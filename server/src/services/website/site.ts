import { commitFiles, GitHubNotConfiguredError, githubConfigured, listTree, readFile, RepoNotAllowedError } from "../../lib/github.js";
import type { Site, SitePage } from "@prisma/client";

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

const FETCH_TIMEOUT_MS = 20_000;

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
  /** Which of the two routes answered, so the editor can say where it is looking. */
  from: "repository" | "live site";
};

async function fetchLive(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Dakyworld-OS-Editor" } });
    if (!response.ok) throw new WebsiteError(502, `${url} answered ${response.status}. The page may have been renamed or removed.`);
    return await response.text();
  } catch (err) {
    if (err instanceof WebsiteError) throw err;
    throw new WebsiteError(502, `Could not read ${url}. The site may be down, or this machine may have no way to reach it.`);
  } finally {
    clearTimeout(timer);
  }
}

/** The page as it stands right now, before any unpublished edits. */
export async function pageSource(site: Site, page: SitePage): Promise<PageSource> {
  const repo = siteRepo(site);
  if (repo && (await githubConfigured())) {
    const html = await readFile(repo, repoFilePath(site, page), site.repoBranch).catch(() => null);
    if (html !== null) return { html, from: "repository" };
    // A configured repository that does not have the file is worth saying out
    // loud rather than silently falling back to a live page that might be a
    // cached copy of something already deleted.
    throw new WebsiteError(
      404,
      `${repoFilePath(site, page)} is not in ${repo} on branch ${site.repoBranch}. It may have been renamed — remove the page here, or rescan the site.`,
    );
  }
  return { html: await fetchLive(pageUrl(site, page)), from: "live site" };
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
export async function discoverPages(site: Site): Promise<DiscoveredPage[]> {
  const listed = await sitemapPaths(site);
  const repo = siteRepo(site);

  if (repo && (await githubConfigured())) {
    const folder = site.repoPath.replace(/^\/+|\/+$/g, "");
    const tree = await listTree(repo, folder, site.repoBranch);
    return tree
      .filter((entry) => entry.type === "blob" || entry.type === "file")
      .map((entry) => (folder ? entry.path.slice(folder.length + 1) : entry.path))
      // Top level only. A file in a subfolder is an asset or an archive of old
      // work — `website-drafts/` on this site is exactly that.
      .filter((relative) => relative.endsWith(".html") && !relative.includes("/"))
      .map((relative) => ({
        filePath: relative,
        path: pathFromFile(relative),
        title: titleFromFile(relative),
        listed: listed.has(pathFromFile(relative)),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  if (listed.size === 0) {
    throw new WebsiteError(
      424,
      `Could not work out which pages ${site.publicUrl} has. Connect the repository under Settings → Developer, or publish a sitemap.xml.`,
    );
  }

  return [...listed]
    .map((path) => {
      const filePath = path === "/" ? "index.html" : `${path.replace(/^\//, "")}.html`;
      return { filePath, path, title: titleFromFile(filePath), listed: true };
    })
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

  try {
    return await commitFiles({
      repo,
      branch: input.site.repoBranch,
      message: input.message,
      files: [{ path: repoFilePath(input.site, input.page), content: input.html }],
    });
  } catch (err) {
    if (err instanceof GitHubNotConfiguredError) {
      throw new WebsiteError(
        503,
        "Publishing needs a GitHub token with permission to write to the website's repository. Add one under Settings → Developer.",
      );
    }
    if (err instanceof RepoNotAllowedError) {
      throw new WebsiteError(
        403,
        `${repo} is not on the list of repositories this system may write to. Add it under Settings → Developer, then publish again.`,
      );
    }
    throw err;
  }
}

/**
 * Hosts a preview must never reach, whatever the page itself allows.
 *
 * Analytics, above all. A preview that loads the site's tag manager reports
 * itself as a visit, so an afternoon of editing quietly becomes traffic in the
 * owner's own reporting — and the pages being "visited" are drafts nobody has
 * seen. The editor must be invisible to the instruments.
 */
const NEVER_IN_PREVIEW = [/https:\/\/[\w.-]*googletagmanager\.com/g, /https:\/\/[\w.-]*google-analytics\.com/g, /https:\/\/[\w.-]*doubleclick\.net/g];

/** What a page with no policy of its own gets. Deliberately close to this site's. */
const FALLBACK_POLICY =
  "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'";

export type PreviewDocument = {
  html: string;
  /**
   * The policy to send as a header. It has to be a header rather than the tag
   * in the page: a `<meta>` policy can only ever *narrow* what a header already
   * allows, so the app's own header — written for the app, where `'self'` is
   * os.dakyworld.com — would go on forbidding the website's stylesheet however
   * the page's own tag were rewritten. That is what a first version of this did,
   * and the preview rendered as unstyled black text on white.
   */
  csp: string;
};

/**
 * Prepares a page for display inside the editor's preview frame.
 *
 * Three changes, and the preview is wrong without any one of them.
 *
 * **A `<base>`**, because the HTML is served from the OS's own domain, where
 * `assets/site.css` and every logo the page asks for do not exist. With one,
 * every relative address resolves against the real site.
 *
 * **The page's own policy, widened to include that site.** The site's CSP is
 * written entirely in terms of `'self'`, and served from anywhere else `'self'`
 * is the wrong origin — so the page forbids its own stylesheet, its own fonts
 * and its own images, and `base-uri 'self'` forbids the tag just added. Taking
 * the author's policy and only widening `'self'` keeps every restriction they
 * wrote: `object-src 'none'` stays `'none'`.
 *
 * **Two directives overridden rather than widened.** `frame-ancestors` has to
 * allow the editor to frame it at all, and `form-action` is forced to `'none'`
 * because a preview of the contact page must not be able to send a real enquiry.
 */
export function previewDocument(html: string, baseUrl: string): PreviewDocument {
  const origin = baseUrl.replace(/\/+$/, "");
  const declared = /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content="([^"]*)"/i.exec(html)?.[1];

  let policy = (declared ?? FALLBACK_POLICY).replace(/'self'/g, `'self' ${origin}`);
  for (const host of NEVER_IN_PREVIEW) policy = policy.replace(host, "");
  policy = policy
    .split(";")
    .map((directive) => directive.trim().replace(/\s+/g, " "))
    .filter((directive) => directive && !/^(frame-ancestors|form-action)\b/i.test(directive))
    .concat(["frame-ancestors 'self'", "form-action 'none'"])
    .join("; ");

  const base = `<base href="${origin}/">`;
  const headOpen = /<head[^>]*>/i.exec(html);
  const withBase = headOpen
    ? html.slice(0, headOpen.index + headOpen[0].length) + base + html.slice(headOpen.index + headOpen[0].length)
    : base + html;

  // The tag in the page is rewritten too. It cannot loosen the header, but a
  // stale `'self'` left in it would narrow the result back down to the app's
  // own origin — the two policies are intersected, not chosen between.
  const out = withBase.replace(
    /(<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=")([^"]*)(")/i,
    (_whole, before: string, _old: string, after: string) => `${before}${policy}${after}`,
  );

  return { html: out, csp: policy };
}
