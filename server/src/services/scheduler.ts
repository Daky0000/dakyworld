import type { ScraperSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { apifyConfigured } from "../lib/apify.js";
import { resumeInterruptedRuns, runSource } from "./scraperRunner.js";

/**
 * Daily lead capture. Each source carries a list of local times ("06:30",
 * "18:00") and a timezone; this ticks once a minute and starts whichever ones
 * are due.
 *
 * The next due instant is stored on the source as `nextRunAt` and advanced
 * *before* the run is started, so a failing actor can't be retried in a loop
 * and a restart can't fire the same slot twice.
 *
 * Deliberately in-process rather than a cron container: Dakyworld OS runs as a
 * single Railway service, and one setInterval has no moving parts to keep in
 * sync with a deploy.
 */

const TICK_MS = 60_000;
/** A slot missed by more than this — a long outage — is skipped, not stampeded through on boot. */
const MAX_CATCHUP_MS = 6 * 60 * 60_000;

let timer: NodeJS.Timeout | null = null;

// --- Timezone maths (no dependency: Intl already knows every zone) ---------

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** How far the zone is ahead of UTC at a given instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wallClockAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallClockAsUtc - instant.getTime();
}

/** The UTC instant at which a given wall-clock time occurs in `timeZone`. */
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes: the first offset may belong to the wrong side of a DST change.
  let instant = naive - zoneOffsetMs(new Date(naive), timeZone);
  instant = naive - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** Today's date in `timeZone`, as [year, month, day]. */
function zonedDateParts(instant: Date, timeZone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(instant)
    .split("-")
    .map(Number);
  return [parts[0], parts[1], parts[2]];
}

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

  const timeZone = isValidTimezone(source.timezone) ? source.timezone : "UTC";
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
      console.error(`[scheduler] Could not start “${source.name}”:`, (err as Error).message);
    }
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    void tick().catch((err) => console.error("[scheduler] tick failed:", err));
  }, TICK_MS);
  // Don't hold the process open on shutdown.
  timer.unref?.();

  void resumeInterruptedRuns().catch((err) => console.error("[scheduler] resume failed:", err));
  void tick().catch((err) => console.error("[scheduler] first tick failed:", err));
  console.log("  → Lead capture scheduler running (checks every minute)");
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
