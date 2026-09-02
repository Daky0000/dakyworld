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
  /** True when the page would only open with certificate verification off. */
  insecure: boolean;
  /**
   * True when the page never finished loading and the picture was taken of the
   * document as it stood. Worth carrying: it is the honest caveat on a
   * screenshot of a site that is slower than it looks here.
   */
  partiallyLoaded: boolean;
}

export interface CaptureFailure {
  ok: false;
  error: ScreenshotError;
  durationMs: number;
  /**
   * Chromium's untranslated message, for the retries that classify on it.
   *
   * **`error.message` is for a person and cannot be matched on.** Translating
   * `net::ERR_CERT_DATE_INVALID` into "its security certificate could not be
   * accepted" is right for the report and it deletes the very token the
   * certificate retry tests for — which silently switched that retry off the
   * moment the translation was added. The actor's own tests caught it; this
   * field is why they cannot catch it twice. It is not on the contract, so
   * nothing downstream can come to depend on Chromium's vocabulary.
   */
  raw: string;
}

export type CaptureResult = CaptureSuccess | CaptureFailure;

const fail = (code: ScreenshotErrorCode, message: string, startedAt: number, raw = ""): CaptureFailure => ({
  ok: false,
  error: { code, message },
  durationMs: Date.now() - startedAt,
  raw: raw || message,
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
 * Chromium's own errors for a request the proxy could not carry.
 *
 * Worth telling apart from a site being down, because the answer is different:
 * these are the navigation failures where trying again *without* the proxy is
 * a real second chance rather than the same refusal more slowly.
 *
 * **The timeouts and resets are here for a measured reason.** A law firm's site
 * came back `net::ERR_TIMED_OUT` through the proxy while answering a plain
 * request from the same continent in 1.7 seconds — 200, 96KB, no redirect. A
 * datacentre range that a host drops on the floor does not announce itself as a
 * proxy failure; it looks exactly like a dead website, and the report then says
 * a live business's site could not be opened. One more page load is a cheap
 * price for not making that claim.
 */
const PROXY_FAILURES = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|ERR_SOCKS_CONNECTION_FAILED|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/;

/**
 * Chromium's own errors for a certificate a browser will not accept: expired,
 * self-signed, issued for another hostname, or signed by an authority nothing
 * trusts. All four are warnings a visitor gets past by clicking through.
 */
const CERTIFICATE_FAILURES = /ERR_CERT_[A-Z_]+|ERR_SSL_[A-Z_]+|ERR_BAD_SSL_CLIENT_AUTH_CERT/;

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
  /** Set only by the certificate retry. Never a default, never a mode. */
  ignoreCertificate?: boolean;
  /**
   * How much of the page to wait for. `load` by default; the timeout retry
   * drops to `domcontentloaded`.
   *
   * Never `networkidle`: a page with a chat widget, an analytics beacon or an
   * ad script never goes idle, and waiting for it burns the whole timeout to
   * produce exactly the same picture.
   */
  waitUntil?: "load" | "domcontentloaded";
}

export async function capturePage(browser: Browser, request: ScreenshotRequest, options: CaptureOptions): Promise<CaptureResult> {
  const startedAt = Date.now();

  const url = validUrl(request.url);
  if (!url) {
    return fail("INVALID_URL", `"${request.url}" is not a web address a browser could open.`, startedAt);
  }

  const attempt = await openAndShoot(browser, url, options, startedAt);
  if (attempt.ok) return attempt;

  /**
   * A page that never finishes loading is still a page worth photographing.
   *
   * `load` waits for every image, font and script on the page, and the single
   * commonest way a real small-business site fails here is one third-party
   * asset that never returns — an analytics beacon, a font from a host that is
   * down, a chat widget's socket. The document itself rendered seconds ago.
   * Reporting "nobody has seen how the site looks" because a tracking pixel
   * hung is a false impression of a site that works.
   *
   * So a timeout drops one rung to `domcontentloaded` and takes the picture,
   * with the delay doing the waiting instead. Only on a timeout: a refused
   * connection or a dead hostname gives the same answer on the second attempt
   * and costs another page load to say so.
   */
  if (attempt.error.code === "PAGE_TIMEOUT" && options.waitUntil !== "domcontentloaded") {
    const looser = await openAndShoot(browser, url, { ...options, waitUntil: "domcontentloaded" }, startedAt);
    if (looser.ok) return { ...looser, partiallyLoaded: true };
    return looser;
  }

  if (attempt.error.code !== "NAVIGATION_ERROR") return attempt;

  // Two retries worth having, and nothing else. A timeout, a refused
  // connection, a site that serves a 403 to every browser it has not seen
  // before — each gives the same answer the second time and costs another page
  // load to say so.
  if (options.proxyUrl && PROXY_FAILURES.test(attempt.raw)) {
    const direct = await openAndShoot(browser, url, { ...options, proxyUrl: null }, startedAt);
    return direct.ok ? { ...direct, withoutProxy: true } : direct;
  }

  /**
   * A certificate warning is clicked past, not reported as a dead end.
   *
   * The same decision `companyAudit.fetchSite` already makes on the server, for
   * the same reason and inside the same limits: a prospect whose certificate
   * had expired used to get a review whose entire content was "we could not
   * open it", about a site every visitor reaches by clicking one button, with
   * the expired certificate — the most urgent thing wrong with the business,
   * and a free same-day fix — never named at all. The audit half was fixed in
   * Aug 2026 and the picture half could not follow, because none of the
   * external actors declared such an input. This one is ours.
   *
   * Four things keep it narrow, and all four are written down in SECURITY.md:
   *
   *  - **It only fires on a certificate failure.** A good certificate is
   *    verified normally, and a host that does not resolve still fails.
   *  - **It is one browser context, not a mode.** Never a browser-wide flag and
   *    never `NODE_TLS_REJECT_UNAUTHORIZED`.
   *  - **Nothing of ours is sent.** A page load for a public homepage: no
   *    credential, no cookie, no body. The exposure from an unverified
   *    connection is that what comes back may not be genuine, and what comes
   *    back is only ever looked at.
   *  - **The row says so**, so a report showing the picture can say so too.
   */
  if (!options.ignoreCertificate && CERTIFICATE_FAILURES.test(attempt.raw)) {
    const past = await openAndShoot(browser, url, { ...options, ignoreCertificate: true }, startedAt);
    return past.ok ? { ...past, insecure: true } : past;
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
      // Off unless the retry in `capturePage` turned it on for this one
      // context. See the long note there; it is never a default.
      ...(options.ignoreCertificate ? { ignoreHTTPSErrors: true } : {}),
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
      // See `waitUntil` on CaptureOptions for why never `networkidle`, and
      // for the rung below this one.
      response = await page.goto(url, { waitUntil: options.waitUntil ?? "load", timeout: options.navigationTimeoutMs });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if ((err as Error).name === "TimeoutError") {
        return fail("PAGE_TIMEOUT", `it did not finish loading within ${Math.round(options.navigationTimeoutMs / 1000)} seconds.`, startedAt, message);
      }
      // The reason alone. The server frames it — "No screenshot of <url> — the
      // page could not be opened." — and a message that framed it again read
      // "the page could not be opened. The page could not be opened: …".
      return fail("NAVIGATION_ERROR", firstLine(message), startedAt, message);
    }

    // Fonts, a hero image, and whatever the page animates in on arrival.
    if (options.delay > 0) await page.waitForTimeout(options.delay);

    // On the looser rung, press Stop before the shutter.
    //
    // Arriving here on `domcontentloaded` means something on the page is still
    // in flight and is not coming — that is why the first attempt timed out.
    // Playwright's screenshot waits for the page to settle, so leaving those
    // requests open only moves the timeout from `goto` to `screenshot`, and the
    // picture is lost for exactly the reason it was being rescued from.
    // `window.stop()` is what a person clicking Stop does, and the full delay
    // has already been given to anything that was going to arrive.
    if (options.waitUntil === "domcontentloaded") {
      await page.evaluate(() => window.stop()).catch(() => undefined);
    }

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
      if (!options.fullPage) return fail("SCREENSHOT_FAILED", firstLine((err as Error).message), startedAt, (err as Error).message);
      try {
        capture = await page.screenshot({ fullPage: false, type: "png", timeout: options.navigationTimeoutMs });
      } catch (second) {
        return fail("SCREENSHOT_FAILED", firstLine((second as Error).message), startedAt, (second as Error).message);
      }
    }

    return {
      ok: true,
      capture,
      finalUrl,
      pageHeight: pageHeight || 0,
      durationMs: Date.now() - startedAt,
      withoutProxy: !options.proxyUrl,
      insecure: Boolean(options.ignoreCertificate),
      partiallyLoaded: options.waitUntil === "domcontentloaded",
    };
  } catch (err) {
    const outer = (err as Error).message ?? String(err);
    return fail("NAVIGATION_ERROR", firstLine(outer), startedAt, outer);
  } finally {
    // Closing the context, not the browser: the browser is shared by the whole
    // batch and closing it here would end the run after the first page.
    await context?.close().catch(() => undefined);
  }
}

/**
 * Chromium's network errors, in the words of somebody who owns the website.
 *
 * `page.goto: net::ERR_TIMED_OUT at https://…` is precise, and it is going to
 * appear in a document sent to a business owner explaining why nobody could
 * look at their site. Every one of these is an ordinary thing for a website to
 * do and each has a different answer, so each gets its own sentence — the same
 * treatment `lib/whatsapp.ts` gives Meta's error codes, for the same reason.
 */
const NETWORK_REASONS: [RegExp, string][] = [
  [/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/, "that address does not resolve to a server."],
  [/ERR_CONNECTION_REFUSED/, "the server refused the connection."],
  [/ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/, "the server did not answer in time."],
  [/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/, "the server closed the connection without answering."],
  [/ERR_CERT_|ERR_SSL_|ERR_BAD_SSL/, "its security certificate could not be accepted, even after clicking past the warning."],
  [/ERR_TOO_MANY_REDIRECTS/, "it redirects in a loop that never arrives anywhere."],
  [/ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/, "the server could not be reached over the network."],
  [/ERR_BLOCKED_BY|ERR_ACCESS_DENIED/, "the server blocked the request."],
  [/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|ERR_SOCKS_CONNECTION_FAILED/, "the connection could not be made, even without a proxy in front of it."],
];

/**
 * Playwright's errors carry a stack, a call log and sometimes the URL it was
 * given — which for a proxied request is a URL with a password in it. One
 * sentence is what a person needs and none of the rest.
 */
function firstLine(message: string): string {
  const raw = message ?? "";
  for (const [pattern, said] of NETWORK_REASONS) {
    if (pattern.test(raw)) return said;
  }
  const line = raw.split("\n")[0]?.trim() ?? "";
  // Whatever is left is Chromium's, so strip the credential a proxied URL can
  // carry and the `page.goto:` framing nobody outside this file needs.
  return line.replace(/https?:\/\/[^\s@]*@/g, "").replace(/^page\.\w+:\s*/, "").slice(0, 200) || "no reason was given.";
}
