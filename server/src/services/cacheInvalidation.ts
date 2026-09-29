import { withCapacityLease } from "../lib/leases.js";
import { CapacityError } from "../lib/capacity.js";
import type { RequestHandler } from "express";
import { prisma } from "../lib/prisma.js";
import { invalidate } from "../lib/cache.js";
import { capacity } from "../lib/capacity.js";
import { clearSettingsCache } from "../lib/settings.js";
import { clearSourceCache, invalidateSource } from "./website/sourceCache.js";

let delivering: Promise<void> | null = null;
const observed = new Set<number>();
let scanCursor = 0;
let lastFullClear = 0;
let polling = false;
let lastPollAt = 0;

/** Every process consumes local invalidations independently of Redis/CDN delivery. */
export async function pollLocalInvalidations() {
  if (polling) return;
  polling = true;
  try {
    if (Date.now() - lastFullClear > 15_000 || (lastPollAt && Date.now() - lastPollAt > 15_000)) {
      clearSourceCache(); clearSettingsCache(); lastFullClear = Date.now();
    }
    lastPollAt = Date.now();
    // Read-only keyset scans avoid one acknowledgement write per replica per event.
    // Rescan from zero after the tail: sequence allocation order is not commit order.
    const events = await prisma.cacheInvalidation.findMany({ where: { id: { gt: scanCursor } },
      select: { id: true, siteId: true, resource: true }, orderBy: { id: "asc" }, take: 500 });
    scanCursor = events.length === 500 ? events[events.length - 1]!.id : 0;
    if (observed.size + events.length > 50_000) {
      observed.clear(); clearSourceCache(); clearSettingsCache();
    }
    for (const event of events) {
      if (observed.has(event.id)) continue;
      observed.add(event.id);
      if (event.siteId) invalidateSource(event.siteId);
      if (event.resource === "settings") clearSettingsCache();
    }
  } catch { clearSourceCache(); clearSettingsCache(); }
  finally { polling = false; }
}

/** Explicit host-to-zone mapping prevents tokens being used for arbitrary customer domains. */
export function cloudflareZones(): Record<string, string> {
  const zones = JSON.parse(process.env.CLOUDFLARE_HOST_ZONES ?? "{}") as Record<string, string>;
  if (!zones || Array.isArray(zones) || Object.values(zones).some(v => typeof v !== "string" || !/^[a-f0-9]{32}$/.test(v))) throw new Error("Invalid CLOUDFLARE_HOST_ZONES");
  return zones;
}

async function purgeUrls(urls: string[]) {
  if (!capacity.edge) return;
  const zones = cloudflareZones();
  const groups = new Map<string, string[]>();
  for (const value of new Set(urls)) {
    const url = new URL(value);
    const zone = zones[url.hostname];
    if (!zone) continue; // Unproxied hosts have no edge cache to invalidate.
    if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("Cloudflare purge token missing");
    const group = groups.get(zone) ?? [];
    if (!group.includes(url.hostname)) group.push(url.hostname);
    groups.set(zone, group);
  }
  for (const [zone, files] of groups) {
    for (let i = 0; i < files.length; i += 30) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
        // Host purging also clears aliases and query-string variants after a site-wide change.
        body: JSON.stringify({ hosts: files.slice(i, i + 30) }),
      });
      const body = await response.json() as { success?: boolean };
      if (!response.ok || body.success !== true) throw new Error(`Cloudflare purge failed (${response.status})`);
    }
  }
}

export async function deliverInvalidations(): Promise<void> {
  if (delivering) return delivering;
  delivering = (async () => {
    const waiting = await prisma.cacheInvalidation.findFirst({ where: { deliveredAt: null, nextAttemptAt: { lte: new Date() } }, select: { id: true } });
    if (!waiting) return;
    try {
      await withCapacityLease("cache-invalidation", 1, async () => {
        const events = await prisma.cacheInvalidation.findMany({ where: { deliveredAt: null, nextAttemptAt: { lte: new Date() } }, orderBy: { id: "asc" }, take: 100 });
        const groups = new Map<string, typeof events>();
        for (const event of events) {
          const key = JSON.stringify([event.scope, event.resource, event.resource === "hosts" ? null : event.siteId]);
          const group = groups.get(key) ?? []; group.push(event); groups.set(key, group);
        }
        const sites = await prisma.site.findMany({ where: { id: { in: [...new Set(events.filter(event => event.resource === "pages").flatMap(event => event.siteId ? [event.siteId] : []))] } },
          select: { id: true, publicUrl: true, customDomain: true, customDomainVerifiedAt: true, hostedSlug: true } });
        for (const group of groups.values()) {
          const event = group[0]!;
          const ids = group.map(row => row.id);
          try {
            await invalidate(event.resource === "pages" && event.siteId ? `public:${event.siteId}` : event.scope, event.resource);
            if (event.resource === "pages") {
              const site = sites.find(row => row.id === event.siteId);
              const bases = site ? [site.publicUrl,
                ...(site.customDomain && site.customDomainVerifiedAt ? [`https://${site.customDomain}`] : []),
                ...(site.hostedSlug && process.env.WEBSITE_HOST_DOMAIN ? [`https://${site.hostedSlug}.${process.env.WEBSITE_HOST_DOMAIN}`] : [])] : [];
              const previousHosted = process.env.WEBSITE_HOST_DOMAIN
                ? group.flatMap(row => row.hostedSlugs.map(slug => `https://${slug}.${process.env.WEBSITE_HOST_DOMAIN}`)) : [];
              await purgeUrls([...group.flatMap(row => row.urls), ...bases, ...previousHosted]);
            }
            await prisma.cacheInvalidation.updateMany({ where: { id: { in: ids }, deliveredAt: null }, data: { deliveredAt: new Date(), lastError: null } });
          } catch {
            await prisma.cacheInvalidation.updateMany({ where: { id: { in: ids }, deliveredAt: null }, data: {
              attempts: { increment: 1 }, lastError: "Cache or CDN delivery failed; retry scheduled",
              nextAttemptAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(Math.max(...group.map(row => row.attempts)), 6))),
            } });
          }
        }
      });
    } catch (error) {
      if (!(error instanceof CapacityError)) throw error; // Another process owns delivery.
    }
  })().finally(() => { delivering = null; });
  return delivering;
}

/** Writes trigger immediate delivery; the worker retries if this process disappears. */
export const invalidateAfterWrite: RequestHandler = (req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) res.once("finish", () => {
    if (res.statusCode < 400) {
      void pollLocalInvalidations();
      void deliverInvalidations().catch(() => undefined);
    }
  });
  next();
};

export function startLocalInvalidations() {
  clearSourceCache(); clearSettingsCache();
  const timer = setInterval(() => { void pollLocalInvalidations(); }, 2000);
  timer.unref();
  return () => clearInterval(timer);
}
