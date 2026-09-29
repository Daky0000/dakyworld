import type { WebsiteActor } from "./websiteActor.js";
import type { Site, SitePage } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";
import { type FieldValue } from "./website/index.js";
import { WebsiteError } from "./website/site.js";
export function draftValues(page: SitePage): Record<string, FieldValue> {
    return (page.draft as Record<string, FieldValue> | null) ?? {};
}
export async function loadSite(req: WebsiteActor, siteId: string): Promise<Site> {
    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site)
        throw new WebsiteError(404, "That site is not in the editor.");
    await assertWebsiteSiteAccess(req, site.id);
    return site;
}
export async function loadPage(req: WebsiteActor, pageId: string): Promise<{
    page: SitePage;
    site: Site;
}> {
    const page = await prisma.sitePage.findUnique({ where: { id: pageId }, include: { site: true } });
    if (!page)
        throw new WebsiteError(404, "That page is not in the editor. It may have been removed — rescan the site.");
    const { site, ...rest } = page;
    await assertWebsiteSiteAccess(req, site.id);
    return { page: rest as SitePage, site };
}
export async function syncDemoFromSitePage(site: {
    id: string;
    publicUrl: string;
}, pageId: string, html: string, incrementVersion: boolean): Promise<void> {
    try {
        const slugMatch = site.publicUrl.match(/\/demos\/([^/?#]+)/i);
        const slugFromUrl = slugMatch?.[1] ? decodeURIComponent(slugMatch[1]) : null;
        let demo = slugFromUrl
            ? await prisma.demo.findUnique({ where: { slug: slugFromUrl }, select: { id: true } })
            : null;
        if (!demo) {
            const candidates = await prisma.demo.findMany({
                where: {
                    OR: [
                        { brief: { path: ["sitePageId"], equals: pageId } },
                        { brief: { path: ["siteId"], equals: site.id } },
                    ],
                },
                select: { id: true },
                take: 1,
            });
            demo = candidates[0] ?? null;
        }
        if (demo) {
            await prisma.demo.update({
                where: { id: demo.id },
                data: {
                    html,
                    ...(incrementVersion ? { version: { increment: 1 } } : {}),
                },
            });
        }
    }
    catch {
        /* Never block editor saves if demo synchronization encounters an unexpected error. */
    }
}
