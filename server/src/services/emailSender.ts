import type { EmailMessage } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { MailerError, sendMail, type Attachment } from "../lib/mailer.js";
import { redFlags } from "./leadPrep.js";
import { SETTING, getSetting } from "../lib/settings.js";
import { renderProposalPdf } from "./pdf.js";
import { renderInvoicePdfFor } from "./invoicePdf.js";
import { readFile } from "./fileStore.js";
import { OPT_OUT_SENTENCE, renderEmail, signature } from "./emailRender.js";
import { resolveContext } from "./emailContext.js";
import { claimSend, settleSend } from "./concept/send.js";
import { noteEmailDraft } from "./concept/progress.js";
import { preSendCheck, type CheckResult, type PreSendReport } from "./coldEmailChecks.js";
import { FLAG, flagOn } from "../lib/featureFlags.js";

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
 *
 * **The checklist runs here too**, on every send and on the stored text, and
 * holds a first letter only when the caller is a machine path and
 * `flags.deliverables` is on. See `checklistFor`.
 */

/**
 * An attachment as stored on the message. Five kinds, and the difference
 * between them is *when the bytes exist*:
 *
 * - `stored` — a real file somebody uploaded, held in StoredFile. The bytes
 *   exist now and do not change.
 * - `file` — a URL. The bytes live somewhere else and are fetched at send.
 * - `invoice` / `proposal` — a document this app renders, and renders **at
 *   send time**, so what the client receives is the document as it stands when
 *   it is sent rather than as it stood when the email was drafted.
 * - `audit` — the website review's PDF. Stored as the *review's* id rather
 *   than the file's, for the same reason: a review re-run between drafting and
 *   sending replaces its PDF, and what should leave with the letter is the
 *   report as it stands, not the one that happened to be rendered on Tuesday.
 */
export type StoredAttachment =
  | { kind: "stored"; fileId: string; name: string; contentType?: string; size?: number }
  | { kind?: "file"; name: string; url: string; contentType?: string }
  | { kind: "invoice"; invoiceId: string; name?: string }
  | { kind: "proposal"; proposalId: string; name?: string }
  | { kind: "audit"; auditId: string; name?: string }
  | { kind: "demo"; demoId: string; name?: string };

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

    if ("kind" in entry && entry.kind === "audit") {
      const audit = await prisma.websiteAudit.findUnique({
        where: { id: entry.auditId },
        select: { pdfFileId: true, businessName: true },
      });
      // A review whose PDF never rendered is skipped like a missing upload
      // rather than failing the send. The letter is the point — and the
      // drafter is only told to mention an attachment once one exists, so the
      // sentence and the file are decided together upstream.
      if (!audit?.pdfFileId) {
        console.warn(`[email] the review ${entry.auditId} has no PDF — sending without it.`);
        continue;
      }
      const file = await readFile(audit.pdfFileId);
      if (!file) {
        console.warn(`[email] the report for ${audit.businessName} is gone — sending without it.`);
        continue;
      }
      const safeName = audit.businessName.replace(/[^\w\- ]+/g, "").slice(0, 60) || "Website";
      resolved.push({ filename: entry.name || `${safeName} — website review.pdf`, content: file.data, contentType: "application/pdf" });
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

    if ("kind" in entry && entry.kind === "demo") {
      const demo = await prisma.demo.findUnique({
        where: { id: entry.demoId },
        select: { slug: true, html: true },
      });
      if (!demo) {
        console.warn(`[email] demo ${entry.demoId} is gone — sending without it.`);
        continue;
      }
      const filename = entry.name?.trim()
        ? entry.name.trim().endsWith(".html")
          ? entry.name.trim()
          : `${entry.name.trim()}.html`
        : `${demo.slug}.html`;
      resolved.push({
        filename,
        content: Buffer.from(demo.html, "utf8"),
        contentType: "text/html; charset=utf-8",
      });
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
  return (await getSetting(SETTING.APP_URL)) ?? "https://os.dakyx.com";
}

/**
 * Where a Website Builder customer signs in, without a trailing slash.
 *
 * `appUrl` is the staff host, and every customer link used to be built from
 * it: a customer who had just paid was emailed a set-password link to
 * os.dakyx.com, and landed on a sign-in screen headed "Internal Operations".
 * One address cannot serve both audiences, so anything a customer is sent — a
 * set-password link, a review link, a billing notice, a payment return — is
 * built from this instead. `EDITOR_URL` overrides it, for local development.
 */
export function customerAppUrl(): string {
  return (process.env.EDITOR_URL?.trim() || "https://editor.dakyx.com").replace(/\/+$/, "");
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
  /**
   * What the pre-send checklist made of the letter. Advisory unless the caller
   * asked for it to be enforced — see `SendOptions`.
   */
  checks?: ChecklistVerdict;
}

// --- The pre-send checklist, on the letter as it is stored -------------------
//
// `coldEmailChecks.preSendCheck` ran in exactly two places — the composer's
// draft routes — and nothing server-side ever read its verdict. An agent's
// `email.draft`, an agent's `email.send` and a sequence step all went past it,
// so "the checklist blocks a send" was true of the screen and of nothing else.
// A rule that must hold on every message cannot depend on whoever composed it,
// which is the same reasoning — and the same failure — as the attachments
// above and as `message.draft` never looking at the lead it was writing to.

/**
 * Which items of the checklist a letter of this purpose answers to.
 *
 * The checklist is the outreach doctrine's, and most of it is about
 * approaching somebody: the opt-out, naming ourselves, the one question, the
 * length of a note, no price. A client's invoice reminder answers to none of
 * those, and telling an agent it "must" add "reply stop" to one is advice that
 * makes the letter worse — so the outreach purposes get the whole checklist
 * and every other letter gets the one item that holds whoever it is to.
 * `fillPlaceholders` leaves an unknown `{{token}}` visible on purpose so a
 * person notices it, and on an agent's or a sequence's letter there may be no
 * person looking. This selects from the one checklist; it never re-states a
 * rule of it, which is what forking it would be.
 */
const ANY_LETTER = new Set(["merge-fields"]);

/**
 * Whether a failing checklist can hold this letter at all.
 *
 * A first approach only. The composer runs the first-email arguments for
 * `COLD_OUTREACH` alone, and a follow-up with no question in it would fail
 * "Exactly one question" — holding it would be inventing a rule the doctrine
 * does not have. Every other purpose is reported on and never held.
 */
export function checklistBinds(purpose: EmailMessage["purpose"]): boolean {
  return purpose === "COLD_OUTREACH";
}

/**
 * The words somebody wrote, with what the renderer added taken back off.
 *
 * `bodyText` is stored as `toText` builds it: the body, the reply-based
 * opt-out on a cold letter, the signature, then the footer. The composer runs
 * the checklist on the body alone, and the difference is not cosmetic — the
 * footer's unsubscribe link carries a `?`, so every stored cold letter has one
 * question more than it was written with, and the signature and footer push
 * the word count past the band a clean note sits in.
 *
 * The footer always opens on a line reading `--` (`textFooter`), which is the
 * one fixed point to cut at. The signature is taken off only when it is the
 * one on file now, and the opt-out only when it is the renderer's own
 * sentence; anything that does not match is left in, where it can only add a
 * warning, never take one away.
 */
function writtenPart(text: string, sign: string | null, cold: boolean): string {
  const footer = text.lastIndexOf("\n--\n");
  let written = (footer >= 0 ? text.slice(0, footer) : text).trimEnd();
  const signed = sign?.trim();
  if (signed && written.endsWith(signed)) written = written.slice(0, -signed.length).trimEnd();
  if (cold && written.endsWith(OPT_OUT_SENTENCE)) written = written.slice(0, -OPT_OUT_SENTENCE.length).trimEnd();
  return written;
}

/**
 * The checklist for one stored message, run the way the composer runs it.
 *
 * Same arguments as `POST /emails/draft` for a first letter — the email
 * channel, `firstEmail`, and the opt-out counted as appended, because the
 * renderer appends it. The one difference is deliberate: the composer passes
 * `optOutAppended` for `COLD_OUTREACH` only, while `renderEmail` appends the
 * sentence to all five outreach purposes, so this passes it for all five
 * rather than reporting a follow-up as missing a sentence it carries.
 *
 * Run on the stored text, which is what will leave: placeholders filled, so a
 * `{{first_name}}` the renderer resolved does not count against the draft and
 * a `{{first_nme}}` it could not does. One verdict for the draft result, the
 * approval card and the send — three answers to one question would be how a
 * card says "sendable" about a letter the send then refuses.
 *
 * Never throws for a reason of its own — `preSendCheck` cannot — and never
 * edits: a checker that rewrites is a second author nobody reviewed.
 */
export async function checklistFor(message: Pick<EmailMessage, "purpose" | "subject" | "bodyText">): Promise<PreSendReport> {
  const cold = COLD_PURPOSES.has(message.purpose);
  const report = preSendCheck({
    subject: message.subject,
    body: writtenPart(message.bodyText, await signature(), cold),
    channel: "EMAIL",
    firstEmail: message.purpose === "COLD_OUTREACH",
    optOutAppended: cold,
  });
  return scopedToPurpose(report, message.purpose);
}

/**
 * The report cut down to the items a letter of this purpose answers to — the
 * whole of it for the five outreach purposes, `ANY_LETTER` for the rest.
 * Exported for `message.draft`, which runs the same checklist on a phone
 * message and must not tell an agent to put "reply stop" on an invoice either.
 */
export function scopedToPurpose(report: PreSendReport, purpose: string): PreSendReport {
  if (COLD_PURPOSES.has(purpose)) return report;
  const checks = report.checks.filter((check) => ANY_LETTER.has(check.id));
  const blocking = checks.filter((check) => !check.passed && check.severity === "BLOCK");
  return {
    checks,
    sendable: blocking.length === 0,
    blocking,
    warnings: checks.filter((check) => !check.passed && check.severity === "WARN"),
    // The six judgement items are about writing to a stranger.
    humanMustConfirm: [],
  };
}

/** One checklist item, as much of it as a reader needs. */
export interface ChecklistItem {
  id: string;
  label: string;
  detail: string;
}

/**
 * The verdict as a tool result, an approval card and a send result carry it.
 *
 * The passed items are left out: a list of ten ticks is ten lines a model
 * re-reads every turn to learn nothing, and a tick for something the checklist
 * did not actually look at reads as a check that happened.
 */
export interface ChecklistVerdict {
  sendable: boolean;
  /**
   * True when a failing verdict stops the send: a first letter, with
   * `flags.deliverables` on. False means the verdict is advice.
   */
  holdsTheSend: boolean;
  blocking: ChecklistItem[];
  warnings: ChecklistItem[];
}

export function checklistVerdict(report: PreSendReport, holdsTheSend: boolean): ChecklistVerdict {
  const item = (check: CheckResult): ChecklistItem => ({ id: check.id, label: check.label, detail: check.detail });
  return { sendable: report.sendable, holdsTheSend, blocking: report.blocking.map(item), warnings: report.warnings.map(item) };
}

/** The blocking items in one line, for an error, a log and a card. */
export function blockingLine(report: { blocking: Array<{ label: string; detail: string }> }): string {
  return report.blocking.map((check) => (check.detail ? `${check.label} (${check.detail})` : check.label)).join("; ");
}

/**
 * Whether a person stands behind this letter. Theirs to send; the checklist
 * only advises them.
 *
 * The kind alone is not enough: the composer stores a letter its drafter wrote
 * as `AI_DRAFT`, and the person who read the red box above it and scheduled it
 * anyway has made the same decision as one pressing Send. `createdById` is
 * that person — the composer sets it, while an agent's `email.draft` (run with
 * no user) and a sequence step leave it empty.
 */
function writtenByAPerson(message: Pick<EmailMessage, "kind" | "createdById">): boolean {
  return message.kind === "MANUAL" || message.kind === "TEMPLATE" || message.createdById !== null;
}

export interface SendOptions {
  /**
   * Refuse a first letter the checklist says is not ready.
   *
   * Only the machine paths pass it — `email.send`, a sequence step, the
   * scheduler for a row no person composed — and only when
   * `flags.deliverables` is on, because holding letters that used to go is a
   * change to work already in flight (`lib/featureFlags.ts`). The composer's
   * Send button never does: a person who has read the red box above their
   * draft and sends it anyway has made a decision, and the checklist was
   * always advice to them.
   */
  enforceChecklist?: boolean;
}

/**
 * Sends one stored message. Safe to call twice: a message that is already SENT
 * returns without doing anything, which is what makes the scheduler and the
 * Send button unable to collide.
 */
export async function sendMessage(id: string, options: SendOptions = {}): Promise<SendResult> {
  const message = await prisma.emailMessage.findUnique({ where: { id } });
  if (!message) throw new Error("Email not found");
  if (message.status === "SENT") return { sent: false, reason: "already-sent", messageId: message.messageId ?? undefined };
  if (message.status === "SENDING") return { sent: false, reason: "in-flight" };
  if (message.status === "CANCELLED") return { sent: false, reason: "cancelled" };

  // The checklist, beside suppression and the claim and before either of
  // them, on the text exactly as it would leave. Before the claim because a
  // refused letter must not take this lead's one first-letter slot, and
  // before SENDING because a row that never went to the socket must not look
  // as if it might have.
  //
  // A failure to *run* it sends the letter as it always went: the checklist is
  // a judgement about the words, and a settings read falling over is not one.
  let report: PreSendReport | null = null;
  try {
    report = await checklistFor(message);
  } catch (err) {
    console.warn(`[email] the pre-send checklist could not run for ${id}: ${(err as Error).message}`);
  }
  const holds = Boolean(options.enforceChecklist) && checklistBinds(message.purpose);
  const checks = report ? checklistVerdict(report, holds) : undefined;

  if (report && !report.sendable) {
    if (holds) {
      // FAILED rather than back to SCHEDULED: the scheduler picks up SCHEDULED
      // rows every minute and would refuse this one every minute for ever.
      // FAILED is the state an outbox already treats as "correct it and send
      // again", and the Send button still sends it — a person is advisory.
      const error = `Not sent — the pre-send checklist holds a first letter that fails it: ${blockingLine(report)}. Edit the draft, or send it yourself from the outbox.`;
      const held = await prisma.emailMessage.updateMany({
        where: { id, status: { in: ["DRAFT", "SCHEDULED", "FAILED"] } },
        data: { status: "FAILED", failedAt: new Date(), error },
      });
      if (held.count !== 1) {
        const now = await prisma.emailMessage.findUnique({ where: { id }, select: { status: true, messageId: true } });
        return { sent: false, reason: now?.status === "SENT" ? "already-sent" : "in-flight", messageId: now?.messageId ?? undefined };
      }
      return { sent: false, reason: `checklist: ${report.blocking.map((check) => check.label).join("; ")}`, checks };
    }
    // Advice nobody asked to enforce still leaves a trace for a letter no
    // person wrote, so "why did that go out like that" has an answer.
    if (!writtenByAPerson(message)) {
      console.warn(`[email] ${message.kind.toLowerCase()} ${message.purpose.toLowerCase()} to ${message.toEmail} fails the checklist (advisory, not held): ${blockingLine(report)}`);
    }
  }

  // What was approved, and whether this lead's one first letter is still
  // unclaimed. A lead outside the concept workflow passes straight through —
  // see services/concept/send.ts, which is also where the reason this is not
  // simply a status check is written down.
  const claim = await claimSend(message);
  if (!claim.ok) return { sent: false, reason: claim.reason ?? "held", checks };

  const suppressed = await isSuppressed(message.toEmail);
  if (suppressed) {
    await prisma.emailMessage.update({
      where: { id },
      data: { status: "CANCELLED", error: `Not sent — ${message.toEmail} is on the suppression list (${suppressed}).` },
    });
    return { sent: false, reason: "suppressed", checks };
  }

  // Claim it before the network call, so a crash leaves a SENDING row to
  // investigate rather than a DRAFT that looks safe to send again.
  //
  // **A conditional update, not a read followed by a write.** The status was
  // read at the top of this function, and between that read and this write two
  // callers — the Send button and the scheduler coming due in the same second —
  // can both have seen DRAFT. Narrowing the update by status is what makes the
  // second one lose: `count` is 0 and it stops here rather than opening a
  // socket for a letter that is already in flight.
  const taken = await prisma.emailMessage.updateMany({
    where: { id, status: { in: ["DRAFT", "SCHEDULED", "FAILED"] } },
    data: { status: "SENDING", attempts: { increment: 1 } },
  });
  if (taken.count !== 1) {
    const now = await prisma.emailMessage.findUnique({ where: { id }, select: { status: true, messageId: true } });
    return { sent: false, reason: now?.status === "SENT" ? "already-sent" : "in-flight", messageId: now?.messageId ?? undefined };
  }

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
      category: `email:${message.purpose.toLowerCase()}`,
      unsubscribeUrl: COLD_PURPOSES.has(message.purpose)
        ? `${await appUrl()}/api/emails/unsubscribe?email=${encodeURIComponent(message.toEmail)}`
        : null,
    });

    await prisma.emailMessage.update({
      where: { id },
      data: { status: "SENT", sentAt: new Date(), messageId: result.messageId, error: null },
    });
    await settleSend(message.leadId, { sent: true });
    await logCommunication(message);
    // The Hostinger path answers a send with no body, so there is no
    // Message-ID to report; sent is still sent.
    return { sent: true, messageId: result.messageId ?? undefined, checks };
  } catch (err) {
    const reason = err instanceof MailerError ? err.message : (err as Error).message;

    // **A refusal and a silence are not the same failure.** A MailerError is
    // the server saying no — nothing was delivered, and the row can go back to
    // FAILED where it is safe to correct and send again. Anything else is a
    // socket that closed or a call that never came back, and the letter may
    // well have arrived. Retrying that is how a stranger gets two first emails,
    // so the row stays SENDING — which every path in this file already refuses
    // to touch — and the lead is held as uncertain for a person to reconcile
    // against the mailbox.
    const uncertain = !(err instanceof MailerError);
    await prisma.emailMessage.update({
      where: { id },
      data: uncertain
        ? { error: `Unresolved: ${reason} The message may have been delivered; check the mailbox before sending again.` }
        : { status: "FAILED", failedAt: new Date(), error: reason },
    });
    await settleSend(message.leadId, { sent: false, uncertain, reason });
    return { sent: false, reason, checks };
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
/**
 * The website review a first letter should leave with, if there is one.
 *
 * Three conditions, all of them necessary:
 *
 * - **A first approach to a lead.** A client update carrying an audit of a
 *   stranger's website is nonsense, and a follow-up already sent the report
 *   with the first letter.
 * - **More than one serious fault.** One fault is an email about that fault
 *   and nothing to attach — the report exists to hold the ones the letter
 *   deliberately does not name. See `redFlags()` in `services/leadPrep.ts`.
 * - **A rendered PDF on the most recent review.** No file, no sentence: the
 *   drafter is told the same thing from the same facts, so the letter and the
 *   attachment agree about whether a report exists.
 */
export async function reportToAttach(args: { purpose: EmailMessage["purpose"]; leadId?: string | null }): Promise<StoredAttachment | null> {
  if (args.purpose !== "COLD_OUTREACH" || !args.leadId) return null;

  const [audit, research] = await Promise.all([
    prisma.websiteAudit.findFirst({
      where: { leadId: args.leadId, pdfFileId: { not: null } },
      orderBy: { ranAt: "desc" },
      // The report as well as the id: the count below decides whether this is
      // attached at all, and counting the scan's two checks while the review
      // sitting in the same row found six is how a letter comes to say "a few
      // other things came up" about a document nobody read.
      select: { id: true, report: true },
    }),
    prisma.leadResearch.findUnique({ where: { leadId: args.leadId }, select: { audit: true, look: true } }),
  ]);
  if (!audit || !research) return null;
  if (redFlags(research.audit as never, research.look as never, audit.report as never).length < 2) return null;

  return { kind: "audit", auditId: audit.id };
}

/**
 * What the server attaches on its own, on top of whatever the sender listed.
 *
 * An email written about an invoice carries the invoice, and one written about
 * a proposal carries the proposal — whoever wrote it and however it was asked
 * for. The link fields decide what the message is *about*; this is what makes
 * the document actually leave with it, so "attach the PDF" is never a step
 * somebody can forget. And a first letter that names one fault out of several
 * carries the rest: the doctrine tells the writer to say "a few other things
 * came up and they are in the attached report", and a rule that has to hold on
 * every message cannot depend on whoever composed it remembering to tick a box.
 *
 * It is a function of its own — rather than five lines inside `composeMessage`
 * — because the composer has to be able to *show* these before anything is
 * sent. A file that appears on the sent record and appeared nowhere on the
 * screen the sender was looking at is the same class of mistake as a letter
 * referring to an attachment that is not there: the sender is answering for a
 * document they were never shown. `GET /emails/context/attachments` and the
 * preview both read this, so what the composer draws and what leaves with the
 * letter are worked out by one piece of code.
 *
 * Anything the caller listed themselves is left exactly as they listed it, and
 * never repeated here.
 */
export async function automaticAttachments(args: {
  purpose: EmailMessage["purpose"];
  leadId?: string | null;
  invoiceId?: string | null;
  proposalId?: string | null;
  attachReport?: boolean;
  existing?: StoredAttachment[];
}): Promise<StoredAttachment[]> {
  const listed = args.existing ?? [];
  const added: StoredAttachment[] = [];
  const already = (match: (entry: StoredAttachment) => boolean) => listed.some(match) || added.some(match);

  if (args.invoiceId && !already((entry) => (entry as { kind?: string }).kind === "invoice" && (entry as { invoiceId?: string }).invoiceId === args.invoiceId)) {
    added.push({ kind: "invoice", invoiceId: args.invoiceId });
  }
  if (args.proposalId && !already((entry) => (entry as { kind?: string }).kind === "proposal" && (entry as { proposalId?: string }).proposalId === args.proposalId)) {
    added.push({ kind: "proposal", proposalId: args.proposalId });
  }

  const report = args.attachReport === false ? null : await reportToAttach(args);
  const auditId = (report as { auditId?: string } | null)?.auditId;
  if (report && !already((entry) => (entry as { kind?: string }).kind === "audit" && (entry as { auditId?: string }).auditId === auditId)) {
    added.push(report);
  }

  return added;
}

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
  /**
   * Refuse the website review this letter would otherwise carry.
   *
   * Only ever set by a person who has decided this particular email should not
   * have it. There is deliberately no way for a model to set it: the report is
   * what makes "several other things came up" an honest sentence rather than
   * an unsupported one.
   */
  attachReport?: boolean;
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
    // Only a lead has one. A client wrote to us first, which is Art 13 and
    // carries no source to disclose.
    leadSource: context.leadSource,
  });

  // The invoice, the proposal and the website review — see
  // `automaticAttachments`, which the composer also reads so the sender sees
  // these on screen before pressing Send.
  const attachments = [...(args.attachments ?? [])];
  attachments.push(...(await automaticAttachments({ ...args, existing: attachments })));

  const created = await prisma.emailMessage.create({
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

  // A first letter for a lead in the concept workflow moves it to EMAIL_READY.
  // Follow-ups, thank-yous and invoice deliveries are different letters with
  // different decisions behind them, so `noteEmailDraft` ignores them.
  await noteEmailDraft(created.leadId, created.id, created.purpose);
  return created;
}

/** The scheduler's half: anything scheduled whose time has come. */
export async function dispatchDueEmails(now = new Date()): Promise<number> {
  const due = await prisma.emailMessage.findMany({
    where: { status: "SCHEDULED", scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: 25,
    select: { id: true, kind: true, createdById: true },
  });
  if (due.length === 0) return 0;

  // A row a person scheduled is theirs, exactly as the Send button is — see
  // `writtenByAPerson`. A row a model or a sequence wrote with nobody behind
  // it is held to the checklist once the flag is on, and a held one is FAILED,
  // so it is not picked up again here.
  const enforce = await flagOn(FLAG.DELIVERABLES);
  let sent = 0;
  for (const message of due) {
    const result = await sendMessage(message.id, { enforceChecklist: enforce && !writtenByAPerson(message) });
    if (result.sent) sent += 1;
  }
  if (sent > 0) console.log(`[email] sent ${sent} scheduled message(s)`);
  return sent;
}
