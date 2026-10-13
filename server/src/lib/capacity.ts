import "dotenv/config";
import type { WebsitePlanTier } from "@prisma/client";

/** Deployment limits are validated at boot rather than silently disabling protection. */
export function integerSetting(name: string, fallback: number, min = 1, max = 100_000): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

/**
 * A setting that may legitimately be zero, so a blank line cannot be allowed to
 * mean it. `Number("")` is 0, which for these would quietly switch a plan's AI
 * off rather than fail at boot.
 */
function optionalSetting(name: string, fallback: number, min = 0): number {
  return process.env[name]?.trim() ? integerSetting(name, fallback, min) : fallback;
}

export const capacity = {
  role: process.env.SERVICE_ROLE ?? "combined",
  cache: process.env.RESPONSE_CACHE_ENABLED === "true",
  edge: process.env.EDGE_HTML_CACHE_ENABLED === "true",
  admission: process.env.JOB_ADMISSION_ENABLED === "true",
  aiConcurrency: integerSetting("AI_CONCURRENCY", 8, 1, 32),
  pendingJobs: integerSetting("AI_PENDING_LIMIT", 200),
  /**
   * How many AI jobs one account may start in a UTC day, by plan.
   *
   * It was one number for everybody, `AI_DAILY_USER_LIMIT`, defaulting to two.
   * With admission switched on, that was every AI job on every plan — so
   * Business, sold as unlimited AI runs, got two a day, and Pro could never
   * reach the fifty a month it is sold with. The plan decides now.
   */
  aiDailyByTier: {
    EDITOR: optionalSetting("AI_DAILY_LIMIT_EDITOR", 0),
    CARE: optionalSetting("AI_DAILY_LIMIT_CARE", 10),
    MANAGED: optionalSetting("AI_DAILY_LIMIT_MANAGED", 50),
  } satisfies Record<WebsitePlanTier, number>,
  /** The old single number. Only where it is actually set does it still cap every plan. */
  aiDailyCeiling: process.env.AI_DAILY_USER_LIMIT?.trim() ? integerSetting("AI_DAILY_USER_LIMIT", 2) : null,
  fallbackConcurrency: integerSetting("CACHE_FALLBACK_CONCURRENCY", 20, 1, 100),
  readConcurrency: integerSetting("API_READ_CONCURRENCY", 50, 1, 500),
  writeConcurrency: integerSetting("API_WRITE_CONCURRENCY", 20, 1, 100),
};
if (!["combined", "api", "worker"].includes(capacity.role)) throw new Error("Invalid SERVICE_ROLE");
// Said at boot because nothing else says it: the plan label and the refusal both
// quote the capped number, so "Unlimited AI runs (fair use: 2 a day)" on Business
// was the only sign that a leftover AI_DAILY_USER_LIMIT was in force.
{
  const ceiling = capacity.aiDailyCeiling;
  const capped = ceiling === null ? [] : (Object.keys(capacity.aiDailyByTier) as WebsitePlanTier[]).filter((tier) => capacity.aiDailyByTier[tier] > ceiling);
  if (capped.length) {
    console.warn(`[capacity] AI_DAILY_USER_LIMIT=${ceiling} is set and caps ${capped.join(", ")} below their own AI_DAILY_LIMIT_* value. Unset it to let each plan's number apply.`);
  }
}
if (capacity.cache && !process.env.REDIS_URL) throw new Error("RESPONSE_CACHE_ENABLED requires REDIS_URL");

/**
 * The AI jobs a day this plan may start: the plan's own number, under the old
 * ceiling where one is set. Read by the queue that enforces it and by the plan
 * label that states it, so the two cannot disagree.
 */
export function dailyAiLimit(tier: WebsitePlanTier): number {
  const own = capacity.aiDailyByTier[tier];
  return capacity.aiDailyCeiling === null ? own : Math.min(own, capacity.aiDailyCeiling);
}

export class CapacityError extends Error {
  constructor(message = "The service is busy. Please try again shortly.", public status = 429, public retryAfter = 15) { super(message); }
}

/** No unbounded waiting room when Redis or the database is slow. */
export function concurrencyGate(limit: number) {
  let active = 0;
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (active >= limit) throw new CapacityError(undefined, 503);
    active++;
    try { return await work(); } finally { active--; }
  };
}
