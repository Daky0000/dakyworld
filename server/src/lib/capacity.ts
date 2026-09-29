import "dotenv/config";

/** Deployment limits are validated at boot rather than silently disabling protection. */
export function integerSetting(name: string, fallback: number, min = 1, max = 100_000): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export const capacity = {
  role: process.env.SERVICE_ROLE ?? "combined",
  cache: process.env.RESPONSE_CACHE_ENABLED === "true",
  edge: process.env.EDGE_HTML_CACHE_ENABLED === "true",
  admission: process.env.JOB_ADMISSION_ENABLED === "true",
  aiConcurrency: integerSetting("AI_CONCURRENCY", 8, 1, 32),
  pendingJobs: integerSetting("AI_PENDING_LIMIT", 200),
  dailyJobs: integerSetting("AI_DAILY_USER_LIMIT", 2),
  fallbackConcurrency: integerSetting("CACHE_FALLBACK_CONCURRENCY", 20, 1, 100),
  readConcurrency: integerSetting("API_READ_CONCURRENCY", 50, 1, 500),
  writeConcurrency: integerSetting("API_WRITE_CONCURRENCY", 20, 1, 100),
};
if (!["combined", "api", "worker"].includes(capacity.role)) throw new Error("Invalid SERVICE_ROLE");
if (capacity.cache && !process.env.REDIS_URL) throw new Error("RESPONSE_CACHE_ENABLED requires REDIS_URL");

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
