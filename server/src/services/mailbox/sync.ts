import type { ImapFlow } from "imapflow";
import type { MailFolder } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getSetting, SETTING } from "../../lib/settings.js";
import { type ImapConfig, ownAddresses, readImapConfig, resolveSentFolder, withImap } from "../../lib/imap.js";
import { parseMessage } from "./parse.js";
import { ingestMessage } from "./ingest.js";

/**
 * Reading what is new, and only what is new.
 *
 * IMAP does not have "since I last asked". It has UIDs, which are ascending
 * within a folder, and a `UIDVALIDITY` number the server may change whenever
 * it likes — after which every UID recorded anywhere means nothing. So the
 * cursor is the pair, and the mismatch case is handled rather than assumed
 * away: the folder is re-read from a date instead of from a number, and
 * `dedupeKey` is what stops that re-read filing nine hundred duplicates.
 *
 * **The first pass is bounded by a date and every pass is bounded by a
 * count.** A brand-new connection to a mailbox with nine years in it would
 * otherwise read nine years of post, at one model call each, before it read
 * anything that arrived this morning. `MAX_PER_RUN` then spreads whatever is
 * left across the following ticks — the cursor advances as it goes, so a
 * restart in the middle of a big first pass resumes rather than restarts.
 */

/** Messages read from one folder in one pass. The rest wait for the next tick. */
const MAX_PER_RUN = 60;
/** How far back the very first pass reaches when nothing is configured. */
const DEFAULT_BACKFILL_DAYS = 14;

export interface FolderSync {
  folder: MailFolder;
  path: string | null;
  read: number;
  /** Already stored — a re-read rather than an arrival. */
  skipped: number;
  routed: number;
  more: boolean;
  notes: string[];
  error: string | null;
}

export interface SyncResult {
  mailbox: string;
  folders: FolderSync[];
  read: number;
  routed: number;
  notes: string[];
}

async function backfillDays(): Promise<number> {
  const raw = await getSetting(SETTING.MAIL_BACKFILL_DAYS);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BACKFILL_DAYS;
  return Math.min(365, Math.round(parsed));
}

async function cursorFor(mailbox: string, folder: MailFolder) {
  return prisma.mailSyncState.upsert({
    where: { mailbox_folder: { mailbox, folder } },
    update: {},
    create: { mailbox, folder },
  });
}

/**
 * Reads one folder from where it got to.
 *
 * Returns rather than throws on a folder that is not there: a mailbox with no
 * Sent folder is a configuration to report, not a reason to stop reading the
 * inbox.
 */
export async function syncFolder(
  client: ImapFlow,
  config: ImapConfig,
  folder: MailFolder,
  path: string,
  own: string[],
): Promise<FolderSync> {
  const result: FolderSync = { folder, path, read: 0, skipped: 0, routed: 0, more: false, notes: [], error: null };
  const state = await cursorFor(config.mailbox, folder);

  // Taken before the work rather than inside it, so a folder that will not
  // open reports that and nothing else — `getMailboxLock` throwing inside the
  // main block would leave a release in a `finally` with nothing to release.
  const lock = await client.getMailboxLock(path).catch((err: unknown) => {
    result.error = `Could not open ${path}: ${(err as Error).message}`;
    return null;
  });
  if (!lock) {
    await prisma.mailSyncState.update({
      where: { id: state.id },
      data: { lastError: result.error?.slice(0, 500) ?? null, lastSyncAt: new Date() },
    });
    return result;
  }

  try {
    const mailbox = client.mailbox;
    if (!mailbox) {
      result.error = `${path} opened but reported nothing about itself.`;
      return result;
    }

    const uidValidity = mailbox.uidValidity;
    let lastUid = state.lastUid;

    // The server renumbered the folder. Every stored UID is now meaningless,
    // so the cursor is thrown away rather than trusted — and the re-read is
    // safe because every message is stored under its Message-ID.
    if (state.uidValidity !== null && state.uidValidity !== uidValidity) {
      result.notes.push(`${path} was renumbered by the server, so it is being re-read from the last ${await backfillDays()} days.`);
      lastUid = 0n;
    }

    let uids: number[];
    if (lastUid === 0n) {
      const since = new Date(Date.now() - (await backfillDays()) * 24 * 60 * 60_000);
      const found = await client.search({ since }, { uid: true });
      uids = (found === false ? [] : found).sort((a, b) => a - b);
    } else {
      const found = await client.search({ uid: `${Number(lastUid) + 1}:*` }, { uid: true });
      // IMAP answers `n:*` with the last message in the folder even when
      // there is nothing at or above n, so the range is filtered rather than
      // trusted — without this, the newest message is re-read every minute.
      uids = (found === false ? [] : found).filter((uid) => BigInt(uid) > lastUid).sort((a, b) => a - b);
    }

    if (uids.length > MAX_PER_RUN) {
      result.more = true;
      uids = uids.slice(0, MAX_PER_RUN);
    }

    if (uids.length === 0) {
      await prisma.mailSyncState.update({
        where: { id: state.id },
        data: { uidValidity, lastSyncAt: new Date(), lastError: null },
      });
      return result;
    }

    let highest = lastUid;
    for await (const raw of client.fetch(uids, { uid: true, source: true, internalDate: true }, { uid: true })) {
      const uid = BigInt(raw.uid);
      if (uid > highest) highest = uid;
      if (!raw.source) {
        result.notes.push(`Message ${raw.uid} in ${path} had no body to read.`);
        continue;
      }

      try {
        // `internalDate` is typed as a string on some servers’ responses and as a
        // Date on others, and it is only the fallback for a message with no
        // Date header at all — so it is normalised rather than trusted.
        const arrived = raw.internalDate ? new Date(raw.internalDate) : new Date();
        const parsed = await parseMessage(raw.source, Number.isNaN(arrived.getTime()) ? new Date() : arrived);
        const ingested = await ingestMessage({ parsed, folder, uid: raw.uid, uidValidity, own });
        if (ingested.fresh) result.read += 1;
        else result.skipped += 1;
        if (ingested.taskId) result.routed += 1;
        result.notes.push(...ingested.notes);
      } catch (err) {
        // One unreadable message must not stop the folder. The cursor still
        // advances past it, because a message that cannot be parsed today
        // cannot be parsed on the next tick either and would block everything
        // behind it for ever.
        result.notes.push(`Could not read message ${raw.uid} in ${path}: ${(err as Error).message}`);
      }
    }

    await prisma.mailSyncState.update({
      where: { id: state.id },
      data: {
        uidValidity,
        lastUid: highest,
        lastSyncAt: new Date(),
        lastError: null,
        messagesSeen: { increment: result.read },
      },
    });
  } catch (err) {
    result.error = (err as Error).message;
    await prisma.mailSyncState.update({ where: { id: state.id }, data: { lastError: result.error.slice(0, 500), lastSyncAt: new Date() } });
  } finally {
    lock.release();
  }

  return result;
}

/**
 * One pass over both folders.
 *
 * The inbox first, deliberately: if the connection dies halfway, the half that
 * ran is the half that matters.
 */
export async function syncMailbox(options: { config?: ImapConfig | null } = {}): Promise<SyncResult> {
  const config = options.config ?? (await readImapConfig());
  if (!config) {
    return { mailbox: "", folders: [], read: 0, routed: 0, notes: ["No mailbox is connected for reading. Settings → Email → Reading the inbox."] };
  }

  const own = await ownAddresses();
  return withImap(config, async (client) => {
    const folders: FolderSync[] = [];
    const notes: string[] = [];

    folders.push(await syncFolder(client, config, "INBOX", "INBOX", own));

    const sentPath = await resolveSentFolder(client, config.sentFolder);
    if (sentPath) {
      folders.push(await syncFolder(client, config, "SENT", sentPath, own));
    } else {
      folders.push({
        folder: "SENT",
        path: null,
        read: 0,
        skipped: 0,
        routed: 0,
        more: false,
        notes: [],
        error:
          "No Sent folder could be found on this server, so replies you send by hand are not seen. Name it under Settings → Email if the server calls it something unusual.",
      });
    }

    for (const folder of folders) {
      notes.push(...folder.notes);
      if (folder.error) notes.push(folder.error);
    }

    return {
      mailbox: config.mailbox,
      folders,
      read: folders.reduce((total, folder) => total + folder.read, 0),
      routed: folders.reduce((total, folder) => total + folder.routed, 0),
      notes,
    };
  });
}
