import { createHash } from "node:crypto";
import { prisma } from "./prisma.js";

export type RateBucket = { count: number; resetAt: number };

/**
 * Bounded local mode is for development; production counters are shared by all replicas.
 *
 * Full is not an error. This used to throw at `maxKeys`, which the limiter
 * turns into a 503, so five thousand distinct callers in one window took the
 * limited route down for everybody, the legitimate caller included. A full
 * store now makes room: expired buckets first, then the oldest live one. That
 * forgets the oldest caller's count early, which lets them through sooner than
 * their limit says; a rate limiter forgetting the stalest caller is a far
 * smaller failure than one refusing every new caller.
 */
export function localRateStore(maxKeys = 5000) {
  const capacity = Math.max(1, Math.floor(maxKeys));
  const hits = new Map<string, RateBucket>();
  let sweep = hits.entries();
  return {
    take(key: string, windowMs: number, max: number, now = Date.now()): RateBucket {
      // Incremental expiry has constant work per request, even with many distinct callers.
      for (let i = 0; i < 16; i++) {
        const item = sweep.next();
        if (item.done) { sweep = hits.entries(); break; }
        if (item.value[1].resetAt <= now) hits.delete(item.value[0]);
      }
      const seen = hits.get(key);
      if (seen && seen.resetAt > now) { seen.count = Math.min(max + 1, seen.count + 1); return seen; }
      // Re-inserted rather than overwritten, so the Map's order stays the order
      // buckets were opened in: the front is always the oldest.
      if (seen) hits.delete(key);
      if (hits.size >= capacity) {
        // Expired first. With one window per limiter the front of the Map is
        // also the first bucket to expire, so a short look there finds them;
        // the look is capped so a store full of live callers costs no more
        // per request than the sweep above.
        let looked = 0;
        for (const [entry, bucket] of hits) {
          if (hits.size < capacity || ++looked > 32) break;
          if (bucket.resetAt <= now) hits.delete(entry);
        }
        while (hits.size >= capacity) hits.delete(hits.keys().next().value as string);
      }
      const fresh = { count: 1, resetAt: now + windowMs };
      hits.set(key, fresh);
      return fresh;
    },
    clear(key: string) { hits.delete(key); },
    get size() { return hits.size; },
  };
}

/**
 * Whether counters live in Postgres, shared by every replica, rather than in
 * this process. The same rule `rateLimit()` in middleware/security.ts applies,
 * for a limiter that is not an Express middleware (the hosted-site form inbox).
 */
export function rateLimitsShared(): boolean {
  return process.env.NODE_ENV === "production" || process.env.RATE_LIMIT_SHARED === "true";
}

export function rateBucketKey(scope: string, key: string) {
  return createHash("sha256").update(JSON.stringify([scope, key])).digest("hex");
}

/** One atomic statement; database time defines the window consistently across replicas. */
export async function takeSharedRateBucket(id: string, windowMs: number, max: number): Promise<RateBucket> {
  const [bucket] = await prisma.$queryRaw<Array<{ count: number; resetAt: Date; now: Date }>>`
    INSERT INTO "RateLimitBucket" ("id", "count", "resetAt") VALUES (${id}, 1, clock_timestamp() + ${windowMs} * INTERVAL '1 millisecond')
    ON CONFLICT ("id") DO UPDATE SET
      "count" = CASE WHEN "RateLimitBucket"."resetAt" <= clock_timestamp() THEN 1 ELSE LEAST("RateLimitBucket"."count" + 1, ${max + 1}) END,
      "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= clock_timestamp() THEN clock_timestamp() + ${windowMs} * INTERVAL '1 millisecond' ELSE "RateLimitBucket"."resetAt" END
    RETURNING "count", "resetAt", clock_timestamp() AS "now"`;
  if (!bucket) throw new Error("Rate limiter unavailable");
  return { count: bucket.count, resetAt: Date.now() + bucket.resetAt.getTime() - bucket.now.getTime() };
}

export async function clearSharedRateBucket(id: string) {
  await prisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE "id" = ${id}`;
}
export async function pruneRateBuckets() {
  await prisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE "id" IN
    (SELECT "id" FROM "RateLimitBucket" WHERE "resetAt" < clock_timestamp() ORDER BY "resetAt" LIMIT 10000)`;
}
