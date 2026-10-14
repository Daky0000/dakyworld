import type { ActorRunCode } from "../actorRun.js";
import type { ScreenshotJob, ScreenshotRow, ScreenshotRunResult } from "../apifyScreenshot.js";

export type ScrapeProviderName = "apify" | "playwright" | "crawlee" | "cheerio";

export type ScrapeStatus = "succeeded" | "partial" | "failed";

export interface ScrapeProvenance {
  provider: ScrapeProviderName;
  sourceUrl: string;
  finalUrl?: string;
  fetchedAt: string;
  durationMs?: number;
  costUsd?: number | null;
  fallbackTriggered?: boolean;
  fallbackReason?: string;
}

export interface HybridScreenshotOptions {
  waitMs?: number;
  preferredProvider?: ScrapeProviderName;
  enableFallback?: boolean;
}

export interface ContactExtractionResult {
  domain: string;
  originalStartUrl: string;
  emails: string[];
  phones: string[];
  phonesUncertain: string[];
  socialLinks: {
    linkedin?: string;
    facebook?: string;
    instagram?: string;
    twitter?: string;
    youtube?: string;
  };
  provenance: ScrapeProvenance;
}
