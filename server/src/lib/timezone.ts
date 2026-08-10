/**
 * Wall-clock arithmetic in a named timezone, with no dependency: `Intl`
 * already knows every zone and every DST rule, which is the hard part.
 *
 * Two things in this app run on a local clock rather than UTC — lead capture
 * fires at "06:30 in Accra", and a care plan bills on "the 1st in Accra" —
 * so both need the same conversion and it lives here rather than in either.
 */

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Falls back to UTC rather than throwing: a bad zone shouldn't stop a schedule. */
export function safeZone(timeZone: string | null | undefined): string {
  return timeZone && isValidTimezone(timeZone) ? timeZone : "UTC";
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

/**
 * The UTC instant at which a given wall-clock time occurs in `timeZone`.
 * Month and day overflow the way `Date.UTC` does, so month 13 is January and
 * day 32 is the 1st — which is what makes "the same day next month" a one-liner.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes: the first offset may belong to the wrong side of a DST change.
  let instant = naive - zoneOffsetMs(new Date(naive), timeZone);
  instant = naive - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** The date in `timeZone` at a given instant, as [year, month, day]. */
export function zonedDateParts(instant: Date, timeZone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(instant)
    .split("-")
    .map(Number);
  return [parts[0], parts[1], parts[2]];
}
