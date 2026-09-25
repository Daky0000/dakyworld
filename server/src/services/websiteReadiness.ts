import type { Request, Response, Router } from "express";
import type { Site, SitePage } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { githubConfigured, repoAllowed } from "../lib/github.js";
import { summariseCompatibility, type SiteCompatibility } from "./website/compatibility.js";
import { pageSource, siteRepo, underSiteCredential, WebsiteError } from "./website/site.js";

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

  const read = await Promise.all(
    pages.slice(0, PAGE_LIMIT).map(async (page) => {
      try {
        const source = await pageSource(site, page);
        return { pageId: page.id, title: page.title, path: page.path, html: source.html };
      } catch (error) {
        // A page that cannot be read is a finding, not a failure: it is exactly
        // the kind of thing this report exists to put in front of somebody.
        return { pageId: page.id, title: page.title, path: page.path, unreadable: error instanceof WebsiteError ? error.message : "This page could not be read." };
      }
    }),
  );

  return summariseCompatibility({ pages: read, publishing: { repository: Boolean(repo), credentials, branch: site.repoBranch, blocked } });
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
