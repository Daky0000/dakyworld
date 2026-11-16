import { SETTING, getSetting } from "./settings.js";
import type { Attachment, SendArgs, SendReceipt } from "./mailer.js";

/**
 * Sending through Mailflare, the mail app DakyXTech runs on its own Cloudflare
 * account.
 *
 * Mailflare has no SMTP listener when it runs on Workers, so this is its HTTP
 * API: one POST to `/api/v1/send` with a key that carries the `send` scope for
 * one mailbox. The sent copy lands in that mailbox's Sent folder, which is the
 * point — what the OS sends and what a person sends from the inbox are then in
 * one place.
 *
 * The API takes no custom headers, so `replyTo` and `unsubscribeUrl` are
 * dropped here exactly as they are on the Hostinger path. `inReplyTo` is kept:
 * Mailflare writes the threading headers itself.
 *
 * **The letterhead artwork goes as inline parts.** An attachment that carries a
 * `contentId` is sent inline, and the HTML shows it with `cid:`. That field
 * is DakyXTech's own addition to Mailflare's send route — upstream sends every
 * file as a plain attachment — so a Mailflare redeployed from an untouched
 * upstream copy brings the broken-image boxes back. See the mailflare folder.
 */

export class MailflareMailError extends Error {
  status: number;
  /** True only when Mailflare certainly did not take the message. */
  safeToRetry: boolean;
  constructor(status: number, message: string, safeToRetry = false) {
    super(message);
    this.name = "MailflareMailError";
    this.status = status;
    this.safeToRetry = safeToRetry;
  }
}

interface MailflareConfig {
  url: string;
  apiKey: string;
  mailboxId: string;
  fromName: string;
  fromEmail: string;
}

/** Mailflare's own ceiling is 14 MB of base64 per file; stay under it. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export async function readMailflareConfig(): Promise<MailflareConfig | null> {
  const [url, apiKey, mailboxId, address, fromName, fromEmail] = await Promise.all([
    getSetting(SETTING.MAILFLARE_URL),
    getSetting(SETTING.MAILFLARE_API_KEY),
    getSetting(SETTING.MAILFLARE_MAILBOX_ID),
    getSetting(SETTING.MAILFLARE_MAILBOX_ADDRESS),
    getSetting(SETTING.MAIL_FROM_NAME),
    getSetting(SETTING.MAIL_FROM_EMAIL),
  ]);
  // The key may only send as its own mailbox, so that address wins over the
  // general From setting, which may still name a mailbox somewhere else.
  const from = address ?? fromEmail;
  if (!url || !apiKey || !mailboxId || !from) return null;
  return { url: url.replace(/\/+$/, ""), apiKey, mailboxId, fromName: fromName ?? "DakyXTech", fromEmail: from };
}

export async function mailflareConfigured(): Promise<boolean> {
  return (await readMailflareConfig()) !== null;
}

async function encodeAttachments(attachments: Attachment[]) {
  const encoded: { filename: string; type: string; contentBase64: string; contentId?: string }[] = [];
  for (const attachment of attachments) {
    let buffer: Buffer | null = attachment.content ?? null;
    if (!buffer && attachment.path) {
      const response = await fetch(attachment.path).catch((err: Error) => {
        throw new MailflareMailError(502, `Could not fetch the attachment ${attachment.filename}: ${err.message}`, true);
      });
      if (!response.ok) {
        throw new MailflareMailError(502, `Could not fetch the attachment ${attachment.filename} (${response.status}).`, true);
      }
      buffer = Buffer.from(await response.arrayBuffer());
    }
    if (!buffer) continue;
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new MailflareMailError(400, `${attachment.filename} is too large to send as an attachment.`);
    }
    encoded.push({
      filename: attachment.filename,
      type: attachment.contentType ?? "application/octet-stream",
      contentBase64: buffer.toString("base64"),
      ...(attachment.cid ? { contentId: attachment.cid } : {}),
    });
  }
  return encoded;
}

const quoteName = (name: string) => `"${name.replace(/["\\\r\n]/g, "")}"`;

export async function sendViaMailflare(args: SendArgs): Promise<SendReceipt> {
  const config = await readMailflareConfig();
  if (!config) {
    throw new MailflareMailError(503, "Mailflare isn't connected yet — set its address, API key and mailbox to send anything.");
  }

  const attachments = await encodeAttachments(args.attachments ?? []);
  const body = {
    mailboxId: config.mailboxId,
    from: `${quoteName(config.fromName)} <${config.fromEmail}>`,
    to: [args.toName ? `${quoteName(args.toName)} <${args.to}>` : args.to],
    ...(args.cc?.length ? { cc: args.cc } : {}),
    ...(args.bcc?.length ? { bcc: args.bcc } : {}),
    subject: args.subject,
    html: args.html,
    text: args.text,
    ...(args.inReplyTo ? { inReplyTo: args.inReplyTo, references: args.inReplyTo } : {}),
    ...(attachments.length ? { attachments } : {}),
  };

  let response: Response;
  try {
    response = await fetch(`${config.url}/api/v1/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    // A timeout may have landed after the message was accepted, so only a
    // connection that never opened is safe to try again.
    const timedOut = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
    throw new MailflareMailError(502, `Could not reach Mailflare: ${(err as Error).message}`, !timedOut);
  }

  const payload = (await response.json().catch(() => null)) as { messageId?: string; error?: unknown } | null;
  if (!response.ok) {
    const reason = typeof payload?.error === "string" ? payload.error : JSON.stringify(payload?.error ?? response.statusText);
    if (response.status === 401) {
      throw new MailflareMailError(503, "Mailflare rejected the API key. Create a new key with the Send permission and store it.");
    }
    // 429 and 503 are refusals before anything was sent; other errors are final.
    throw new MailflareMailError(response.status, `Mailflare refused the message: ${reason}`, response.status === 429 || response.status === 503);
  }

  return { messageId: payload?.messageId ?? null, accepted: [args.to, ...(args.cc ?? []), ...(args.bcc ?? [])] };
}
