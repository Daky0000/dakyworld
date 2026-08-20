import type { AgentSchedule } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { parseScheduleTime, safeZone, zonedDateParts, zonedTimeToUtc } from "../../lib/timezone.js";

/**
 * What an agent does without being asked.
 *
 * `AgentTaskOrigin.SCHEDULE` has existed since the runtime shipped and nothing
 * has ever written it. Every task so far has come from a person opening the
 * Agents screen, or from one agent handing work to another — which makes fifty
 * agents that can work and have no reason to start. This is the reason to
 * start.
 *
 * **The time maths is `lib/timezone`'s**, which is where the scrapers get
 * theirs. `parseScheduleTime` moved there when this arrived, because the
 * scheduler importing standing work while standing work imported the scheduler
 * is a module cycle — the kind that surfaces as an undefined export at boot
 * rather than as a type error.
 *
 * **Three ceilings, because a loop that raises work faster than an agent
 * finishes it would queue for ever and the first sign of it would be the
 * bill:**
 *
 * 1. `maxOpenTasks` per schedule — by default one, so a daily brief that is
 *    still unfinished tomorrow does not become two.
 * 2. The per-agent lock in the runner's claim: one agent, one running task.
 * 3. `MAX_CATCHUP_MS`, so a slot missed during an outage is skipped rather
 *    than stampeded through on boot.
 */

/** A slot older than this was missed during an outage. Do it next time, not six times now. */
const MAX_CATCHUP_MS = 6 * 60 * 60_000;

/** The soonest slot strictly after `from`, ignoring the weekday rule. */
function soonestSlot(runTimes: string[], timezone: string, from: Date): Date | null {
  const zone = safeZone(timezone);
  const [year, month, day] = zonedDateParts(from, zone);

  let earliest: Date | null = null;
  // Today and tomorrow is enough for a daily schedule; the extra day covers
  // slots that have already passed in the schedule's own timezone.
  for (const dayOffset of [0, 1]) {
    for (const raw of runTimes) {
      const time = parseScheduleTime(raw);
      if (!time) continue;
      const candidate = zonedTimeToUtc(year, month, day + dayOffset, time.hour, time.minute, zone);
      if (candidate.getTime() > from.getTime() && (!earliest || candidate < earliest)) earliest = candidate;
    }
  }
  return earliest;
}

/**
 * The next time this schedule should raise a task.
 *
 * Walks forward over weekends where the schedule asks for weekdays only. The
 * walk is bounded rather than trusted to terminate: a schedule saved with the
 * times field empty would otherwise spin, and that is the easiest one to save
 * by accident.
 */
export function nextRunFor(schedule: Pick<AgentSchedule, "enabled" | "runTimes" | "timezone" | "weekdaysOnly">, from = new Date()): Date | null {
  if (!schedule.enabled || schedule.runTimes.length === 0) return null;
  let cursor = from;

  for (let attempt = 0; attempt < 14; attempt += 1) {
    const next = soonestSlot(schedule.runTimes, schedule.timezone, cursor);
    if (!next) return null;
    if (!schedule.weekdaysOnly) return next;

    // Judged in the schedule's own zone, not the server's: 08:00 Monday in
    // Accra is Sunday evening in a good many of them.
    const zone = safeZone(schedule.timezone);
    const [year, month, day] = zonedDateParts(next, zone);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return next;

    cursor = next;
  }
  return null;
}

/** Recomputes and stores `nextRunAt`. Call after any change to a schedule. */
export async function syncStandingWork(id: string): Promise<Date | null> {
  const schedule = await prisma.agentSchedule.findUnique({ where: { id } });
  if (!schedule) return null;
  const nextRunAt = schedule.enabled ? nextRunFor(schedule) : null;
  await prisma.agentSchedule.update({ where: { id }, data: { nextRunAt } });
  return nextRunAt;
}

/**
 * Raises the tasks that are due.
 *
 * Joins the six jobs on the minute tick. Like the scraper tick it **advances
 * the schedule before doing the work**, so a failure cannot be retried in a
 * loop and a restart cannot fire the same slot twice.
 */
export async function raiseStandingWork(now = new Date()): Promise<number> {
  // Schedules enabled before this ever ran, or saved with no next time worked
  // out. Same backfill the scrapers do.
  const unscheduled = await prisma.agentSchedule.findMany({ where: { enabled: true, nextRunAt: null } });
  for (const schedule of unscheduled) {
    await prisma.agentSchedule.update({ where: { id: schedule.id }, data: { nextRunAt: nextRunFor(schedule, now) } });
  }

  const due = await prisma.agentSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    include: { agent: { select: { key: true, name: true, status: true } } },
  });
  if (due.length === 0) return 0;

  let raised = 0;
  for (const schedule of due) {
    const slot = schedule.nextRunAt;
    // Spent whatever happens next.
    await prisma.agentSchedule.update({
      where: { id: schedule.id },
      data: { nextRunAt: nextRunFor(schedule, now), lastRunAt: now },
    });

    if (slot && now.getTime() - slot.getTime() > MAX_CATCHUP_MS) {
      console.warn(`[standing] skipping "${schedule.title}" — its ${slot.toISOString()} slot is more than six hours stale.`);
      continue;
    }

    // A draft or paused agent is not refused loudly: the Owner pausing an agent
    // is exactly how they stop its standing work, and a warning every minute
    // about a deliberate decision is noise.
    if (schedule.agent.status !== "ACTIVE") continue;

    const open = await prisma.agentTask.count({
      where: { agentKey: schedule.agentKey, origin: "SCHEDULE", title: schedule.title, status: { in: ["QUEUED", "RUNNING", "BLOCKED", "NEEDS_APPROVAL"] } },
    });
    if (open >= schedule.maxOpenTasks) {
      console.warn(`[standing] "${schedule.title}" already has ${open} open — not raising another.`);
      continue;
    }

    await prisma.agentTask.create({
      data: {
        agentKey: schedule.agentKey,
        title: schedule.title,
        brief: schedule.brief,
        origin: "SCHEDULE",
      },
    });
    raised += 1;
    console.log(`[standing] raised "${schedule.title}" for ${schedule.agent.name}`);
  }

  return raised;
}
