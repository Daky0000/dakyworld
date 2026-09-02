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

/** The same two and a half screens on a phone, where the same content is taller. */
export const PHONE_KEEP_ROWS = 3200;

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
   * True when the page never finished loading and the picture is of the
   * document as it stood — usually one third-party asset that never returned.
   */
  partiallyLoaded: boolean;
  /**
   * True when the page would only open by going past a certificate warning —
   * what a person does at *Advanced → Continue to site*.
   *
   * On the picture rather than silent because a report showing it has to say
   * so: what came back over an unverified connection may not be genuine, and
   * the audit already labels every other section it read that way. See
   * SECURITY.md, which is where the scope of that relaxation is written down.
   */
  insecure: boolean;
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
 * One picture that has been asked for: a page, and the shape to take it in.
 *
 * The unit of a run is a **view**, not a website, because the two things this
 * app photographs are not the same shape. A batch of leads is one view each at
 * a laptop viewport; an audit is two views of one homepage. Both are the same
 * request to the actor, which takes a viewport per page.
 */
interface ShotRequest {
  /** Generated here, sent with the request, matched on the way back. */
  id: string;
  /** What the caller looks this result up by. */
  key: string;
  url: string;
  viewportWidth: number;
  viewportHeight: number;
  keepRows: number;
}

/** Fills in the defaults that go together, so a phone never gets a laptop's window. */
function shapeOf(options: ShotOptions): { viewportWidth: number; viewportHeight: number; keepRows: number } {
  const viewportWidth = options.viewportWidth ?? VIEWPORT_WIDTH;
  return {
    viewportWidth,
    viewportHeight: options.viewportHeight ?? (viewportWidth <= 500 ? PHONE_VIEWPORT_HEIGHT : VIEWPORT_HEIGHT),
    keepRows: options.keepRows ?? KEEP_ROWS,
  };
}

/**
 * One run, however many views it covers.
 *
 * This is where nearly all the cost of the feature lives, and almost none of
 * it is the picture. An Apify run boots a container and a browser before it
 * does anything useful, and that boot is the same whether the run shoots one
 * page or twenty. Preparing sixty freshly captured leads one at a time is
 * sixty boots — half an hour of waiting and sixty times the compute, for the
 * same sixty pictures a handful of runs would have produced.
 *
 * So this is the real function and everything exported is a wrapper on it.
 */
async function captureViews(requests: ShotRequest[]): Promise<Map<string, ShotResult>> {
  const results = new Map<string, ShotResult>();
  const first = requests[0];
  if (!first) return results;

  if (!(await apifyConfigured())) {
    const note = "No screenshot was taken — Apify is not connected. Add a token under Lead Sources → Connection.";
    for (const entry of requests) results.set(entry.key, none(note));
    return results;
  }

  const failAll = (note: string) => {
    for (const entry of requests) if (!results.has(entry.key)) results.set(entry.key, none(note));
    return results;
  };

  // The clock scales with the batch: twenty pages genuinely take longer than
  // one, and giving up early would throw away a run that has been paid for.
  const giveUpAfterMs = Math.min(600_000, 60_000 + requests.length * 20_000);

  const run = await runScreenshotActor(
    {
      // Every page carries its own viewport and its own crop, which is what
      // lets one run hold the laptop picture and the phone picture of the same
      // homepage. The run-level pair below is the same as the first page's:
      // the actor only reaches for it when a page did not bring one, and
      // nothing here depends on the two agreeing.
      urls: requests.map((entry) => ({
        id: entry.id,
        url: entry.url,
        viewport: { width: entry.viewportWidth, height: entry.viewportHeight },
        maxHeight: entry.keepRows,
      })),
      viewport: { width: first.viewportWidth, height: first.viewportHeight },
      fullPage: true,
      delayMs: DELAY_MS,
      maxWidth: MODEL_WIDTH,
      maxHeight: first.keepRows,
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

  // What one picture cost, which is the number worth knowing when pricing a
  // batch. Apify reports per run, so it is shared out across the pictures that
  // actually came back.
  const withImages = [...run.rows.values()].filter((row) => row.success).length;
  const perShot = run.costUsd != null && withImages > 0 ? run.costUsd / withImages : null;
  const takenAt = new Date().toISOString();

  for (const entry of requests) {
    // By id, and only by id. Nothing here looks at position, and a row that
    // did not come back is a page with no picture rather than a reason to
    // reach for the row next to it.
    const row = run.rows.get(entry.id);
    if (!row) {
      results.set(entry.key, none(`No screenshot came back for ${entry.url} — the run finished without producing a result for it.`));
      continue;
    }
    if (!row.success || !row.screenshotUrl) {
      results.set(entry.key, none(describeRowFailure(entry.url, row)));
      continue;
    }
    results.set(entry.key, await readShot(entry, row, takenAt, perShot));
  }

  return results;
}

/**
 * Screenshots for many businesses in one run.
 *
 * A single lead in the drawer still gets a run of its own, because a person is
 * watching; bulk work goes through here in groups of `MAX_BATCH`.
 */
export async function captureHomepages(websites: string[], options: ShotOptions = {}): Promise<Map<string, ShotResult>> {
  const results = new Map<string, ShotResult>();
  const shape = shapeOf(options);

  // Normalise first, so an unusable address costs nothing and says so. The id
  // is the position in this list: it is generated here, sent with the request
  // and matched on the way back, so it never has to be guessed at either end.
  const requests: ShotRequest[] = [];
  const seen = new Set<string>();
  for (const website of websites) {
    if (results.has(website) || seen.has(website)) continue;
    const url = normaliseSiteUrl(website);
    if (!url) {
      results.set(website, none(`"${website}" is not a web address this could open, so no screenshot was taken.`));
      continue;
    }
    seen.add(website);
    requests.push({ id: `s${requests.length}`, key: website, url, ...shape });
  }

  for (const [key, result] of await captureViews(requests)) results.set(key, result);
  return results;
}

/** One business. A person is waiting, so it gets a run of its own. */
export async function captureHomepage(website: string, options: ShotOptions = {}): Promise<ShotResult> {
  const results = await captureHomepages([website], options);
  return results.get(website) ?? none(`No screenshot was taken for ${website}.`);
}

/**
 * The laptop picture and the phone picture of one homepage, in **one** run.
 *
 * The audit needs both — a site that lays out correctly at 1280 and spills off
 * the screen at 390 passes every check except the one that matches where their
 * customers actually are — and taking them separately meant two runs, so two
 * container boots and two browser starts for two pictures of the same page.
 * The boot is nearly the whole cost of a screenshot, so this halves the price
 * of the shape this app runs most often.
 *
 * **Both are attempted whatever happens to the other**, which is a deliberate
 * reversal. Asking for the phone picture only when the laptop one had worked
 * was the right guard while the second picture meant a second run and a second
 * bill; inside one run it is one more page load against a browser that is
 * already open, and a site that serves one viewport and refuses another is a
 * real thing worth seeing. The caller decides what to say when both fail —
 * `audit/evidence.ts` prints one sentence rather than the same sentence twice.
 */
export async function captureHomepageViews(website: string): Promise<{ desktop: ShotResult; mobile: ShotResult }> {
  const url = normaliseSiteUrl(website);
  if (!url) {
    const note = `"${website}" is not a web address this could open, so no screenshot was taken.`;
    return { desktop: none(note), mobile: none(note) };
  }

  const results = await captureViews([
    { id: "desktop", key: "desktop", url, ...shapeOf({}) },
    { id: "mobile", key: "mobile", url, ...shapeOf({ viewportWidth: PHONE_VIEWPORT_WIDTH, keepRows: PHONE_KEEP_ROWS }) },
  ]);

  return {
    desktop: results.get("desktop") ?? none(`No screenshot was taken for ${website}.`),
    mobile: results.get("mobile") ?? none(`No phone screenshot was taken for ${website}.`),
  };
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
  // The actor sends the *reason* and this puts the frame round it. Both halves
  // saying "the page could not be opened" produced, on a real report,
  // "… the page could not be opened. The page could not be opened:
  // net::ERR_TIMED_OUT at https://…" — the same sentence twice with Chromium's
  // vocabulary after it.
  const said = row.error?.message?.trim();
  const because = said ? ` ${said[0]!.toLowerCase()}${said.slice(1)}` : "";
  switch (row.error?.code) {
    case "PAGE_TIMEOUT":
      return `No screenshot of ${url} — the page never finished loading, even after waiting for the document alone.`;
    case "NAVIGATION_ERROR":
      return `No screenshot of ${url} — the page could not be opened:${because || " no reason was given."}`;
    case "INVALID_URL":
      return `No screenshot of ${url} — it is not an address a browser could open.`;
    case "SCREENSHOT_FAILED":
    case "IMAGE_PROCESSING_FAILED":
      return `The page at ${url} opened but no usable picture came out of it:${because || " no reason was given."}`;
    case "BROWSER_LAUNCH_FAILED":
      return `No screenshot of ${url} — the screenshot service could not start a browser:${because || " no reason was given."}`;
    default:
      return `No screenshot came back for ${url}.${said ? ` ${said}` : ""}`;
  }
}

async function readShot(entry: ShotRequest, row: ScreenshotRow, takenAt: string, costUsd: number | null): Promise<ShotResult> {
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
      viewportWidth: entry.viewportWidth,
      width: size.width,
      height: size.height,
      cropped: row.cropped,
      insecure: row.insecure,
      partiallyLoaded: row.partiallyLoaded,
      // The uncut capture when there is one, so a person opening this sees the
      // whole page rather than the same crop the model was shown.
      imageUrl: row.fullScreenshotUrl ?? row.screenshotUrl!,
      mediaType: "image/png",
      bytes: sent.byteLength,
      costUsd,
    },
    base64: sent.toString("base64"),
    note:
      [
        row.cropped ? "Their homepage is longer than this; the picture is the top of the page, which is what a visitor sees first." : null,
        row.insecure
          ? "The picture was taken by going past a certificate warning, exactly as a visitor would — so what is in it came over an unverified connection."
          : null,
        row.partiallyLoaded
          ? "Their page never finished loading — something on it, often a third-party script or font, never answered — so this is the page as it had drawn itself by then."
          : null,
      ]
        .filter(Boolean)
        .join(" ") || null,
  };
}

/** Which actor is doing this, for anything that needs to say so. */
export { screenshotActorId };
