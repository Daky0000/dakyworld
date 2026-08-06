import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { apifyConfigured, displayActorId, getActor, getDatasetItems, listMyActors, normalizeActorId, searchStore } from "../lib/apify.js";
import { ScrapeInProgressError, runSource, stopRun } from "../services/scraperRunner.js";
import { computeNextRunAt, isValidTimezone, parseScheduleTime, syncSchedule } from "../services/scheduler.js";
import { SCRAPER_TEMPLATES } from "../services/scraperTemplates.js";
import { buildDedupeKey, mapItemToLead, scoreLead, type Preset } from "../services/leadMapping.js";

export const scrapersRouter = Router();

// Lead sourcing spends money on Apify and writes straight into the pipeline,
// so configuring it stays with the Owner.
scrapersRouter.use(requireRole("OWNER"));

const LEAD_SOURCES = [
  "REFERRAL",
  "LINKEDIN",
  "COLD_EMAIL",
  "OUTREACH",
  "CONTENT",
  "WARM_NETWORK",
  "GOOGLE_MAPS",
  "WEB_SCRAPE",
  "DIRECTORY",
  "SOCIAL",
  "OTHER",
] as const;

const scheduleTime = z.string().refine((value) => parseScheduleTime(value) !== null, {
  message: "Use 24-hour HH:mm, e.g. 06:30",
});

const sourceInput = z.object({
  name: z.string().min(1, "Give this source a name"),
  actorId: z.string().min(3, "Enter an Apify actor, e.g. compass/crawler-google-places"),
  description: z.string().optional().nullable(),
  input: z.record(z.unknown()).default({}),
  fieldMap: z.record(z.string()).nullable().optional(),
  preset: z.enum(["AUTO", "GOOGLE_MAPS", "GENERIC_CONTACT", "CUSTOM"]).default("AUTO"),
  leadSource: z.enum(LEAD_SOURCES).default("GOOGLE_MAPS"),
  groupName: z.string().max(120).optional().nullable(),
  enabled: z.boolean().default(true),
  maxItems: z.number().int().min(1).max(1000).default(100),
  minScore: z.number().int().min(0).max(100).default(0),
  autoQualify: z.boolean().default(true),
  qualifyScore: z.number().int().min(0).max(100).default(60),
  scheduleEnabled: z.boolean().default(false),
  scheduleTimes: z.array(scheduleTime).max(6, "Six runs a day is plenty").default([]),
  timezone: z
    .string()
    .refine(isValidTimezone, { message: "Unknown timezone" })
    .default("Africa/Accra"),
});

/** Actors are stored in their display form (`username/actor`), whatever was pasted. */
function normalizeStoredActorId(actorId: string) {
  return displayActorId(normalizeActorId(actorId));
}

// --- Overview --------------------------------------------------------------

// GET /api/scrapers/overview — the header strip on the Lead Sources page.
scrapersRouter.get("/overview", async (_req, res, next) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const [connected, sources, running, capturedThisWeek, capturedTotal, lastRun] = await Promise.all([
      apifyConfigured(),
      prisma.scraperSource.findMany({ orderBy: { name: "asc" } }),
      prisma.scraperRun.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
      prisma.lead.count({ where: { scraperSourceId: { not: null }, createdAt: { gte: weekAgo } } }),
      prisma.lead.count({ where: { scraperSourceId: { not: null } } }),
      prisma.scraperRun.findFirst({ orderBy: { startedAt: "desc" }, include: { source: { select: { name: true } } } }),
    ]);

    const scheduled = sources
      .filter((source) => source.enabled && source.scheduleEnabled && source.nextRunAt)
      .sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime());

    res.json({
      connected,
      sourceCount: sources.length,
      enabledCount: sources.filter((source) => source.enabled).length,
      scheduledCount: scheduled.length,
      runningCount: running,
      nextRun: scheduled[0] ? { id: scheduled[0].id, name: scheduled[0].name, at: scheduled[0].nextRunAt } : null,
      capturedThisWeek,
      capturedTotal,
      lastRun,
    });
  } catch (err) {
    next(err);
  }
});

// --- Apify catalogue -------------------------------------------------------

// GET /api/scrapers/templates — pre-filled starting points.
scrapersRouter.get("/templates", (_req, res) => res.json(SCRAPER_TEMPLATES));

// GET /api/scrapers/catalog?search=google+maps — Apify Store search, plus the
// Owner's own actors, so adding a source never means hunting for an id.
scrapersRouter.get("/catalog", async (req, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const [store, mine] = await Promise.all([
      searchStore(search, 24).catch(() => []),
      // Only meaningful once a token exists, and irrelevant to a store search.
      search ? Promise.resolve([]) : listMyActors().catch(() => []),
    ]);
    res.json({ store, mine });
  } catch (err) {
    next(err);
  }
});

// GET /api/scrapers/catalog/actor?id=compass/crawler-google-places
// Actor ids contain a slash, so they travel as a query parameter.
scrapersRouter.get("/catalog/actor", async (req, res, next) => {
  try {
    const id = z.string().min(3).parse(req.query.id);
    res.json(await getActor(id));
  } catch (err) {
    next(err);
  }
});

// --- Sources ---------------------------------------------------------------

scrapersRouter.get("/sources", async (_req, res, next) => {
  try {
    const sources = await prisma.scraperSource.findMany({
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
      include: {
        _count: { select: { leads: true } },
        runs: { orderBy: { startedAt: "desc" }, take: 1 },
      },
    });
    res.json(sources);
  } catch (err) {
    next(err);
  }
});

scrapersRouter.get("/sources/:id", async (req, res, next) => {
  try {
    const source = await prisma.scraperSource.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { leads: true } },
        runs: { orderBy: { startedAt: "desc" }, take: 20 },
      },
    });
    if (!source) return res.status(404).json({ error: "Lead source not found" });
    res.json(source);
  } catch (err) {
    next(err);
  }
});

scrapersRouter.post("/sources", async (req, res, next) => {
  try {
    const data = sourceInput.parse(req.body);
    const created = await prisma.scraperSource.create({
      data: {
        ...data,
        actorId: normalizeStoredActorId(data.actorId),
        input: data.input as Prisma.InputJsonValue,
        fieldMap: (data.fieldMap ?? undefined) as Prisma.InputJsonValue | undefined,
        nextRunAt: computeNextRunAt(data),
      },
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

scrapersRouter.patch("/sources/:id", async (req, res, next) => {
  try {
    const data = sourceInput.partial().parse(req.body);
    const updated = await prisma.scraperSource.update({
      where: { id: req.params.id },
      data: {
        ...data,
        actorId: data.actorId ? normalizeStoredActorId(data.actorId) : undefined,
        input: data.input === undefined ? undefined : (data.input as Prisma.InputJsonValue),
        fieldMap: data.fieldMap === undefined ? undefined : ((data.fieldMap ?? Prisma.DbNull) as Prisma.InputJsonValue),
      },
    });
    // Any of enabled / scheduleEnabled / times / timezone can move the next slot.
    const nextRunAt = await syncSchedule(updated.id);
    res.json({ ...updated, nextRunAt });
  } catch (err) {
    next(err);
  }
});

scrapersRouter.delete("/sources/:id", async (req, res, next) => {
  try {
    // Leads keep their data; they just lose the link back to a source that no
    // longer exists (the FK is SET NULL), so deleting a source never deletes work.
    await prisma.scraperSource.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/scrapers/sources/:id/run — starts a run and returns immediately;
// a scrape takes minutes and the UI polls the run record.
scrapersRouter.post("/sources/:id/run", async (req, res, next) => {
  try {
    const run = await runSource(req.params.id, "MANUAL");
    res.status(202).json(run);
  } catch (err) {
    if (err instanceof ScrapeInProgressError) return res.status(409).json({ error: err.message });
    next(err);
  }
});

/**
 * POST /api/scrapers/sources/:id/preview — shows how rows would be read
 * without writing any leads. Uses pasted items when given, otherwise a sample
 * from the source's most recent run, so mapping can be checked before a
 * schedule starts filling the pipeline with mis-parsed rows.
 */
scrapersRouter.post("/sources/:id/preview", async (req, res, next) => {
  try {
    const source = await prisma.scraperSource.findUnique({ where: { id: req.params.id } });
    if (!source) return res.status(404).json({ error: "Lead source not found" });

    const body = z.object({ items: z.array(z.record(z.unknown())).max(20).optional() }).parse(req.body ?? {});
    let items = body.items ?? [];

    if (items.length === 0) {
      const lastRun = await prisma.scraperRun.findFirst({
        where: { sourceId: source.id, datasetId: { not: null } },
        orderBy: { startedAt: "desc" },
      });
      if (!lastRun?.datasetId) {
        return res.status(400).json({ error: "Run this source once (or paste sample rows) before previewing the mapping." });
      }
      items = await getDatasetItems(lastRun.datasetId, 5);
    }

    const fieldMap = (source.fieldMap ?? null) as Record<string, string> | null;
    const preview = items.slice(0, 5).map((item) => {
      const mapped = mapItemToLead(item, { preset: source.preset as Preset, fieldMap });
      if (!mapped) return { skipped: "No usable name in this row", raw: item };
      const score = scoreLead(mapped);
      return {
        lead: mapped,
        score,
        dedupeKey: buildDedupeKey(mapped),
        wouldSave: !mapped.closed && score >= source.minScore,
        skipped: mapped.closed ? "Marked closed" : score < source.minScore ? `Below the minimum score of ${source.minScore}` : null,
        raw: item,
      };
    });

    res.json({ items: preview });
  } catch (err) {
    next(err);
  }
});

// --- Runs ------------------------------------------------------------------

scrapersRouter.get("/runs", async (req, res, next) => {
  try {
    const sourceId = typeof req.query.sourceId === "string" ? req.query.sourceId : undefined;
    const take = Math.min(Number(req.query.take) || 25, 100);
    const runs = await prisma.scraperRun.findMany({
      where: sourceId ? { sourceId } : undefined,
      orderBy: { startedAt: "desc" },
      take,
      include: { source: { select: { id: true, name: true, actorId: true } } },
    });
    res.json(runs);
  } catch (err) {
    next(err);
  }
});

scrapersRouter.get("/runs/:id", async (req, res, next) => {
  try {
    const run = await prisma.scraperRun.findUnique({
      where: { id: req.params.id },
      include: {
        source: { select: { id: true, name: true, actorId: true } },
        leads: { orderBy: { leadScore: "desc" }, take: 50 },
      },
    });
    if (!run) return res.status(404).json({ error: "Run not found" });
    res.json(run);
  } catch (err) {
    next(err);
  }
});

scrapersRouter.post("/runs/:id/stop", async (req, res, next) => {
  try {
    res.json(await stopRun(req.params.id));
  } catch (err) {
    next(err);
  }
});
