import nodemailer, { type Transporter } from "nodemailer";
import { SETTING, getSetting } from "./settings.js";

/**
 * Outbound email.
 *
 * **SMTP, not a provider API.** Every mailbox Dakyworld might send from —
 * Google Workspace, the Hostinger mailbox on the domain, Zoho — already speaks
 * SMTP, and none of them need a new account opening or a domain re-verifying
 * to start. A provider API would be one more service to sign up for before the
 * first email could go out.
 *
 * **Configured at use, like Stripe.** The credentials live encrypted in
 * `AppSetting` so they can be pasted in and rotated without a redeploy, which
 * means the transport can't be a module constant built from `process.env`. It
 * is rebuilt only when the configuration actually changes.
 *
 * **Nothing sends without a From address.** A message with no verified sender
 * is either rejected or silently spam-filed, and the second is worse. So
 * `getMailer` returns null unless host, user, password and from-address are
 * all present, and every call site turns that into a 503 that says so.
 */

export class MailerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MailerError";
    this.status = status;
  }
}

export interface MailerConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
}

export interface Attachment {
  filename: string;
  /** A URL nodemailer fetches, or a buffer this app rendered (an invoice PDF). */
  path?: string;
  content?: Buffer;
  contentType?: string;
}

export async function readMailerConfig(): Promise<MailerConfig | null> {
  const [host, port, secure, user, password, fromName, fromEmail, replyTo] = await Promise.all([
    getSetting(SETTING.SMTP_HOST),
    getSetting(SETTING.SMTP_PORT),
    getSetting(SETTING.SMTP_SECURE),
    getSetting(SETTING.SMTP_USER),
    getSetting(SETTING.SMTP_PASSWORD),
    getSetting(SETTING.MAIL_FROM_NAME),
    getSetting(SETTING.MAIL_FROM_EMAIL),
    getSetting(SETTING.MAIL_REPLY_TO),
  ]);

  if (!host || !user || !password || !fromEmail) return null;

  const portNumber = Number(port ?? 587) || 587;
  return {
    host,
    port: portNumber,
    // 465 is implicit TLS; 587 upgrades with STARTTLS. Getting this wrong is
    // the single most common reason a working mailbox refuses to connect, so
    // it follows the port unless it was set explicitly.
    secure: secure === null ? portNumber === 465 : secure === "true",
    user,
    password,
    fromName: fromName ?? "Dakyworld",
    fromEmail,
    replyTo: replyTo ?? null,
  };
}

export async function mailerConfigured(): Promise<boolean> {
  return (await readMailerConfig()) !== null;
}

function buildTransport(config: MailerConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    // A hung SMTP handshake must not hold a request open indefinitely.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

let cached: { fingerprint: string; transport: Transporter } | null = null;

function fingerprint(config: MailerConfig): string {
  return `${config.host}:${config.port}:${config.secure}:${config.user}:${config.password}`;
}

export async function getMailer(): Promise<{ transport: Transporter; config: MailerConfig } | null> {
  const config = await readMailerConfig();
  if (!config) return null;
  const print = fingerprint(config);
  if (!cached || cached.fingerprint !== print) cached = { fingerprint: print, transport: buildTransport(config) };
  return { transport: cached.transport, config };
}

/**
 * Checks the credentials against the server before they are stored, so a typo
 * fails on the Settings screen rather than silently at 6am when a sequence
 * tries to send.
 */
export async function verifySmtp(config: MailerConfig): Promise<{ host: string }> {
  const transport = buildTransport(config);
  try {
    await transport.verify();
    return { host: config.host };
  } catch (err) {
    const message = (err as Error).message;
    // The two failures worth naming: everything else is passed through.
    if (/invalid login|auth|535/i.test(message)) {
      throw new MailerError(
        400,
        "The mail server rejected those credentials. If this is a Google Workspace account, use an App Password rather than the account password.",
      );
    }
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
      throw new MailerError(400, `Could not reach ${config.host}:${config.port}. Check the host and port.`);
    }
    throw new MailerError(400, `The mail server refused the connection: ${message}`);
  } finally {
    transport.close();
  }
}

export interface SendArgs {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string | null;
  attachments?: Attachment[];
  /** Message-ID of the email this answers, so it threads rather than starting anew. */
  inReplyTo?: string | null;
  /** List-Unsubscribe target. Cold email without one is asking to be marked spam. */
  unsubscribeUrl?: string | null;
}

export async function sendMail(args: SendArgs): Promise<{ messageId: string; accepted: string[] }> {
  const mailer = await getMailer();
  if (!mailer) {
    throw new MailerError(503, "Email isn't connected yet — add the mailbox under Settings → Email to send anything.");
  }
  const { transport, config } = mailer;

  const headers: Record<string, string> = {};
  if (args.inReplyTo) {
    headers["In-Reply-To"] = args.inReplyTo;
    headers["References"] = args.inReplyTo;
  }
  if (args.unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${args.unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const info = await transport.sendMail({
    from: { name: config.fromName, address: config.fromEmail },
    to: args.toName ? { name: args.toName, address: args.to } : args.to,
    cc: args.cc?.length ? args.cc : undefined,
    bcc: args.bcc?.length ? args.bcc : undefined,
    replyTo: args.replyTo ?? config.replyTo ?? undefined,
    subject: args.subject,
    html: args.html,
    text: args.text,
    attachments: args.attachments,
    headers,
  });

  return { messageId: info.messageId, accepted: (info.accepted ?? []).map(String) };
}
