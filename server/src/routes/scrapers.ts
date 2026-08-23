import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  apifyConfigured,
  displayActorId,
  getActor,
  getActorSchema,
  getDatasetItems,
  getActorPricing,
  getMonthlyUsage,
  listMyActors,
  normalizeActorId,
  searchStore,
} from "../lib/apify.js";
import { CaptureBudgetError, CaptureBusyError, ScrapeInProgressError, runSource, stopRun } from "../services/scraperRunner.js";
import { computeNextRunAt, isValidTimezone, parseScheduleTime, syncSchedule } from "../services/scheduler.js";
import { SCRAPER_TEMPLATES } from "../services/scraperTemplates.js";
import { buildDedupeKey, describeShape, mapRow, scoreLead, type Preset } from "../services/leadMapping.js";
import { estimateCost } from "../services/captureCost.js";
import { readCaptureConfig, unknownInputKeys } from "../services/captureConfig.js";
import { gateBy } from "../middleware/permissionGate.js";

export const scrapersRouter = Router();

scrapersRouter.use(gateBy({ view: "leads.sources", create: "leads.sources", edit: "leads.sources", remove: "leads.sources" }));

// Lead sourcing spends money on Apify and writes straight into the pipeline,
// so configuring it stays with the Owner.

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
  // Left optional on purpose: anything the form doesn't send falls back to the
  // capture defaults in Settings, so those are a real default rather than a
  // number copied into every source at the moment it was created.
  maxItems: z.number().int().min(1).max(1000).optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  autoQualify: z.boolean().optional(),
  qualifyScore: z.number().int().min(0).max(100).optional(),
  scheduleEnabled: z.boolean().default(false),
  scheduleTimes: z.array(scheduleTime).max(6, "Six runs a day is plenty").default([]),
  timezone: z.string().refine(isValidTimezone, { message: "Unknown timezone" }).optional(),
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

    const config = await readCaptureConfig();
    // Spend is a live call to Apify; the page must still render when it fails.
    const usage = connected ? await getMonthlyUsage().catch(() => null) : null;

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
      spend: usage
        ? {
            spentUsd: usage.spentUsd,
            includedUsd: usage.includedUsd,
            budgetUsd: config.monthlyBudgetUsd,
            cycleEnd: usage.cycleEnd,
            /** True once runs are being refused rather than merely close to it. */
            blocked: config.monthlyBudgetUsd != null && usage.spentUsd >= config.monthlyBudgetUsd,
          }
        : null,
      concurrency: { running, limit: config.maxConcurrentRuns },
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

/**
 * GET /api/scrapers/actors — the health of every actor this install depends on.
 *
 * An actor is someone else's code on someone else's account: it gets renamed,
 * made private, deprecated, or repriced, and the first sign of any of that is
 * a scheduled run failing at 06:00. This answers the three questions worth
 * asking before that happens — is it still there, what does it cost now, and
 * is each source's input actually understood by it.
 *
 * `?refresh=1` bypasses the six-hour schema cache.
 */
scrapersRouter.get("/actors", async (req, res, next) => {
  try {
    const refresh = req.query.refresh === "1";
    const sources = await prisma.scraperSource.findMany({
      select: { id: true, name: true, actorId: true, input: true, enabled: true },
      orderBy: { name: "asc" },
    });

    const templateActors = new Set(SCRAPER_TEMPLATES.map((template) => template.actorId));
    const ids = [...new Set([...sources.map((source) => source.actorId), ...templateActors])];

    const actors = await Promise.all(
      ids.map(async (actorId) => {
        const [schema, pricing] = await Promise.all([getActorSchema(actorId, refresh), getActorPricing(actorId, "FREE", refresh)]);
        const used = sources
          .filter((source) => normalizeActorId(source.actorId) === normalizeActorId(actorId))
          .map((source) => ({
            id: source.id,
            name: source.name,
            enabled: source.enabled,
            // Keys the actor will silently ignore — nearly always a typo, and
            // invisible until you wonder why a filter isn't filtering.
            unknownKeys: unknownInputKeys((source.input ?? {}) as Record<string, unknown>, schema),
          }));

        return {
          actorId,
          reachable: schema !== null,
          title: schema?.title ?? null,
          pricingModel: pricing?.model ?? schema?.pricingModel ?? null,
          // The rate card as Apify publishes it today. `usedBy` below says
          // which sources are exposed to a change in it.
          rates: pricing?.events.map((event) => ({ key: event.key, label: event.title, usd: event.priceUsd, primary: event.primary })) ?? [],
          perResultUsd: pricing?.perResultUsd ?? null,
          minChargeUsd: pricing?.minChargeUsd ?? null,
          proxyField: schema?.proxyField ?? null,
          proxyRequired: schema?.proxyRequired ?? false,
          inTemplates: templateActors.has(actorId),
          usedBy: used,
        };
      }),
    );

    res.json({
      actors: actors.sort((a, b) => b.usedBy.length - a.usedBy.length || a.actorId.localeCompare(b.actorId)),
      unreachable: actors.filter((actor) => !actor.reachable).length,
      withUnknownKeys: actors.filter((actor) => actor.usedBy.some((source) => source.unknownKeys.length > 0)).length,
    });
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
    const config = await readCaptureConfig();
    const resolved = {
      ...data,
      maxItems: data.maxItems ?? config.maxItems,
      minScore: data.minScore ?? config.minScore,
      autoQualify: data.autoQualify ?? config.autoQualify,
      qualifyScore: data.qualifyScore ?? config.qualifyScore,
      timezone: data.timezone ?? config.timezone,
    };
    const created = await prisma.scraperSource.create({
      data: {
        ...resolved,
        actorId: normalizeStoredActorId(resolved.actorId),
        input: resolved.input as Prisma.InputJsonValue,
        fieldMap: (resolved.fieldMap ?? undefined) as Prisma.InputJsonValue | undefined,
        nextRunAt: computeNextRunAt(resolved),
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
    if (err instanceof ScrapeInProgressError || err instanceof CaptureBusyError) {
      return res.status(409).json({ error: err.message });
    }
    // 402: the request is fine, it's the money that has run out.
    if (err instanceof CaptureBudgetError) return res.status(402).json({ error: err.message });
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
      const { lead, shape, reason } = mapRow(item, { preset: source.preset as Preset, fieldMap });
      // The shape travels with every row, mapped or not: "read as an Instagram
      // profile" is the single most useful thing to know when the fields come
      // out wrong, and it used to be invisible.
      if (!lead) return { shape, readAs: describeShape(shape), skipped: reason, raw: item };
      const score = scoreLead(lead);
      return {
        lead,
        shape,
        readAs: describeShape(shape),
        score,
        dedupeKey: buildDedupeKey(lead),
        wouldSave: !lead.closed && score >= source.minScore,
        skipped: lead.closed ? "Marked closed" : score < source.minScore ? `Below the minimum score of ${source.minScore}` : null,
        raw: item,
      };
    });

    res.json({ items: preview });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/scrapers/cost — what a given actor and input would cost to run.
 *
 * Deliberately not tied to a saved source: quick capture, the source editor
 * and the template browser all need the same answer, and two of the three are
 * asking about something that doesn't exist in the database yet. Reads Apify's
 * published rates, so it is honest about actors this app has never seen.
 */
scrapersRouter.post("/cost", async (req, res, next) => {
  try {
    const { actorId, input, maxItems } = z
      .object({
        actorId: z.string().min(1).max(200),
        input: z.record(z.unknown()).default({}),
        maxItems: z.number().int().min(1).max(10_000).optional(),
      })
      .parse(req.body ?? {});

    const config = await readCaptureConfig();
    // The actor's declared keys tell the estimator which paid add-ons this
    // actor bakes in rather than offering as a switch.
    const schema = await getActorSchema(actorId).catch(() => null);
    const estimate = await estimateCost(actorId, input, maxItems ?? config.maxItems, schema?.properties ?? null);
    res.json(estimate);
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
