import type { MailFolder, MailMessage, MailThread } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { isOurs } from "../../lib/imap.js";
import type { MailboxMessage } from "./parse.js";
import { bareId, counterpartOf, findRepliedTo, findThreadByReferences, matchRecords, resolveThread, threadKeyFor } from "./match.js";
import { announce, applyConsequences } from "./consequences.js";
import { routeMessage } from "./router.js";
import { triageEnabled, triageMessage } from "./triage.js";

/**
 * One message, from the wire to a routed piece of work.
 *
 * The whole mail room runs through here, in an order chosen so that the
 * cheapest and most certain things happen first and the expensive, fallible
 * one happens last:
 *
 * ```
 * store  →  read (a model)  →  consequences (code)  →  route  →  announce
 * ```
 *
 * **Storing first is what makes the rest safe to fail.** A model outage, a
 * paused agent, a Slack workspace nobody connected — none of them can lose a
 * message, because the message is already a row before any of them is
 * touched. Every stage after the first is wrapped and records its own failure
 * on that row rather than throwing back into the sync loop, where one
 * unreadable message would stop the folder.
 *
 * **The model is skipped wherever the headers already answer.** A delivery
 * failure and an out-of-office are machine-readable facts, and a mailbox is
 * mostly machines: newsletters, receipts, notifications. Paying for an opinion
 * about each of them would be the largest running cost in this app and would
 * buy nothing.
 */

export interface IngestResult {
  message: MailMessage;
  thread: MailThread;
  /** False when this message was already stored — a re-read, not a new arrival. */
  fresh: boolean;
  routedTo: string | null;
  taskId: string | null;
  notes: string[];
}

/**
 * What makes a message unique.
 *
 * The `Message-ID` is the right answer and roughly one message in a thousand
 * does not have one, so the folder coordinates are the fallback. Those are
 * only unique *within* a `UIDVALIDITY`, which is exactly why it is in the key:
 * a server that renumbers its folder would otherwise collide every message
 * with an unrelated one.
 */
export function dedupeKeyFor(parsed: MailboxMessage, folder: MailFolder, uid: number, uidValidity: bigint): string {
  const id = bareId(parsed.messageId);
  return id ? `mid:${id}` : `loc:${folder}:${uidValidity}:${uid}`;
}

export async function ingestMessage(input: {
  parsed: MailboxMessage;
  folder: MailFolder;
  uid: number;
  uidValidity: bigint;
  /** The addresses that are us. Passed in so a sync of 200 messages reads settings once. */
  own: string[];
  /** Skips the model. Used by the check harness and by a re-read of old mail. */
  skipTriage?: boolean;
}): Promise<IngestResult> {
  const { parsed, folder, uid, uidValidity, own } = input;
  const dedupeKey = dedupeKeyFor(parsed, folder, uid, uidValidity);

  const already = await prisma.mailMessage.findUnique({ where: { dedupeKey }, include: { thread: true } });
  if (already) {
    return { message: already, thread: already.thread, fresh: false, routedTo: already.routedAgentKey, taskId: already.taskId, notes: [] };
  }

  // Direction is decided by who wrote it, not by which folder it was in. A
  // copy of our own outbound sitting in the inbox — a BCC to self, a mailing
  // list reflecting it back — is still something we sent, and treating it as
  // an arrival would have the system reply to itself.
  //
  // A delivery report is the exception and it is not a small one: a bounce is
  // very often sent by our own mail server, from `mailer-daemon@` on our own
  // domain, and read as outbound it would be filed as something we wrote and
  // suppressed nothing. A machine telling us a letter failed is an arrival
  // whatever address it comes from.
  const direction = isOurs(parsed.fromEmail, own) && !parsed.bounce ? "OUTBOUND" : "INBOUND";
  const counterpart = counterpartOf(parsed, own);

  const [repliedTo, matched, priorThreadId] = await Promise.all([
    findRepliedTo(parsed),
    matchRecords(counterpart.email),
    findThreadByReferences(parsed),
  ]);
  // The letter being answered is the better evidence of who this is about: it
  // was addressed to a record on purpose, where an address match is an
  // inference. Only used to fill blanks — see match.ts.
  const leadId = matched.leadId ?? repliedTo?.leadId ?? null;
  const clientId = matched.clientId ?? repliedTo?.clientId ?? null;

  const thread = await resolveThread({
    priorThreadId,
    threadKey: threadKeyFor(parsed.subject, counterpart.email),
    subject: parsed.subject,
    counterpartEmail: counterpart.email,
    counterpartName: counterpart.name,
    participants: [parsed.fromEmail, ...parsed.toEmails, ...parsed.ccEmails],
    leadId,
    clientId,
    direction,
    at: parsed.sentAt,
    snippet: parsed.snippet,
  });

  // Read off the headers, before any model. Both of these route to nobody and
  // both have consequences that are pure arithmetic.
  const headerIntent = parsed.bounce ? "BOUNCE" : parsed.autoSubmitted ? "AUTO_REPLY" : null;

  let message = await prisma.mailMessage.create({
    data: {
      dedupeKey,
      messageId: parsed.messageId,
      folder,
      direction,
      uid: BigInt(uid),
      uidValidity,
      fromEmail: parsed.fromEmail,
      fromName: parsed.fromName,
      toEmails: parsed.toEmails,
      ccEmails: parsed.ccEmails,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      snippet: parsed.snippet,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      sentAt: parsed.sentAt,
      attachments: parsed.attachments,
      hasAttachments: parsed.attachments.length > 0,
      autoSubmitted: parsed.autoSubmitted,
      threadId: thread.id,
      leadId,
      clientId,
      replyToEmailId: repliedTo?.id ?? null,
      ...(headerIntent
        ? {
            intent: headerIntent,
            triage: "TRIAGED" as const,
            triagedAt: new Date(),
            confidence: 1,
            needsReply: false,
            urgency: 3,
            summary: headerIntent === "BOUNCE" ? "A delivery failure, read off the headers." : "A machine sent this, read off the headers.",
          }
        : {}),
    },
  });

  const notes: string[] = [];

  // --- Read it -------------------------------------------------------------
  const worthReading = direction === "INBOUND" && !headerIntent && !input.skipTriage && (await triageEnabled());
  if (worthReading) {
    try {
      const triage = await triageMessage(message);
      message = await prisma.mailMessage.update({
        where: { id: message.id },
        data: {
          triage: "TRIAGED",
          intent: triage.intent,
          summary: triage.summary,
          urgency: triage.urgency,
          needsReply: triage.needsReply,
          confidence: triage.confidence,
          triagedAt: new Date(),
          triageError: null,
        },
      });
    } catch (err) {
      // Recorded on the row rather than thrown. A message nobody could read is
      // still a message that arrived, and the Inbox screen shows why it was
      // not sorted — which is how a missing key gets noticed.
      const reason = (err as Error).message;
      notes.push(`Not sorted: ${reason}`);
      message = await prisma.mailMessage.update({
        where: { id: message.id },
        data: { triage: "FAILED", triageError: reason.slice(0, 500) },
      });
    }
  }

  // --- Act on it, whatever the model did or did not manage ------------------
  const consequences = await applyConsequences(message, thread).catch((err) => {
    notes.push(`Could not act on it: ${(err as Error).message}`);
    return { acted: false, notes: [] as string[], unsubscribed: false, bounced: false };
  });
  notes.push(...consequences.notes);

  // --- Hand it to somebody --------------------------------------------------
  let routedTo: string | null = null;
  let taskId: string | null = null;
  if (message.triage === "TRIAGED" && direction === "INBOUND") {
    const decision = await routeMessage(message, thread).catch((err) => {
      notes.push(`Could not hand it to anybody: ${(err as Error).message}`);
      return null;
    });
    if (decision) {
      routedTo = decision.agentKey;
      taskId = decision.taskId;
      if (decision.note) notes.push(decision.note);
      if (!decision.taskId && !decision.note) notes.push(decision.because);
      if (decision.taskId) message = (await prisma.mailMessage.findUnique({ where: { id: message.id } })) ?? message;
    }
  }

  // --- Tell somebody --------------------------------------------------------
  // Only what a person would want interrupting for: a real reply, an opt-out
  // or a bounce. Newsletters and receipts are filed in silence.
  if (direction === "INBOUND" && (consequences.unsubscribed || consequences.bounced || (message.intent && ANNOUNCED.has(message.intent)))) {
    await announce(message, consequences);
  }

  return { message, thread, fresh: true, routedTo, taskId, notes };
}

/** The intents worth a Slack line at the moment they arrive. */
const ANNOUNCED = new Set<string>([
  "INTERESTED",
  "QUESTION",
  "MEETING_REQUEST",
  "PROPOSAL_FEEDBACK",
  "SUPPORT_ISSUE",
  "INVOICE_QUERY",
  "PAYMENT_NOTICE",
  "NEW_ENQUIRY",
]);

/**
 * Reads a message again, on purpose.
 *
 * The escape hatch for the two cases the automatic path gets wrong: a real
 * reply from a system that sets `Precedence: bulk` and was therefore never
 * read at all, and a classification that is simply wrong. Clears the routing
 * so the message can be handed to somebody else — it does not cancel a task
 * that has already been raised, because that task may already have been
 * worked on and deciding its fate is a person's call.
 */
export async function retriage(messageId: string): Promise<IngestResult> {
  const existing = await prisma.mailMessage.findUnique({ where: { id: messageId }, include: { thread: true } });
  if (!existing) throw new Error("That message is not in the mailbox.");

  const triage = await triageMessage(existing);
  const message = await prisma.mailMessage.update({
    where: { id: existing.id },
    data: {
      triage: "TRIAGED",
      intent: triage.intent,
      summary: triage.summary,
      urgency: triage.urgency,
      needsReply: triage.needsReply,
      confidence: triage.confidence,
      triagedAt: new Date(),
      triageError: null,
      routedAgentKey: existing.taskId ? existing.routedAgentKey : null,
      taskId: existing.taskId,
    },
  });

  const decision = await routeMessage(message, existing.thread);
  const notes = [decision.note, decision.taskId ? null : decision.because].filter((note): note is string => Boolean(note));
  const after = (await prisma.mailMessage.findUnique({ where: { id: message.id } })) ?? message;
  return { message: after, thread: existing.thread, fresh: false, routedTo: decision.agentKey, taskId: decision.taskId, notes };
}
