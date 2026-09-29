import { draftValues, loadSite, loadPage, syncDemoFromSitePage } from "../services/websitePageContext.js";
import { executePagePublish, executeVersionPublish } from "../services/websitePagePublication.js";
export { executePagePublish, executeVersionPublish } from "../services/websitePagePublication.js";

import { getOrLoad } from "../lib/cache.js";
import { listPage } from "../lib/pagination.js";
import { enqueueWebsiteWork, registerWebsiteWorkQueue } from "../services/websiteWorkQueue.js";
import { capacity } from "../lib/capacity.js";
import { versionDraft } from "../services/website/versionRestore.js";
import { rateLimit } from "../middleware/security.js";

import { Router, json } from "express";
import { createHash } from "node:crypto";


import { registerWebsiteAssistant } from "../services/websiteAssistant.js";
import { registerWebsiteBuilderAgent } from "../services/websiteBuilderAgent.js";
import { registerWebsiteSource } from "../services/websiteSource.js";
import { registerWebsiteFrameworkView, sourceManagedFields } from "../services/websiteFrameworkView.js";
import { nameFieldsOnPage } from "../services/websiteFrameworkPublish.js";
import { hasSourceManifest } from "../services/websitePageManifest.js";
import { embedWebsiteAssets } from "../services/websiteAssets.js";
import { registerWebsiteManagement, siteInput } from "../services/websiteManagement.js";
import { registerWebsiteShared, saveSharedEdits, sharedOnPage } from "../services/websiteShared.js";
import { registerWebsiteReadiness } from "../services/websiteReadiness.js";
import { registerWebsiteSurvey } from "../services/websiteSiteSurvey.js";
import { registerWebsiteOnboarding } from "../services/websiteOnboarding.js";
import { registerGithubAppRoutes } from "../services/githubAppRoutes.js";
import { assertEditAllowance, assertTierFeatureAccess, recordAiPromptUsed, recordEditUsed, registerWebsiteTierRoutes } from "../services/websiteTierPlans.js";
import { registerWebsitePublishJobs } from "../services/websitePublishJobs.js";
import { registerWebsiteHosting } from "../services/websiteHosting.js";
import { registerSubscriberSelfService } from "../services/websiteSubscriberSelfService.js";
import { registerWebsiteSetupAssistance } from "../services/websiteSetupAssistance.js";
import { registerWebsiteClientPortal } from "../services/websiteClientPortal.js";
import { registerWebsiteEscalationRoutes } from "../services/websiteEscalationService.js";
import { registerWebsiteApprovalRoutes } from "../services/websiteApprovalAndReview.js";
import { registerWebsiteSchedulerRoutes } from "../services/websitePublishScheduler.js";
import { registerWebsiteBatchEditingRoutes } from "../services/websiteBatchEditing.js";
import { registerWebsiteEditingPolicyRoutes } from "../services/websiteEditingPolicy.js";
import { registerWebsiteFreelancerWorkspaceRoutes } from "../services/websiteFreelancerWorkspace.js";

import { z } from "zod";

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { assertWebsiteConnectionChange, getWebsiteCapabilities, assertWebsiteSiteAccess, registerWebsiteMembership, websiteAccessGate, websiteCapabilities, websitePrincipal, websiteSiteFilter } from "../services/websiteAccess.js";
import { recordPresence, removePresence } from "../services/websitePresence.js";
// The engine comes through its one door — see services/website/index.ts for why.
// `site.js` is the other half and stays separate on purpose: it is the part that
// talks to GitHub and the network, and nothing in the core does.
import { DOCUMENT_KEY, draftDocument, editingSource, fieldValues, sourceHash, documentChanged, changeStructure, structureControls, applyValues, categoriseChanges, describeChanges, buildPreview, discoverFields, isVariantOfStem, sanitizeValue, validateFieldChange, type FieldValue, type SiteField } from "../services/website/index.js";
import { discoverPages, PAGE_LIST_FIELDS, pageSource, pageUrl, siteRepo, siteStyleClasses, WebsiteError } from "../services/website/site.js";

import { tailwindCdnCss } from "../services/website/cdnStyles.js";

/**
 * Editing the websites this company publishes.
 *
 * The shape to hold on to: **this API serves fields, not files.** A client asks
 * for a page and gets a list of headings, paragraphs, links and pictures with
 * plain labels on them; they send back the ones they changed. The HTML is read
 * fresh from the repository on every one of those calls and is never handed over
 * whole, because a page of markup in a text box is the thing the whole feature
 * exists to avoid.
 *
 * Drafts are values, never pages. A draft is `{ fieldId: { value, original } }`
 * — the change and what the page said when it was made. That is what lets a
 * developer go on editing the same files underneath: a draft written against a
 * heading that has since moved refuses to publish and says so, instead of
 * quietly writing itself into whatever now sits at that position.
 */
export const websiteRouter = Router();

websiteRouter.use(websiteAccessGate);
// The API already has a global ceiling. Expensive mutations get a separate,
// per-user budget so preview reads and ordinary typing never consume it.
const expensiveWebsiteWrite = rateLimit({ windowMs: 60_000, max: 20, message: "Too many publishing or assistant requests. Try again in {minutes}.", key: req => req.dbUser?.id ?? req.ip ?? "local" });
const websiteImportLimit = rateLimit({ windowMs: 10 * 60_000, max: 12, message: "Too many website imports. Try again in {minutes}.", key: req => req.dbUser?.id ?? req.ip ?? "local" });
websiteRouter.use((req, res, next) => {
  if (req.method === "POST" && /\/(publish|structure|assistant|agent|rollback)(?:\/|$)/.test(req.path)) return expensiveWebsiteWrite(req, res, next);
  // An import fetches somebody else's website and parses the whole document, so
  // it costs more than a publish and is worth a tighter bucket of its own.
  if (req.method === "POST" && /\/(import|pages\/import|fetch)(?:\/|$)/.test(req.path)) return websiteImportLimit(req, res, next);
  next();
});

// Business allows 10 MB binary assets; base64 in JSON needs about 13.4 MB.
websiteRouter.use(json({ limit: "16mb" }));
registerWebsiteTierRoutes(websiteRouter);
registerWebsiteHosting(websiteRouter);
registerSubscriberSelfService(websiteRouter);
registerWebsiteSetupAssistance(websiteRouter);
registerWebsiteClientPortal(websiteRouter);
registerWebsiteEscalationRoutes(websiteRouter);
registerWebsiteApprovalRoutes(websiteRouter);
registerWebsiteSchedulerRoutes(websiteRouter);
registerWebsiteBatchEditingRoutes(websiteRouter);
registerWebsiteEditingPolicyRoutes(websiteRouter);
registerWebsiteFreelancerWorkspaceRoutes(websiteRouter);

// Tier feature enforcement across SEO, AI Assistant, AI Builder Agent, and Source Editor routes
websiteRouter.use((req, _res, next) => {
  void (async () => {
    if (/\/(?:source|source-project)(?:\/|$)/.test(req.path)) {
      await assertTierFeatureAccess(req, "sourceCodeEditor");
    } else if (/\/agent(?:\/|$)/.test(req.path)) {
      await assertTierFeatureAccess(req, "aiBuilderAgent");
      if (!capacity.admission && req.method === "POST" && /\/agent\/(?:plan|apply)\/?$/.test(req.path)) await recordAiPromptUsed(req);
    } else if (/\/(?:assistant|suggest|ai)(?:\/|$)/.test(req.path)) {
      await assertTierFeatureAccess(req, "aiAssistant", undefined, { skipUsageLimit: capacity.admission && /\/pages\/[^/]+\/assistant\/?$/.test(req.path) });
      if (!capacity.admission && req.method === "POST") await recordAiPromptUsed(req);
    } else if (/\/seo(?:\/|$)/.test(req.path)) {
      await assertTierFeatureAccess(req, "seoInspector");
    }
  })().then(() => next(), next);
});

registerWebsiteMembership(websiteRouter);
registerWebsiteWorkQueue(websiteRouter);
registerWebsiteManagement(websiteRouter, { loadSite, loadPage });
registerWebsiteAssistant(websiteRouter, { loadPage });
registerWebsiteBuilderAgent(websiteRouter, { loadSite, loadPage });
registerWebsiteSource(websiteRouter, { loadSite });
registerWebsiteFrameworkView(websiteRouter, { loadPage });
registerWebsiteShared(websiteRouter, { loadSite, loadPage });
registerWebsiteReadiness(websiteRouter, { loadSite });
registerWebsiteSurvey(websiteRouter, { loadSite });
registerWebsitePublishJobs(websiteRouter, { loadSite });
registerWebsiteOnboarding(websiteRouter, { loadSite });
registerGithubAppRoutes(websiteRouter, { loadSite });

/**
 * Do two values read the same to a person?
 *
 * Whitespace is normalised because HTML's is: a newline between two spans, a
 * run of indentation, a non-breaking space typed where an ordinary one would do
 * — none of them change a word on the page, and all of them make a string
 * comparison say "different". The rollback confirmation was listing three
 * changes whose before and after were the same sentence for exactly this reason.
 */
function readsSame(a: string, b: string): boolean {
  const flatten = (value: string) => value.replace(/[\s\u00a0]+/g, " ").trim();
  return flatten(a) === flatten(b);
}

/** The editor never needs byte offsets; sending them would only invite something to trust them. */
function publicField(field: SiteField) {
  return {
    id: field.id,
    kind: field.kind,
    label: field.label,
    tag: field.tag,
    confidence: field.confidence,
    parentId: field.parentId,
    order: field.order,
    value: field.value,
    preview: field.preview,
    ...(field.note !== undefined ? { note: field.note } : {}),
    ...(field.href !== undefined ? { href: field.href } : {}),
    ...(field.alt !== undefined ? { alt: field.alt } : {}),
    ...(field.decorative !== undefined ? { decorative: field.decorative } : {}),
    // The offsets stay on the server. Everything else about a field is the
    // editor's business; where it sits in the file is not, and sending them
    // would invite a second implementation of the splice in the browser.
    ...(field.style !== undefined ? { style: field.style } : {}),
    ...(field.responsive !== undefined ? { responsive: field.responsive } : {}),
    // Buttons. `variantStem` travels because the editor labels a style by the
    // word after it — `btn-primary` reads as "Primary" — and `variantsOnPage`
    // is the menu: every style this page already wears somewhere, so picking
    // one can never produce a button the stylesheet has no rule for.
    ...(field.variant !== undefined ? { variant: field.variant } : {}),
    ...(field.variantStem !== undefined ? { variantStem: field.variantStem } : {}),
    ...(field.variantsOnPage !== undefined ? { variants: field.variantsOnPage } : {}),
    ...(field.newTab !== undefined ? { newTab: field.newTab } : {}),
    // Icons. The markup travels so the editor can draw what is there now; the
    // span it lives at does not, for the same reason as every other offset.
    ...(field.icon !== undefined ? { icon: field.icon } : {}),
    ...(field.iconPosition !== undefined ? { iconPosition: field.iconPosition } : {}),
    ...(field.iconType !== undefined ? { iconType: field.iconType } : {}),
    ...(field.iconAddable ? { iconAddable: true } : {}),
    ...(field.repeatable !== undefined ? { repeatable: field.repeatable } : {}),
  };
}





/**
 * A page and the site it belongs to, with the caller checked against the site.
 *
 * Loading the parent is not an extra query for the sake of it: authorising on a
 * page id alone is authorising on a value the caller supplied, and the record
 * that says who may touch it is one level up.
 */


websiteRouter.get("/sites", async (req, res, next) => {
  try {
    const principal = websitePrincipal(req);
    const siteFilter = websiteSiteFilter(req);
    const { limit, cursor } = listPage.parse(req.query);
    const rows = await prisma.site.findMany({
      where: siteFilter, orderBy: [{ name: "asc" }, { id: "asc" }], take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, name: true, slug: true, publicUrl: true, repoOwner: true, repoName: true,
        sourceKind: true, repoBranch: true, _count: { select: { pages: true } },
        client: { select: { id: true, name: true } }, members: { where: { userId: principal.id }, select: { role: true } } },
    });
    const sites = rows.slice(0, limit);
    const grouped = await prisma.sitePage.groupBy({ by: ["siteId"], where: { siteId: { in: sites.map(site => site.id) }, NOT: { draft: { equals: Prisma.DbNull } } }, _count: true });
    const drafts = new Map(grouped.map(row => [row.siteId, row._count]));
    if (rows.length > limit) res.set("X-Next-Cursor", sites[sites.length - 1]!.id);
    res.json(sites.map(site => ({ id: site.id, name: site.name, slug: site.slug, publicUrl: site.publicUrl,
      repo: siteRepo(site), sourceKind: site.sourceKind, branch: site.repoBranch, client: site.client,
      pageCount: site._count.pages, draftCount: drafts.get(site.id) ?? 0,
      capabilities: websiteCapabilities(principal, site.members[0]?.role ?? null),
    })));
  } catch (error) { next(error); }
});

websiteRouter.get("/sites/:siteId/pages", async (req, res, next) => {
  try {
    const site = await loadSite(req, req.params.siteId);
    const { limit, cursor } = listPage.parse(req.query);
    const result = await getOrLoad({ scope: `site:${site.id}`, resource: "metadata", identity: `pages:${req.dbUser!.id}`, query: { limit, cursor } }, { ttlMs: 15_000 }, async () => {
      const { draft: _draft, ...fields } = PAGE_LIST_FIELDS;
      const rows = await prisma.sitePage.findMany({ where: { siteId: site.id },
        orderBy: [{ sortOrder: "asc" }, { path: "asc" }, { id: "asc" }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { ...fields, draftSavedBy: { select: { id: true, name: true } } },
      });
      const pages = rows.slice(0, limit);
      const drafts = pages.length ? await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM "SitePage" WHERE id IN (${Prisma.join(pages.map(page => page.id))}) AND draft IS NOT NULL AND draft <> 'null'::jsonb`) : [];
      const draftIds = new Set(drafts.map(page => page.id));
      return { nextCursor: rows.length > limit ? pages[pages.length - 1]!.id : null,
        pages: pages.map(page => ({ id: page.id, title: page.title, path: page.path, filePath: page.filePath,
          status: page.status, url: pageUrl(site, page), hasDraft: draftIds.has(page.id), draftSavedAt: page.draftSavedAt,
          draftSavedBy: page.draftSavedBy, lastPublishedAt: page.lastPublishedAt })) };
    });
    res.json({ site: { id: site.id, name: site.name, publicUrl: site.publicUrl, repo: siteRepo(site), branch: site.repoBranch, sourceKind: site.sourceKind }, ...result });
  } catch (error) { next(error); }
});

/**
 * Finds the pages the site has and reconciles the list with what is here.
 *
 * Additive on purpose. A file that has disappeared from the repository keeps its
 * row and its history rather than being deleted — the version record of what was
 * published on a page is worth more than a tidy list, and a page that really is
 * gone can be hidden by hand.
 */
websiteRouter.post("/sites/:siteId/scan", async (req, res, next) => {
  try {
    const site = await loadSite(req, req.params.siteId);

    const discovery = await discoverPages(site);
    const found = discovery.pages;

    // The scan may have found the pages somewhere other than where the site
    // said they were. Save that, because a publish commits to `repoPath`: left
    // unsaved, every page read from the found folder would be written back to
    // the configured one.
    const movedTo = discovery.repoPath !== site.repoPath ? discovery.repoPath : null;
    // The framework is saved for the same reason the folder is: the page list,
    // the Edit button and the source editor all have to agree about what kind of
    // file a page is, and only the scan has looked.
    const sourceKind = discovery.sourceKind ?? null;
    if (movedTo !== null || sourceKind !== site.sourceKind) {
      await prisma.site.update({ where: { id: site.id }, data: { ...(movedTo !== null && { repoPath: movedTo }), sourceKind } });
    }

    const existing = await prisma.sitePage.findMany({ where: { siteId: site.id }, select: PAGE_LIST_FIELDS });
    const byFile = new Map(existing.map((page) => [page.filePath, page]));

    let added = 0;
    for (const [index, page] of found.entries()) {
      const already = byFile.get(page.filePath);
      if (already) {
        if (already.sortOrder !== index) await prisma.sitePage.update({ where: { id: already.id }, data: { sortOrder: index } });
        continue;
      }
      await prisma.sitePage.create({
        data: {
          siteId: site.id,
          title: page.title,
          path: page.path,
          filePath: page.filePath,
          sortOrder: index,
          // A file the site's own sitemap does not list is not a page the public
          // is meant to find — an archived draft, a plan document, the 404. It
          // is still here, but it starts out of the way.
          status: page.listed ? "LIVE" : "HIDDEN",
        },
      });
      added += 1;
    }

    const missing = existing.filter((page) => !found.some((candidate) => candidate.filePath === page.filePath)).map((page) => page.filePath);
    res.json({ found: found.length, added, missing, folder: discovery.repoPath, movedTo, sourceKind });
  } catch (err) {
    next(err);
  }
});

/** Where a site lives: its public address, and the repository a publish commits to. */
websiteRouter.patch("/sites/:siteId", async (req, res, next) => {
  try {
    const body = siteInput.partial().parse(req.body);
    const previous = await loadSite(req, req.params.siteId);
    assertWebsiteConnectionChange(req, previous, body);
    const site = await prisma.site.update({ where: { id: req.params.siteId }, data: body });
    res.json({ id: site.id, name: site.name, publicUrl: site.publicUrl, repo: siteRepo(site), branch: site.repoBranch });
  } catch (err) {
    next(err);
  }
});

websiteRouter.patch("/pages/:pageId", async (req, res, next) => {
  try {
    const body = z.object({ title: z.string().min(1).max(120).optional(), status: z.enum(["LIVE", "HIDDEN"]).optional() }).parse(req.body);
    await loadPage(req, req.params.pageId);
    const page = await prisma.sitePage.update({ where: { id: req.params.pageId }, data: body });
    res.json({ id: page.id, title: page.title, status: page.status });
  } catch (err) {
    next(err);
  }
});

/** A page opened for editing: its fields as they stand, plus whatever draft sits over them. */
websiteRouter.get("/pages/:pageId", async (req, res, next) => {
  try {
    const { page, site } = await loadPage(req, req.params.pageId);
    const source = await pageSource(site, page);
    const own = draftValues(page);
    // What the shared elements on this page are giving it, resolved onto this
    // page's own field ids. Merged before anything is read, so a change made on
    // another page is already on this one — in the panel and in the preview —
    // rather than appearing only when somebody publishes.
    const shared = await sharedOnPage(page, editingSource(source.html, own));
    const values = { ...own, ...shared.values };
    const content = discoverFields(editingSource(source.html, values));
    const controls = structureControls(editingSource(source.html, values));

    // The style menu, widened from what this page happens to wear to what the
    // site actually defines. Best-effort and never fatal: with no stylesheet
    // reachable the menu is still every style the page uses, and the rule that
    // decides whether a style may be *written* never consults this at all.
    const defined = await siteStyleClasses(site, page, source.html).catch(() => new Set<string>());
    const widen = (field: SiteField) => {
      if (field.classes === undefined) return field;
      // The stems this button could take a style from: the one it already wears
      // a style off, plus any class it carries that the stylesheet defines
      // styles for. The second is what lets a button wearing only `btn` be
      // *given* a colour — which is otherwise a one-way door, since picking
      // "None" and publishing would leave a button no menu could ever reach
      // again.
      const carried = field.classes.split(/\s+/).filter(Boolean);
      const stems = new Set(field.variantStem ? [field.variantStem] : []);
      for (const token of carried) {
        for (const candidate of defined) if (isVariantOfStem(token, candidate)) stems.add(token);
      }
      if (stems.size === 0) return field;

      const offered = new Set(field.variantsOnPage ?? []);
      for (const stem of stems) {
        for (const candidate of defined) if (isVariantOfStem(stem, candidate)) offered.add(candidate);
      }
      // Capped, because a utility-first stylesheet can define hundreds under
      // one stem and a menu of hundreds is not a menu.
      return {
        ...field,
        // A button with no style yet has no stem to read off itself, so the
        // one derived here travels with it — that is what lets the editor
        // label `btn-primary` as "Primary" rather than printing the class.
        // Only when there is exactly one: two stems and there is no single
        // word to strip.
        ...(field.variantStem === undefined && stems.size === 1 ? { variantStem: [...stems][0] } : {}),
        variantsOnPage: [...offered].sort().slice(0, 12),
      };
    };

    // On a framework page, which of these fields a publish could actually write.
    // The editor works on the built HTML, so it can show everything; only the
    // parts that trace back to a literal in the source can be changed, and the
    // rest have to say so on the field rather than at the publish, which is far
    // too late to be told.
    const managed = source.sourceFile ? await sourceManagedFields(site, page, source.html) : null;

    const [saver, siblings] = await Promise.all([
      page.draftSavedById
        ? prisma.user.findUnique({ where: { id: page.draftSavedById }, select: { id: true, name: true } })
        : Promise.resolve(null),
      // Where a link on this page can go without leaving the site. Sent so a
      // destination is something somebody picks rather than something they
      // spell — `contact` instead of `/contact` is a link to nowhere that looks
      // exactly like a link, and nothing on the page says otherwise until a
      // visitor clicks it.
      prisma.sitePage.findMany({
        where: { siteId: site.id },
        orderBy: { path: "asc" },
        select: { path: true, title: true },
      }),
    ]);

    res.json({
      site: { id: site.id, name: site.name, publicUrl: site.publicUrl, repo: siteRepo(site) },
      links: siblings,
      page: {
        id: page.id,
        title: page.title,
        path: page.path,
        filePath: page.filePath,
        status: page.status,
        url: pageUrl(site, page),
        lastPublishedAt: page.lastPublishedAt,
      },
      readFrom: source.from,
      // Set only for a framework page: what is being shown is a build of the
      // file named here, and how fresh that build is. A person editing needs
      // both — "this is last night's deploy" and "your words go into page.tsx"
      // are the two facts that make the screen make sense.
      builtFrom: source.sourceFile
        ? {
            filePath: source.sourceFile,
            detail: source.detail ?? null,
            writableFields: managed ? managed.writable.size : 0,
            // Said once, at the top, when the answer is "none of it". A page
            // where every field is locked is not three hundred separate facts;
            // it is one fact, and the person needs it before they click.
            problem: managed?.failure ?? (managed && managed.writable.size === 0 ? "Nothing on this page could be traced back to a piece of text in its source files, so none of it can be changed here. Open it under Source files to edit the code itself." : null),
          }
        : null,
      sections: content.sections.map((section) => ({
        id: section.id,
        label: section.label,
        kind: section.kind,
        fields: section.fields.map((field) => ({
          ...publicField(widen(field)),
          structure: managed ? undefined : controls[field.id],
          ...(managed && !managed.writable.has(field.id)
            ? {
                sourceManaged: true as const,
                sourceNote: managed.notes.get(field.id) ?? `This came from the code in ${page.filePath} rather than from a piece of text in it. Change it there, or ask a developer.`,
                // Only where naming it would actually unlock it.
                ...(managed.nameable?.has(field.id) ? { sourceNameable: true as const } : {}),
              }
            : {}),
        })),
      })),
      draft: {
        values: Object.fromEntries(
          Object.entries(fieldValues(values)).map(([id, edit]) => [
            id,
            { value: edit.value, href: edit.href, alt: edit.alt, style: edit.style, responsive: edit.responsive, variant: edit.variant, newTab: edit.newTab },
          ]),
        ),
        // The number the editor has to send back on every save. Handing it out
        // here, and only here, is what makes a save an exchange: a screen that
        // never loaded the page has no revision to quote and cannot write.
        revision: page.draftRevision,
        savedAt: page.draftSavedAt,
        savedBy: saver,
        documentHash: draftDocument(values) ? sourceHash(draftDocument(values)!.html) : null,
      },
      // Which fields belong to a shared element, how many pages a change here
      // would reach, and whether this page's copy is still listening.
      shared: {
        scope: shared.scope,
        elements: shared.elements,
      },
      structure: { changed: documentChanged(source.html, values), canUndo: Boolean(draftDocument(values)?.undo.length), canRedo: Boolean(draftDocument(values)?.redo.length), changes: draftDocument(values)?.changes ?? [], stale: Boolean(draftDocument(values) && draftDocument(values)!.baseHash !== sourceHash(source.html)) },
      problems: validateFieldChange(content.fields, values),
    });
  } catch (err) {
    next(err);
  }
});

const draftBody = z.object({
  /**
   * The revision this editor was last shown. Required in effect, optional here.
   *
   * Omitting it defeats the whole mechanism — the one caller that leaves it out
   * is the one that overwrites — so it is refused either way. It is `optional()`
   * only so that the refusal is this route's own sentence. Marked required, it
   * would be a `ZodError`, and the handler renders those as "Validation failed"
   * with the raw issue list attached: technically a 400, and no use at all to
   * somebody whose actual remedy is to reload the page.
   */
  ifRevision: z.number().int().nonnegative().optional(),
  /**
   * The revision of each shared element this editor was shown, quoted back for
   * the same reason `ifRevision` is: a header edited from two pages at once is
   * one row, and a save that does not say which version it saw is a save that
   * overwrites somebody.
   */
  sharedRevisions: z.record(z.number().int().nonnegative()).optional(),
  documentHash: z.string().length(64).nullable().optional(),
  values: z.record(
    z.object({
      value: z.string().max(20_000).optional(),
      href: z.string().max(2_000).optional(),
      alt: z.string().max(500).optional(),
      style: z.string().max(2_000).optional(),
      responsive: z.object({ tablet: z.string().max(2_000).optional(), mobile: z.string().max(2_000).optional() }).strict().optional(),
      /** A button's style class. `null` takes the style off without adding one. */
      variant: z.string().max(120).nullable().optional(),
      newTab: z.boolean().optional(),
      /** A new icon by library name or image address; null takes it away. Never markup. */
      icon: z.union([z.object({ library: z.string().min(1).max(60) }).strict(), z.object({ src: z.string().min(1).max(2_000) }).strict()]).nullable().optional(),
      iconPosition: z.enum(["start", "end"]).optional(),
    }),
  ),
});

websiteRouter.post("/pages/:pageId/presence", async (req, res, next) => {
  try {
    const { page } = await loadPage(req, req.params.pageId);
    const user = req.dbUser ? { id: req.dbUser.id, name: req.dbUser.name, email: req.dbUser.email } : { id: `anon-${req.ip || "user"}`, name: "Visitor" };
    const editors = recordPresence(page.id, user);
    res.json({ editors });
  } catch (err) {
    next(err);
  }
});

websiteRouter.delete("/pages/:pageId/presence", async (req, res, next) => {
  try {
    const userId = req.dbUser?.id || `anon-${req.ip || "user"}`;
    removePresence(req.params.pageId, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Saves a draft.
 *
 * Two things happen here that are easy to miss and both matter. Every value is
 * sanitised **on the way in**, so nothing that could not be published is ever
 * stored; and each edit is stamped with what the page currently says, which is
 * the only reason a draft can be trusted an hour later.
 *
 * An edit that matches the page exactly is dropped rather than stored. Without
 * that, opening a page and closing it would leave it looking edited for ever.
 */
websiteRouter.put("/pages/:pageId/draft", async (req, res, next) => {
  try {
    const body = draftBody.parse(req.body);
    if (body.ifRevision === undefined) {
      throw new WebsiteError(
        400,
        "This editor is out of date and did not say which version of the page it was showing. Reload the page and make the change again — nothing has been lost.",
      );
    }
    const { page, site } = await loadPage(req, req.params.pageId);
    await assertEditAllowance(req, site.id);
    const source = await pageSource(site, page);
    const existing = draftValues(page);
    const document = draftDocument(existing);
    if ((body.documentHash ?? null) !== (document ? sourceHash(document.html) : null)) throw new WebsiteError(409, "The page layout changed in another session. Reload it before saving these edits; your local changes have been kept.");
    if (Object.hasOwn(body.values, DOCUMENT_KEY)) throw new WebsiteError(400, "Page structure must be changed through the visual structure controls.");
    const content = discoverFields(editingSource(source.html, existing));
    const byId = new Map(content.fields.map((field) => [field.id, field]));

    // A field belonging to a linked shared element is not this page's to store.
    // The editor was shown the shared values merged in and sends them back with
    // everything else; without this split they would be copied into the page's
    // own draft, and the page and the shared element would immediately start to
    // disagree about what the header says.
    const shared = await sharedOnPage(page, editingSource(source.html, existing));
    const own: typeof body.values = {};
    const sharedEdits: typeof body.values = {};
    for (const [id, edit] of Object.entries(body.values)) {
      const owner = shared.scope[id];
      if (owner && owner.state === "LINKED") sharedEdits[id] = edit;
      else own[id] = edit;
    }
    const sharedResult = await saveSharedEdits({
      html: editingSource(source.html, existing),
      pageId: page.id,
      scope: shared.scope,
      values: sharedEdits,
      revisions: body.sharedRevisions ?? {},
      userId: req.dbUser?.id,
      fields: content.fields,
    });

    const values: Record<string, FieldValue> = document ? { [DOCUMENT_KEY]: { document } } : {};
    const unknown: string[] = [];

    for (const [id, edit] of Object.entries(own)) {
      const field = byId.get(id);
      if (!field) {
        unknown.push(id);
        continue;
      }

      // Cleaned on the way *in* as well as on the way out, and stamped with what
      // the page currently says. The draft outlives the session that wrote it,
      // so what is stored has to be safe, and datable, on its own.
      const next = sanitizeValue(field, edit);
      if (Object.keys(next).length === 0) continue;
      values[id] = next;
    }

    const empty = Object.keys(values).length === 0;

    // The whole save is one conditional statement. Reading the revision and then
    // writing would be two, and between them is exactly the window this exists to
    // close — two people pressing save in the same second both read 8, both
    // consider themselves current, and the second one wins silently.
    const written = await prisma.sitePage.updateMany({
      where: { id: page.id, draftRevision: body.ifRevision },
      data: {
        // A nullable Json column clears with `Prisma.DbNull`; a plain `null`
        // would be the JSON value `null`, which is not the same as no draft.
        draft: empty ? Prisma.DbNull : (values as unknown as Prisma.InputJsonValue),
        draftSavedAt: empty ? null : new Date(),
        draftSavedById: empty ? null : req.dbUser?.id ?? null,
        draftRevision: { increment: 1 },
      },
    });

    if (written.count === 0) {
      // Somebody else saved between this editor loading the page and pressing
      // save. Their draft is returned in full beside this one so the comparison
      // can be made on screen — refusing the write and saying only "conflict"
      // would leave the person with no way to keep their own words except by
      // remembering them.
      const current = await prisma.sitePage.findUnique({
        where: { id: page.id },
        include: { draftSavedBy: { select: { id: true, name: true } } },
      });
      if (!current) throw new WebsiteError(404, "That page has been removed from the editor.");

      const theirs = (current.draft as Record<string, FieldValue> | null) ?? {};
      const ids = [...new Set([...Object.keys(fieldValues(values)), ...Object.keys(fieldValues(theirs))])];

      return res.status(409).json({
        error:
          current.draftSavedBy?.name
            ? `${current.draftSavedBy.name} saved changes to this page while you were editing it. Nothing has been overwritten — choose which version to keep.`
            : "Somebody saved changes to this page while you were editing it. Nothing has been overwritten — choose which version to keep.",
        revision: current.draftRevision,
        savedAt: current.draftSavedAt,
        savedBy: current.draftSavedBy,
        // One row per field either side touched, so the screen can render a
        // three-column comparison without asking a second question.
        fields: ids.map((id) => {
          const field = byId.get(id);
          const mine = values[id];
          const other = theirs[id];
          return {
            id,
            label: field?.label ?? "A field that has since moved",
            kind: field?.kind ?? "text",
            yours: mine ? { value: mine.value, href: mine.href, alt: mine.alt, style: mine.style, responsive: mine.responsive, variant: mine.variant, newTab: mine.newTab } : null,
            theirs: other ? { value: other.value, href: other.href, alt: other.alt, style: other.style, responsive: other.responsive, variant: other.variant, newTab: other.newTab } : null,
            /** True where both changed the same field and disagreed — the only rows that need a decision. */
            contested: Boolean(mine && other) && JSON.stringify({ ...mine, original: undefined }) !== JSON.stringify({ ...other, original: undefined }),
          };
        }),
      });
    }

    const saved = await prisma.sitePage.findUnique({ where: { id: page.id }, select: { draftSavedAt: true, draftRevision: true } });

    const renderedDraftHtml = applyValues(editingSource(source.html, values), fieldValues(values)).html;
    await syncDemoFromSitePage(site, page.id, renderedDraftHtml, false);
    await recordEditUsed(req);

    res.json({
      savedAt: saved?.draftSavedAt ?? null,
      revision: body.ifRevision + 1,
      changed: Object.keys(values).length + sharedResult.applied,
      /** The new revision of each shared element this save touched. */
      sharedRevisions: sharedResult.revisions,
      unknown,
      problems: validateFieldChange(content.fields, values),
    });
  } catch (err) {
    next(err);
  }
});

websiteRouter.delete("/pages/:pageId/draft", async (req, res, next) => {
  try {
    const { page, site } = await loadPage(req, req.params.pageId);
    const expected = req.query.ifRevision === undefined ? page.draftRevision : z.coerce.number().int().nonnegative().parse(req.query.ifRevision);
    const removed = await prisma.sitePage.updateMany({
      where: { id: page.id, draftRevision: expected },
      // The revision still moves. Discarding somebody's draft is a change to the
      // draft like any other, and a second editor holding the old number has to
      // be told rather than allowed to save over the discard.
      data: { draft: Prisma.DbNull, draftSavedAt: null, draftSavedById: null, draftRevision: { increment: 1 } },
    });
    if (!removed.count) throw new WebsiteError(409, "The draft changed before it could be discarded. Reopen it before discarding.");
    const source = await pageSource(site, page);
    await syncDemoFromSitePage(site, page.id, source.html, false);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

websiteRouter.post("/pages/:pageId/structure", async (req, res, next) => {
  try {
    const body = z.object({ ifRevision: z.number().int().nonnegative(), kind: z.enum(["remove", "duplicate", "before", "after", "undo", "redo"]), fieldId: z.string().min(1).max(200).optional(), targetId: z.string().min(1).max(200).optional() }).strict().parse(req.body);
    if (!["undo", "redo"].includes(body.kind) && !body.fieldId) throw new WebsiteError(400, "Select an element first.");
    const { page, site } = await loadPage(req, req.params.pageId);
    await assertEditAllowance(req, site.id);
    if (body.ifRevision !== page.draftRevision) throw new WebsiteError(409, "The draft changed in another session. Reload the page before changing its layout.");
    const source = await pageSource(site, page, { fresh: true });
    const values = draftValues(page);
    const problems = validateFieldChange(discoverFields(editingSource(source.html, values)).fields, values);
    if (problems.length) throw Object.assign(new WebsiteError(422, "Resolve the draft's validation problems before changing its layout."), { problems });
    const result = changeStructure(source.html, values, body.kind === "undo" || body.kind === "redo" ? { kind: body.kind } : { kind: body.kind, fieldId: body.fieldId!, targetId: body.targetId });
    await prisma.$transaction(async tx => {
      const changed = await tx.sitePage.updateMany({ where: { id: page.id, draftRevision: body.ifRevision }, data: { draft: result.values as unknown as Prisma.InputJsonValue, draftRevision: { increment: 1 }, draftSavedAt: new Date(), draftSavedById: req.dbUser?.id ?? null } });
      if (!changed.count) throw new WebsiteError(409, "Another editor saved first. Nothing was moved or removed. Reload the page and try again.");
      await tx.siteAuditEvent.create({ data: { siteId: site.id, kind: "LAYOUT_EDIT", summary: `${body.kind} · ${page.title}`, actorName: req.dbUser?.name ?? "Website editor", actorId: req.dbUser?.id, detail: { pageId: page.id, fieldId: body.fieldId, targetId: body.targetId, revision: body.ifRevision + 1 } } });
    });
    const renderedStructureHtml = applyValues(editingSource(source.html, result.values), fieldValues(result.values)).html;
    await syncDemoFromSitePage(site, page.id, renderedStructureHtml, false);
    await recordEditUsed(req);
    res.json({ revision: body.ifRevision + 1, selectedId: result.selectedId });
  } catch (error) { next(error); }
});

/**
 * Name the fields on this page whose words are shared.
 *
 * The button behind the sentence an element shows when it is locked for that
 * reason. It writes one attribute per element into the page's source files, in
 * one commit, and takes back out any attribute an earlier run of this left
 * behind that the build ignored. Nothing else in the files is touched, and a
 * file that would not come back saying the same words is left alone.
 *
 * It is a commit to the customer's repository, so it is behind the same
 * `source` permission a publish is, and it is recorded in the audit log under
 * the person who pressed it.
 */
websiteRouter.post("/pages/:pageId/name-fields", async (req, res, next) => {
  try {
    const { page, site } = await loadPage(req, req.params.pageId);
    await assertWebsiteSiteAccess(req, site.id, "source");
    if (!hasSourceManifest(page.filePath)) throw new WebsiteError(400, "This page is not built from source files the editor can name fields in.");
    const source = await pageSource(site, page, { fresh: true });
    if (!source.sourceFile) throw new WebsiteError(400, "This page is an HTML file, so every part of it is already editable.");
    const author = req.dbUser?.name ?? "the website editor";
    const result = await nameFieldsOnPage({ site, page, html: source.html, author });
    if (!result.files.length) {
      res.json({ named: 0, removed: 0, files: [], refused: result.refused, message: result.refused.length ? "Nothing on this page could be named. " + result.refused.join(" ") : "Nothing on this page needed naming." });
      return;
    }
    await prisma.siteAuditEvent.create({ data: { siteId: site.id, kind: "SOURCE_EDIT", summary: `Named ${result.named} field${result.named === 1 ? "" : "s"} · ${page.title}`, actorName: author, actorId: req.dbUser?.id, detail: { pageId: page.id, files: result.files, named: result.named, removed: result.removed, sha: result.sha } } });
    res.json({
      ...result,
      // The build has to run before these names are on the page, and until it
      // does the fields are exactly as locked as they were. Said here rather
      // than discovered by somebody clicking the element again.
      message: `Named ${result.named} field${result.named === 1 ? "" : "s"} in ${result.files.join(", ")}. They become editable once the site rebuilds.`,
    });
  } catch (error) { next(error); }
});

/**
 * The page as it would look if it were published now.
 *
 * Served as HTML rather than JSON because it goes straight into an iframe, and
 * behind the same session as everything else here — a draft is not public, and
 * this is the route that would make it so if it were left open.
 */
websiteRouter.get("/pages/:pageId/preview", async (req, res, next) => {
  try {
    const { page, site } = await loadPage(req, req.params.pageId);
    const source = await pageSource(site, page);
    const own = draftValues(page);
    // The preview is where somebody checks a shared change on the pages they did
    // not type it on, so the shared draft belongs here as much as in the panel.
    const shared = await sharedOnPage(page, editingSource(source.html, own));
    const values = { ...own, ...shared.values };
    const applied = applyValues(editingSource(source.html, values), fieldValues(values));
    // `?pick=1` is the visual editor asking for a preview it can click on. The
    // plain preview stays exactly as it was — it is what "Preview" means, and a
    // page covered in selection outlines is not a preview of anything.
    const picking = req.query.pick === "1";
    const capabilities = await getWebsiteCapabilities(req, site.id);
    // Every element can be selected. Source-managed content remains read-only
    // in the preview and inspector, with an explanation of its source.
    const pickable = picking ? discoverFields(applied.html).fields : undefined;
    const writable = picking && source.sourceFile ? await sourceManagedFields(site, page, source.html) : null;
    const builtCss = await tailwindCdnCss(applied.html);
    const document = buildPreview(applied.html, pageUrl(site, page), writable ? pickable!.map((field) => ({ ...field, previewReadOnly: !writable.writable.has(field.id) })) : pickable, capabilities.capabilities.edit, builtCss);
    res
      .type("html")
      .set("Cache-Control", "no-store")
      // Replaces the app's own policy for this one response. See
      // `previewDocument` for why it has to be the header rather than the tag.
      .set("Content-Security-Policy", document.csp)
      // The preview carries client-written copy; nothing here should be framed
      // by anyone but the editor itself.
      .set("X-Frame-Options", "SAMEORIGIN")
      .send(await embedWebsiteAssets(site, document.html));
  } catch (err) {
    next(err);
  }
});

/**
 * Puts the draft on the public site.
 *
 * The order is deliberate. Validate, then apply, then commit, and only once the
 * commit has come back does anything here change — so a publish that fails
 * leaves both the draft and the live page exactly as they were. The version row
 * is written afterwards for the same reason: it records what *did* happen.
 */

websiteRouter.post("/pages/:pageId/publish", async (req, res, next) => {
  try {
    if (capacity.admission) {
      const { site, page } = await loadPage(req, req.params.pageId);
      if (req.body?.ifRevision !== undefined && req.body.ifRevision !== page.draftRevision) throw new WebsiteError(409, "The draft changed after your review. Review it again before publishing.");
      res.status(202).json(await enqueueWebsiteWork(req, site.id, "PUBLISH_PAGE", { pageId: page.id, body: { ...req.body, ifRevision: page.draftRevision } }));
      return;
    }
    res.json(await executePagePublish(req));
  } catch (error) { next(error); }
});

websiteRouter.get("/pages/:pageId/versions", async (req, res, next) => {
  try {
    const { page, site } = await loadPage(req, req.params.pageId);
    const versions = await prisma.sitePageVersion.findMany({
      where: { pageId: page.id },
      orderBy: { number: "desc" },
      take: 40,
      select: {
        id: true,
        number: true,
        commitSha: true,
        commitUrl: true,
        createdAt: true,
        values: true,
        publishedBy: { select: { id: true, name: true } },
      },
    });
    // Labels come from the page as it is now, and a version that named a field
    // the page no longer has still renders — `describeChanges` falls back rather
    // than dropping the line. A history that goes blank because somebody
    // restructured a page is not a history.
    let fields: SiteField[] = [];
    try {
      const source = await pageSource(site, page);
      fields = discoverFields(source.html).fields;
    } catch {
      // The page being unreadable right now — a renamed file, GitHub down — must
      // not take the record of what was published with it. Ids stand in for
      // labels until it can be read again.
    }

    res.json(
      versions.map((version) => {
        const values = (version.values as Record<string, FieldValue> | null) ?? {};
        const summary = describeChanges(fields, values);
        const changedLabels = summary.map(s => `${s.label} (${s.part})`).slice(0, 6);
        const dateStr = new Date(version.createdAt).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        return {
          ...version,
          changed: Object.keys(values).length,
          summary,
          changedLabels,
          formattedDate: dateStr,
          authorName: version.publishedBy?.name || "Dan",
          affectedPagesCount: 1,
          touched: categoriseChanges(summary),
          rawValues: fieldValues(values),
          values: undefined,
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

websiteRouter.post("/pages/:pageId/versions/:versionId/cherry-pick", async (req, res, next) => {
  try {
    const { page, site } = await loadPage(req, req.params.pageId);
    await assertWebsiteSiteAccess(req, site.id, "edit");
    const body = z.object({ fieldId: z.string() }).parse(req.body);

    const version = await prisma.sitePageVersion.findFirst({
      where: { id: req.params.versionId, pageId: page.id },
    });
    if (!version) return res.status(404).json({ error: "Version not found" });

    const versionVals = (version.values as Record<string, FieldValue> | null) ?? {};
    const fieldVal = versionVals[body.fieldId];
    if (!fieldVal) return res.status(404).json({ error: "Field not found in selected version" });

    const currentDraft = ((page.draft as Record<string, FieldValue> | null) ?? {});
    const updatedDraft = {
      ...currentDraft,
      [body.fieldId]: fieldVal,
    };

    const updated = await prisma.sitePage.update({
      where: { id: page.id },
      data: {
        draft: updatedDraft as any,
        draftSavedAt: new Date(),
        draftRevision: { increment: 1 },
      },
    });

    res.json({ ok: true, draftRevision: updated.draftRevision, copiedField: body.fieldId });
  } catch (err) {
    next(err);
  }
});

/**
 * Puts an old version back — as a draft, never straight onto the site.
 *
 * The plan asks for restore-to-draft rather than restore-to-live, and the reason
 * is worth keeping: the page may have moved on in ways that have nothing to do
 * with the edit being undone, and a restore that published itself would take
 * those with it. This gives the person their old words back and leaves the
 * decision to publish where it was.
 */
websiteRouter.post("/pages/:pageId/versions/:versionId/restore", async (req, res, next) => {
  try {
    const version = await prisma.sitePageVersion.findFirst({
      where: { id: req.params.versionId, pageId: req.params.pageId },
    });
    if (!version) throw new WebsiteError(404, "That version is not on this page.");

    const { page, site } = await loadPage(req, req.params.pageId);
    const source = await pageSource(site, page);
    const currentValues = draftValues(page);
    const { values, dropped } = versionDraft(source.html, currentValues, version.html, Boolean(source.sourceFile), `Restored complete page from version ${version.number}`);

    const empty = Object.keys(values).length === 0;
    const expected = req.body?.ifRevision === undefined ? page.draftRevision : z.number().int().nonnegative().parse(req.body.ifRevision);
    const restored = await prisma.sitePage.updateMany({
      where: { id: page.id, draftRevision: expected },
      data: {
        // A nullable Json column clears with `Prisma.DbNull`; a plain `null`
        // would be the JSON value `null`, which is not the same as no draft.
        draft: empty ? Prisma.DbNull : (values as unknown as Prisma.InputJsonValue),
        draftSavedAt: empty ? null : new Date(),
        draftSavedById: empty ? null : req.dbUser?.id ?? null,
        draftRevision: { increment: 1 },
      },
    });
    if (!restored.count) throw new WebsiteError(409, "The draft changed while that version was being restored. Reopen the page before restoring.");
    res.json({ restored: Object.keys(values).length, dropped, empty });
  } catch (err) {
    next(err);
  }
});

/**
 * What putting an old version back would actually do.
 *
 * Asked before the button is offered, never after it is pressed. A rollback
 * writes a **whole stored file** over whatever is in the repository now, which
 * is exactly what makes it the right tool after a bad publish and exactly what
 * makes it dangerous: any developer work committed since is inside "whatever is
 * in the repository now". That is a decision somebody has to take deliberately,
 * so this route exists to let them take it with the facts in front of them.
 */
websiteRouter.get("/pages/:pageId/versions/:versionId/diff", async (req, res, next) => {
  try {
    const { page, site } = await loadPage(req, req.params.pageId);
    const version = await prisma.sitePageVersion.findFirst({
      where: { id: req.params.versionId, pageId: page.id },
      include: { publishedBy: { select: { id: true, name: true } } },
    });
    // Matched on both ids together rather than fetched and then compared: a
    // version id from another page is a caller-supplied value like any other.
    if (!version) throw new WebsiteError(404, "That version is not on this page.");

    const source = await pageSource(site, page, { fresh: true });
    const identical = source.html === version.html;

    const current = discoverFields(source.html);
    const restored = discoverFields(version.html);
    const currentById = new Map(current.fields.map((field) => [field.id, field]));

    // Field by field, because a line diff of minified-ish HTML tells nobody
    // anything.
    //
    // **Compared on what a person can see, not on the bytes.** The first version
    // of this compared `value`, which is inner HTML, and then printed `preview`,
    // which is plain text — so a file differing only in whitespace or in how an
    // entity was written produced a confirmation screen listing three changes
    // whose before and after read identically. A dialog asking somebody to
    // approve an overwrite is the last place to show them a difference they
    // cannot see: it teaches them the screen is wrong, on the one screen that has
    // to be believed.
    //
    // The invisible differences are real and are counted, because they are why
    // the file is not identical — they are just not a list anybody can read.
    const differences: Array<{ id: string; label: string; now: string; after: string }> = [];
    let invisible = 0;
    for (const field of restored.fields) {
      const now = currentById.get(field.id);
      if (!now) {
        differences.push({ id: field.id, label: field.label, now: "(not on the page any more)", after: field.preview });
        continue;
      }
      const parts: Array<[string, string, string]> = [
        ["", now.preview, field.preview],
        ["link", now.href ?? "", field.href ?? ""],
        ["description", now.alt ?? "", field.alt ?? ""],
        ["base styling", now.style ?? "", field.style ?? ""],
        ["tablet styling", now.responsive?.tablet ?? "", field.responsive?.tablet ?? ""],
        ["phone styling", now.responsive?.mobile ?? "", field.responsive?.mobile ?? ""],
        ["button style", now.variant ?? "", field.variant ?? ""],
        ["opens in", now.newTab ? "a new tab" : "the same tab", field.newTab ? "a new tab" : "the same tab"],
      ];
      for (const [part, before, after] of parts) {
        if (readsSame(before, after)) continue;
        differences.push({ id: field.id, label: `${field.label}${part ? ` (${part})` : ""}`, now: before || "(not set)", after: after || "(not set)" });
      }
      if (now.value !== field.value && readsSame(now.preview, field.preview)) invisible += 1;
    }
    const restoredIds = new Set(restored.fields.map(field => field.id));
    for (const field of current.fields) {
      if (!restoredIds.has(field.id)) differences.push({ id: field.id, label: field.label, now: field.preview || field.label, after: "(not in this version)" });
    }

    const summary = describeChanges(current.fields, (version.values as Record<string, FieldValue> | null) ?? {});

    res.json({
      version: { id: version.id, number: version.number, createdAt: version.createdAt, publishedBy: version.publishedBy, commitUrl: version.commitUrl },
      identical,
      // The count is stated separately from the list because the list is what a
      // person reads and the count is what makes them read it.
      differenceCount: differences.length,
      differences: differences.slice(0, 60),
      /**
       * Fields whose markup differs but which read exactly the same.
       *
       * Almost always the gap between the file in the repository and what the
       * live site serves — a build step, an entity written differently. Worth a
       * sentence so that "the file is not identical" and "nothing you can see
       * would change" can both be true on screen without contradicting.
       */
      invisibleCount: invisible,
      summary,
      readFrom: source.from,
      sourceHash: createHash("sha256").update(source.html).digest("hex"),
      // Said in the response rather than only in the UI, so that anything else
      // calling this route — an agent, a script — is told as plainly as a person.
      warning:
        "Publishing this version writes the whole stored file over the page as it stands now. Anything changed in the repository since this version was published will be undone.",
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Puts an old version back on the public site, in one action.
 *
 * The existing restore-to-draft route is still the default and is still the
 * right answer nearly every time: a page may have moved on for reasons that have
 * nothing to do with the edit being undone, and a restore that published itself
 * would take those with it. This is the other case — a publish that broke
 * something, where the whole point is to be back where you were now, not after a
 * review.
 *
 * `SitePageVersion` stores the complete file rather than a diff for precisely
 * this: putting a page back must not depend on the repository's history, the
 * parser, or the field ids still meaning what they meant. It needs nothing to
 * still be true.
 *
 * History is never rewritten. The rollback is published as a **new** version, so
 * the record reads "we published X, then we published Y, then we put X back" —
 * which is what happened.
 */

websiteRouter.post("/pages/:pageId/versions/:versionId/publish", async (req, res, next) => {
  try {
    if (capacity.admission) {
      const { site, page } = await loadPage(req, req.params.pageId);
      res.status(202).json(await enqueueWebsiteWork(req, site.id, "PUBLISH_VERSION", {
        pageId: page.id, versionId: req.params.versionId, body: { ...req.body, ifRevision: req.body?.ifRevision ?? page.draftRevision },
      }));
      return;
    }
    res.json(await executeVersionPublish(req));
  } catch (error) { next(error); }
});

/**
 * The builder's front page: what exists, what is waiting, what just happened.
 *
 * Everything here is counted in the database. Nothing reads a repository, and
 * that is a deliberate limit rather than an oversight — a field count would mean
 * fetching and parsing every page of every site on every render, which is a
 * minute of GitHub calls to put a number on a card. The counts that matter to
 * somebody arriving at this screen are how many sites they have, how much is
 * unpublished, and whether anything went out recently.
 */
websiteRouter.get("/overview", async (req, res, next) => {
  try {
    const siteFilter = websiteSiteFilter(req);

    const [sites, pages, drafts, hidden, versions] = await Promise.all([
      prisma.site.count({ where: siteFilter }),
      prisma.sitePage.count({ where: { site: siteFilter } }),
      prisma.sitePage.count({ where: { site: siteFilter, NOT: { draft: { equals: Prisma.DbNull } } } }),
      prisma.sitePage.count({ where: { site: siteFilter, status: "HIDDEN" } }),
      prisma.sitePageVersion.findMany({
        where: { page: { site: siteFilter } },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          number: true,
          createdAt: true,
          commitUrl: true,
          values: true,
          publishedBy: { select: { id: true, name: true } },
          page: { select: { id: true, title: true, path: true, site: { select: { id: true, name: true } } } },
        },
      }),
    ]);

    // A site with no repository cannot publish, and somebody looking at this
    // screen should learn that here rather than at the moment they press the
    // button. Counted rather than listed: the list is one click away.
    const unconnected = await prisma.site.count({ where: { AND: [siteFilter, { OR: [{ repoOwner: null }, { repoName: null }] }] } });

    res.json({
      counts: { sites, pages, drafts, hidden, unconnected },
      recent: versions.map((version) => ({
        id: version.id,
        number: version.number,
        createdAt: version.createdAt,
        commitUrl: version.commitUrl,
        publishedBy: version.publishedBy,
        page: { id: version.page.id, title: version.page.title, path: version.page.path },
        site: version.page.site,
        // The labels would need the page's HTML, so the count is what is honest
        // here. The version list on the page itself has the words.
        changed: version.values ? Object.keys(version.values as Record<string, unknown>).length : 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});
