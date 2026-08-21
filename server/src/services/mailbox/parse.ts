import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";

/**
 * A message off the wire, turned into the handful of things this app cares
 * about.
 *
 * Two jobs, both about *not* storing what arrived. A mailbox contains
 * megabytes of quoted history, tracking pixels, base64 attachments and
 * fourteen headers per hop, and none of it makes a routing decision better.
 * So: the bodies are capped, the attachments are recorded by name and size
 * with their bytes left in the mailbox, and the quoted history is cut off the
 * bottom before anything reads it.
 *
 * **Cutting the quote is not cosmetic.** A model sent the whole of a five-deep
 * reply chain reads our own cold email as loudly as their one-line answer, and
 * classifies a "no thanks" as an outreach. It is also what the cost looks like:
 * the trimmed body is a paragraph and the untrimmed one is a book.
 */

/** Enough of a body for a person and a model both. */
const MAX_TEXT = 20_000;
/** Kept only for display. Newsletters are enormous and nothing reads this. */
const MAX_HTML = 120_000;
const SNIPPET = 220;

export interface MailboxMessage {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  /** The new writing only — quoted history removed. What the model reads. */
  bodyText: string;
  bodyHtml: string | null;
  snippet: string;
  sentAt: Date;
  attachments: { filename: string; contentType: string; size: number }[];
  /** A machine sent this: an out-of-office, a newsletter, a receipt. */
  autoSubmitted: boolean;
  /** A delivery failure report. Stronger than `autoSubmitted` and acted on. */
  bounce: boolean;
}

function addresses(field: AddressObject | AddressObject[] | undefined): { email: string; name: string | null }[] {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  return list.flatMap((entry) =>
    (entry.value ?? [])
      .filter((value) => Boolean(value.address))
      .map((value) => ({ email: value.address!.toLowerCase().trim(), name: value.name?.trim() || null })),
  );
}

function headerValue(mail: ParsedMail, name: string): string | null {
  const raw = mail.headers.get(name);
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && "value" in raw && typeof (raw as { value: unknown }).value === "string") {
    return (raw as { value: string }).value;
  }
  return String(raw);
}

/**
 * Where the reply ends and the history begins.
 *
 * Each of these is a marker a mail client writes when it quotes. They are
 * matched against the *start* of a line so that a sentence mentioning "on
 * Monday" does not truncate somebody's actual answer — a false cut is worse
 * than a missed one, because the part that gets thrown away is the part that
 * was written by hand.
 */
const QUOTE_MARKERS: RegExp[] = [
  /^-{2,}\s*original message\s*-{2,}/i,
  /^-{2,}\s*forwarded message\s*-{2,}/i,
  /^_{10,}$/,
  /^on .{4,120}\bwrote:\s*$/i,
  /^on .{4,200},?\s*$/i, // "On Tue, 12 Aug 2026 at 09:14, Dan" — the "wrote:" wrapped
  /^from:\s*.+<.+@.+>/i,
  /^sent from my \w+/i,
  /^>{1,3}\s?/, // a quoted block that starts without any header at all
];

export function stripQuotedHistory(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (!QUOTE_MARKERS.some((marker) => marker.test(line))) continue;
    // Never cut the whole message away. A reply written *under* the quote —
    // which is how a good deal of the world still writes — would otherwise
    // arrive as an empty body, and an empty body classifies as nothing.
    const kept = lines.slice(0, index).join("\n").trim();
    if (kept.length >= 20) return kept;
    return text.trim();
  }
  return text.trim();
}

/** A machine wrote this, and it must never be mistaken for a reply. */
function isAutomated(mail: ParsedMail, subject: string): boolean {
  const autoSubmitted = headerValue(mail, "auto-submitted");
  if (autoSubmitted && autoSubmitted.toLowerCase().trim() !== "no") return true;

  const precedence = headerValue(mail, "precedence")?.toLowerCase() ?? "";
  if (["bulk", "list", "auto_reply", "junk"].includes(precedence.trim())) return true;

  for (const header of ["x-autoreply", "x-autorespond", "x-auto-response-suppress", "list-id", "list-unsubscribe"]) {
    if (mail.headers.has(header)) return true;
  }
  // The subject line is the last resort and the most common signal, because a
  // great many corporate autoresponders set none of the headers above.
  return /^(auto(matic)?[\s-]?reply|out of (the )?office|away from|automatische|réponse automatique)\b/i.test(subject.trim()) ||
    /\bout of (the )?office\b/i.test(subject.trim());
}

/** A delivery failure. The address is dead and writing to it again costs reputation. */
function isBounce(mail: ParsedMail, fromEmail: string, subject: string): boolean {
  if (/^(mailer-daemon|postmaster|no-?reply@.*(mail|smtp))/i.test(fromEmail)) return true;
  const contentType = headerValue(mail, "content-type") ?? "";
  if (/report-type\s*=\s*"?delivery-status/i.test(contentType)) return true;
  return /^(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice)/i.test(subject.trim());
}

/**
 * Parses one raw RFC822 source.
 *
 * Never throws on a malformed message: a mailbox holds mail from every client
 * ever written, and one that cannot be parsed must be filed as unreadable
 * rather than stopping the whole sync at message four hundred.
 */
export async function parseMessage(source: Buffer, fallbackDate: Date): Promise<MailboxMessage> {
  const mail = await simpleParser(source, { skipImageLinks: true });

  const from = addresses(mail.from)[0] ?? { email: "unknown@unknown.invalid", name: null };
  const subject = (mail.subject ?? "").trim() || "(no subject)";

  const rawText = mail.text ?? (mail.html ? String(mail.html).replace(/<[^>]+>/g, " ") : "");
  const bodyText = stripQuotedHistory(rawText).slice(0, MAX_TEXT);
  const html = typeof mail.html === "string" ? mail.html : null;

  const references = Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [];

  return {
    messageId: mail.messageId?.trim() || null,
    inReplyTo: mail.inReplyTo?.trim() || null,
    references: references.map((value) => value.trim()).filter(Boolean),
    fromEmail: from.email,
    fromName: from.name,
    toEmails: addresses(mail.to).map((entry) => entry.email),
    ccEmails: addresses(mail.cc).map((entry) => entry.email),
    subject,
    bodyText,
    bodyHtml: html ? html.slice(0, MAX_HTML) : null,
    snippet: bodyText.replace(/\s+/g, " ").trim().slice(0, SNIPPET),
    sentAt: mail.date ?? fallbackDate,
    attachments: (mail.attachments ?? []).map((attachment) => ({
      filename: attachment.filename ?? "(unnamed)",
      contentType: attachment.contentType ?? "application/octet-stream",
      size: attachment.size ?? 0,
    })),
    autoSubmitted: isAutomated(mail, subject),
    bounce: isBounce(mail, from.email, subject),
  };
}
