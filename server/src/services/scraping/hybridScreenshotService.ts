import { apifyConfigured } from "../../lib/apify.js";
import {
  runScreenshotActor,
  type ScreenshotJob,
  type ScreenshotRow,
  type ScreenshotRunFailure,
  type ScreenshotRunSuccess,
} from "../apifyScreenshot.js";
import { captureLocalScreenshots } from "./providers/localScreenshot.js";

/**
 * Hybrid Screenshot Service: "Local-First, Apify Fallback".
 *
 * Runs free local Playwright + Sharp execution first to eliminate Apify costs.
 * If bot challenges, Cloudflare WAF, or launch errors occur, it seamlessly
 * offloads the blocked/failed URLs to Apify as an automated safety net.
 */

export type HybridExecutionResult =
  | (ScreenshotRunSuccess & { provider: "playwright" | "apify" | "hybrid"; fallbackOccurred?: boolean })
  | (ScreenshotRunFailure & { provider: "playwright" | "apify" | "hybrid"; fallbackOccurred?: boolean });

export async function runHybridScreenshot(
  job: ScreenshotJob,
  options: { waitMs: number },
): Promise<HybridExecutionResult> {
  const providerPreference = (process.env.SCRAPER_SCREENSHOT_PROVIDER || "playwright").toLowerCase().trim();

  // If explicitly configured for Apify only, bypass local execution
  if (providerPreference === "apify") {
    const apifyRes = await runScreenshotActor(job, options);
    return { ...apifyRes, provider: "apify" };
  }

  // 1. Attempt free local Playwright + Sharp first
  const local = await captureLocalScreenshots(job, options);

  // If local browser could not launch and Apify is available, fallback immediately
  if (local.browserError) {
    if (await apifyConfigured()) {
      console.warn(`[hybridScreenshot] Local Chromium error (${local.browserError}). Falling back to Apify.`);
      const apifyRes = await runScreenshotActor(job, options);
      return { ...apifyRes, provider: "apify", fallbackOccurred: true };
    }
    return {
      ok: false,
      actorId: "local/playwright",
      code: "ACTOR_FAILED",
      message: `Local browser could not start: ${local.browserError}`,
      costUsd: 0,
      provider: "playwright",
    };
  }

  // Identify any URLs that were blocked by bot shields or timed out
  const needsFallbackUrls: typeof job.urls = [];
  for (const req of job.urls) {
    const row = local.rows.get(req.id);
    if (!row || !row.success) {
      if (row?.error?.code === "BOT_BLOCKED" || row?.error?.code === "PAGE_TIMEOUT") {
        needsFallbackUrls.push(req);
      }
    }
  }

  // If everything succeeded locally, return 100% free result!
  if (needsFallbackUrls.length === 0) {
    return {
      ok: true,
      actorId: "local/playwright",
      runId: `local_${Date.now()}`,
      rows: local.rows,
      costUsd: 0,
      provider: "playwright",
    };
  }

  // 2. Fallback contingency for blocked URLs
  const hasApify = await apifyConfigured();
  if (hasApify && needsFallbackUrls.length > 0) {
    console.info(
      `[hybridScreenshot] ${needsFallbackUrls.length} page(s) hit bot barrier or timeout. Invoking Apify fallback with residential proxies.`,
    );

    const fallbackJob: ScreenshotJob = {
      ...job,
      urls: needsFallbackUrls,
    };

    const apifyFallback = await runScreenshotActor(fallbackJob, options);
    if (apifyFallback.ok) {
      // Merge Apify successful rows into our local dataset
      for (const [id, row] of apifyFallback.rows) {
        local.rows.set(id, row);
      }
      return {
        ok: true,
        actorId: apifyFallback.actorId,
        runId: apifyFallback.runId,
        rows: local.rows,
        costUsd: apifyFallback.costUsd,
        provider: "hybrid",
        fallbackOccurred: true,
      };
    }
  }

  // If no Apify or fallback failed, return the local rows as they stand
  return {
    ok: true,
    actorId: "local/playwright",
    runId: `local_${Date.now()}`,
    rows: local.rows,
    costUsd: 0,
    provider: "playwright",
  };
}
