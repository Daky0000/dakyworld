import type { ScraperSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { apifyConfigured } from "../lib/apify.js";
import { isValidTimezone, safeZone, zonedDateParts, zonedTimeToUtc } from "../lib/timezone.js";
import { CaptureBudgetError, CaptureBusyError, pruneRunHistory, resumeInterruptedRuns, runSource } from "./scraperRunner.js";
import { readCaptureConfig } from "./captureConfig.js";
import { billDuePlans } from "./carePlanBilling.js";
import { dispatchDueEmails } from "./emailSender.js";
import { runDueSequences } from "./emailSequences.js";
import { runDueTasks, resumeInterruptedTasks } from "./agents/runner.js";
import { pruneCheckpoints } from "./agents/checkpoint.js";
import { ensureGapReviews, expireStaleHireRequests } from "./agents/hiring.js";
import { purgeExpiredSessions } from "../lib/session.js";

/**
 * The app's clock. Three things run on it:
 *
 *  - **Lead capture.** Each source carries a list of local times ("06:30",
 *    "18:00") and a timezone; this ticks once a minute and starts whichever
 *    ones are due.
 *  - **Care plan billing.** Each active plan bills on its own day of the
 *    month — see `carePlanBilling.ts`.
 *  - **The agent workforce.** Queued tasks belonging to agents that are ACTIVE
 *    are started, up to a concurrency ceiling — see `agents/runner.ts`. Unlike
 *    the other two this one does not wait: an agent's run can take minutes,
 *    and holding the tick open for it would stop an invoice going out.
 *
 * Both follow the same discipline: the next due instant is stored on the row
 * and advanced *before* the work starts, so a failure can't be retried in a
 * loop and a restart can't fire the same slot twice.
 *
 * Deliberately in-process rather than a cron container: Dakyworld OS runs as a
 * single Railway service, and one setInterval has no moving parts to keep in
 * sync with a deploy.
 */

const TICK_MS = 60_000;
/** A slot missed by more than this — a long outage — is skipped, not stampeded through on boot. */
const MAX_CATCHUP_MS = 6 * 60 * 60_000;

let timer: NodeJS.Timeout | null = null;

// The zone maths moved to lib/timezone.ts once care plan billing needed it
// too; re-exported because the scrapers router validates against it.
export { isValidTimezone };

export function parseScheduleTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * The next instant this source should run, strictly after `from`. Returns null
 * when the source has no usable schedule.
 */
export function computeNextRunAt(
  source: Pick<ScraperSource, "scheduleEnabled" | "scheduleTimes" | "timezone" | "enabled">,
  from = new Date(),
): Date | null {
  if (!source.enabled || !source.scheduleEnabled || source.scheduleTimes.length === 0) return null;

  const timeZone = safeZone(source.timezone);
  const [year, month, day] = zonedDateParts(from, timeZone);

  let earliest: Date | null = null;
  // Today and tomorrow is enough for a daily schedule; the extra day covers
  // slots that have already passed in the source's own timezone.
  for (const dayOffset of [0, 1]) {
    for (const raw of source.scheduleTimes) {
      const time = parseScheduleTime(raw);
      if (!time) continue;
      const candidate = zonedTimeToUtc(year, month, day + dayOffset, time.hour, time.minute, timeZone);
      if (candidate.getTime() > from.getTime() && (!earliest || candidate < earliest)) earliest = candidate;
    }
  }
  return earliest;
}

/** Recomputes and persists `nextRunAt`. Call after any schedule change. */
export async function syncSchedule(sourceId: string): Promise<Date | null> {
  const source = await prisma.scraperSource.findUnique({ where: { id: sourceId } });
  if (!source) return null;
  const nextRunAt = computeNextRunAt(source);
  await prisma.scraperSource.update({ where: { id: sourceId }, data: { nextRunAt } });
  return nextRunAt;
}

// --- The tick --------------------------------------------------------------

export async function tick(now = new Date()) {
  // Independent jobs on one interval. Lead capture failing must not stop an
  // invoice going out, and neither must stop a follow-up, so they're settled
  // separately rather than awaited in sequence.
  const results = await Promise.allSettled([
    captureTick(now),
    billDuePlans(now),
    dispatchDueEmails(now),
    runDueSequences(now),
    runDueTasks(now),
    housekeepingTick(now),
  ]);
  for (const result of results) {
    if (result.status === "rejected") console.error("[scheduler] job failed:", result.reason);
  }
}

async function captureTick(now: Date) {
  // Backfill sources that were scheduled while the server was down, or saved
  // before this feature existed.
  const unscheduled = await prisma.scraperSource.findMany({
    where: { enabled: true, scheduleEnabled: true, nextRunAt: null },
  });
  for (const source of unscheduled) {
    await prisma.scraperSource.update({
      where: { id: source.id },
      data: { nextRunAt: computeNextRunAt(source, now) },
    });
  }

  const due = await prisma.scraperSource.findMany({
    where: { enabled: true, scheduleEnabled: true, nextRunAt: { lte: now } },
  });
  if (due.length === 0) return;

  if (!(await apifyConfigured())) {
    // No token yet: keep the schedule moving instead of piling up due slots.
    for (const source of due) {
      await prisma.scraperSource.update({ where: { id: source.id }, data: { nextRunAt: computeNextRunAt(source, now) } });
    }
    console.warn(`[scheduler] ${due.length} source(s) due but Apify isn't connected — skipped.`);
    return;
  }

  for (const source of due) {
    const slot = source.nextRunAt;
    // Advance the schedule first: whatever happens to this run, the slot is spent.
    await prisma.scraperSource.update({ where: { id: source.id }, data: { nextRunAt: computeNextRunAt(source, now) } });

    if (slot && now.getTime() - slot.getTime() > MAX_CATCHUP_MS) {
      console.warn(`[scheduler] Skipping ${source.name}: its ${slot.toISOString()} slot is more than 6 hours stale.`);
      continue;
    }

    try {
      await runSource(source.id, "SCHEDULED");
      console.log(`[scheduler] Started scheduled run for “${source.name}”`);
    } catch (err) {
      // Being at the concurrency limit or over budget is the guardrail doing
      // its job, not a fault: say so plainly and let the next slot try again.
      if (err instanceof CaptureBusyError || err instanceof CaptureBudgetError) {
        console.warn(`[scheduler] Held back “${source.name}”: ${err.message}`);
        continue;
      }
      console.error(`[scheduler] Could not start “${source.name}”:`, (err as Error).message);
    }
  }
}

/**
 * Run history past its retention window. Once a day is plenty — the check is
 * cheap, but the delete isn't, and nothing depends on it being prompt.
 */
let lastPruneDay: string | null = null;

async function housekeepingTick(now: Date) {
  const day = now.toISOString().slice(0, 10);
  if (lastPruneDay === day) return;
  lastPruneDay = day;
  const { retentionDays } = await readCaptureConfig();
  await pruneRunHistory(retentionDays, now);

  // Sessions that have expired or hit the absolute ceiling. resolveSession
  // deletes one when it is presented, but a session nobody ever returns to is
  // never presented — so without this the table keeps every token hash the
  // system has ever issued.
  const dropped = await purgeExpiredSessions();
  if (dropped) console.log(`[scheduler] cleared ${dropped} expired session(s)`);

  // Conversations kept so a blocked or failed task could be continued, long
  // after anybody was going to continue one.
  const staleCheckpoints = await pruneCheckpoints();
  if (staleCheckpoints) console.log(`[scheduler] cleared ${staleCheckpoints} stale agent checkpoint(s)`);

  // Hiring cards nobody answered. They have to expire rather than sit PENDING
  // for ever: pending proposals are *counted*, so five forgotten ones would
  // stop the Agent Creator proposing anything at all with nothing to show why.
  const expired = await expireStaleHireRequests(now);
  if (expired) console.log(`[scheduler] expired ${expired} unanswered hire request(s)`);

  // A gap whose review task somebody cancelled would otherwise sit IN_REVIEW
  // with nothing reviewing it. recordGap raises the review at the moment the
  // gap is filed; this is the only path that covers one being taken away
  // afterwards.
  const reviews = await ensureGapReviews();
  if (reviews) console.log(`[scheduler] raised ${reviews} skill-gap review(s)`);
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    void tick().catch((err) => console.error("[scheduler] tick failed:", err));
  }, TICK_MS);
  // Don't hold the process open on shutdown.
  timer.unref?.();

  void resumeInterruptedRuns().catch((err) => console.error("[scheduler] resume failed:", err));
  // Agent runs the last process died in the middle of. Handed back before the
  // first tick, because each one is holding an agent that cannot work until it
  // lets go — and each carries a checkpoint, so being handed back costs
  // nothing but the seconds since the restart.
  void resumeInterruptedTasks().catch((err) => console.error("[scheduler] agent resume failed:", err));
  void tick().catch((err) => console.error("[scheduler] first tick failed:", err));
  console.log("  → Scheduler running (lead capture, care plan billing, email, agent tasks — checks every minute)");
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
