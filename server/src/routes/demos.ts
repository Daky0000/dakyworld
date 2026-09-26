import express, { Router } from "express";
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
import { resolveIpLocation, countryFlag } from "../lib/demoGeo.js";
import { parseUserAgent } from "../lib/deviceParser.js";
import { injectDemoTracker } from "../services/demoTracker.js";

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

  if (!site) {
    const uniqueSiteSlug = `demo-${demo.slug}-${demo.id.slice(-6)}`.slice(0, 60);
    const createdSite = await prisma.site.create({
      data: {
        name: siteName,
        slug: uniqueSiteSlug,
        publicUrl,
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

    const visits = await prisma.demoVisit.findMany({
      where: { demoId: demo.id },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    const uniqueIps = new Set(
      visits.map((v) => v.ip).filter((ip): ip is string => Boolean(ip)),
    );
    const uniqueVisitors = Math.max(uniqueIps.size, visits.length > 0 ? 1 : 0);

    const totalDuration = visits.reduce((acc, v) => acc + (v.durationSeconds || 0), 0);
    const avgDurationSeconds = visits.length > 0 ? Math.round(totalDuration / visits.length) : 0;

    const totalScrollDepth = visits.reduce((acc, v) => acc + (v.scrollDepth || 0), 0);
    const avgScrollDepth = visits.length > 0 ? Math.round(totalScrollDepth / visits.length) : 0;

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
      flag?: string;
      createdAt: string;
    }> = [];

    const countryMap: Record<string, { code: string; name: string; flag: string; count: number }> = {};
    const deviceMap: Record<string, number> = {};
    const browserMap: Record<string, number> = {};
    const osMap: Record<string, number> = {};
    const elementClickMap: Record<string, { selector: string; tag: string; text: string; count: number }> = {};

    for (const v of visits) {
      const clickList = Array.isArray(v.clicks) ? (v.clicks as any[]) : [];
      totalClicks += clickList.length;

      if ((v.durationSeconds || 0) < 5 && clickList.length === 0) {
        bouncedCount++;
      }

      if (v.country) {
        if (!countryMap[v.country]) {
          countryMap[v.country] = {
            code: v.country,
            name: v.countryName || v.country,
            flag: countryFlag(v.country),
            count: 0,
          };
        }
        countryMap[v.country].count++;
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
          ip: v.ip,
          country: v.country,
          countryName: v.countryName,
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

    const formattedVisits = visits.map((v) => {
      const clickList = Array.isArray(v.clicks) ? (v.clicks as any[]) : [];
      return {
        id: v.id,
        sessionId: v.sessionId,
        ip: v.ip,
        country: v.country,
        countryName: v.countryName,
        flag: countryFlag(v.country),
        city: v.city,
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
        uniqueVisitors,
        totalVisits: visits.length,
        avgDurationSeconds,
        avgScrollDepth,
        totalClicks,
        bounceRate,
      },
      breakdowns: {
        countries: countryBreakdown,
        devices: deviceBreakdown,
        browsers: browserBreakdown,
        os: osBreakdown,
      },
      visits: formattedVisits,
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

const analyticsBeaconInput = z.object({
  sessionId: z.string().trim().min(1).max(120),
  durationSeconds: z.number().int().min(0).max(86400).optional(),
  scrollDepth: z.number().int().min(0).max(100).optional(),
  viewportWidth: z.number().int().min(0).max(10000).nullish(),
  viewportHeight: z.number().int().min(0).max(10000).nullish(),
  screenWidth: z.number().int().min(0).max(10000).nullish(),
  screenHeight: z.number().int().min(0).max(10000).nullish(),
  clicks: z
    .array(
      z.object({
        x: z.number().int().min(0).max(20000),
        y: z.number().int().min(0).max(200000),
        xPercent: z.number().min(0).max(100),
        yPercent: z.number().min(0).max(100),
        targetTag: z.string().trim().max(30).optional(),
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
      select: { id: true },
    });
    if (!demo) {
      return res.status(404).json({ error: "Demo not found" });
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
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null;
    const hint = countryHint(req);
    const geo = resolveIpLocation(ip, hint);
    const ua = req.headers["user-agent"] || null;
    const parsedDevice = parseUserAgent(ua);

    const existingVisit = await prisma.demoVisit.findFirst({
      where: { demoId: demo.id, sessionId: data.sessionId },
      orderBy: { createdAt: "desc" },
    });

    const newDuration = Math.max(existingVisit?.durationSeconds ?? 0, data.durationSeconds ?? 0);
    const newScrollDepth = Math.max(existingVisit?.scrollDepth ?? 0, data.scrollDepth ?? 0);

    const existingClicks = Array.isArray(existingVisit?.clicks) ? (existingVisit.clicks as any[]) : [];
    const incomingClicks = data.clicks ?? [];
    const mergedClicks = [...existingClicks, ...incomingClicks].slice(-500);

    if (existingVisit) {
      await prisma.demoVisit.update({
        where: { id: existingVisit.id },
        data: {
          durationSeconds: newDuration,
          scrollDepth: newScrollDepth,
          viewportWidth: data.viewportWidth ? Math.round(data.viewportWidth) : existingVisit.viewportWidth,
          viewportHeight: data.viewportHeight ? Math.round(data.viewportHeight) : existingVisit.viewportHeight,
          screenWidth: data.screenWidth ? Math.round(data.screenWidth) : existingVisit.screenWidth,
          screenHeight: data.screenHeight ? Math.round(data.screenHeight) : existingVisit.screenHeight,
          clicks: mergedClicks as Prisma.InputJsonValue,
        },
      });
    } else {
      await prisma.demoVisit.create({
        data: {
          demoId: demo.id,
          sessionId: data.sessionId,
          ip,
          country: geo.country,
          countryName: geo.countryName,
          userAgent: ua ? ua.slice(0, 500) : null,
          deviceType: parsedDevice.deviceType,
          browser: parsedDevice.browser,
          os: parsedDevice.os,
          viewportWidth: data.viewportWidth ? Math.round(data.viewportWidth) : null,
          viewportHeight: data.viewportHeight ? Math.round(data.viewportHeight) : null,
          screenWidth: data.screenWidth ? Math.round(data.screenWidth) : null,
          screenHeight: data.screenHeight ? Math.round(data.screenHeight) : null,
          durationSeconds: newDuration,
          scrollDepth: newScrollDepth,
          clicks: mergedClicks as Prisma.InputJsonValue,
        },
      });
    }

    res.status(200).json({ ok: true });
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

    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null;
    const hint = countryHint(req);
    const geo = resolveIpLocation(ip, hint);
    const ua = req.headers["user-agent"] || null;
    const parsedDevice = parseUserAgent(ua);
    const sessionId = `vs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

    // Log the visit with visitor IP, country, device details, and increment views
    void prisma.$transaction([
      prisma.demo.update({
        where: { id: demo.id },
        data: { views: { increment: 1 }, lastViewedAt: new Date() },
      }),
      prisma.demoVisit.create({
        data: {
          demoId: demo.id,
          sessionId,
          ip,
          country: geo.country,
          countryName: geo.countryName,
          userAgent: ua ? ua.slice(0, 500) : null,
          deviceType: parsedDevice.deviceType,
          browser: parsedDevice.browser,
          os: parsedDevice.os,
          durationSeconds: 0,
          scrollDepth: 0,
          clicks: [],
        },
      }),
    ]).catch(() => undefined);

    const meta = readBriefMeta(demo.brief);
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

    // Inject analytics tracking script for dwell time, scroll depth, and clicks heatmap
    const trackedHtml = injectDemoTracker(renderedHtml, {
      slug: demo.slug,
      sessionId,
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

function missingPage(company: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not here</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F5F0;color:#08101F;font:400 16px/1.6 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;padding:2rem}
main{max-width:34rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .75rem}p{margin:0;color:#69758A}</style>
</head><body><main><h1>This page is not here any more</h1>
<p>The demo you are looking for has been taken down or never existed. If somebody at ${company} sent you the link, ask them for a new one.</p>
</main></body></html>`;
}
