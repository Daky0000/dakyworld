import { apifyConfigured } from "../lib/apify.js";
import { pngSize } from "./png.js";
import {
  downloadScreenshot,
  runScreenshotActor,
  screenshotActorId,
  type ScreenshotRow,
} from "./apifyScreenshot.js";

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
 *    new way for a deploy to fail. Since 2 Sep 2026 the actor doing it is
 *    Dakyworld's own — `apify/dakyworld-screenshot` in this repository — which
 *    is what let the four external actors, their incompatible input schemas
 *    and the layer that translated between them all leave this file.
 *  - **The top of the page only, and the actor cuts it.** A full-page
 *    screenshot of a long homepage comes back taller than any vision model
 *    will accept, and the part the argument rests on is the part a visitor
 *    sees before scrolling. `maxHeight` and `maxWidth` go out with the run, so
 *    what comes back over the network is already the picture the model reads
 *    rather than a 12,000px page this server then has to decode.
 *  - **It never throws.** No token, actor down, site refuses a headless
 *    browser — every one of those is a note, and the caller falls back to the
 *    structural audit, which needs nothing but a fetch.
 */

/** A desktop viewport. Wide enough that a responsive site shows its real layout. */
export const VIEWPORT_WIDTH = 1280;

/**
 * The window heights that go with the two widths.
 *
 * A real laptop and a real iPhone 14. The picture is taken full-page and cut
 * to `keepRows` afterwards, so this is not what decides how much page comes
 * back — it is what the page is told it is being viewed on, which decides
 * where a sticky header sits and how much a lazy-loading gallery brings in
 * before the shutter. It must be a real device height: deriving it from the
 * width (the first version used three quarters) gives a phone a 293px-tall
 * window, which is not a shape any site has been designed against.
 */
const VIEWPORT_HEIGHT = 800;
const PHONE_VIEWPORT_HEIGHT = 844;

/**
 * A phone viewport, for the second picture the audit team asks for.
 *
 * 390 is an iPhone 14's CSS width and the number the whole trade designs
 * against. It matters more than the desktop shot for most of the businesses
 * this app writes to: their customers are on a phone, and a site that lays out
 * correctly at 1280 and spills off the screen at 390 looks fine in every check
 * that is not this one.
 */
export const PHONE_VIEWPORT_WIDTH = 390;

export interface ShotOptions {
  /** The browser width to render at. Defaults to the desktop viewport. */
  viewportWidth?: number;
  /** The window height to render at. Defaults to the height that goes with the width. */
  viewportHeight?: number;
  /**
   * How many rows of the captured page to keep. A phone screenshot is three
   * times as tall for the same content, so keeping the desktop number would
   * cut it off part-way down the first screen.
   */
  keepRows?: number;
}

/**
 * What the vision model is actually sent, after cropping.
 *
 * Vision is billed in 512px tiles, so 1280 wide costs three tiles across and
 * 1024 costs two — a third off every look, for a picture that answers the same
 * questions just as well. The shot is taken at 1280 because that is the width
 * at which a responsive site lays itself out like a desktop site; it is only
 * shrunk on the way to the model.
 */
const MODEL_WIDTH = 1024;

/** How many pages one run may cover. Beyond this the run gets slow and fragile. */
export const MAX_BATCH = 20;

/**
 * How much of the page is kept. About two and a half screens: the fold, plus
 * whatever the first scroll reveals, which together are what a first
 * impression is made of.
 */
const KEEP_ROWS = 2400;

/** Milliseconds after load, for fonts and a hero image to arrive. */
const DELAY_MS = 3000;

/** Past this, the image is dropped rather than sent — every vendor rejects it anyway. */
const MAX_IMAGE_BYTES = 4_500_000;
/** Claude's ceiling, and the lowest of the three. */
const MAX_IMAGE_EDGE = 8000;

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
  /**
   * The signed Apify link to the **original** full-size picture, which expires.
   * Kept so a person can open what was actually captured — `width` and
   * `height` above describe the cropped, shrunk copy the model was shown.
   */
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

/**
 * Screenshots for many businesses in one run.
 *
 * This is where nearly all the cost of the feature lives, and almost none of
 * it is the picture. An Apify run boots a container and a browser before it
 * does anything useful, and that boot is the same whether the run shoots one
 * page or twenty. Preparing sixty freshly captured leads one at a time is
 * sixty boots — half an hour of waiting and sixty times the compute, for the
 * same sixty pictures a handful of runs would have produced.
 *
 * So the batch is the real function and `captureHomepage` is a wrapper on it.
 * A single lead in the drawer still gets its own run, because a person is
 * watching; bulk work goes through here in groups of `MAX_BATCH`.
 */
export async function captureHomepages(websites: string[], options: ShotOptions = {}): Promise<Map<string, ShotResult>> {
  const results = new Map<string, ShotResult>();
  const viewportWidth = options.viewportWidth ?? VIEWPORT_WIDTH;
  const viewportHeight = options.viewportHeight ?? (viewportWidth <= 500 ? PHONE_VIEWPORT_HEIGHT : VIEWPORT_HEIGHT);
  const keepRows = options.keepRows ?? KEEP_ROWS;

  // Normalise first, so an unusable address costs nothing and says so. The id
  // is the position in this list: it is generated here, sent with the request
  // and matched on the way back, so it never has to be guessed at either end.
  const wanted: { id: string; requested: string; url: string }[] = [];
  const seen = new Map<string, string>();
  for (const website of websites) {
    if (results.has(website) || seen.has(website)) continue;
    const url = normaliseSiteUrl(website);
    if (!url) {
      results.set(website, none(`"${website}" is not a web address this could open, so no screenshot was taken.`));
      continue;
    }
    const id = `s${wanted.length}`;
    seen.set(website, id);
    wanted.push({ id, requested: website, url });
  }
  if (wanted.length === 0) return results;

  if (!(await apifyConfigured())) {
    const note = "No screenshot was taken — Apify is not connected. Add a token under Lead Sources → Connection.";
    for (const entry of wanted) results.set(entry.requested, none(note));
    return results;
  }

  const failAll = (note: string) => {
    for (const entry of wanted) if (!results.has(entry.requested)) results.set(entry.requested, none(note));
    return results;
  };

  // The clock scales with the batch: twenty pages genuinely take longer than
  // one, and giving up early would throw away a run that has been paid for.
  const giveUpAfterMs = Math.min(600_000, 60_000 + wanted.length * 20_000);

  const run = await runScreenshotActor(
    {
      urls: wanted.map((entry) => ({ id: entry.id, url: entry.url })),
      viewport: { width: viewportWidth, height: viewportHeight },
      fullPage: true,
      delayMs: DELAY_MS,
      maxWidth: MODEL_WIDTH,
      maxHeight: keepRows,
    },
    { waitMs: giveUpAfterMs },
  );

  if (!run.ok) {
    switch (run.code) {
      case "APIFY_NOT_CONFIGURED":
      case "APIFY_AUTH_ERROR":
        return failAll(run.message);
      case "STILL_RUNNING":
        return failAll(`No screenshot was taken — the run was still going after ${Math.round(giveUpAfterMs / 1000)} seconds.`);
      case "APIFY_UNREACHABLE":
        return failAll(`No screenshot was taken — Apify stopped answering: ${run.message}`);
      case "DATASET_RETRIEVAL_FAILED":
        return failAll(`The screenshots were taken but could not be read back: ${run.message}`);
      case "ACTOR_FAILED":
      case "ACTOR_ABORTED":
      case "ACTOR_TIMEOUT":
        return failAll(`No screenshot was taken — the run did not finish. ${run.message}`);
      default:
        return failAll(`No screenshot was taken — Apify would not start the run: ${run.message}`);
    }
  }

  // What one page cost, which is the number worth knowing when pricing a
  // batch. Apify reports per run, so it is shared out across the pictures that
  // actually came back.
  const withImages = [...run.rows.values()].filter((row) => row.success).length;
  const perShot = run.costUsd != null && withImages > 0 ? run.costUsd / withImages : null;
  const takenAt = new Date().toISOString();

  for (const entry of wanted) {
    // By id, and only by id. Nothing here looks at position, and a row that
    // did not come back is a page with no picture rather than a reason to
    // reach for the row next to it.
    const row = run.rows.get(entry.id);
    if (!row) {
      results.set(entry.requested, none(`No screenshot came back for ${entry.url} — the run finished without producing a result for it.`));
      continue;
    }
    if (!row.success || !row.screenshotUrl) {
      results.set(entry.requested, none(describeRowFailure(entry.url, row)));
      continue;
    }
    results.set(entry.requested, await readShot(entry, row, takenAt, perShot, viewportWidth));
  }

  return results;
}

/**
 * Why one page in a finished run has no picture.
 *
 * Each of these is an ordinary thing for a stranger's website to do, and each
 * needs a different sentence — "their site timed out" and "that address does
 * not resolve" send a person to two different places. The actor's own message
 * is carried through when there is nothing better to say, which is the
 * difference between "no picture" and a reason.
 */
function describeRowFailure(url: string, row: ScreenshotRow): string {
  const said = row.error?.message?.trim();
  switch (row.error?.code) {
    case "PAGE_TIMEOUT":
      return `No screenshot of ${url} — the page did not finish loading in time. A slow site, or one that never stops requesting.`;
    case "NAVIGATION_ERROR":
      return `No screenshot of ${url} — the page could not be opened.${said ? ` ${said}` : ""}`;
    case "INVALID_URL":
      return `No screenshot of ${url} — it is not an address a browser could open.`;
    case "SCREENSHOT_FAILED":
    case "IMAGE_PROCESSING_FAILED":
      return `The page at ${url} opened but no usable picture came out of it.${said ? ` ${said}` : ""}`;
    case "BROWSER_LAUNCH_FAILED":
      return `No screenshot of ${url} — the screenshot actor could not start a browser.${said ? ` ${said}` : ""}`;
    default:
      return `No screenshot came back for ${url}.${said ? ` ${said}` : ""}`;
  }
}

async function readShot(
  entry: { requested: string; url: string },
  row: ScreenshotRow,
  takenAt: string,
  costUsd: number | null,
  viewportWidth: number,
): Promise<ShotResult> {
  const downloaded = await downloadScreenshot(row.screenshotUrl!);
  if (!downloaded.ok) return none(`The screenshot of ${entry.url} could not be downloaded: ${downloaded.message}`);
  const sent = downloaded.bytes;

  // The actor reports the size it produced; this reads it off the file. They
  // should agree, and the file is the one the model is actually being handed —
  // so a disagreement means trusting the bytes rather than the claim.
  const size = pngSize(sent) ?? (row.width && row.height ? { width: row.width, height: row.height } : null);

  if (!size || size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE) {
    return none(`The screenshot of ${entry.url} came back in a shape no model will read, so the look at their homepage was skipped.`);
  }
  if (sent.byteLength > MAX_IMAGE_BYTES) {
    return none(`The screenshot of ${entry.url} is ${(sent.byteLength / 1_000_000).toFixed(1)}MB, past what a model will accept, so it was skipped.`);
  }

  return {
    shot: {
      requested: entry.url,
      finalUrl: row.finalUrl,
      takenAt,
      viewportWidth,
      width: size.width,
      height: size.height,
      cropped: row.cropped,
      // The uncut capture when there is one, so a person opening this sees the
      // whole page rather than the same crop the model was shown.
      imageUrl: row.fullScreenshotUrl ?? row.screenshotUrl!,
      mediaType: "image/png",
      bytes: sent.byteLength,
      costUsd,
    },
    base64: sent.toString("base64"),
    note: row.cropped
      ? "Their homepage is longer than this; the picture is the top of the page, which is what a visitor sees first."
      : null,
  };
}

/** One business. A person is waiting, so it gets a run of its own. */
export async function captureHomepage(website: string, options: ShotOptions = {}): Promise<ShotResult> {
  const results = await captureHomepages([website], options);
  return results.get(website) ?? none(`No screenshot was taken for ${website}.`);
}

/** Which actor is doing this, for anything that needs to say so. */
export { screenshotActorId };
