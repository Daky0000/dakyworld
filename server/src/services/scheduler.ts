import type { ScraperSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { apifyConfigured } from "../lib/apify.js";
import { isValidTimezone, parseScheduleTime, safeZone, zonedDateParts, zonedTimeToUtc } from "../lib/timezone.js";
import { CaptureBudgetError, CaptureBusyError, pruneRunHistory, resumeInterruptedRuns, runSource } from "./scraperRunner.js";
import { readCaptureConfig } from "./captureConfig.js";
import { runDueHunts } from "./hunt/run.js";
import { billDuePlans } from "./carePlanBilling.js";
import { dispatchDueEmails } from "./emailSender.js";
import { dispatchDueMessages } from "./messageSender.js";
import { runDueSequences } from "./emailSequences.js";
import { readMailboxOnce } from "./mailbox/watcher.js";
import { runDueTasks, resumeInterruptedTasks } from "./agents/runner.js";
import { pruneCheckpoints } from "./agents/checkpoint.js";
import { ensureGapReviews, expireStaleHireRequests, postGapNotice } from "./agents/hiring.js";
import { postEscalationDigest } from "./agents/escalationDigest.js";
import { SETTING, getSetting, setSetting } from "../lib/settings.js";
import { expireStaleRequests, flagStalePreparedActions } from "./approvals.js";
import { raiseStandingWork } from "./agents/standingWork.js";
import { restoreOrphanedWakes } from "./rehearsals/wake.js";
import { settleIdleRehearsals } from "./rehearsals/run.js";
import { purgeExpiredSessions } from "../lib/session.js";

/**
 * The app's clock. Three things run on it:
 *
 *  - **Lead capture.** Each source carries a list of local times ("06:30",
 *    "18:00") and a timezone; this ticks once a minute and starts whichever
 *    ones are due.
 *  - **Care plan billing.** Each active plan bills on its own day of the
 *    month — see `carePlanBilling.ts`.
 *  - **The mailbox.** Whatever has arrived since the last pass, in both the
 *    inbox and Sent — see `services/mailbox/`. A live IMAP connection normally
 *    beats this to it; the tick is what makes the feature work anyway when
 *    that connection is down, which on a mail server is often.
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
export { isValidTimezone, parseScheduleTime };



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
    // WhatsApp and SMS, on the same tick and settled separately for the same
    // reason: a WhatsApp token that has expired must not stop an invoice email.
    dispatchDueMessages(now),
    runDueSequences(now),
    // Reading the mailbox. The IMAP watcher usually gets there first — this is
    // the floor under it, and the only thing that reads the Sent folder, so a
    // reply the Owner typed on his phone is noticed within the minute whether
    // or not the live connection is up.
    readMailboxOnce(),
    runDueTasks(now),
    // What the agents do without being asked. Raises tasks; runDueTasks above
    // is what works them, on the next tick rather than this one — deliberately,
    // so raising work and doing it stay separable.
    raiseStandingWork(now),
    // The hunts. Deliberately its own job rather than part of `captureTick`:
    // a hunt starts a capture, waits for it, then audits and judges what came
    // back, which is minutes of work — and the whole point of settling these
    // separately is that no one of them may hold up an invoice. `runDueHunts`
    // returns as soon as it has started what is due; the cycles run behind it.
    runDueHunts(now),
    // Rehearsals nobody is watching any more. The screen drains its own run
    // while it is open; this is the floor under that, and it is what puts a
    // woken agent's autonomy back when the tab was closed part-way.
    settleIdleRehearsals(),
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

  // Prepared actions nobody decided on. A week-old proposal is a re-ask rather
  // than a refusal — the invoice may have been paid and the lead gone cold
  // since — and carrying one out on the strength of a decision that was never
  // actually made is the mistake this guards against. Leaving them PENDING
  // would also make the queue a list of things that are not going to happen,
  // which is how a queue stops being read.
  await expireStaleRequests();

  // Prepared actions somebody has had two days to look at.
  //
  // Different from expiry above and it matters: expiry is what happens to a
  // card at seven days, which is a card giving up. This is at two, while there
  // is still time to act on it — and it is per agent, because eleven cards
  // spread across the workforce is a busy week and eleven against one agent is
  // an agent nobody is reading.
  //
  // Said in the log rather than posted. A Slack message every day about the
  // same undecided card is how the channel stops being read, and the weekly
  // digest already carries the questions that genuinely need chasing.
  for (const row of await flagStalePreparedActions()) {
    console.log(
      `[scheduler] ${row.agentName} (${row.agentKey}) has ${row.waiting} prepared action(s) waiting — the oldest ` +
        `${row.oldestHours}h: ${row.oldest?.wouldDo?.slice(0, 120) ?? row.oldest?.tool ?? "unknown"}. Decide them under Approvals.`,
    );
  }

  // The week's unanswered questions, once a week. On the daily tick rather
  // than a timer of its own: this function already runs once a day and already
  // owns the "have I done this yet today" guard, and a second scheduler is a
  // second thing that can silently stop.
  //
  // Keyed on the ISO week rather than a day-of-week test. A container that
  // happens to be restarting every Monday morning would post one digest per
  // restart; a container that is down all Monday would post none at all.
  const week = isoWeek(now);
  if ((await getSetting(SETTING.WEEKLY_DIGEST_SENT)) !== week) {
    const digest = await postEscalationDigest();
    // Marked whether or not anything was posted. A quiet week is a week that
    // has been checked, and re-checking it every day would be the same query
    // for the same answer.
    await setSetting(SETTING.WEEKLY_DIGEST_SENT, week);
    if (digest.posted) console.log(`[scheduler] posted the weekly digest — ${digest.count} question(s) waiting`);
    else if (digest.count > 0) console.log(`[scheduler] ${digest.count} agent question(s) waiting, and no Slack to say so on`);
  }

  // The crafts enough separate agents have asked for that the answer is
  // somebody's decision rather than a queue.
  //
  // A second weekly message rather than a section on the digest above, and
  // that is deliberate: the digest is questions waiting on the Owner *now*,
  // and a week with no questions must still be a week the piling-up gaps are
  // said out loud. Its own sent-marker for the same reason — see
  // `GAP_NOTICE_SENT`.
  //
  // Every gap here already has a review on the Agent Creator's queue, raised
  // when it was filed. This says nothing new about any one of them; what it
  // says is that they are accumulating, which no single review can.
  if ((await getSetting(SETTING.GAP_NOTICE_SENT)) !== week) {
    const notice = await postGapNotice();
    await setSetting(SETTING.GAP_NOTICE_SENT, week);
    if (notice.posted) console.log(`[scheduler] posted the skill-gap notice — ${notice.count} craft(s) waiting on a decision`);
    else if (notice.count > 0) console.log(`[scheduler] ${notice.count} skill gap(s) waiting on a decision, and no Slack to say so on`);
  }
}

/** `2026-W35`. Stable across a restart, unlike "is it Monday". */
function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weeks run Monday to Sunday and belong to the year containing their
  // Thursday, which is why this shifts to Thursday before reading the year.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - start) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
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
  // Agents a rehearsal woke and never got to put back, because the process
  // holding the run was killed. Left alone, the next tick hands those agents
  // real work — a test changing how the business runs, days later, with
  // nothing on screen connecting the two.
  void restoreOrphanedWakes().catch((err) => console.error("[scheduler] rehearsal wake restore failed:", err));
  void tick().catch((err) => console.error("[scheduler] first tick failed:", err));
  console.log("  → Scheduler running (lead capture, lead hunts, care plan billing, email, WhatsApp/SMS, agent tasks — checks every minute)");
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
