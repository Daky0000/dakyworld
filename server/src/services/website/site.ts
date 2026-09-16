import { interactionCss } from "../../shared/websiteInteraction.js";
import { websiteAssetFiles } from "../websiteAssets.js";
import { randomBytes } from "node:crypto";
import { commitFiles, GitHubError, GitHubNotConfiguredError, githubConfigured, listRepoFiles, listTree, readFile, RepoNotAllowedError, withGithubCredential } from "../../lib/github.js";
import { siteGithubCredential } from "../githubApp.js";
import type { Site, SitePage } from "@prisma/client";
import type { SiteField } from "./regions.js";
import { attr, decodeEntities, parseHtml, walk } from "./parse.js";
import { applyHtmlEditsAsJsx, type HtmlFieldEdit } from "./jsx.js";
import { fetchWebsiteText } from "../../lib/websiteFetch.js";
import { invalidateSource, readCache, sourceKey, writeCache } from "./sourceCache.js";
import { detectFramework, isEditableSourcePath, type DiscoveredRoute, type SourceKind } from "./frameworks.js";
import { invalidateRender, renderRoute } from "./renderSource.js";
import { discoverRouterRoutes, routerCandidates } from "./router.js";

/**
 * Where a page's HTML comes from, and where an edited one goes.
 *
 * The repository is the source of truth. Nothing here keeps a copy of a page
 * between edits, and that is the point: the developer goes on working on these
 * files, and an editor holding its own copy would either overwrite that work or
 * quietly show a client a page that no longer exists.
 *
 * Reading has two routes and prefers the first:
 *
 *  1. **GitHub**, which is exact and immediate — it is the same commit the site
 *     will be built from, whether or not Pages has finished building it.
 *  2. **The live site over HTTP**, when no token is configured. Good enough to
 *     read and edit with, and it is the honest fallback rather than a blank
 *     screen: what it returns is what the public can see.
 *
 * Writing has one route. A publish is a commit, GitHub Pages rebuilds, and a
 * minute later the change is live. Without a token that can write, publishing
 * says so — it does not save a draft and call it published.
 */

/** A failure with a sentence written for the person who caused it. */
export class WebsiteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WebsiteError";
    this.status = status;
  }
}

/** `owner/name`, or null when the site has no repository configured. */
export function siteRepo(site: Pick<Site, "repoOwner" | "repoName">): string | null {
  return site.repoOwner && site.repoName ? `${site.repoOwner}/${site.repoName}` : null;
}

/** The file's path inside the repository, with the site's folder in front of it. */
export function repoFilePath(site: Pick<Site, "repoPath">, page: Pick<SitePage, "filePath">): string {
  const folder = site.repoPath.replace(/^\/+|\/+$/g, "");
  return folder ? `${folder}/${page.filePath}` : page.filePath;
}

/** The address a page is served at. */
export function pageUrl(site: Pick<Site, "publicUrl">, page: Pick<SitePage, "path">): string {
  return `${site.publicUrl.replace(/\/+$/, "")}${page.path === "/" ? "/" : page.path}`;
}

export type PageSource = {
  html: string;
  /**
   * Which route answered, so the editor can say where it is looking.
   *
   * The last three are a framework page: its file is not HTML, so what the
   * editor opens is what a build made of it — the export committed alongside
   * the source, a render service, or the published page. The difference matters
   * on screen, because only the first two are this commit.
   */
  from: "repository" | "live site" | "imported file" | "prerendered output" | "render service";
  /**
   * The source file the HTML was built from, for a framework page. Set means
   * "an edit here has to be written back as a change to this file", and the
   * publish path branches on it.
   */
  sourceFile?: string;
  detail?: string;
};

async function fetchLive(url: string): Promise<string> {
  try {
    return await fetchWebsiteText(url);
  } catch (err) {
    if (err instanceof WebsiteError) throw err;
    throw new WebsiteError(502, `Could not read the website. ${err instanceof Error ? err.message : "Check its public address and try again."}`);
  }
}

/**
 * The page as it stands right now, before any unpublished edits.
 *
 * `fresh` bypasses the cache and is **required** of anything that is about to
 * decide whether the page has moved under a draft. See `sourceCache.ts`: a
 * conflict check answered from a copy taken ninety seconds ago is not a conflict
 * check. Everything else — listing fields, rendering a preview, stamping an
 * autosave — is welcome to a slightly old page, because the worst it can produce
 * is a conflict that the publish path then catches properly.
 */
/**
 * Runs one piece of work under whichever GitHub credential this site should use.
 *
 * A site with a customer's own installation borrows an hour-long token scoped to
 * the repositories they chose; every other site carries on with the shared one.
 * Applied at the four doors that talk to GitHub rather than at each call inside
 * them, so a nested read during a commit inherits it without knowing — see
 * `withGithubCredential`.
 */
async function underSiteCredential<T>(site: Site, work: () => Promise<T>): Promise<T> {
  const credential = await siteGithubCredential(site);
  return credential ? withGithubCredential(credential, work) : work();
}

/**
 * A page's own file, read as bytes rather than as HTML.
 *
 * `pageSource` above answers "what is on this page", which for an HTML site is
 * the same question as "what is in this file". For a framework page it is not:
 * the file is `.tsx` or `.astro` and the page is what a build makes of it. This
 * is the file, for the source editor and for the framework view that sits
 * beside the live page.
 */
export async function pageFile(site: Site, page: SitePage): Promise<string | null> {
  const repo = siteRepo(site);
  if (!repo || !(await githubConfigured())) return null;
  return underSiteCredential(site, () => readFile(repo, repoFilePath(site, page), site.repoBranch).catch(() => null));
}

export async function pageSource(site: Site, page: SitePage, options: { fresh?: boolean } = {}): Promise<PageSource> {
  if (page.sourceHtml !== null && page.sourceHtml !== undefined) return { html: page.sourceHtml, from: "imported file" };
  return underSiteCredential(site, () => readPageSource(site, page, options));
}

async function readPageSource(site: Site, page: SitePage, options: { fresh?: boolean }): Promise<PageSource> {
  const repo = siteRepo(site);
  // A framework page's own file is source, not a page. What the editor opens is
  // the HTML a build made of it — see `renderSource.ts` — and everything the
  // editor does afterwards works on that unchanged. The one thing that changes
  // is what a publish writes, which is why the answer carries the file.
  if (isEditableSourcePath(page.filePath)) {
    const rendered = await renderRoute(site, page, { fresh: options.fresh });
    if (!rendered) {
      throw new WebsiteError(
        409,
        `${page.filePath} is built into a page rather than being one, and no built copy of ${page.path} could be found — no export committed to the repository, no render service configured, and the published page could not be read. Edit its text in the source editor, or publish the site once so this page has something to show.`,
      );
    }
    return { html: rendered.html, from: rendered.from, sourceFile: page.filePath, detail: rendered.detail };
  }
  const key = sourceKey({ siteId: site.id, repo, branch: site.repoBranch, filePath: page.filePath });
  if (!options.fresh) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  if (repo && (await githubConfigured())) {
    const html = await readFile(repo, repoFilePath(site, page), site.repoBranch).catch(() => null);
    if (html !== null) {
      const source: PageSource = { html, from: "repository" };
      writeCache(key, { html, from: "repository" });
      return source;
    }
    // A configured repository that does not have the file is worth saying out
    // loud rather than silently falling back to a live page that might be a
    // cached copy of something already deleted.
    throw new WebsiteError(
      404,
      `${repoFilePath(site, page)} is not in ${repo} on branch ${site.repoBranch}. It may have been renamed — remove the page here, or rescan the site.`,
    );
  }
  const live: PageSource = { html: await fetchLive(pageUrl(site, page)), from: "live site" };
  writeCache(key, { html: live.html, from: "live site" });
  return live;
}

/**
 * Every class the site's own stylesheet defines.
 *
 * One reason only: the button style menu. Read off the page alone, a menu can
 * offer a style the page already wears somewhere — which is always true, and on
 * a page whose buttons happen to be all one colour, is a menu of one. The
 * stylesheet is where the answer actually lives, and reading it turns "the
 * styles this page uses" into "the styles this site has".
 *
 * Everything about it degrades. No stylesheet linked, none reachable, none
 * parseable: the caller falls back to what the page itself is wearing, and the
 * *write* rule never consults this at all — `variantOf` is structural, so a
 * style is safe whether or not this succeeded. It is a menu, not a permission.
 *
 * Cached alongside pages, and read the same two ways: from the repository when
 * a token is configured, from the live site otherwise. A stylesheet on another
 * host is skipped rather than fetched — a font CDN is not this site's design
 * system, and fetching arbitrary URLs named in somebody's HTML is a door this
 * module has no reason to open.
 */
/**
 * The same-site stylesheets a page links to, as text.
 *
 * `siteStyleClasses` wanted the class names out of these; the site survey wants
 * the declarations, so the fetching is shared and the reading is not. The rules
 * about *which* files are fetched live here, once: same host only, because a
 * font CDN is not this site's design system and following arbitrary URLs out of
 * somebody's HTML is a door with no reason to open; and only the first few,
 * because a page linking eleven stylesheets is not a reason to make eleven
 * requests. A stylesheet that cannot be read is skipped, not raised — a palette
 * missing one file is still a palette.
 */
export function linkedStylesheetHrefs(html: string, limit = 3): string[] {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((tag) => /rel\s*=\s*["']?stylesheet/i.test(tag[0]))
    .map((tag) => /href\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1])
    .filter((href): href is string => Boolean(href))
    .filter((href) => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//"))
    .slice(0, limit);
}

/**
 * The limit is a caller's decision, because the two callers want different things.
 *
 * Three is right for the button style menu: it wants class names, and the first
 * few files have them. It is wrong for reading a site's design. Sites link their
 * cookie banner and their fonts before their own stylesheet — on Dakyworld's own
 * site the first three are consent.css, fonts.css and a 4 KB base, while the
 * design system is the 80 KB site.css that comes fourth. Asking for three files
 * and reporting the result as the site's palette is reporting a cookie banner's
 * palette.
 */
export async function siteStylesheets(site: Site, page: SitePage, html: string, limit = 3): Promise<Array<{ href: string; css: string }>> {
  const sheets: Array<{ href: string; css: string }> = [];
  for (const href of linkedStylesheetHrefs(html, limit)) {
    const css = await readStylesheet(site, page, href).catch(() => null);
    if (css) sheets.push({ href, css });
  }
  return sheets;
}

export async function siteStyleClasses(site: Site, page: SitePage, html: string): Promise<Set<string>> {
  const classes = new Set<string>();
  const hrefs = [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((tag) => /rel\s*=\s*["']?stylesheet/i.test(tag[0]))
    .map((tag) => /href\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1])
    .filter((href): href is string => Boolean(href))
    // Same site only, and only the first few: a page linking eleven
    // stylesheets is not a reason to make eleven requests every time somebody
    // opens it.
    .filter((href) => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//"))
    .slice(0, 3);

  for (const href of hrefs) {
    const css = await readStylesheet(site, page, href).catch(() => null);
    if (!css) continue;
    // Selectors only — the part before the `{`. A class name mentioned inside a
    // declaration is not a class this site defines.
    for (const rule of css.split("{")) {
      const selector = rule.slice(rule.lastIndexOf("}") + 1);
      for (const match of selector.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) classes.add(match[1]!);
    }
  }
  return classes;
}

async function readStylesheet(site: Site, page: SitePage, href: string): Promise<string | null> {
  // Resolved against the page, so `assets/site.css` beside `about.html` and
  // `/assets/site.css` both land in the same place.
  const filePath = href.startsWith("/")
    ? href.slice(1).split(/[?#]/)[0]!
    : new URL(href, `https://x/${page.filePath}`).pathname.slice(1).split(/[?#]/)[0]!;
  if (!filePath || filePath.includes("..")) return null;

  const repo = siteRepo(site);
  const key = sourceKey({ siteId: site.id, repo, branch: site.repoBranch, filePath });
  const cached = readCache(key);
  if (cached) return cached.html;

  if (repo && (await underSiteCredential(site, githubConfigured))) {
    const css = await underSiteCredential(site, () => readFile(repo, repoFilePath(site, { filePath }), site.repoBranch).catch(() => null));
    if (css !== null) {
      writeCache(key, { html: css, from: "repository" });
      return css;
    }
    return null;
  }
  const css = await fetchLive(`${site.publicUrl.replace(/\/+$/, "")}/${filePath}`);
  writeCache(key, { html: css, from: "live site" });
  return css;
}

/** `about.html` → `/about`, `index.html` → `/`. The site serves extensionless paths. */
export function pathFromFile(filePath: string): string {
  const name = filePath.replace(/\.html$/i, "");
  if (name === "index") return "/";
  return `/${name}`;
}

/** `how-we-work.html` → `How we work`. A starting name, not a permanent one. */
export function titleFromFile(filePath: string): string {
  const name = filePath.replace(/\.html$/i, "").replace(/[-_]+/g, " ").trim();
  if (!name || name === "index") return "Home";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export type DiscoveredPage = {
  filePath: string;
  path: string;
  title: string;
  /** In the site's own sitemap, and so a page the public is meant to find. */
  listed: boolean;
};

/** The paths a site publishes, read from its sitemap. Empty when it has none. */
async function sitemapPaths(site: Site): Promise<Set<string>> {
  const paths = new Set<string>();
  try {
    const xml = await fetchLive(`${site.publicUrl.replace(/\/+$/, "")}/sitemap.xml`);
    for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      try {
        const url = new URL(match[1]!.trim());
        paths.add(url.pathname.replace(/\/$/, "") || "/");
      } catch {
        // A malformed <loc> is the sitemap's problem, not this scan's.
      }
    }
  } catch {
    // No sitemap is normal for a small site. Every page is simply unlisted.
  }
  return paths;
}

export type Discovery = {
  pages: DiscoveredPage[];
  /**
   * The folder the pages were actually read from, relative to the repository
   * root. Usually the site's configured `repoPath`; different when the search
   * below found them somewhere else, in which case the caller should save it —
   * a publish writes to `repoPath`, so a scan that read one folder and a
   * publish that writes to another would commit a page into the wrong place.
   */
  repoPath: string;
  /**
   * The framework whose pages these are, or null for plain HTML.
   *
   * Saved on the site by the scan, because every screen after it has to know:
   * a Next route is opened in the source editor, an `.html` page in the visual
   * one, and a page list that cannot tell them apart sends people to an editor
   * that cannot read the file it was given.
   */
  sourceKind: SourceKind | null;
};

/**
 * Finds the pages a site has.
 *
 * From the repository where one is configured, because that is the complete
 * list — including a page nobody has linked to yet. From the sitemap otherwise,
 * which is the only list a static site publishes about itself.
 *
 * A file that the sitemap does not mention is still discovered, but arrives
 * hidden. That is how the plan document and the 404 page stay out of a client's
 * page list without anybody having to name them here: the site itself already
 * says which files are pages, and this listens to it.
 */
export async function discoverPages(site: Site): Promise<Discovery> {
  return underSiteCredential(site, () => findPages(site));
}

/** Folders whose HTML is never the site: dependencies, tooling, build scratch. */
const IGNORED_FOLDERS = /(^|\/)(node_modules|\.git|\.github|\.next|\.cache|vendor|coverage|__tests__|tests?|examples?|storybook-static)(\/|$)/i;

/** Folder names that hold copies of pages rather than the pages themselves. */
const ARCHIVE_FOLDERS = /(^|\/)(drafts?|website-drafts|archive[ds]?|backups?|old|deprecated|templates?|partials?|includes?|components?|fragments?|emails?)(\/|$)/i;

/**
 * Works out which folder of a repository holds the site.
 *
 * Somebody connecting a repository knows the repository; they do not
 * necessarily know that this one keeps its pages in `public/` and the last one
 * kept them at the root. Rather than making that a setting they have to get
 * right before anything works, the scan looks.
 *
 * Every folder holding top-level `.html` files is a candidate, scored on what
 * actually distinguishes a site's page folder from a folder that happens to
 * contain HTML: it has an `index.html`, it has several pages, it is near the
 * root, and it is not called `drafts`. The best-scoring folder wins; a tie goes
 * to the shallower one.
 *
 * Returns null when the repository holds no HTML at all — a Next or Astro
 * project, say — because there is nothing here this editor can open.
 */
function chooseSiteFolder(files: string[]): string | null {
  const byFolder = new Map<string, string[]>();
  for (const file of files) {
    if (!/\.html$/i.test(file) || IGNORED_FOLDERS.test(file)) continue;
    const cut = file.lastIndexOf("/");
    const folder = cut === -1 ? "" : file.slice(0, cut);
    const name = cut === -1 ? file : file.slice(cut + 1);
    if (name.startsWith(".")) continue;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), name]);
  }
  if (byFolder.size === 0) return null;

  let best: { folder: string; score: number } | null = null;
  for (const [folder, names] of byFolder) {
    const depth = folder === "" ? 0 : folder.split("/").length;
    let score = Math.min(names.length, 12);
    if (names.some((name) => /^index\.html$/i.test(name))) score += 10;
    // A folder named after where a static site is built or served from is a
    // stronger signal than its file count: `public/` with one page beats a
    // `docs/` folder with four notes in it.
    if (/(^|\/)(public|site|www|dist|build|docs|_site|out)$/i.test(folder)) score += 4;
    if (ARCHIVE_FOLDERS.test(folder)) score -= 12;
    score -= depth * 2;
    if (!best || score > best.score || (score === best.score && depth < (best.folder === "" ? 0 : best.folder.split("/").length))) {
      best = { folder, score };
    }
  }
  return best ? best.folder : null;
}

async function findPages(site: Site): Promise<Discovery> {
  const listed = await sitemapPaths(site);
  const repo = siteRepo(site);

  if (repo && (await githubConfigured())) {
    const configured = site.repoPath.replace(/^\/+|\/+$/g, "");
    const fromConfigured = await htmlIn(repo, configured, site.repoBranch);
    if (fromConfigured.length > 0) return { pages: buildPages(fromConfigured, listed), repoPath: configured, sourceKind: null };

    // Nothing where the site says its pages are. Before reporting an empty
    // site, look for them: see `chooseSiteFolder`.
    const { files, truncated } = await listRepoFiles(repo, site.repoBranch);

    // A framework project has no `.html` to find and never will until it is
    // built. Its pages are its route files, so ask the registry which framework
    // this is and let it map them — see `frameworks.ts`.
    const framework = truncated ? null : detectFramework(files);
    if (framework) {
      const pages = framework.readsRouteTable
        ? await routeTablePages(repo, site.repoBranch, files, listed, framework.routes(files, listed))
        : framework.routes(files, listed);
      // Route files are addressed from the repository root, not from a page
      // folder: `app/blog/page.tsx` means that path and no other. Anything else
      // would have a publish write the file into the folder the HTML editor
      // happened to settle on.
      if (pages.length) return { pages, repoPath: "", sourceKind: framework.sourceKind };
    }

    const found = chooseSiteFolder(files);
    if (found === null) {
      throw new WebsiteError(
        422,
        truncated
          ? `${repo} is too large to search from here. Set the folder its pages are in under the site's settings.`
          : `${repo} has no HTML pages on branch ${site.repoBranch}${configured ? ` — and nothing in ${configured}` : ""}. The editor works on .html files, so a site built by a framework has to be built before it can be edited here.`,
      );
    }
    const names = await htmlIn(repo, found, site.repoBranch);
    return { pages: buildPages(names, listed), repoPath: found, sourceKind: null };
  }

  if (listed.size === 0) {
    throw new WebsiteError(
      424,
      `Could not work out which pages ${site.publicUrl} has. Connect the repository under Settings → Developer, or publish a sitemap.xml.`,
    );
  }

  return {
    repoPath: site.repoPath,
    sourceKind: null,
    pages: [...listed]
      .map((path) => {
        const filePath = path === "/" ? "index.html" : `${path.replace(/^\//, "")}.html`;
        return { filePath, path, title: titleFromFile(filePath), listed: true };
      })
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/**
 * The pages a single-page app declares in code, merged with what its folders say.
 *
 * This is the shape every AI builder ships: one `App.tsx` holding a route table,
 * and a file tree that mentions one page. Reading the table is the difference
 * between a customer seeing their nine pages and seeing one — so it is worth the
 * two or three extra reads, and it is capped at that.
 *
 * The file list still wins where the two disagree about a file, because a route
 * whose element is written inline genuinely lives in the router file, and a
 * `src/pages/About.tsx` that the table also names is the same page either way.
 */
async function routeTablePages(repo: string, branch: string, files: string[], listed: Set<string>, fromFiles: DiscoveredRoute[]): Promise<DiscoveredRoute[]> {
  const byPath = new Map(fromFiles.map((page) => [page.path, page]));
  for (const candidate of routerCandidates(files)) {
    const source = await readFile(repo, candidate, branch).catch(() => null);
    if (source === null) continue;
    const routes = discoverRouterRoutes(source, candidate, files, listed);
    for (const route of routes) {
      const already = byPath.get(route.path);
      // A route the file tree already found keeps its file; the table may still
      // be the only thing that knows the page is called "Pricing".
      if (already) byPath.set(route.path, { ...already, title: already.title === "Home" ? already.title : route.title });
      else byPath.set(route.path, route);
    }
    // One file answered with a real table. Reading the next two would only add
    // the same routes again, or a second app's.
    if (routes.length > 1) break;
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The `.html` files directly inside one folder of the repository. */
async function htmlIn(repo: string, folder: string, branch: string): Promise<string[]> {
  const tree = await listTree(repo, folder, branch);
  return tree
    .filter((entry) => entry.type === "blob" || entry.type === "file")
    .map((entry) => (folder ? entry.path.slice(folder.length + 1) : entry.path))
    // Top level only. A file in a subfolder is an asset or an archive of old
    // work — `website-drafts/` on this site is exactly that.
    .filter((relative) => /\.html$/i.test(relative) && !relative.includes("/"));
}

function buildPages(names: string[], listed: Set<string>): DiscoveredPage[] {
  return names
    .map((relative) => ({
      filePath: relative,
      path: pathFromFile(relative),
      title: titleFromFile(relative),
      listed: listed.has(pathFromFile(relative)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Writes an edited page back to the repository.
 *
 * One file, one commit, on the branch the site is built from. GitHub Pages
 * notices and rebuilds; the change is live within a minute or two.
 *
 * The two ways this refuses are both configuration, and both say what to do:
 * no token at all, and a token whose repository has not been added to the
 * writable list. Neither is a bug and neither should read like one.
 */
export async function publishPage(input: {
  site: Site;
  page: SitePage;
  html: string;
  message: string;
  expectedSource?: string;
}): Promise<{ sha: string; url: string }> {
  return publishPages({
    site: input.site,
    message: input.message,
    pages: [{ page: input.page, html: input.html, expectedSource: input.expectedSource }],
  });
}

/**
 * The same, for a change that belongs to several pages at once.
 *
 * One commit, not one per page. A shared element edited once and landing on
 * seven pages is one change to the website, and committing it seven times would
 * make it seven — reviewable as seven, revertable as seven, and capable of
 * being half-done if the fourth request fails. Every affected file's expected
 * content goes with it, so GitHub refuses the whole commit if any one of them
 * moved underneath the review.
 */
/**
 * What GitHub refused, said to the person who can fix it.
 *
 * One function rather than a block inside each publish path: every one of these
 * is a setting on a token or a repository, and left as a raw `GitHubError` they
 * all arrive as "Something went wrong", which sends somebody hunting for a bug
 * that is not there. A second publish path with its own half of this list would
 * be the same defect again, one branch along.
 */
export function githubFailure(err: unknown, repo: string, branch: string): unknown {
  if (err instanceof GitHubNotConfiguredError) {
    return new WebsiteError(503, "Publishing needs a GitHub token with permission to write to the website's repository. Add one under Settings → Developer.");
  }
  if (err instanceof RepoNotAllowedError) {
    return new WebsiteError(403, `${repo} is not on the list of repositories this system may write to. Add it under Settings → Developer, then publish again.`);
  }
  if (err instanceof GitHubError) {
    if (err.status === 401) return new WebsiteError(403, "GitHub rejected the access token — it has expired or been revoked. Create a new one and paste it under Settings → Developer.");
    if (err.status === 403) return new WebsiteError(403, `The GitHub token cannot write to ${repo}. Give it Contents: write on that repository — a fine-grained token must also list ${repo} among the repositories it can reach — then publish again.`);
    if (err.status === 404) return new WebsiteError(404, `GitHub cannot find ${repo} on branch ${branch}, or the token cannot see it. Check the repository and branch on the site's settings, and that the token has access to it.`);
    if (err.status === 409 || err.status === 422) return new WebsiteError(409, `GitHub would not accept the commit to ${branch}: ${err.message}. A branch protection rule is the usual cause.`);
    return new WebsiteError(502, `GitHub would not accept the publish: ${err.message}`);
  }
  return err;
}

/**
 * A framework page: the edits made against the rendered page, written into the
 * file that page was built from.
 *
 * The rendered HTML is output. Committing it would put a file in the repository
 * that the next build overwrites, beside a source file that still says the old
 * thing — so what is committed is the source, with the edited literals in it,
 * and the rendered page catches up when the host rebuilds.
 *
 * The refusal is the important part. An edit that cannot be traced back to a
 * literal — a style, a moved section, a heading built by code — fails the whole
 * publish and names what it was. A publish that wrote the parts it understood
 * and dropped the rest would be a page that is half of what somebody approved,
 * reported as a success.
 */
export async function publishSourcePage(input: {
  site: Site;
  page: SitePage;
  /** The draft as the editor keeps it: values keyed by the rendered page's fields. */
  values: Record<string, HtmlFieldEdit>;
  /** The rendered HTML those edits were made against. */
  html: string;
  author: string;
  changed: number;
}): Promise<{ sha: string; url: string }> {
  const repo = siteRepo(input.site);
  if (!repo) throw new WebsiteError(409, "Connect this site's GitHub repository in Website settings before publishing.");
  return underSiteCredential(input.site, async () => {
    const current = await readFile(repo, repoFilePath(input.site, input.page), input.site.repoBranch).catch(() => null);
    if (current === null) {
      throw new WebsiteError(404, `${repoFilePath(input.site, input.page)} is not in ${repo} on branch ${input.site.repoBranch}. Rescan the site so its page list matches the repository.`);
    }
    const written = applyHtmlEditsAsJsx({ source: current, filePath: input.page.filePath, html: input.html, edits: input.values });
    if (written.unmappable.length) {
      throw Object.assign(
        new WebsiteError(400, `Some of these changes are written by this page's code rather than by its text, so nothing was published: ${written.unmappable.map((entry) => entry.message).join(" ")}`),
        { unmappable: written.unmappable },
      );
    }
    if (written.problems.length) {
      const stale = written.problems.some((problem) => problem.code === "stale");
      throw new WebsiteError(stale ? 409 : 400, written.problems.map((problem) => problem.message).join(" "));
    }
    try {
      const commit = await commitFiles({
        repo,
        branch: input.site.repoBranch,
        message: `Website: ${input.changed} change${input.changed === 1 ? "" : "s"} on ${input.page.path} (${input.author})`,
        // Guarded against the file as it is this second, so a developer editing
        // the same component while somebody edits its words loses nothing.
        expectedFiles: [{ path: repoFilePath(input.site, input.page), content: current }],
        files: [{ path: repoFilePath(input.site, input.page), content: written.source }],
      });
      invalidateSource(input.site.id, input.page.filePath);
      invalidateRender(input.site, input.page);
      return commit;
    } catch (err) {
      throw githubFailure(err, repo, input.site.repoBranch);
    }
  });
}

/**
 * Every column of a page except the one that holds a whole website.
 *
 * `SitePage.sourceHtml` is the entire file for an *imported* page — up to 2 MB,
 * and that is the path a site built in Lovable or Bolt arrives through. It is
 * null for a repository-connected site, which is why listing forty pages felt
 * free right up until the first customer who pasted their HTML in.
 *
 * Use this for a query whose rows are *listed*, and not for one whose rows are
 * then handed to `pageSource` — which returns `sourceHtml` directly when a page
 * has one, so stripping the column there would silently send an imported page
 * off to read a repository it does not have. That rules out the onboarding,
 * readiness, survey and shared-element sweeps, every one of which loads pages
 * in order to read them; they are not being wasteful, they are paying for the
 * thing they are about to use.
 *
 * What is left is the two that genuinely only list: the page table, and the
 * scan's comparison of what it already knows about. Named rather than spelled
 * out per query for the reason `MESSAGE_FIELDS` in routes/inbox.ts is — a
 * column you must not select is a rule, and a rule is worth one name.
 */
/** A page as everything that lists them sees it: all of it but the file. */
export type SitePageSummary = Omit<SitePage, "sourceHtml">;

export const PAGE_LIST_FIELDS = {
  id: true, siteId: true, title: true, path: true, filePath: true, status: true,
  sortOrder: true, draft: true, draftRevision: true, draftSavedAt: true,
  draftSavedById: true, lastPublishedAt: true, createdAt: true, updatedAt: true,
} as const;

export async function publishPages(input: {
  site: Site;
  message: string;
  pages: Array<{ page: SitePage; html: string; expectedSource?: string }>;
}): Promise<{ sha: string; url: string }> {
  const repo = siteRepo(input.site);
  if (!repo) {
    throw new WebsiteError(
      409,
      `${input.site.name} has no repository connected, so there is nowhere to publish to. Add one on the site's settings before publishing.`,
    );
  }
  // Asked before the commit, because `commitFiles` checks the writable-repository
  // list first and would answer "add it to the list" to somebody who has not
  // connected GitHub at all. An error should name the first thing that is
  // missing, not the second.
  if (!(await githubConfigured())) {
    throw new WebsiteError(
      503,
      "Publishing needs a GitHub token with permission to write to the website's repository. Add one under Settings → Developer.",
    );
  }
  if (!input.pages.length) throw new WebsiteError(400, "There are no pages to publish.");

  return underSiteCredential(input.site, async () => {
  try {
    // One pass over the whole commit, not one per page.
    //
    // This was `Promise.all(pages.map(...))`, and each of those calls loaded
    // every image on the site. Ten pages meant ten concurrent copies of the
    // entire asset library in memory to publish one change — the shape that
    // has taken this service down before. The pages are joined first and the
    // assets resolved once against all of them, which also removes the
    // de-duplication that only existed because the same file arrived N times.
    const assets = await websiteAssetFiles(input.site, input.pages.map((entry) => entry.html).join(" "));
    const files = [
      ...input.pages.map((entry) => ({ path: repoFilePath(input.site, entry.page), content: entry.html })),
      ...assets,
    ];
    const expected = input.pages
      .filter((entry) => entry.expectedSource !== undefined)
      .map((entry) => ({ path: repoFilePath(input.site, entry.page), content: entry.expectedSource!, allowMissing: entry.page.sourceHtml !== null }));

    const commit = await commitFiles({
      repo,
      branch: input.site.repoBranch,
      message: input.message,
      expectedFiles: expected.length ? expected : undefined,
      files,
    });
    // Here rather than at the call site, so that a second publisher — a rollback,
    // a site-wide publish, an agent — cannot forget it. Until this runs, every
    // read is answering from the version before the commit, and the reload meant
    // to confirm the publish shows the page unchanged.
    for (const entry of input.pages) invalidateSource(input.site.id, entry.page.filePath);
    return commit;
  } catch (err) {
    throw githubFailure(err, repo, input.site.repoBranch);
  }
  });
}

export type PreviewDocument = { html: string; csp: string };

/** Isolated rendering of the original HTML, with only the editor's picker allowed to run. */
export function previewDocument(html: string, baseUrl: string, editable?: SiteField[], allowEditing = true): PreviewDocument {
  const policy = ["default-src 'none'", "sandbox allow-scripts allow-same-origin", "base-uri http: https:", "img-src 'self' data: blob: http: https:", "style-src 'self' 'unsafe-inline' http: https:", "font-src 'self' data: http: https:", "media-src http: https: data:", "script-src 'none'", "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "frame-ancestors 'self'", "form-action 'none'"].join("; ");
  // Apply the original offsets first, then parse again before removing tags.
  let out = editable?.length ? markEditable(html, editable) : html;
  const removed = [...walk(parseHtml(out))].filter(node => node.tag === "base" || (node.tag === "meta" && ["refresh", "content-security-policy"].includes(decodeEntities(attr(node, "http-equiv") ?? "").trim().toLowerCase())));
  for (const node of removed.sort((a, b) => b.start - a.start)) out = out.slice(0, node.start) + out.slice(node.end);
  // A document URL preserves relative asset paths on nested pages. A bare
  // origin still resolves to /, preserving the old caller contract.
  const base = '<base href="' + new URL(baseUrl).href.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") + '">';
  const head = [...walk(parseHtml(out))].find(node => node.tag === "head");
  out = head ? out.slice(0, head.innerStart) + base + out.slice(head.innerStart) : base + out;
  const interactionHead = [...walk(parseHtml(out))].find(node => node.tag === "head");
  const interactionAt = interactionHead?.innerEnd ?? out.length;
  out = out.slice(0, interactionAt) + `<style data-dw-interaction-preview>${interactionCss(true)}</style>` + out.slice(interactionAt);
  if (!editable?.length) return { html: out, csp: policy };
  const nonce = randomBytes(16).toString("base64");
  // Parsed closing offsets avoid matching a fake </body> inside a script/string.
  const body = [...walk(parseHtml(out))].find(node => node.tag === "body");
  const at = body?.innerEnd ?? out.length;
  out = out.slice(0, at) + pickerAssets(nonce, allowEditing) + out.slice(at);
  return { html: out, csp: policy.replace("script-src 'none'", "script-src 'nonce-" + nonce + "'") + "; style-src-attr 'unsafe-inline'" };
}

/**
 * Names every editable element in the page, so a click in the preview can say
 * which field it landed on.
 *
 * Written as a splice at the offsets the parse already recorded rather than
 * matched in the browser: the ids are positional, and anything that recomputed
 * them on the other side of the frame would be a second implementation of
 * `readPage` that has to agree with the first for ever.
 */
function markEditable(html: string, fields: SiteField[]): string {
  const marks = fields
    .filter((field) => field.attrInsert !== undefined)
    .map((field) => ({ at: field.markerSpan?.start ?? field.attrInsert as number, end: field.markerSpan?.end ?? field.attrInsert as number, id: field.id, kind: field.kind, readOnly: field.previewReadOnly }))
    // Backwards, so each insert leaves the earlier offsets valid.
    .sort((a, b) => b.at - a.at);

  let out = html;
  for (const mark of marks) {
    out = `${out.slice(0, mark.at)} data-dw-field="${mark.id.replace(/"/g, "&quot;")}" data-dw-kind="${mark.kind}"${mark.readOnly ? ' data-dw-readonly="true"' : ""}${out.slice(mark.end)}`;
  }
  return out;
}

/**
 * Click to select, double click to type, and nothing else.
 *
 * Deliberately no library behind it. What a person wants from a visual editor
 * is to point at the thing they mean; the drag-and-drop layout builders that
 * word usually implies need a component model the page does not have, and would
 * turn a hand-written site into something only the builder can open.
 *
 * Three channels back to the editor, and the split matters:
 *
 *  - `select` says which field was clicked. The panel follows the page.
 *  - `text` carries what is being typed, straight out of the element it is
 *    being typed into. Editing happens on the page, in place, at the real size
 *    and in the real typeface — the panel's own box is the fallback, not the
 *    main way in.
 *  - `style` comes the other way: the panel writes the element's inline style
 *    live so a change is visible while the slider is still moving, instead of
 *    only after the draft saves and the frame reloads.
 *
 * Only text, richtext, link and button fields can be typed into. A picture is
 * changed by address, in the panel, because there is nothing to type into it.
 *
 * Navigation is stopped for the same reason `form-action` is `'none'`: a click
 * on a link in a preview should select the link, not leave the page.
 */
function pickerAssets(nonce: string, allowEditing: boolean): string {
  return `
<style nonce="${nonce}">
  [data-dw-field] { cursor: pointer; }
  [data-dw-field]:hover { outline: 2px dashed rgba(49,87,255,.55); outline-offset: 2px; }
  [data-dw-selected] { outline: 2px solid #3157FF !important; outline-offset: 2px; background: rgba(49,87,255,.06); }
  [data-dw-editing] { cursor: text !important; outline: 2px solid #3157FF !important; outline-offset: 2px; background: rgba(49,87,255,.10); }
  [data-dw-editing]:hover { outline-style: solid !important; }
  [data-dw-shown] { opacity: 1 !important; transform: none !important; filter: none !important; }
</style>
<script nonce="${nonce}">
(function () {
  var selected = null;
  var editing = null;
  var timer = null;

  function post(message) {
    message.source = "dakyworld-preview";
    parent.postMessage(message, "*");
  }
  function find(id) {
    return id ? document.querySelector('[data-dw-field="' + String(id).replace(/"/g, "") + '"]') : null;
  }
  function mark(el) {
    if (selected && selected !== el) selected.removeAttribute("data-dw-selected");
    selected = el;
    if (el) el.setAttribute("data-dw-selected", "");
  }
  // A picture has nothing to type into; its address is changed in the panel.
  // A button's words are typed on the page like any other words — its style and
  // its destination are the parts that live in the panel.
  function typeable(el) {
    if (el.hasAttribute("data-dw-readonly")) return false;
    var kind = el.getAttribute("data-dw-kind");
    return kind === "text" || kind === "richtext" || kind === "link" || kind === "button";
  }
  // Never the element's own innerHTML: it carries the attributes this script
  // put on its children, and a data-* attribute survives sanitising on purpose
  // (the homepage figures are data-target). Handing them back would commit the
  // editor's scaffolding into the published page.
  var OURS = ["data-dw-field", "data-dw-kind", "data-dw-readonly", "data-dw-shown", "data-dw-selected", "data-dw-editing", "data-dw-state-preview"];
  function words(el) {
    var copy = el.cloneNode(true);
    var marked = copy.querySelectorAll("[" + OURS.join("],[") + "]");
    for (var i = 0; i < marked.length; i++) {
      for (var j = 0; j < OURS.length; j++) marked[i].removeAttribute(OURS[j]);
    }
    return copy.innerHTML;
  }
  function push(final) {
    if (!editing) return;
    post({ type: "text", id: editing.getAttribute("data-dw-field"), html: words(editing), final: !!final });
  }
  function startEdit(el) {
    if (!${allowEditing}) return;
    if (!el || !typeable(el) || editing === el) return;
    stopEdit();
    editing = el;
    el.setAttribute("contenteditable", "true");
    el.setAttribute("data-dw-editing", "");
    el.focus();
    post({ type: "editing", id: el.getAttribute("data-dw-field") });
  }
  function stopEdit() {
    if (!editing) return;
    clearTimeout(timer);
    push(true);
    var was = editing;
    editing = null;
    was.removeAttribute("contenteditable");
    was.removeAttribute("data-dw-editing");
    was.blur();
    post({ type: "editing", id: null });
  }

  document.addEventListener("click", function (event) {
    var el = event.target && event.target.closest ? event.target.closest("[data-dw-field]") : null;
    // While typing, a click inside the same element is the caret being placed.
    if (editing && el === editing) return;
    // A click on nothing in particular clears the selection rather than
    // leaving the panel describing something the eye has moved on from.
    event.preventDefault();
    event.stopPropagation();
    stopEdit();
    mark(el);
    post({ type: "select", id: el ? el.getAttribute("data-dw-field") : null });
  }, true);

  document.addEventListener("dblclick", function (event) {
    var el = event.target && event.target.closest ? event.target.closest("[data-dw-field]") : null;
    if (!el || !typeable(el)) return;
    event.preventDefault();
    event.stopPropagation();
    mark(el);
    post({ type: "select", id: el.getAttribute("data-dw-field") });
    startEdit(el);
  }, true);

  document.addEventListener("input", function () {
    if (!editing) return;
    clearTimeout(timer);
    timer = setTimeout(function () { push(false); }, 250);
  }, true);

  document.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && ["s", "z", "Z", "y", "Y", "Enter"].indexOf(event.key) !== -1) {
      event.preventDefault(); stopEdit();
      parent.postMessage({ source: "dakyworld-preview", type: "shortcut", key: event.key, shiftKey: event.shiftKey }, location.origin);
      return;
    }
    if (!editing) return;
    if (event.key === "Escape") { event.preventDefault(); stopEdit(); return; }
    // Lines within an element, not new paragraphs — the browser's default here
    // is a <div>, which would put a block inside a heading.
    if (event.key === "Enter") { event.preventDefault(); document.execCommand("insertLineBreak"); }
  }, true);

  document.addEventListener("paste", function (event) {
    if (!editing) return;
    // Pasting out of a word processor brings its markup with it. The words are
    // what somebody meant to paste.
    event.preventDefault();
    var text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
    document.execCommand("insertText", false, text);
  }, true);

  // A page whose sections fade in as you scroll shows almost nothing in a
  // frame that has never been scrolled, and nobody can click a heading they
  // cannot see. Sweep the page once so every IntersectionObserver fires the
  // way it would for a reader, then force anything still invisible.
  //
  // Only here, never in the plain Preview: that one is meant to be the page
  // exactly as a visitor gets it, animations and all.
  function force() {
    var fields = document.querySelectorAll("[data-dw-field]");
    for (var i = 0; i < fields.length; i++) {
      var node = fields[i];
      while (node && node !== document.body) {
        if (!node.hasAttribute("data-dw-shown")) {
          var style = window.getComputedStyle(node);
          // Something the page means to keep hidden — a closed menu, a tab
          // nobody is on — has no box and stays hidden.
          if (style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity) < 0.1) {
            node.setAttribute("data-dw-shown", "");
          }
        }
        node = node.parentElement;
      }
    }
  }
  var swept = false;
  function sweep() {
    if (swept) return;
    swept = true;
    var height = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    var step = Math.max(240, Math.round(window.innerHeight * 0.8));
    // Put the page back where it was, not at the top: by the time this runs the
    // editor may already have scrolled to something that was clicked.
    var was = window.scrollY || 0;
    var at = 0;
    (function next() {
      window.scrollTo(0, at);
      at += step;
      if (at < height + step) window.requestAnimationFrame(next);
      else {
        window.scrollTo(0, was);
        window.setTimeout(force, 80);
      }
    })();
  }
  if (document.readyState === "complete") window.setTimeout(sweep, 120);
  else window.addEventListener("load", function () { window.setTimeout(sweep, 120); });

  window.addEventListener("message", function (event) {
    var data = event.data || {};
    if (event.source !== parent || event.origin !== location.origin || data.source !== "dakyworld-editor") return;
    if (data.type === "reveal") { sweep(); return; }
    if (data.type === "select") {
      stopEdit();
      var el = find(data.id);
      if (!el && data.id) post({ type: "absent", id: data.id, want: "select" });
      mark(el);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (data.type === "edit") {
      var target = find(data.id);
      if (target) { mark(target); startEdit(target); }
    } else if (data.type === "stopEdit") {
      stopEdit();
    } else if (data.type === "style") {
      // The whole inline style, because that is what the panel edits — including
      // the declarations it has no control for, which ride through untouched.
      var styled = find(data.id);
      // Nothing to write it on: say so, rather than letting the change vanish.
      if (!styled) { post({ type: "absent", id: data.id, want: "style" }); return; }
      if (data.style) styled.setAttribute("style", String(data.style));
      else styled.removeAttribute("style");
      post({ type: "applied", id: data.id, want: "style" });
    } else if (data.type === "responsive") {
      var responsiveElement = find(data.id);
      if (!responsiveElement) { post({ type: "absent", id: data.id, want: "responsive" }); return; }
      responsiveElement.removeAttribute("data-dw-style");
      var sheets = document.querySelectorAll("style[data-dw-responsive-preview]");
      var sheet = null;
      for (var s = 0; s < sheets.length; s++) if (sheets[s].getAttribute("data-dw-responsive-preview") === data.id) sheet = sheets[s];
      if (!data.css) { if (sheet) sheet.remove(); }
      else {
        if (!sheet) { sheet = document.createElement("style"); sheet.setAttribute("data-dw-responsive-preview", data.id); (document.head || document.body).appendChild(sheet); }
        sheet.textContent = String(data.css);
      }
      post({ type: "applied", id: data.id, want: "responsive" });
    } else if (data.type === "image") {
      var picture = find(data.id);
      if (!picture) { post({ type: "absent", id: data.id, want: "image" }); return; }
      picture.setAttribute("src", String(data.src || ""));
      picture.removeAttribute("srcset");
      post({ type: "applied", id: data.id, want: "image" });
    } else if (data.type === "text") {
      var written = find(data.id);
      if (!written) { post({ type: "absent", id: data.id, want: "text" }); return; }
      // Never while it is being typed into: that would move the caret.
      if (written !== editing) written.innerHTML = String(data.html == null ? "" : data.html);
      post({ type: "applied", id: data.id, want: "text" });
    } else if (data.type === "variant") {
      // A button's style, swapped here as well as in the draft. Without this a
      // colour change shows nothing until the autosave and the reload behind
      // it, which is a second or two of an editor that looks broken — the same
      // reason a style change is pushed rather than waited for. (No backticks
      // in here: this whole script is a template literal.)
      //
      // One token out, one token in, and every other class left exactly as the
      // developer wrote it. The editor sends both halves because it is the side
      // that knows which token is the style: reading it back off the element
      // would be a second implementation of that rule, in a different language,
      // that has to agree with the first for ever.
      var restyled = find(data.id);
      if (!restyled) { post({ type: "absent", id: data.id, want: "variant" }); return; }
      if (data.from) restyled.classList.remove(String(data.from));
      if (data.to) restyled.classList.add(String(data.to));
      post({ type: "applied", id: data.id, want: "variant" });
    }
  });
  // Announced after the listener above exists, and again on load, because an
  // editor that pushed before this point would have pushed into nothing.
  post({ type: "ready" });
  if (document.readyState !== "complete") window.addEventListener("load", function () { post({ type: "ready" }); });
})();
</script>`;
}
