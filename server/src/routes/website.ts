import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import type { Site, SitePage } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { gateBy } from "../middleware/permissionGate.js";
// The engine comes through its one door — see services/website/index.ts for why.
// `site.js` is the other half and stays separate on purpose: it is the part that
// talks to GitHub and the network, and nothing in the core does.
import {
  applyValues,
  categoriseChanges,
  describeChanges,
  buildPreview,
  buildPublishPlan,
  discoverFields,
  isVariantOfStem,
  sanitizeValue,
  validateFieldChange,
  type FieldValue,
  type SiteField,
} from "../services/website/index.js";
import { discoverPages, pageSource, pageUrl, publishPage, siteRepo, siteStyleClasses, WebsiteError } from "../services/website/site.js";

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

websiteRouter.use(
  gateBy({
    view: "website.view",
    create: "website.edit",
    // PATCH is only ever site or page configuration — what a page is called,
    // whether it is editable at all, which repository it publishes to.
    edit: "website.manage",
    remove: "website.edit",
    routes: [
      { method: "POST", path: /\/scan$/, permission: "website.manage" },
      { method: "POST", path: /\/publish$/, permission: "website.publish" },
      { method: "PUT", path: /\/draft$/, permission: "website.edit" },
    ],
  }),
);

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
    // Buttons. `variantStem` travels because the editor labels a style by the
    // word after it — `btn-primary` reads as "Primary" — and `variantsOnPage`
    // is the menu: every style this page already wears somewhere, so picking
    // one can never produce a button the stylesheet has no rule for.
    ...(field.variant !== undefined ? { variant: field.variant } : {}),
    ...(field.variantStem !== undefined ? { variantStem: field.variantStem } : {}),
    ...(field.variantsOnPage !== undefined ? { variants: field.variantsOnPage } : {}),
    ...(field.newTab !== undefined ? { newTab: field.newTab } : {}),
  };
}

function draftValues(page: SitePage): Record<string, FieldValue> {
  return (page.draft as Record<string, FieldValue> | null) ?? {};
}

/**
 * May this caller act on this site at all?
 *
 * Every route here resolves a page or a site and then acts on it, and until now
 * **not one of them checked that the caller had anything to do with that site.**
 * The permission gate above answers "may this person edit websites"; it does not
 * and cannot answer "may this person edit *this* website", because it never sees
 * which one. With a single site in the database those are the same question. The
 * moment a second site exists — which is the entire point of selling this — they
 * are not, and the failure mode is a customer opening another customer's pages by
 * changing an id in a URL.
 *
 * So it is one function, called by everything, before anything. Today it enforces
 * the rule that can be enforced now; membership and client scoping land on this
 * line rather than on twelve handlers that each have to remember.
 */
function assertSiteAccess(req: Request, site: Site): void {
  // A site belonging to a client is still only reachable by staff at this point.
  // The external-account door is shut in `scopeExternal`, and opening it is a
  // deliberate, separate piece of work — not something that should fall out of
  // adding a column.
  if (req.dbUser?.accessRole?.external) {
    throw new WebsiteError(403, "This account cannot open sites in the internal editor.");
  }
  void site;
}

async function loadSite(req: Request, siteId: string): Promise<Site> {
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) throw new WebsiteError(404, "That site is not in the editor.");
  assertSiteAccess(req, site);
  return site;
}

/**
 * A page and the site it belongs to, with the caller checked against the site.
 *
 * Loading the parent is not an extra query for the sake of it: authorising on a
 * page id alone is authorising on a value the caller supplied, and the record
 * that says who may touch it is one level up.
 */
async function loadPage(req: Request, pageId: string): Promise<{ page: SitePage; site: Site }> {
  const page = await prisma.sitePage.findUnique({ where: { id: pageId }, include: { site: true } });
  if (!page) throw new WebsiteError(404, "That page is not in the editor. It may have been removed — rescan the site.");
  const { site, ...rest } = page;
  assertSiteAccess(req, site);
  return { page: rest as SitePage, site };
}

websiteRouter.get("/sites", async (_req, res, next) => {
  try {
    const sites = await prisma.site.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { pages: true } }, client: { select: { id: true, name: true } } },
    });
    const withDrafts = await prisma.sitePage.findMany({
      where: { NOT: { draft: { equals: Prisma.DbNull } } },
      select: { siteId: true },
    });
    const drafts = new Map<string, number>();
    for (const row of withDrafts) drafts.set(row.siteId, (drafts.get(row.siteId) ?? 0) + 1);

    res.json(
      sites.map((site) => ({
        id: site.id,
        name: site.name,
        slug: site.slug,
        publicUrl: site.publicUrl,
        repo: siteRepo(site),
        branch: site.repoBranch,
        client: site.client,
        pageCount: site._count.pages,
        draftCount: drafts.get(site.id) ?? 0,
      })),
    );
  } catch (err) {
    next(err);
  }
});

websiteRouter.get("/sites/:siteId/pages", async (req, res, next) => {
  try {
    const site = await loadSite(req, req.params.siteId);
    const pages = await prisma.sitePage.findMany({
      where: { siteId: site.id },
      orderBy: [{ sortOrder: "asc" }, { path: "asc" }],
      include: { draftSavedBy: { select: { id: true, name: true } } },
    });

    res.json({
      site: { id: site.id, name: site.name, publicUrl: site.publicUrl, repo: siteRepo(site), branch: site.repoBranch },
      pages: pages.map((page) => ({
        id: page.id,
        title: page.title,
        path: page.path,
        filePath: page.filePath,
        status: page.status,
        url: pageUrl(site, page),
        hasDraft: page.draft !== null,
        draftSavedAt: page.draftSavedAt,
        draftSavedBy: page.draftSavedBy,
        lastPublishedAt: page.lastPublishedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
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

    const found = await discoverPages(site);
    const existing = await prisma.sitePage.findMany({ where: { siteId: site.id } });
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
    res.json({ found: found.length, added, missing });
  } catch (err) {
    next(err);
  }
});

/** Where a site lives: its public address, and the repository a publish commits to. */
websiteRouter.patch("/sites/:siteId", async (req, res, next) => {
  try {
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        publicUrl: z.string().url().optional(),
        repoOwner: z.string().max(100).nullable().optional(),
        repoName: z.string().max(100).nullable().optional(),
        repoBranch: z.string().min(1).max(100).optional(),
        repoPath: z.string().max(200).optional(),
      })
      .parse(req.body);
    await loadSite(req, req.params.siteId);
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
    const content = discoverFields(source.html);
    const values = draftValues(page);

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
      sections: content.sections.map((section) => ({
        id: section.id,
        label: section.label,
        kind: section.kind,
        fields: section.fields.map((field) => publicField(widen(field))),
      })),
      draft: {
        values: Object.fromEntries(
          Object.entries(values).map(([id, edit]) => [
            id,
            { value: edit.value, href: edit.href, alt: edit.alt, style: edit.style, variant: edit.variant, newTab: edit.newTab },
          ]),
        ),
        // The number the editor has to send back on every save. Handing it out
        // here, and only here, is what makes a save an exchange: a screen that
        // never loaded the page has no revision to quote and cannot write.
        revision: page.draftRevision,
        savedAt: page.draftSavedAt,
        savedBy: saver,
      },
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
  values: z.record(
    z.object({
      value: z.string().max(20_000).optional(),
      href: z.string().max(2_000).optional(),
      alt: z.string().max(500).optional(),
      style: z.string().max(2_000).optional(),
      /** A button's style class. `null` takes the style off without adding one. */
      variant: z.string().max(120).nullable().optional(),
      newTab: z.boolean().optional(),
    }),
  ),
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
    const source = await pageSource(site, page);
    const content = discoverFields(source.html);
    const byId = new Map(content.fields.map((field) => [field.id, field]));

    const values: Record<string, FieldValue> = {};
    const unknown: string[] = [];

    for (const [id, edit] of Object.entries(body.values)) {
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
      const ids = [...new Set([...Object.keys(values), ...Object.keys(theirs)])];

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
            yours: mine ? { value: mine.value, href: mine.href, alt: mine.alt, style: mine.style } : null,
            theirs: other ? { value: other.value, href: other.href, alt: other.alt, style: other.style } : null,
            /** True where both changed the same field and disagreed — the only rows that need a decision. */
            contested: Boolean(mine && other) && JSON.stringify({ ...mine, original: undefined }) !== JSON.stringify({ ...other, original: undefined }),
          };
        }),
      });
    }

    const saved = await prisma.sitePage.findUnique({ where: { id: page.id }, select: { draftSavedAt: true, draftRevision: true } });

    res.json({
      savedAt: saved?.draftSavedAt ?? null,
      revision: saved?.draftRevision ?? page.draftRevision + 1,
      changed: Object.keys(values).length,
      unknown,
      problems: validateFieldChange(content.fields, values),
    });
  } catch (err) {
    next(err);
  }
});

websiteRouter.delete("/pages/:pageId/draft", async (req, res, next) => {
  try {
    const { page } = await loadPage(req, req.params.pageId);
    await prisma.sitePage.update({
      where: { id: page.id },
      // The revision still moves. Discarding somebody's draft is a change to the
      // draft like any other, and a second editor holding the old number has to
      // be told rather than allowed to save over the discard.
      data: { draft: Prisma.DbNull, draftSavedAt: null, draftSavedById: null, draftRevision: { increment: 1 } },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
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
    const applied = applyValues(source.html, draftValues(page));
    // `?pick=1` is the visual editor asking for a preview it can click on. The
    // plain preview stays exactly as it was — it is what "Preview" means, and a
    // page covered in selection outlines is not a preview of anything.
    const picking = req.query.pick === "1";
    const document = buildPreview(applied.html, site.publicUrl, picking ? discoverFields(applied.html).fields : undefined);
    res
      .type("html")
      .set("Cache-Control", "no-store")
      // Replaces the app's own policy for this one response. See
      // `previewDocument` for why it has to be the header rather than the tag.
      .set("Content-Security-Policy", document.csp)
      // The preview carries client-written copy; nothing here should be framed
      // by anyone but the editor itself.
      .set("X-Frame-Options", "SAMEORIGIN")
      .send(document.html);
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
    const { page, site } = await loadPage(req, req.params.pageId);
    const values = draftValues(page);
    if (Object.keys(values).length === 0) throw new WebsiteError(400, "There is nothing to publish — this page has no unsaved changes.");

    // `fresh` is not an optimisation switch here. The whole purpose of the next
    // few lines is to decide whether the page has moved under this draft, and a
    // copy taken ninety seconds ago cannot answer that. See sourceCache.ts.
    const source = await pageSource(site, page, { fresh: true });
    // Every refusal is decided before anything acts, and each one is reported as
    // itself — "some fields need attention" and "the page moved under you" send
    // somebody to two different places.
    const plan = buildPublishPlan({ source: source.html, values });

    if (plan.problems.length) {
      return res.status(400).json({ error: "This page cannot be published yet — some fields need attention.", problems: plan.problems });
    }
    if (plan.conflicts.length || plan.missing.length) {
      return res.status(409).json({
        error: "The page has changed since these edits were made, so they have not been published. Reopen the page to see it as it is now.",
        conflicts: plan.conflicts,
        missing: plan.missing,
      });
    }
    if (!plan.html) throw new WebsiteError(400, "The page already says all of this. Nothing to publish.");

    // Read once for the labels the summary is written in. The plan has already
    // parsed the page; this is the same parse and is kept separate rather than
    // threaded out of the plan, because a publish summary that silently depended
    // on the plan's internals is how the two come to disagree.
    const content = discoverFields(source.html);
    const author = req.dbUser?.name ?? "the website editor";
    const commit = await publishPage({
      site,
      page,
      html: plan.html,
      message: `Website: ${plan.changed.length} change${plan.changed.length === 1 ? "" : "s"} on ${page.path} (${author})`,
    });

    const last = await prisma.sitePageVersion.findFirst({ where: { pageId: page.id }, orderBy: { number: "desc" }, select: { number: true } });
    const version = await prisma.sitePageVersion.create({
      data: {
        pageId: page.id,
        number: (last?.number ?? 0) + 1,
        html: plan.html,
        values: values as unknown as Prisma.InputJsonValue,
        commitSha: commit.sha,
        commitUrl: commit.url,
        publishedById: req.dbUser?.id ?? null,
      },
    });
    await prisma.sitePage.update({
      where: { id: page.id },
      data: {
        draft: Prisma.DbNull,
        draftSavedAt: null,
        draftSavedById: null,
        lastPublishedAt: new Date(),
        // A publish is a change to the draft — it removes it. A second editor
        // still holding the pre-publish number must be told that, or their next
        // save silently re-creates a draft of edits that are already live.
        draftRevision: { increment: 1 },
      },
    });

    const summary = describeChanges(content.fields, values);

    res.json({
      version: version.number,
      changed: plan.changed.length,
      summary,
      touched: categoriseChanges(summary),
      commit: { sha: commit.sha, url: commit.url },
      url: pageUrl(site, page),
      // Said plainly because the alternative is somebody refreshing the live page
      // for a minute and concluding the publish failed.
      note: "GitHub Pages rebuilds the site after a commit. The change is usually live within a minute or two.",
    });
  } catch (err) {
    next(err);
  }
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
        return {
          ...version,
          changed: Object.keys(values).length,
          summary,
          touched: categoriseChanges(summary),
          values: undefined,
        };
      }),
    );
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
    const content = discoverFields(source.html);
    const byId = new Map(content.fields.map((field) => [field.id, field]));

    // Restated against the page as it is now, not as it was. A value whose field
    // no longer exists is dropped and named, rather than being restored into a
    // draft that can never publish.
    const stored = (version.values as Record<string, FieldValue> | null) ?? {};
    const values: Record<string, FieldValue> = {};
    const dropped: string[] = [];
    for (const [id, edit] of Object.entries(stored)) {
      const field = byId.get(id);
      if (!field) {
        dropped.push(id);
        continue;
      }
      const next: FieldValue = { original: field.value };
      if (field.href !== undefined) next.originalHref = field.href;
      if (field.alt !== undefined) next.originalAlt = field.alt;
      if (field.style !== undefined) next.originalStyle = field.style;
      if (edit.value !== undefined && edit.value !== field.value) next.value = edit.value;
      if (edit.href !== undefined && edit.href !== field.href) next.href = edit.href;
      if (edit.alt !== undefined && edit.alt !== field.alt) next.alt = edit.alt;
      if (edit.style !== undefined && edit.style !== field.style) next.style = edit.style;
      if (next.value === undefined && next.href === undefined && next.alt === undefined && next.style === undefined) continue;
      values[id] = next;
    }

    const empty = Object.keys(values).length === 0;
    await prisma.sitePage.update({
      where: { id: page.id },
      data: {
        // A nullable Json column clears with `Prisma.DbNull`; a plain `null`
        // would be the JSON value `null`, which is not the same as no draft.
        draft: empty ? Prisma.DbNull : (values as unknown as Prisma.InputJsonValue),
        draftSavedAt: empty ? null : new Date(),
        draftSavedById: empty ? null : req.dbUser?.id ?? null,
      },
    });

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
      const sameBytes = now.value === field.value && (now.href ?? "") === (field.href ?? "") && (now.alt ?? "") === (field.alt ?? "");
      if (sameBytes) continue;
      const sameToRead =
        readsSame(now.preview, field.preview) && readsSame(now.href ?? "", field.href ?? "") && readsSame(now.alt ?? "", field.alt ?? "");
      if (sameToRead) {
        invisible += 1;
        continue;
      }
      differences.push({ id: field.id, label: field.label, now: now.preview, after: field.preview });
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
    const { page, site } = await loadPage(req, req.params.pageId);
    const version = await prisma.sitePageVersion.findFirst({ where: { id: req.params.versionId, pageId: page.id } });
    if (!version) throw new WebsiteError(404, "That version is not on this page.");

    const source = await pageSource(site, page, { fresh: true });
    if (source.html === version.html) {
      throw new WebsiteError(400, `The page is already exactly as it was in version ${version.number}. Nothing to publish.`);
    }

    const author = req.dbUser?.name ?? "the website editor";
    const commit = await publishPage({
      site,
      page,
      html: version.html,
      message: `Website: roll ${page.path} back to version ${version.number} (${author})`,
    });

    const last = await prisma.sitePageVersion.findFirst({ where: { pageId: page.id }, orderBy: { number: "desc" }, select: { number: true } });
    const written = await prisma.sitePageVersion.create({
      data: {
        pageId: page.id,
        number: (last?.number ?? 0) + 1,
        html: version.html,
        // The values are carried across so the new row can say what it restored
        // rather than reading as a publish that changed nothing.
        values: (version.values ?? Prisma.DbNull) as Prisma.InputJsonValue,
        commitSha: commit.sha,
        commitUrl: commit.url,
        publishedById: req.dbUser?.id ?? null,
      },
    });

    // A rollback leaves any unpublished draft exactly where it was. It undoes a
    // publish, not somebody's work in progress — and silently discarding a draft
    // as a side effect of an emergency action is how an emergency becomes two.
    await prisma.sitePage.update({ where: { id: page.id }, data: { lastPublishedAt: new Date() } });

    res.json({
      version: written.number,
      restoredFrom: version.number,
      label: `Rollback to version ${version.number}`,
      commit: { sha: commit.sha, url: commit.url },
      url: pageUrl(site, page),
      note: "GitHub Pages rebuilds the site after a commit. The change is usually live within a minute or two.",
    });
  } catch (err) {
    next(err);
  }
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
    if (req.dbUser?.accessRole?.external) {
      throw new WebsiteError(403, "This account cannot open sites in the internal editor.");
    }

    const [sites, pages, drafts, hidden, versions] = await Promise.all([
      prisma.site.count(),
      prisma.sitePage.count(),
      prisma.sitePage.count({ where: { NOT: { draft: { equals: Prisma.DbNull } } } }),
      prisma.sitePage.count({ where: { status: "HIDDEN" } }),
      prisma.sitePageVersion.findMany({
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
    const unconnected = await prisma.site.count({ where: { OR: [{ repoOwner: null }, { repoName: null }] } });

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
