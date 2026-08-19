import { SETTING, getSetting } from "../lib/settings.js";
import { getActorSchema, normalizeActorId, displayActorId } from "../lib/apify.js";

/**
 * Which actor takes the screenshots, and how to talk to it.
 *
 * Every screenshot actor on Apify does the same job and none of them agree on
 * the input. One takes `urls`, another `link_urls`; one calls the viewport
 * `viewportWidth`, another `window_Width`, another just `width`; the proxy
 * arrives under `proxy`, `proxyConfig` or `proxyConfiguration` depending on
 * who wrote it. So the choice of actor cannot be a constant in the middle of
 * `siteShot.ts` — swapping one for a cheaper one would be a code change and a
 * deploy, which is exactly the thing `capture.actors` already exists to avoid
 * for the capture actors.
 *
 * Two rules, both inherited from that older decision:
 *
 *  - **Only ever send a key the actor declares.** A misspelt or unknown input
 *    key is not an error on Apify — it is silently ignored, and the run comes
 *    back with a desktop-width screenshot when you asked for a phone. The
 *    actor's own published schema decides what goes in the body.
 *  - **Never hard-code the price.** `getActorPricing` reads it live, and what
 *    a run actually cost comes back from `runCost`. A stale number inside a
 *    spending guard fails silently.
 */

/**
 * $0.006 a screenshot, flat, and nothing for the compute underneath it.
 *
 * Chosen over `apify/screenshot-url` (Apify's own, free beyond compute) on
 * 19 Aug 2026. The two are close and which one wins depends on the batch: this
 * app usually takes **two** pictures of one homepage — desktop and phone, in
 * two separate runs — and a boot at 2GB dwarfs a pair of flat fees. It loses on
 * a batch of twenty, where one boot is spread across forty pictures. If lead
 * capture ever runs big batches through here, re-price before assuming.
 */
export const DEFAULT_SCREENSHOT_ACTOR = "i-scraper/website-screenshot";

/**
 * What each key is called on the actors worth using, measured 19 Aug 2026.
 *
 * `i-scraper/website-screenshot` is the shipped default: $0.006 a picture,
 * 256MB, media blocked by default. It is the only one here that takes a
 * viewport *height*, which is why `ScreenshotOptions` carries one — see the
 * note on `fullPage` below.
 *
 * `apify/screenshot-url` is Apify's own and the previous default: two million
 * runs, free beyond compute, and always full-page. It has no `fullPage` and no
 * viewport height at all, so those keys are simply never sent to it.
 */
interface ActorProfile {
  /** The key holding the list of pages. */
  urlsKey: string;
  /** True when each entry is `{ url }` rather than a bare string. */
  urlsAsObjects: boolean;
  viewportWidthKey?: string;
  viewportHeightKey?: string;
  formatKey?: string;
  /** What this actor calls PNG, when it takes a format at all. */
  png?: string;
  waitUntilKey?: string;
  delayKey?: string;
  fullPageKey?: string;
  /** Extra keys worth setting for cost or speed, if the actor declares them. */
  extras?: Record<string, unknown>;
}

const PROFILES: Record<string, ActorProfile> = {
  "apify/screenshot-url": {
    urlsKey: "urls",
    urlsAsObjects: true,
    viewportWidthKey: "viewportWidth",
    formatKey: "format",
    png: "png",
    waitUntilKey: "waitUntil",
    delayKey: "delay",
    extras: { scrollToBottom: false },
  },
  "i-scraper/website-screenshot": {
    urlsKey: "urls",
    urlsAsObjects: false,
    viewportWidthKey: "viewportWidth",
    viewportHeightKey: "viewportHeight",
    formatKey: "format",
    png: "png",
    waitUntilKey: "waitUntil",
    delayKey: "delay",
    fullPageKey: "fullPage",
    // Video and audio on a homepage are megabytes we pay to download and then
    // never look at — the screenshot is taken before most of it would play.
    extras: { blockResources: ["media"], waitForImages: true },
  },
  "room_js/url-screenshot-generator": {
    urlsKey: "urls",
    urlsAsObjects: false,
    viewportWidthKey: "width",
    viewportHeightKey: "height",
    formatKey: "format",
    png: "png",
    waitUntilKey: "waitUntil",
    delayKey: "delay",
    extras: { timeout: 30_000 },
  },
  "dz_omar/screenshot": {
    urlsKey: "link_urls",
    urlsAsObjects: true,
    viewportWidthKey: "window_Width",
    viewportHeightKey: "window_Height",
    waitUntilKey: "waitUntil",
    fullPageKey: "fullPage",
  },
};

/**
 * The actors whose input this app knows how to speak. Anything else still
 * works — the generic profile plus the actor's own schema covers most of
 * them — but these are the ones somebody has checked.
 */
export const KNOWN_SCREENSHOT_ACTORS = Object.keys(PROFILES);

/** A profile for an actor nobody has mapped: the keys most of them use. */
const GENERIC: ActorProfile = {
  urlsKey: "urls",
  urlsAsObjects: true,
  viewportWidthKey: "viewportWidth",
  formatKey: "format",
  png: "png",
  waitUntilKey: "waitUntil",
  delayKey: "delay",
};

/** Which actor is configured, or the shipped default. */
export async function screenshotActorId(): Promise<string> {
  const configured = (await getSetting(SETTING.SCREENSHOT_ACTOR))?.trim();
  return configured || DEFAULT_SCREENSHOT_ACTOR;
}

export interface ScreenshotOptions {
  viewportWidth: number;
  /**
   * The browser window height, for the actors that take one.
   *
   * It is not a crop — `fullPage` is on and `cropPngTop` does the cutting — but
   * it decides what the page thinks it is being viewed on, which changes what
   * lazy-loading brings in and where a sticky header sits. It must be a real
   * device height: deriving it from the width (the first version used three
   * quarters) gives a phone a 293px-tall window, which is not a shape any site
   * has been designed against.
   */
  viewportHeight: number;
  /** Milliseconds to wait after load, for fonts and a hero image to arrive. */
  delayMs: number;
}

export interface BuiltInput {
  actorId: string;
  input: Record<string, unknown>;
  /** What was asked for but the actor does not declare, for the run's notes. */
  ignored: string[];
  /** True when the actor's schema could not be read and the guess was used. */
  guessed: boolean;
}

/**
 * The run body for however many pages, built against the actor's own schema.
 *
 * A key the actor does not declare is dropped rather than sent. That is not
 * politeness: Apify ignores unknown keys silently, so sending `viewportWidth`
 * to an actor that calls it `window_Width` produces a perfectly successful run
 * at the wrong size, and nothing anywhere says so.
 */
export async function buildScreenshotInput(urls: string[], options: ScreenshotOptions): Promise<BuiltInput> {
  const actorId = await screenshotActorId();
  const profile = PROFILES[displayActorId(normalizeActorId(actorId))] ?? GENERIC;
  const schema = await getActorSchema(actorId);
  const declared = schema ? new Set(schema.properties) : null;

  const ignored: string[] = [];
  const input: Record<string, unknown> = {};

  const put = (key: string | undefined, value: unknown, label: string) => {
    if (!key) return;
    if (declared && !declared.has(key)) {
      ignored.push(`${label} (this actor has no "${key}")`);
      return;
    }
    input[key] = value;
  };

  input[profile.urlsKey] = profile.urlsAsObjects ? urls.map((url) => ({ url })) : urls;

  put(profile.viewportWidthKey, options.viewportWidth, "viewport width");
  put(profile.viewportHeightKey, options.viewportHeight, "viewport height");
  put(profile.formatKey, profile.png ?? "png", "PNG output");
  // "load" rather than networkidle: a page with a chat widget or an ad script
  // never goes idle, and waiting for it burns the whole timeout to produce the
  // same picture.
  put(profile.waitUntilKey, "load", "wait-until");
  put(profile.delayKey, options.delayMs, "delay");
  // The whole page, then cut down here rather than at the browser.
  //
  // `cropPngTop` keeps 2400 rows — the fold plus what the first scroll reveals,
  // which is what a first impression is made of, and more than one viewport.
  // Asking the actor for a single viewport instead would silently shorten every
  // picture to the window height: on a phone that is one screen where the
  // reviewer expects two and a half. `apify/screenshot-url`, the previous
  // default, has no such key and is always full-page — this keeps the same
  // image arriving whichever actor is configured.
  put(profile.fullPageKey, true, "full-page capture");

  for (const [key, value] of Object.entries(profile.extras ?? {})) put(key, value, key);

  // Whichever of the three spellings this one uses, from its own schema — and
  // the proxy is turned on whatever the actor's own default says. A datacentre
  // IP with no proxy in front of it is refused by a good share of small
  // business sites behind Cloudflare, and "their site blocks automated
  // browsers" is indistinguishable from "their site is down" in the report
  // that comes out. Anything else in the actor's default (proxy groups, a
  // country) is kept.
  if (schema?.proxyField) {
    input[schema.proxyField] = { ...(schema.proxyDefault ?? {}), useApifyProxy: true };
  } else if (!schema) {
    input.proxy = { useApifyProxy: true };
  }

  return { actorId, input, ignored, guessed: !schema };
}

/**
 * How much memory and how long to allow, inside what the actor will accept.
 *
 * Memory is cost on a FREE-pricing actor — billed in gigabyte-hours, so 2GB for
 * a minute costs twice what 1GB does — and on a pay-per-picture actor it is
 * not cost at all, just a slice of the account's concurrent budget. Either way
 * the number this app *wants* is a guess from the batch size, and the actor's
 * own build is the only thing that knows what it can run in.
 *
 * So the guess is clamped to the declared band. `i-scraper/website-screenshot`
 * declares 512–2048MB while its own default run option says 256MB, which is
 * below its floor: over the ceiling Apify rejects the run outright, and under
 * the floor it dies part-way through. Neither is a failure worth having when
 * the actor published both numbers.
 */
export async function runOptionsFor(count: number, actorId?: string): Promise<{ memoryMbytes: number; timeoutSecs: number }> {
  const wanted = count > 4 ? 2048 : 1024;
  const schema = await getActorSchema(actorId ?? (await screenshotActorId())).catch(() => null);
  const floor = schema?.minMemoryMbytes ?? 256;
  const ceiling = schema?.maxMemoryMbytes ?? 4096;

  return {
    memoryMbytes: Math.min(Math.max(wanted, floor), Math.max(floor, ceiling)),
    // Enough for the boot plus a page each, with headroom, and capped so one
    // stuck site cannot hold a run open for an hour.
    timeoutSecs: Math.min(600, 90 + count * 20),
  };
}
