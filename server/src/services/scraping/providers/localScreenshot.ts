import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { isSafeUrl } from "../safety/ssrf.js";
import type { ScreenshotJob, ScreenshotRequest, ScreenshotRow } from "../../apifyScreenshot.js";

/**
 * Local Playwright + Sharp Screenshot Engine.
 *
 * Implements the identical screenshot, viewport, and Sharp processing pipeline
 * from `apify/dakyworld-screenshot`, running directly on the local server at $0 cost.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const CERTIFICATE_FAILURES = /ERR_CERT_[A-Z_]+|ERR_SSL_[A-Z_]+|ERR_BAD_SSL_CLIENT_AUTH_CERT/;

const CLOUDFLARE_CHALLENGE = /Cloudflare|Attention Required!|Just a moment\.\.\.|Verification Challenge|Checking your browser/i;

const PNG_OPTIONS = { compressionLevel: 9, adaptiveFiltering: true, palette: false } as const;

let sharedBrowser: Browser | null = null;
let activeUsers = 0;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }
  sharedBrowser = await chromium.launch({
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  return sharedBrowser;
}

export async function closeSharedBrowser(): Promise<void> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
}

export interface LocalCaptureOutcome {
  row: ScreenshotRow;
  isBotBlocked: boolean;
  canFallbackToApify: boolean;
}

export async function processImageBuffer(
  capture: Buffer,
  options: { maxWidth?: number; maxHeight?: number },
): Promise<{
  png: Buffer;
  width: number;
  height: number;
  cropped: boolean;
}> {
  const source = sharp(capture, { limitInputPixels: 800_000_000 });
  const meta = await source.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("The captured image had no readable dimensions.");

  const keep = options.maxHeight && height > options.maxHeight ? options.maxHeight : height;
  const cropped = keep < height;
  const shrink = Boolean(options.maxWidth && width > options.maxWidth);

  if (!cropped && !shrink) {
    return { png: capture, width, height, cropped: false };
  }

  let pipeline = sharp(capture, { limitInputPixels: 800_000_000 });
  if (cropped) pipeline = pipeline.extract({ left: 0, top: 0, width, height: keep });
  if (shrink) {
    pipeline = pipeline.resize({ width: options.maxWidth, withoutEnlargement: true, fit: "inside" });
  }

  const png = await pipeline.png(PNG_OPTIONS).toBuffer({ resolveWithObject: true });
  return {
    png: png.data,
    width: png.info.width,
    height: png.info.height,
    cropped,
  };
}

async function captureSingleUrl(
  browser: Browser,
  request: ScreenshotRequest,
  job: ScreenshotJob,
  timeoutMs: number,
): Promise<LocalCaptureOutcome> {
  const startedAt = Date.now();
  const viewport = request.viewport ?? job.viewport;
  const maxHeight = request.maxHeight ?? job.maxHeight;

  // SSRF and URL safety check
  const safety = isSafeUrl(request.url);
  if (!safety.safe || !safety.url) {
    return {
      row: {
        id: request.id,
        url: request.url,
        finalUrl: null,
        success: false,
        screenshotUrl: null,
        fullScreenshotUrl: null,
        width: null,
        height: null,
        fullWidth: null,
        fullHeight: null,
        cropped: false,
        insecure: false,
        partiallyLoaded: false,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        format: "png",
        durationMs: Date.now() - startedAt,
        error: { code: "INVALID_URL", message: safety.reason ?? "Invalid URL" },
      },
      isBotBlocked: false,
      canFallbackToApify: false, // Do not waste Apify money on invalid/private URLs
    };
  }

  let insecure = false;
  let partiallyLoaded = false;

  const tryNavigateAndShoot = async (ignoreCert = false, waitUntil: "load" | "domcontentloaded" = "load") => {
    const context = await browser.newContext({
      viewport,
      userAgent: USER_AGENT,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: ignoreCert,
    });

    try {
      const page = await context.newPage();

      let response;
      try {
        response = await page.goto(safety.url!.href, {
          waitUntil,
          timeout: Math.min(25_000, timeoutMs),
        });
      } catch (err: any) {
        const msg = String(err?.message || err);
        return { ok: false as const, err: msg, isCert: CERTIFICATE_FAILURES.test(msg), isTimeout: /timeout/i.test(msg) };
      }

      if (job.delayMs > 0) {
        await page.waitForTimeout(Math.min(job.delayMs, 5000));
      }

      let isBotBlocked = false;
      const status = response?.status() ?? 200;
      const title = (await page.title().catch(() => "")) || "";
      if (status === 403 || status === 503 || CLOUDFLARE_CHALLENGE.test(title)) {
        isBotBlocked = true;
      }

      const fullBuffer = await page.screenshot({ fullPage: job.fullPage });
      const finalUrl = page.url();

      return { ok: true as const, buffer: fullBuffer, finalUrl, isBotBlocked };
    } finally {
      await context.close().catch(() => {});
    }
  };

  try {
    let result = await tryNavigateAndShoot(false, "load");

    // Retry 1: Certificate issues
    if (!result.ok && result.isCert) {
      insecure = true;
      result = await tryNavigateAndShoot(true, "load");
    }

    // Retry 2: Timeout issues -> loosen to domcontentloaded
    if (!result.ok && result.isTimeout) {
      partiallyLoaded = true;
      result = await tryNavigateAndShoot(insecure, "domcontentloaded");
    }

    if (!result.ok || !result.buffer) {
      const durationMs = Date.now() - startedAt;
      const isTimeout = Boolean(result.isTimeout);
      return {
        row: {
          id: request.id,
          url: request.url,
          finalUrl: null,
          success: false,
          screenshotUrl: null,
          fullScreenshotUrl: null,
          width: null,
          height: null,
          fullWidth: null,
          fullHeight: null,
          cropped: false,
          insecure,
          partiallyLoaded,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          format: "png",
          durationMs,
          error: {
            code: isTimeout ? "PAGE_TIMEOUT" : "NAVIGATION_ERROR",
            message: result.err ?? "Navigation failed",
          },
        },
        isBotBlocked: false,
        canFallbackToApify: isTimeout,
      };
    }

    // Process image through Sharp
    const processed = await processImageBuffer(result.buffer, {
      maxWidth: job.maxWidth,
      maxHeight,
    });

    const fullMeta = await sharp(result.buffer).metadata();
    const fullWidth = fullMeta.width ?? processed.width;
    const fullHeight = fullMeta.height ?? processed.height;

    // Encode as Data URLs for zero-network instantaneous retrieval
    const screenshotUrl = `data:image/png;base64,${processed.png.toString("base64")}`;
    const fullScreenshotUrl =
      result.buffer.length !== processed.png.length
        ? `data:image/png;base64,${result.buffer.toString("base64")}`
        : screenshotUrl;

    const durationMs = Date.now() - startedAt;

    return {
      row: {
        id: request.id,
        url: request.url,
        finalUrl: result.finalUrl ?? request.url,
        success: !result.isBotBlocked,
        screenshotUrl: result.isBotBlocked ? null : screenshotUrl,
        fullScreenshotUrl: result.isBotBlocked ? null : fullScreenshotUrl,
        width: processed.width,
        height: processed.height,
        fullWidth,
        fullHeight,
        cropped: processed.cropped,
        insecure,
        partiallyLoaded,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        format: "png",
        durationMs,
        error: result.isBotBlocked
          ? { code: "BOT_BLOCKED", message: "Protected by Cloudflare or bot wall challenge" }
          : null,
      },
      isBotBlocked: Boolean(result.isBotBlocked),
      canFallbackToApify: Boolean(result.isBotBlocked),
    };
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    return {
      row: {
        id: request.id,
        url: request.url,
        finalUrl: null,
        success: false,
        screenshotUrl: null,
        fullScreenshotUrl: null,
        width: null,
        height: null,
        fullWidth: null,
        fullHeight: null,
        cropped: false,
        insecure,
        partiallyLoaded,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        format: "png",
        durationMs,
        error: { code: "SCREENSHOT_FAILED", message: err?.message || "Unknown capture error" },
      },
      isBotBlocked: false,
      canFallbackToApify: true,
    };
  }
}

export async function captureLocalScreenshots(
  job: ScreenshotJob,
  options: { waitMs?: number } = {},
): Promise<{
  rows: Map<string, ScreenshotRow>;
  blockedCount: number;
  successCount: number;
  browserError: string | null;
}> {
  const rows = new Map<string, ScreenshotRow>();
  let blockedCount = 0;
  let successCount = 0;

  activeUsers++;
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err: any) {
    activeUsers--;
    return {
      rows,
      blockedCount: 0,
      successCount: 0,
      browserError: err?.message || "Could not launch Chromium",
    };
  }

  try {
    const perPageTimeout = options.waitMs ? Math.min(25_000, options.waitMs) : 20_000;
    for (const req of job.urls) {
      const outcome = await captureSingleUrl(browser, req, job, perPageTimeout);
      rows.set(outcome.row.id, outcome.row);
      if (outcome.row.success) {
        successCount++;
      }
      if (outcome.isBotBlocked) {
        blockedCount++;
      }
    }
  } finally {
    activeUsers = Math.max(0, activeUsers - 1);
  }

  return { rows, blockedCount, successCount, browserError: null };
}
