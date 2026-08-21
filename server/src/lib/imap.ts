import { ImapFlow, type ListResponse } from "imapflow";
import { SETTING, getSetting } from "./settings.js";

/**
 * The mailbox, read rather than written to.
 *
 * **Why IMAP and not a provider API.** `lib/mailer.ts` has two ways out
 * because sending is where the provider differences live — a Message-ID, a
 * Reply-To, an unsubscribe header. Reading has no such differences and one
 * enormous practical fact: every mailbox this company could ever use already
 * speaks IMAP. Hostinger, Google Workspace, Zoho, a cPanel address, the one
 * the accountant insists on. A provider API would connect one of them and
 * leave the rest with nothing.
 *
 * **Connecting is meant to be one field, not five.** The host is almost always
 * the SMTP host with `smtp` swapped for `imap`, the port is 993, and the
 * password is very often the same app password already stored for sending. So
 * `suggestFromSmtp()` derives all of it and the Settings screen offers it
 * pre-filled — the Owner confirms rather than researches.
 *
 * **Nothing here decides anything.** This file connects, lists folders and
 * hands back messages. What a message means, who it belongs to and what should
 * happen next is `services/mailbox/` — kept apart so the half that talks to a
 * socket can be exercised against a real server while the half that makes
 * decisions is exercised against a database with no network at all.
 */

export class ImapError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ImapError";
    this.status = status;
  }
}

export interface ImapConfig {
  host: string;
  port: number;
  /** Implicit TLS. True for 993, false for STARTTLS on 143. */
  secure: boolean;
  user: string;
  password: string;
  /** What this server calls Sent. Null means find it. */
  sentFolder: string | null;
  /**
   * The address this mailbox *is*, for `MailSyncState.mailbox`. Usually the
   * login, but a login can be an account name rather than an address, so the
   * From address wins when there is one.
   */
  mailbox: string;
}

/** How long a single command may hang before the connection is considered dead. */
const SOCKET_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;

const BAD_LOGIN =
  "The mail server rejected that username or password. If the mailbox has two-factor authentication on — Google Workspace does — this needs an App Password, not the account password.";

// --- Configuration ---------------------------------------------------------

export async function readImapConfig(): Promise<ImapConfig | null> {
  const [enabled, host, portRaw, secureRaw, user, password, sentFolder, fromEmail] = await Promise.all([
    getSetting(SETTING.IMAP_ENABLED),
    getSetting(SETTING.IMAP_HOST),
    getSetting(SETTING.IMAP_PORT),
    getSetting(SETTING.IMAP_SECURE),
    getSetting(SETTING.IMAP_USER),
    getSetting(SETTING.IMAP_PASSWORD),
    getSetting(SETTING.IMAP_SENT_FOLDER),
    getSetting(SETTING.MAIL_FROM_EMAIL),
  ]);

  if (enabled === "false") return null;
  if (!host || !user || !password) return null;

  const port = Number(portRaw) || 993;
  return {
    host,
    port,
    // Default from the port rather than from a missing setting: 993 is implicit
    // TLS and 143 is not, and getting that pair wrong is a hang rather than an
    // error message.
    secure: secureRaw === null ? port === 993 : secureRaw !== "false",
    user,
    password,
    sentFolder: sentFolder?.trim() || null,
    mailbox: (fromEmail?.trim() || user).toLowerCase(),
  };
}

export async function imapConfigured(): Promise<boolean> {
  return (await readImapConfig()) !== null;
}

/**
 * The IMAP settings implied by the SMTP ones already stored.
 *
 * Every provider this app is likely to meet names its two servers the same way,
 * so the honest thing is to fill the form in and let the Owner correct it. The
 * one that is not a swap is Google, whose SMTP host is `smtp.gmail.com` and
 * whose IMAP host is `imap.gmail.com` — which is a swap, and the reason the
 * general rule is written as a swap rather than as a list of providers.
 */
export function suggestFromSmtp(smtpHost: string | null): { host: string; port: number; secure: boolean } | null {
  const host = smtpHost?.trim().toLowerCase();
  if (!host) return null;
  const imapHost = host.startsWith("smtp.")
    ? `imap.${host.slice(5)}`
    : host.startsWith("mail.")
      ? host
      : host.replace(/^smtp/, "imap");
  return { host: imapHost, port: 993, secure: true };
}

/**
 * The addresses that are *us*.
 *
 * The loop guard, and the thing that tells an inbound message from a copy of
 * one we sent. Returns lowercase entries which are either a whole address
 * (`dan@dakyworld.com`) or a bare domain (`dakyworld.com`) — `isOurs` accepts
 * either, because a company has one domain and an unknown number of aliases on
 * it.
 */
export async function ownAddresses(): Promise<string[]> {
  const [configured, fromEmail, smtpUser, imapUser, hostingerAddress] = await Promise.all([
    getSetting(SETTING.MAIL_OWN_DOMAINS),
    getSetting(SETTING.MAIL_FROM_EMAIL),
    getSetting(SETTING.SMTP_USER),
    getSetting(SETTING.IMAP_USER),
    getSetting(SETTING.HOSTINGER_MAILBOX_ADDRESS),
  ]);

  const entries = new Set<string>();
  for (const raw of (configured ?? "").split(/[,\s]+/)) {
    const value = raw.trim().toLowerCase().replace(/^@/, "");
    if (value) entries.add(value);
  }
  // The derived ones are added whether or not the setting is filled in: a list
  // that names a domain and forgets the sending address is a list that treats
  // our own outbound as a stranger's mail.
  for (const value of [fromEmail, smtpUser, imapUser, hostingerAddress]) {
    const address = value?.trim().toLowerCase();
    if (!address || !address.includes("@")) continue;
    entries.add(address);
    entries.add(address.split("@")[1]);
  }
  return [...entries];
}

/** Whether an address is one of ours, by exact address or by domain. */
export function isOurs(address: string | null | undefined, own: string[]): boolean {
  const value = address?.trim().toLowerCase();
  if (!value) return false;
  const domain = value.includes("@") ? value.split("@")[1] : null;
  return own.some((entry) => entry === value || (domain !== null && entry === domain));
}

// --- Connecting ------------------------------------------------------------

export function buildClient(config: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    // ImapFlow's own logging is a firehose of protocol chatter at info level.
    logger: false,
    emitLogs: false,
    socketTimeout: SOCKET_TIMEOUT_MS,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  });
}

/** Turns a driver error into something a person can act on. */
export function describeError(err: unknown): ImapError {
  const error = err as { authenticationFailed?: boolean; code?: string; message?: string };
  if (error?.authenticationFailed) return new ImapError(401, BAD_LOGIN);
  const code = error?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ImapError(502, "That mail server name does not resolve. Check the host — it is usually the SMTP host with “smtp” swapped for “imap”.");
  }
  if (code === "ECONNREFUSED") return new ImapError(502, "The mail server refused the connection on that port. 993 with TLS is the usual pair; 143 is STARTTLS.");
  if (code === "ETIMEDOUT" || code === "ECONNRESET") {
    return new ImapError(504, "The mail server did not answer in time. If TLS is off on port 993 the connection hangs exactly like this.");
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID" || code === "CERT_HAS_EXPIRED" || code === "SELF_SIGNED_CERT_IN_CHAIN") {
    return new ImapError(502, `The mail server's certificate could not be verified (${code}).`);
  }
  return new ImapError(502, error?.message || "The mail server could not be reached.");
}

/**
 * Opens a connection, runs one piece of work, and closes it whatever happens.
 *
 * Every scheduled read goes through this rather than holding a connection
 * open, because a socket left open across a Railway deploy is a socket the
 * server thinks is still logged in. The watcher is the one exception and says
 * so — see services/mailbox/watcher.ts.
 */
export async function withImap<T>(config: ImapConfig, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = buildClient(config);
  try {
    await client.connect();
  } catch (err) {
    throw describeError(err);
  }
  try {
    return await work(client);
  } finally {
    // `logout` is the polite close and can itself hang on a half-dead socket,
    // so it is bounded and followed by the rude one.
    await Promise.race([client.logout(), new Promise((resolve) => setTimeout(resolve, 5_000))]).catch(() => undefined);
    client.close();
  }
}

/**
 * Which folder holds sent mail.
 *
 * Three attempts, in falling order of trustworthiness: what the Owner typed,
 * what the server flags as `\Sent`, and a name that looks like one. The third
 * exists because plenty of servers do not advertise special-use at all, and
 * "no Sent folder" would silently turn off half of this feature.
 */
export async function resolveSentFolder(client: ImapFlow, configured: string | null): Promise<string | null> {
  const folders: ListResponse[] = await client.list();
  if (configured) {
    const named = folders.find((folder) => folder.path.toLowerCase() === configured.toLowerCase());
    // Honoured even when it matches nothing the server listed: a name typed by
    // a person is a decision, and quietly reading a different folder instead
    // would be worse than failing to open the one they asked for.
    return named?.path ?? configured;
  }
  const flagged = folders.find((folder) => folder.specialUse === "\\Sent");
  if (flagged) return flagged.path;
  const byName = folders.find((folder) => /^(inbox[./])?sent(\s?(mail|items|messages))?$/i.test(folder.path) || /sent/i.test(folder.name));
  return byName?.path ?? null;
}

export interface ImapVerification {
  ok: true;
  /** Every folder the account can see, for the Settings screen's dropdown. */
  folders: string[];
  sentFolder: string | null;
  inboxMessages: number;
  serverName: string | null;
}

/**
 * Proves a set of credentials works *before* they are stored.
 *
 * The same discipline SMTP follows with `transporter.verify()`, and for the
 * same reason: credentials that are wrong should fail on the Settings screen
 * with a message, not at six the next morning with silence.
 */
export async function verifyImap(input: Omit<ImapConfig, "mailbox">): Promise<ImapVerification> {
  const config: ImapConfig = { ...input, mailbox: input.user.toLowerCase() };
  return withImap(config, async (client) => {
    const folders = await client.list();
    const sentFolder = await resolveSentFolder(client, input.sentFolder);
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox;
      return {
        ok: true as const,
        folders: folders.map((folder) => folder.path).sort(),
        sentFolder,
        inboxMessages: mailbox ? mailbox.exists : 0,
        serverName: client.serverInfo?.name ?? null,
      };
    } finally {
      lock.release();
    }
  });
}
