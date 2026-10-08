import nodemailer, { type Transporter } from "nodemailer";
import { SETTING, getSetting } from "./settings.js";
import { HostingerMailError, hostingerConfigured, sendViaHostinger } from "./hostingerMail.js";
import { inlineBrandImages } from "./brandAssets.js";
import { prisma } from "./prisma.js";

/**
 * Outbound email.
 *
 * **Two ways out, one door.** Everything in the app sends through `sendMail`
 * and nothing else knows which transport is live:
 *
 * - **SMTP**, which works with any mailbox — Google Workspace, Zoho, a
 *   cPanel address — because all of them already speak it, and none need a new
 *   account opening or a domain re-verifying before the first email goes out.
 * - **Hostinger Agentic Mail**, for the mailbox on the domain, over the MCP
 *   server it ships with. Five SMTP fields collapse into one API token, which
 *   is the difference between connecting mail in a minute and connecting it in
 *   an evening. See lib/hostingerMail.ts.
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
  /** Set on the letterhead artwork, which the HTML points at as `cid:…`. */
  cid?: string;
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
    fromName: fromName ?? "DakyXTech",
    fromEmail,
    replyTo: replyTo ?? null,
  };
}

export type MailTransport = "SMTP" | "HOSTINGER";

/**
 * Which path sends. The stored choice wins; with nothing stored it falls back
 * to whichever is actually configured, so an existing SMTP deploy keeps sending
 * without anyone visiting Settings.
 */
export async function activeTransport(): Promise<MailTransport> {
  const stored = await getSetting(SETTING.MAIL_TRANSPORT);
  if (stored === "HOSTINGER" || stored === "SMTP") return stored;
  if (await readMailerConfig()) return "SMTP";
  return (await hostingerConfigured()) ? "HOSTINGER" : "SMTP";
}

export async function mailerConfigured(): Promise<boolean> {
  return (await activeTransport()) === "HOSTINGER" ? hostingerConfigured() : (await readMailerConfig()) !== null;
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

/**
 * One message, as every caller describes it. Three fields are SMTP-only and are
 * dropped on the Hostinger path, which takes no custom headers: `replyTo`,
 * `inReplyTo` and `unsubscribeUrl`. The opt-out link inside the body of a cold
 * email is rendered separately and is unaffected — see services/emailRender.ts.
 */
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
  /** What kind of email this is, for the delivery log ("account:Set your password"). */
  category?: string | null;
}

export interface SendReceipt {
  /** Null on the Hostinger path — it answers a send with no body, so there is no id to keep. */
  messageId: string | null;
  accepted: string[];
}

async function sendOnce(args: SendArgs, transportName: MailTransport): Promise<SendReceipt> {
  // The letterhead artwork rides along as inline parts, added here rather than
  // at compose time so a draft written last week still goes out on the current
  // identity — and so nothing is attached to a message that doesn't show it.
  const withBranding: SendArgs = {
    ...args,
    attachments: [...(args.attachments ?? []), ...(await inlineBrandImages(args.html))],
  };

  if (transportName === "HOSTINGER") {
    try {
      return await sendViaHostinger(withBranding);
    } catch (err) {
      // One error type reaches the routes, whichever transport failed.
      if (err instanceof HostingerMailError) throw new MailerError(err.status, err.message);
      throw err;
    }
  }

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
    attachments: withBranding.attachments,
    headers,
  });

  return { messageId: info.messageId, accepted: (info.accepted ?? []).map(String) };
}

/** How many times one message is tried, and the waits between tries. */
const ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 8_000];

/**
 * Whether trying again could help *and* could not send the message twice.
 *
 * Only failures where the server certainly did not take the message: it
 * answered with a temporary 4xx refusal ("try later", greylisting, rate limit),
 * or the connection never got as far as sending anything. A timeout in the
 * middle of DATA is not retried — the message may already have gone, and a
 * customer receiving their invoice twice is worse than one failure we can see.
 */
function transient(error: unknown): boolean {
  if (error instanceof HostingerMailError) return error.safeToRetry;
  const e = error as { responseCode?: number; code?: string; command?: string };
  if (typeof e.responseCode === "number") return e.responseCode >= 400 && e.responseCode < 500;
  if (e.command === "CONN") return true;
  return e.code === "ECONNECTION" || e.code === "EDNS" || e.code === "ECONNREFUSED";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one email, tries again on a temporary failure, and records the outcome.
 *
 * Every path that sends mail comes through here, so every send — an account
 * link, a form message, a reminder, an outreach letter — leaves a row in
 * `MailDelivery` saying whether the mail server took it. A failed send used to
 * be a console line on whichever deploy happened to be running.
 */
export async function sendMail(args: SendArgs): Promise<SendReceipt> {
  const transportName = await activeTransport();
  let attempts = 0;
  let lastError: unknown = null;
  for (; attempts < ATTEMPTS; ) {
    attempts += 1;
    try {
      const receipt = await sendOnce(args, transportName);
      await recordDelivery(args, transportName, "SENT", attempts, null, receipt.messageId);
      return receipt;
    } catch (error) {
      lastError = error;
      if (attempts >= ATTEMPTS || !transient(error)) break;
      console.warn(`[mail] ${transportName} send to ${args.to} failed (attempt ${attempts}), retrying: ${(error as Error).message}`);
      await sleep(BACKOFF_MS[attempts - 1] ?? 8_000);
    }
  }
  await recordDelivery(args, transportName, "FAILED", attempts, (lastError as Error)?.message ?? String(lastError), null);
  throw lastError;
}

/** Best effort: a database hiccup must never turn a delivered email into a failed request. */
async function recordDelivery(args: SendArgs, transport: MailTransport, status: "SENT" | "FAILED", attempts: number, error: string | null, messageId: string | null) {
  try {
    await prisma.mailDelivery.create({
      data: {
        toEmail: args.to.slice(0, 320),
        subject: args.subject.slice(0, 300),
        category: args.category?.slice(0, 120) ?? null,
        transport,
        status,
        attempts,
        error: error?.slice(0, 1000) ?? null,
        messageId,
      },
    });
    // Kept for 90 days. Pruned now and then rather than on a schedule, so it
    // needs no job of its own.
    if (Math.random() < 0.02) {
      await prisma.mailDelivery.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } });
    }
  } catch (err) {
    console.warn(`[mail] could not record a delivery: ${(err as Error).message}`);
  }
}
