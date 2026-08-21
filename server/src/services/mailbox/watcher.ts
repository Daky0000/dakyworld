import type { ImapFlow } from "imapflow";
import { buildClient, readImapConfig, type ImapConfig } from "../../lib/imap.js";
import { syncMailbox } from "./sync.js";

/**
 * Staying connected to the mailbox.
 *
 * The minute tick would read the inbox sixty times an hour and that is a
 * perfectly good floor, but it is not what was asked for and it is not what a
 * reply deserves: somebody answering a cold email is the most time-sensitive
 * event this company produces, and the difference between forty seconds and
 * four minutes is the difference between a business that is paying attention
 * and one that is not.
 *
 * So there is a long-lived connection sitting in IMAP IDLE on the inbox, and
 * the server pushes. Three things make that safe to run inside a web process:
 *
 *  - **The watcher does not read anything.** It listens, and when the server
 *    says a message arrived it asks `syncMailbox()` to do the reading on its
 *    own short-lived connection. A socket that is fetching is a socket that
 *    is not idling, and juggling both on one connection is where every
 *    home-made IMAP client goes wrong.
 *  - **The tick is still the floor.** IDLE dies quietly — a NAT timeout, a
 *    server that drops idle sessions after half an hour, a laptop closing.
 *    Every path here is an optimisation over a poll that runs anyway, so the
 *    worst case of the whole watcher failing is the behaviour we would have
 *    had without it.
 *  - **One reader at a time.** `syncMailbox` is guarded by a promise rather
 *    than a lock: a push and a tick arriving together is normal, and two
 *    passes over the same UID range would double the work and race on the
 *    cursor.
 */

/** Backoff after a dropped connection: a second, then two, four … up to a minute. */
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/**
 * IDLE is renewed well inside the 29 minutes RFC 2177 allows, because the
 * thing that kills it is usually a NAT table rather than the server.
 */
const IDLE_REFRESH_MS = 9 * 60_000;

interface WatcherState {
  client: ImapFlow | null;
  /** The config the live connection was built from, so a settings change reconnects. */
  signature: string | null;
  backoffMs: number;
  reconnectTimer: NodeJS.Timeout | null;
  refreshTimer: NodeJS.Timeout | null;
  stopping: boolean;
  connectedAt: Date | null;
  lastError: string | null;
  lastPushAt: Date | null;
}

const state: WatcherState = {
  client: null,
  signature: null,
  backoffMs: MIN_BACKOFF_MS,
  reconnectTimer: null,
  refreshTimer: null,
  stopping: false,
  connectedAt: null,
  lastError: null,
  lastPushAt: null,
};

/** The one pass that may be running. Everything that wants to read joins it. */
let running: Promise<unknown> | null = null;

/**
 * Reads the mailbox, or joins the read already happening.
 *
 * The tick, the watcher and the Sync now button all come through here. Errors
 * are swallowed to a log deliberately: this is called from the scheduler, and
 * a mail server having a bad morning must not take the tick down with it —
 * the failure is already recorded on `MailSyncState` for the Settings screen.
 */
export async function readMailboxOnce(): Promise<void> {
  if (running) {
    await running.catch(() => undefined);
    return;
  }
  running = syncMailbox()
    .catch((err) => {
      state.lastError = (err as Error).message;
      console.warn("[mailbox] read failed:", state.lastError);
    })
    .finally(() => {
      running = null;
    });
  await running;
}

function signatureOf(config: ImapConfig): string {
  // The password is in it on purpose: a rotated App Password must reconnect,
  // and hashing it here would be theatre — the value is already in memory.
  return [config.host, config.port, config.secure, config.user, config.password].join("|");
}

function clearTimers() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.reconnectTimer = null;
  state.refreshTimer = null;
}

function scheduleReconnect(reason: string) {
  if (state.stopping || state.reconnectTimer) return;
  state.lastError = reason;
  const wait = state.backoffMs;
  state.backoffMs = Math.min(MAX_BACKOFF_MS, state.backoffMs * 2);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect().catch(() => undefined);
  }, wait);
  // `unref` so a reconnect that is waiting cannot hold the process open past a
  // SIGTERM — Railway gives a deploy a few seconds and this must not use them.
  state.reconnectTimer.unref?.();
}

async function connect(): Promise<void> {
  if (state.stopping) return;

  const config = await readImapConfig();
  if (!config) {
    // Not an error. Nothing is connected, the tick still runs, and the moment
    // credentials are saved `restartWatcher()` brings this up.
    await teardown();
    return;
  }

  const signature = signatureOf(config);
  if (state.client && state.signature === signature) return;
  if (state.client) await teardown();

  const client = buildClient(config);
  state.client = client;
  state.signature = signature;

  client.on("error", (err: Error) => {
    if (state.client !== client || state.stopping) return;
    void teardown().then(() => scheduleReconnect(err.message));
  });
  client.on("close", () => {
    if (state.client !== client || state.stopping) return;
    state.client = null;
    state.connectedAt = null;
    clearTimers();
    scheduleReconnect("The mail server closed the connection.");
  });
  // What the whole file is for. The server says the folder grew; we go and
  // look. Deliberately does not trust the count in the event — the sync reads
  // from the cursor, so a push that arrives twice costs one wasted query.
  client.on("exists", () => {
    state.lastPushAt = new Date();
    void readMailboxOnce();
  });

  try {
    await client.connect();
    await client.mailboxOpen("INBOX", { readOnly: true });
    state.connectedAt = new Date();
    state.lastError = null;
    state.backoffMs = MIN_BACKOFF_MS;

    // A NOOP on a schedule. ImapFlow re-enters IDLE on its own after any
    // command, so this is both the keep-alive and the proof the socket is
    // still real — a dead one throws here rather than staying silently open.
    state.refreshTimer = setInterval(() => {
      client.noop().catch((err: Error) => scheduleReconnect(err.message));
    }, IDLE_REFRESH_MS);
    state.refreshTimer.unref?.();

    // Anything that arrived while the connection was down.
    void readMailboxOnce();
  } catch (err) {
    state.client = null;
    state.connectedAt = null;
    client.close();
    scheduleReconnect((err as Error).message);
  }
}

async function teardown(): Promise<void> {
  clearTimers();
  const client = state.client;
  state.client = null;
  state.signature = null;
  state.connectedAt = null;
  if (!client) return;
  await Promise.race([client.logout(), new Promise((resolve) => setTimeout(resolve, 3_000))]).catch(() => undefined);
  client.close();
}

/** Called at boot. Silent and harmless when no mailbox is connected. */
export async function startWatcher(): Promise<void> {
  state.stopping = false;
  await connect().catch((err) => console.warn("[mailbox] could not watch the mailbox:", (err as Error).message));
}

/**
 * Called after the settings change.
 *
 * Reconnecting on a settings write rather than on a timer is what makes
 * pasting a password feel like it did something: the Settings screen saves,
 * this reconnects, and the first read happens before the person has looked
 * away from the page.
 */
export async function restartWatcher(): Promise<void> {
  await teardown();
  state.backoffMs = MIN_BACKOFF_MS;
  await startWatcher();
}

export async function stopWatcher(): Promise<void> {
  state.stopping = true;
  await teardown();
}

export interface WatcherStatus {
  connected: boolean;
  connectedAt: Date | null;
  /** The last time the server pushed. Null when nothing has arrived since connecting. */
  lastPushAt: Date | null;
  lastError: string | null;
  reading: boolean;
}

export function watcherStatus(): WatcherStatus {
  return {
    connected: Boolean(state.client?.usable),
    connectedAt: state.connectedAt,
    lastPushAt: state.lastPushAt,
    lastError: state.lastError,
    reading: running !== null,
  };
}
