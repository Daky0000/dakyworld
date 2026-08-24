import { Router } from "express";
import { z } from "zod";
import type { Site, SitePage } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { gateBy } from "../middleware/permissionGate.js";
import { applyValues, readPage, type FieldValue, type SiteField } from "../services/website/regions.js";
import { checkLink, sanitizePlain, sanitizeRich } from "../services/website/sanitize.js";
import { discoverPages, pageSource, pageUrl, previewDocument, publishPage, siteRepo, WebsiteError } from "../services/website/site.js";

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
  };
}

function draftValues(page: SitePage): Record<string, FieldValue> {
  return (page.draft as Record<string, FieldValue> | null) ?? {};
}

async function loadPage(pageId: string): Promise<{ page: SitePage; site: Site }> {
  const page = await prisma.sitePage.findUnique({ where: { id: pageId }, include: { site: true } });
  if (!page) throw new WebsiteError(404, "That page is not in the editor. It may have been removed — rescan the site.");
  const { site, ...rest } = page;
  return { page: rest as SitePage, site };
}

/**
 * Everything about a draft that would stop it going live.
 *
 * Run on save so the editor can mark the field, and again on publish so a
 * problem saved before a rule existed cannot slip out. Blank required text and
 * a link pointing nowhere are the two that actually happen.
 */
function problemsWith(fields: SiteField[], values: Record<string, FieldValue>): Array<{ id: string; label: string; reason: string }> {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const problems: Array<{ id: string; label: string; reason: string }> = [];

  for (const [id, edit] of Object.entries(values)) {
    const field = byId.get(id);
    if (!field) {
      problems.push({ id, label: "A field that has moved", reason: "This edit no longer matches anything on the page. Discard it, or reopen the page." });
      continue;
    }
    if (edit.value !== undefined && field.kind !== "image" && edit.value.replace(/<[^>]*>/g, "").trim() === "") {
      problems.push({ id, label: field.label, reason: "This cannot be left empty — a heading or a button with no words disappears from the page." });
    }
    if (edit.href !== undefined) {
      const checked = checkLink(edit.href);
      if (!checked.ok) problems.push({ id, label: field.label, reason: checked.reason });
    }
    if (edit.value !== undefined && field.kind === "image" && !edit.value.trim()) {
      problems.push({ id, label: field.label, reason: "An image needs a file to point at." });
    }
    // The plan's rule, and an accessibility one: a picture either describes
    // itself or is explicitly marked as decoration.
    if (field.kind === "image" && edit.alt !== undefined && edit.alt.trim() === "" && !field.decorative) {
      problems.push({ id, label: field.label, reason: "Describe the image, or mark it decorative if it carries no meaning." });
    }
  }
  return problems;
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
    const site = await prisma.site.findUnique({ where: { id: req.params.siteId } });
    if (!site) throw new WebsiteError(404, "That site is not in the editor.");
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
    const site = await prisma.site.findUnique({ where: { id: req.params.siteId } });
    if (!site) throw new WebsiteError(404, "That site is not in the editor.");

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
    const site = await prisma.site.update({ where: { id: req.params.siteId }, data: body });
    res.json({ id: site.id, name: site.name, publicUrl: site.publicUrl, repo: siteRepo(site), branch: site.repoBranch });
  } catch (err) {
    next(err);
  }
});

websiteRouter.patch("/pages/:pageId", async (req, res, next) => {
  try {
    const body = z.object({ title: z.string().min(1).max(120).optional(), status: z.enum(["LIVE", "HIDDEN"]).optional() }).parse(req.body);
    const page = await prisma.sitePage.update({ where: { id: req.params.pageId }, data: body });
    res.json({ id: page.id, title: page.title, status: page.status });
  } catch (err) {
    next(err);
  }
});

/** A page opened for editing: its fields as they stand, plus whatever draft sits over them. */
websiteRouter.get("/pages/:pageId", async (req, res, next) => {
  try {
    const { page, site } = await loadPage(req.params.pageId);
    const source = await pageSource(site, page);
    const content = readPage(source.html);
    const values = draftValues(page);

    const saver = page.draftSavedById
      ? await prisma.user.findUnique({ where: { id: page.draftSavedById }, select: { id: true, name: true } })
      : null;

    res.json({
      site: { id: site.id, name: site.name, publicUrl: site.publicUrl, repo: siteRepo(site) },
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
        fields: section.fields.map(publicField),
      })),
      draft: {
        values: Object.fromEntries(
          Object.entries(values).map(([id, edit]) => [id, { value: edit.value, href: edit.href, alt: edit.alt }]),
        ),
        savedAt: page.draftSavedAt,
        savedBy: saver,
      },
      problems: problemsWith(content.fields, values),
    });
  } catch (err) {
    next(err);
  }
});

const draftBody = z.object({
  values: z.record(
    z.object({
      value: z.string().max(20_000).optional(),
      href: z.string().max(2_000).optional(),
      alt: z.string().max(500).optional(),
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
    const { page, site } = await loadPage(req.params.pageId);
    const source = await pageSource(site, page);
    const content = readPage(source.html);
    const byId = new Map(content.fields.map((field) => [field.id, field]));

    const values: Record<string, FieldValue> = {};
    const unknown: string[] = [];

    for (const [id, edit] of Object.entries(body.values)) {
      const field = byId.get(id);
      if (!field) {
        unknown.push(id);
        continue;
      }

      const next: FieldValue = {};
      if (edit.value !== undefined) {
        const cleaned =
          field.kind === "richtext" ? sanitizeRich(edit.value) : field.kind === "image" ? edit.value.trim() : sanitizePlain(edit.value);
        if (cleaned !== field.value) next.value = cleaned;
      }
      if (edit.href !== undefined && edit.href.trim() !== (field.href ?? "")) next.href = edit.href.trim();
      if (edit.alt !== undefined && edit.alt !== (field.alt ?? "")) next.alt = edit.alt;

      if (Object.keys(next).length === 0) continue;
      next.original = field.value;
      if (field.href !== undefined) next.originalHref = field.href;
      if (field.alt !== undefined) next.originalAlt = field.alt;
      values[id] = next;
    }

    const empty = Object.keys(values).length === 0;
    const saved = await prisma.sitePage.update({
      where: { id: page.id },
      data: {
        // A nullable Json column clears with `Prisma.DbNull`; a plain `null`
        // would be the JSON value `null`, which is not the same as no draft.
        draft: empty ? Prisma.DbNull : (values as unknown as Prisma.InputJsonValue),
        draftSavedAt: empty ? null : new Date(),
        draftSavedById: empty ? null : req.dbUser?.id ?? null,
      },
    });

    res.json({
      savedAt: saved.draftSavedAt,
      changed: Object.keys(values).length,
      unknown,
      problems: problemsWith(content.fields, values),
    });
  } catch (err) {
    next(err);
  }
});

websiteRouter.delete("/pages/:pageId/draft", async (req, res, next) => {
  try {
    await prisma.sitePage.update({
      where: { id: req.params.pageId },
      data: { draft: Prisma.DbNull, draftSavedAt: null, draftSavedById: null },
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
    const { page, site } = await loadPage(req.params.pageId);
    const source = await pageSource(site, page);
    const applied = applyValues(source.html, draftValues(page));
    const document = previewDocument(applied.html, site.publicUrl);
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
    const { page, site } = await loadPage(req.params.pageId);
    const values = draftValues(page);
    if (Object.keys(values).length === 0) throw new WebsiteError(400, "There is nothing to publish — this page has no unsaved changes.");

    const source = await pageSource(site, page);
    const content = readPage(source.html);

    const problems = problemsWith(content.fields, values);
    if (problems.length) {
      return res.status(400).json({ error: "This page cannot be published yet — some fields need attention.", problems });
    }

    const applied = applyValues(source.html, values);
    if (applied.conflicts.length || applied.missing.length) {
      return res.status(409).json({
        error: "The page has changed since these edits were made, so they have not been published. Reopen the page to see it as it is now.",
        conflicts: applied.conflicts,
        missing: applied.missing,
      });
    }
    if (applied.changed.length === 0) throw new WebsiteError(400, "The page already says all of this. Nothing to publish.");

    const author = req.dbUser?.name ?? "the website editor";
    const commit = await publishPage({
      site,
      page,
      html: applied.html,
      message: `Website: ${applied.changed.length} change${applied.changed.length === 1 ? "" : "s"} on ${page.path} (${author})`,
    });

    const last = await prisma.sitePageVersion.findFirst({ where: { pageId: page.id }, orderBy: { number: "desc" }, select: { number: true } });
    const version = await prisma.sitePageVersion.create({
      data: {
        pageId: page.id,
        number: (last?.number ?? 0) + 1,
        html: applied.html,
        values: values as unknown as Prisma.InputJsonValue,
        commitSha: commit.sha,
        commitUrl: commit.url,
        publishedById: req.dbUser?.id ?? null,
      },
    });
    await prisma.sitePage.update({
      where: { id: page.id },
      data: { draft: Prisma.DbNull, draftSavedAt: null, draftSavedById: null, lastPublishedAt: new Date() },
    });

    res.json({
      version: version.number,
      changed: applied.changed.length,
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
    const versions = await prisma.sitePageVersion.findMany({
      where: { pageId: req.params.pageId },
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
    res.json(
      versions.map((version) => ({
        ...version,
        changed: version.values ? Object.keys(version.values as Record<string, unknown>).length : 0,
        values: undefined,
      })),
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

    const { page, site } = await loadPage(req.params.pageId);
    const source = await pageSource(site, page);
    const content = readPage(source.html);
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
      if (edit.value !== undefined && edit.value !== field.value) next.value = edit.value;
      if (edit.href !== undefined && edit.href !== field.href) next.href = edit.href;
      if (edit.alt !== undefined && edit.alt !== field.alt) next.alt = edit.alt;
      if (next.value === undefined && next.href === undefined && next.alt === undefined) continue;
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
