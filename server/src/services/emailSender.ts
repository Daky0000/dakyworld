import type { EmailMessage } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { MailerError, sendMail, type Attachment } from "../lib/mailer.js";
import { SETTING, getSetting } from "../lib/settings.js";
import { renderProposalPdf } from "./pdf.js";
import { renderInvoicePdfFor } from "./invoicePdf.js";
import { readFile } from "./fileStore.js";
import { renderEmail } from "./emailRender.js";
import { resolveContext } from "./emailContext.js";

/**
 * Sending. Everything that decides whether an email actually leaves is here,
 * in one place, because "why did that go out?" and "why didn't that go out?"
 * are the only two questions anyone ever asks of an outbox.
 *
 * **Suppression is checked at send, not at compose.** Someone can unsubscribe
 * between a draft being written and the sequence reaching them; the check that
 * matters is the last one before the socket opens.
 *
 * **Status moves before the network call.** A message goes SENDING first, so a
 * crash mid-send leaves evidence rather than a message that looks unsent and
 * gets sent again.
 */

/**
 * An attachment as stored on the message. Four kinds, and the difference
 * between them is *when the bytes exist*:
 *
 * - `stored` — a real file somebody uploaded, held in StoredFile. The bytes
 *   exist now and do not change.
 * - `file` — a URL. The bytes live somewhere else and are fetched at send.
 * - `invoice` / `proposal` — a document this app renders, and renders **at
 *   send time**, so what the client receives is the document as it stands when
 *   it is sent rather than as it stood when the email was drafted.
 */
export type StoredAttachment =
  | { kind: "stored"; fileId: string; name: string; contentType?: string; size?: number }
  | { kind?: "file"; name: string; url: string; contentType?: string }
  | { kind: "invoice"; invoiceId: string; name?: string }
  | { kind: "proposal"; proposalId: string; name?: string };

export function parseAttachments(value: unknown): StoredAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is StoredAttachment => Boolean(entry) && typeof entry === "object");
}

/**
 * Turns stored attachments into what nodemailer needs. Invoice and proposal
 * PDFs are rendered at send time rather than stored, so what the client
 * receives is the document as it stands when it is sent — not as it stood when
 * the email was drafted three days earlier.
 */
export async function resolveAttachments(stored: StoredAttachment[]): Promise<Attachment[]> {
  const resolved: Attachment[] = [];

  for (const entry of stored) {
    if ("kind" in entry && entry.kind === "stored") {
      const file = await readFile(entry.fileId);
      // A file deleted between drafting and sending is skipped rather than
      // failing the send: the letter is the point, and a message that never
      // leaves because one attachment went missing helps nobody.
      if (!file) {
        console.warn(`[email] attachment ${entry.fileId} (${entry.name}) is gone — sending without it.`);
        continue;
      }
      resolved.push({ filename: entry.name || file.filename, content: file.data, contentType: file.contentType });
      continue;
    }

    if ("kind" in entry && entry.kind === "invoice") {
      // The same branded document "Generate PDF" produces — one template, see
      // services/invoicePdf.ts. Rendered here rather than stored, so what the
      // client receives is the invoice as it stands when the email leaves.
      const rendered = await renderInvoicePdfFor(entry.invoiceId);
      if (!rendered) continue;
      resolved.push({ filename: rendered.filename, content: rendered.pdf, contentType: "application/pdf" });
      continue;
    }

    if ("kind" in entry && entry.kind === "proposal") {
      const proposal = await prisma.proposal.findUnique({ where: { id: entry.proposalId }, include: { client: true, lead: true } });
      if (!proposal) continue;
      const pdf = await renderProposalPdf({
        title: proposal.title,
        clientName: proposal.client?.name ?? proposal.lead?.contactName ?? "Prospective client",
        serviceType: proposal.serviceType,
        scopeSummary: proposal.scopeSummary,
        priceAmount: proposal.priceAmount.toString(),
        currency: proposal.currency,
        priceTier: proposal.priceTier ?? undefined,
        expiresAt: proposal.expiresAt ?? undefined,
      });
      const safeTitle = proposal.title.replace(/[^\w\- ]+/g, "").slice(0, 60) || "Proposal";
      resolved.push({ filename: `${safeTitle}.pdf`, content: pdf, contentType: "application/pdf" });
      continue;
    }

    if ("url" in entry && entry.url) {
      resolved.push({ filename: entry.name || "attachment", path: entry.url, contentType: entry.contentType });
    }
  }

  return resolved;
}

export async function isSuppressed(email: string): Promise<string | null> {
  const row = await prisma.emailSuppression.findUnique({ where: { email: email.toLowerCase() } });
  return row ? row.reason : null;
}

export async function appUrl(): Promise<string> {
  return (await getSetting(SETTING.APP_URL)) ?? "https://os.dakyworld.com";
}

/**
 * Only a cold approach carries an opt-out. See emailRender for why.
 *
 * Exported so the preview renders the same message the send would: an opt-out
 * that appears in the preview and not in the email — or the other way round —
 * makes the preview worse than useless.
 */
export const COLD_PURPOSES = new Set(["COLD_OUTREACH", "FOLLOW_UP", "MEETING_REQUEST", "REACTIVATION", "ANNOUNCEMENT"]);

export interface SendResult {
  sent: boolean;
  reason?: string;
  messageId?: string;
}

/**
 * Sends one stored message. Safe to call twice: a message that is already SENT
 * returns without doing anything, which is what makes the scheduler and the
 * Send button unable to collide.
 */
export async function sendMessage(id: string): Promise<SendResult> {
  const message = await prisma.emailMessage.findUnique({ where: { id } });
  if (!message) throw new Error("Email not found");
  if (message.status === "SENT") return { sent: false, reason: "already-sent", messageId: message.messageId ?? undefined };
  if (message.status === "SENDING") return { sent: false, reason: "in-flight" };
  if (message.status === "CANCELLED") return { sent: false, reason: "cancelled" };

  const suppressed = await isSuppressed(message.toEmail);
  if (suppressed) {
    await prisma.emailMessage.update({
      where: { id },
      data: { status: "CANCELLED", error: `Not sent — ${message.toEmail} is on the suppression list (${suppressed}).` },
    });
    return { sent: false, reason: "suppressed" };
  }

  // Claim it before the network call, so a crash leaves a SENDING row to
  // investigate rather than a DRAFT that looks safe to send again.
  await prisma.emailMessage.update({ where: { id }, data: { status: "SENDING", attempts: { increment: 1 } } });

  try {
    const attachments = await resolveAttachments(parseAttachments(message.attachments));
    const result = await sendMail({
      to: message.toEmail,
      toName: message.toName,
      subject: message.subject,
      html: message.bodyHtml,
      text: message.bodyText,
      cc: message.cc,
      bcc: message.bcc,
      replyTo: message.replyTo,
      inReplyTo: message.inReplyTo,
      attachments,
      unsubscribeUrl: COLD_PURPOSES.has(message.purpose)
        ? `${await appUrl()}/api/emails/unsubscribe?email=${encodeURIComponent(message.toEmail)}`
        : null,
    });

    await prisma.emailMessage.update({
      where: { id },
      data: { status: "SENT", sentAt: new Date(), messageId: result.messageId, error: null },
    });
    await logCommunication(message);
    // The Hostinger path answers a send with no body, so there is no
    // Message-ID to report; sent is still sent.
    return { sent: true, messageId: result.messageId ?? undefined };
  } catch (err) {
    const reason = err instanceof MailerError ? err.message : (err as Error).message;
    await prisma.emailMessage.update({ where: { id }, data: { status: "FAILED", failedAt: new Date(), error: reason } });
    return { sent: false, reason };
  }
}

/**
 * A sent email is a contact, and the lead's history is where anyone looks for
 * "when did we last speak to them" — so it is written there too rather than
 * living only in the outbox.
 */
async function logCommunication(message: EmailMessage) {
  if (!message.leadId && !message.clientId && !message.projectId) return;
  await prisma.communication.create({
    data: {
      type: "EMAIL",
      summary: message.subject,
      outcome: `Sent to ${message.toEmail}`,
      occurredAt: new Date(),
      leadId: message.leadId,
      clientId: message.clientId,
      projectId: message.projectId,
      loggedById: message.createdById,
    },
  });
}

/**
 * Builds a sendable message from written content. Used by the composer, by
 * sequences, and by the automations — one path, so a sequence email and a
 * hand-written one are rendered by exactly the same code.
 */
export async function composeMessage(args: {
  subject: string;
  body: string;
  purpose: EmailMessage["purpose"];
  kind: EmailMessage["kind"];
  toEmail?: string | null;
  toName?: string | null;
  cc?: string[];
  bcc?: string[];
  replyTo?: string | null;
  leadId?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  proposalId?: string | null;
  invoiceId?: string | null;
  carePlanId?: string | null;
  templateId?: string | null;
  stepId?: string | null;
  enrollmentId?: string | null;
  createdById?: string | null;
  attachments?: StoredAttachment[];
  scheduledFor?: Date | null;
  status?: EmailMessage["status"];
}): Promise<EmailMessage> {
  const context = await resolveContext({
    leadId: args.leadId,
    clientId: args.clientId,
    toEmail: args.toEmail,
    toName: args.toName,
  });

  const toEmail = args.toEmail ?? context.email;
  if (!toEmail) throw new MailerError(400, "No email address on file for this recipient — add one, or type an address.");

  const rendered = await renderEmail({
    subject: args.subject,
    body: args.body,
    variables: context.variables,
    toEmail,
    appUrl: await appUrl(),
    includeUnsubscribe: COLD_PURPOSES.has(args.purpose),
  });

  // An email written about an invoice carries the invoice, and one written
  // about a proposal carries the proposal — whoever wrote it and however it
  // was asked for. The link fields decide what the message is *about*; this is
  // what makes the document actually leave with it, so "attach the PDF" is
  // never a step somebody can forget. An attachment the caller listed
  // themselves is left exactly as they listed it.
  const attachments = [...(args.attachments ?? [])];
  if (args.invoiceId && !attachments.some((entry) => (entry as { kind?: string }).kind === "invoice" && (entry as { invoiceId?: string }).invoiceId === args.invoiceId)) {
    attachments.push({ kind: "invoice", invoiceId: args.invoiceId });
  }
  if (args.proposalId && !attachments.some((entry) => (entry as { kind?: string }).kind === "proposal" && (entry as { proposalId?: string }).proposalId === args.proposalId)) {
    attachments.push({ kind: "proposal", proposalId: args.proposalId });
  }

  return prisma.emailMessage.create({
    data: {
      subject: rendered.subject,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      toEmail,
      toName: args.toName ?? context.name,
      cc: args.cc ?? [],
      bcc: args.bcc ?? [],
      replyTo: args.replyTo ?? null,
      status: args.status ?? (args.scheduledFor ? "SCHEDULED" : "DRAFT"),
      kind: args.kind,
      purpose: args.purpose,
      scheduledFor: args.scheduledFor ?? null,
      attachments: attachments as never,
      leadId: args.leadId ?? null,
      clientId: args.clientId ?? null,
      projectId: args.projectId ?? null,
      proposalId: args.proposalId ?? null,
      invoiceId: args.invoiceId ?? null,
      carePlanId: args.carePlanId ?? null,
      templateId: args.templateId ?? null,
      stepId: args.stepId ?? null,
      enrollmentId: args.enrollmentId ?? null,
      createdById: args.createdById ?? null,
    },
  });
}

/** The scheduler's half: anything scheduled whose time has come. */
export async function dispatchDueEmails(now = new Date()): Promise<number> {
  const due = await prisma.emailMessage.findMany({
    where: { status: "SCHEDULED", scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: 25,
    select: { id: true },
  });
  if (due.length === 0) return 0;

  let sent = 0;
  for (const message of due) {
    const result = await sendMessage(message.id);
    if (result.sent) sent += 1;
  }
  if (sent > 0) console.log(`[email] sent ${sent} scheduled message(s)`);
  return sent;
}
