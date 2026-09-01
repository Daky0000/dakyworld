import { apifyConfigured } from "../lib/apify.js";
import { runActor } from "./actorRun.js";
import { cropPngTop, downscalePng, pngSize } from "./png.js";
import { buildScreenshotInput, runOptionsFor, screenshotActorId } from "./screenshotActors.js";

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

/** A desktop viewport. Wide enough that a responsive site shows its real layout. */
const VIEWPORT_WIDTH = 1280;

/**
 * The window heights that go with the two widths.
 *
 * A real laptop and a real iPhone 14. The picture is taken full-page and cut to
 * `keepRows` afterwards, so this is not what decides how much page comes back —
 * it is what the page is told it is being viewed on, which decides where a
 * sticky header sits and how much a lazy-loading gallery brings in before the
 * shutter. Only some actors take it; the rest use their own.
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

  // Normalise first, so an unusable address costs nothing and says so.
  const wanted: { requested: string; url: string }[] = [];
  for (const website of websites) {
    const url = normaliseSiteUrl(website);
    if (!url) {
      results.set(website, none(`"${website}" is not a web address this could open, so no screenshot was taken.`));
      continue;
    }
    wanted.push({ requested: website, url });
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

  const built = await buildScreenshotInput(
    wanted.map((entry) => entry.url),
    { viewportWidth, viewportHeight, delayMs: 3000 },
  );

  // The clock scales with the batch: twenty pages genuinely take longer than
  // one, and giving up early would throw away a run that has been paid for.
  const giveUpAfterMs = Math.min(600_000, 60_000 + wanted.length * 20_000);

  // Start, poll and read are `services/actorRun.ts` rather than a loop here.
  // The loop that used to be in this function treated `ABORTING` and
  // `TIMING-OUT` as finished — they are not terminal — so a run being killed
  // was reported as a run that failed for no stated reason. Every message
  // below is the one this function has always produced; only the machinery
  // underneath them is now shared with the capture tools.
  const result = await runActor(built.actorId, built.input, {
    ...(await runOptionsFor(wanted.length, built.actorId)),
    waitMs: giveUpAfterMs,
    maxItemsRead: Math.max(10, wanted.length * 2),
  });

  if (!result.ok) {
    switch (result.code) {
      case "APIFY_NOT_CONFIGURED":
      case "APIFY_AUTH_ERROR":
        return failAll(result.message);
      case "STILL_RUNNING":
        return failAll(`No screenshot was taken — the run was still going after ${Math.round(giveUpAfterMs / 1000)} seconds.`);
      case "APIFY_UNREACHABLE":
        return failAll(`No screenshot was taken — Apify stopped answering: ${result.message}`);
      case "DATASET_RETRIEVAL_FAILED":
        return failAll(`The screenshots were taken but could not be read back: ${result.message}`);
      case "ACTOR_FAILED":
      case "ACTOR_ABORTED":
      case "ACTOR_TIMEOUT":
        return failAll(
          `No screenshot was taken — the run ${(result.status ?? "failed").toLowerCase()}. Their site may block automated browsers.`,
        );
      default:
        return failAll(`No screenshot was taken — Apify would not start the run: ${result.message}`);
    }
  }

  const items = result.items;
  // What one page cost, which is the number worth knowing when choosing an
  // actor. Apify reports per run, so it is shared out across the pictures that
  // actually came back.
  const withImages = items.filter((row) => typeof row.screenshotUrl === "string").length;
  const perShot = result.costUsd != null && withImages > 0 ? result.costUsd / withImages : null;

  for (const [index, entry] of wanted.entries()) {
    const item = matchItem(items, entry.url, index, wanted.length);
    const imageUrl = item?.screenshotUrl as string | undefined;
    if (!imageUrl) {
      // Some actors say why in the row itself rather than failing the run.
      // Carrying that sentence through is the difference between "no picture"
      // and "their site timed out after 30 seconds".
      const said = typeof item?.error === "string" && item.error.trim() ? ` ${item.error.trim()}` : "";
      results.set(entry.requested, none(`No screenshot came back for ${entry.url} — the run finished without producing an image for it.${said}`));
      continue;
    }
    results.set(entry.requested, await readShot(entry, item!, imageUrl, new Date().toISOString(), perShot, built, viewportWidth, keepRows));
  }

  return results;
}

/**
 * Which dataset row belongs to which request.
 *
 * By `startUrl` first, because that is the address we asked for and it survives
 * a redirect. Then by final URL. Position is the last resort: actors generally
 * preserve input order, but a run where one page failed shifts everything after
 * it, so matching on position alone would quietly attach the wrong picture to
 * the wrong business — which on a page carrying somebody's name is not a
 * cosmetic mistake.
 */
function matchItem(
  items: Record<string, unknown>[],
  url: string,
  index: number,
  wantedCount: number,
): Record<string, unknown> | null {
  const same = (value: unknown) => typeof value === "string" && (value === url || value.replace(/\/$/, "") === url.replace(/\/$/, ""));

  const byStart = items.find((row) => same(row.startUrl));
  if (byStart) return byStart;
  const byFinal = items.find((row) => same(row.url));
  if (byFinal) return byFinal;

  // Some actors return the picture and nothing else — no startUrl, no url. For
  // those, position is all there is, and it is only safe when every page came
  // back: one failure part-way through a batch shifts the rest, and a picture
  // attached to the wrong business is a page carrying somebody's name that is
  // not theirs. So this insists the counts line up exactly.
  const anyAddress = items.some((row) => typeof row.startUrl === "string" || typeof row.url === "string");
  if (!anyAddress && items.length === wantedCount) return items[index] ?? null;

  return null;
}

async function readShot(
  entry: { requested: string; url: string },
  item: Record<string, unknown>,
  imageUrl: string,
  finishedAt: string | null,
  costUsd: number | null,
  built: { actorId: string; ignored: string[]; guessed: boolean },
  viewportWidth: number,
  keepRows: number,
): Promise<ShotResult> {
  let raw: Buffer;
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return none(`The screenshot of ${entry.url} could not be downloaded (HTTP ${response.status}).`);
    raw = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    return none(`The screenshot of ${entry.url} could not be downloaded: ${(err as Error).message}`);
  }

  const original = pngSize(raw);
  // Crop first, then shrink: cropping is what removes the footer nobody is
  // judging, and shrinking a 12,000px page before cutting it would waste the
  // work on rows about to be thrown away.
  const cropped = cropPngTop(raw, keepRows) ?? raw;
  // Never *up*-scale: a 390px-wide phone shot blown up to 1024 is the same
  // picture with softer edges and three times the tiles to pay for.
  const sent = (original && original.width > MODEL_WIDTH ? downscalePng(cropped, MODEL_WIDTH) : null) ?? cropped;
  const size = pngSize(sent);
  const wasCropped = Boolean(original && size && original.height > keepRows);

  if (!size || size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE) {
    return none(`The screenshot of ${entry.url} came back in a shape no model will read, so the look at their homepage was skipped.`);
  }
  if (sent.byteLength > MAX_IMAGE_BYTES) {
    return none(`The screenshot of ${entry.url} is ${(sent.byteLength / 1_000_000).toFixed(1)}MB, past what a model will accept, so it was skipped.`);
  }

  const notes = [
    wasCropped ? `Their homepage is longer than this; the picture is the top of the page, which is what a visitor sees first.` : null,
    built.guessed ? `The screenshot actor (${built.actorId}) publishes no input schema, so its settings were guessed.` : null,
    built.ignored.length ? `${built.actorId} ignored: ${built.ignored.join("; ")}.` : null,
  ].filter(Boolean);

  return {
    shot: {
      requested: entry.url,
      finalUrl: typeof item.url === "string" ? item.url : null,
      takenAt: finishedAt ?? new Date().toISOString(),
      viewportWidth,
      width: size.width,
      height: size.height,
      cropped: wasCropped,
      imageUrl,
      mediaType: "image/png",
      bytes: sent.byteLength,
      costUsd,
    },
    base64: sent.toString("base64"),
    note: notes.length ? notes.join(" ") : null,
  };
}

/** One business. A person is waiting, so it gets a run of its own. */
export async function captureHomepage(website: string, options: ShotOptions = {}): Promise<ShotResult> {
  const results = await captureHomepages([website], options);
  return results.get(website) ?? none(`No screenshot was taken for ${website}.`);
}

/** Which actor is doing this, for anything that needs to say so. */
export { screenshotActorId };
