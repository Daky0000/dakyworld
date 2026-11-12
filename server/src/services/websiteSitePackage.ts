/**
 * A whole website imported as a ZIP or a folder, so that every page works.
 *
 * 11 Nov 2026. The package import already found every page in an archive and
 * stored every file. What it did not do was make the result a working site:
 *
 *  - A framework build (Next.js, Gatsby, Nuxt, SvelteKit, Remix, Astro islands)
 *    repainted each page from its own data as it loaded, so every edit was
 *    undone on the published site. Its pages are now frozen
 *    (`website/buildOutput.ts`).
 *  - Files kept their archive paths as their storage keys, shared by every
 *    site, and a hosted domain only serves `assets/dw/<file>`. Every file a
 *    page uses is now stored under a fresh `assets/dw/<uuid>.<ext>` of its own
 *    site — the shape an upload in the editor has — with pictures made WebP on
 *    the way, through the same bundler the Demos import uses. Files no page
 *    uses (a frozen build's own chunks and data) are left out and counted.
 *  - Links between pages kept whatever spelling the export used. Relative ones
 *    broke one folder down once the hosted address dropped `index.html`; they
 *    now point at the page's own clean address.
 *  - Two files for one address (`404.html` and `404/index.html`) both became
 *    the page at `/404`, the second overwriting the first. One is kept and the
 *    summary says which.
 *  - Three hundred files were written inside one interactive transaction with
 *    Prisma's 5 s default, after uploading them to R2. Files are now written in
 *    batches first, pages in a transaction with room to finish, and the files
 *    are taken back out if the pages fail.
 *
 * `checks/websiteSitePackage.ts` holds it.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { optimizeImageBuffer } from "../lib/imageOptimization.js";
import { deleteFromR2, isR2Configured, uploadToR2 } from "../lib/r2.js";
import { attrNode, decodeEntities, parseHtml, walk } from "./website/parse.js";
import { discoverFields } from "./website/index.js";
import { drawnByScript } from "./website/site.js";
import { freezePage, recogniseBuild, type BuildRecognition } from "./website/buildOutput.js";
import { contentTypeFor, isTextAsset, referencesIn, rewriteReferences, STORABLE } from "./demoPackage.js";
import { healWebflowFouc, type DiscoveredPage, type ImportPackageResult, type PackageAnalysis } from "./websitePackageImport.js";
import type { SourceProjectDetection } from "./website/sourceBuild.js";
import { assetUrl } from "./websiteAssets.js";
import { assertImportAllowance, assertMediaStorageAllowance, recordImportUsed, recordMediaStorageAdded } from "./websiteTierPlans.js";
import type { WebsiteActor } from "./websiteActor.js";

/* ------------------------------------------------------------------ pages */

/**
 * One page per address. Of two files that land on the same address the one
 * nearer the top of the archive wins (`404.html` over `404/index.html`), then
 * the first in name order, so the choice never depends on archive order.
 */
export function choosePages<T extends Pick<DiscoveredPage, "filePath" | "path">>(pages: T[]): { kept: T[]; dropped: Array<{ filePath: string; keptFilePath: string; path: string }> } {
  const byPath = new Map<string, T[]>();
  for (const page of pages) byPath.set(page.path, [...(byPath.get(page.path) ?? []), page]);
  const kept: T[] = [];
  const dropped: Array<{ filePath: string; keptFilePath: string; path: string }> = [];
  for (const page of pages) {
    const group = byPath.get(page.path)!;
    const winner = [...group].sort((a, b) => a.filePath.split("/").length - b.filePath.split("/").length || a.filePath.localeCompare(b.filePath))[0]!;
    if (page === winner) kept.push(page);
    else dropped.push({ filePath: page.filePath, keptFilePath: winner.filePath, path: page.path });
  }
  return { kept, dropped };
}

const TITLE_SEPARATORS = [" — ", " – ", " | ", " - ", " · ", " :: "];

/**
 * Page titles for the page list, without the site's name on every one.
 *
 * A built site's `<title>`s read "About Us — Gulf Contracting Co. W.L.L.",
 * fifty times over, and a list of them is a column of the same words. When
 * most pages end (or begin) with the same separator and words, that part is
 * dropped from the list's title. The page's own `<title>` is not touched.
 */
export function tidyPageTitles(titles: string[]): string[] {
  if (titles.length < 3) return titles;
  for (const separator of TITLE_SEPARATORS) {
    const tails = new Map<string, number>();
    const heads = new Map<string, number>();
    for (const title of titles) {
      const cut = title.lastIndexOf(separator);
      if (cut > 0) tails.set(title.slice(cut), (tails.get(title.slice(cut)) ?? 0) + 1);
      const first = title.indexOf(separator);
      if (first > 0) heads.set(title.slice(0, first + separator.length), (heads.get(title.slice(0, first + separator.length)) ?? 0) + 1);
    }
    const common = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1])[0];
    const tail = common(tails);
    if (tail && tail[1] >= titles.length * 0.6) return titles.map((title) => (title.endsWith(tail[0]) && title.length > tail[0].length ? title.slice(0, -tail[0].length).trim() : title));
    const head = common(heads);
    if (head && head[1] >= titles.length * 0.6) return titles.map((title) => (title.startsWith(head[0]) && title.length > head[0].length ? title.slice(head[0].length).trim() : title));
  }
  return titles;
}

const NOT_A_PAGE_LINK = /^(?:#|[a-z][a-z0-9+.-]*:|\/\/)/i;

/** `/about/index.html`, `/about/`, `/about.html` and `/about` are one address. */
export function routeOfLink(linkPath: string): string {
  const clean = linkPath
    .replace(/\/index\.html?$/i, "/")
    .replace(/\.html?$/i, "")
    .replace(/\/+$/, "");
  return clean.startsWith("/") ? clean || "/" : `/${clean}`;
}

/**
 * The address of the imported page an `href` names, or null when it names
 * something else (a file, another site, an anchor on the same page).
 *
 * Relative links are resolved against the file they are in and looked up by
 * file. Root-relative links are looked up by address too, because a page may
 * have sat in a folder inside the archive (`site/about/index.html`) while its
 * links were written for the site's root.
 */
export function pageLinkTarget(href: string, fromFile: string, byFile: ReadonlyMap<string, string>, routes: ReadonlySet<string>): { route: string; suffix: string } | null {
  const raw = decodeEntities(href).trim();
  if (!raw || NOT_A_PAGE_LINK.test(raw)) return null;
  const split = /^([^?#]*)(.*)$/s.exec(raw)!;
  let linkPath = split[1]!;
  const suffix = split[2]!;
  if (!linkPath) return null;
  try {
    linkPath = decodeURI(linkPath);
  } catch {}
  const rooted = linkPath.startsWith("/");
  const dir = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(rooted ? linkPath : `${dir === "." ? "" : `${dir}/`}${linkPath}`);
  // A browser stops at the root however many `..` it is given.
  const file = joined.replace(/^\/+/, "").replace(/^(?:\.\.\/?)+/, "").replace(/^\.\/?$/, "");
  const folder = linkPath.endsWith("/") || file === "";
  const candidates = folder
    ? [`${file.replace(/\/+$/, "")}/index.html`.replace(/^\//, ""), `${file.replace(/\/+$/, "")}/index.htm`.replace(/^\//, "")]
    : [file, `${file}.html`, `${file}/index.html`, `${file}.htm`, `${file}/index.htm`];
  for (const candidate of candidates) {
    const route = byFile.get(candidate);
    if (route) return { route, suffix };
  }
  if (rooted) {
    const route = routeOfLink(linkPath);
    if (routes.has(route)) return { route, suffix };
  }
  return null;
}

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Every link to another imported page rewritten to that page's address under the site's base path. */
export function rewritePageLinks(html: string, fromFile: string, byFile: ReadonlyMap<string, string>, routes: ReadonlySet<string>, basePath: string): { html: string; rewritten: number } {
  const base = basePath.replace(/\/+$/, "");
  const edits: Array<{ start: number; end: number; value: string }> = [];
  for (const node of walk(parseHtml(html))) {
    if (node.tag !== "a" && node.tag !== "area") continue;
    const href = attrNode(node, "href");
    if (!href) continue;
    const target = pageLinkTarget(href.value, fromFile, byFile, routes);
    if (!target) continue;
    const address = `${base}${target.route === "/" ? "/" : target.route}${target.suffix}`;
    if (decodeEntities(href.value) === address) continue;
    edits.push({ start: href.valueStart, end: href.valueEnd, value: escapeAttribute(address) });
  }
  let out = html;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    // An unquoted value gains quotes, so a `?a&b` suffix cannot end it early.
    const quoted = out[edit.start - 1] === '"' || out[edit.start - 1] === "'";
    out = out.slice(0, edit.start) + (quoted ? edit.value : `"${edit.value}"`) + out.slice(edit.end);
  }
  return { html: out, rewritten: edits.length };
}

/* ------------------------------------------------------------------ files */

export type PendingSiteFile = { source: string; repoPath: string; filename: string; contentType: string; content: Buffer };

/**
 * What every page uses, stored once under the site's own names.
 *
 * The Demos bundler (`demoPackage.ts`) for many pages at once: a stylesheet is
 * followed relative to itself, a script relative to the first page that loads
 * it, pictures are optimised before anything is renamed so a `.png` that
 * became `.webp` is pointed at by its new name. `hostedBase` is what
 * `assetUrl(site, "assets/dw")` gives.
 */
export async function bundleSiteFiles(
  pages: Array<{ filePath: string; html: string }>,
  files: ReadonlyMap<string, Buffer>,
  hostedBase: string,
): Promise<{ pages: string[]; files: PendingSiteFile[]; skipped: string[]; leftOut: string[] }> {
  const known = new Set(files.keys());
  const needed = new Map<string, string>();
  const queue: Array<[string, string]> = [];
  for (const page of pages) for (const reference of referencesIn(page.html, page.filePath, known)) queue.push([reference, page.filePath]);
  while (queue.length) {
    const [next, from] = queue.shift()!;
    if (needed.has(next)) continue;
    needed.set(next, from);
    const type = contentTypeFor(next);
    if (type === "text/css") for (const reference of referencesIn(files.get(next)!.toString("utf8"), next, known)) queue.push([reference, next]);
    else if (type === "application/javascript") for (const reference of referencesIn(files.get(next)!.toString("utf8"), from, known)) queue.push([reference, from]);
  }

  const prepared = new Map<string, { content: Buffer; contentType: string; extension: string }>();
  const skipped: string[] = [];
  const sources = [...needed.keys()];
  // Four at a time: a site's worth of photographs one by one is most of a minute.
  for (let start = 0; start < sources.length; start += 4) {
    await Promise.all(sources.slice(start, start + 4).map(async (source) => {
      const contentType = contentTypeFor(source);
      if (!STORABLE.test(contentType)) {
        skipped.push(source);
        return;
      }
      const raw = files.get(source)!;
      const extension = path.posix.extname(source).slice(1).toLowerCase() || "bin";
      if (/^image\/(?:png|jpeg|webp|svg\+xml)$/.test(contentType)) {
        try {
          const optimised = await optimizeImageBuffer(raw);
          prepared.set(source, { content: optimised.content, contentType: optimised.contentType, extension: optimised.extension });
        } catch {
          skipped.push(source);
        }
        return;
      }
      prepared.set(source, { content: raw, contentType, extension });
    }));
  }

  const hosted = new Map<string, string>();
  const repoPaths = new Map<string, string>();
  for (const [source, file] of prepared) {
    const repoPath = `assets/dw/${randomUUID()}.${file.extension}`;
    repoPaths.set(source, repoPath);
    hosted.set(source, `${hostedBase.replace(/\/+$/, "")}/${path.posix.basename(repoPath)}`);
  }

  const out: PendingSiteFile[] = [];
  for (const [source, file] of prepared) {
    let content = file.content;
    if (isTextAsset(file.contentType)) {
      const base = file.contentType === "text/css" ? source : needed.get(source)!;
      content = Buffer.from(rewriteReferences(content.toString("utf8"), base, known, hosted), "utf8");
    }
    out.push({ source, repoPath: repoPaths.get(source)!, filename: path.posix.basename(source).slice(0, 200), contentType: file.contentType, content });
  }

  return {
    pages: pages.map((page) => rewriteReferences(page.html, page.filePath, known, hosted)),
    files: out,
    skipped: skipped.sort(),
    leftOut: [...known].filter((file) => !needed.has(file)).sort(),
  };
}

/** A file this size goes to R2 rather than a database row, when R2 is set up. */
export const LARGE_FILE_BYTES = 8 * 1024 * 1024;
const BATCH_BYTES = 24 * 1024 * 1024;
const BATCH_ROWS = 40;

/**
 * Writes the files outside any transaction, in batches small enough that no
 * single statement carries a site's worth of photographs. A large file goes to
 * R2 under its own `assets/dw/...` key with no bytes in the row — the state a
 * swept upload is in, which every reader already handles (`movedAssetLocation`,
 * the asset route's redirect). Returns what to take back out if the pages fail.
 */
async function storeSiteFiles(siteId: string, pending: PendingSiteFile[]): Promise<{ repoPaths: string[]; r2Keys: string[] }> {
  const repoPaths: string[] = [];
  const r2Keys: string[] = [];
  const rows: Array<{ siteId: string; repoPath: string; filename: string; contentType: string; content: Buffer | null; size: number; alt: string }> = [];
  for (const file of pending) {
    let content: Buffer | null = file.content;
    if (file.content.length >= LARGE_FILE_BYTES && isR2Configured()) {
      await uploadToR2(file.content, { mimeType: file.contentType, key: file.repoPath });
      r2Keys.push(file.repoPath);
      content = null;
    }
    rows.push({ siteId, repoPath: file.repoPath, filename: file.filename, contentType: file.contentType, content, size: file.content.length, alt: "" });
  }
  try {
    let batch: typeof rows = [];
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await prisma.siteAsset.createMany({ data: batch });
      repoPaths.push(...batch.map((row) => row.repoPath));
      batch = [];
      bytes = 0;
    };
    for (const row of rows) {
      const size = row.content?.length ?? 0;
      if (batch.length && (batch.length >= BATCH_ROWS || bytes + size > BATCH_BYTES)) await flush();
      batch.push(row);
      bytes += size;
    }
    await flush();
  } catch (error) {
    await removeSiteFiles(siteId, { repoPaths, r2Keys });
    throw error;
  }
  return { repoPaths, r2Keys };
}

async function removeSiteFiles(siteId: string, stored: { repoPaths: string[]; r2Keys: string[] }): Promise<void> {
  if (stored.repoPaths.length) await prisma.siteAsset.deleteMany({ where: { siteId, repoPath: { in: stored.repoPaths } } }).catch(() => undefined);
  for (const key of stored.r2Keys) await deleteFromR2(key).catch(() => undefined);
}

/* ------------------------------------------------------------------ commit */

export type SitePackageResult = ImportPackageResult & {
  build: { kind: BuildRecognition["kind"]; label: string; frozen: boolean };
  /** Addresses two files claimed, and which file was kept. */
  duplicatePages: Array<{ filePath: string; keptFilePath: string; path: string }>;
  linksRewritten: number;
  interactions: { restored: number; unrestored: Array<{ page: string; control: string }> };
  /** Files in the archive no page uses, left out. */
  leftOut: { count: number; examples: string[] };
  /** Pages that are empty until their scripts run. */
  scriptDrawnPages: string[];
  /** Sentences for the import summary. */
  notes: string[];
  sourcePackage?: SourceProjectDetection | null;
  autoBuilt?: boolean;
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const listOf = (items: string[], max = 4) => items.slice(0, max).join(", ") + (items.length > max ? ` and ${items.length - max} more` : "");

/** Turns the archive into the site's pages and files. Replaces `commitPackageToSite` for every package import. */
export async function commitSitePackage(input: { req: WebsiteActor; siteId: string; analysis: PackageAnalysis }): Promise<SitePackageResult> {
  const { req, siteId, analysis } = input;
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { id: true, name: true, publicUrl: true } });
  await assertImportAllowance(req, siteId);

  const build = recogniseBuild([...analysis.assets.map((asset) => asset.repoPath), ...analysis.pages.map((page) => page.filePath)], analysis.pages);
  const { kept, dropped } = choosePages(analysis.pages);

  // 1. Frozen, when the build repaints its pages.
  const frozen = kept.map((page) => ({ page, frozen: freezePage(page.html, build) }));

  // 2. Links between pages, to each page's own address.
  const basePath = new URL(site.publicUrl).pathname;
  const byFile = new Map(analysis.pages.map((page) => [page.filePath, page.path]));
  const routes = new Set(kept.map((page) => page.path));
  let linksRewritten = 0;
  const linked = frozen.map(({ page, frozen: result }) => {
    const links = rewritePageLinks(result.html, page.filePath, byFile, routes, basePath);
    linksRewritten += links.rewritten;
    return { filePath: page.filePath, html: links.html };
  });

  // 3. The files the pages use, under this site's own names.
  const files = new Map(analysis.assets.map((asset) => [asset.repoPath, asset.content]));
  const bundle = await bundleSiteFiles(linked, files, assetUrl(site, "assets/dw"));

  const totalBytes = bundle.files.reduce((sum, file) => sum + file.content.length, 0);
  const largestVideo = Math.max(0, ...bundle.files.filter((file) => file.contentType.startsWith("video/")).map((file) => file.content.length));
  const largestOther = Math.max(0, ...bundle.files.filter((file) => !file.contentType.startsWith("video/")).map((file) => file.content.length));
  if (largestOther) await assertMediaStorageAllowance(req, largestOther, siteId, "image");
  if (largestVideo) await assertMediaStorageAllowance(req, largestVideo, siteId, "video");
  if (totalBytes) await assertMediaStorageAllowance(req, totalBytes, siteId, "quota-only");

  const titles = tidyPageTitles(kept.map((page) => page.title));
  const finalPages = kept.map((page, index) => {
    const html = healWebflowFouc(bundle.pages[index]!);
    const fields = discoverFields(html).fields.filter((field) => field.kind !== "container" && field.tag !== "title" && field.tag !== "meta").length;
    return { ...page, title: titles[index]!.slice(0, 200) || page.title, html, fields };
  });

  // 4. Files first, outside the transaction; pages in one, with room to finish.
  const stored = await storeSiteFiles(site.id, bundle.files);
  let createdPages: SitePackageResult["pages"];
  try {
    createdPages = await prisma.$transaction(async (tx) => {
      const list: SitePackageResult["pages"] = [];
      for (const page of finalPages) {
        const existing = await tx.sitePage.findFirst({ where: { siteId, OR: [{ filePath: page.filePath }, { path: page.path }] }, select: { id: true } });
        const record = existing
          ? await tx.sitePage.update({ where: { id: existing.id }, data: { title: page.title, filePath: page.filePath, path: page.path, sourceHtml: page.html }, select: { id: true } })
          : await tx.sitePage.create({ data: { siteId, title: page.title, filePath: page.filePath, path: page.path, sourceHtml: page.html }, select: { id: true } });
        const number = (await tx.sitePageVersion.count({ where: { pageId: record.id } })) + 1;
        await tx.sitePageVersion.create({
          data: { pageId: record.id, number, html: page.html, values: { initialImport: true, filePath: page.filePath, fields: page.fields, build: build.kind }, publishedById: req.dbUser?.id ?? null },
        });
        list.push({ id: record.id, title: page.title, path: page.path, filePath: page.filePath, fields: page.fields });
      }
      return list;
    }, { timeout: 120_000, maxWait: 15_000 });
  } catch (error) {
    await removeSiteFiles(site.id, stored);
    throw error;
  }

  // 5. What to tell the person.
  const restored = frozen.reduce((sum, entry) => sum + entry.frozen.interactions.restored, 0);
  const unrestored = frozen.flatMap(({ page, frozen: result }) => [...new Set(result.interactions.unrestored)].map((control) => ({ page: page.path, control })));
  const clientOnly = frozen.filter((entry) => entry.frozen.clientOnlyParts > 0);
  const scriptDrawnPages = finalPages.filter((page) => drawnByScript(page.html)).map((page) => page.path);
  const notes: string[] = [];
  if (analysis.autoBuilt) {
    notes.push(`Compiled and exported from ${analysis.sourcePackage?.label ?? "source project"} into ${plural(kept.length, "page")}.`);
  }
  if (build.freezes) {
    notes.push(`Recognised as ${build.label}. Its own scripts were taken out of ${plural(kept.length, "page")}, because they would have put the original words back over every edit on the published site. A small DakyXTech script now opens and closes the menus, drawers and tabs they ran${restored ? ` (${plural(restored, "control")})` : ""}.`);
  } else {
    notes.push(`Recognised as ${build.label}. Its scripts were kept.`);
  }
  if (unrestored.length) {
    const named = [...new Set(unrestored.map((entry) => entry.control))];
    notes.push(`${plural(named.length, "button")} may do nothing now, because what ${named.length === 1 ? "it" : "they"} did lived in the removed scripts: ${listOf(named.map((name) => `“${name}”`))}. Check ${named.length === 1 ? "it" : "them"} in Preview.`);
  }
  if (clientOnly.length) {
    const parts = clientOnly.reduce((sum, entry) => sum + entry.frozen.clientOnlyParts, 0);
    notes.push(`${plural(parts, "part")} on ${listOf(clientOnly.map((entry) => entry.page.path))} ${parts === 1 ? "was" : "were"} only ever drawn by those scripts and will show empty.`);
  }
  if (scriptDrawnPages.length) notes.push(`${listOf(scriptDrawnPages)} ${scriptDrawnPages.length === 1 ? "is" : "are"} empty until ${scriptDrawnPages.length === 1 ? "its" : "their"} scripts run, so ${scriptDrawnPages.length === 1 ? "it shows" : "they show"} in Preview but cannot be edited on the canvas.`);
  for (const duplicate of dropped) notes.push(`${duplicate.filePath} and ${duplicate.keptFilePath} are both the page at ${duplicate.path}; ${duplicate.keptFilePath} was kept.`);
  if (linksRewritten) notes.push(`${plural(linksRewritten, "link")} between pages now ${linksRewritten === 1 ? "points" : "point"} at the imported pages.`);
  if (bundle.files.length) notes.push(`${plural(bundle.files.length, "file")} the pages use ${bundle.files.length === 1 ? "was" : "were"} stored with the site (pictures as WebP).`);
  if (bundle.leftOut.length) notes.push(`${plural(bundle.leftOut.length, "file")} in the package ${bundle.leftOut.length === 1 ? "was" : "were"} left out because no page uses ${bundle.leftOut.length === 1 ? "it" : "them"}${build.freezes ? ", mostly the build's own scripts and data" : ""}: ${listOf(bundle.leftOut, 3)}.`);
  if (bundle.skipped.length) notes.push(`${plural(bundle.skipped.length, "file")} a page names could not be stored (not a kind of file a site can serve, or not readable as one): ${listOf(bundle.skipped)}.`);

  await prisma.siteAuditEvent.create({
    data: {
      siteId,
      kind: "PACKAGE_IMPORTED",
      summary: `Imported a ${analysis.isZip ? "ZIP package" : "page"} with ${plural(createdPages.length, "page")} and ${plural(bundle.files.length, "file")} (${build.label}${build.freezes ? ", frozen" : ""})`,
      actorName: req.dbUser?.name ?? "Website editor",
      actorId: req.dbUser?.id,
      detail: {
        pagesCount: createdPages.length,
        assetsCount: bundle.files.length,
        totalBytesAdded: totalBytes,
        build: build.kind,
        frozen: build.freezes,
        duplicatePages: dropped,
        linksRewritten,
        leftOutCount: bundle.leftOut.length,
        skipped: bundle.skipped,
        missingAssetsCount: analysis.missingAssets.length,
        missingAssets: analysis.missingAssets.slice(0, 50),
        externalResourcesCount: analysis.externalResources.length,
      },
    },
  });
  if (totalBytes) recordMediaStorageAdded(req, totalBytes);
  await recordImportUsed(req, siteId);

  return {
    siteId: site.id,
    siteName: site.name,
    pagesCount: createdPages.length,
    pages: createdPages,
    assetsCount: bundle.files.length,
    assets: [],
    missingAssets: analysis.missingAssets,
    externalResources: analysis.externalResources,
    warnings: analysis.warnings,
    totalBytesAdded: totalBytes,
    build: { kind: build.kind, label: build.label, frozen: build.freezes },
    duplicatePages: dropped,
    linksRewritten,
    interactions: { restored, unrestored: unrestored.slice(0, 50) },
    leftOut: { count: bundle.leftOut.length, examples: bundle.leftOut.slice(0, 10) },
    scriptDrawnPages,
    notes,
    sourcePackage: analysis.sourcePackage ?? null,
    autoBuilt: Boolean(analysis.autoBuilt),
  };
}
