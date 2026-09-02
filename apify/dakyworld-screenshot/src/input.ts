import type { ScreenshotInput, ScreenshotRequest } from "./contract.js";

/**
 * Reading the run's input, with a defence for every field.
 *
 * The caller is Dakyworld OS and it sends the right shape. This exists for the
 * other two callers: a person running the actor from the Apify console, and a
 * future version of the server whose contract has drifted. Neither should be
 * able to produce a run that boots a browser and then does nothing
 * explicable — so a missing viewport becomes a laptop, a nonsense delay
 * becomes the default, and only an empty URL list is fatal.
 */

/** A laptop. Wide enough that a responsive site shows its real layout. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
/** Fonts and a hero image, which are most of what a first impression is. */
export const DEFAULT_DELAY_MS = 3000;
/** Per page. Enough for a slow site, short enough that twenty of them end. */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 45_000;
/** Past this the run gets slow and fragile, and Apify's own timeout looms. */
export const MAX_URLS = 20;

export class InvalidInputError extends Error {}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(value)));
}

function number(value: unknown, fallback: number, low: number, high: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, low, high) : fallback;
}

/**
 * Whether this is a page a browser could open.
 *
 * Checked here as well as in the server, and that is not the duplication the
 * refactor set out to remove: the server's copy exists to avoid paying for a
 * run at all, and this one exists because the console and any future caller
 * are not the server. It is four lines, and the alternative is a browser
 * navigating to `javascript:` because somebody pasted it into a form.
 */
export function validUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname.includes(".")) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * The requests, with an id on every one.
 *
 * A bare string is accepted so the actor is usable by hand from the console,
 * where nobody wants to invent ids. The generated id is positional, which is
 * exactly what the server must never rely on — but a console run has no second
 * system to hand the rows back to, so there is nothing there to mismatch.
 */
function readUrls(raw: unknown): ScreenshotRequest[] {
  if (!Array.isArray(raw)) throw new InvalidInputError('Input must carry a "urls" array.');

  const requests: ScreenshotRequest[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const url = typeof entry === "string" ? entry : (entry as { url?: unknown })?.url;
    const given = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
    // Kept as the caller wrote it, not as it normalises — the server keys its
    // own results off the string it sent, and a row coming back under a
    // tidied-up id is a row it cannot find.
    const id = typeof given === "string" && given.trim() ? given.trim() : `url_${index}`;
    if (seen.has(id)) throw new InvalidInputError(`Two requests share the id "${id}". Ids must be unique within a run.`);
    seen.add(id);
    requests.push({ id, url: typeof url === "string" ? url : "" });
  }

  if (requests.length === 0) throw new InvalidInputError('Input carried no URLs — "urls" was empty.');
  // Truncating rather than refusing: the ceiling is about how long a run takes,
  // and a caller that asked for 25 pages is better served by 20 pictures and a
  // line in the log than by nothing at all.
  return requests.slice(0, MAX_URLS);
}

export function parseInput(raw: unknown): ScreenshotInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const viewport = (input.viewport ?? {}) as Record<string, unknown>;

  return {
    urls: readUrls(input.urls),
    viewport: {
      // The floor is a phone; the ceiling is past any real display, and both
      // are there so a typo cannot produce a 1px window Chromium spends the
      // whole timeout laying out.
      width: number(viewport.width, DEFAULT_VIEWPORT.width, 320, 3840),
      height: number(viewport.height, DEFAULT_VIEWPORT.height, 400, 4320),
    },
    fullPage: input.fullPage !== false,
    delay: number(input.delay, DEFAULT_DELAY_MS, 0, 30_000),
    maxWidth: input.maxWidth == null ? undefined : number(input.maxWidth, 0, 200, 3840),
    maxHeight: input.maxHeight == null ? undefined : number(input.maxHeight, 0, 200, 30_000),
    navigationTimeoutMs: number(input.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS, 5_000, 120_000),
    proxy: (input.proxy ?? input.proxyConfiguration) as ScreenshotInput["proxy"],
  };
}
