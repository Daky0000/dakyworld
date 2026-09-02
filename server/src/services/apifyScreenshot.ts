import { SETTING, getSetting } from "../lib/settings.js";
import { apifyConfigured, findActor, getApifyToken } from "../lib/apify.js";
import { runActor, type ActorRunCode } from "./actorRun.js";

/**
 * Talking to the Dakyworld screenshot actor.
 *
 * This file is the whole of what the server knows about taking a picture:
 * which actor, what the body looks like, and how to read the rows back. It is
 * about a fifth of what it replaced, and the reason is that the actor is ours
 * now.
 *
 * What used to be here: a table of what four strangers' actors each called a
 * viewport (`viewportWidth`, `window_Width`, `width`), a live read of the
 * chosen actor's published input schema, a six-hour cache of that schema, a
 * translation layer that dropped any key the actor did not declare, and a
 * fallback profile for an actor nobody had mapped. All of it existed for one
 * reason — Apify ignores an unknown input key in silence, so guessing produces
 * a perfectly successful run at the wrong size with nothing anywhere saying
 * so. With one actor that Dakyworld writes, there is nothing to guess.
 *
 * ## The contract
 *
 * Mirrored from `apify/dakyworld-screenshot/src/contract.ts`. The two are
 * deployed separately and neither can import from the other, so a change to
 * one is a change to both in the same commit.
 *
 * ## The id is a safeguard, not a convenience
 *
 * Every request carries an id and every row carries it back. The
 * implementation this replaced matched rows to requests by looking for the
 * address inside the row and, failing that, by position — so one page failing
 * part-way through a batch shifted every picture after it onto the wrong
 * business. A picture attached to the wrong business is a page carrying
 * somebody's name that is not theirs.
 */

/**
 * Dakyworld's own actor.
 *
 * **`daky_world`, with the underscore.** That is the Apify account this
 * company's token belongs to, and it was not a guess: the first automatic
 * deploy shipped as `dakyworld`, Apify created the actor under the account the
 * token actually names, and the mismatch guard in `screenshotActorDeploy.ts`
 * stopped and said so rather than leaving a working actor under a name nothing
 * would ever call. The username half of an actor id is not ours to choose.
 *
 * A different deployment on a different account sets `capture.screenshotActor`
 * (Settings → Lead Sources) to `<account>/website-screenshot` rather than
 * editing this — the setting exists precisely so pointing at another copy is
 * not a deploy.
 */
export const DEFAULT_SCREENSHOT_ACTOR = "daky_world/website-screenshot";

/**
 * Which version of the actor's source this app expects Apify to be running.
 *
 * **Bump it in the same commit as any change under
 * `apify/dakyworld-screenshot/src/`.** Apify holds whatever was last built and
 * nothing on an actor's record says which version of our source that was, so
 * this is the only thing that can tell *deployed* from *up to date*. Without
 * it a fixed actor stays broken on Apify for ever, because the boot pass only
 * ever built one that was **missing** — while rebuilding on every deploy would
 * spend an Apify build each time anybody pushed anything at all.
 *
 * The number is arbitrary and only ever compared with itself.
 *
 *  1. The first actor: id-matched rows, Sharp cropping, the proxy, the deadline.
 *  2. Per-page viewports, the certificate retry, plain-English network errors,
 *     the `domcontentloaded` rung with `window.stop()`, and a direct retry on a
 *     connection timeout.
 */
export const ACTOR_SOURCE_VERSION = 2;

/** Which actor takes the screenshots — the shipped one unless the Owner moved it. */
export async function screenshotActorId(): Promise<string> {
  const configured = (await getSetting(SETTING.SCREENSHOT_ACTOR))?.trim();
  return configured || DEFAULT_SCREENSHOT_ACTOR;
}

export interface ScreenshotRequest {
  /** The caller's own name for this page. Comes back unchanged. */
  id: string;
  url: string;
  /**
   * This page's own viewport, overriding the run's.
   *
   * It exists for the shape the audit actually asks for: a laptop picture and
   * a phone picture of the same homepage. With one viewport per run that is
   * two runs, and the boot — which is nearly the whole cost — gets paid twice
   * for two pictures.
   */
  viewport?: { width: number; height: number };
  /** This page's own crop, overriding the run's. A phone page is taller. */
  maxHeight?: number;
}

/** Why one page produced no picture. The actor's half of the vocabulary. */
export type ScreenshotErrorCode =
  | "INVALID_URL"
  | "PAGE_TIMEOUT"
  | "NAVIGATION_ERROR"
  | "SCREENSHOT_FAILED"
  | "IMAGE_PROCESSING_FAILED"
  | "BROWSER_LAUNCH_FAILED";

export interface ScreenshotRow {
  id: string;
  url: string;
  finalUrl: string | null;
  success: boolean;
  /** The processed picture — cropped and resized, and what a model should read. */
  screenshotUrl: string | null;
  /** The capture before that, when it is a different picture. */
  fullScreenshotUrl: string | null;
  width: number | null;
  height: number | null;
  fullWidth: number | null;
  fullHeight: number | null;
  cropped: boolean;
  /** True when the page would only open with certificate verification off. */
  insecure: boolean;
  /** True when the page never finished loading and the picture is what had rendered. */
  partiallyLoaded: boolean;
  viewportWidth: number;
  viewportHeight: number;
  format: string;
  durationMs: number | null;
  error: { code: ScreenshotErrorCode | string; message: string } | null;
}

export interface ScreenshotJob {
  urls: ScreenshotRequest[];
  viewport: { width: number; height: number };
  fullPage: boolean;
  delayMs: number;
  /** Resize the finished picture down to this width. Never up. */
  maxWidth?: number;
  /** Rows to keep from the top, measured in captured pixels, before the resize. */
  maxHeight?: number;
}

export interface ScreenshotRunSuccess {
  ok: true;
  actorId: string;
  runId: string;
  /** Keyed by the id that was sent. A request with no row is absent, not null. */
  rows: Map<string, ScreenshotRow>;
  /** What Apify billed for the whole run. Null is "not reported", never "free". */
  costUsd: number | null;
}

export interface ScreenshotRunFailure {
  ok: false;
  actorId: string;
  code: ActorRunCode;
  /** One sentence, safe to show a person. Never carries a credential. */
  message: string;
  costUsd: number | null;
}

export type ScreenshotRunResult = ScreenshotRunSuccess | ScreenshotRunFailure;

/**
 * How much memory and how long to allow.
 *
 * Both are guesses from the batch size and both used to be clamped to whatever
 * band the chosen stranger's actor declared, because asking a 256MB actor for
 * 2GB is a run Apify refuses outright. Ours declares no band, so the numbers
 * are simply the numbers: a browser wants a gigabyte, a batch big enough to
 * run several pages wants two, and the clock has to cover a boot plus a page
 * each with headroom.
 *
 * The actor works to the same clock from the inside — it reads Apify's timeout
 * and writes a timed-out row for anything it has not reached — so a batch that
 * overruns comes back with the pictures it did take instead of a run Apify
 * kills and rows nobody reads.
 */
function runOptionsFor(count: number): { memoryMbytes: number; timeoutSecs: number } {
  return {
    memoryMbytes: count > 4 ? 2048 : 1024,
    timeoutSecs: Math.min(600, 90 + count * 20),
  };
}

/**
 * Runs the actor once and hands back a row per requested id.
 *
 * It does not throw. Every failure is a value with a code, because each one
 * needs a different sentence said about it and an exception makes that a
 * `catch` with a string match in it.
 */
export async function runScreenshotActor(job: ScreenshotJob, options: { waitMs: number }): Promise<ScreenshotRunResult> {
  const actorId = await screenshotActorId();

  // The whole body. Four fields the caller decides and two that describe the
  // picture the vision model is going to be sent; no compatibility keys, no
  // schema lookup, nothing conditional.
  const input = {
    urls: job.urls.map((entry) => ({
      id: entry.id,
      url: entry.url,
      ...(entry.viewport ? { viewport: entry.viewport } : {}),
      ...(entry.maxHeight ? { maxHeight: entry.maxHeight } : {}),
    })),
    viewport: job.viewport,
    fullPage: job.fullPage,
    delay: job.delayMs,
    ...(job.maxWidth ? { maxWidth: job.maxWidth } : {}),
    ...(job.maxHeight ? { maxHeight: job.maxHeight } : {}),
  };

  const result = await runActor(actorId, input, {
    ...runOptionsFor(job.urls.length),
    waitMs: options.waitMs,
    // One row per URL is the contract; the headroom is for a version of the
    // actor that ever writes more than that, so a batch is never half-read.
    maxItemsRead: Math.max(10, job.urls.length * 2),
  });

  if (!result.ok) {
    return { ok: false, actorId, code: result.code, message: describeRunFailure(result.code, result.message, actorId), costUsd: result.costUsd };
  }

  const rows = new Map<string, ScreenshotRow>();
  for (const item of result.items) {
    const row = readRow(item);
    // A row with no id cannot be matched to anything, and guessing which
    // request it belongs to is the exact defect the id was introduced to end.
    if (row) rows.set(row.id, row);
  }

  /**
   * A run that produced rows, none of which this can read, is one signature and
   * only one: the actor is not ours.
   *
   * `capture.screenshotActor` exists so a deployment on a different Apify
   * account can name its own copy — and it looks exactly like the setting it
   * used to be, which was a choice between four actors on the store. Somebody
   * reading the Settings screen may well still put one of those in it, and
   * Apify will happily run it: it ignores every input key it does not declare,
   * so `urls: [{ id, url }]` and a `viewport` object are silently dropped and
   * what comes back is a dataset in that actor's own shape with no `id` on any
   * row.
   *
   * Without this, every page in the batch gets "the run finished without
   * producing a result for it" — true, useless, and pointing at the website
   * rather than at the setting that caused it. There is no adapter behind this
   * message on purpose: one actor and one contract is the whole point, and the
   * answer to a foreign actor is to stop using it, not to translate for it.
   */
  if (rows.size === 0 && result.items.length > 0) {
    return {
      ok: false,
      actorId,
      code: "ACTOR_FAILED",
      message:
        `The run finished, but not one of its ${result.items.length} result(s) carried an id — so "${actorId}" is not the Dakyworld ` +
        `screenshot actor. Only that actor speaks this app's screenshot contract; an actor from the Apify store cannot be substituted for it. ` +
        `Deploy it from apify/dakyworld-screenshot in this repository, or set Settings → Lead Sources → Screenshot actor back to a copy of it.`,
      costUsd: result.costUsd,
    };
  }

  return { ok: true, actorId, runId: result.runId, rows, costUsd: result.costUsd };
}

/**
 * A dataset row, read defensively.
 *
 * The actor writes this shape, but the actor is deployed separately from the
 * server and can be a version behind it. A row that has drifted should read as
 * a page with no picture — which every caller already handles — rather than as
 * a picture with `undefined` for its width.
 */
function readRow(item: Record<string, unknown>): ScreenshotRow | null {
  const id = typeof item.id === "string" && item.id ? item.id : null;
  if (!id) return null;

  const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const error = item.error as { code?: unknown; message?: unknown } | null | undefined;

  const screenshotUrl = text(item.screenshotUrl);
  return {
    id,
    url: text(item.url) ?? "",
    finalUrl: text(item.finalUrl),
    // Trusting the picture over the flag: a row claiming success with no image
    // is a row the caller must not treat as a screenshot.
    success: item.success === true && Boolean(screenshotUrl),
    screenshotUrl,
    fullScreenshotUrl: text(item.fullScreenshotUrl),
    width: num(item.width),
    height: num(item.height),
    fullWidth: num(item.fullWidth),
    fullHeight: num(item.fullHeight),
    cropped: item.cropped === true,
    insecure: item.insecure === true,
    partiallyLoaded: item.partiallyLoaded === true,
    viewportWidth: num(item.viewportWidth) ?? 0,
    viewportHeight: num(item.viewportHeight) ?? 0,
    format: text(item.format) ?? "png",
    durationMs: num(item.durationMs),
    error:
      error && typeof error === "object"
        ? { code: text(error.code) ?? "SCREENSHOT_FAILED", message: text(error.message) ?? "No reason was given." }
        : null,
  };
}

/**
 * The one failure worth rewording.
 *
 * Everything else `runActor` says is already a sentence for a person. An actor
 * that is not on the account is different: it is a setting somebody can fix in
 * a minute, and Apify's own words for it ("Actor was not found") read as an
 * outage. See the rule in `lib/errors.ts` — a fixable setting must never reach
 * the Owner as "something went wrong".
 */
function describeRunFailure(code: ActorRunCode, message: string, actorId: string): string {
  if (code === "ACTOR_START_FAILED" && /not found|404|does not exist/i.test(message)) {
    return (
      `The screenshot actor "${actorId}" is not on this Apify account. Deploy it from apify/dakyworld-screenshot in this repository, ` +
      `or point Settings → Lead Sources → Screenshot actor at the copy that exists.`
    );
  }
  return message;
}

/**
 * Is the screenshot actor actually on this Apify account?
 *
 * Said at boot, because the alternative is that nobody finds out until the
 * first audit of the day comes back with no picture and a sentence nobody was
 * looking at. The actor is deployed separately from this server — `apify push`
 * from `apify/dakyworld-screenshot/` — so a perfectly good deploy of the app
 * can sit in front of an account that has never had the actor pushed to it,
 * and every screenshot fails for a reason that is five minutes' work.
 *
 * Costs one free, read-only request, and only when a token exists. Null means
 * "no token, so there is nothing to say" — which is a different state from
 * "the actor is missing", and conflating the two would put a deploy warning in
 * front of every developer who has not connected Apify.
 */
export async function screenshotActorReady(): Promise<
  { actorId: string; ready: boolean; exists: boolean; upToDate: boolean } | null
> {
  if (!(await apifyConfigured())) return null;
  const actorId = await screenshotActorId();
  // What was last built out of this repository, if anything. *Deployed* and
  // *up to date* are different questions, and only the second one keeps a fix
  // from sitting in git while Apify runs the version that was broken.
  const built = await getSetting(SETTING.SCREENSHOT_ACTOR_BUILT).catch(() => null);
  // Present **and built**. An actor whose creation succeeded and whose build
  // failed exists, answers `GET /acts/:id` perfectly happily, and cannot be run
  // — so "the actor is there" is not the question. This one caught it: the
  // deploy pass skipped an unbuilt actor as already done, and the boot check
  // called it ready, which between them would have left a permanently broken
  // account looking healthy.
  const actor = await findActor(actorId).catch(() => null);
  // `exists` and `ready` are different questions and the caller needs both: an
  // actor that was created and never built is half done, and telling somebody
  // it is "not on this account" sends them looking in the wrong place.
  return {
    actorId,
    exists: Boolean(actor),
    ready: Boolean(actor?.hasBuild),
    upToDate: built === `${ACTOR_SOURCE_VERSION}:${actorId}`,
  };
}

/**
 * Downloads a picture the actor stored.
 *
 * The key-value store record of a run is normally readable without a token,
 * which is why this was a bare `fetch` for as long as the actor was somebody
 * else's public one. Ours is private, and a private account's store can refuse
 * an anonymous read — so a 401 or 403 is retried with the token rather than
 * reported as a missing picture, which is a failure that would look exactly
 * like a website blocking us.
 */
export async function downloadScreenshot(url: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; message: string }> {
  const attempt = async (token: string | null) => {
    const response = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    return response;
  };

  try {
    let response = await attempt(null);
    if (response.status === 401 || response.status === 403) {
      const token = await getApifyToken().catch(() => null);
      if (token) response = await attempt(token);
    }
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
    return { ok: true, bytes: Buffer.from(await response.arrayBuffer()) };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
