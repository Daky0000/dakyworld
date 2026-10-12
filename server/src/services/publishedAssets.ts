import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getR2PublicUrl, isR2Configured } from "../lib/r2.js";
import { assetUrl } from "./websiteAssets.js";
import { SVG_CONTENT_SECURITY_POLICY } from "../lib/svgSanitize.js";

/**
 * Which uploaded files a site may serve to the public: the ones its own LIVE
 * pages point at, and nothing else.
 *
 * This used to be a `LIKE '%url%'` over every published page on every image
 * request — a page with twenty pictures ran twenty full scans of the site's
 * HTML. Now the set of referenced paths is read in the database (only the
 * matches come back, never the HTML), once for each version of the site.
 *
 * A reference counts only when it carries the site's own base path, exactly as
 * `assetUrl` writes it — the rule the `LIKE` applied — so on a site served
 * under `/shop/`, a bare `/assets/dw/x.png` in its HTML does not authorise
 * `/shop/assets/dw/x.png`. At the root the base is `/`, which is also what lets
 * an R2 address (`https://<bucket>/assets/dw/x.png`) count as a reference.
 */
const ASSET_NAME = "[^[:space:]\"'`()<>,;?#&\\\\/]+";
const escapeRegex = (text: string) => text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");

const livePages = (siteId: string) =>
  Prisma.sql`FROM "SitePage" p WHERE p."siteId" = ${siteId} AND p."status" = 'LIVE' AND p."publishedHtml" IS NOT NULL`;

/**
 * The site's LIVE pages in one short string: a page published, republished,
 * hidden or deleted changes it. Read from each page's id and the
 * `publishedEtag` a trigger writes whenever `publishedHtml` changes — a few
 * short columns through the siteId index, never the HTML itself.
 */
const LIVE_VERSION = Prisma.sql`coalesce(md5(string_agg(p."id" || ':' || coalesce(p."publishedEtag", ''), ',' ORDER BY p."id")), '')`;

async function livePagesVersion(siteId: string): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ version: string }>>`SELECT ${LIVE_VERSION} AS version ${livePages(siteId)}`;
  return rows[0]?.version ?? "";
}

/**
 * Every path the LIVE pages reference, and the version they were read at — in
 * one statement, so one snapshot: a set is never filed under a version it was
 * not read from, even when a page changes while the HTML is being read.
 */
export async function publishedAssetPaths(site: { id: string; publicUrl: string }): Promise<{ version: string; paths: string[] }> {
  const pattern = `${escapeRegex(assetUrl(site, ""))}(assets/dw/${ASSET_NAME})`;
  const rows = await prisma.$queryRaw<Array<{ version: string; paths: string[] }>>`
    SELECT ${LIVE_VERSION} AS version,
      array(SELECT DISTINCT (regexp_matches(p."publishedHtml", ${pattern}, 'g'))[1] ${livePages(site.id)}) AS paths
    ${livePages(site.id)}`;
  return rows[0] ?? { version: "", paths: [] };
}

/**
 * The referenced set, held in this process and checked against the pages'
 * version on every request rather than kept for a while.
 *
 * It used to live in the response cache. With that cache off, which is the
 * default, nothing was kept: every picture request re-extracted the whole site
 * through the cache's fallback gate, which refuses rather than waits once
 * twenty reads are running, so a page with forty pictures fetched together got
 * about half of them as 503. Now forty requests at once share one extraction,
 * and none is made again until a page changes. The extraction takes no slot in
 * that gate: one per site and version is its own bound.
 *
 * Checked rather than timed, it is exact both ways, cache on or off: a picture
 * published a moment ago is served on the first request for it, one taken off
 * the site is refused on the next, and nothing is remembered about a refusal.
 */
const HELD_SITES = 1000;
const heldPaths = new Map<string, { version: string; paths: Set<string>; order: number }>();
const extracting = new Map<string, Promise<Set<string>>>();
let extractions = 0;

async function referencedPaths(site: { id: string; publicUrl: string }): Promise<Set<string>> {
  const key = `${site.id} ${assetUrl(site, "")}`;
  const version = await livePagesVersion(site.id);
  const held = heldPaths.get(key);
  if (held?.version === version) return held.paths;
  const job = `${key} ${version}`;
  let pending = extracting.get(job);
  if (!pending) {
    const order = ++extractions;
    pending = publishedAssetPaths(site).then((read) => {
      const paths = new Set(read.paths);
      // An extraction started earlier and finishing later must not replace a newer one.
      if ((heldPaths.get(key)?.order ?? 0) < order) {
        heldPaths.delete(key);
        if (heldPaths.size >= HELD_SITES) heldPaths.delete(heldPaths.keys().next().value!);
        heldPaths.set(key, { version: read.version, paths, order });
      }
      return paths;
    }).finally(() => extracting.delete(job));
    extracting.set(job, pending);
  }
  return pending;
}

export type PublishedAsset = { repoPath: string; contentType: string; size: number };

/** Public bytes belong to a specific site and must be referenced by its live content. Metadata only. */
export async function readPublishedAsset(site: { id: string; publicUrl: string }, repoPath: string, requestPath: string): Promise<PublishedAsset | null> {
  if (requestPath !== assetUrl(site, repoPath)) return null;
  if (!(await referencedPaths(site)).has(repoPath)) return null;
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
 * That script (a manual one-off, never a deploy step) uploads each blob under
 * its `repoPath` and then sets `content` to NULL — so without this every
 * picture it moved answered 404. No network call: the object key is the repo
 * path, by construction.
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
