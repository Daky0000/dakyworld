import type { MailMessage, MailThread } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { sendSlack } from "../../lib/slack.js";
import { getSetting, SETTING } from "../../lib/settings.js";
import { stopOnReply } from "../emailSequences.js";

/**
 * What happens the moment a message is filed, before anything has been read by
 * a model.
 *
 * These are the reactions that need no judgement, and they are here rather than
 * in the router for one reason: **they must happen even when triage is off,
 * even when there is no model key, and even when every agent is paused.** A
 * sequence that keeps writing to somebody who has already answered is the exact
 * failure this whole module exists to end, and it must not be contingent on an
 * API key.
 *
 * The order matters. Suppression comes before sequence-stopping, because
 * stopping a sequence pulls its queued mail and suppression pulls everything
 * else queued for that address as well.
 *
 * **The trap this file exists for:** an out-of-office is not a reply. It
 * carries `Auto-Submitted`, it arrives within seconds of a send, and treating
 * it as an answer stops the sequence, marks the lead as engaged and loses the
 * prospect in silence. `parse.ts` decides whether a machine wrote it; nothing
 * here acts on a message that a machine wrote, except a bounce.
 */

/** Their own words, not ours. Matched against the trimmed body. */
const UNSUBSCRIBE_PHRASES =
  /\b(unsubscribe|opt[\s-]?out|take me off (your |the )?(list|mailing)|remove me from|stop (emailing|contacting|sending)|do not (contact|email) (me|us)|no longer wish to receive)\b/i;

export interface ConsequenceResult {
  /** True when a sequence was stopped, a suppression added, or a lead moved. */
  acted: boolean;
  notes: string[];
  unsubscribed: boolean;
  bounced: boolean;
}

/**
 * Applies everything that follows from one message having arrived.
 *
 * `message` is already stored. Nothing here throws: a Slack outage, a lead row
 * somebody deleted mid-sync, a race with the same message arriving twice — none
 * of those should undo the fact that the mail was filed.
 */
export async function applyConsequences(message: MailMessage, thread: MailThread): Promise<ConsequenceResult> {
  const notes: string[] = [];
  let unsubscribed = false;
  let bounced = false;

  if (message.direction === "OUTBOUND") {
    const note = await answeredByHand(message, thread);
    if (note) notes.push(note);
    return { acted: notes.length > 0, notes, unsubscribed, bounced };
  }

  // --- A dead address -------------------------------------------------------
  // Read off the headers rather than off a model, because a bounce is a
  // machine-readable fact and paying for an opinion about one would be absurd.
  if (message.intent === "BOUNCE" || (message.autoSubmitted && looksLikeBounceSubject(message.subject))) {
    const address = bouncedAddress(message) ?? thread.counterpartEmail;
    if (address) {
      await suppress(address, `Mail to this address bounced: ${message.subject.slice(0, 120)}`, "BOUNCED");
      bounced = true;
      notes.push(`${address} bounced and is now suppressed.`);
    }
  }

  // --- They asked to be left alone -----------------------------------------
  if (UNSUBSCRIBE_PHRASES.test(message.bodyText) || message.intent === "UNSUBSCRIBE") {
    await suppress(message.fromEmail, `They asked to be removed: “${message.snippet.slice(0, 100)}”`, "UNSUBSCRIBED");
    unsubscribed = true;
    notes.push(`${message.fromEmail} asked not to be contacted again and is suppressed everywhere.`);
  }

  // --- An out-of-office is not a reply -------------------------------------
  if (message.autoSubmitted && !unsubscribed && !bounced) {
    notes.push("A machine sent this, so no sequence was stopped.");
    return { acted: notes.length > 0, notes, unsubscribed, bounced };
  }

  // --- A person answered ----------------------------------------------------
  const stopped = await stopOnReply({
    leadId: message.leadId ?? undefined,
    clientId: message.clientId ?? undefined,
    email: message.fromEmail,
  });
  if (stopped > 0) notes.push(`Stopped ${stopped} sequence${stopped === 1 ? "" : "s"} they were in.`);

  const moved = await advanceLead(message);
  if (moved) notes.push(moved);

  await logCommunication(message, unsubscribed);

  return { acted: notes.length > 0 || stopped > 0, notes, unsubscribed, bounced };
}

/**
 * The Owner replied from his own webmail.
 *
 * This is the whole reason the Sent folder is read. He answers a prospect from
 * his phone on the way somewhere, the app knows nothing about it, and the
 * sequence writes to that prospect again on Thursday — under his name, asking
 * whether they saw his first email. Reading Sent is what stops that.
 */
async function answeredByHand(message: MailMessage, thread: MailThread): Promise<string | null> {
  // Only a message that was *not* sent by this app counts. Everything the
  // outbox sends turns up in Sent a moment later, and treating our own
  // automated send as a hand-written reply would stop every sequence at its
  // first step.
  const ours = await prisma.emailMessage.findFirst({
    where: message.messageId ? { messageId: { in: [message.messageId, message.messageId.replace(/^<|>$/g, "")] } } : { id: "never" },
    select: { id: true },
  });
  if (ours) return null;

  const recipient = thread.counterpartEmail;
  const stopped = await stopOnReply({
    leadId: thread.leadId ?? undefined,
    clientId: thread.clientId ?? undefined,
    email: recipient,
  });
  if (stopped === 0) return null;
  return `You answered ${recipient} by hand, so ${stopped} sequence${stopped === 1 ? "" : "s"} stopped.`;
}

/**
 * A lead that answers has stopped being a cold row on a list.
 *
 * Only ever forwards, and only out of NEW — the one status that means nobody
 * has spoken to them yet. A reply must never drag a CONVERTED client back to
 * QUALIFYING, and a DISQUALIFIED lead answering is not a reason to re-open
 * them: that is a decision for a person, and the message is on the Inbox
 * screen for them to make it.
 */
async function advanceLead(message: MailMessage): Promise<string | null> {
  if (!message.leadId) return null;
  const lead = await prisma.lead.findUnique({ where: { id: message.leadId }, select: { status: true, contactName: true } });
  if (!lead || lead.status !== "NEW") return null;

  await prisma.lead.update({ where: { id: message.leadId }, data: { status: "QUALIFYING" } });
  return `${lead.contactName} moved from New to Qualifying — they replied.`;
}

async function logCommunication(message: MailMessage, unsubscribed: boolean): Promise<void> {
  if (!message.leadId && !message.clientId) return;
  await prisma.communication.create({
    data: {
      type: "EMAIL",
      summary: `Reply by email: ${message.subject.slice(0, 120)}`,
      outcome: unsubscribed ? "They asked not to be contacted again" : "Awaiting a response from us",
      occurredAt: message.sentAt,
      leadId: message.leadId,
      clientId: message.clientId,
    },
  });
}

export async function suppress(email: string, reason: string, source: string): Promise<void> {
  const address = email.trim().toLowerCase();
  if (!address.includes("@")) return;
  await prisma.emailSuppression.upsert({
    where: { email: address },
    update: { reason, source },
    create: { email: address, reason, source },
  });
  await stopOnReply({ email: address });
  // Everything already written and waiting for its send time goes too. A
  // suppression that only stops the *next* composition has stopped nothing.
  await prisma.emailMessage.updateMany({
    where: { toEmail: address, status: { in: ["DRAFT", "SCHEDULED"] } },
    data: { status: "CANCELLED", error: `Cancelled — ${reason}` },
  });
}

function looksLikeBounceSubject(subject: string): boolean {
  return /^(undeliverable|delivery status notification|mail delivery|returned mail|failure notice)/i.test(subject.trim());
}

/**
 * The address that actually bounced, dug out of the report body.
 *
 * The From on a bounce is `mailer-daemon@`, which is useless — suppressing that
 * would stop nothing and quietly add a system address to the list. The failed
 * recipient is in the report, usually as `Final-Recipient: rfc822; …`.
 */
function bouncedAddress(message: MailMessage): string | null {
  const final = /final-recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i.exec(message.bodyText);
  if (final) return final[1].toLowerCase();
  const original = /original-recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i.exec(message.bodyText);
  if (original) return original[1].toLowerCase();
  // "Your message to dan@example.com couldn't be delivered" — the loosest
  // pattern, and only reached when the structured report is absent.
  const loose = /\b([^\s<>]+@[^\s<>]+\.[a-z]{2,})\b/i.exec(message.bodyText);
  return loose ? loose[1].toLowerCase().replace(/[.,;:]$/, "") : null;
}

/**
 * A reply worth interrupting somebody for.
 *
 * The same judgement the WhatsApp side makes, and the same catch: Slack failing
 * must never look like the mail failing. The mail is already filed by the time
 * this runs.
 */
export async function announce(message: MailMessage, result: ConsequenceResult): Promise<void> {
  const [webhook, token] = await Promise.all([getSetting(SETTING.SLACK_WEBHOOK_URL), getSetting(SETTING.SLACK_BOT_TOKEN)]);
  if (!webhook && !token) return;

  const who = message.fromName ? `${message.fromName} (${message.fromEmail})` : message.fromEmail;
  const title = result.unsubscribed ? "Opted out" : result.bounced ? "An address bounced" : "Somebody replied by email";
  const lines = [`*${who}* — ${message.subject}`, message.snippet ? `“${message.snippet}”` : "", ...result.notes].filter(Boolean);

  await sendSlack({ title, text: lines.join("\n") }).catch((err) =>
    console.warn("[mailbox] Slack notice failed:", (err as Error).message),
  );
}
