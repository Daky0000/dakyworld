import { costControlState } from "../services/costControl.js";
import type { RequestHandler } from "express";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { cacheMetrics } from "../lib/cache.js";
import { databaseMetrics } from "../lib/prisma.js";

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
const buckets = [50, 100, 200, 300, 500, 1000, 2000, Infinity];
const requests = { total: 0, errors: 0, rejected: 0, durationBuckets: buckets.map(() => 0) };
export const measureRequests: RequestHandler = (_req, res, next) => {
  const start = performance.now();
  res.once("finish", () => {
    requests.total++;
    if (res.statusCode === 429 || (res.statusCode === 503 && res.hasHeader("Retry-After"))) requests.rejected++;
    else if (res.statusCode >= 500) requests.errors++;
    const elapsed = performance.now() - start;
    requests.durationBuckets[buckets.findIndex(bound => elapsed <= bound)]++;
  });
  next();
};
export function performanceSnapshot() {
  return { budget: costControlState(), requests, bucketUpperMs: buckets.map(n => Number.isFinite(n) ? n : "infinity"), cache: cacheMetrics, database: databaseMetrics,
    memory: process.memoryUsage(), cpu: process.cpuUsage(), uptimeSeconds: process.uptime(), eventLoopP95Ms: histogram.percentile(95) / 1e6 };
}
