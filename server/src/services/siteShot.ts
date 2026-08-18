import { ApifyNotConfiguredError, apifyConfigured, getDatasetItems, getRun, runCost, startRun } from "../lib/apify.js";
import { cropPngTop, pngSize } from "./png.js";

/**
 * A picture of a prospect's homepage.
 *
 * `companyAudit` reads their markup and their DNS, and it answers everything
 * that is *checkable* — no HTTPS, no viewport tag, a 2019 copyright line. What
 * it cannot answer is the question a business owner actually asks, which is
 * "what does my site look like to somebody who has never seen it". A homepage
 * can pass every structural check and still open on a stock photo of a
 * handshake, a logo stretched out of shape, and no way to tell within five
 * seconds what the business sells. That argument needs an image.
 *
 * Three decisions worth knowing:
 *
 *  - **Apify takes the screenshot, not this server.** A headless Chrome in the
 *    deployment is three hundred megabytes, a browser to keep patched, and a
 *    new way for a deploy to fail — in exchange for a job Apify's own actor
 *    has done two million times and this app already holds a token for.
 *  - **The top of the page only.** A full-page screenshot of a long homepage
 *    comes back taller than any vision model will accept, and the part of it
 *    the argument rests on is the part a visitor sees before scrolling.
 *    `cropPngTop` cuts it down here rather than paying to send the footer.
 *  - **It never throws.** No token, actor down, site refuses a headless
 *    browser — every one of those is a note, and the caller falls back to the
 *    structural audit, which needs nothing but a fetch.
 */

/** Apify's own actor: two million runs, free beyond platform compute. */
export const SCREENSHOT_ACTOR = "apify/screenshot-url";

/** A desktop viewport. Wide enough that a responsive site shows its real layout. */
const VIEWPORT_WIDTH = 1280;

/**
 * How much of the page is kept. About two and a half screens: the fold, plus
 * whatever the first scroll reveals, which together are what a first
 * impression is made of.
 */
const KEEP_ROWS = 2400;

/** Past this, the image is dropped rather than sent — every vendor rejects it anyway. */
const MAX_IMAGE_BYTES = 4_500_000;
/** Claude's ceiling, and the lowest of the three. */
const MAX_IMAGE_EDGE = 8000;

const START_TIMEOUT_SECS = 120;
const POLL_EVERY_MS = 2500;
const GIVE_UP_AFTER_MS = 150_000;

export interface Screenshot {
  /** What we asked for. */
  requested: string;
  /** Where the actor ended up — a redirect to www or to https shows here. */
  finalUrl: string | null;
  takenAt: string;
  viewportWidth: number;
  width: number;
  height: number;
  /** True when the page was longer than `KEEP_ROWS` and the rest was cut. */
  cropped: boolean;
  /** The signed Apify link, which expires. Kept so a person can open the original. */
  imageUrl: string;
  mediaType: string;
  bytes: number;
  /** What Apify billed for the run, when it says. */
  costUsd: number | null;
}

export interface ShotResult {
  /** Null whenever anything at all went wrong. `note` says what. */
  shot: Screenshot | null;
  /** The image itself, base64, for handing to a model. Absent when `shot` is null. */
  base64: string | null;
  /** Plain words for a person: why there is no picture, or what was cut. */
  note: string | null;
}

const none = (note: string): ShotResult => ({ shot: null, base64: null, note });

/** `dakyworld.com` becomes `https://dakyworld.com`. Null for anything that is not a web address. */
export function normaliseSiteUrl(website: string): string | null {
  const trimmed = website.trim();
  if (!trimmed) return null;
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

export async function captureHomepage(website: string): Promise<ShotResult> {
  const url = normaliseSiteUrl(website);
  if (!url) return none(`"${website}" is not a web address this could open, so no screenshot was taken.`);
  if (!(await apifyConfigured())) {
    return none("No screenshot was taken — Apify is not connected. Add a token under Lead Sources → Connection.");
  }

  let run;
  try {
    run = await startRun(
      SCREENSHOT_ACTOR,
      {
        urls: [{ url }],
        format: "png",
        // Declared required by the actor's own input schema, alongside
        // `waitUntil` and `delay` — omitting it is an input validation
        // failure, not a default.
        viewportWidth: VIEWPORT_WIDTH,
        // "load" rather than networkidle: a site with a chat widget or an ad
        // script never goes idle, and waiting for it burns the whole timeout
        // to produce the same picture.
        waitUntil: "load",
        // Long enough for web fonts and a hero image to arrive, so the shot is
        // of their site rather than of their site loading.
        delay: 3000,
        scrollToBottom: false,
        proxy: { useApifyProxy: true },
      },
      { timeoutSecs: START_TIMEOUT_SECS, memoryMbytes: 2048 },
    );
  } catch (err) {
    if (err instanceof ApifyNotConfiguredError) return none(err.message);
    return none(`No screenshot was taken — Apify would not start the run: ${(err as Error).message}`);
  }

  const giveUpAt = Date.now() + GIVE_UP_AFTER_MS;
  let finished = run;
  while (finished.status === "READY" || finished.status === "RUNNING") {
    if (Date.now() > giveUpAt) {
      return none(`No screenshot was taken — ${url} was still loading after ${Math.round(GIVE_UP_AFTER_MS / 1000)} seconds.`);
    }
    await wait(POLL_EVERY_MS);
    try {
      finished = await getRun(run.id);
    } catch (err) {
      return none(`No screenshot was taken — Apify stopped answering: ${(err as Error).message}`);
    }
  }

  if (finished.status !== "SUCCEEDED") {
    return none(`No screenshot was taken — the run ${finished.status.toLowerCase()}. Their site may block automated browsers.`);
  }

  let items: Record<string, unknown>[];
  try {
    items = await getDatasetItems(finished.defaultDatasetId, 5);
  } catch (err) {
    return none(`The screenshot was taken but could not be read back: ${(err as Error).message}`);
  }

  const item = items.find((row) => typeof row.screenshotUrl === "string");
  const imageUrl = item?.screenshotUrl as string | undefined;
  if (!imageUrl) return none(`No screenshot was taken — the run finished without producing an image for ${url}.`);

  let raw: Buffer;
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return none(`The screenshot could not be downloaded (HTTP ${response.status}).`);
    raw = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    return none(`The screenshot could not be downloaded: ${(err as Error).message}`);
  }

  const original = pngSize(raw);
  const trimmed = cropPngTop(raw, KEEP_ROWS) ?? raw;
  const size = pngSize(trimmed);
  const cropped = Boolean(original && size && original.height > size.height);

  if (!size || size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE) {
    return none("The screenshot came back in a shape no model will read, so the look at their homepage was skipped.");
  }
  if (trimmed.byteLength > MAX_IMAGE_BYTES) {
    return none(
      `The screenshot of ${url} is ${(trimmed.byteLength / 1_000_000).toFixed(1)}MB, past what a model will accept, so it was skipped.`,
    );
  }

  const cost = await runCost(finished, SCREENSHOT_ACTOR).catch(() => ({ totalUsd: null, events: null }));

  return {
    shot: {
      requested: url,
      finalUrl: typeof item?.url === "string" ? item.url : null,
      takenAt: finished.finishedAt ?? new Date().toISOString(),
      viewportWidth: VIEWPORT_WIDTH,
      width: size.width,
      height: size.height,
      cropped,
      imageUrl,
      mediaType: "image/png",
      bytes: trimmed.byteLength,
      costUsd: cost.totalUsd,
    },
    base64: trimmed.toString("base64"),
    note: cropped
      ? `Their homepage is longer than this; the picture is the top ${size.height}px, which is what a visitor sees first.`
      : null,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
