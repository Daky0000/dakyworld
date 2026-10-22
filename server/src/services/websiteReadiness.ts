import type { Request, Response, Router } from "express";
import type { Site, SitePage } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { githubConfigured, repoAllowed } from "../lib/github.js";
import { summariseCompatibility, type SiteCompatibility } from "./website/compatibility.js";
import { pageSource, siteRepo, underSiteCredential, WebsiteError } from "./website/site.js";
import { isWordPressSite, wordpressPostOf } from "./websiteWordPress.js";
import { builderEditable, builderRefusal, detectWordPressBuilder } from "./website/index.js";

/**
 * Whether a website is one this editor can honestly be sold for.
 *
 * The report exists because of a support problem rather than a technical one.
 * Every website is *partly* editable here, and the parts that are not are never
 * obvious from looking: a menu that only works because of a script, a picture
 * group the image control cannot reach, a form whose behaviour belongs to
 * whoever wrote it. Told afterwards, each of those is somebody feeling misled.
 * Told first, each is a sentence in an onboarding conversation.
 *
 * The judging is `services/website/compatibility.ts` and has no database in it.
 * This is the half that has to read the pages and ask GitHub whether a publish
 * could actually happen — because "ready" that does not include "and it can go
 * live" is the more expensive half of the same problem.
 */

type Access = { loadSite: (req: Request, id: string) => Promise<Site> };

/** Read for a report, not for editing: a slow site must not hang the request. */
const PAGE_LIMIT = 60;

export async function siteCompatibility(site: Site, pages: SitePage[]): Promise<SiteCompatibility> {
  // A WordPress site publishes into WordPress, so "can it go live" is whether
  // the Application Password still works — not a repository it will never have.
  if (isWordPressSite(site)) {
    const connection = await prisma.wordPressConnection.findUnique({ where: { siteId: site.id } });
    const blocked = !connection
      ? "This WordPress site is not connected yet. Connect it under Website settings with an Application Password."
      : connection.pausedAt
        ? `WordPress stopped accepting the Application Password, so nothing can be published until it is replaced under Website settings. ${connection.pausedReason ?? ""}`.trim()
        : null;
    return summariseCompatibility({
      pages: await readForReport(site, pages),
      publishing: { repository: false, credentials: Boolean(connection && !connection.pausedAt), branch: null, blocked, wordpress: connection ? { username: connection.username, siteUrl: connection.siteUrl } : null },
    });
  }
  const repo = siteRepo(site);
  const credentials = await underSiteCredential(site, githubConfigured);
  const allowed = repo ? await repoAllowed(repo).catch(() => false) : false;

  const blocked = !repo
    ? "No repository is connected, so there is nowhere to publish to. Add one under the site's settings."
    : !credentials
      ? "Publishing needs a GitHub token with permission to write to this repository. Add one under Settings → Developer."
      : !allowed
        ? `${repo} is not on the list of repositories this system may write to. Add it under Settings → Developer.`
        : null;

  return summariseCompatibility({ pages: await readForReport(site, pages), publishing: { repository: Boolean(repo), credentials, branch: site.repoBranch, blocked } });
}

async function readForReport(site: Site, pages: SitePage[]) {
  return Promise.all(
    pages.slice(0, PAGE_LIMIT).map(async (page) => {
      try {
        const source = await pageSource(site, page);
        // A WordPress page made with Elementor and friends reads as perfectly
        // good HTML and is still read-only here: its words are in the builder's
        // own data. Graded on the HTML alone it came out "Fully editable".
        const post = isWordPressSite(site) ? wordpressPostOf(page) : null;
        if (post) {
          const builder = detectWordPressBuilder({ postId: post.id, content: "", html: source.html });
          if (!builderEditable(builder)) return { pageId: page.id, title: page.title, path: page.path, unreadable: builderRefusal(builder) };
        }
        return { pageId: page.id, title: page.title, path: page.path, html: source.html };
      } catch (error) {
        // A page that cannot be read is a finding, not a failure: it is exactly
        // the kind of thing this report exists to put in front of somebody.
        return { pageId: page.id, title: page.title, path: page.path, unreadable: error instanceof WebsiteError ? error.message : "This page could not be read." };
      }
    }),
  );
}

export function registerWebsiteReadiness(router: Router, access: Access) {
  const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => {
    void fn(req, res).catch(next);
  };

  router.get("/sites/:siteId/compatibility", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const pages = await prisma.sitePage.findMany({ where: { siteId: site.id }, orderBy: { sortOrder: "asc" } });
    const report = await siteCompatibility(site, pages);
    res.json({
      site: { id: site.id, name: site.name, publicUrl: site.publicUrl, repo: siteRepo(site) },
      ...report,
      truncated: pages.length > PAGE_LIMIT ? pages.length - PAGE_LIMIT : 0,
    });
  }));
}
