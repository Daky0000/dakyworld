import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER } from "../lib/webhooks.js";
import { IS_PRODUCTION } from "../middleware/auth.js";
import { partnerEventsConfigured } from "./entitlements.js";

/**
 * Delivers queued `entitlements.changed` events to the Marketing SaaS.
 *
 * Signed with `PARTNER_MARKETING_API_KEY` rather than the OS's own inbound
 * webhook secret: a partner that could sign *our* inbound events could create
 * leads here. The body carries the subject and nothing else. The receiver
 * fetches the tiers over the partner API, so a forged or replayed event costs
 * one GET and grants nothing.
 *
 * Several rows for one person collapse into one delivery. A failure backs off
 * (30 s, 1 m, 2 m … capped at an hour) and is kept, with its error, until it
 * lands. The SaaS's hourly reconcile covers anything that never does.
 */

const BATCH = 25;
const MAX_BACKOFF_MS = 60 * 60_000;

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.max(0, attempts - 1));
}

function eventsUrl(): URL | null {
  const raw = process.env.PARTNER_MARKETING_EVENTS_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:" && IS_PRODUCTION) throw new Error("PARTNER_MARKETING_EVENTS_URL must be https in production.");
  return url;
}

export async function sendEntitlementEvent(subject: string): Promise<void> {
  const url = eventsUrl();
  const secret = process.env.PARTNER_MARKETING_API_KEY?.trim();
  if (!url || !secret) throw new Error("Partner events are not configured.");
  const eventId = randomUUID();
  const timestamp = String(Date.now());
  const body = JSON.stringify({ id: eventId, event: "entitlements.changed", sentAt: new Date().toISOString(), data: { sub: subject } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: sign(secret, timestamp, body),
        [TIMESTAMP_HEADER]: timestamp,
        [EVENT_ID_HEADER]: eventId,
        "User-Agent": "dakyworld-os",
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`The partner answered ${response.status}.`);
  } finally {
    clearTimeout(timer);
  }
}

let running = false;

/** One pass over what is due. Returns how many people were announced. */
export async function deliverEntitlementEvents(now = new Date()): Promise<number> {
  if (running || !partnerEventsConfigured()) return 0;
  running = true;
  try {
    const due = await prisma.entitlementEvent.findMany({
      where: { deliveredAt: null, nextAttemptAt: { lte: now } },
      orderBy: { createdAt: "asc" },
      take: BATCH,
    });
    const people = [...new Set(due.map((row) => row.userId))];
    let sent = 0;
    for (const userId of people) {
      const rows = due.filter((row) => row.userId === userId);
      const ids = rows.map((row) => row.id);
      try {
        await sendEntitlementEvent(userId);
        await prisma.entitlementEvent.updateMany({ where: { id: { in: ids } }, data: { deliveredAt: new Date(), lastError: null } });
        sent++;
      } catch (err) {
        const attempts = Math.max(...rows.map((row) => row.attempts)) + 1;
        await prisma.entitlementEvent.updateMany({
          where: { id: { in: ids } },
          data: { attempts, lastError: (err as Error).message.slice(0, 500), nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) },
        });
      }
    }
    return sent;
  } finally {
    running = false;
  }
}

/** Delivered rows are kept a week, for "did the SaaS hear about this". */
export async function pruneEntitlementEvents(now = new Date()): Promise<void> {
  await prisma.entitlementEvent.deleteMany({ where: { deliveredAt: { lt: new Date(now.getTime() - 7 * 86_400_000) } } });
}
