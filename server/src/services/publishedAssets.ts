import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { prisma } from "../lib/prisma.js";
import { getOrLoad } from "../lib/cache.js";
import { getR2PublicUrl, isR2Configured } from "../lib/r2.js";
import { assetUrl } from "./websiteAssets.js";
import { SVG_CONTENT_SECURITY_POLICY } from "../lib/svgSanitize.js";

/**
 * Which uploaded files a site may serve to the public: the ones its own LIVE
 * pages point at, and nothing else.
 *
 * This used to be a `LIKE '%url%'` over every published page on every image
 * request — a page with twenty pictures ran twenty full scans of the site's
 * HTML. Now the set of referenced paths is read once, in the database (only the
 * matches come back, never the HTML), and kept under the same cache key as the
 * hosted pages, so the invalidation every publish already sends clears it too.
 *
 * A reference counts only when it carries the site's own base path, exactly as
 * `assetUrl` writes it — the rule the `LIKE` applied — so on a site served
 * under `/shop/`, a bare `/assets/dw/x.png` in its HTML does not authorise
 * `/shop/assets/dw/x.png`. At the root the base is `/`, which is also what lets
 * an R2 address (`https://<bucket>/assets/dw/x.png`) count as a reference.
 */
const ASSET_NAME = "[^[:space:]\"'`()<>,;?#&\\\\/]+";
const escapeRegex = (text: string) => text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");

export async function publishedAssetPaths(site: { id: string; publicUrl: string }): Promise<string[]> {
  return getOrLoad({ scope: `public:${site.id}`, resource: "pages", identity: "#asset-paths" }, { ttlMs: 25_000, maxBytes: 1024 * 1024 }, async () => {
    const pattern = `${escapeRegex(assetUrl(site, ""))}(assets/dw/${ASSET_NAME})`;
    const rows = await prisma.$queryRaw<Array<{ path: string }>>`
      SELECT DISTINCT (regexp_matches(p."publishedHtml", ${pattern}, 'g'))[1] AS path
      FROM "SitePage" p
      WHERE p."siteId" = ${site.id} AND p."status" = 'LIVE' AND p."publishedHtml" IS NOT NULL`;
    return rows.map((row) => row.path);
  });
}

export type PublishedAsset = { repoPath: string; contentType: string; size: number };

/** Public bytes belong to a specific site and must be referenced by its live content. Metadata only. */
export async function readPublishedAsset(site: { id: string; publicUrl: string }, repoPath: string, requestPath: string): Promise<PublishedAsset | null> {
  if (requestPath !== assetUrl(site, repoPath)) return null;
  if (!(await publishedAssetPaths(site)).includes(repoPath)) return null;
  return prisma.siteAsset.findUnique({ where: { siteId_repoPath: { siteId: site.id, repoPath } },
    select: { repoPath: true, contentType: true, size: true } });
}

/** The bytes, when the database still holds them. Null once they have moved to R2. */
export async function publishedAssetBytes(siteId: string, repoPath: string): Promise<Buffer | null> {
  const row = await prisma.siteAsset.findUnique({ where: { siteId_repoPath: { siteId, repoPath } }, select: { content: true } });
  return row?.content ? Buffer.from(row.content) : null;
}

/**
 * Where the file lives once `scripts/migrate-images-to-r2.mjs` has moved it.
 *
 * That script runs before every deploy with R2 configured, uploads each blob
 * under its `repoPath` and then sets `content` to NULL — so without this every
 * published picture answered 404 the morning after a deploy. No network call:
 * the object key is the repo path, by construction.
 */
export function movedAssetLocation(repoPath: string): string | null {
  return isR2Configured() ? getR2PublicUrl(repoPath) : null;
}

/** A redirect can be cached, but not for the year an immutable file can: the bucket's address is configuration. */
export const MOVED_ASSET_CACHE = "public, max-age=86400";

/**
 * The ETag from what identifies the file rather than from its bytes, so a
 * revalidation never has to read the blob. Uploads get a fresh random path, so
 * a path and a size name one file.
 */
export function publishedAssetEtag(asset: PublishedAsset): string {
  return `W/"${crypto.createHash("sha1").update(`${asset.repoPath}\0${asset.size}`).digest("base64url")}"`;
}

/**
 * Every upload route writes `assets/dw/<randomUUID()>.<ext>` and never writes
 * that path again, so those files can be cached for a year. Anything else —
 * a package import keeps the file's own name and can replace it — revalidates.
 */
const IMMUTABLE_ASSET = /^assets\/dw\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/;
export function publishedAssetCacheControl(repoPath: string): string {
  return IMMUTABLE_ASSET.test(repoPath) ? "public, max-age=31536000, immutable" : "public, max-age=60, must-revalidate";
}

/** Compatibility for the company's historical root asset URLs, never a cross-site lookup. */
export const legacyPublishedAsset: RequestHandler = async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const site = await prisma.site.findUnique({ where: { slug: process.env.LEGACY_ASSET_SITE_SLUG ?? "dakyworld" }, select: { id: true, publicUrl: true } });
    const asset = site ? await readPublishedAsset(site, `assets/dw/${req.params.filename}`, req.path) : null;
    const bytes = site && asset ? await publishedAssetBytes(site.id, asset.repoPath) : null;
    if (!asset || !bytes) {
      const moved = asset ? movedAssetLocation(asset.repoPath) : null;
      if (moved) { res.set("Cache-Control", MOVED_ASSET_CACHE).redirect(302, moved); return; }
      res.status(404).send("Asset not found"); return;
    }
    if (asset.contentType === "image/svg+xml") res.set("Content-Security-Policy", SVG_CONTENT_SECURITY_POLICY);
    res.set("X-Content-Type-Options", "nosniff").type(asset.contentType).send(bytes);
  } catch (error) { next(error); }
};
