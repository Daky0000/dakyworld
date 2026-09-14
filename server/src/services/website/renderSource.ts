/**
 * The HTML a framework page actually is, so the visual editor can open it.
 *
 * The editor's whole model is "what you see is the bytes we write". A framework
 * page breaks that in one place only: the bytes are a `.tsx`, and what a person
 * sees is what a build made of it. Give the editor that built HTML and every
 * part of it works again — fields, layers, the picker, responsive styles — and
 * the only new contract is that each edit has to trace back to a literal in the
 * source. That tracing is `jsx.ts`'s job; getting the HTML is this file's.
 *
 * **Nothing here runs the customer's project, and that is deliberate.**
 * `npm install && next build` on a connected repository is remote code
 * execution with our database credentials in the environment: an `npm` lifecycle
 * script in any transitive dependency runs as us, on our box, before a single
 * line of their app is even compiled. Sandboxing that properly means a
 * throwaway container with no network, no secrets and a hard timeout, which is
 * infrastructure rather than a function — so it is a seam here, switched on by
 * `WEBSITE_RENDER_URL`, and off unless somebody has built it.
 *
 * What is left is enough for almost every real site, in order:
 *
 *  1. **Prerendered output committed to the repository** — `out/`, `dist/`,
 *     `build/`, `.output/public/`, `_site/`. Every static export writes one, and
 *     plenty of people commit it. Exact, free, and it is the same commit the
 *     source came from.
 *  2. **A render service**, if one is configured. This is where a sandboxed
 *     builder plugs in: it is handed the repository, the branch and the route,
 *     and it returns HTML. Nothing in this process executes anything.
 *  3. **The live page** — whatever the host last built and published. Behind by
 *     however long a deploy takes, and honest about being so.
 *
 * The answer says which of the three it is, because the editor has to tell
 * somebody whether they are looking at this commit or at last night's deploy.
 */
import type { Site, SitePage } from "@prisma/client";
import { readFile } from "../../lib/github.js";
import { fetchWebsiteText } from "../../lib/websiteFetch.js";
import { readCache, sourceKey, writeCache, invalidateSource } from "./sourceCache.js";
import { pageUrl, repoFilePath, siteRepo } from "./site.js";

export type RenderedPage = {
  html: string;
  from: "prerendered output" | "render service" | "live site";
  /** Where the HTML was taken from, for the sentence the editor shows. */
  detail: string;
};

/** Folders a static export writes into, best first. */
const OUTPUT_FOLDERS = ["out", "dist", "build", ".output/public", "_site", "public"] as const;

/**
 * The files a route's prerendered HTML could be at.
 *
 * Every exporter spells it slightly differently — `/pricing` is
 * `out/pricing.html` in one and `out/pricing/index.html` in the next — so both
 * are tried, in both spellings, before giving up on a folder.
 */
export function prerenderCandidates(route: string): string[] {
  const clean = route.replace(/^\/+|\/+$/g, "");
  const names = clean === "" ? ["index.html"] : [`${clean}/index.html`, `${clean}.html`];
  return OUTPUT_FOLDERS.flatMap((folder) => names.map((name) => `${folder}/${name}`));
}

/** The cache entry for a rendered page, kept apart from the file's own bytes. */
function renderKey(site: Site, page: SitePage): string {
  return sourceKey({ siteId: site.id, repo: siteRepo(site), branch: site.repoBranch, filePath: `render:${page.filePath}` });
}

/** Drops the rendered HTML for a page, so the next open re-reads it. Called by a
 * publish: the file it wrote is the file the rendering came from. */
export function invalidateRender(site: Pick<Site, "id">, page: Pick<SitePage, "filePath">): void {
  invalidateSource(site.id, `render:${page.filePath}`);
}

type Dependencies = { read: typeof readFile; live: typeof fetchWebsiteText; service: typeof renderThroughService };
const dependencies: Dependencies = { read: readFile, live: fetchWebsiteText, service: renderThroughService };

/**
 * Hands a build out to a service that is allowed to run it.
 *
 * The seam, and the only place a framework project is ever executed. It is a
 * plain HTTP call to something the operator has stood up — a container that
 * clones, installs, builds and exports with no network to anywhere else, no
 * secrets and a hard timeout. Absent the environment variable there is no
 * service and this never runs, which is the default.
 */
async function renderThroughService(input: { repo: string; branch: string; route: string; filePath: string }): Promise<string | null> {
  const endpoint = process.env.WEBSITE_RENDER_URL;
  if (!endpoint) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.WEBSITE_RENDER_TIMEOUT_MS ?? 120_000));
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.WEBSITE_RENDER_TOKEN ? { Authorization: `Bearer ${process.env.WEBSITE_RENDER_TOKEN}` } : {}) },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json() as { html?: unknown };
    return typeof body.html === "string" && body.html.trim() ? body.html : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The rendered HTML for one framework page.
 *
 * Cached on the page's own source hash rather than on a clock: the rendering is
 * only stale when the file it came from changes, and a publish invalidates it
 * directly. `fresh` skips the cache for the one caller that must never answer
 * from a copy — the publish path's conflict check.
 */
export async function renderRoute(site: Site, page: SitePage, options: { fresh?: boolean; overrides?: Partial<Dependencies> } = {}): Promise<RenderedPage | null> {
  const deps = { ...dependencies, ...options.overrides };
  const key = renderKey(site, page);
  if (!options.fresh) {
    const cached = readCache(key);
    // The cache speaks the HTML editor's vocabulary; a rendering is a repository
    // read in everything that matters — it is the same commit.
    if (cached) return { html: cached.html, from: cached.from === "live site" ? "live site" : "prerendered output", detail: cached.from };
  }
  const repo = siteRepo(site);

  if (repo) {
    for (const candidate of prerenderCandidates(page.path)) {
      const html = await deps.read(repo, prefixed(site, candidate), site.repoBranch).catch(() => null);
      if (html && html.trim()) {
        const rendered: RenderedPage = { html, from: "prerendered output", detail: candidate };
        writeCache(key, { html, from: "repository" });
        return rendered;
      }
    }
    const built = await deps.service({ repo, branch: site.repoBranch, route: page.path, filePath: repoFilePath(site, page) });
    if (built) {
      writeCache(key, { html: built, from: "repository" });
      return { html: built, from: "render service", detail: "built from this commit" };
    }
  }

  try {
    const html = await deps.live(pageUrl(site, page));
    writeCache(key, { html, from: "live site" });
    return { html, from: "live site", detail: pageUrl(site, page) };
  } catch {
    return null;
  }
}

/** A repository whose site lives in a subfolder keeps its build output there too. */
function prefixed(site: Site, candidate: string): string {
  const folder = site.repoPath.replace(/^\/+|\/+$/g, "");
  return folder ? `${folder}/${candidate}` : candidate;
}
