import type { RequestHandler } from "express";
import { prisma } from "../lib/prisma.js";
import { assetUrl } from "./websiteAssets.js";
import { SVG_CONTENT_SECURITY_POLICY } from "../lib/svgSanitize.js";

/** Public bytes belong to a specific site and must be referenced by its live content. */
export async function readPublishedAsset(site: { id: string; publicUrl: string }, repoPath: string, requestPath: string) {
  if (requestPath !== assetUrl(site, repoPath)) return null;
  const published = await prisma.sitePage.findFirst({
    where: { siteId: site.id, status: "LIVE", publishedHtml: { contains: assetUrl(site, repoPath) } }, select: { id: true },
  });
  if (!published) return null;
  return prisma.siteAsset.findUnique({ where: { siteId_repoPath: { siteId: site.id, repoPath } },
    select: { content: true, contentType: true, repoPath: true } });
}

/** Compatibility for the company's historical root asset URLs, never a cross-site lookup. */
export const legacyPublishedAsset: RequestHandler = async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const site = await prisma.site.findUnique({ where: { slug: process.env.LEGACY_ASSET_SITE_SLUG ?? "dakyworld" }, select: { id: true, publicUrl: true } });
    const asset = site ? await readPublishedAsset(site, `assets/dw/${req.params.filename}`, req.path) : null;
    if (!asset?.content) { res.status(404).send("Asset not found"); return; }
    if (asset.contentType === "image/svg+xml") res.set("Content-Security-Policy", SVG_CONTENT_SECURITY_POLICY);
    res.set("X-Content-Type-Options", "nosniff").type(asset.contentType).send(Buffer.from(asset.content));
  } catch (error) { next(error); }
};
