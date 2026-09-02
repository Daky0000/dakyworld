import { SETTING, deleteSetting, getSetting, isEnvManaged, setSetting } from "../lib/settings.js";
import { safeZone } from "../lib/timezone.js";
import type { ApifyActorSchema } from "../lib/apify.js";

/**
 * How lead capture behaves, for every source at once.
 *
 * A ScraperSource says *what* to scrape — actor, input, schedule. This says
 * everything that shouldn't have to be repeated per source and shouldn't need
 * a redeploy to change:
 *
 *  - **Where Dakyworld sells.** One location, country and language, injected
 *    into actor input as `{{location}}` / `{{country}}` / `{{language}}`. Move
 *    the business to Lagos and every template follows.
 *  - **What a run may cost.** Apify bills per run: a monthly ceiling, a
 *    per-run charge cap, a wall clock timeout, and a limit on simultaneous
 *    runs. Without these, one bad input JSON can quietly spend a month's
 *    credits overnight.
 *  - **What a new source starts as.** Row cap, score floor, qualify
 *    threshold — the numbers the Owner would otherwise retype every time.
 *  - **Who hears about it.** A run that fails at 06:00 is invisible unless
 *    something says so.
 *
 * Stored in AppSetting, so all of it is editable from Settings → Lead capture.
 */

export type ProxyMode = "NONE" | "AUTO" | "DATACENTER" | "RESIDENTIAL";
export type NotifyMode = "OFF" | "FAILURES" | "ALL";

export interface CaptureConfig {
  /** Defaults for a newly added source. */
  maxItems: number;
  minScore: number;
  autoQualify: boolean;
  qualifyScore: number;
  timezone: string;

  /** Run options sent to Apify. `memoryMbytes: 0` means "whatever the actor asks for". */
  runTimeoutSecs: number;
  memoryMbytes: number;
  proxyMode: ProxyMode;
  /** Two-letter code, e.g. "GH". Null lets Apify choose. */
  proxyCountry: string | null;

  /** Spend guardrails. Null means no ceiling. */
  monthlyBudgetUsd: number | null;
  /** Per run, enforced by Apify rather than after the money is gone. */
  maxRunChargeUsd: number | null;
  maxConcurrentRuns: number;

  /** The market, substituted into actor input at run time. */
  location: string;
  countryCode: string;
  language: string;

  notify: NotifyMode;
  /** Null falls back to the address the app sends from. */
  notifyEmail: string | null;
  /** Run history older than this is pruned. Captured leads are never touched. */
  retentionDays: number;
}

/**
 * What a deployment starts with as its monthly Apify ceiling, written once.
 *
 * Not a *default*, which is the distinction that matters here. A default is
 * what blank means, and blank has always meant **no ceiling** — changing that
 * would make "no ceiling" unsayable, because clearing the box would put the
 * default back. So this is seeded as an actual stored value the first time,
 * which the Owner can then raise, lower, or clear.
 *
 * Ten dollars rather than nothing because an uncapped spend is a bad thing to
 * arrive at by never having opened a settings screen, and ten is roughly a
 * month of ordinary use: a few thousand screenshots, or a few dozen Google
 * Maps searches. The number is the Owner's; only the starting point is ours.
 */
export const SEEDED_MONTHLY_BUDGET_USD = 10;

export const CAPTURE_DEFAULTS: CaptureConfig = {
  maxItems: 100,
  minScore: 30,
  autoQualify: true,
  qualifyScore: 60,
  timezone: "Africa/Accra",

  // 30 minutes matches how long the runner is willing to poll. Actors ship
  // defaults measured in days — `compass/crawler-google-places` says seven —
  // which is a runaway bill waiting for a bad search string.
  runTimeoutSecs: 1800,
  memoryMbytes: 0,
  proxyMode: "AUTO",
  proxyCountry: null,

  // Null is **no ceiling**, and that stays the meaning of blank. What a fresh
  // deployment gets is not this default but `SEEDED_MONTHLY_BUDGET_USD` below,
  // written once as a real value — so the Owner can raise it, lower it, or clear
  // it back to no ceiling, and blank does not silently mean ten.
  monthlyBudgetUsd: null,
  maxRunChargeUsd: null,
  maxConcurrentRuns: 2,

  location: "Accra, Ghana",
  countryCode: "gh",
  language: "en",

  notify: "FAILURES",
  notifyEmail: null,
  retentionDays: 90,
};

export const PROXY_MODES: ProxyMode[] = ["NONE", "AUTO", "DATACENTER", "RESIDENTIAL"];
export const NOTIFY_MODES: NotifyMode[] = ["OFF", "FAILURES", "ALL"];
/** Apify only accepts powers of two; 0 is our own "leave it to the actor". */
export const MEMORY_OPTIONS = [0, 1024, 2048, 4096, 8192];

// --- Reading ---------------------------------------------------------------

function toInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value: string | null, fallback: number | null): number | null {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value: string | null, fallback: boolean): boolean {
  if (value == null) return fallback;
  return value === "true" || value === "1";
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export async function readCaptureConfig(): Promise<CaptureConfig> {
  const [
    maxItems,
    minScore,
    autoQualify,
    qualifyScore,
    timezone,
    runTimeoutSecs,
    memoryMbytes,
    proxyMode,
    proxyCountry,
    monthlyBudgetUsd,
    maxRunChargeUsd,
    maxConcurrentRuns,
    location,
    countryCode,
    language,
    notify,
    notifyEmail,
    retentionDays,
  ] = await Promise.all([
    getSetting(SETTING.CAPTURE_MAX_ITEMS),
    getSetting(SETTING.CAPTURE_MIN_SCORE),
    getSetting(SETTING.CAPTURE_AUTO_QUALIFY),
    getSetting(SETTING.CAPTURE_QUALIFY_SCORE),
    getSetting(SETTING.DEFAULT_TIMEZONE),
    getSetting(SETTING.CAPTURE_RUN_TIMEOUT),
    getSetting(SETTING.CAPTURE_MEMORY),
    getSetting(SETTING.CAPTURE_PROXY_MODE),
    getSetting(SETTING.CAPTURE_PROXY_COUNTRY),
    getSetting(SETTING.CAPTURE_MONTHLY_BUDGET),
    getSetting(SETTING.CAPTURE_MAX_RUN_CHARGE),
    getSetting(SETTING.CAPTURE_MAX_CONCURRENT),
    getSetting(SETTING.CAPTURE_LOCATION),
    getSetting(SETTING.CAPTURE_COUNTRY_CODE),
    getSetting(SETTING.CAPTURE_LANGUAGE),
    getSetting(SETTING.CAPTURE_NOTIFY),
    getSetting(SETTING.CAPTURE_NOTIFY_EMAIL),
    getSetting(SETTING.CAPTURE_RETENTION_DAYS),
  ]);

  return {
    maxItems: toInt(maxItems, CAPTURE_DEFAULTS.maxItems),
    minScore: toInt(minScore, CAPTURE_DEFAULTS.minScore),
    autoQualify: toBool(autoQualify, CAPTURE_DEFAULTS.autoQualify),
    qualifyScore: toInt(qualifyScore, CAPTURE_DEFAULTS.qualifyScore),
    timezone: safeZone(timezone ?? CAPTURE_DEFAULTS.timezone),
    runTimeoutSecs: toInt(runTimeoutSecs, CAPTURE_DEFAULTS.runTimeoutSecs),
    memoryMbytes: toInt(memoryMbytes, CAPTURE_DEFAULTS.memoryMbytes),
    proxyMode: oneOf(proxyMode, PROXY_MODES, CAPTURE_DEFAULTS.proxyMode),
    proxyCountry: proxyCountry?.trim() ? proxyCountry.trim().toUpperCase() : null,
    monthlyBudgetUsd: toFloat(monthlyBudgetUsd, CAPTURE_DEFAULTS.monthlyBudgetUsd),
    maxRunChargeUsd: toFloat(maxRunChargeUsd, CAPTURE_DEFAULTS.maxRunChargeUsd),
    maxConcurrentRuns: Math.max(1, toInt(maxConcurrentRuns, CAPTURE_DEFAULTS.maxConcurrentRuns)),
    location: location?.trim() || CAPTURE_DEFAULTS.location,
    countryCode: (countryCode?.trim() || CAPTURE_DEFAULTS.countryCode).toLowerCase(),
    language: language?.trim() || CAPTURE_DEFAULTS.language,
    notify: oneOf(notify, NOTIFY_MODES, CAPTURE_DEFAULTS.notify),
    notifyEmail: notifyEmail?.trim() || null,
    retentionDays: Math.max(0, toInt(retentionDays, CAPTURE_DEFAULTS.retentionDays)),
  };
}

/** Which capture values the deploy has pinned, so the UI can refuse to edit them. */
export function captureEnvManaged() {
  return {
    monthlyBudgetUsd: isEnvManaged(SETTING.CAPTURE_MONTHLY_BUDGET),
    maxConcurrentRuns: isEnvManaged(SETTING.CAPTURE_MAX_CONCURRENT),
    timezone: isEnvManaged(SETTING.DEFAULT_TIMEZONE),
  };
}

// --- Writing ---------------------------------------------------------------

const KEYS: Record<keyof CaptureConfig, string> = {
  maxItems: SETTING.CAPTURE_MAX_ITEMS,
  minScore: SETTING.CAPTURE_MIN_SCORE,
  autoQualify: SETTING.CAPTURE_AUTO_QUALIFY,
  qualifyScore: SETTING.CAPTURE_QUALIFY_SCORE,
  timezone: SETTING.DEFAULT_TIMEZONE,
  runTimeoutSecs: SETTING.CAPTURE_RUN_TIMEOUT,
  memoryMbytes: SETTING.CAPTURE_MEMORY,
  proxyMode: SETTING.CAPTURE_PROXY_MODE,
  proxyCountry: SETTING.CAPTURE_PROXY_COUNTRY,
  monthlyBudgetUsd: SETTING.CAPTURE_MONTHLY_BUDGET,
  maxRunChargeUsd: SETTING.CAPTURE_MAX_RUN_CHARGE,
  maxConcurrentRuns: SETTING.CAPTURE_MAX_CONCURRENT,
  location: SETTING.CAPTURE_LOCATION,
  countryCode: SETTING.CAPTURE_COUNTRY_CODE,
  language: SETTING.CAPTURE_LANGUAGE,
  notify: SETTING.CAPTURE_NOTIFY,
  notifyEmail: SETTING.CAPTURE_NOTIFY_EMAIL,
  retentionDays: SETTING.CAPTURE_RETENTION_DAYS,
};

/**
 * Saves only the keys present in `patch`. A null clears the setting rather
 * than storing the word "null", so the default takes over again.
 */
export async function writeCaptureConfig(patch: Partial<CaptureConfig>): Promise<CaptureConfig> {
  for (const [field, value] of Object.entries(patch) as [keyof CaptureConfig, unknown][]) {
    const key = KEYS[field];
    if (!key || value === undefined) continue;
    // An env-pinned value must stay the deploy's, whatever the form sent.
    if (isEnvManaged(key)) continue;
    if (value === null || value === "") await deleteSetting(key);
    else await setSetting(key, String(value));
  }
  return readCaptureConfig();
}

// --- Turning config into a run ---------------------------------------------

/** `timeoutSecs` / `memoryMbytes` for `startRun`; an omitted key means "actor's own default". */
export function runOptions(config: CaptureConfig): { timeoutSecs?: number; memoryMbytes?: number } {
  return {
    timeoutSecs: config.runTimeoutSecs > 0 ? config.runTimeoutSecs : undefined,
    memoryMbytes: config.memoryMbytes > 0 ? config.memoryMbytes : undefined,
  };
}

/** The `{{…}}` tokens actor input can use, on top of the date ones. */
export function captureTokens(config: CaptureConfig): Record<string, string> {
  return {
    location: config.location,
    country: config.location.split(",").pop()?.trim() || config.location,
    countrycode: config.countryCode,
    language: config.language,
  };
}

/**
 * The proxy object to put in an actor's own proxy field — `proxyConfiguration`
 * for most crawlers, `proxyConfig` for `vdrmota/contact-info-scraper`, nothing
 * at all for the Google Maps actors, which handle their own.
 *
 * Returns null when the actor declares no proxy field, when the source already
 * set one by hand, or when proxying is switched off and the actor doesn't
 * insist on it. Never guesses a key: an undeclared field is an input
 * validation error, which fails the run outright.
 */
export function proxyInput(
  config: CaptureConfig,
  schema: ApifyActorSchema | null,
  currentInput: Record<string, unknown>,
): { field: string; value: Record<string, unknown> } | null {
  const field = schema?.proxyField;
  if (!field) return null;
  if (currentInput[field] !== undefined) return null;

  if (config.proxyMode === "NONE") {
    // A required field still has to be filled, or Apify rejects the run before
    // it starts — so honour the actor's own default rather than break it.
    if (!schema.proxyRequired) return null;
    return { field, value: schema.proxyDefault ?? { useApifyProxy: true } };
  }

  const value: Record<string, unknown> = { useApifyProxy: true };
  if (config.proxyMode === "RESIDENTIAL") {
    value.apifyProxyGroups = ["RESIDENTIAL"];
    // Residential proxies are the only group where country selection applies.
    if (config.proxyCountry) value.apifyProxyCountry = config.proxyCountry;
  } else if (config.proxyMode === "DATACENTER") {
    value.apifyProxyGroups = ["BUYPROXIES94952"];
  }
  return { field, value };
}

/**
 * Input keys the actor doesn't declare. They aren't errors — Apify ignores
 * them — which is exactly why they're worth surfacing: a misspelt key means a
 * setting the Owner thinks is on simply isn't.
 */
export function unknownInputKeys(input: Record<string, unknown>, schema: ApifyActorSchema | null): string[] {
  if (!schema || schema.properties.length === 0) return [];
  return Object.keys(input).filter((key) => !schema.properties.includes(key));
}


/**
 * Writes the starting monthly ceiling, once ever.
 *
 * Behind a marker rather than a `null` check, for the reason every one-shot
 * pass in this codebase is: checking whether the value is *absent* would
 * resurrect it every boot for somebody who had deliberately cleared it to no
 * ceiling. Clearing it is a decision, and a boot pass must not overrule one.
 */
export async function seedCaptureBudget(): Promise<number | null> {
  if (await getSetting(SETTING.CAPTURE_BUDGET_SEEDED)) return null;
  await setSetting(SETTING.CAPTURE_BUDGET_SEEDED, new Date().toISOString());

  // Only if nothing is there. A deployment that already has a ceiling has one
  // somebody chose, and this is a starting point, not a correction.
  const existing = await getSetting(SETTING.CAPTURE_MONTHLY_BUDGET);
  if (existing?.trim()) return null;

  await setSetting(SETTING.CAPTURE_MONTHLY_BUDGET, String(SEEDED_MONTHLY_BUDGET_USD));
  return SEEDED_MONTHLY_BUDGET_USD;
}
