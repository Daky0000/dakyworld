import { Actor, log } from "apify";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import type { ScreenshotResult } from "./contract.js";
import { InvalidInputError, parseInput } from "./input.js";
import { processScreenshot } from "./image.js";
import { capturePage } from "./screenshot.js";

/**
 * The Dakyworld screenshot actor.
 *
 * One actor, owned by us, replacing four strangers' actors and the layer of
 * translation the server needed to speak to any of them. What the server sends
 * is now a viewport rather than a guess at what this particular actor calls a
 * viewport, and what comes back is one row per request carrying the id the
 * request arrived with.
 *
 * Three promises this file keeps, in the order they matter:
 *
 *  1. **Every requested URL gets exactly one row.** A page that fails, a page
 *     that is not a URL at all, a page there was no time left to open — each
 *     produces a row with a code on it. Nothing is silently dropped, because a
 *     caller matching rows to businesses can only be safe if the two lists are
 *     the same length and carry the same ids.
 *  2. **One broken site costs one picture.** Every page is opened in its own
 *     browser context inside a `try`, and the browser outlives all of them.
 *  3. **The run ends before Apify ends it.** A run Apify times out is a run
 *     whose rows the caller never reads, so the pages are worked through
 *     against a deadline and whatever is left when time runs short is written
 *     as a timed-out row rather than attempted and lost.
 */

await Actor.init();

/** Leave time to write the last rows and close the browser cleanly. */
const SHUTDOWN_MARGIN_MS = 15_000;
/** Below this there is no point starting a page — it cannot finish. */
const MINIMUM_PAGE_MS = 8_000;

try {
  const input = parseInput(await Actor.getInput());
  log.info(
    `Screenshotting ${input.urls.length} page(s) at ${input.viewport.width}x${input.viewport.height}` +
      `${input.fullPage ? ", full page" : ""}, ${input.delay}ms delay.`,
  );

  const store = await Actor.openKeyValueStore();

  /**
   * The proxy is the actor's business, not the caller's.
   *
   * Forced on, whatever a run's own input says, because a datacentre IP with
   * no proxy in front of it is refused by a good share of small-business sites
   * behind Cloudflare — and "their site blocks automated browsers" is
   * indistinguishable from "their site is down" in the report that comes out.
   * An account with no proxy on it gets null back and goes direct, which is
   * worse than a proxy and much better than a run that refuses to start.
   */
  const proxyConfiguration = await Actor.createProxyConfiguration({
    useApifyProxy: true,
    ...(input.proxy?.apifyProxyGroups ? { groups: input.proxy.apifyProxyGroups } : {}),
    ...(input.proxy?.apifyProxyCountry ? { countryCode: input.proxy.apifyProxyCountry } : {}),
  }).catch((err) => {
    log.warning(`No Apify proxy on this account, going direct: ${(err as Error).message}`);
    return null;
  });

  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: true,
      // A dummy server, which is what Chromium needs at launch before a
      // context is allowed its own proxy. Without it every per-context proxy
      // is silently ignored and the whole batch goes out on the datacentre IP.
      ...(proxyConfiguration ? { proxy: { server: "per-context" } } : {}),
      args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu"],
    });
  } catch (err) {
    // The one failure that is not one page's problem. Every row says so, so
    // the caller still gets its list back rather than an empty dataset.
    const message = `Chromium would not start: ${(err as Error).message}`;
    log.error(message);
    for (const request of input.urls) {
      await Actor.pushData(blank(request.id, request.url, input.viewport, { code: "BROWSER_LAUNCH_FAILED", message }, 0));
    }
    await Actor.exit();
    throw err;
  }

  const timeoutAt = Actor.getEnv().timeoutAt?.getTime() ?? null;
  const deadline = timeoutAt ? timeoutAt - SHUTDOWN_MARGIN_MS : null;

  try {
    for (const [index, request] of input.urls.entries()) {
      const remaining = deadline ? deadline - Date.now() : Number.POSITIVE_INFINITY;
      if (remaining < MINIMUM_PAGE_MS) {
        log.warning(`Out of time before ${request.url} — writing it as a timeout.`);
        await Actor.pushData(
          blank(request.id, request.url, input.viewport, {
            code: "PAGE_TIMEOUT",
            message: "The run ran out of time before this page was opened.",
          }, 0),
        );
        continue;
      }

      // Whichever is smaller: what this page is allowed, or what is left.
      const navigationTimeoutMs = Math.min(input.navigationTimeoutMs ?? 45_000, Math.max(MINIMUM_PAGE_MS, remaining - input.delay - 3_000));

      const captured = await capturePage(browser, request, {
        viewport: input.viewport,
        fullPage: input.fullPage,
        delay: input.delay,
        navigationTimeoutMs,
        // A session per page, so twenty sites are twenty IPs rather than one
        // address working through a list — which is what a rate limiter is
        // built to notice.
        proxyUrl: proxyConfiguration ? ((await proxyConfiguration.newUrl(`shot${index}`)) ?? null) : null,
      });

      if (!captured.ok) {
        log.warning(`${request.url}: ${captured.error.code} — ${captured.error.message}`);
        await Actor.pushData(blank(request.id, request.url, input.viewport, captured.error, captured.durationMs));
        continue;
      }

      try {
        const processed = await processScreenshot(captured.capture, { maxWidth: input.maxWidth, maxHeight: input.maxHeight });

        // The key has to survive being a URL path segment, and the caller's id
        // is whatever the caller wanted it to be. The index keeps two ids that
        // sanitise to the same thing apart.
        const key = `shot_${index}_${request.id.replace(/[^a-zA-Z0-9!\-_.'()]/g, "_").slice(0, 60)}`;
        await store.setValue(key, processed.png, { contentType: "image/png" });

        // Only when it is a different picture. Storing a second copy of an
        // image nothing cropped or shrank is storage paid for twice for no
        // reason a person could ever see.
        let fullScreenshotUrl: string | null = null;
        if (!processed.untouched) {
          await store.setValue(`${key}_full`, captured.capture, { contentType: "image/png" });
          fullScreenshotUrl = store.getPublicUrl(`${key}_full`);
        }

        const result: ScreenshotResult = {
          id: request.id,
          url: request.url,
          finalUrl: captured.finalUrl,
          success: true,
          screenshotUrl: store.getPublicUrl(key),
          fullScreenshotUrl,
          width: processed.width,
          height: processed.height,
          // What was on the screen before any of this. A full-page capture is
          // taken at the viewport width, and the page's own scroll height is
          // the honest answer for how much of it there was.
          fullWidth: processed.untouched ? processed.width : input.viewport.width,
          fullHeight: processed.untouched ? processed.height : captured.pageHeight || null,
          cropped: processed.cropped,
          viewportWidth: input.viewport.width,
          viewportHeight: input.viewport.height,
          format: "png",
          durationMs: captured.durationMs,
          error: null,
        };
        if (captured.withoutProxy && proxyConfiguration) {
          log.warning(`${request.url} was fetched without the proxy — it could not be reached through one.`);
        }
        await Actor.pushData(result);
        log.info(`${request.url} → ${processed.width}x${processed.height}${processed.cropped ? " (cropped)" : ""} in ${captured.durationMs}ms`);
      } catch (err) {
        const message = `The picture was taken and could not be prepared: ${(err as Error).message}`;
        log.warning(`${request.url}: ${message}`);
        await Actor.pushData(blank(request.id, request.url, input.viewport, { code: "IMAGE_PROCESSING_FAILED", message }, captured.durationMs));
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
} catch (err) {
  if (err instanceof InvalidInputError) {
    // A bad input is a bad run, not a bad website. Failing the run is what
    // tells the caller the difference — there is no per-URL row to put it on.
    log.error(err.message);
    await Actor.fail(err.message);
  } else {
    throw err;
  }
}

await Actor.exit();

/** A row for a page that produced no picture. Same shape as one that did. */
function blank(
  id: string,
  url: string,
  viewport: { width: number; height: number },
  error: ScreenshotResult["error"],
  durationMs: number,
): ScreenshotResult {
  return {
    id,
    url,
    finalUrl: null,
    success: false,
    screenshotUrl: null,
    fullScreenshotUrl: null,
    width: null,
    height: null,
    fullWidth: null,
    fullHeight: null,
    cropped: false,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    format: "png",
    durationMs,
    error,
  };
}
