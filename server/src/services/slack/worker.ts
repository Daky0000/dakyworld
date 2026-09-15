import type { Prisma, SlackDelivery } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { POSTED_BY_WEBHOOK } from "./queue.js";
import { SlackError, isPermanentSlackError, sendSlack, sendSlackBlocks, settleSlackMessage, updateSlack } from "../../lib/slack.js";

/**
 * Turning queued messages into Slack requests, once, in order, and with a
 * record of what happened either way.
 *
 * This runs on its own five-second interval rather than inside the minute tick
 * in `scheduler.ts`. A capture that starts fifty seconds late is nothing; a
 * card asking the Owner to approve a spend that appears a minute after they
 * pressed the button feels broken, and they will have gone back to the app to
 * check by then anyway.
 *
 * **The lease is the same one the runner uses.** `runTask` claims a task with a
 * conditional update and stamps `runOwner` so a process that was reaped as
 * dead cannot later write over the run that took over. Nothing about that
 * problem changes one table across, so nothing about the answer does either —
 * no queue service, no Redis, one `UPDATE` whose `WHERE` clause is the
 * invariant.
 */

const TICK_MS = 5_000;
const LEASE_MS = 60_000;
const BATCH = 10;

/** Eight attempts over a day is long enough to outlast any outage worth waiting out. */
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

const PROCESS_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let leaseCounter = 0;

let timer: NodeJS.Timeout | null = null;
let draining = false;

/**
 * How long to wait before trying again.
 *
 * Doubling, capped, with jitter — the jitter because a Slack outage fails every
 * queued message at once, and without it every one of them would come back at
 * the same instant and fail together a second time.
 */
export function backoffMs(attempts: number, asked: number | null): number {
  if (asked !== null && asked > 0) return Math.min(asked, MAX_BACKOFF_MS);
  const base = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  return Math.round(base + Math.random() * base * 0.3);
}

/**
 * The next thing to send on each card, and nothing behind it.
 *
 * Raw SQL, deliberately and for one reason: the rule is "the earliest unsent
 * message for each order key, but only if nothing earlier in that order is
 * still in flight", and a correlated `NOT EXISTS` against the same table is not
 * expressible in the Prisma query API. Writing it in TypeScript would mean
 * reading the whole queue into memory to sort it, which is the kind of thing
 * that works beautifully until the day Slack has been down for an hour.
 *
 * Failed rows are absent from that `NOT EXISTS` on purpose. One permanently
 * broken update — a card in a channel the bot was removed from — must not stop
 * every later message about that task for ever.
 */
async function claimable(now: Date, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT ON (COALESCE(d."orderKey", d.id)) d.id
      FROM "SlackDelivery" d
     WHERE d.status IN ('PENDING', 'RETRYING')
       AND d."nextAttemptAt" <= ${now}
       AND (d."leaseUntil" IS NULL OR d."leaseUntil" < ${now})
       AND NOT EXISTS (
             SELECT 1
               FROM "SlackDelivery" earlier
              WHERE earlier."orderKey" = d."orderKey"
                AND earlier.seq < d.seq
                AND earlier.status IN ('PENDING', 'RETRYING', 'SENDING')
           )
     ORDER BY COALESCE(d."orderKey", d.id), d.seq ASC
     LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
}

/**
 * Takes ownership of a batch.
 *
 * The `where` repeats every condition the candidate query already checked. That
 * is not belt and braces — between the select and this update another process
 * may have claimed the same row, and the repeat is what makes losing that race
 * a quiet no-op rather than two copies of one card.
 */
async function lease(ids: string[], now: Date): Promise<SlackDelivery[]> {
  if (ids.length === 0) return [];
  const owner = `${PROCESS_ID}:${++leaseCounter}`;
  await prisma.slackDelivery.updateMany({
    where: {
      id: { in: ids },
      status: { in: ["PENDING", "RETRYING"] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      status: "SENDING",
      leaseOwner: owner,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      attempts: { increment: 1 },
    },
  });
  // Stamped separately so a row tried twice keeps the time it was first tried,
  // which is what "this has been failing for three hours" is measured from.
  await prisma.slackDelivery.updateMany({
    where: { leaseOwner: owner, firstTriedAt: null },
    data: { firstTriedAt: now },
  });
  return prisma.slackDelivery.findMany({ where: { leaseOwner: owner, status: "SENDING" } });
}

/**
 * Tells the record that owns a card where its card ended up.
 *
 * Without this a posted card can never be edited, so the question it asks can
 * never be shown as answered. It happens in the same transaction as the status
 * flip for exactly that reason: a delivery marked delivered whose subject
 * never learned the message id is worse than one that failed, because nothing
 * will ever try it again.
 */
async function writeBack(
  tx: Prisma.TransactionClient,
  row: SlackDelivery,
  channel: string | null,
  ts: string | null,
): Promise<void> {
  if (!row.subjectType || !row.subjectId) return;
  // A webhook transport reports neither a channel nor a message id, and
  // writing nothing there would lose the distinction the sentinel exists for —
  // the subject would look like one whose card was never posted, and its
  // outcome would never be announced.
  if (!ts && !channel) {
    if (row.kind !== "POST") return;
    await noteSubject(tx, row.subjectType, row.subjectId, { slackChannel: POSTED_BY_WEBHOOK, slackTs: null });
    return;
  }
  await noteSubject(tx, row.subjectType, row.subjectId, { slackChannel: channel, slackTs: ts });
}

async function noteSubject(
  tx: Prisma.TransactionClient,
  subjectType: string,
  id: string,
  data: { slackChannel: string | null; slackTs: string | null },
): Promise<void> {
  try {
    switch (subjectType) {
      case "agentTask":
        await tx.agentTask.update({ where: { id }, data });
        break;
      case "actionRequest":
        await tx.actionRequest.update({ where: { id }, data });
        break;
      case "hireRequest":
        await tx.agentHireRequest.update({ where: { id }, data });
        break;
      default:
        break;
    }
  } catch {
    // The subject was deleted while its card was in flight. The card is real
    // and the delivery succeeded; there is simply nothing left to tell.
  }
}

async function deliver(row: SlackDelivery): Promise<{ channel: string | null; ts: string | null }> {
  const blocks = (row.blocks ?? null) as unknown[] | null;

  if (row.kind === "UPDATE" && row.channel && row.ts) {
    const edited = await updateSlack(row.channel, row.ts, { text: row.text, blocks: blocks ?? [] });
    // A webhook-only Slack cannot edit. Saying so by posting the new state is
    // better than silently doing nothing, and matches what `settleSlackMessage`
    // does for the same reason.
    if (!edited) {
      const posted = await sendSlackBlocks({ text: row.text, blocks: blocks ?? [], channel: row.channel });
      return { channel: posted.channel, ts: posted.ts ?? null };
    }
    return { channel: row.channel, ts: row.ts };
  }

  if (row.kind === "SETTLE") {
    await settleSlackMessage(row.channel, row.ts, { text: row.text, blocks: blocks ?? [] });
    return { channel: row.channel, ts: row.ts };
  }

  if (blocks && blocks.length > 0) {
    const posted = await sendSlackBlocks({ text: row.text, blocks, channel: row.channel });
    return { channel: posted.channel, ts: posted.ts ?? null };
  }
  const posted = await sendSlack({ text: row.text, channel: row.channel });
  return { channel: posted.channel, ts: posted.ts ?? null };
}

/**
 * Did the request leave without us learning what became of it?
 *
 * This is the one outcome that must not be retried. Everything else is either
 * known to have worked or known not to have; an aborted `chat.postMessage` may
 * well have posted, and trying again would put a second card in the channel
 * asking for the same decision. Better to record the doubt and let a person
 * look.
 */
function isAmbiguous(err: unknown): boolean {
  const name = (err as Error | undefined)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const message = String((err as Error | undefined)?.message ?? "").toLowerCase();
  return message.includes("aborted") || message.includes("timeout") || message.includes("socket hang up");
}

function transient(err: unknown): boolean {
  if (err instanceof SlackError) return !isPermanentSlackError(err);
  // A network error that is not ambiguous — a refused connection, DNS — never
  // reached Slack at all, so repeating it is safe.
  return true;
}

async function attempt(row: SlackDelivery, now: Date): Promise<void> {
  try {
    const result = await deliver(row);
    await prisma.$transaction(async (tx) => {
      await tx.slackDelivery.update({
        where: { id: row.id },
        data: {
          status: "DELIVERED",
          deliveredAt: now,
          channel: result.channel ?? row.channel,
          ts: result.ts ?? row.ts,
          leaseOwner: null,
          leaseUntil: null,
          lastError: null,
          lastErrorCode: null,
        },
      });
      await writeBack(tx, row, result.channel ?? row.channel, result.ts ?? row.ts);
    });
    return;
  } catch (err) {
    const error = err as Error;
    const code = err instanceof SlackError ? err.code : null;

    if (isAmbiguous(err)) {
      await prisma.slackDelivery.update({
        where: { id: row.id },
        data: {
          status: "UNCERTAIN",
          leaseOwner: null,
          leaseUntil: null,
          lastError: "The request to Slack never answered, so whether the message arrived is unknown. Check Slack before retrying.",
          lastErrorCode: code,
        },
      });
      return;
    }

    const permanent = isPermanentSlackError(err);
    const exhausted = row.attempts >= MAX_ATTEMPTS || now >= row.expiresAt;

    if (permanent || exhausted) {
      await prisma.slackDelivery.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          permanent,
          leaseOwner: null,
          leaseUntil: null,
          lastError: permanent
            ? error.message
            : `${error.message} Gave up after ${row.attempts} attempts.`,
          lastErrorCode: code,
        },
      });
      return;
    }

    if (!transient(err)) {
      await prisma.slackDelivery.update({
        where: { id: row.id },
        data: { status: "FAILED", permanent: true, leaseOwner: null, leaseUntil: null, lastError: error.message, lastErrorCode: code },
      });
      return;
    }

    // Slack sometimes says exactly how long to wait, and that number knows
    // when the window resets in a way no backoff we invent does.
    const asked = err instanceof SlackError ? err.retryAfterMs : null;
    await prisma.slackDelivery.update({
      where: { id: row.id },
      data: {
        status: "RETRYING",
        nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts, asked)),
        leaseOwner: null,
        leaseUntil: null,
        lastError: error.message,
        lastErrorCode: code,
      },
    });
  }
}

/**
 * One pass of the queue.
 *
 * Exported so a check can drive it directly rather than waiting five seconds
 * per assertion, and so the scheduler can call it at boot without starting
 * the interval.
 */
export async function drainSlackQueue(now = new Date(), limit = BATCH): Promise<number> {
  const ids = await claimable(now, limit);
  const rows = await lease(ids, now);
  // Sequentially, not in parallel. Two messages about one card have an order
  // that matters, and the whole point of `seq` would be lost by sending them
  // at once and letting Slack decide.
  for (const row of rows) await attempt(row, new Date());
  return rows.length;
}

/**
 * Hands back rows whose owner died mid-send.
 *
 * They go back to retrying rather than pending, and keep their attempt count:
 * the process may well have died *because* of what it was sending, and a row
 * that gets a free attempt on every restart is a crash loop that also spams
 * a channel.
 */
export async function reclaimExpiredLeases(now = new Date()): Promise<number> {
  const { count } = await prisma.slackDelivery.updateMany({
    where: { status: "SENDING", leaseUntil: { lt: now } },
    data: {
      status: "RETRYING",
      leaseOwner: null,
      leaseUntil: null,
      nextAttemptAt: now,
      lastError: "The process sending this stopped before it finished. Picked up again.",
    },
  });
  return count;
}

export function startSlackQueueWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (draining) return;
    draining = true;
    void drainSlackQueue()
      .catch((err) => console.error("[slack-queue] drain failed:", (err as Error).message))
      .finally(() => {
        draining = false;
      });
  }, TICK_MS);
  // Never the reason the process stays alive.
  timer.unref?.();
}

export function stopSlackQueueWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
