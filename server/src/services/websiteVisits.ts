import crypto from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";

/**
 * How many people visit a website DakyX hosts, and from where.
 *
 * Counted on the server as the hosting middleware serves each page, so there is
 * nothing on the customer's page: no script, no cookie, no banner to ask
 * permission for, and nothing an ad blocker can take away. No IP address is
 * stored. A visitor is recognised for one day by a hash of their address and
 * browser with a salt that is never written down and changes every day, so
 * yesterday's visitor cannot be linked to today's and neither to a person.
 *
 * Counts are held in memory and written every thirty seconds rather than on
 * every request; a deploy can lose the last few seconds, which is the right
 * trade for a page view. Restarting also re-salts, so somebody who comes back
 * after a deploy is counted twice that day — a small overcount, never a lost
 * visitor.
 */

const BOT = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|monitor|curl|wget|python|httpclient|go-http|java\/|okhttp|headless|lighthouse|pingdom|uptime|scan/i;
const PHONE = /Mobi|Android(?!.*Tablet)|iPhone|iPod/i;
const SEARCH: Array<[RegExp, string]> = [
  [/(^|\.)google\./, "Google"],
  [/(^|\.)bing\.com$/, "Bing"],
  [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)yahoo\./, "Yahoo"],
  [/(^|\.)yandex\./, "Yandex"],
];
const SOCIAL: Array<[RegExp, string]> = [
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)l\.facebook\.com$/, "Facebook"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)t\.co$|(^|\.)twitter\.com$|(^|\.)x\.com$/, "X (Twitter)"],
  [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/, "LinkedIn"],
  [/(^|\.)tiktok\.com$/, "TikTok"],
  [/(^|\.)whatsapp\.com$|(^|\.)wa\.me$/, "WhatsApp"],
];

/** Where a visit came from, in words a business owner reads. Null for a click inside the same site. */
export function sourceOf(referer: string | undefined, host: string): string | null {
  if (!referer) return "Direct";
  let from: string;
  try { from = new URL(referer).hostname.toLowerCase().replace(/^www\./, ""); } catch { return "Direct"; }
  if (!from || from === host.replace(/^www\./, "")) return null;
  for (const [pattern, name] of SEARCH) if (pattern.test(from)) return `Search · ${name}`;
  for (const [pattern, name] of SOCIAL) if (pattern.test(from)) return name;
  return from.slice(0, 120);
}

type Pending = { views: number; visitors: number; phone: number };
const pendingPages = new Map<string, Pending>();
const pendingSources = new Map<string, number>();
const seen = new Set<string>();
let salt = { day: "", value: "" };
let timer: NodeJS.Timeout | null = null;

function dailySalt(day: string): string {
  if (salt.day !== day) {
    salt = { day, value: crypto.randomBytes(16).toString("hex") };
    seen.clear();
  }
  return salt.value;
}

function bump(key: string, views: number, visitors: number, phone: number) {
  const row = pendingPages.get(key) ?? { views: 0, visitors: 0, phone: 0 };
  row.views += views;
  row.visitors += visitors;
  row.phone += phone;
  pendingPages.set(key, row);
}

/** Called by the hosting middleware once a page has been served to somebody. */
export function recordVisit(siteId: string, req: Request, path: string, host: string): void {
  if (req.method !== "GET") return;
  const agent = String(req.headers["user-agent"] ?? "");
  if (!agent || BOT.test(agent)) return;
  const purpose = String(req.headers["sec-purpose"] ?? req.headers["purpose"] ?? "");
  if (/prefetch|prerender/i.test(purpose)) return;

  const day = new Date().toISOString().slice(0, 10);
  const visitor = crypto.createHash("sha256").update(`${dailySalt(day)}|${siteId}|${req.ip ?? ""}|${agent}`).digest("base64url");
  const phone = PHONE.test(agent) ? 1 : 0;
  // A Set this size is a lot of visitors for one process; past it, stop
  // telling them apart for the rest of the day rather than grow without end.
  const newToSite = seen.size < 200_000 && !seen.has(visitor);
  const pageKey = `${visitor}|${path}`;
  const newToPage = seen.size < 200_000 && !seen.has(pageKey);
  if (newToSite) seen.add(visitor);
  if (newToPage) seen.add(pageKey);

  bump(`${siteId}|${day}|*`, 1, newToSite ? 1 : 0, phone);
  bump(`${siteId}|${day}|${path.slice(0, 300)}`, 1, newToPage ? 1 : 0, phone);
  const source = sourceOf(typeof req.headers.referer === "string" ? req.headers.referer : undefined, host);
  if (source) pendingSources.set(`${siteId}|${day}|${source}`, (pendingSources.get(`${siteId}|${day}|${source}`) ?? 0) + 1);

  if (!timer) {
    timer = setInterval(() => void flushVisits().catch((error) => console.warn(`[visits] could not write counts: ${(error as Error).message}`)), 30_000);
    timer.unref();
  }
}

/** Writes what has been counted since the last write. Exported for checks and shutdown. */
export async function flushVisits(): Promise<number> {
  const pages = [...pendingPages.entries()];
  const sources = [...pendingSources.entries()];
  pendingPages.clear();
  pendingSources.clear();
  for (const [key, counts] of pages) {
    const [siteId, day, path] = key.split("|") as [string, string, string];
    await prisma.siteVisitDay.upsert({
      where: { siteId_day_path: { siteId, day: new Date(`${day}T00:00:00Z`), path } },
      create: { siteId, day: new Date(`${day}T00:00:00Z`), path, ...counts },
      update: { views: { increment: counts.views }, visitors: { increment: counts.visitors }, phone: { increment: counts.phone } },
    }).catch((error: { code?: string }) => {
      // The site was deleted between the visit and the write. Nothing to keep.
      if (error.code !== "P2003" && error.code !== "P2025") throw error;
    });
  }
  for (const [key, views] of sources) {
    const [siteId, day, source] = key.split("|") as [string, string, string];
    await prisma.siteReferrerDay.upsert({
      where: { siteId_day_source: { siteId, day: new Date(`${day}T00:00:00Z`), source } },
      create: { siteId, day: new Date(`${day}T00:00:00Z`), source, views },
      update: { views: { increment: views } },
    }).catch((error: { code?: string }) => {
      if (error.code !== "P2003" && error.code !== "P2025") throw error;
    });
  }
  return pages.length + sources.length;
}

const rangeQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

export function registerWebsiteVisitRoutes(router: Router) {
  const handle = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

  /** Counts only — nothing in here identifies anybody, so anybody the site is shared with may read it. */
  router.get("/sites/:siteId/visits", handle(async (req, res) => {
    await assertWebsiteSiteAccess(req, req.params.siteId!, "view");
    const { days } = rangeQuery.parse(req.query);
    const since = new Date(Date.now() - (days - 1) * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const siteId = req.params.siteId!;
    const [daily, pages, sources] = await Promise.all([
      prisma.siteVisitDay.findMany({ where: { siteId, path: "*", day: { gte: since } }, orderBy: { day: "asc" }, select: { day: true, views: true, visitors: true, phone: true } }),
      prisma.siteVisitDay.groupBy({ by: ["path"], where: { siteId, path: { not: "*" }, day: { gte: since } }, _sum: { views: true }, orderBy: { _sum: { views: "desc" } }, take: 10 }),
      prisma.siteReferrerDay.groupBy({ by: ["source"], where: { siteId, day: { gte: since } }, _sum: { views: true }, orderBy: { _sum: { views: "desc" } }, take: 10 }),
    ]);
    const byDay = new Map(daily.map((row) => [row.day.toISOString().slice(0, 10), row]));
    const series = Array.from({ length: days }, (_, index) => {
      const day = new Date(since.getTime() + index * 86_400_000).toISOString().slice(0, 10);
      const row = byDay.get(day);
      return { day, views: row?.views ?? 0, visitors: row?.visitors ?? 0 };
    });
    const views = daily.reduce((sum, row) => sum + row.views, 0);
    const phone = daily.reduce((sum, row) => sum + row.phone, 0);
    res.set("Cache-Control", "no-store").json({
      days,
      totals: { views, visitors: daily.reduce((sum, row) => sum + row.visitors, 0), phoneShare: views ? Math.round((phone / views) * 100) : 0 },
      series,
      pages: pages.map((row) => ({ path: row.path, views: row._sum.views ?? 0 })),
      sources: sources.map((row) => ({ source: row.source, views: row._sum.views ?? 0 })),
    });
  }));
}
