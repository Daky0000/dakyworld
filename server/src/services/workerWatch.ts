import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { acquireLease } from "../lib/leases.js";
import { emailOwner } from "./opsAlert.js";

/**
 * Notices when the worker stops, from the one process still able to say so.
 *
 * In production the API and the worker are separate Railway services. The
 * worker runs everything scheduled: billing, outbound email, agent tasks, lead
 * capture and the mailbox. It has no public address, so no uptime monitor can
 * see it. On 9 Oct 2026 it crash-looped for about five hours and Railway stopped
 * restarting it. The API stayed green the whole time and nobody knew.
 *
 * The worker already proves it is alive: `startBackgroundRuntime` renews the
 * `background-runtime` lease every 10 seconds for 45. This reads that lease.
 * `/api/ready/worker` turns it into a status an uptime monitor can watch, and
 * the API emails the Owner itself once the silence outlasts a deploy.
 */

const RUNTIME_LEASE = "background-runtime";
/** How long the worker's own lease runs; its expiry minus this is the last renewal. */
const RUNTIME_LEASE_SECONDS = 45;
/** A deploy hands over in about a minute. Past this, the public status says down. */
export const DOWN_AFTER_MS = 3 * 60_000;
/** Past this, somebody is told. Long enough that a slow deploy never sends it. */
export const ALERT_AFTER_MS = 10 * 60_000;
/** One email per outage, and at most one per this window if it keeps flapping. */
const ALERT_LEASE = "worker-down-alert";
const ALERT_LEASE_SECONDS = 6 * 3600;
const CHECK_EVERY_MS = 2 * 60_000;

export interface WorkerStatus {
  /** When the worker last renewed its lease, or null if it never has. */
  lastSeen: Date | null;
  silentMs: number | null;
}

export async function workerStatus(now = Date.now()): Promise<WorkerStatus> {
  const row = await prisma.serviceLease.findUnique({ where: { key: RUNTIME_LEASE }, select: { expiresAt: true } });
  if (!row) return { lastSeen: null, silentMs: null };
  const lastSeen = new Date(row.expiresAt.getTime() - RUNTIME_LEASE_SECONDS * 1000);
  return { lastSeen, silentMs: Math.max(0, now - lastSeen.getTime()) };
}

/** Down for the public status. A worker that has never run is down as well. */
export function isDown(status: WorkerStatus): boolean {
  return status.silentMs === null || status.silentMs > DOWN_AFTER_MS;
}

/**
 * Worth an email. A worker that has never run is not: that is a fresh database
 * or a deployment without one, and nobody is waiting on it.
 */
export function needsAlert(status: WorkerStatus): boolean {
  return status.silentMs !== null && status.silentMs > ALERT_AFTER_MS;
}

async function alertOwner(status: WorkerStatus) {
  const minutes = Math.round((status.silentMs ?? 0) / 60_000);
  const since = status.lastSeen ? `${status.lastSeen.toISOString().slice(0, 16).replace("T", " ")} UTC` : "an unknown time";
  const sent = await emailOwner({
    subject: "The OS worker has stopped",
    paragraphs: [
      `The DakyXTech OS worker has not checked in since ${since}, ${minutes} minutes ago.`,
      "It runs everything scheduled: care plan billing, queued email, agent tasks, lead capture and reading the mailbox. While it is down none of that happens. Websites and the app itself are unaffected.",
      "Open the worker service in Railway and read the end of its latest logs. A crash usually names its cause in the last few lines. Redeploy once it is fixed.",
    ],
    footnotes: ["The API service sent this because it is still running. You will hear again only if the worker recovers and then stops again, or after six hours."],
    category: "ops:worker-down",
  });
  if (sent) console.error(`[worker-watch] The worker has been silent for ${minutes} min. Emailed the Owner.`);
}

async function check() {
  const status = await workerStatus();
  if (!needsAlert(status)) {
    // Back up, or never started: the next outage gets its own email.
    if (!isDown(status)) await prisma.serviceLease.deleteMany({ where: { key: ALERT_LEASE } });
    return;
  }
  // Every API replica runs this; the lease means one of them sends it.
  if (!(await acquireLease(ALERT_LEASE, randomUUID(), ALERT_LEASE_SECONDS))) return;
  try {
    await alertOwner(status);
  } catch (err) {
    // Let the next check try again rather than staying quiet for six hours.
    await prisma.serviceLease.deleteMany({ where: { key: ALERT_LEASE } }).catch(() => undefined);
    console.error("[worker-watch] Could not email the Owner:", (err as Error).message);
  }
}

/** Only for an API that runs without the background work; a combined process is its own worker. */
export function startWorkerWatch(): () => void {
  const timer = setInterval(() => { void check().catch((err) => console.error("[worker-watch] check failed:", (err as Error).message)); }, CHECK_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
