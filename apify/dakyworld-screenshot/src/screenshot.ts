import type { Browser, BrowserContext } from "playwright";
import type { ScreenshotError, ScreenshotErrorCode, ScreenshotInput, ScreenshotRequest } from "./contract.js";
import { validUrl } from "./input.js";

/**
 * One page, opened and photographed.
 *
 * Everything about a browser lives in this file and `main.ts`; nothing above
 * either of them knows that Playwright or Chromium exist. That separation is
 * the point of owning the actor — the server used to hold a table of what four
 * different strangers' actors called their viewport keys, and now it holds a
 * viewport.
 *
 * **A failure here is a value, never a throw.** One website refusing automated
 * browsers must not cost the nineteen others in the batch their pictures, so
 * every path out of this function is a result with a code on it.
 */

export interface CaptureSuccess {
  ok: true;
  capture: Buffer;
  finalUrl: string;
  /** The whole scrollable height, whether or not all of it was captured. */
  pageHeight: number;
  durationMs: number;
  /** True when the proxy failed and the page was fetched directly instead. */
  withoutProxy: boolean;
}

export interface CaptureFailure {
  ok: false;
  error: ScreenshotError;
  durationMs: number;
}

export type CaptureResult = CaptureSuccess | CaptureFailure;

const fail = (code: ScreenshotErrorCode, message: string, startedAt: number): CaptureFailure => ({
  ok: false,
  error: { code, message },
  durationMs: Date.now() - startedAt,
});

/**
 * A real Chrome's user agent, because a good share of small-business sites
 * behind a WAF serve a challenge page to anything that says HeadlessChrome —
 * and a challenge page photographed and read by a vision model becomes a
 * report about a website that does not exist.
 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Chromium's own errors for a proxy that could not carry the request.
 *
 * Worth telling apart from a site being down, because the answer is different:
 * this is the one navigation failure where trying again *without* the proxy is
 * a real second chance rather than the same refusal more slowly.
 */
const PROXY_FAILURES = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|ERR_SOCKS_CONNECTION_FAILED/;

/** Apify hands out `http://groups-…:password@proxy.apify.com:8000`; Playwright wants the three parts apart. */
export function splitProxyUrl(url: string): { server: string; username?: string; password?: string } | null {
  try {
    const parsed = new URL(url);
    return {
      server: `${parsed.protocol}//${parsed.host}`,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    };
  } catch {
    return null;
  }
}

export interface CaptureOptions {
  viewport: ScreenshotInput["viewport"];
  fullPage: boolean;
  delay: number;
  navigationTimeoutMs: number;
  /** A fresh proxy URL for this page, or null to go direct. */
  proxyUrl: string | null;
}

export async function capturePage(browser: Browser, request: ScreenshotRequest, options: CaptureOptions): Promise<CaptureResult> {
  const startedAt = Date.now();

  const url = validUrl(request.url);
  if (!url) {
    return fail("INVALID_URL", `"${request.url}" is not a web address a browser could open.`, startedAt);
  }

  const attempt = await openAndShoot(browser, url, options, startedAt);
  // The one retry worth having. Everything else — a timeout, a refused
  // connection, a site that serves a 403 to every browser it has not seen
  // before — gives the same answer the second time and costs another page load
  // to say so.
  if (!attempt.ok && options.proxyUrl && attempt.error.code === "NAVIGATION_ERROR" && PROXY_FAILURES.test(attempt.error.message)) {
    const direct = await openAndShoot(browser, url, { ...options, proxyUrl: null }, startedAt);
    if (direct.ok) return { ...direct, withoutProxy: true };
    return direct;
  }
  return attempt;
}

async function openAndShoot(browser: Browser, url: string, options: CaptureOptions, startedAt: number): Promise<CaptureResult> {
  const proxy = options.proxyUrl ? splitProxyUrl(options.proxyUrl) : null;
  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      viewport: options.viewport,
      userAgent: USER_AGENT,
      deviceScaleFactor: 1,
      // **No mobile emulation, deliberately.** Turning Playwright's `isMobile`
      // on is more faithful to a real phone and it changes the picture: a page
      // with no viewport meta tag is laid out at Chrome's 980px default and
      // zoomed out, so the phone shot comes back 980 wide instead of 390. That
      // is arguably better evidence, and it is not the evidence the audit's UX
      // reviewer and its prompts were written against — so it is a change to
      // make deliberately, with the vision half re-checked, rather than a side
      // effect of owning the actor. See the README.
      ...(proxy ? { proxy } : {}),
    });

    // Video and audio on a homepage are megabytes paid for and never looked
    // at — the shutter falls before most of it would play. Images and fonts
    // are the opposite: they are the thing being judged.
    await context.route("**/*", (route) => {
      if (route.request().resourceType() === "media") return route.abort();
      return route.continue();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(options.navigationTimeoutMs);

    let response;
    try {
      // "load" rather than "networkidle": a page with a chat widget, an
      // analytics beacon or an ad script never goes idle, and waiting for it
      // burns the whole timeout to produce exactly the same picture.
      response = await page.goto(url, { waitUntil: "load", timeout: options.navigationTimeoutMs });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if ((err as Error).name === "TimeoutError") {
        return fail("PAGE_TIMEOUT", `The page did not finish loading within ${Math.round(options.navigationTimeoutMs / 1000)} seconds.`, startedAt);
      }
      return fail("NAVIGATION_ERROR", `The page could not be opened: ${firstLine(message)}`, startedAt);
    }

    // Fonts, a hero image, and whatever the page animates in on arrival.
    if (options.delay > 0) await page.waitForTimeout(options.delay);

    const finalUrl = page.url() || response?.url() || url;
    const pageHeight = await page
      .evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0))
      .catch(() => 0);

    let capture: Buffer;
    try {
      capture = await page.screenshot({ fullPage: options.fullPage, type: "png", timeout: options.navigationTimeoutMs });
    } catch (err) {
      // Nearly always an enormous page: Chromium will not compose a texture
      // past about 16,000 pixels tall. One window of it is worth far more than
      // nothing, and it is the window the whole argument rests on anyway.
      if (!options.fullPage) return fail("SCREENSHOT_FAILED", `The screenshot could not be taken: ${firstLine((err as Error).message)}`, startedAt);
      try {
        capture = await page.screenshot({ fullPage: false, type: "png", timeout: options.navigationTimeoutMs });
      } catch (second) {
        return fail("SCREENSHOT_FAILED", `The screenshot could not be taken: ${firstLine((second as Error).message)}`, startedAt);
      }
    }

    return {
      ok: true,
      capture,
      finalUrl,
      pageHeight: pageHeight || 0,
      durationMs: Date.now() - startedAt,
      withoutProxy: !options.proxyUrl,
    };
  } catch (err) {
    return fail("NAVIGATION_ERROR", `The page could not be opened: ${firstLine((err as Error).message ?? String(err))}`, startedAt);
  } finally {
    // Closing the context, not the browser: the browser is shared by the whole
    // batch and closing it here would end the run after the first page.
    await context?.close().catch(() => undefined);
  }
}

/**
 * Playwright's errors carry a stack, a call log and sometimes the URL it was
 * given — which for a proxied request is a URL with a password in it. One line
 * is the sentence a person needs and none of the rest.
 */
function firstLine(message: string): string {
  const line = (message ?? "").split("\n")[0]?.trim() ?? "";
  return line.replace(/https?:\/\/[^\s@]*@/g, "").slice(0, 300) || "no reason given";
}
