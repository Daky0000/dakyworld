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

/** Apify's own. FREE pricing model, so a run costs platform compute and nothing else. */
export const DEFAULT_SCREENSHOT_ACTOR = "apify/screenshot-url";

/**
 * What each key is called on the actors worth using, measured 19 Aug 2026.
 *
 * `apify/screenshot-url` is the shipped default: two million runs, Apify's own,
 * and free beyond compute — which batching makes very cheap, because one boot
 * covers every URL in the run.
 *
 * `i-scraper/website-screenshot` is the one to try if compute ever looks
 * expensive: $0.006 a screenshot flat, but it asks for **256MB** rather than
 * 2GB and blocks media by default, so a batch of twenty is both cheaper and
 * faster. It is the obvious swap, which is why its mapping is here rather than
 * being worked out under pressure later.
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
  put(profile.viewportHeightKey, Math.round(options.viewportWidth * 0.75), "viewport height");
  put(profile.formatKey, profile.png ?? "png", "PNG output");
  // "load" rather than networkidle: a page with a chat widget or an ad script
  // never goes idle, and waiting for it burns the whole timeout to produce the
  // same picture.
  put(profile.waitUntilKey, "load", "wait-until");
  put(profile.delayKey, options.delayMs, "delay");
  // The fold, not the whole page. A full-page shot of a long homepage is taller
  // than any vision model accepts and it is not what a first impression is.
  put(profile.fullPageKey, false, "above-the-fold only");

  for (const [key, value] of Object.entries(profile.extras ?? {})) put(key, value, key);

  // Whichever of the three spellings this one uses, from its own schema.
  if (schema?.proxyField) {
    input[schema.proxyField] = schema.proxyDefault ?? { useApifyProxy: true };
  } else if (!schema) {
    input.proxy = { useApifyProxy: true };
  }

  return { actorId, input, ignored, guessed: !schema };
}

/**
 * How much memory and how long to allow.
 *
 * Both are cost: a FREE-pricing actor is billed in compute units, which are
 * gigabyte-hours, so 2GB for a minute costs twice what 1GB for a minute does.
 * One page at a time does not need two gigabytes; a batch of twenty does,
 * because the actor keeps several browser contexts open at once.
 */
export function runOptionsFor(count: number): { memoryMbytes: number; timeoutSecs: number } {
  return {
    memoryMbytes: count > 4 ? 2048 : 1024,
    // Enough for the boot plus a page each, with headroom, and capped so one
    // stuck site cannot hold a run open for an hour.
    timeoutSecs: Math.min(600, 90 + count * 20),
  };
}
