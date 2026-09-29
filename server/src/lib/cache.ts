import { createHash, randomUUID } from "node:crypto";
import { createClient } from "redis";
import { capacity, concurrencyGate } from "./capacity.js";
import { bypassRequestCache } from "./requestCache.js";

export type CacheKey = { scope: string; resource: string; identity: string; revision?: string; query?: unknown };
export type CachePolicy = { ttlMs: number; maxBytes?: number; bypass?: boolean; cacheNull?: boolean };
type Envelope<T> = { version: 1; createdAt: number; expiresAt: number; value: T };
export interface CacheBackend {
  close?(): Promise<void>;
  generation(key: string): Promise<string>;
  get(key: string): Promise<string | null>;
  put(key: string, generationKey: string, generation: string, value: string, ttl: number): Promise<void>;
  invalidate(key: string): Promise<void>;
}
export const cacheMetrics = { hits: 0, misses: 0, errors: 0, oversize: 0, coalesced: 0 };
const prefix = `dw:${process.env.RAILWAY_ENVIRONMENT_ID ?? process.env.NODE_ENV ?? "development"}:v1`;
const part = (value: string) => encodeURIComponent(value);
export function cacheNamespace(key: Pick<CacheKey, "scope" | "resource">) { return `${prefix}:${part(key.scope)}:${part(key.resource)}`; }
export function cacheKey(key: CacheKey) {
  const query = createHash("sha256").update(JSON.stringify(key.query ?? null)).digest("hex");
  return `${cacheNamespace(key)}:${part(key.identity)}:${part(key.revision ?? "")}:${query}`;
}

/** Unique generations remain safe even if Redis evicts the generation key. */
export function redisBackend(): CacheBackend | null {
  if (!process.env.REDIS_URL) return null;
  const client = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true, commandsQueueMaxLength: 100,
    socket: { connectTimeout: 1000, reconnectStrategy: retries => Math.min(1000 * (retries + 1), 10_000) } });
  client.on("error", () => { /* Cache errors are counted without logging connection secrets. */ });
  void client.connect().catch(() => undefined);
  return {
    close: async () => { client.destroy(); },
    generation: async key => String(await client.eval(
      "local v=redis.call('GET',KEYS[1]); if not v then v=ARGV[1]; redis.call('SET',KEYS[1],v,'PX',86400000); end; return v",
      { keys: [key], arguments: [randomUUID()] })),
    get: key => client.get(key),
    put: async (key, generationKey, generation, value, ttl) => {
      await client.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); end; return 0",
        { keys: [generationKey, key], arguments: [generation, value, String(ttl)] });
    },
    invalidate: async key => { await client.set(key, randomUUID(), { PX: 86_400_000 }); },
  };
}

export function createCache(backend: CacheBackend | null, enabled = capacity.cache) {
  const inFlight = new Map<string, Promise<unknown>>();
  const fallback = concurrencyGate(capacity.fallbackConcurrency);
  let failures = 0;
  let openUntil = 0;
  async function redis<T>(work: () => Promise<T>): Promise<T> {
    if (Date.now() < openUntil) throw new Error("Cache circuit open");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Cache timeout")), 100); })]);
      failures = 0;
      return value;
    } catch (error) {
      cacheMetrics.errors++;
      if (++failures >= 3) openUntil = Date.now() + 5000;
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
  return {
    async getOrLoad<T>(input: CacheKey, policy: CachePolicy, loader: () => Promise<T>): Promise<T> {
      if (!enabled || !backend || policy.bypass || bypassRequestCache()) return fallback(loader);
      const generationKey = `${cacheNamespace(input)}:generation`;
      let generation: string;
      try { generation = await redis(() => backend.generation(generationKey)); }
      catch { return fallback(loader); }
      const key = `${cacheKey(input)}:${generation}`;
      try {
        const raw = await redis(() => backend.get(key));
        if (raw) {
          const cached = JSON.parse(raw) as Envelope<T> | null;
          if (cached && cached.version === 1 && Number.isFinite(cached.expiresAt) && cached.expiresAt > Date.now()
            && Object.prototype.hasOwnProperty.call(cached, "value")
            && !(cached.value === null && policy.cacheNull === false)) {
            cacheMetrics.hits++;
            return cached.value;
          }
        }
      } catch { /* Corrupt and unavailable entries are misses. */ }
      const pending = inFlight.get(key);
      if (pending) { cacheMetrics.coalesced++; return pending as Promise<T>; }
      cacheMetrics.misses++;
      const work = fallback(async () => {
        const value = await loader();
        if (value === undefined || (value === null && policy.cacheNull === false)) return value;
        const ttl = Math.max(1, Math.round(policy.ttlMs * (0.9 + Math.random() * 0.2)));
        const createdAt = Date.now();
        let raw: string;
        try {
          raw = JSON.stringify({ version: 1, createdAt, expiresAt: createdAt + ttl, value } satisfies Envelope<T>);
        } catch {
          // Caching is optional: serialization must not turn a successful source read into a failure.
          cacheMetrics.errors++;
          return value;
        }
        if (Buffer.byteLength(raw) <= (policy.maxBytes ?? 256 * 1024)) {
          try { await redis(() => backend.put(key, generationKey, generation, raw, ttl)); } catch { /* The source remains authoritative. */ }
        } else cacheMetrics.oversize++;
        return value;
      });
      inFlight.set(key, work);
      try { return await work; } finally { inFlight.delete(key); }
    },
    async invalidate(scope: string, resource: string) {
      if (!enabled) return;
      if (!backend) throw new Error("Response caching requires REDIS_URL");
      await redis(() => backend.invalidate(`${cacheNamespace({ scope, resource })}:generation`));
    },
  };
}
export const sharedCache = createCache(capacity.cache ? redisBackend() : null);
export const getOrLoad = sharedCache.getOrLoad;
export const invalidate = sharedCache.invalidate;
