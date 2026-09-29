import express, { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { FileTypeError } from "../lib/fileType.js";
import {
  DemoImportError,
  buildDemo,
  demoSlug,
  demoUrl,
  importDemo,
  prepareImportedDemoHtml,
  recordImportedConcept,
  subjectFromLead,
} from "../services/demoBuilder.js";
import { applyValues, editingSource, fieldValues, type FieldValue } from "../services/website/index.js";
import { appUrl } from "../services/emailSender.js";
import { MAX_UPLOAD_BODY } from "../services/fileStore.js";
import { companyProfile } from "../services/systemProfile.js";
import { gateBy } from "../middleware/permissionGate.js";
import { recordBuild } from "../services/concept/record.js";
import { countryHint } from "./products.js";
import {
  resolveIpLocation,
  countryFlag,
  extractClientIp,
  extractGeoHints,
  isPrivateOrLocalIp,
  maskIp,
} from "../lib/demoGeo.js";
import { parseUserAgent } from "../lib/deviceParser.js";
import { createVisitToken, verifyVisitToken } from "../lib/demoTokens.js";
import { injectDemoTracker } from "../services/demoTracker.js";
import { extractColorsFromHtml } from "../services/website/pageColors.js";

/**
 * Demos: the pages built for prospects, and the public serving of them.
 *
 * Two routers, because they answer to different people. `demosRouter` is the
 * Owner's — list, build, import, rebuild, retire — and sits behind the session
 * like every other API route. `demoPagesRouter` is the prospect's, mounted
 * before the auth middleware in index.ts, and serves one page to anybody
 * holding the link.
 *
 * **The index is deliberately not public.** `/demos/<slug>` is unlisted rather
 * than secret: whoever has the link can open it, which is what makes it
 * sendable in an email. `/demos` on its own falls through to the app, so the
 * list of every business Dakyworld is pitching stays behind the login where it
 * belongs. Publishing that list would tell every prospect who else is being
 * written to.
 */

export const demosRouter = Router();

demosRouter.use(
  gateBy({
    view: "demos.view",
    create: "demos.create",
    // PATCH changes status, URL slug, metadata, or replaces HTML.
    edit: "demos.publish",
    remove: "demos.delete",
  }),
);

// Imported HTML files ride in the JSON body (raw or base64), so this router
// mounts its own larger body parser after the permission check. See index.ts -> UPLOAD_PATHS.
demosRouter.use(express.json({ limit: MAX_UPLOAD_BODY }));

interface DemoBriefMeta {
  imported?: boolean;
  filename?: string | null;
  headline?: string | null;
  includeBanner?: boolean;
  makeInert?: boolean;
  clientId?: string | null;
  clientName?: string | null;
  recipientEmail?: string | null;
  recipientName?: string | null;
  siteId?: string | null;
  sitePageId?: string | null;
  accessMode?: "PUBLIC" | "LINK_ONLY" | "PASSWORD" | "INVITED_ONLY";
  passwordHash?: string | null;
  passwordPlain?: string | null;
  allowedEmails?: string[];
  expiresAt?: string | null;
  notifyOnView?: boolean;
  viewNotifications?: Array<{
    id: string;
    text: string;
    timestamp: string;
    durationSeconds?: number;
    viewerName?: string;
  }>;
}

function readBriefMeta(brief: unknown): DemoBriefMeta {
  if (!brief || typeof brief !== "object") return {};
  return brief as DemoBriefMeta;
}

function readSitePageDraft(draft: unknown): Record<string, FieldValue> {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return {};
  return draft as Record<string, FieldValue>;
}

async function ensureDemoSitePage(
  demo: { id: string; slug: string; title: string; businessName: string; html: string; brief: unknown },
  options: { overwriteSourceHtml?: boolean } = {},
): Promise<{ siteId: string; pageId: string }> {
  const base = await appUrl();
  const publicUrl = demoUrl(demo.slug, base);
  const meta = readBriefMeta(demo.brief);
  const siteName = `${demo.businessName} (Demo)`;
  const pageTitle = demo.title || demo.businessName;

  if (meta.sitePageId) {
    const existingPage = await prisma.sitePage.findUnique({
      where: { id: meta.sitePageId },
      include: { site: true },
    });
    if (existingPage) {
      await prisma.site.update({
        where: { id: existingPage.siteId },
        data: { name: siteName, publicUrl },
      });
      await prisma.sitePage.update({
        where: { id: existingPage.id },
        data: {
          title: pageTitle,
          filePath: `${demo.slug}.html`,
          ...(options.overwriteSourceHtml
            ? {
                sourceHtml: demo.html,
                draft: Prisma.DbNull,
                draftSavedAt: null,
                draftRevision: { increment: 1 },
              }
            : existingPage.sourceHtml === null
              ? { sourceHtml: demo.html }
              : {}),
        },
      });
      return { siteId: existingPage.siteId, pageId: existingPage.id };
    }
  }

  let site = await prisma.site.findFirst({
    where: { publicUrl },
    include: { pages: true },
  });

  let pageId: string;
  let siteId: string;
  const demoColours = extractColorsFromHtml(demo.html, { maxColors: 16 });

  if (!site) {
    const uniqueSiteSlug = `demo-${demo.slug}-${demo.id.slice(-6)}`.slice(0, 60);
    const createdSite = await prisma.site.create({
      data: {
        name: siteName,
        slug: uniqueSiteSlug,
        publicUrl,
        settings: demoColours.length ? { colours: demoColours } : undefined,
        pages: {
          create: {
            path: "/",
            filePath: `${demo.slug}.html`,
            title: pageTitle,
            sourceHtml: demo.html,
          },
        },
      },
      include: { pages: true },
    });
    siteId = createdSite.id;
    pageId = createdSite.pages[0]!.id;
  } else if (site.pages.length === 0) {
    if (demoColours.length && (!site.settings || !(site.settings as Record<string, any>).colours?.length)) {
      const curSettings = (site.settings && typeof site.settings === "object" ? site.settings : {}) as Record<string, any>;
      await prisma.site.update({
        where: { id: site.id },
        data: { settings: { ...curSettings, colours: demoColours } },
      }).catch(() => {});
    }
    const createdPage = await prisma.sitePage.create({
      data: {
        siteId: site.id,
        path: "/",
        filePath: `${demo.slug}.html`,
        title: pageTitle,
        sourceHtml: demo.html,
      },
    });
    siteId = site.id;
    pageId = createdPage.id;
  } else {
    siteId = site.id;
    pageId = site.pages[0]!.id;
    if (demoColours.length && (!site.settings || !(site.settings as Record<string, any>).colours?.length)) {
      const curSettings = (site.settings && typeof site.settings === "object" ? site.settings : {}) as Record<string, any>;
      await prisma.site.update({
        where: { id: site.id },
        data: { settings: { ...curSettings, colours: demoColours } },
      }).catch(() => {});
    }
    if (options.overwriteSourceHtml) {
      await prisma.sitePage.update({
        where: { id: pageId },
        data: {
          title: pageTitle,
          filePath: `${demo.slug}.html`,
          sourceHtml: demo.html,
          draft: Prisma.DbNull,
          draftSavedAt: null,
          draftRevision: { increment: 1 },
        },
      });
    }
  }

  const nextBrief = { ...meta, siteId, sitePageId: pageId };
  await prisma.demo.update({
    where: { id: demo.id },
    data: { brief: nextBrief as never },
  });

  return { siteId, pageId };
}

import { readFile } from "node:fs/promises";
import path from "node:path";

let dakyworldSeedChecked = false;
async function ensureDefaultDakyworldDemo(): Promise<void> {
  if (dakyworldSeedChecked) return;
  try {
    const existing = await prisma.demo.findFirst({
      where: {
        OR: [{ slug: "dakyworld" }, { businessName: { equals: "Dakyworld", mode: "insensitive" } }],
      },
      select: { id: true, slug: true, title: true, businessName: true, html: true, brief: true },
    });
    if (existing) {
      await ensureDemoSitePage(existing, { overwriteSourceHtml: false });
      dakyworldSeedChecked = true;
      return;
    }

    const candidates = [
      path.resolve(process.cwd(), "docs", "dakyworld.html"),
      path.resolve(process.cwd(), "server", "docs", "dakyworld.html"),
    ];
    let htmlContent: string | null = null;
    for (const candidate of candidates) {
      htmlContent = await readFile(candidate, "utf8").catch(() => null);
      if (htmlContent) break;
    }
    if (htmlContent) {
      const result = await importDemo({
        html: htmlContent,
        filename: "dakyworld.html",
        businessName: "Dakyworld",
        title: "Dakyworld® — Your IT Department, Without the Overhead",
        slug: "dakyworld",
        includeBanner: false,
        makeInert: true,
      });
      await ensureDemoSitePage(result.demo, { overwriteSourceHtml: true });
    }
    dakyworldSeedChecked = true;
  } catch {
    /* Optional default seed — never fail the request if unavailable. */
  }
}

const listQuery = z.object({
  status: z.enum(["DRAFT", "READY", "SENT", "ACCEPTED", "DECLINED", "ARCHIVED"]).optional(),
  leadId: z.string().optional(),
  clientId: z.string().optional(),
});

demosRouter.get("/", async (req, res, next) => {
  try {
    await ensureDefaultDakyworldDemo();
    const query = listQuery.parse(req.query);
    const [demos, base] = await Promise.all([
      prisma.demo.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.leadId ? { leadId: query.leadId } : {}),
        },
        orderBy: { updatedAt: "desc" },
        // The HTML is the largest column in the database and no list needs it.
        select: {
          id: true,
          slug: true,
          title: true,
          businessName: true,
          status: true,
          version: true,
          views: true,
          lastViewedAt: true,
          sentAt: true,
          builtBy: true,
          buildCostUsd: true,
          createdAt: true,
          updatedAt: true,
          brief: true,
          references: true,
          visits: {
            select: {
              id: true,
              ip: true,
              country: true,
              countryName: true,
              deviceType: true,
              browser: true,
              durationSeconds: true,
              scrollDepth: true,
              clicks: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
            take: 50,
          },
          lead: { select: { id: true, contactName: true, companyName: true, contactEmail: true, website: true, status: true } },
        },
      }),
      appUrl(),
    ]);

    const clientIds = [
      ...new Set(
        demos
          .map((demo) => readBriefMeta(demo.brief).clientId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    const clients = clientIds.length
      ? await prisma.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, name: true, company: true, email: true },
        })
      : [];
    const clientById = new Map(clients.map((client) => [client.id, client]));

    const enriched = demos
      .map((demo) => {
        const meta = readBriefMeta(demo.brief);
        const client = meta.clientId ? (clientById.get(meta.clientId) ?? null) : null;

        const uniqueIps = new Set(
          demo.visits.map((v) => v.ip).filter((ip): ip is string => Boolean(ip)),
        );
        const uniqueVisitors = Math.max(uniqueIps.size, demo.visits.length > 0 ? 1 : 0);
        const totalDuration = demo.visits.reduce((acc, v) => acc + (v.durationSeconds || 0), 0);
        const avgDurationSeconds = demo.visits.length > 0 ? Math.round(totalDuration / demo.visits.length) : 0;
        let totalClicks = 0;
        for (const v of demo.visits) {
          if (Array.isArray(v.clicks)) totalClicks += v.clicks.length;
        }

        const countryCounts: Record<string, { code: string; name: string; flag: string; count: number }> = {};
        for (const v of demo.visits) {
          if (v.country) {
            if (!countryCounts[v.country]) {
              countryCounts[v.country] = {
                code: v.country,
                name: v.countryName || v.country,
                flag: countryFlag(v.country),
                count: 0,
              };
            }
            countryCounts[v.country].count++;
          }
        }
        const topCountry = Object.values(countryCounts).sort((a, b) => b.count - a.count)[0] || null;

        const deviceCounts: Record<string, number> = {};
        for (const v of demo.visits) {
          if (v.deviceType) {
            deviceCounts[v.deviceType] = (deviceCounts[v.deviceType] || 0) + 1;
          }
        }
        const topDevice = Object.entries(deviceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

        const analytics = {
          views: demo.views,
          uniqueVisitors,
          avgDurationSeconds,
          totalClicks,
          topCountry,
          topDevice,
          recentVisitsCount: demo.visits.length,
        };

        const { visits: _visits, ...demoWithoutVisits } = demo;

        return {
          ...demoWithoutVisits,
          url: demoUrl(demo.slug, base),
          client,
          analytics,
          recipientEmail: meta.recipientEmail ?? demo.lead?.contactEmail ?? client?.email ?? null,
          recipientName: meta.recipientName ?? demo.lead?.contactName ?? client?.name ?? null,
        };
      })
      .filter((demo) => !query.clientId || demo.client?.id === query.clientId);

    res.json({ demos: enriched, base });
  } catch (err) {
    next(err);
  }
});

demosRouter.get("/:id/analytics", async (req, res, next) => {
  try {
    const demo = await prisma.demo.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        slug: true,
        title: true,
        businessName: true,
        views: true,
        lastViewedAt: true,
        createdAt: true,
      },
    });
    if (!demo) return res.status(404).json({ error: "Demo not found" });

    const base = await appUrl();
    const url = demoUrl(demo.slug, base);

    const range = req.query.range as string | undefined;
    const includeBots = req.query.includeBots === "true";
    const includeInternal = req.query.includeInternal === "true";
    const format = req.query.format as string | undefined;

    let dateFilter: Prisma.DateTimeFilter | undefined;
    const now = new Date();
    if (req.query.startDate || req.query.endDate) {
      dateFilter = {
        ...(req.query.startDate ? { gte: new Date(String(req.query.startDate)) } : {}),
        ...(req.query.endDate ? { lte: new Date(String(req.query.endDate)) } : {}),
      };
    } else if (range === "7d") {
      dateFilter = { gte: new Date(now.getTime() - 7 * 86400 * 1000) };
    } else if (range === "30d") {
      dateFilter = { gte: new Date(now.getTime() - 30 * 86400 * 1000) };
    } else if (range === "90d") {
      dateFilter = { gte: new Date(now.getTime() - 90 * 86400 * 1000) };
    }

    const where: Prisma.DemoVisitWhereInput = {
      demoId: demo.id,
      ...(dateFilter ? { createdAt: dateFilter } : {}),
      ...(includeBots ? {} : { deviceType: { not: "bot" } }),
    };

    // Aggregate over the entire selected date range without hardcoded caps
    const rawVisits = await prisma.demoVisit.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    const visits = includeInternal
      ? rawVisits
      : rawVisits.filter((v) => !isPrivateOrLocalIp(v.ip));

    // Handle CSV export matching the exact filtered population and date range
    if (format === "csv") {
      const csvHeader = [
        "Visit ID",
        "Opened At",
        "Session ID",
        "Country",
        "City",
        "Device",
        "Browser",
        "OS",
        "Duration (s)",
        "Scroll Depth (%)",
        "Clicks",
        "Masked IP",
      ].join(",");
      const csvLines = visits.map((v) => {
        const clickList = Array.isArray(v.clicks) ? (v.clicks as any[]) : [];
        return [
          `"${v.id}"`,
          `"${v.createdAt.toISOString()}"`,
          `"${v.sessionId}"`,
          `"${v.countryName || v.country || "Unknown"}"`,
          `"${v.city || "City unavailable"}"`,
          `"${v.deviceType || "desktop"}"`,
          `"${v.browser || "unknown"}"`,
          `"${v.os || "unknown"}"`,
          v.durationSeconds,
          v.scrollDepth,
          clickList.length,
          `"${maskIp(v.ip) || ""}"`,
        ].join(",");
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${demo.slug}-analytics.csv"`);
      return res.status(200).send([csvHeader, ...csvLines].join("\n"));
    }

    const uniqueSessions = new Set(visits.map((v) => v.sessionId).filter(Boolean));
    const uniqueVisitors = uniqueSessions.size;

    const measuredDurations = visits.map((v) => v.durationSeconds).filter((d) => d > 0);
    const avgDurationSeconds =
      measuredDurations.length > 0
        ? Math.round(measuredDurations.reduce((acc, d) => acc + d, 0) / measuredDurations.length)
        : 0;

    const measuredScrolls = visits.map((v) => v.scrollDepth).filter((s) => s > 0);
    const avgScrollDepth =
      measuredScrolls.length > 0
        ? Math.round(measuredScrolls.reduce((acc, s) => acc + s, 0) / measuredScrolls.length)
        : null;

    let totalClicks = 0;
    let bouncedCount = 0;
    const allClicks: Array<{
      x: number;
      y: number;
      xPercent: number;
      yPercent: number;
      targetTag?: string;
      targetText?: string;
      targetSelector?: string;
      timeOffset?: number;
      visitId: string;
      sessionId: string;
      deviceType?: string | null;
      browser?: string | null;
      os?: string | null;
      ip?: string | null;
      country?: string | null;
      countryName?: string | null;
      city?: string | null;
      isLocal?: boolean;
      flag?: string;
      createdAt: string;
    }> = [];

    const countryMap: Record<string, { code: string; name: string; flag: string; count: number }> = {};
    const cityMap: Record<string, { city: string; country: string; flag: string; count: number; unverified: boolean }> = {};
    const deviceMap: Record<string, number> = {};
    const browserMap: Record<string, number> = {};
    const osMap: Record<string, number> = {};
    const elementClickMap: Record<string, { selector: string; tag: string; text: string; count: number }> = {};

    for (const v of visits) {
      const clickList = Array.isArray(v.clicks) ? (v.clicks as any[]) : [];
      totalClicks += clickList.length;

      const isBounced = (v.durationSeconds || 0) < 5 && (v.scrollDepth || 0) < 25 && clickList.length === 0;
      if (isBounced) {
        bouncedCount++;
      }

      const cCode = v.country || (isPrivateOrLocalIp(v.ip) ? "LOCAL" : "UNKNOWN");
      if (!countryMap[cCode]) {
        countryMap[cCode] = {
          code: cCode,
          name: v.countryName || (cCode === "LOCAL" ? "Local Development" : "Unresolved"),
          flag: countryFlag(v.country),
          count: 0,
        };
      }
      countryMap[cCode].count++;

      if (v.city) {
        const cityKey = `${v.city}||${v.country || "UNKNOWN"}`;
        if (!cityMap[cityKey]) {
          cityMap[cityKey] = {
            city: v.city,
            country: v.countryName || v.country || "Unknown",
            flag: countryFlag(v.country),
            count: 0,
            unverified: true, // Legacy cities classified as unverified
          };
        }
        cityMap[cityKey].count++;
      }

      if (v.deviceType) {
        deviceMap[v.deviceType] = (deviceMap[v.deviceType] || 0) + 1;
      }
      if (v.browser) {
        browserMap[v.browser] = (browserMap[v.browser] || 0) + 1;
      }
      if (v.os) {
        osMap[v.os] = (osMap[v.os] || 0) + 1;
      }

      for (const c of clickList) {
        const enrichedClick = {
          x: typeof c.x === "number" ? c.x : 0,
          y: typeof c.y === "number" ? c.y : 0,
          xPercent: typeof c.xPercent === "number" ? c.xPercent : 0,
          yPercent: typeof c.yPercent === "number" ? c.yPercent : 0,
          targetTag: c.targetTag || "ELEMENT",
          targetText: c.targetText || "",
          targetSelector: c.targetSelector || "",
          timeOffset: typeof c.timeOffset === "number" ? c.timeOffset : 0,
          visitId: v.id,
          sessionId: v.sessionId,
          deviceType: v.deviceType,
          browser: v.browser,
          os: v.os,
          ip: maskIp(v.ip),
          country: v.country,
          countryName: v.countryName,
          city: v.city,
          isLocal: isPrivateOrLocalIp(v.ip),
          flag: countryFlag(v.country),
          createdAt: v.createdAt.toISOString(),
        };
        allClicks.push(enrichedClick);

        const elKey = `${c.targetSelector || c.targetTag || "element"}||${c.targetText || ""}`;
        if (!elementClickMap[elKey]) {
          elementClickMap[elKey] = {
            selector: c.targetSelector || c.targetTag || "element",
            tag: c.targetTag || "ELEMENT",
            text: c.targetText || "",
            count: 0,
          };
        }
        elementClickMap[elKey].count++;
      }
    }

    const totalV = Math.max(1, visits.length);
    const countryBreakdown = Object.values(countryMap)
      .map((c) => ({ ...c, percentage: Math.round((c.count / totalV) * 100) }))
      .sort((a, b) => b.count - a.count);

    const cityBreakdown = Object.values(cityMap)
      .map((c) => ({ ...c, percentage: Math.round((c.count / totalV) * 100) }))
      .sort((a, b) => b.count - a.count);

    const deviceBreakdown = Object.entries(deviceMap)
      .map(([deviceType, count]) => ({ deviceType, count, percentage: Math.round((count / totalV) * 100) }))
      .sort((a, b) => b.count - a.count);

    const browserBreakdown = Object.entries(browserMap)
      .map(([browser, count]) => ({ browser, count, percentage: Math.round((count / totalV) * 100) }))
      .sort((a, b) => b.count - a.count);

    const osBreakdown = Object.entries(osMap)
      .map(([os, count]) => ({ os, count, percentage: Math.round((count / totalV) * 100) }))
      .sort((a, b) => b.count - a.count);

    const topClickedElements = Object.values(elementClickMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)
      .map((item) => ({
        ...item,
        percentage: totalClicks > 0 ? Math.round((item.count / totalClicks) * 100) : 0,
      }));

    const bounceRate = visits.length > 0 ? Math.round((bouncedCount / visits.length) * 100) : 0;

    // Paginate detail visit rows rather than truncating aggregate analytics
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(String(req.query.limit || "50"), 10) || 50));
    const totalPages = Math.ceil(visits.length / limit) || 1;
    const paginatedVisits = visits.slice((page - 1) * limit, page * limit);

    const formattedVisits = paginatedVisits.map((v) => {
      const clickList = Array.isArray(v.clicks) ? (v.clicks as any[]) : [];
      return {
        id: v.id,
        sessionId: v.sessionId,
        ip: maskIp(v.ip),
        country: v.country,
        countryName: v.countryName,
        flag: countryFlag(v.country),
        city: v.city,
        citySource: v.city ? "unverified" : "none",
        isLocal: isPrivateOrLocalIp(v.ip),
        userAgent: v.userAgent,
        deviceType: v.deviceType,
        browser: v.browser,
        os: v.os,
        viewportWidth: v.viewportWidth,
        viewportHeight: v.viewportHeight,
        screenWidth: v.screenWidth,
        screenHeight: v.screenHeight,
        durationSeconds: v.durationSeconds,
        scrollDepth: v.scrollDepth,
        clickCount: clickList.length,
        clicks: clickList,
        createdAt: v.createdAt.toISOString(),
        updatedAt: v.updatedAt.toISOString(),
      };
    });

    res.json({
      demo: {
        ...demo,
        url,
      },
      summary: {
        totalViews: demo.views,
        periodViews: visits.length,
        uniqueVisitors,
        totalVisits: visits.length,
        avgDurationSeconds,
        avgScrollDepth,
        totalClicks,
        bounceRate,
      },
      breakdowns: {
        countries: countryBreakdown,
        cities: cityBreakdown,
        devices: deviceBreakdown,
        browsers: browserBreakdown,
        os: osBreakdown,
      },
      visits: formattedVisits,
      pagination: {
        page,
        limit,
        total: visits.length,
        totalPages,
      },
      heatmap: {
        totalClicks,
        clicks: allClicks,
        topClickedElements,
      },
    });
  } catch (err) {
    next(err);
  }
});

demosRouter.get("/:id", async (req, res, next) => {
  try {
    const demo = await prisma.demo.findUnique({
      where: { id: req.params.id },
      include: { lead: { select: { id: true, contactName: true, companyName: true, contactEmail: true, website: true } } },
    });
    if (!demo) return res.status(404).json({ error: "No such demo" });
    const meta = readBriefMeta(demo.brief);
    const client = meta.clientId
      ? await prisma.client.findUnique({
          where: { id: meta.clientId },
          select: { id: true, name: true, company: true, email: true },
        })
      : null;
    res.json({
      ...demo,
      url: demoUrl(demo.slug, await appUrl()),
      client,
      recipientEmail: meta.recipientEmail ?? demo.lead?.contactEmail ?? client?.email ?? null,
      recipientName: meta.recipientName ?? demo.lead?.contactName ?? client?.name ?? null,
    });
  } catch (err) {
    next(err);
  }
});

demosRouter.get("/:id/download", async (req, res, next) => {
  try {
    const demo = await prisma.demo.findUnique({
      where: { id: req.params.id },
      select: { slug: true, html: true },
    });
    if (!demo) return res.status(404).json({ error: "No such demo" });
    const safeSlug = demo.slug.replace(/[^a-z0-9\-_]+/gi, "-") || "demo";
    res
      .status(200)
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeSlug}.html"`,
      })
      .send(demo.html);
  } catch (err) {
    next(err);
  }
});

demosRouter.get("/:id/open-editor", async (req, res, next) => {
  try {
    const demo = await prisma.demo.findUnique({ where: { id: req.params.id } });
    if (!demo) return res.status(404).json({ error: "No such demo" });
    const editor = await ensureDemoSitePage(demo, { overwriteSourceHtml: false });
    res.json({
      pageId: editor.pageId,
      siteId: editor.siteId,
      editorUrl: `/website/pages/${editor.pageId}?demoId=${demo.id}&mode=edit`,
    });
  } catch (err) {
    next(err);
  }
});

demosRouter.post("/:id/open-editor", async (req, res, next) => {
  try {
    const demo = await prisma.demo.findUnique({ where: { id: req.params.id } });
    if (!demo) return res.status(404).json({ error: "No such demo" });
    const editor = await ensureDemoSitePage(demo, { overwriteSourceHtml: false });
    res.json({
      pageId: editor.pageId,
      siteId: editor.siteId,
      editorUrl: `/website/pages/${editor.pageId}?demoId=${demo.id}&mode=edit`,
    });
  } catch (err) {
    next(err);
  }
});

const importInput = z.object({
  html: z.string().nullish(),
  dataBase64: z.string().nullish(),
  filename: z.string().max(240).nullish(),
  businessName: z.string().max(200).nullish(),
  title: z.string().max(200).nullish(),
  slug: z.string().max(100).nullish(),
  leadId: z.string().nullish(),
  clientId: z.string().nullish(),
  recipientEmail: z.string().max(200).nullish(),
  recipientName: z.string().max(200).nullish(),
  includeBanner: z.boolean().default(true),
  makeInert: z.boolean().default(true),
  demoId: z.string().nullish(),
});

/**
 * Imports an HTML file (or raw HTML markup) as a hosted demo with its own
 * public URL (`/demos/<slug>`), ready to share via link or attach to an email.
 */
demosRouter.post("/import", async (req, res, next) => {
  try {
    const input = importInput.parse(req.body);
    const result = await importDemo({
      ...input,
      userId: req.dbUser?.id ?? null,
    });
    const editor = await ensureDemoSitePage(result.demo, { overwriteSourceHtml: true });
    res.status(201).json({
      ...result.demo,
      siteId: editor.siteId,
      sitePageId: editor.pageId,
      notes: result.notes,
    });
  } catch (err) {
    if (err instanceof DemoImportError || err instanceof FileTypeError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

const buildInput = z.object({
  leadId: z.string().min(1),
  /** Replace the page at the existing link rather than opening a second one. */
  rebuild: z.boolean().default(true),
  /**
   * Build anyway, with no scan behind it. Off by default and deliberately
   * awkward: a page built from a bare record is a template with a business
   * name dropped into it, which is the one thing this feature exists not to
   * produce.
   */
  force: z.boolean().default(false),
});

/**
 * Builds the page. Slow — a design lookup and then a whole page of HTML — and
 * deliberately a separate call from sending anything, so the Owner reads it
 * before a prospect does.
 */
demosRouter.post("/build", async (req, res, next) => {
  try {
    const input = buildInput.parse(req.body);
    const lead = await prisma.lead.findUnique({ where: { id: input.leadId }, include: { research: true } });
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    // Refused rather than warned about, and refused here rather than only in
    // the UI: the tool an agent calls has the same rule, and a guard that only
    // exists in a button is not a guard.
    if (!lead.research && !input.force) {
      return res.status(409).json({
        error:
          "Nobody has looked at this business yet. Run the scan first — a demo built from a bare record is a template with their name dropped into it, and it is worse than sending nothing.",
      });
    }

    const subject = subjectFromLead(lead, (lead.research?.audit ?? null) as never, (lead.research?.look ?? null) as never);
    const startedAt = Date.now();
    const result = await buildDemo(subject, { rebuild: input.rebuild });
    // Every door into `buildDemo` records the same thing: the page enters the
    // workflow at NEEDS_REVIEW with its checks run. A page built here and not
    // recorded would be a page the gate has never heard of.
    const checks = await recordBuild(input.leadId, result, { by: req.dbUser?.id ?? null, startedAt, rebuild: input.rebuild });
    res.status(201).json({
      ...result,
      checks,
      lookedAtFirst: Boolean(lead.research),
      notes: lead.research
        ? result.notes
        : ["This was built without a scan behind it, so it could be about any business in the trade. Read every line before the link goes out.", ...result.notes],
    });
  } catch (err) {
    next(err);
  }
});

const updateInput = z.object({
  status: z.enum(["DRAFT", "READY", "SENT", "ACCEPTED", "DECLINED", "ARCHIVED"]).optional(),
  title: z.string().min(1).max(200).optional(),
  businessName: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(100).optional(),
  leadId: z.string().nullish(),
  clientId: z.string().nullish(),
  recipientEmail: z.string().max(200).nullish(),
  recipientName: z.string().max(200).nullish(),
  includeBanner: z.boolean().optional(),
  makeFormsInert: z.boolean().optional(),
  notes: z.string().max(1000).nullish(),
  html: z.string().nullish(),
  dataBase64: z.string().nullish(),
  filename: z.string().max(240).nullish(),
  fileName: z.string().max(240).nullish(),
  accessMode: z.enum(["PUBLIC", "LINK_ONLY", "PASSWORD", "INVITED_ONLY"]).optional(),
  password: z.string().max(100).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  notifyOnView: z.boolean().optional(),
});

demosRouter.patch("/:id", async (req, res, next) => {
  try {
    const input = updateInput.parse(req.body);
    const existing = await prisma.demo.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "No such demo" });

    // If new HTML was uploaded or pasted, run the full import update path.
    if ((input.html && input.html.trim()) || (input.dataBase64 && input.dataBase64.trim())) {
      const prevMeta = readBriefMeta(existing.brief);
      const updated = await importDemo({
        demoId: existing.id,
        html: input.html,
        dataBase64: input.dataBase64,
        filename: input.filename ?? input.fileName,
        businessName: input.businessName ?? existing.businessName,
        title: input.title ?? existing.title,
        slug: input.slug ?? existing.slug,
        leadId: input.leadId === undefined ? existing.leadId : input.leadId,
        clientId: input.clientId === undefined ? prevMeta.clientId : input.clientId,
        recipientEmail: input.recipientEmail === undefined ? prevMeta.recipientEmail : input.recipientEmail,
        recipientName: input.recipientName === undefined ? prevMeta.recipientName : input.recipientName,
        includeBanner: input.includeBanner ?? prevMeta.includeBanner ?? true,
        makeInert: input.makeFormsInert ?? prevMeta.makeInert ?? true,
        userId: req.dbUser?.id ?? null,
      });
      const editor = await ensureDemoSitePage(updated.demo, { overwriteSourceHtml: true });
      return res.json({
        ...updated.demo,
        siteId: editor.siteId,
        sitePageId: editor.pageId,
      });
    }

    let nextSlug: string | undefined;
    if (input.slug !== undefined) {
      const desired = demoSlug(input.slug);
      const clash = await prisma.demo.findUnique({ where: { slug: desired }, select: { id: true, businessName: true } });
      if (clash && clash.id !== existing.id) {
        return res.status(409).json({
          error: `The URL slug "/demos/${desired}" is already used by "${clash.businessName}". Choose a different slug.`,
        });
      }
      nextSlug = desired;
    }

    const prevMeta = readBriefMeta(existing.brief);
    const nextBusinessName = input.businessName ?? existing.businessName;
    const nextTitle = input.title ?? existing.title;
    const nextIncludeBanner = input.includeBanner ?? prevMeta.includeBanner ?? true;
    const nextMakeInert = input.makeFormsInert ?? prevMeta.makeInert ?? true;

    let nextHtml: string | undefined;
    const metadataAffectsHtml =
      input.businessName !== undefined ||
      input.title !== undefined ||
      input.includeBanner !== undefined ||
      input.makeFormsInert !== undefined;

    if (metadataAffectsHtml) {
      const profile = await companyProfile();
      const prepared = prepareImportedDemoHtml(existing.html, {
        businessName: nextBusinessName,
        title: nextTitle,
        senderName: profile.displayName,
        senderSite: profile.web ?? "dakyworld.com",
        includeBanner: nextIncludeBanner,
        makeInert: nextMakeInert,
      });
      nextHtml = prepared.html;
    }

    const nextMeta: DemoBriefMeta = {
      ...prevMeta,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      ...(input.recipientEmail !== undefined ? { recipientEmail: input.recipientEmail } : {}),
      ...(input.recipientName !== undefined ? { recipientName: input.recipientName } : {}),
      ...(input.includeBanner !== undefined ? { includeBanner: input.includeBanner } : {}),
      ...(input.makeFormsInert !== undefined ? { makeInert: input.makeFormsInert } : {}),
      ...(input.accessMode !== undefined ? { accessMode: input.accessMode } : {}),
      ...(input.password !== undefined ? { passwordPlain: input.password, passwordHash: createHash("sha256").update(input.password).digest("hex") } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.notifyOnView !== undefined ? { notifyOnView: input.notifyOnView } : {}),
    };

    const demo = await prisma.demo.update({
      where: { id: req.params.id },
      data: {
        ...(input.title ? { title: input.title } : {}),
        ...(input.businessName ? { businessName: input.businessName } : {}),
        ...(nextSlug ? { slug: nextSlug } : {}),
        ...(nextHtml ? { html: nextHtml, version: { increment: 1 } } : {}),
        ...(input.leadId !== undefined ? { leadId: input.leadId } : {}),
        ...(input.status ? { status: input.status, ...(input.status === "SENT" ? { sentAt: new Date() } : {}) } : {}),
        brief: nextMeta as never,
      },
      include: {
        lead: { select: { id: true, contactName: true, companyName: true, contactEmail: true, website: true, status: true } },
      },
    });

    const editor = await ensureDemoSitePage(demo, { overwriteSourceHtml: Boolean(nextHtml) });

    if (demo.leadId && (demo.builtBy === "Imported HTML" || input.status === "READY" || input.status === "SENT")) {
      await recordImportedConcept(demo.leadId, demo, req.dbUser?.id ?? null);
    }

    const client = nextMeta.clientId
      ? await prisma.client.findUnique({
          where: { id: nextMeta.clientId },
          select: { id: true, name: true, company: true, email: true },
        })
      : null;

    res.json({
      ...demo,
      siteId: editor.siteId,
      sitePageId: editor.pageId,
      url: demoUrl(demo.slug, await appUrl()),
      client,
      recipientEmail: nextMeta.recipientEmail ?? demo.lead?.contactEmail ?? client?.email ?? null,
      recipientName: nextMeta.recipientName ?? demo.lead?.contactName ?? client?.name ?? null,
    });
  } catch (err) {
    if (err instanceof DemoImportError || err instanceof FileTypeError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

demosRouter.get("/feed/notifications", async (req, res, next) => {
  try {
    const demos = await prisma.demo.findMany({
      select: { id: true, title: true, businessName: true, slug: true, brief: true },
      take: 50,
    });
    const allNotes: Array<{ id: string; demoId: string; demoTitle: string; businessName: string; text: string; timestamp: string }> = [];
    for (const d of demos) {
      const meta = readBriefMeta(d.brief);
      if (Array.isArray(meta.viewNotifications)) {
        for (const n of meta.viewNotifications) {
          allNotes.push({
            id: n.id,
            demoId: d.id,
            demoTitle: d.title,
            businessName: d.businessName,
            text: n.text,
            timestamp: n.timestamp,
          });
        }
      }
    }
    allNotes.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    res.json({ notifications: allNotes.slice(0, 30) });
  } catch (err) {
    next(err);
  }
});

demosRouter.get("/:id/analytics-pro", async (req, res, next) => {
  try {
    const includeBots = req.query.includeBots === "true";
    const includeInternal = req.query.includeInternal === "true";

    const demo = await prisma.demo.findUnique({
      where: { id: req.params.id },
      include: {
        visits: {
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!demo) return res.status(404).json({ error: "Demo not found" });

    const meta = readBriefMeta(demo.brief);
    const rawVisits = demo.visits;
    const visits = rawVisits.filter((v) => {
      if (!includeBots && v.deviceType === "bot") return false;
      if (!includeInternal && isPrivateOrLocalIp(v.ip)) return false;
      return true;
    });

    const totalViews = demo.views;
    const periodViews = visits.length;
    const lastViewedAt = demo.lastViewedAt || (visits[0]?.createdAt ?? null);

    const durations = visits.map(v => v.durationSeconds).filter(d => d > 0);
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const avgMinutes = Math.floor(avgDuration / 60);
    const avgSeconds = avgDuration % 60;
    const formattedAvgTime = avgMinutes > 0 ? `${avgMinutes}m ${avgSeconds}s` : `${avgSeconds}s`;

    const devices = new Map<string, number>();
    for (const v of visits) {
      const dev = v.deviceType || "Desktop";
      devices.set(dev, (devices.get(dev) ?? 0) + 1);
    }
    let topDevice = "Desktop";
    let topDeviceCount = 0;
    for (const [dev, count] of devices.entries()) {
      if (count > topDeviceCount) {
        topDevice = dev;
        topDeviceCount = count;
      }
    }

    const scrolls = visits.map(v => v.scrollDepth).filter(s => s > 0);
    // Display missing measurements as unavailable (null), do NOT fabricate 85%
    const avgScroll = scrolls.length > 0 ? Math.round(scrolls.reduce((a, b) => a + b, 0) / scrolls.length) : null;

    const clickedButtons = new Map<string, number>();
    let pricingRevisits = 0;
    for (const v of visits) {
      const clicks = Array.isArray(v.clicks) ? (v.clicks as any[]) : [];
      for (const c of clicks) {
        const txt = (c.targetText || "").trim();
        const sel = (c.targetSelector || "").toLowerCase();
        if (txt) {
          clickedButtons.set(txt, (clickedButtons.get(txt) ?? 0) + 1);
        }
        if (sel.includes("price") || sel.includes("pricing") || txt.toLowerCase().includes("pricing") || txt.toLowerCase().includes("plan")) {
          pricingRevisits++;
        }
      }
    }

    const topClicks = Array.from(clickedButtons.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([text, count]) => ({ text, count }));

    const insights: string[] = [];
    if (pricingRevisits > 0) {
      insights.push(`Client revisited the pricing section ${pricingRevisits} time${pricingRevisits === 1 ? "" : "s"}.`);
    }
    if (avgDuration > 180) {
      insights.push(`Client spent ${formattedAvgTime} deeply reviewing your proposal.`);
    }
    // Only generate high engagement insight if scroll depth was actually measured
    if (avgScroll !== null && avgScroll > 80) {
      insights.push(`High engagement: client scrolled through ${avgScroll}% of the page.`);
    }

    res.json({
      demoId: demo.id,
      title: demo.title,
      businessName: demo.businessName,
      totalViews,
      periodViews,
      lastViewedAt,
      formattedAvgTime,
      avgDurationSeconds: avgDuration,
      topDevice: topDevice === "mobile" ? "iPhone / Mobile" : topDevice,
      avgScrollDepth: avgScroll,
      topClicks,
      insights,
      notifications: meta.viewNotifications || [],
      protection: {
        accessMode: meta.accessMode || "PUBLIC",
        isProtected: meta.accessMode === "PASSWORD",
        expiresAt: meta.expiresAt || null,
        isExpired: meta.expiresAt ? new Date(meta.expiresAt) < new Date() : false,
      },
    });
  } catch (err) {
    next(err);
  }
});

demosRouter.patch("/:id/settings", async (req, res, next) => {
  try {
    const body = z.object({
      accessMode: z.enum(["PUBLIC", "PASSWORD"]).optional(),
      password: z.string().optional(),
      expiresAt: z.string().datetime().nullable().optional(),
      extendDays: z.number().int().positive().optional(),
    }).parse(req.body);

    const demo = await prisma.demo.findUnique({ where: { id: req.params.id } });
    if (!demo) return res.status(404).json({ error: "Demo not found" });

    const meta = ((demo.brief as Record<string, any>) || {});
    let nextExpiresAt = meta.expiresAt;

    if (body.extendDays) {
      const currentExpiry = meta.expiresAt ? new Date(meta.expiresAt) : new Date();
      const baseDate = currentExpiry > new Date() ? currentExpiry : new Date();
      nextExpiresAt = new Date(baseDate.getTime() + body.extendDays * 86400 * 1000).toISOString();
    } else if (body.expiresAt !== undefined) {
      nextExpiresAt = body.expiresAt;
    }

    const updatedBrief = {
      ...meta,
      accessMode: body.accessMode ?? meta.accessMode ?? "PUBLIC",
      ...(body.password !== undefined
        ? {
            passwordPlain: body.password || null,
            passwordHash: body.password ? createHash("sha256").update(body.password).digest("hex") : null,
          }
        : {}),
      expiresAt: nextExpiresAt,
    };

    const updated = await prisma.demo.update({
      where: { id: demo.id },
      data: { brief: updatedBrief },
    });

    res.json({
      ok: true,
      demo: updated,
      protection: {
        accessMode: updatedBrief.accessMode,
        isProtected: updatedBrief.accessMode === "PASSWORD",
        expiresAt: updatedBrief.expiresAt,
        isExpired: updatedBrief.expiresAt ? new Date(updatedBrief.expiresAt) < new Date() : false,
      },
    });
  } catch (err) {
    next(err);
  }
});

demosRouter.delete("/:id", async (req, res, next) => {
  try {
    await prisma.demo.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// --- The public half --------------------------------------------------------

export const demoPagesRouter = Router();

demoPagesRouter.use(express.json({ limit: "512kb" }));
demoPagesRouter.use(express.text({ type: ["text/plain", "application/json"], limit: "512kb" }));

const beaconRateLimits = new Map<string, { count: number; resetAt: number }>();

function checkBeaconRateLimit(key: string, maxPerMin = 120): boolean {
  const now = Date.now();
  const entry = beaconRateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    beaconRateLimits.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= maxPerMin;
}

const analyticsBeaconInput = z.object({
  token: z.string().trim().min(1).max(1000).optional(),
  visitId: z.string().trim().min(1).max(120).optional(),
  sessionId: z.string().trim().min(1).max(120),
  visitorId: z.string().trim().max(120).optional(),
  durationSeconds: z.number().int().min(0).max(86400).optional(),
  scrollDepth: z.number().int().min(0).max(100).optional(),
  viewportWidth: z.number().int().min(0).max(10000).nullish(),
  viewportHeight: z.number().int().min(0).max(10000).nullish(),
  screenWidth: z.number().int().min(0).max(10000).nullish(),
  screenHeight: z.number().int().min(0).max(10000).nullish(),
  timezone: z.string().trim().max(100).optional(),
  locale: z.string().trim().max(30).optional(),
  clicks: z
    .array(
      z.object({
        id: z.string().trim().max(80).optional(),
        x: z.number().int().min(0).max(20000),
        y: z.number().int().min(0).max(200000),
        xPercent: z.number().min(0).max(100),
        yPercent: z.number().min(0).max(100),
        targetTag: z.string().trim().max(50).optional(),
        targetText: z.string().trim().max(120).optional(),
        targetSelector: z.string().trim().max(120).optional(),
        timeOffset: z.number().int().min(0).max(86400).optional(),
      }),
    )
    .max(100)
    .optional(),
});

/**
 * One demo, to whoever has the link.
 *
 * The CSP is the real guard on what a generated page may do. `sanitiseDemoHtml`
 * strips the obvious things at build time so the page does not arrive visibly
 * broken by its own headers, but a page written by a model and served from
 * Dakyworld's own domain does not get to decide what it may load.
 *
 * When a demo was imported directly from an HTML file by the Owner (`IMPORTED_CSP`),
 * `https:` assets (Tailwind CDN, web fonts, external images, icon libraries) are
 * allowed so the imported file renders faithfully while forms remain inert.
 */
const CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
].join("; ");

const IMPORTED_CSP = [
  "default-src 'self' https: data: blob:",
  "img-src 'self' https: data: blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' https: data:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
  "media-src 'self' https: data: blob:",
  "connect-src 'self' https:",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

demoPagesRouter.get("/:slug/assets/dw/:filename", async (req, res, next) => {
  try {
    const filename = req.params.filename;
    const repoPath = `assets/dw/${filename}`;
    const asset = await prisma.siteAsset.findFirst({
      where: { repoPath },
      select: { content: true, contentType: true, size: true },
    });
    if (!asset || !asset.content) {
      return res.status(404).send("Asset not found");
    }
    res.setHeader("Content-Type", asset.contentType || "image/png");
    res.setHeader("Content-Length", asset.content.length);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(Buffer.from(asset.content));
  } catch (err) {
    next(err);
  }
});

demoPagesRouter.post("/:slug/analytics", async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const demo = await prisma.demo.findUnique({
      where: { slug },
      select: { id: true, brief: true },
    });
    if (!demo) {
      return res.status(404).json({ error: "Demo not found" });
    }

    // Access check: reject beacons for expired demos
    const meta = readBriefMeta(demo.brief);
    if (meta.expiresAt && new Date(meta.expiresAt) < new Date()) {
      return res.status(403).json({ error: "Demo proposal has expired" });
    }

    const clientIp = extractClientIp(req) || "unknown";
    if (!checkBeaconRateLimit(clientIp)) {
      return res.status(429).json({ error: "Rate limit exceeded" });
    }

    let rawBody = req.body;
    if (typeof rawBody === "string") {
      try {
        rawBody = JSON.parse(rawBody);
      } catch {
        return res.status(400).json({ error: "Invalid JSON" });
      }
    }

    const parsed = analyticsBeaconInput.safeParse(rawBody);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid analytics payload", details: parsed.error.issues });
    }

    const data = parsed.data;

    // Authenticate beacon: require valid signed visit token
    if (!data.token) {
      return res.status(401).json({ error: "Tracking token required" });
    }

    const verification = verifyVisitToken(data.token, {
      demoId: demo.id,
      slug,
      visitId: data.visitId,
    });
    if (!verification.valid) {
      return res.status(403).json({ error: verification.error || "Invalid or expired tracking token" });
    }

    const targetVisitId = data.visitId || verification.visitId;
    const existingVisit = await prisma.demoVisit.findFirst({
      where: { id: targetVisitId, demoId: demo.id },
    });

    // Reject unissued visits: do not create visits without a legitimate page view
    if (!existingVisit) {
      return res.status(404).json({ error: "Visit not found or unissued" });
    }

    const ip = extractClientIp(req);
    const hints = extractGeoHints(req);
    const geo = resolveIpLocation(ip, {
      hintCountry: hints.country,
      hintCity: hints.city,
      hintRegion: hints.region,
      timezone: data.timezone,
      locale: data.locale,
    });

    const newDuration = Math.max(existingVisit.durationSeconds ?? 0, data.durationSeconds ?? 0);
    const newScrollDepth = Math.max(existingVisit.scrollDepth ?? 0, data.scrollDepth ?? 0);

    // Merge clicks with event ID deduplication
    const existingClicks = Array.isArray(existingVisit.clicks) ? (existingVisit.clicks as any[]) : [];
    const existingIds = new Set(existingClicks.map((c) => c.id).filter(Boolean));
    const incomingClicks = data.clicks ?? [];
    const newClicks = incomingClicks.filter((c) => !c.id || !existingIds.has(c.id));
    const mergedClicks = [...existingClicks, ...newClicks].slice(-500);

    await prisma.demoVisit.update({
      where: { id: existingVisit.id },
      data: {
        sessionId: data.sessionId || existingVisit.sessionId,
        durationSeconds: newDuration,
        scrollDepth: newScrollDepth,
        viewportWidth: data.viewportWidth ? Math.round(data.viewportWidth) : existingVisit.viewportWidth,
        viewportHeight: data.viewportHeight ? Math.round(data.viewportHeight) : existingVisit.viewportHeight,
        screenWidth: data.screenWidth ? Math.round(data.screenWidth) : existingVisit.screenWidth,
        screenHeight: data.screenHeight ? Math.round(data.screenHeight) : existingVisit.screenHeight,
        clicks: mergedClicks as Prisma.InputJsonValue,
        // Enrich location only if edge verified city or genuine country resolved
        ...(geo.country && (!existingVisit.country || existingVisit.country === "LOCAL")
          ? {
              country: geo.country,
              countryName: geo.countryName,
              city: geo.city || existingVisit.city,
            }
          : geo.city && !existingVisit.city
            ? { city: geo.city }
            : {}),
      },
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

demoPagesRouter.post("/:slug/unlock", express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const demo = await prisma.demo.findUnique({ where: { slug: req.params.slug } });
    if (!demo) return res.status(404).send("Demo not found");
    const meta = readBriefMeta(demo.brief);
    const password = req.body?.password?.trim();

    if (!meta.passwordPlain || password === meta.passwordPlain) {
      const hash = meta.passwordHash || createHash("sha256").update(password || "").digest("hex");
      res.setHeader("Set-Cookie", `dw_demo_${demo.slug}=${hash}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
      return res.redirect(`/demos/${demo.slug}`);
    }

    res.status(401).type("html").send(passwordUnlockPage(demo.slug, demo.businessName, "Incorrect password. Please try again."));
  } catch (err) {
    next(err);
  }
});

demoPagesRouter.get("/:slug", async (req, res, next) => {
  try {
    if (req.params.slug.toLowerCase() === "dakyworld") {
      await ensureDefaultDakyworldDemo();
    }
    const demo = await prisma.demo.findUnique({ where: { slug: req.params.slug } });
    if (!demo || demo.status === "ARCHIVED") {
      const profile = await companyProfile();
      return res.status(404).type("html").send(missingPage(profile.displayName));
    }

    const meta = readBriefMeta(demo.brief);

    // 1. Demo Expiry Check
    if (meta.expiresAt && new Date(meta.expiresAt) < new Date()) {
      return res.status(403).type("html").send(expiredDemoPage(demo.title, demo.businessName, meta.expiresAt));
    }

    // 2. Demo Password Protection Check
    if (meta.accessMode === "PASSWORD" && meta.passwordPlain) {
      const passParam = (req.query.pass as string) || (req.headers["x-demo-password"] as string);
      const cookieHeader = req.headers.cookie || "";
      const cookieMatches = cookieHeader.includes(`dw_demo_${demo.slug}=${meta.passwordHash}`);
      if (passParam !== meta.passwordPlain && !cookieMatches) {
        return res.status(401).type("html").send(passwordUnlockPage(demo.slug, demo.businessName));
      }
    }

    const isPreviewOrHeatmap =
      req.query.dw_preview === "heatmap" ||
      req.query.dw_heatmap === "1" ||
      req.query.preview === "heatmap" ||
      Boolean(req.headers["x-dw-preview"]);

    const sessionId = isPreviewOrHeatmap
      ? `prev_${Date.now().toString(36)}`
      : `vs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

    const visitId = isPreviewOrHeatmap
      ? `prev_${Date.now().toString(36)}`
      : `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

    const visitToken = createVisitToken({
      visitId,
      demoId: demo.id,
      slug: demo.slug,
    });

    if (!isPreviewOrHeatmap) {
      const ip = extractClientIp(req);
      const hints = extractGeoHints(req);
      const geo = resolveIpLocation(ip, {
        hintCountry: hints.country,
        hintCity: hints.city,
        hintRegion: hints.region,
      });
      const ua = req.headers["user-agent"] || null;
      const parsedDevice = parseUserAgent(ua);
      const isBot = parsedDevice.isBot;

      // Human traffic increments views; bots and link previews (WhatsApp, Slack, etc.) are excluded
      const dbOperations: Array<Promise<unknown>> = [
        prisma.demoVisit.create({
          data: {
            id: visitId,
            demoId: demo.id,
            sessionId,
            ip,
            country: geo.country,
            countryName: geo.countryName,
            city: geo.city,
            userAgent: ua ? ua.slice(0, 500) : null,
            deviceType: parsedDevice.deviceType,
            browser: parsedDevice.browser,
            os: parsedDevice.os,
            durationSeconds: 0,
            scrollDepth: 0,
            clicks: [],
          },
        }),
      ];

      if (!isBot) {
        dbOperations.push(
          prisma.demo.update({
            where: { id: demo.id },
            data: { views: { increment: 1 }, lastViewedAt: new Date() },
          }),
        );
      }

      void Promise.all(dbOperations).catch(() => undefined);

      // View Notification Logging only for genuine human viewers
      if (!isBot && meta.notifyOnView !== false) {
        const viewer = meta.recipientName || meta.clientName || "Prospect";
        const locLabel = geo.city && geo.countryName ? ` from ${geo.city}, ${geo.countryName}` : "";
        const newNote = {
          id: randomUUID(),
          text: `${viewer} from ${demo.businessName}${locLabel} opened your proposal demo.`,
          timestamp: new Date().toISOString(),
        };
        const existingNotes = Array.isArray(meta.viewNotifications) ? meta.viewNotifications : [];
        const updatedMeta = { ...meta, viewNotifications: [newNote, ...existingNotes].slice(0, 50) };
        void prisma.demo.update({
          where: { id: demo.id },
          data: { brief: updatedMeta as any },
        }).catch(() => {});
      }
    }

    const isImported = demo.builtBy === "Imported HTML" || meta.imported === true;

    let renderedHtml = demo.html;
    if (meta.sitePageId) {
      const sitePage = await prisma.sitePage.findUnique({
        where: { id: meta.sitePageId },
        select: { sourceHtml: true, draft: true },
      });
      if (sitePage?.sourceHtml) {
        const draft = readSitePageDraft(sitePage.draft);
        renderedHtml =
          Object.keys(draft).length > 0
            ? applyValues(editingSource(sitePage.sourceHtml, draft), fieldValues(draft)).html
            : sitePage.sourceHtml;
      }
    }

    // Inject analytics tracking script with server-issued visit ID and signed token
    const trackedHtml = injectDemoTracker(renderedHtml, {
      slug: demo.slug,
      visitId,
      token: visitToken,
      sessionId,
      disabled: isPreviewOrHeatmap,
    });


    res
      .status(200)
      .type("html")
      .set({
        "Content-Security-Policy": isImported ? IMPORTED_CSP : CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        // A concept page for somebody else's business has no business in a
        // search index under their name.
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0",
      })
      .send(trackedHtml);
  } catch (err) {
    next(err);
  }
});

function expiredDemoPage(title: string, businessName: string, expiresAt: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo Expired</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08101F;color:#F4F5F0;font:400 16px/1.6 system-ui,-apple-system,sans-serif;padding:2rem}
main{max-width:32rem;text-align:center;background:#0F1B2E;padding:2.5rem;border-radius:1rem;border:1px solid #1E293B;box-shadow:0 20px 25px -5px rgba(0,0,0,0.5)}
.badge{display:inline-block;padding:0.25rem 0.75rem;background:#F59E0B20;color:#FBBF24;border-radius:9999px;font-size:0.75rem;font-weight:600;margin-bottom:1rem}
h1{font-size:1.5rem;margin:0 0 0.75rem;color:#FFFFFF}p{margin:0 0 1.5rem;color:#94A3B8;font-size:0.95rem}
.notice{background:#1E293B;padding:1rem;border-radius:0.5rem;font-size:0.85rem;color:#CBD5E1}
</style></head><body><main>
<span class="badge">Demo Access Expired</span>
<h1>${businessName} Redesign Demo</h1>
<p>Access to this proposal demo concluded on ${new Date(expiresAt).toLocaleDateString()}.</p>
<div class="notice">To request an extension or review the full proposal, please contact the developer or team directly.</div>
</main></body></html>`;
}

function passwordUnlockPage(slug: string, businessName: string, error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Protected Proposal Demo</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08101F;color:#F4F5F0;font:400 16px/1.6 system-ui,-apple-system,sans-serif;padding:2rem}
main{width:100%;max-width:26rem;background:#0F1B2E;padding:2.5rem;border-radius:1rem;border:1px solid #1E293B;box-shadow:0 20px 25px -5px rgba(0,0,0,0.5)}
.icon{width:48px;height:48px;margin:0 auto 1.25rem;background:#0B66C320;color:#38BDF8;border-radius:0.75rem;display:flex;align-items:center;justify-content:center;font-size:1.5rem}
h1{font-size:1.35rem;margin:0 0 0.5rem;text-align:center;color:#FFFFFF}
p{margin:0 0 1.5rem;color:#94A3B8;font-size:0.875rem;text-align:center}
form{display:flex;flex-direction:column;gap:1rem}
input{padding:0.75rem 1rem;background:#1E293B;border:1px solid #334155;border-radius:0.5rem;color:#FFFFFF;font-size:1rem;outline:none}
input:focus{border-color:#38BDF8}
button{padding:0.75rem;background:#0B66C3;color:#FFFFFF;border:none;border-radius:0.5rem;font-weight:600;cursor:pointer;font-size:0.95rem;transition:background 0.2s}
button:hover{background:#09529E}
.err{color:#F87171;font-size:0.8rem;text-align:center;margin-bottom:0.5rem}
</style></head><body><main>
<div class="icon">🔒</div>
<h1>Private Proposal Demo</h1>
<p>${businessName} Website Redesign is password protected.</p>
${error ? `<div class="err">${error}</div>` : ""}
<form method="POST" action="/demos/${slug}/unlock">
  <input type="password" name="password" placeholder="Enter proposal password" required autofocus />
  <button type="submit">View Proposal Demo</button>
</form>
</main></body></html>`;
}

function missingPage(company: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not here</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F5F0;color:#08101F;font:400 16px/1.6 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;padding:2rem}
main{max-width:34rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .75rem}p{margin:0;color:#69758A}</style>
</head><body><main><h1>This page is not here any more</h1>
<p>The demo you are looking for has been taken down or never existed. If somebody at ${company} sent you the link, ask them for a new one.</p>
</main></body></html>`;
}
