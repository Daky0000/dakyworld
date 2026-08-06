import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const leadsRouter = Router();

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

const LEAD_STATUSES = ["NEW", "QUALIFYING", "QUALIFIED", "DISQUALIFIED", "CONVERTED", "LOST"] as const;

const leadInput = z.object({
  contactName: z.string().min(1),
  contactEmail: z.string().email().optional().nullable(),
  contactPhone: z.string().optional().nullable(),
  companyName: z.string().optional().nullable(),
  source: z.enum(LEAD_SOURCES).default("OTHER"),
  status: z.enum(LEAD_STATUSES).default("NEW"),
  leadScore: z.number().int().min(0).max(100).default(0),
  discoveryCallAt: z.coerce.date().optional().nullable(),
  discoveryNotes: z.string().optional().nullable(),
  estimatedDealSize: z.number().nonnegative().optional().nullable(),
  winLossReason: z.string().optional().nullable(),
  clientId: z.string().cuid().optional().nullable(),
  website: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  groupId: z.string().cuid().nullable().optional(),
});

const SORTS: Record<string, Prisma.LeadOrderByWithRelationInput> = {
  newest: { createdAt: "desc" },
  oldest: { createdAt: "asc" },
  score: { leadScore: "desc" },
  name: { contactName: "asc" },
  reviews: { reviewsCount: "desc" },
  rating: { rating: "desc" },
};

/** Turns the filter bar's query string into a Prisma filter. */
function buildWhere(query: Record<string, unknown>): Prisma.LeadWhereInput {
  const str = (key: string) => (typeof query[key] === "string" && query[key] ? (query[key] as string) : undefined);
  const where: Prisma.LeadWhereInput = {};

  const status = str("status");
  if (status) where.status = { in: status.split(",") as (typeof LEAD_STATUSES)[number][] };

  const source = str("source");
  if (source) where.source = { in: source.split(",") as (typeof LEAD_SOURCES)[number][] };

  const groupId = str("groupId");
  if (groupId) where.groupId = groupId === "none" ? null : groupId;

  const scraperSourceId = str("scraperSourceId");
  if (scraperSourceId) where.scraperSourceId = scraperSourceId;

  const scraperRunId = str("scraperRunId");
  if (scraperRunId) where.scraperRunId = scraperRunId;

  const city = str("city");
  if (city) where.city = { equals: city, mode: "insensitive" };

  const category = str("category");
  if (category) where.category = { equals: category, mode: "insensitive" };

  const minScore = Number(str("minScore"));
  if (Number.isFinite(minScore) && minScore > 0) where.leadScore = { gte: minScore };

  // `has=email,phone,website` — the "can I actually reach them" filter.
  const has = str("has")?.split(",") ?? [];
  if (has.includes("email")) where.contactEmail = { not: null };
  if (has.includes("phone")) where.contactPhone = { not: null };
  if (has.includes("website")) where.website = { not: null };
  if (has.includes("noWebsite")) where.website = null;

  const q = str("q");
  if (q) {
    where.OR = [
      { contactName: { contains: q, mode: "insensitive" } },
      { companyName: { contains: q, mode: "insensitive" } },
      { contactEmail: { contains: q, mode: "insensitive" } },
      { contactPhone: { contains: q, mode: "insensitive" } },
      { city: { contains: q, mode: "insensitive" } },
      { category: { contains: q, mode: "insensitive" } },
      { address: { contains: q, mode: "insensitive" } },
    ];
  }

  return where;
}

// GET /api/leads — filtered, sorted, paged.
leadsRouter.get("/", async (req, res, next) => {
  try {
    const where = buildWhere(req.query as Record<string, unknown>);
    const sort = SORTS[String(req.query.sort ?? "newest")] ?? SORTS.newest;
    const take = Math.min(Number(req.query.take) || 300, 1000);
    const skip = Number(req.query.skip) || 0;

    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: sort,
        take,
        skip,
        include: {
          client: { select: { id: true, name: true } },
          group: { select: { id: true, name: true } },
          scraperSource: { select: { id: true, name: true } },
          proposals: { select: { id: true, status: true } },
        },
      }),
      prisma.lead.count({ where }),
    ]);

    res.json({ items, total, take, skip });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/leads/stats — pipeline counters plus the distinct values the filter
 * bar offers. One call, because the Leads page needs all of it on first paint.
 */
leadsRouter.get("/stats", async (req, res, next) => {
  try {
    const where = buildWhere(req.query as Record<string, unknown>);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);

    const [byStatus, bySource, byCity, byCategory, totals, reachable, newThisWeek, groups] = await Promise.all([
      prisma.lead.groupBy({ by: ["status"], _count: true, where }),
      prisma.lead.groupBy({ by: ["source"], _count: true, where }),
      prisma.lead.groupBy({ by: ["city"], _count: true, where, orderBy: { _count: { city: "desc" } }, take: 25 }),
      prisma.lead.groupBy({ by: ["category"], _count: true, where, orderBy: { _count: { category: "desc" } }, take: 25 }),
      prisma.lead.aggregate({ where, _count: true, _avg: { leadScore: true }, _sum: { estimatedDealSize: true } }),
      prisma.lead.count({ where: { ...where, OR: [{ contactEmail: { not: null } }, { contactPhone: { not: null } }] } }),
      prisma.lead.count({ where: { ...where, createdAt: { gte: weekAgo } } }),
      prisma.leadGroup.findMany({
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { leads: true } } },
      }),
    ]);

    res.json({
      total: totals._count,
      averageScore: Math.round(totals._avg.leadScore ?? 0),
      pipelineValue: totals._sum.estimatedDealSize ?? 0,
      reachable,
      newThisWeek,
      byStatus,
      bySource,
      cities: byCity.filter((row) => row.city),
      categories: byCategory.filter((row) => row.category),
      groups,
    });
  } catch (err) {
    next(err);
  }
});

// --- Groups ----------------------------------------------------------------

const groupInput = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
});

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\da-z]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "group"
  );
}

leadsRouter.get("/groups", async (_req, res, next) => {
  try {
    const groups = await prisma.leadGroup.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { leads: true } } },
    });
    res.json(groups);
  } catch (err) {
    next(err);
  }
});

leadsRouter.post("/groups", async (req, res, next) => {
  try {
    const data = groupInput.parse(req.body);
    // A hand-made group that collides with an auto one just reuses it.
    const group = await prisma.leadGroup.upsert({
      where: { slug: slugify(data.name) },
      update: { name: data.name, description: data.description ?? undefined },
      create: { ...data, slug: slugify(data.name) },
    });
    res.status(201).json(group);
  } catch (err) {
    next(err);
  }
});

leadsRouter.patch("/groups/:id", async (req, res, next) => {
  try {
    const data = groupInput.partial().parse(req.body);
    const group = await prisma.leadGroup.update({ where: { id: req.params.id }, data });
    res.json(group);
  } catch (err) {
    next(err);
  }
});

// Deleting a group never deletes leads — they fall back to "Ungrouped".
leadsRouter.delete("/groups/:id", async (req, res, next) => {
  try {
    await prisma.lead.updateMany({ where: { groupId: req.params.id }, data: { groupId: null } });
    await prisma.leadGroup.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- Bulk actions ----------------------------------------------------------

// PATCH /api/leads/bulk — what you need after a scrape drops 200 rows at once.
leadsRouter.patch("/bulk", async (req, res, next) => {
  try {
    const { ids, status, groupId, addTags } = z
      .object({
        ids: z.array(z.string().cuid()).min(1, "Select at least one lead"),
        status: z.enum(LEAD_STATUSES).optional(),
        groupId: z.string().cuid().nullable().optional(),
        addTags: z.array(z.string()).optional(),
      })
      .parse(req.body);

    // "Unchecked" is the variant that accepts foreign keys like groupId directly.
    const data: Prisma.LeadUncheckedUpdateManyInput = {};
    if (status) data.status = status;
    if (groupId !== undefined) data.groupId = groupId;
    if (addTags?.length) data.tags = { push: addTags };

    if (Object.keys(data).length === 0) return res.status(400).json({ error: "Nothing to change" });

    const result = await prisma.lead.updateMany({ where: { id: { in: ids } }, data });
    res.json({ updated: result.count });
  } catch (err) {
    next(err);
  }
});

leadsRouter.post("/bulk/delete", async (req, res, next) => {
  try {
    const { ids } = z.object({ ids: z.array(z.string().cuid()).min(1) }).parse(req.body);
    // Proposals hold a lead reference; refuse rather than orphan them.
    const withProposals = await prisma.lead.count({ where: { id: { in: ids }, proposals: { some: {} } } });
    if (withProposals > 0) {
      return res.status(409).json({ error: `${withProposals} of these leads have proposals and can't be deleted.` });
    }
    await prisma.communication.deleteMany({ where: { leadId: { in: ids } } });
    const result = await prisma.lead.deleteMany({ where: { id: { in: ids } } });
    res.json({ deleted: result.count });
  } catch (err) {
    next(err);
  }
});

// --- Single lead -----------------------------------------------------------

leadsRouter.get("/:id", async (req, res, next) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: {
        client: true,
        group: true,
        scraperSource: { select: { id: true, name: true, actorId: true } },
        scraperRun: { select: { id: true, startedAt: true, trigger: true } },
        proposals: true,
        communications: { orderBy: { occurredAt: "desc" }, include: { loggedBy: { select: { id: true, name: true } } } },
      },
    });
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    res.json(lead);
  } catch (err) {
    next(err);
  }
});

leadsRouter.post("/", async (req, res, next) => {
  try {
    const data = leadInput.parse(req.body);
    const lead = await prisma.lead.create({ data });
    res.status(201).json(lead);
  } catch (err) {
    next(err);
  }
});

leadsRouter.patch("/:id", async (req, res, next) => {
  try {
    const data = leadInput.partial().parse(req.body);
    const lead = await prisma.lead.update({ where: { id: req.params.id }, data });
    res.json(lead);
  } catch (err) {
    next(err);
  }
});

leadsRouter.delete("/:id", async (req, res, next) => {
  try {
    // A proposal points at its lead; deleting underneath it would fail with a
    // raw foreign-key error, so say why instead.
    const proposals = await prisma.proposal.count({ where: { leadId: req.params.id } });
    if (proposals > 0) {
      return res.status(409).json({ error: "This lead has proposals. Mark it LOST instead of deleting it." });
    }
    await prisma.communication.deleteMany({ where: { leadId: req.params.id } });
    await prisma.lead.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/leads/:id/convert — promotes a qualified lead to a Client without
 * waiting for a proposal, carrying the scraped firmographics across so nothing
 * has to be retyped.
 */
leadsRouter.post("/:id/convert", async (req, res, next) => {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (lead.clientId) return res.status(409).json({ error: "This lead is already linked to a client" });

    const client = await prisma.client.create({
      data: {
        name: lead.companyName ?? lead.contactName,
        email: lead.contactEmail,
        phone: lead.contactPhone,
        address: lead.address,
        sector: lead.category,
        firstContactAt: lead.createdAt,
      },
    });
    const updated = await prisma.lead.update({
      where: { id: lead.id },
      data: { clientId: client.id, status: "CONVERTED" },
    });
    res.status(201).json({ client, lead: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/leads/:id/communications — log a call, email or meeting against the lead.
leadsRouter.post("/:id/communications", async (req, res, next) => {
  try {
    const data = z
      .object({
        type: z.enum(["EMAIL", "CALL", "MESSAGE", "MEETING"]),
        summary: z.string().min(1),
        outcome: z.string().optional().nullable(),
        occurredAt: z.coerce.date().optional(),
      })
      .parse(req.body);

    const communication = await prisma.communication.create({
      data: { ...data, leadId: req.params.id, loggedById: req.dbUser?.id },
    });
    res.status(201).json(communication);
  } catch (err) {
    next(err);
  }
});
