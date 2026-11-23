import { SETTING, getSetting } from "./settings.js";

/**
 * Reading the mailbox from Mailflare, over JMAP (RFC 8620/8621).
 *
 * Since 16 Nov 2026 mail for dakyx.com arrives at Resend and is filed by
 * Mailflare. The Hostinger mailbox the IMAP reader watched receives nothing,
 * so a lead's reply never reached the mail room: no triage, no routing, and
 * the sequence kept writing to somebody who had already answered.
 *
 * Mailflare runs on Workers and has no IMAP listener. JMAP is its reading
 * protocol: `Email/query` finds what arrived after the cursor, `Email/get`
 * names each message's blob, and the download URL returns the stored raw
 * MIME, which goes through the same `parseMessage` and `ingestMessage` as an
 * IMAP fetch. The key needs the `jmap` scope; a `read`-only key cannot reach
 * `/jmap` at all.
 */

export interface MailflareReadConfig {
  url: string;
  key: string;
  /** Mailflare's own mailbox id (`mbx_…`), which is also its JMAP account-level mailbox. */
  mailboxId: string;
  /** The address the mailbox receives for, e.g. info@dakyx.com. */
  address: string;
}

export class MailflareReadError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MailflareReadError";
    this.status = status;
  }
}

export async function readMailflareReadConfig(): Promise<MailflareReadConfig | null> {
  const [url, key, mailboxId, address, fromEmail] = await Promise.all([
    getSetting(SETTING.MAILFLARE_URL),
    getSetting(SETTING.MAILFLARE_READ_KEY),
    getSetting(SETTING.MAILFLARE_MAILBOX_ID),
    getSetting(SETTING.MAILFLARE_MAILBOX_ADDRESS),
    getSetting(SETTING.MAIL_FROM_EMAIL),
  ]);
  const mailbox = (address ?? fromEmail)?.trim().toLowerCase();
  if (!url || !key || !mailboxId || !mailbox) return null;
  return { url: url.replace(/\/+$/, ""), key: key.trim(), mailboxId, address: mailbox };
}

export async function mailflareReadConfigured(): Promise<boolean> {
  return (await readMailflareReadConfig()) !== null;
}

interface Session {
  apiUrl: string;
  downloadUrl: string;
  accountId: string;
}

const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
const TIMEOUT_MS = 30_000;

async function request(config: MailflareReadConfig, url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${config.key}`, Accept: "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new MailflareReadError(502, `Could not reach Mailflare: ${(err as Error).message}`);
  }
  if (response.status === 401) throw new MailflareReadError(401, "Mailflare rejected the reading key. Create a key with the JMAP permission for info@ and paste it on the Inbox page.");
  if (response.status === 403) throw new MailflareReadError(403, "That Mailflare key cannot read mail: it needs the JMAP permission.");
  // Error 1102 is Cloudflare's "Worker exceeded resource limits" page on the free plan.
  if (!response.ok) throw new MailflareReadError(response.status, `Mailflare answered ${response.status}${response.status >= 500 ? " (if this keeps happening, the Worker is over its CPU limit — Workers Paid fixes it)" : ""}.`);
  return response;
}

/** One session per key for five minutes: a pass downloads many messages and each would otherwise ask again. */
let cachedSession: { key: string; url: string; at: number; session: Session } | null = null;
const SESSION_TTL_MS = 5 * 60_000;

async function session(config: MailflareReadConfig): Promise<Session> {
  if (cachedSession && cachedSession.key === config.key && cachedSession.url === config.url && Date.now() - cachedSession.at < SESSION_TTL_MS) {
    return cachedSession.session;
  }
  const fresh = await loadSession(config);
  cachedSession = { key: config.key, url: config.url, at: Date.now(), session: fresh };
  return fresh;
}

async function loadSession(config: MailflareReadConfig): Promise<Session> {
  const response = await request(config, `${config.url}/.well-known/jmap`);
  const body = (await response.json().catch(() => null)) as { apiUrl?: string; downloadUrl?: string; primaryAccounts?: Record<string, string> } | null;
  const accountId = body?.primaryAccounts?.[MAIL_CAPABILITY];
  if (!body?.apiUrl || !body.downloadUrl || !accountId) throw new MailflareReadError(502, "Mailflare's JMAP session was missing its API address or account.");
  return { apiUrl: body.apiUrl, downloadUrl: body.downloadUrl, accountId };
}

/** Proves the key works before it is stored. Returns the account the key reads. */
export async function checkMailflareRead(config: MailflareReadConfig): Promise<string> {
  const s = await loadSession(config);
  return s.accountId;
}

export interface MailflareEmail {
  id: string;
  blobId: string;
  receivedAt: Date;
  /** Bare Message-ID, no angle brackets, when Mailflare stored one. */
  messageId: string | null;
  folder: "INBOX" | "SENT";
}

type JmapResponse = { methodResponses?: [string, Record<string, unknown>, string][] };

/**
 * What arrived at or after `after`, oldest first, at most `limit`.
 *
 * Drafts and trash are left out; junk is kept and filed as INBOX, because the
 * mail room's own triage decides what is spam, and a lead's reply that Mailflare
 * misjudged is exactly the message that must not be missed.
 */
export async function listMailflareEmails(config: MailflareReadConfig, after: Date, limit: number): Promise<MailflareEmail[]> {
  const s = await session(config);
  const body = {
    using: [CORE_CAPABILITY, MAIL_CAPABILITY],
    methodCalls: [
      [
        "Email/query",
        {
          accountId: s.accountId,
          filter: { inMailbox: config.mailboxId, after: after.toISOString() },
          sort: [{ property: "receivedAt", isAscending: true }],
          limit,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: s.accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["id", "blobId", "mailboxIds", "receivedAt", "messageId"],
        },
        "g",
      ],
    ],
  };
  const response = await request(config, s.apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = (await response.json().catch(() => null)) as JmapResponse | null;
  const responses = payload?.methodResponses ?? [];
  const failed = responses.find(([name]) => name === "error");
  if (failed) throw new MailflareReadError(502, `Mailflare refused the query: ${String(failed[1].type ?? "error")} ${String(failed[1].description ?? "")}`.trim());
  const got = responses.find(([name, , id]) => name === "Email/get" && id === "g");
  const list = ((got?.[1].list as Record<string, unknown>[] | undefined) ?? []);

  const emails: MailflareEmail[] = [];
  for (const item of list) {
    const mailboxIds = Object.keys((item.mailboxIds as Record<string, boolean> | undefined) ?? {});
    const roles = mailboxIds.map((ref) => ref.split("~")[1] ?? "");
    if (roles.includes("drafts") || roles.includes("trash")) continue;
    const receivedAt = new Date(String(item.receivedAt ?? ""));
    if (!item.id || !item.blobId || Number.isNaN(receivedAt.getTime())) continue;
    const ids = item.messageId as string[] | null | undefined;
    emails.push({
      id: String(item.id),
      blobId: String(item.blobId),
      receivedAt,
      messageId: ids?.[0]?.replace(/^<|>$/g, "") || null,
      folder: roles.includes("sent") ? "SENT" : "INBOX",
    });
  }
  return emails.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
}

/** The stored raw MIME of one message. */
export async function downloadMailflareRaw(config: MailflareReadConfig, blobId: string): Promise<Buffer> {
  const s = await session(config);
  const url = s.downloadUrl
    .replace("{accountId}", encodeURIComponent(s.accountId))
    .replace("{blobId}", encodeURIComponent(blobId))
    .replace("{name}", "message.eml")
    .replace("{type}", encodeURIComponent("message/rfc822"));
  const response = await request(config, url, { headers: { Accept: "message/rfc822" } });
  return Buffer.from(await response.arrayBuffer());
}
