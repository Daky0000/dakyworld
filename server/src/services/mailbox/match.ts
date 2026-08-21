import type { MailThread, MessageDirection } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { isOurs } from "../../lib/imap.js";
import type { MailboxMessage } from "./parse.js";

/**
 * Working out what a message that arrived is *about*.
 *
 * Three questions, in falling order of certainty:
 *
 *  1. **Which of our letters does it answer?** `In-Reply-To` and `References`
 *     carry the Message-ID of the mail being replied to, and the outbox stores
 *     the Message-ID of everything it sent. That is a join, not a guess, and
 *     it is the only link here that is certain.
 *  2. **Whose conversation is it?** Threading by header where the headers are
 *     there, and by normalised subject plus the other party's address where
 *     they are not — because a good many clients answer with neither header.
 *  3. **Which record is it?** The sender's address against leads, clients and
 *     client contacts. Matched on the address alone and never on the person's
 *     name: two businesses share a receptionist called "Info" and neither of
 *     them wants the other's invoice.
 *
 * Every one of these can come back empty, and empty is a legitimate answer. A
 * message from somebody nobody has ever written to is the most valuable kind
 * of mail this system will ever see.
 */

/** `<abc@host>` and `abc@host` are the same id written two ways. */
export function bareId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^</, "").replace(/>$/, "").toLowerCase() || null;
}

/** Both spellings of one Message-ID, so a stored value matches whichever way it was saved. */
function idVariants(value: string): string[] {
  const bare = bareId(value);
  return bare ? [bare, `<${bare}>`] : [];
}

/** "Re: Re: Fwd: About the site" → "about the site". */
export function normaliseSubject(subject: string): string {
  return subject
    .replace(/^((re|fw|fwd|aw|sv|vs|antw)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The other party on a message — the address that is not one of ours.
 *
 * On an inbound message that is the sender. On a copy of our own outbound it
 * is the first recipient who is not us, which is what makes a reply the Owner
 * typed into his phone land in the same conversation as the letter the app
 * sent.
 */
export function counterpartOf(
  message: Pick<MailboxMessage, "fromEmail" | "fromName" | "toEmails" | "ccEmails">,
  own: string[],
): { email: string; name: string | null } {
  if (!isOurs(message.fromEmail, own)) return { email: message.fromEmail, name: message.fromName };
  const recipient = [...message.toEmails, ...message.ccEmails].find((address) => !isOurs(address, own));
  return { email: recipient ?? message.toEmails[0] ?? message.fromEmail, name: null };
}

/**
 * The conversation key, when nothing better is available.
 *
 * Subject and the other party. Two genuinely separate conversations with the
 * same subject and the same person do collapse into one under this; every mail
 * client on earth does the same thing, and the alternative — a new thread per
 * message — is worse.
 */
export function threadKeyFor(subject: string, counterpartEmail: string): string {
  return `${normaliseSubject(subject) || "(no subject)"}|${counterpartEmail.toLowerCase()}`;
}

/**
 * The thread holding a message this one answers.
 *
 * **Threading is done by finding the stored message, not by matching a key**,
 * and the failure that forced it is worth keeping: a key derived from the
 * `References` root only ever matches another message carrying the same root,
 * so a conversation whose first message has no such header — every conversation,
 * since the first message has nothing to reference — was keyed one way while
 * every reply to it was keyed another. The letter and its answer were two
 * conversations, and a reply typed on a phone was a third.
 *
 * Looking the ids up against `MailMessage.messageId` has none of that
 * asymmetry: whatever key each thread happens to be stored under, a reply
 * finds the one containing the message it is replying to.
 */
export async function findThreadByReferences(message: MailboxMessage): Promise<string | null> {
  const ids = [message.inReplyTo, ...message.references].filter((value): value is string => Boolean(value)).flatMap(idVariants);
  if (ids.length === 0) return null;
  const known = await prisma.mailMessage.findFirst({
    where: { messageId: { in: ids } },
    select: { threadId: true },
    orderBy: { sentAt: "desc" },
  });
  return known?.threadId ?? null;
}

/** The outbound message this one answers, by header. */
export async function findRepliedTo(message: MailboxMessage): Promise<{ id: string; leadId: string | null; clientId: string | null } | null> {
  const candidates = [message.inReplyTo, ...message.references.slice().reverse()]
    .filter((value): value is string => Boolean(value))
    .flatMap(idVariants);
  if (candidates.length === 0) return null;

  return prisma.emailMessage.findFirst({
    where: { messageId: { in: candidates } },
    select: { id: true, leadId: true, clientId: true },
    orderBy: { sentAt: "desc" },
  });
}

export interface RecordMatch {
  leadId: string | null;
  clientId: string | null;
}

/**
 * Who an address belongs to.
 *
 * A client wins over a lead when the same address is both, because a lead that
 * converted is a client and the newer relationship is the true one. The lookup
 * is case-insensitive on purpose: addresses arrive from scrapes, spreadsheets
 * and people typing, and a third of them are capitalised.
 */
export async function matchRecords(email: string): Promise<RecordMatch> {
  const address = email.trim().toLowerCase();
  if (!address || !address.includes("@")) return { leadId: null, clientId: null };

  const [client, contact, lead] = await Promise.all([
    prisma.client.findFirst({ where: { email: { equals: address, mode: "insensitive" } }, select: { id: true } }),
    prisma.contact.findFirst({ where: { email: { equals: address, mode: "insensitive" } }, select: { clientId: true } }),
    prisma.lead.findFirst({
      where: { contactEmail: { equals: address, mode: "insensitive" } },
      select: { id: true, clientId: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const clientId = client?.id ?? contact?.clientId ?? lead?.clientId ?? null;
  return { leadId: lead?.id ?? null, clientId };
}

/**
 * Finds or creates the conversation this message belongs to.
 *
 * Attribution only ever *fills in* a thread — a thread that already knows its
 * lead is never re-pointed at another one by a later message. Somebody being
 * cc'd on a conversation should not move it.
 */
export async function resolveThread(args: {
  /** The thread a reference chain already found, which always wins. */
  priorThreadId: string | null;
  threadKey: string;
  subject: string;
  counterpartEmail: string;
  counterpartName: string | null;
  participants: string[];
  leadId: string | null;
  clientId: string | null;
  direction: MessageDirection;
  at: Date;
  snippet: string;
}): Promise<MailThread> {
  // The reference chain is evidence; the subject key is an inference. So a
  // thread found by chain is used even when the subject has been edited, and
  // the key is only consulted when there was no chain to follow.
  const existing = args.priorThreadId
    ? await prisma.mailThread.findUnique({ where: { id: args.priorThreadId } })
    : await prisma.mailThread.findUnique({ where: { threadKey: args.threadKey } });
  const inbound = args.direction === "INBOUND";

  if (!existing) {
    return prisma.mailThread.create({
      data: {
        threadKey: args.threadKey,
        subject: args.subject,
        counterpartEmail: args.counterpartEmail,
        counterpartName: args.counterpartName,
        participants: [...new Set(args.participants)],
        leadId: args.leadId,
        clientId: args.clientId,
        lastMessageAt: args.at,
        lastInboundAt: inbound ? args.at : null,
        lastOutboundAt: inbound ? null : args.at,
        lastSnippet: args.snippet,
        messageCount: 1,
        unreadCount: inbound ? 1 : 0,
      },
    });
  }

  return prisma.mailThread.update({
    where: { id: existing.id },
    data: {
      participants: [...new Set([...existing.participants, ...args.participants])],
      counterpartName: existing.counterpartName ?? args.counterpartName,
      leadId: existing.leadId ?? args.leadId,
      clientId: existing.clientId ?? args.clientId,
      // Guarded rather than assigned: a folder re-read can hand over an old
      // message after a newer one, and a conversation whose "last message"
      // walks backwards sorts to the bottom of the list and disappears.
      lastMessageAt: args.at > existing.lastMessageAt ? args.at : existing.lastMessageAt,
      lastInboundAt: inbound && (!existing.lastInboundAt || args.at > existing.lastInboundAt) ? args.at : existing.lastInboundAt,
      lastOutboundAt: !inbound && (!existing.lastOutboundAt || args.at > existing.lastOutboundAt) ? args.at : existing.lastOutboundAt,
      lastSnippet: args.at >= existing.lastMessageAt ? args.snippet : existing.lastSnippet,
      messageCount: { increment: 1 },
      unreadCount: inbound ? { increment: 1 } : undefined,
    },
  });
}
