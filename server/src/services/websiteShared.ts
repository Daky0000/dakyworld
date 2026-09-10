import type { Request, Response, Router } from "express";
import type { Site, SitePage } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  buildPublishPlan, describeChanges, discoverFields, instanceShape, resolveSharedValues, sanitizeSharedValue,
  sharedCandidates, sourceHash, versionValues,
  type FieldValue, type SharedSlot, type SiteField,
} from "./website/index.js";
import { pageSource, publishPages, WebsiteError } from "./website/site.js";
import { withWebsitePublishLocks } from "./websitePublishing.js";
import { advancePublishJob, failPublishJob, publishJobCommitted, publishJobView, startPublishJob } from "./websitePublishJobs.js";
import { createHash } from "node:crypto";

/**
 * Shared elements, from the database side.
 *
 * The pure half of this feature — what counts as the same element on two pages,
 * what the slots inside one are, and how a change written once lands on each
 * page's own field ids — is `services/website/shared.ts` and has no database in
 * it. This is everything that has to decide: where a shared edit is stored,
 * which pages a publish touches, and what it refuses to do.
 *
 * Three decisions worth not re-litigating.
 *
 * **A shared change is stored once, against the shared element**, keyed by slot.
 * The alternative — copying the same edit into seven page drafts — is the thing
 * that makes shared elements unmaintainable: seven drafts to keep in step, seven
 * things to review, and no way to say afterwards that they were one change.
 *
 * **A page publish never publishes a shared change.** It would publish one page
 * of seven and report success, leaving a site whose header says two different
 * things. The page's own edits publish normally; the shared change is published
 * from the shared change, to every linked page, in one commit.
 *
 * **Every affected page is hashed at review and checked again before writing.**
 * A shared value carries no per-field `original` — there is no one thing seven
 * pages said — so the guard is the whole source of every page that would be
 * written. Stricter than the per-field check, and it has to be.
 */

type Access = {
  loadSite: (req: Request, id: string) => Promise<Site>;
  loadPage: (req: Request, id: string) => Promise<{ page: SitePage; site: Site }>;
};

const actor = (req: Request) => ({ actorName: req.dbUser?.name ?? "Website editor", actorId: req.dbUser?.id });

/** Pages read for detection in one request. Detection is a suggestion, not a scan. */
const DETECTION_PAGE_LIMIT = 25;

const slotsOf = (row: { slots: Prisma.JsonValue }): SharedSlot[] => (Array.isArray(row.slots) ? (row.slots as unknown as SharedSlot[]) : []);
const draftOf = (row: { draft: Prisma.JsonValue | null }): Record<string, FieldValue> =>
  row.draft && typeof row.draft === "object" && !Array.isArray(row.draft) ? (row.draft as unknown as Record<string, FieldValue>) : {};

export type SharedFieldScope = {
  sharedElementId: string;
  instanceId: string;
  key: string;
  name: string;
  slot: string;
  state: "LINKED" | "DETACHED";
  /** How many pages this change would reach — the number the editor shows. */
  linkedPages: number;
};

export type SharedOnPage = {
  values: Record<string, FieldValue>;
  /** What the inspector needs to say "this is shared, and with how many pages". */
  scope: Record<string, SharedFieldScope>;
  elements: Array<{
    id: string;
    instanceId: string;
    key: string;
    name: string;
    rootFieldId: string;
    state: "LINKED" | "DETACHED";
    revision: number;
    linkedPages: number;
    pendingSlots: number;
    /** Slots this page could not receive, because its copy has changed shape. */
    mismatched: string[];
  }>;
};

/**
 * What the shared elements on this page are giving it, and what to say about it.
 *
 * Called wherever a page is read — the editor, the preview and the publish plan
 * — so that a shared draft is visible on every page it reaches rather than only
 * on the page somebody happened to type it on. That is the whole of §38 of the
 * specification, and it falls out of resolving here rather than at publish time.
 */
export async function sharedOnPage(page: SitePage, html: string): Promise<SharedOnPage> {
  const instances = await prisma.sharedElementInstance.findMany({
    where: { pageId: page.id },
    include: { element: { include: { _count: { select: { instances: true } } } } },
  });
  if (!instances.length) return { values: {}, scope: {}, elements: [] };

  const linkedCounts = await prisma.sharedElementInstance.groupBy({
    by: ["sharedElementId"],
    where: { sharedElementId: { in: instances.map((instance) => instance.sharedElementId) }, state: "LINKED" },
    _count: { _all: true },
  });
  const linkedBy = new Map(linkedCounts.map((row) => [row.sharedElementId, row._count._all]));

  const values: Record<string, FieldValue> = {};
  const scope: Record<string, SharedFieldScope> = {};
  const elements: SharedOnPage["elements"] = [];

  for (const instance of instances) {
    const slots = slotsOf(instance.element);
    const draft = draftOf(instance.element);
    const resolved = resolveSharedValues({ html, rootFieldId: instance.nodeId, slots, values: draft });
    const linkedPages = linkedBy.get(instance.sharedElementId) ?? 0;

    // A detached instance keeps its own local draft and is told nothing more.
    if (instance.state === "LINKED") Object.assign(values, resolved.values);

    const shape = instanceShape(html, instance.nodeId);
    for (const [position, slot] of (shape?.slots ?? []).entries()) {
      const fieldId = fieldIdForSlot(html, instance.nodeId, position);
      if (!fieldId) continue;
      scope[fieldId] = {
        sharedElementId: instance.sharedElementId,
        instanceId: instance.id,
        key: instance.element.key,
        name: instance.element.name,
        slot: slot.key,
        state: instance.state,
        linkedPages,
      };
    }

    elements.push({
      id: instance.sharedElementId,
      instanceId: instance.id,
      key: instance.element.key,
      name: instance.element.name,
      rootFieldId: instance.nodeId,
      state: instance.state,
      revision: instance.element.draftRevision,
      linkedPages,
      pendingSlots: Object.keys(draft).length,
      mismatched: resolved.mismatched,
    });
  }

  return { values, scope, elements };
}

/** The page's own field id at one position inside an instance. */
function fieldIdForSlot(html: string, rootFieldId: string, position: number): string | null {
  const shape = instanceShape(html, rootFieldId);
  if (!shape) return null;
  const slot = shape.slots[position];
  if (!slot) return null;
  const fields = discoverFields(html).fields;
  const root = fields.find((field) => field.id === rootFieldId);
  if (!root) return null;
  const members = descendants(fields, rootFieldId);
  return members[position]?.id ?? null;
}

function descendants(fields: SiteField[], rootFieldId: string): SiteField[] {
  const root = fields.find((field) => field.id === rootFieldId);
  if (!root) return [];
  const out: SiteField[] = [];
  const inside = (field: SiteField): boolean => {
    let walker = field.parentId;
    while (walker) {
      if (walker === rootFieldId) return true;
      walker = fields.find((candidate) => candidate.id === walker)?.parentId;
    }
    return false;
  };
  for (const field of fields) if (field.id === rootFieldId || inside(field)) out.push(field);
  return out.sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

/**
 * Splits a page's incoming draft into what belongs to it and what is shared.
 *
 * The editor sends back the values it was shown, and it was shown the shared
 * ones merged in. Without this split, every save would copy the shared change
 * into the page's own draft, and the two would immediately start to disagree.
 */
export function splitSharedEdits(
  html: string,
  scope: Record<string, SharedFieldScope>,
  values: Record<string, { value?: string; href?: string; alt?: string; style?: string; responsive?: unknown; variant?: string | null; newTab?: boolean }>,
): { own: typeof values; shared: Map<string, Record<string, typeof values[string]>> } {
  const own: typeof values = {};
  const shared = new Map<string, Record<string, typeof values[string]>>();
  for (const [fieldId, edit] of Object.entries(values)) {
    const owner = scope[fieldId];
    // Only a linked instance takes the edit away from the page. A detached one
    // is a local element again in every respect.
    if (!owner || owner.state !== "LINKED") {
      own[fieldId] = edit;
      continue;
    }
    const group = shared.get(owner.sharedElementId) ?? {};
    group[owner.slot] = edit;
    shared.set(owner.sharedElementId, group);
  }
  void html;
  return { own, shared };
}

/**
 * Writes the shared half of a page's draft save.
 *
 * The editor sends one set of values for the page it is looking at; the ones
 * belonging to a linked shared instance are stored against the shared element
 * instead, keyed by slot, so a change made on the home page is the same change
 * the services page shows. Each shared element carries its own revision, quoted
 * back on the save, for the reason the page draft does: two people editing the
 * same header from two different pages must not silently overwrite each other.
 */
export async function saveSharedEdits(input: {
  html: string;
  pageId: string;
  scope: Record<string, SharedFieldScope>;
  values: Record<string, Parameters<typeof sanitizeSharedValue>[1]>;
  revisions: Record<string, number>;
  userId?: string;
  fields: SiteField[];
}): Promise<{ applied: number; revisions: Record<string, number> }> {
  const groups = new Map<string, Array<{ slot: string; fieldId: string; edit: Parameters<typeof sanitizeSharedValue>[1] }>>();
  for (const [fieldId, edit] of Object.entries(input.values)) {
    const owner = input.scope[fieldId];
    if (!owner || owner.state !== "LINKED") continue;
    const group = groups.get(owner.sharedElementId) ?? [];
    group.push({ slot: owner.slot, fieldId, edit });
    groups.set(owner.sharedElementId, group);
  }
  if (!groups.size) return { applied: 0, revisions: {} };

  const revisions: Record<string, number> = {};
  let applied = 0;

  for (const [sharedElementId, edits] of groups) {
    const element = await prisma.sharedElement.findUnique({ where: { id: sharedElementId } });
    if (!element) continue;
    const quoted = input.revisions[sharedElementId];
    if (quoted === undefined) {
      throw new WebsiteError(400, `This editor did not say which version of ${element.name} it was showing. Reload the page and make the change again — nothing has been lost.`);
    }
    if (quoted !== element.draftRevision) {
      throw new WebsiteError(409, `${element.name} is shared, and somebody changed it on another page while you were editing. Reload this page to see it as it now is; nothing has been overwritten.`);
    }

    const next: Record<string, FieldValue> = { ...draftOf(element) };
    for (const { slot, fieldId, edit } of edits) {
      const field = input.fields.find((candidate) => candidate.id === fieldId);
      if (!field) continue;
      const cleaned = sanitizeSharedValue(field, edit);
      // An edit that says nothing is a removal of whatever was pending for that
      // slot, not a no-op: it is how somebody puts a shared heading back.
      if (Object.keys(cleaned).length === 0) delete next[slot];
      else next[slot] = cleaned;
      applied += 1;
    }

    const written = await prisma.sharedElement.updateMany({
      where: { id: element.id, draftRevision: element.draftRevision },
      data: {
        draft: Object.keys(next).length ? (next as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        draftRevision: { increment: 1 },
        draftSavedAt: Object.keys(next).length ? new Date() : null,
        draftSavedById: Object.keys(next).length ? input.userId ?? null : null,
      },
    });
    if (!written.count) {
      throw new WebsiteError(409, `${element.name} changed on another page while this was saving. Reload this page to see it as it now is.`);
    }
    revisions[element.id] = element.draftRevision + 1;
  }

  void input.html;
  void input.pageId;
  return { applied, revisions };
}

const nameInput = z.string().trim().min(1).max(120);
const keyInput = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, "Use lower-case letters, numbers and hyphens.");

export function registerWebsiteShared(router: Router, access: Access) {
  const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => {
    void fn(req, res).catch(next);
  };

  /** Every shared element on a site, with where it appears. */
  router.get("/sites/:siteId/shared", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const elements = await prisma.sharedElement.findMany({
      where: { siteId: site.id },
      orderBy: { name: "asc" },
      include: { instances: { include: { page: { select: { id: true, title: true, path: true } } } }, draftSavedBy: { select: { id: true, name: true } } },
    });
    res.json({
      elements: elements.map((element) => ({
        id: element.id,
        key: element.key,
        name: element.name,
        origin: element.origin,
        revision: element.draftRevision,
        pendingSlots: Object.keys(draftOf(element)).length,
        savedAt: element.draftSavedAt,
        savedBy: element.draftSavedBy,
        slots: slotsOf(element),
        instances: element.instances.map((instance) => ({
          id: instance.id,
          pageId: instance.pageId,
          page: instance.page,
          nodeId: instance.nodeId,
          state: instance.state,
          detachedAt: instance.detachedAt,
        })),
      })),
    });
  }));

  /**
   * What looks shared and is not shared yet.
   *
   * Suggestions only. Nothing here creates anything, and a medium-confidence
   * group is offered as a question — the specification's own rule, and the
   * reason detection can afford to be generous without being dangerous.
   */
  router.get("/sites/:siteId/shared/suggestions", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const pages = await prisma.sitePage.findMany({ where: { siteId: site.id }, orderBy: { sortOrder: "asc" }, take: DETECTION_PAGE_LIMIT + 1 });
    const capped = pages.length > DETECTION_PAGE_LIMIT;
    const considered = pages.slice(0, DETECTION_PAGE_LIMIT);

    const sources = await Promise.all(
      considered.map(async (page) => {
        // A page the site cannot serve right now is left out rather than
        // failing the whole request: a suggestion list is best-effort.
        try {
          const source = await pageSource(site, page);
          return { pageId: page.id, title: page.title, html: source.html };
        } catch {
          return null;
        }
      }),
    );
    const readable = sources.filter((entry): entry is { pageId: string; title: string; html: string } => entry !== null);

    const taken = await prisma.sharedElementInstance.findMany({ where: { element: { siteId: site.id } }, select: { pageId: true, nodeId: true } });
    const already = new Set(taken.map((instance) => `${instance.pageId}:${instance.nodeId}`));

    // An element that is already shared is not a suggestion, and neither is a
    // group left with one page once its shared instances are taken out of it.
    const candidates = sharedCandidates(readable)
      .map((candidate) => ({ ...candidate, instances: candidate.instances.filter((instance) => !already.has(`${instance.pageId}:${instance.fieldId}`)) }))
      .filter((candidate) => candidate.instances.length > 1);

    res.json({
      candidates: candidates.map((candidate) => ({
        key: candidate.key,
        name: candidate.name,
        confidence: candidate.confidence,
        reason: candidate.reason,
        instances: candidate.instances.map((instance) => ({
          pageId: instance.pageId,
          fieldId: instance.fieldId,
          title: readable.find((page) => page.pageId === instance.pageId)?.title ?? "",
        })),
      })),
      readPages: readable.length,
      unreadable: considered.length - readable.length,
      capped,
      note: capped ? `Only the first ${DETECTION_PAGE_LIMIT} pages were compared.` : undefined,
    });
  }));

  /**
   * Makes one element shared, on the pages the person chose.
   *
   * An explicit decision, and it outranks anything detection later thinks: the
   * shape recorded here is the shape every instance is checked against.
   */
  router.post("/sites/:siteId/shared", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const body = z
      .object({
        name: nameInput,
        key: keyInput.optional(),
        pageId: z.string().min(1),
        fieldId: z.string().min(1).max(200),
        /** The other pages it should be linked on, as page id and root field id. */
        instances: z.array(z.object({ pageId: z.string().min(1), fieldId: z.string().min(1).max(200) })).max(200).default([]),
      })
      .parse(req.body);

    const origin = await prisma.sitePage.findFirst({ where: { id: body.pageId, siteId: site.id } });
    if (!origin) throw new WebsiteError(404, "That page is not part of this site.");
    const source = await pageSource(site, origin);
    const shape = instanceShape(source.html, body.fieldId);
    if (!shape) throw new WebsiteError(400, "That element is no longer on the page. Reopen the page and choose it again.");

    const field = discoverFields(source.html).fields.find((candidate) => candidate.id === body.fieldId);
    const key = body.key ?? `${slugOf(body.name)}-${Date.now().toString(36).slice(-4)}`;

    const wanted = [{ pageId: body.pageId, fieldId: body.fieldId }, ...body.instances.filter((instance) => instance.pageId !== body.pageId)];
    const pages = await prisma.sitePage.findMany({ where: { siteId: site.id, id: { in: wanted.map((instance) => instance.pageId) } } });
    const byId = new Map(pages.map((page) => [page.id, page]));

    // Every instance is checked against the recorded shape before the element
    // exists at all. A page that would be refused every change is not a page to
    // link and then report as broken for ever.
    const linkable: Array<{ pageId: string; fieldId: string }> = [];
    const refused: Array<{ pageId: string; title: string; reason: string }> = [];
    for (const instance of wanted) {
      const page = byId.get(instance.pageId);
      if (!page) {
        refused.push({ pageId: instance.pageId, title: "", reason: "That page is not part of this site." });
        continue;
      }
      try {
        const html = instance.pageId === body.pageId ? source.html : (await pageSource(site, page)).html;
        const resolved = resolveSharedValues({ html, rootFieldId: instance.fieldId, slots: shape.slots, values: {} });
        if (resolved.mismatched.length) {
          refused.push({ pageId: page.id, title: page.title, reason: "This page's copy has a different shape, so a change here could land in the wrong place." });
          continue;
        }
        linkable.push(instance);
      } catch {
        refused.push({ pageId: page.id, title: page.title, reason: "That page could not be read just now." });
      }
    }
    if (linkable.length < 2) {
      throw new WebsiteError(400, "A shared element needs at least two pages that hold the same thing. Only one could be linked.");
    }

    const created = await prisma.sharedElement.create({
      data: {
        siteId: site.id,
        key,
        name: body.name,
        tag: field?.tag ?? "div",
        origin: "manual",
        slots: shape.slots as unknown as Prisma.InputJsonValue,
        instances: { create: linkable.map((instance) => ({ pageId: instance.pageId, nodeId: instance.fieldId })) },
      },
      include: { instances: true },
    });

    await prisma.siteAuditEvent.create({
      data: {
        siteId: site.id,
        kind: "SHARED_CREATE",
        summary: `${body.name} is now shared across ${created.instances.length} pages`,
        ...actor(req),
        detail: { key, pages: created.instances.map((instance) => instance.pageId) },
      },
    });

    res.status(201).json({ id: created.id, key: created.key, name: created.name, instances: created.instances.length, refused });
  }));

  /** One shared element, with its pending change and where it would land. */
  router.get("/shared/:sharedId", handler(async (req, res) => {
    const { element, site } = await loadShared(req, req.params.sharedId);
    void site;
    res.json({
      id: element.id,
      key: element.key,
      name: element.name,
      origin: element.origin,
      revision: element.draftRevision,
      slots: slotsOf(element),
      values: draftOf(element),
      instances: element.instances.map((instance) => ({
        id: instance.id,
        pageId: instance.pageId,
        page: instance.page,
        nodeId: instance.nodeId,
        state: instance.state,
      })),
    });
  }));

  /**
   * Saves a change to the shared element itself.
   *
   * The revision exchange is the page draft's, for the same reason: two people
   * on two different pages of the same site are editing this one row, and a save
   * quoting a stale number is somebody about to overwrite work they have never
   * seen. Unlike a page draft there is no side-by-side merge to offer them yet —
   * the refusal says which shared element moved and what to do about it.
   */
  router.put("/shared/:sharedId/draft", handler(async (req, res) => {
    const { element, site } = await loadShared(req, req.params.sharedId);
    const body = z
      .object({
        ifRevision: z.number().int().nonnegative().optional(),
        /** The page the edit was typed on, so values can be cleaned against real fields. */
        pageId: z.string().min(1),
        values: z.record(
          z.object({
            value: z.string().max(20_000).optional(),
            href: z.string().max(2_000).optional(),
            alt: z.string().max(500).optional(),
            style: z.string().max(2_000).optional(),
            responsive: z.object({ tablet: z.string().max(2_000).optional(), mobile: z.string().max(2_000).optional() }).strict().optional(),
            variant: z.string().max(120).nullable().optional(),
            newTab: z.boolean().optional(),
          }),
        ),
      })
      .parse(req.body);

    if (body.ifRevision === undefined) {
      throw new WebsiteError(400, "This editor is out of date and cannot save shared changes safely. Reload the page and try again.");
    }
    if (body.ifRevision !== element.draftRevision) {
      throw new WebsiteError(409, `${element.name} was changed on another page while you were editing it. Reopen this page to see it as it now is.`);
    }

    const instance = element.instances.find((candidate) => candidate.pageId === body.pageId);
    if (!instance) throw new WebsiteError(400, "This page does not carry that shared element.");
    if (instance.state !== "LINKED") throw new WebsiteError(409, "This page's copy is detached, so changes here are its own. Re-link it to edit the shared element.");

    const source = await pageSource(site, await pageOf(instance.pageId));
    const fields = discoverFields(source.html).fields;
    const slots = slotsOf(element);
    const next: Record<string, FieldValue> = { ...draftOf(element) };

    for (const [slotKey, raw] of Object.entries(body.values)) {
      const position = slots.findIndex((slot) => slot.key === slotKey);
      if (position < 0) continue;
      const fieldId = fieldIdForSlot(source.html, instance.nodeId, position);
      const field = fieldId ? fields.find((candidate) => candidate.id === fieldId) : undefined;
      if (!field) continue;
      const cleaned = sanitizeSharedValue(field, raw as Parameters<typeof sanitizeSharedValue>[1]);
      if (Object.keys(cleaned).length === 0) delete next[slotKey];
      else next[slotKey] = cleaned;
    }

    const saved = await prisma.sharedElement.updateMany({
      where: { id: element.id, draftRevision: element.draftRevision },
      data: {
        draft: Object.keys(next).length ? (next as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        draftRevision: { increment: 1 },
        draftSavedAt: new Date(),
        draftSavedById: req.dbUser?.id ?? null,
      },
    });
    if (!saved.count) throw new WebsiteError(409, `${element.name} was changed on another page while this was saving. Reopen this page to see it as it now is.`);

    res.json({ revision: element.draftRevision + 1, values: next });
  }));

  /** Throws the pending shared change away, on every page at once. */
  router.delete("/shared/:sharedId/draft", handler(async (req, res) => {
    const { element } = await loadShared(req, req.params.sharedId);
    await prisma.sharedElement.update({
      where: { id: element.id },
      data: { draft: Prisma.DbNull, draftRevision: { increment: 1 }, draftSavedAt: null, draftSavedById: null },
    });
    res.json({ ok: true, revision: element.draftRevision + 1 });
  }));

  /**
   * Takes one page's copy out of the shared element.
   *
   * The page must not move when this happens — only the relationship changes —
   * so whatever the shared element was giving this page is written into the
   * page's own draft first, keyed by that page's own field ids. From then on the
   * two diverge, which is the point.
   */
  router.post("/shared/:sharedId/instances/:instanceId/detach", handler(async (req, res) => {
    const { element, site } = await loadShared(req, req.params.sharedId);
    const instance = element.instances.find((candidate) => candidate.id === req.params.instanceId);
    if (!instance) throw new WebsiteError(404, "That page is not linked to this shared element.");
    if (instance.state === "DETACHED") return res.json({ ok: true, state: "DETACHED", changed: 0 });

    const page = await pageOf(instance.pageId);
    const source = await pageSource(site, page);
    const snapshot = resolveSharedValues({ html: source.html, rootFieldId: instance.nodeId, slots: slotsOf(element), values: draftOf(element) });

    const existing = (page.draft as Record<string, FieldValue> | null) ?? {};
    const merged = { ...existing, ...snapshot.values };

    await prisma.$transaction([
      prisma.sitePage.update({
        where: { id: page.id },
        data: {
          draft: Object.keys(merged).length ? (merged as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          draftRevision: { increment: 1 },
          draftSavedAt: new Date(),
          draftSavedById: req.dbUser?.id ?? null,
        },
      }),
      prisma.sharedElementInstance.update({ where: { id: instance.id }, data: { state: "DETACHED", detachedAt: new Date() } }),
      prisma.siteAuditEvent.create({
        data: { siteId: site.id, kind: "SHARED_DETACH", summary: `${page.title} was detached from ${element.name}`, ...actor(req), detail: { sharedElementId: element.id, pageId: page.id } },
      }),
    ]);

    res.json({ ok: true, state: "DETACHED", changed: Object.keys(snapshot.values).length, mismatched: snapshot.mismatched });
  }));

  /**
   * Puts one page's copy back under the shared element.
   *
   * The default is the one the specification asks for: the shared version wins,
   * and this page's local copy of those slots goes. Making a local copy the new
   * shared version changes every other page, so it is not something re-linking
   * does quietly.
   */
  router.post("/shared/:sharedId/instances/:instanceId/relink", handler(async (req, res) => {
    const { element, site } = await loadShared(req, req.params.sharedId);
    const instance = element.instances.find((candidate) => candidate.id === req.params.instanceId);
    if (!instance) throw new WebsiteError(404, "That page is not part of this shared element.");
    if (instance.state === "LINKED") return res.json({ ok: true, state: "LINKED", cleared: 0 });

    const page = await pageOf(instance.pageId);
    const source = await pageSource(site, page);
    const shape = instanceShape(source.html, instance.nodeId);
    if (!shape) throw new WebsiteError(409, `${page.title} no longer holds that element, so it cannot be re-linked.`);
    const check = resolveSharedValues({ html: source.html, rootFieldId: instance.nodeId, slots: slotsOf(element), values: {} });
    if (check.mismatched.length) {
      throw new WebsiteError(409, `${page.title}'s copy has a different shape from the shared element, so re-linking it could put a change in the wrong place.`);
    }

    // The local draft for exactly the slots the shared element owns is dropped;
    // anything else on the page is somebody's own work and stays.
    const owned = new Set(
      shape.slots
        .map((_, position) => fieldIdForSlot(source.html, instance.nodeId, position))
        .filter((id): id is string => id !== null),
    );
    const existing = (page.draft as Record<string, FieldValue> | null) ?? {};
    const kept = Object.fromEntries(Object.entries(existing).filter(([fieldId]) => !owned.has(fieldId)));

    await prisma.$transaction([
      prisma.sitePage.update({
        where: { id: page.id },
        data: {
          draft: Object.keys(kept).length ? (kept as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          draftRevision: { increment: 1 },
          draftSavedAt: new Date(),
          draftSavedById: req.dbUser?.id ?? null,
        },
      }),
      prisma.sharedElementInstance.update({ where: { id: instance.id }, data: { state: "LINKED", detachedAt: null } }),
      prisma.siteAuditEvent.create({
        data: { siteId: site.id, kind: "SHARED_RELINK", summary: `${page.title} was re-linked to ${element.name}`, ...actor(req), detail: { sharedElementId: element.id, pageId: page.id } },
      }),
    ]);

    res.json({ ok: true, state: "LINKED", cleared: Object.keys(existing).length - Object.keys(kept).length });
  }));

  /**
   * What publishing this shared change would do, page by page.
   *
   * Every affected page is read fresh and hashed, and the hashes come back with
   * the review. The publish will not proceed unless it is handed the same ones,
   * so a page that moved between the review and the button is a refusal rather
   * than a surprise.
   */
  router.get("/shared/:sharedId/review", handler(async (req, res) => {
    const { element, site } = await loadShared(req, req.params.sharedId);
    res.json(publicReview(await buildSharedReview(site, element)));
  }));

  /**
   * Publishes one shared change to every page it is linked to, or to none.
   *
   * All-or-nothing at the level of the change, not the page: the whole point of
   * a shared element is that the seven pages agree, and a publish that writes
   * six of them has broken the thing it was asked to maintain. One commit, with
   * every affected file's expected content attached, so GitHub refuses the lot
   * if any of them moved.
   */
  router.post("/shared/:sharedId/publish", handler(async (req, res) => {
    const { element, site } = await loadShared(req, req.params.sharedId);
    const body = z.object({
      ifRevision: z.number().int().nonnegative(),
      /** The hashes the review showed, one per affected page. */
      pages: z.record(z.string().length(64)),
    }).parse(req.body);

    if (body.ifRevision !== element.draftRevision) {
      throw new WebsiteError(409, `${element.name} changed after your review. Review it again before publishing.`);
    }

    // Locked before it is read: an ordinary publish of one of these pages must
    // not be deciding what that file says at the same time as this one.
    const result = await withWebsitePublishLocks(element.instances.filter((instance) => instance.state === "LINKED").map((instance) => instance.pageId), async (tx) => {
    // Recorded before GitHub is touched, exactly as a page publish is. A shared
    // publish writes several files, so an interruption here leaves more than one
    // page ahead of this system and is worth more, not less, than a page's.
    const job = await startPublishJob({
      site,
      kind: "SHARED",
      sharedElementId: element.id,
      startedById: req.dbUser?.id,
      detail: { name: element.name, revision: element.draftRevision },
    });

    const review = await buildSharedReview(site, element);
    if (!review.publishable) {
      await failPublishJob(job.id, "CONFLICT", review.reason ?? "This shared change could not be published.");
      throw Object.assign(new WebsiteError(409, review.reason ?? `${element.name} cannot be published yet.`), { pages: publicReview(review).pages });
    }
    for (const page of review.pages) {
      if (body.pages[page.pageId] !== page.sourceHash) {
        await failPublishJob(job.id, "CONFLICT", `${page.title} changed after the review, so nothing was published.`);
        throw Object.assign(new WebsiteError(409, `${page.title} changed after your review, so nothing has been published. Review this change again.`), { pages: publicReview(review).pages });
      }
    }

    const author = req.dbUser?.name ?? "the website editor";
    await advancePublishJob(job.id, "COMMITTING", {
      detail: {
        name: element.name,
        revision: element.draftRevision,
        pages: review.pages.map((page) => ({ pageId: page.pageId, path: page.path, hash: createHash("sha256").update(page.html!).digest("hex") })),
      },
    });
    let commit: { sha: string; url: string };
    try {
      commit = await publishPages({
        site,
        message: `Website: ${element.name} on ${review.pages.length} page${review.pages.length === 1 ? "" : "s"} (${author})`,
        pages: review.pages.map((page) => ({ page: page.record, html: page.html!, expectedSource: page.source })),
      });
    } catch (error) {
      await failPublishJob(job.id, "COMMIT_FAILED", error instanceof Error ? error.message : "The commit did not happen.");
      throw error;
    }
    // One page of the several is enough to watch: they went out in one commit,
    // so the host has either rebuilt or it has not.
    const watched = review.pages[0]!;
    await publishJobCommitted({ id: job.id, commit, site, page: watched.record, html: watched.html!, summary: watched.summary });

    // The commit has landed. Everything below is bookkeeping, and a failure here
    // leaves the repository ahead of the database rather than the other way
    // round — the same trade the page publish makes, for the same reason.
    const published = new Date();
    {
      for (const page of review.pages) {
        const last = await tx.sitePageVersion.findFirst({ where: { pageId: page.pageId }, orderBy: { number: "desc" }, select: { number: true } });
        await tx.sitePageVersion.create({
          data: {
            pageId: page.pageId,
            number: (last?.number ?? 0) + 1,
            html: page.html!,
            values: versionValues(page.values) as unknown as Prisma.InputJsonValue,
            commitSha: commit.sha,
            commitUrl: commit.url,
            publishedById: req.dbUser?.id ?? null,
          },
        });
        await tx.sitePage.update({
          where: { id: page.pageId },
          data: {
            lastPublishedAt: published,
            sourceHtml: page.record.sourceHtml === null ? undefined : page.html!,
            // The page's own draft is untouched: this publish never carried it.
            draftRevision: { increment: 1 },
          },
        });
      }
      await tx.sharedElement.update({
        where: { id: element.id },
        data: { draft: Prisma.DbNull, draftRevision: { increment: 1 }, draftSavedAt: null, draftSavedById: null },
      });
      await tx.siteAuditEvent.create({
        data: {
          siteId: site.id,
          kind: "SHARED_PUBLISH",
          summary: `Published ${element.name} to ${review.pages.length} page${review.pages.length === 1 ? "" : "s"}`,
          ...actor(req),
          detail: { sharedElementId: element.id, pages: review.pages.map((page) => page.path), commit: commit.sha },
        },
      });
    }

    return {
      job: publishJobView(await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } })),
      commit: { sha: commit.sha, url: commit.url },
      pages: review.pages.map((page) => ({ pageId: page.pageId, title: page.title, path: page.path, changed: page.changed.length })),
      note: "GitHub Pages rebuilds the site after a commit. The change is usually live within a minute or two.",
    };
    });

    res.json(result);
  }));

  /**
   * Stops an element being shared, leaving every page exactly as it looks.
   *
   * Each linked page keeps what the shared element was giving it, as its own
   * draft. Deleting the row without that would silently revert seven pages to
   * whatever their HTML said before the change.
   */
  router.delete("/shared/:sharedId", handler(async (req, res) => {
    const { element, site } = await loadShared(req, req.params.sharedId);
    const draft = draftOf(element);
    if (Object.keys(draft).length) {
      for (const instance of element.instances) {
        if (instance.state !== "LINKED") continue;
        const page = await pageOf(instance.pageId);
        const source = await pageSource(site, page);
        const snapshot = resolveSharedValues({ html: source.html, rootFieldId: instance.nodeId, slots: slotsOf(element), values: draft });
        const existing = (page.draft as Record<string, FieldValue> | null) ?? {};
        const merged = { ...existing, ...snapshot.values };
        await prisma.sitePage.update({
          where: { id: page.id },
          data: { draft: Object.keys(merged).length ? (merged as unknown as Prisma.InputJsonValue) : Prisma.DbNull, draftRevision: { increment: 1 } },
        });
      }
    }
    await prisma.sharedElement.delete({ where: { id: element.id } });
    await prisma.siteAuditEvent.create({
      data: { siteId: site.id, kind: "SHARED_DELETE", summary: `${element.name} is no longer a shared element`, ...actor(req), detail: { key: element.key } },
    });
    res.json({ ok: true });
  }));

  async function loadShared(req: Request, sharedId: string) {
    const element = await prisma.sharedElement.findUnique({
      where: { id: sharedId },
      include: { instances: { include: { page: { select: { id: true, title: true, path: true } } } } },
    });
    if (!element) throw new WebsiteError(404, "That shared element is not in the editor.");
    const site = await access.loadSite(req, element.siteId);
    return { element, site };
  }
}

async function pageOf(pageId: string): Promise<SitePage> {
  const page = await prisma.sitePage.findUnique({ where: { id: pageId } });
  if (!page) throw new WebsiteError(404, "That page is no longer in the editor. Rescan the site.");
  return page;
}

const slugOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shared";

/**
 * The review, with the page sources taken out of it.
 *
 * The review carries each affected page's whole HTML because the publish that
 * follows needs it. None of that belongs in an HTTP response: it is large, it
 * is the one thing this API deliberately never hands over, and a client that
 * received it would sooner or later start deciding things from it.
 */
export function publicReview(review: Awaited<ReturnType<typeof buildSharedReview>>) {
  return {
    id: review.id,
    name: review.name,
    revision: review.revision,
    publishable: review.publishable,
    reason: review.reason,
    detached: review.detached,
    pages: review.pages.map((page) => ({
      pageId: page.pageId,
      title: page.title,
      path: page.path,
      sourceHash: page.sourceHash,
      changed: page.changed.length,
      summary: page.summary,
      problems: page.problems,
      blocked: page.blocked,
      /** False when this page already says all of it. */
      writes: page.html !== null,
    })),
  };
}

export type SharedReviewPage = {
  pageId: string;
  title: string;
  path: string;
  sourceHash: string;
  changed: string[];
  summary: ReturnType<typeof describeChanges>;
  problems: Array<{ id: string; label: string; reason: string }>;
  blocked?: string;
  /** Kept for the publish that follows; never serialised to the client. */
  record: SitePage;
  source: string;
  html: string | null;
  values: Record<string, FieldValue>;
};

/**
 * The whole shared change, page by page, decided before anything acts.
 *
 * Only the shared slots are applied. A page's own pending edits are deliberately
 * left out: they were not what anybody reviewed here, and publishing somebody's
 * half-finished paragraph because they also changed the header is exactly the
 * kind of surprise a publish must not contain.
 */
export async function buildSharedReview(
  site: Site,
  element: { id: string; name: string; slots: Prisma.JsonValue; draft: Prisma.JsonValue | null; draftRevision: number; instances: Array<{ id: string; pageId: string; nodeId: string; state: string }> },
): Promise<{ id: string; name: string; revision: number; publishable: boolean; reason?: string; pages: SharedReviewPage[]; detached: string[] }> {
  const draft = draftOf(element);
  const slots = slotsOf(element);
  const linked = element.instances.filter((instance) => instance.state === "LINKED");
  const detached = element.instances.filter((instance) => instance.state !== "LINKED").map((instance) => instance.pageId);

  if (!Object.keys(draft).length) {
    return { id: element.id, name: element.name, revision: element.draftRevision, publishable: false, reason: `${element.name} has no unpublished change.`, pages: [], detached };
  }

  const pages: SharedReviewPage[] = [];
  for (const instance of linked) {
    const record = await pageOf(instance.pageId);
    // Fresh, always: the whole purpose of the next few lines is to decide
    // whether this page has moved under the change.
    const source = await pageSource(site, record, { fresh: true });
    const resolved = resolveSharedValues({ html: source.html, rootFieldId: instance.nodeId, slots, values: draft });
    const plan = buildPublishPlan({ source: source.html, values: resolved.values });
    const content = discoverFields(source.html);

    pages.push({
      pageId: record.id,
      title: record.title,
      path: record.path,
      sourceHash: sourceHash(source.html),
      changed: plan.changed,
      summary: describeChanges(content.fields, resolved.values),
      problems: plan.problems,
      blocked: resolved.mismatched.length
        ? "This page's copy of the element has changed shape, so the change cannot be placed on it."
        : plan.problems.length
          ? "Some of the change cannot be published on this page."
          : plan.conflicts.length || plan.missing.length
            ? "This page has changed since the shared element was set up."
            : !plan.html
              ? undefined
              : undefined,
      record,
      source: source.html,
      html: plan.html,
      values: resolved.values,
    });
  }

  const blocked = pages.filter((page) => page.blocked);
  const writable = pages.filter((page) => page.html !== null);

  return {
    id: element.id,
    name: element.name,
    revision: element.draftRevision,
    publishable: blocked.length === 0 && writable.length === pages.length && pages.length > 0,
    reason: blocked.length
      ? `${blocked.length} of ${pages.length} linked page${pages.length === 1 ? "" : "s"} cannot receive this change, so none of them will be published.`
      : pages.length === 0
        ? `${element.name} is not linked to any page.`
        : writable.length === pages.length
          ? undefined
          : "Some linked pages already say all of this, so there is nothing to write to them. Publishing part of a shared change would leave the site disagreeing with itself.",
    pages,
    detached,
  };
}
