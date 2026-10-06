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
/**
 * The demo an editor page belongs to, if any. Matched on the /demos/<slug> in
 * the site's address first, then on the ids the demo's brief recorded — an
 * imported page keeps the business's own address as its publicUrl, so the
 * second route is the only one that finds it.
 */
export async function findLinkedDemo(site: {
    id: string;
    publicUrl: string;
}, pageId: string): Promise<{ id: string; slug: string } | null> {
    const slugMatch = site.publicUrl.match(/\/demos\/([^/?#]+)/i);
    const slugFromUrl = slugMatch?.[1] ? decodeURIComponent(slugMatch[1]) : null;
    const bySlug = slugFromUrl
        ? await prisma.demo.findUnique({ where: { slug: slugFromUrl }, select: { id: true, slug: true } })
        : null;
    if (bySlug) return bySlug;
    const candidates = await prisma.demo.findMany({
        where: {
            OR: [
                { brief: { path: ["sitePageId"], equals: pageId } },
                { brief: { path: ["siteId"], equals: site.id } },
            ],
        },
        select: { id: true, slug: true },
        take: 1,
    });
    return candidates[0] ?? null;
}
export async function syncDemoFromSitePage(site: {
    id: string;
    publicUrl: string;
}, pageId: string, html: string, incrementVersion: boolean): Promise<void> {
    try {
        const demo = await findLinkedDemo(site, pageId);
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
