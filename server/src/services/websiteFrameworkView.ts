/**
 * A framework page, edited beside the page itself.
 *
 * The source editor works and reads like a file browser, which is the wrong
 * shape for the person it is for: they clicked "Edit" next to a page called
 * Pricing and were handed `app/(marketing)/pricing/page.tsx`. What they wanted
 * was the builder — their page, and the words on it.
 *
 * We cannot turn their `.tsx` into HTML ourselves. That means running their
 * build, and even then a rendered `<h1>` has no general way back to the literal
 * it came from once it has passed through a loop, a prop and a layout.
 *
 * But their site is already built and published, so the HTML exists: it is the
 * live page. So this puts the live page in the frame, works out which of its
 * elements came from which literal in the source file, and marks only those.
 * Everything else is visible and not editable, which is the truth — the rest of
 * that page is code.
 *
 * The matching is `mapJsxFieldsToHtml`, and it is deliberately strict: same
 * tag, identical decoded value, unique on both sides. A guess here would show
 * somebody a heading, take their edit, and change a different heading.
 *
 * Two things this is honest about rather than hiding:
 *
 *  - **the live page can be behind.** It is whatever the host last built, so a
 *    publish from ten seconds ago may not be on it yet. The publish job knows
 *    when it lands; this says plainly what it is showing.
 *  - **a page that has never been deployed has no HTML at all.** Then there is
 *    no frame, and the fields are still editable on their own.
 */
import type { Request, Response, Router } from "express";
import type { Site, SitePage } from "@prisma/client";
import { discoverFields, mapJsxFieldsToHtml, pageFile, buildPreview, type SiteField } from "./website/index.js";
import { isEditableSourcePath } from "./website/index.js";
import { pageUrl, siteRepo, WebsiteError } from "./website/site.js";
import { sourceAdapterFor } from "./websiteSource.js";
import { matchPageToHtml, type PageDiscovery, type PageView } from "./website/pageFields.js";
import { hasSourceManifest, pageManifest } from "./websitePageManifest.js";
import { fetchWebsiteText } from "../lib/websiteFetch.js";
import { assertWebsiteSiteAccess, type WebsiteAction } from "./websiteAccess.js";

type Access = { loadPage(req: Request, id: string): Promise<{ page: SitePage; site: Site }> };
type Dependencies = {
  file: typeof pageFile;
  live(url: string): Promise<string>;
  authorize(req: Request, siteId: string, action: WebsiteAction): Promise<unknown>;
  manifest: typeof pageManifest;
};
const dependencies: Dependencies = { file: pageFile, live: fetchWebsiteText, authorize: assertWebsiteSiteAccess, manifest: pageManifest };

export type FrameworkView = {
  /** The source fields, and which of them the live page can show. */
  fields: Array<{ id: string; label: string; kind: string; value: string; marker?: string; confidence: string; shownOnPage: boolean }>;
  issues: unknown[];
  mapping: Array<{ sourceFieldId: string; htmlFieldId: string }>;
};

/**
 * The same view, built from every file the page reaches rather than from its
 * route file alone.
 *
 * `matchSourceToLive` below is the single-file answer and stays exactly as it
 * was, because `.astro`, `.vue` and `.svelte` pages still use it and have no
 * import graph this editor can walk. A JSX-family page gets this instead: the
 * heading in the imported component and the cards in the data file are fields
 * of the page, which on most real projects is the difference between an editor
 * with something in it and an empty one.
 */
export function matchManifestToLive(input: { discovery: PageDiscovery; liveHtml: string | null }): FrameworkView & { view: (PageView & { htmlFields: SiteField[] }) | null; sources: PageDiscovery["sources"] } {
  const view = input.liveHtml ? matchPageToHtml({ discovery: input.discovery, html: input.liveHtml }) : null;
  const shown = new Set(view?.mappings.map((mapping) => mapping.sourceFieldId) ?? []);
  return {
    view,
    sources: input.discovery.sources,
    issues: input.discovery.issues,
    mapping: (view?.mappings ?? []).map((mapping) => ({ sourceFieldId: mapping.sourceFieldId, htmlFieldId: mapping.htmlFieldId })),
    fields: input.discovery.fields.map((field) => ({
      id: field.id,
      label: field.label,
      kind: field.kind,
      value: field.value,
      ...(field.marker ? { marker: field.marker } : {}),
      confidence: field.confidence,
      shownOnPage: shown.has(field.id),
      // Which file this field lives in, so the editor can say "this is in your
      // header, which every page shares" before somebody changes it everywhere.
      filePath: field.filePath,
      role: field.role,
      scope: field.shared ? ("shared" as const) : ("instance" as const),
    })),
  };
}

/**
 * The source file's fields, and their matches on the live page.
 *
 * Pure apart from the two reads it is given, so the matching can be checked
 * against real files with no network — see `checks/websiteFrameworkView.ts`.
 */
export function matchSourceToLive(input: { source: string; filePath: string; liveHtml: string | null }): FrameworkView & { htmlFields: SiteField[]; sourceHash: string; adapter: string } {
  const adapter = sourceAdapterFor(input.filePath);
  const discovery = adapter.discover(input.source, input.filePath);
  const htmlFields = input.liveHtml ? discoverFields(input.liveHtml).fields : [];
  // The mapper takes the JSX adapter's field shape; the template and Markdown
  // adapters produce the same one, so a `.vue` page matches on the same terms a
  // `.tsx` page does and neither gets a private set of rules.
  const report = input.liveHtml ? mapJsxFieldsToHtml(discovery.fields as never, htmlFields) : { mappings: [], diagnostics: [] };
  const shown = new Set(report.mappings.map((mapping) => mapping.sourceFieldId));
  return {
    adapter: discovery.adapter,
    sourceHash: discovery.sourceHash,
    htmlFields,
    issues: discovery.issues,
    mapping: report.mappings.map((mapping) => ({ sourceFieldId: mapping.sourceFieldId, htmlFieldId: mapping.htmlFieldId })),
    fields: discovery.fields.map((field) => ({
      id: field.id,
      label: field.label,
      kind: field.kind,
      value: field.value,
      // Markdown fields have no marker; the other two adapters do.
      ...("marker" in field && field.marker ? { marker: field.marker } : {}),
      confidence: field.confidence,
      shownOnPage: shown.has(field.id),
    })),
  };
}

/**
 * Which fields of a built page a publish could actually write.
 *
 * Used by the visual editor, which shows the whole rendered page: everything is
 * visible, and only what traces back to a literal in the source is editable.
 * Saying which on the field itself is the difference between a person being
 * told now and being told at the publish, when they have already done the work.
 */
export async function sourceManagedFields(site: Site, page: SitePage, html: string): Promise<{ writable: Set<string>; notes: Map<string, string>; nameable?: Set<string>; failure?: string } | null> {
  // The editor and the publish have to agree about what is writable, and they
  // agree by asking the same question of the same files. When this read one file
  // and the publish read the whole manifest, every heading in a component was
  // shown locked to the person editing it and would have been written happily
  // by the publish they were not allowed to reach.
  if (hasSourceManifest(page.filePath)) {
    // Never swallowed. When the crawl cannot be built — no repository, a tree
    // too large for one call, a branch that moved — every field on the page
    // becomes unwritable, and saying "this came from the code" about all of
    // them is a lie told three hundred times. The reason travels instead.
    const context = await pageManifest(site, page).catch((error: unknown) => (error instanceof WebsiteError ? error.message : "The files this page is built from could not be read from the connected repository."));
    if (typeof context === "string") return { writable: new Set(), notes: new Map(), failure: context };
    const wide = matchManifestToLive({ discovery: context.discovery, liveHtml: html });
    // The mapper already knows why each of these is locked — which is a far more
    // useful sentence than "it came from the code". A person told "these exact
    // words appear more than once" can act; a person told the page is code
    // cannot. Naming the files the words were found in is the rest of it: the
    // brand in a header is not in `page.tsx` and saying so sends them nowhere.
    const notes = new Map<string, string>();
    const byValue = new Map<string, Set<string>>();
    for (const field of context.discovery.fields) {
      const value = field.value.trim();
      if (!value) continue;
      const files = byValue.get(value) ?? new Set<string>();
      files.add(field.filePath);
      byValue.set(value, files);
    }
    const values = new Map((wide.view?.htmlFields ?? []).map((field) => [field.id, field.value.trim()]));
    for (const capability of wide.view?.capabilities ?? []) {
      if (!capability.reason) continue;
      // Naming the file is not a claim that the edit could be traced there —
      // that is exactly what failed. It is the far more useful fact that these
      // words do exist as text somewhere, and where, so a dead end becomes the
      // one place the change can actually be made. Silent when they do not.
      // Where the mapper named the collision, those files are the answer; the
      // value match is the fallback for a literal that was never matched at all.
      const named = (wide.view?.diagnostics ?? []).filter((diagnostic) => diagnostic.candidateHtmlFieldIds.includes(capability.htmlFieldId)).map((diagnostic) => diagnostic.filePath);
      const where = [...new Set(named.length ? named : [...(byValue.get(values.get(capability.htmlFieldId) ?? " ") ?? [])])].sort();
      notes.set(
        capability.htmlFieldId,
        where.length
          ? `${capability.reason} These words are in ${where.join(" and ")} — open it under Source files to change it there.`
          : capability.reason,
      );
    }
    // Which of the locked elements the editor could unlock by itself: the ones
    // locked because their words are shared, rather than because the code works
    // them out. The distinction decides whether a button is worth offering, and
    // offering it where it cannot help is how a person learns to ignore it.
    const nameable = new Set(
      wide.view?.diagnostics.filter((diagnostic) => diagnostic.code === "ambiguous").flatMap((diagnostic) => diagnostic.candidateHtmlFieldIds) ?? [],
    );
    return { writable: new Set(wide.mapping.map((entry) => entry.htmlFieldId)), notes, nameable };
  }
  const source = await pageFile(site, page).catch(() => null);
  if (source === null) return { writable: new Set(), notes: new Map(), failure: `${page.filePath} could not be read from branch ${site.repoBranch}, so nothing on this page could be traced back to it.` };
  const view = matchSourceToLive({ source, filePath: page.filePath, liveHtml: html });
  return { writable: new Set(view.mapping.map((entry) => entry.htmlFieldId)), notes: new Map() };
}

/** Page-scoped framework editing: the page's file, and the live page beside it. */
export function registerWebsiteFrameworkView(router: Router, access: Access, overrides: Partial<Dependencies> = {}) {
  const deps = { ...dependencies, ...overrides };
  const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => { void fn(req, res).catch(next); };

  const load = async (req: Request) => {
    const { page, site } = await access.loadPage(req, req.params.pageId);
    await deps.authorize(req, site.id, "source");
    if (!isEditableSourcePath(page.filePath)) {
      throw new WebsiteError(400, "This page is an HTML file. Open it in the visual editor, which edits the page itself.");
    }
    if (!siteRepo(site)) throw new WebsiteError(409, "Connect this site's GitHub repository in Website settings to edit its pages.");
    const source = await deps.file(site, page);
    if (source === null) throw new WebsiteError(404, `${page.filePath} is not on branch ${site.repoBranch}. Scan the site again to refresh its page list.`);
    return { page, site, source };
  };

  const live = async (site: Site, page: SitePage): Promise<{ html: string | null; reason: string | null }> => {
    try {
      return { html: await deps.live(pageUrl(site, page)), reason: null };
    } catch (error) {
      // Not deployed yet, not public, or the address is wrong. All three are
      // worth saying: the fields still work, and a blank frame with no sentence
      // beside it reads as a broken editor.
      return { html: null, reason: error instanceof Error ? error.message : "The live page could not be read." };
    }
  };

  router.get("/pages/:pageId/framework", handler(async (req, res) => {
    const { page, site, source } = await load(req);
    const published = await live(site, page);
    res.setHeader("Cache-Control", "no-store");

    // The JSX family reads every file the page reaches. Everything else keeps
    // the single-file answer, which is the only one its adapter can give.
    if (hasSourceManifest(page.filePath)) {
      const { manifest, discovery } = await deps.manifest(site, page);
      const wide = matchManifestToLive({ discovery, liveHtml: published.html });
      res.json({
        page: { id: page.id, title: page.title, path: page.path, filePath: page.filePath, url: pageUrl(site, page) },
        site: { id: site.id, repo: siteRepo(site), branch: site.repoBranch, sourceKind: site.sourceKind },
        adapter: discovery.version,
        sourceHash: discovery.manifestHash,
        fields: wide.fields,
        issues: wide.issues,
        mapping: wide.mapping,
        // What the editor needs to be honest on screen: which files this page is
        // made of, which parts of it are code, and what may be done to each
        // element it is about to let somebody click on.
        manifest: {
          version: manifest.version,
          entry: manifest.entry,
          files: manifest.files.map((file) => ({ path: file.path, role: file.role, sourceHash: file.sourceHash, clientBoundary: file.clientBoundary })),
          boundaries: manifest.boundaries,
          truncated: manifest.truncated,
        },
        capabilities: wide.view?.capabilities ?? [],
        diagnostics: wide.view?.diagnostics ?? [],
        live: { url: pageUrl(site, page), available: published.html !== null, reason: published.reason },
      });
      return;
    }

    const view = matchSourceToLive({ source, filePath: page.filePath, liveHtml: published.html });
    res.json({
      page: { id: page.id, title: page.title, path: page.path, filePath: page.filePath, url: pageUrl(site, page) },
      site: { id: site.id, repo: siteRepo(site), branch: site.repoBranch, sourceKind: site.sourceKind },
      adapter: view.adapter,
      sourceHash: view.sourceHash,
      fields: view.fields,
      issues: view.issues,
      mapping: view.mapping,
      live: { url: pageUrl(site, page), available: published.html !== null, reason: published.reason },
    });
  }));

  router.get("/pages/:pageId/framework/preview", handler(async (req, res) => {
    const { page, site, source } = await load(req);
    const published = await live(site, page);
    if (published.html === null) throw new WebsiteError(409, `This page has not been published yet, so there is nothing to show. ${published.reason ?? ""}`.trim());
    const view = hasSourceManifest(page.filePath)
      ? await deps.manifest(site, page).then(({ discovery }) => {
          const wide = matchManifestToLive({ discovery, liveHtml: published.html });
          return { htmlFields: wide.view?.htmlFields ?? [], mapping: wide.mapping };
        })
      : matchSourceToLive({ source, filePath: page.filePath, liveHtml: published.html });
    const matched = new Set(view.mapping.map((entry) => entry.htmlFieldId));
    // Every element is marked, so the whole page answers a click the way the
    // HTML editor does. Only the elements that came from a literal in this file
    // can be typed into; the rest select, outline, and say in the panel why
    // there is nothing here that could edit them.
    const editable = view.htmlFields.map((field) => (matched.has(field.id) ? field : { ...field, previewReadOnly: true as const }));
    // Typing on the page is allowed for exactly the elements that were matched,
    // and nothing else has a marker to type into. What the browser sends back is
    // words, and they become an edit to the literal those words came from — the
    // frame is never the record of anything, the file is.
    const document = buildPreview(published.html, pageUrl(site, page), editable, true);
    res
      .type("html")
      .set("Cache-Control", "no-store")
      .set("Content-Security-Policy", document.csp)
      .set("X-Frame-Options", "SAMEORIGIN")
      // Sent as it came, with no uploaded images swapped in: this is the page
      // the public is already being served, so its pictures are the real ones.
      // The HTML editor embeds drafts because its preview shows a page that has
      // not been published; there is no such thing here.
      .send(document.html);
  }));
}
