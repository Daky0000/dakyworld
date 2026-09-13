import type { Request, Response, Router } from "express";
import type { Site, SitePage } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { surveySite, type SiteSurvey } from "./website/survey.js";
import { pageSource, siteRepo, WebsiteError } from "./website/site.js";

/**
 * The half of the survey that has to go and read the website.
 *
 * `services/website/survey.ts` is given pages and decides what they are; this
 * fetches them. The split is the same one compatibility uses and for the same
 * reason: the deciding is worth checking without a database or a network, and
 * the fetching is worth doing in one place that knows about page limits, a
 * repository that will not answer, and a page that simply cannot be read.
 *
 * A page that cannot be read is left out of the survey and counted, rather than
 * failing the whole thing. A survey of nine pages out of ten is useful as long
 * as it says which one is missing; a survey that refuses because one page is
 * broken is not.
 */

type Access = { loadSite: (req: Request, id: string) => Promise<Site> };

/** Read for a report, not for editing: a slow site must not hang the request. */
const PAGE_LIMIT = 60;

export type SiteSurveyReport = SiteSurvey & {
  unreadable: Array<{ pageId: string; title: string; path: string; reason: string }>;
  truncated: number;
};

export async function siteSurvey(site: Site, pages: SitePage[]): Promise<SiteSurveyReport> {
  const considered = pages.slice(0, PAGE_LIMIT);
  const unreadable: SiteSurveyReport["unreadable"] = [];

  const read = await Promise.all(
    considered.map(async (page) => {
      try {
        const source = await pageSource(site, page);
        return { pageId: page.id, title: page.title, path: page.path, html: source.html };
      } catch (error) {
        unreadable.push({
          pageId: page.id,
          title: page.title,
          path: page.path,
          reason: error instanceof WebsiteError ? error.message : "This page could not be read.",
        });
        return null;
      }
    }),
  );

  const survey = surveySite(read.filter((page): page is NonNullable<typeof page> => page !== null));
  return { ...survey, unreadable, truncated: pages.length > PAGE_LIMIT ? pages.length - PAGE_LIMIT : 0 };
}

export function registerWebsiteSurvey(router: Router, access: Access) {
  const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => {
    void fn(req, res).catch(next);
  };

  router.get("/sites/:siteId/survey", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const pages = await prisma.sitePage.findMany({ where: { siteId: site.id }, orderBy: [{ sortOrder: "asc" }, { path: "asc" }] });
    const report = await siteSurvey(site, pages);
    res.json({
      site: { id: site.id, name: site.name, publicUrl: site.publicUrl, repo: siteRepo(site) },
      pages: pages.map((page) => ({ id: page.id, title: page.title, path: page.path })),
      ...report,
    });
  }));
}
