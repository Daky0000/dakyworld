/**
 * Files a demo's visitors could not load, as their own browsers reported them.
 *
 * Why this exists (11 Nov 2026): the Ghacem demo showed no pictures for days
 * while every request for them answered 200 in the HTTP logs. The browser was
 * discarding each file *after* it arrived (Cross-Origin-Resource-Policy against
 * a sandboxed page), and nothing on the server can see that. Twice before, the
 * same pictures had broken for other reasons (a lone HTML file, then a 404 per
 * picture), and each time the person who noticed was the person looking at the
 * page. So the page now says so itself: the tracker (`demoTracker.ts`) listens
 * for every picture, video, stylesheet, script, font and CSS background that
 * fails, and sends them with its beacon. Whatever the cause is next time — a
 * header, a CSP, a deleted asset, a storage bucket — it lands here, in the log
 * and on the Demos screen, the first time anyone opens the page.
 */

export interface BrokenFile {
  url: string;
  /** What asked for it: img, video, source, script, link, background, font. */
  kind: string;
}

export interface BrokenFileSummary extends BrokenFile {
  /** How many visits in the window reported it. */
  visits: number;
  lastSeenAt: string;
}

/** Per visit; the tracker sends no more than this either. */
export const MAX_BROKEN_FILES = 40;

/** Old reports stop counting once nobody has seen the file fail for this long. */
export const BROKEN_FILE_WINDOW_MS = 7 * 86400 * 1000;

function asBrokenFiles(value: unknown): BrokenFile[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is BrokenFile =>
    Boolean(entry) && typeof entry === "object" && typeof (entry as BrokenFile).url === "string" && typeof (entry as BrokenFile).kind === "string");
}

/** Adds a beacon's report to what the visit already holds, once per address. */
export function mergeBrokenFiles(existing: unknown, incoming: BrokenFile[] | undefined): { files: BrokenFile[]; added: BrokenFile[] } {
  const files = asBrokenFiles(existing);
  const seen = new Set(files.map((file) => file.url));
  const added: BrokenFile[] = [];
  for (const file of incoming ?? []) {
    if (files.length >= MAX_BROKEN_FILES) break;
    if (seen.has(file.url)) continue;
    seen.add(file.url);
    files.push(file);
    added.push(file);
  }
  return { files, added };
}

/** One line per address across recent visits, most recently seen first. */
export function summariseBrokenFiles(
  visits: Array<{ brokenFiles?: unknown; createdAt: Date; updatedAt?: Date }>,
  now = new Date(),
): BrokenFileSummary[] {
  const since = now.getTime() - BROKEN_FILE_WINDOW_MS;
  const byUrl = new Map<string, BrokenFileSummary>();
  for (const visit of visits) {
    const seenAt = visit.updatedAt ?? visit.createdAt;
    if (seenAt.getTime() < since) continue;
    for (const file of asBrokenFiles(visit.brokenFiles)) {
      const current = byUrl.get(file.url);
      if (!current) {
        byUrl.set(file.url, { ...file, visits: 1, lastSeenAt: seenAt.toISOString() });
        continue;
      }
      current.visits += 1;
      if (seenAt.toISOString() > current.lastSeenAt) current.lastSeenAt = seenAt.toISOString();
    }
  }
  return [...byUrl.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, MAX_BROKEN_FILES);
}

/** The line written to the server log, where the HTTP logs alone said 200. */
export function brokenFilesLogLine(slug: string, added: BrokenFile[]): string {
  const names = added.slice(0, 5).map((file) => `${file.kind} ${file.url}`).join(", ");
  const more = added.length > 5 ? ` and ${added.length - 5} more` : "";
  return `[demos] ${slug}: ${added.length} file${added.length === 1 ? "" : "s"} did not load in a visitor's browser: ${names}${more}`;
}
