import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import {
  BUILTIN_FIELDS,
  LEAD_CAPTURE_METHODS,
  LEAD_FIELD_TYPES,
  LEAD_SOURCES,
  LEAD_STATUSES,
  isBuiltinKey,
  replaceFields,
  resolveFields,
  slugifyKey,
} from "../services/leadFields.js";
import { renderLeadsPdf, renderLeadsXlsx, type ExportGroup } from "../services/leadExport.js";
import { TAG_COLOURS, deleteTag, listTags, normaliseTags, registerTags, retagLeads, tagSlug } from "../services/leadTags.js";
import { STALE_AFTER_DAYS, caseStrength, isStale, prepareLead, prepareLeads, storedPrep } from "../services/leadPrep.js";
import { demoUrl } from "../services/demoBuilder.js";
import { appUrl } from "../services/emailSender.js";

export const leadsRouter = Router();

/** An export is a file someone waits for — big enough to be useful, bounded enough to finish. */
const EXPORT_LIMIT = 5000;

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
  /** Values for the columns that aren't Lead scalars — see services/leadFields.ts. */
  customFields: z.record(z.unknown()).nullable().optional(),
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
/**
 * The one filter every list, count, group and export on this screen is built
 * from. Exported as `buildLeadWhere` so `checks/rehearsal.ts` can assert what
 * it produces — hiding a rehearsal lead is a claim worth a regression check,
 * and the alternative is asserting it eight times over eight queries.
 */
export function buildWhere(query: Record<string, unknown>): Prisma.LeadWhereInput {
  const str = (key: string) => (typeof query[key] === "string" && query[key] ? (query[key] as string) : undefined);
  const where: Prisma.LeadWhereInput = {};

  const status = str("status");
  if (status) where.status = { in: status.split(",") as (typeof LEAD_STATUSES)[number][] };

  const source = str("source");
  if (source) where.source = { in: source.split(",") as (typeof LEAD_SOURCES)[number][] };

  // How the lead got in — a scrape, a spreadsheet, typed by hand.
  const captureMethod = str("captureMethod");
  if (captureMethod) {
    where.captureMethod = { in: captureMethod.split(",") as (typeof LEAD_CAPTURE_METHODS)[number][] };
  }

  const groupId = str("groupId");
  if (groupId) where.groupId = groupId === "none" ? null : groupId;

  const scraperSourceId = str("scraperSourceId");
  if (scraperSourceId) where.scraperSourceId = scraperSourceId;

  // Rehearsal leads are hidden unless asked for. They are real rows — the
  // workflow under test takes a lead id — but they are not prospects, and one
  // sitting at the top of the list because it was created five minutes ago is
  // somebody about to write to a business nobody chose to approach.
  //
  // Every count, group and export on this screen is built from this filter, so
  // this line is the whole exclusion rather than the first of eight.
  where.rehearsal = str("rehearsal") === "only" ? true : false;

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

  // `tags=cold-outreach,ghana` — any of them by default, all of them with
  // `tagMatch=all`. "Any" is the one people mean nine times in ten: a tag is a
  // label, and asking for two labels usually means "either of these".
  const tags = normaliseTags(str("tags")?.split(","));
  if (tags.length > 0) where.tags = str("tagMatch") === "all" ? { hasEvery: tags } : { hasSome: tags };

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

    const [byStatus, bySource, byMethod, byCity, byCategory, totals, reachable, newThisWeek, groups] = await Promise.all([
      prisma.lead.groupBy({ by: ["status"], _count: true, where }),
      prisma.lead.groupBy({ by: ["source"], _count: true, where }),
      // Counted against the *other* filters only, so the method chips still
      // show what switching to another method would find.
      prisma.lead.groupBy({ by: ["captureMethod"], _count: true, where: { ...where, captureMethod: undefined } }),
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
      byMethod,
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
  /// What this batch is, as opposed to what the businesses in it are.
  tags: z.array(z.string().max(60)).max(24).optional(),
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
    // A tag typed here is one the Owner chose, so it is registered as theirs
    // rather than as something a scrape coined.
    const tags = await registerTags(data.tags, { autoCreated: false });
    // A hand-made group that collides with an auto one just reuses it.
    const group = await prisma.leadGroup.upsert({
      where: { slug: slugify(data.name) },
      update: { name: data.name, description: data.description ?? undefined, ...(data.tags ? { tags } : {}) },
      create: { name: data.name, description: data.description ?? null, tags, slug: slugify(data.name) },
    });
    res.status(201).json(group);
  } catch (err) {
    next(err);
  }
});

leadsRouter.patch("/groups/:id", async (req, res, next) => {
  try {
    const data = groupInput.partial().parse(req.body);
    const group = await prisma.leadGroup.update({
      where: { id: req.params.id },
      data: { ...data, ...(data.tags ? { tags: await registerTags(data.tags, { autoCreated: false }) } : {}) },
    });
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

// --- Tags ------------------------------------------------------------------

/**
 * The tag vocabulary — see services/leadTags.ts.
 *
 * Registered here rather than under `/api/tags` because a tag is a property of
 * the pipeline, and the screen that manages one is the leads screen. Every
 * route below is mounted above `/:id`, or `/api/leads/tags` would be read as a
 * lead whose id is "tags".
 */
leadsRouter.get("/tags", async (_req, res, next) => {
  try {
    res.json({ tags: await listTags(), colours: TAG_COLOURS });
  } catch (err) {
    next(err);
  }
});

const tagInput = z.object({
  label: z.string().min(1).max(60),
  colour: z.enum(TAG_COLOURS).nullish(),
  description: z.string().max(300).nullish(),
});

leadsRouter.post("/tags", async (req, res, next) => {
  try {
    const input = tagInput.parse(req.body);
    const slug = tagSlug(input.label);
    if (!slug) return res.status(400).json({ error: "That name has no letters or numbers in it." });

    // Naming a tag that a scrape already coined is how an auto-created tag
    // gets adopted: it keeps its slug and every lead that carries it, and
    // stops being marked as something the system invented.
    const tag = await prisma.leadTag.upsert({
      where: { slug },
      update: { label: input.label, colour: input.colour ?? null, description: input.description ?? null, autoCreated: false },
      create: { slug, label: input.label, colour: input.colour ?? null, description: input.description ?? null, autoCreated: false },
    });
    res.status(201).json(tag);
  } catch (err) {
    next(err);
  }
});

/**
 * Renames or recolours a tag.
 *
 * The slug is deliberately not editable. It is the identity every lead and
 * every list holds, so changing it would orphan all of them — which is the
 * whole reason the arrays store the slug and not the label.
 */
leadsRouter.patch("/tags/:id", async (req, res, next) => {
  try {
    const input = tagInput.partial().parse(req.body);
    const tag = await prisma.leadTag.update({
      where: { id: req.params.id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.colour !== undefined ? { colour: input.colour ?? null } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      },
    });
    res.json(tag);
  } catch (err) {
    next(err);
  }
});

/** Deletes the tag *and* takes it off every lead and list carrying it. */
leadsRouter.delete("/tags/:id", async (req, res, next) => {
  try {
    const tag = await prisma.leadTag.findUnique({ where: { id: req.params.id } });
    if (!tag) return res.status(404).json({ error: "No such tag." });
    const removed = await deleteTag(tag.slug);
    res.json({ deleted: tag.slug, ...removed });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/leads/export?format=xlsx|pdf — the current view, as a file.
 *
 * Takes exactly the same query string as the table, so what downloads is what
 * you were looking at. Grouped by batch, each batch keeps its own columns —
 * one worksheet each, because two batches with different columns can't share a
 * sheet without one of them losing columns.
 */
leadsRouter.get("/export", async (req, res, next) => {
  try {
    const format = String(req.query.format ?? "xlsx").toLowerCase();
    if (format !== "xlsx" && format !== "pdf") {
      return res.status(400).json({ error: "format must be xlsx or pdf" });
    }

    const where = buildWhere(req.query as Record<string, unknown>);
    const sort = SORTS[String(req.query.sort ?? "newest")] ?? SORTS.newest;
    const leads = await prisma.lead.findMany({ where, orderBy: sort, take: EXPORT_LIMIT, include: { group: true } });

    // One export per batch when the leads span several, so each keeps its own
    // columns; a single batch (or none) exports flat.
    const byGroup = new Map<string, { name: string; leads: typeof leads }>();
    for (const lead of leads) {
      const key = lead.groupId ?? "none";
      const bucket = byGroup.get(key) ?? { name: lead.group?.name ?? "Ungrouped", leads: [] };
      bucket.leads.push(lead);
      byGroup.set(key, bucket);
    }

    const groups: ExportGroup[] = [];
    for (const [key, bucket] of byGroup) {
      const { fields } = await resolveFields(key === "none" ? null : key);
      groups.push({ name: bucket.name, fields: fields.filter((field) => !field.hidden), leads: bucket.leads });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `dakyworld-leads-${stamp}.${format === "pdf" ? "pdf" : "xlsx"}`;
    const subtitle = `${leads.length} lead${leads.length === 1 ? "" : "s"} · exported ${stamp}${
      leads.length === EXPORT_LIMIT ? ` · capped at ${EXPORT_LIMIT}` : ""
    }`;

    const file =
      format === "pdf"
        ? await renderLeadsPdf(groups, "Lead export", subtitle)
        : await renderLeadsXlsx(groups, "Leads");

    res.setHeader(
      "Content-Type",
      format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(file);
  } catch (err) {
    next(err);
  }
});

// --- Columns ---------------------------------------------------------------
//
// The leads table's shape is data, not code: which columns show, in what order,
// under what label, and whether they're a Lead scalar or a value carried in
// `customFields`. A group with its own set overrides the default set entirely,
// which is what lets two batches imported from one workbook look nothing alike.

const fieldInput = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(60),
  type: z.enum(LEAD_FIELD_TYPES).optional(),
  hidden: z.boolean().optional(),
  width: z.number().int().min(60).max(600).nullable().optional(),
  meta: z.record(z.unknown()).nullable().optional(),
});

// GET /api/leads/fields?groupId= — the columns this view should render.
leadsRouter.get("/fields", async (req, res, next) => {
  try {
    const groupId = typeof req.query.groupId === "string" && req.query.groupId ? req.query.groupId : null;
    const resolved = await resolveFields(groupId);
    res.json({
      ...resolved,
      groupId,
      /** Everything a new column could map onto, for the column editor's picker. */
      builtins: BUILTIN_FIELDS,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/leads/fields — replaces a scope's whole column set.
 *
 * The column editor sends the list it wants to end up with, because reorder,
 * rename, hide, add and remove all arrive together and applying them one at a
 * time would leave the table in states the Owner never asked for.
 */
leadsRouter.put("/fields", async (req, res, next) => {
  try {
    const { groupId, fields } = z
      .object({ groupId: z.string().cuid().nullable().optional(), fields: z.array(fieldInput) })
      .parse(req.body);

    if (groupId) {
      const group = await prisma.leadGroup.findUnique({ where: { id: groupId }, select: { id: true } });
      if (!group) return res.status(404).json({ error: "Lead group not found" });
    }

    // A custom column must never claim a Lead scalar's name, or two different
    // things would write to one place.
    const seen = new Set<string>();
    const cleaned = fields.map((field) => {
      let key = field.key.trim();
      if (!isBuiltinKey(key)) key = slugifyKey(key);
      let candidate = key;
      let suffix = 2;
      while (seen.has(candidate)) candidate = `${key}_${suffix++}`;
      seen.add(candidate);
      return { ...field, key: candidate, meta: (field.meta ?? null) as Prisma.InputJsonValue | null };
    });

    const saved = await replaceFields(groupId ?? null, cleaned);
    res.json({ scope: groupId ? "group" : "default", groupId: groupId ?? null, fields: saved });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/leads/fields?groupId= — drops the override, falling back to the
// default set (or, for the default set, to the built-in columns).
leadsRouter.delete("/fields", async (req, res, next) => {
  try {
    const groupId = typeof req.query.groupId === "string" && req.query.groupId ? req.query.groupId : null;
    await prisma.leadField.deleteMany({ where: { groupId } });
    res.json(await resolveFields(groupId));
  } catch (err) {
    next(err);
  }
});

// --- Bulk actions ----------------------------------------------------------

// PATCH /api/leads/bulk — what you need after a scrape drops 200 rows at once.
leadsRouter.patch("/bulk", async (req, res, next) => {
  try {
    const { ids, status, groupId, addTags, removeTags } = z
      .object({
        ids: z.array(z.string().cuid()).min(1, "Select at least one lead"),
        status: z.enum(LEAD_STATUSES).optional(),
        groupId: z.string().cuid().nullable().optional(),
        addTags: z.array(z.string().max(60)).max(24).optional(),
        removeTags: z.array(z.string().max(60)).max(24).optional(),
      })
      .parse(req.body);

    // "Unchecked" is the variant that accepts foreign keys like groupId directly.
    const data: Prisma.LeadUncheckedUpdateManyInput = {};
    if (status) data.status = status;
    if (groupId !== undefined) data.groupId = groupId;

    // Tags are deliberately *not* done here with `push`. Prisma can push into
    // an array column in one statement but cannot pull from one and cannot
    // de-duplicate, so pushing a tag a lead already carries stores it twice.
    // retagLeads reads, merges and writes back — see services/leadTags.ts.
    const retagged = addTags?.length || removeTags?.length ? await retagLeads(ids, addTags ?? [], removeTags ?? []) : 0;

    if (Object.keys(data).length === 0 && retagged === 0) {
      return res.status(400).json({ error: "Nothing to change" });
    }

    const result = Object.keys(data).length ? await prisma.lead.updateMany({ where: { id: { in: ids } }, data }) : { count: 0 };
    res.json({ updated: Math.max(result.count, retagged), retagged });
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
        research: true,
        demos: { orderBy: { updatedAt: "desc" }, select: { id: true, slug: true, title: true, status: true, version: true, views: true, lastViewedAt: true, sentAt: true, updatedAt: true, createdAt: true, businessName: true, builtBy: true } },
        // The newest review only, and without `report` or `markdown`. Both are
        // large, both have their own endpoint, and neither is wanted by a
        // drawer that is showing a score and two links.
        websiteAudits: {
          orderBy: { ranAt: "desc" },
          take: 3,
          select: { id: true, ranAt: true, overallScore: true, verdict: true, website: true, pdfFileId: true, markdownFileId: true, screenshots: true, costUsd: true },
        },
      },
    });
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    const base = await appUrl();
    res.json({
      ...lead,
      researchStale: isStale(lead.research?.ranAt),
      // Derived rather than stored: it is a reading of the findings, and a
      // stored copy would drift the day the thresholds change.
      caseStrength: lead.research ? caseStrength(lead.research.audit as never, lead.research.look as never) : null,
      // Assembled here rather than in the client, so there is one spelling of
      // a demo's address in the whole system.
      demos: lead.demos.map((demo) => ({ ...demo, url: demoUrl(demo.slug, base) })),
    });
  } catch (err) {
    next(err);
  }
});

/** `customFields` is free-form JSON to zod but typed JSON to Prisma. */
function toPrismaData<T extends { customFields?: Record<string, unknown> | null }>(input: T) {
  const { customFields, ...rest } = input;
  return {
    ...rest,
    ...(customFields === undefined ? {} : { customFields: (customFields ?? Prisma.JsonNull) as Prisma.InputJsonValue }),
  };
}

leadsRouter.post("/", async (req, res, next) => {
  try {
    const data = leadInput.parse(req.body);
    if (data.tags) data.tags = await registerTags(data.tags, { autoCreated: false });
    const lead = await prisma.lead.create({ data: toPrismaData(data) });
    res.status(201).json(lead);
  } catch (err) {
    next(err);
  }
});

leadsRouter.patch("/:id", async (req, res, next) => {
  try {
    const data = leadInput.partial().parse(req.body);
    if (data.tags) data.tags = await registerTags(data.tags, { autoCreated: false });
    // A patch of one custom value shouldn't drop the others, so the incoming
    // object is merged over what the lead already holds.
    if (data.customFields) {
      const current = await prisma.lead.findUnique({ where: { id: req.params.id }, select: { customFields: true } });
      const previous = (current?.customFields as Record<string, unknown> | null) ?? {};
      data.customFields = { ...previous, ...data.customFields };
    }
    const lead = await prisma.lead.update({ where: { id: req.params.id }, data: toPrismaData(data) });
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
const prepareInput = z.object({
  /** Skip the live-source pass, for a record that is already complete. */
  skipResearch: z.boolean().default(false),
  /** Skip the screenshot and the model that reads it. */
  skipLook: z.boolean().default(false),
  /** Overwrite a discovery note that is already there. Off by default. */
  replaceDiscoveryNotes: z.boolean().default(false),
  /**
   * Run the four-reviewer website audit afterwards and produce the report.
   *
   * On by default here and off in the batch route, which is the split that
   * matters: this is one lead with a person watching, and the report is the
   * thing they are watching for. Sixty leads prepared overnight want the scan
   * and nothing else.
   */
  withAuditTeam: z.boolean().default(true),
});

/**
 * Goes and looks at this business: researches them, fills the blanks their
 * scrape left, checks their site and mail domain, and photographs their
 * homepage so a model can say what it looks like.
 *
 * Slow on purpose — a screenshot is a browser somewhere else opening a page.
 * It is a separate call from drafting so the person watching can see which
 * part is taking the time, and so the result is reusable: research is stored
 * against the lead and every draft to them afterwards reads it for nothing.
 *
 * Nothing here is destructive. Fields are only ever written into blanks, and
 * the one thing that could send a letter to the wrong person — a contact
 * address found by searching — is returned for a person to accept rather than
 * applied. See services/leadPrep.ts.
 */
const prepareManyInput = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  skipResearch: z.boolean().default(false),
  skipLook: z.boolean().default(false),
  /** Leave alone anything already looked at recently. On by default. */
  skipFresh: z.boolean().default(true),
});

/**
 * Looks at a list of businesses, with the screenshots batched into as few
 * Apify runs as possible.
 *
 * Mounted above `/:id/prepare` because "/prepare-many" would otherwise be read
 * as a lead id. Slow by nature — this is one browser opening two hundred pages
 * — so it answers with what it managed rather than holding a connection open
 * on all-or-nothing terms.
 */
leadsRouter.post("/prepare-many", requireRole("OWNER"), async (req, res, next) => {
  try {
    const input = prepareManyInput.parse(req.body);

    let ids = input.ids;
    if (input.skipFresh) {
      const fresh = await prisma.leadResearch.findMany({
        where: { leadId: { in: ids }, ranAt: { gt: new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000) } },
        select: { leadId: true },
      });
      const skip = new Set(fresh.map((row) => row.leadId));
      ids = ids.filter((id) => !skip.has(id));
    }
    if (ids.length === 0) {
      return res.json({ prepared: [], failed: [], skipped: input.ids.length, screenshotRuns: 0, screenshotsTaken: 0, costUsd: 0 });
    }

    const result = await prepareLeads(ids, { skipResearch: input.skipResearch, skipLook: input.skipLook });
    res.json({
      prepared: result.prepared.map((prep) => ({ leadId: prep.leadId, strength: prep.strength, filled: Object.keys(prep.filled) })),
      failed: result.failed,
      skipped: input.ids.length - ids.length,
      screenshotRuns: result.screenshotRuns,
      screenshotsTaken: result.screenshotsTaken,
      costUsd: result.costUsd,
    });
  } catch (err) {
    next(err);
  }
});

leadsRouter.post("/:id/prepare", async (req, res, next) => {
  try {
    const options = prepareInput.parse(req.body ?? {});
    const prep = await prepareLead(req.params.id, options);
    res.json(prep);
  } catch (err) {
    if ((err as Error).message === "Lead not found") return res.status(404).json({ error: "Lead not found" });
    next(err);
  }
});

/** What the last look found, without running another one. */
leadsRouter.get("/:id/research", async (req, res, next) => {
  try {
    const stored = await storedPrep(req.params.id);
    if (!stored) return res.json({ research: null, stale: true, staleAfterDays: STALE_AFTER_DAYS });
    res.json({ research: stored, stale: isStale(stored.ranAt), staleAfterDays: STALE_AFTER_DAYS });
  } catch (err) {
    next(err);
  }
});

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
