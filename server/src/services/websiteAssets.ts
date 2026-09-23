import type { Site } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { WebsiteError } from "./website/site.js";

export function assetUrl(site: Pick<Site, "publicUrl">, repoPath: string) { return `${new URL(site.publicUrl).pathname.replace(/\/+$/, "")}/${repoPath}`; }

/**
 * Reading a site's images without reading a site's images.
 *
 * Both callers below want the bytes of the handful of pictures one page
 * actually uses. Both used to ask for every asset row on the site — bytes
 * included — and then filter. On a site with two hundred photographs that is
 * the whole library in memory to render one page, and `publishPages` asked for
 * it once per page *concurrently*, so a ten-page publish multiplied it again.
 * The filter was always there; it simply ran after the cost had been paid.
 *
 * So: metadata first, filter, then bytes for the survivors. The rule is that
 * nothing in this file loads `content` for a row it has not already decided it
 * needs.
 */
type AssetRef = { id: string; repoPath: string; contentType: string; size: number };

const REF = { id: true, repoPath: true, contentType: true, size: true } as const;

/** The site's assets that this HTML actually points at. Metadata only. */
async function referencedAssets(site: Pick<Site, "id" | "publicUrl">, html: string): Promise<AssetRef[]> {
  const assets = await prisma.siteAsset.findMany({ where: { siteId: site.id }, select: REF });
  return assets.filter((asset) => html.includes(assetUrl(site, asset.repoPath)));
}

/**
 * The bytes for an already-chosen set of ids, in one query.
 *
 * A row whose `content` is null has been swept: the file it holds is already
 * live at its address and the duplicate was dropped. That is normal for a
 * published asset and a fault for anything that needs the bytes, so the two
 * callers disagree about what to do and neither may guess — see each of them.
 */
async function assetBytes(ids: string[]): Promise<Map<string, Buffer>> {
  if (!ids.length) return new Map();
  const rows = await prisma.siteAsset.findMany({ where: { id: { in: ids } }, select: { id: true, content: true } });
  const bytes = new Map<string, Buffer>();
  for (const row of rows) if (row.content) bytes.set(row.id, Buffer.from(row.content));
  return bytes;
}

/**
 * Draft uploads are local until publication, so a preview has to carry them
 * itself; embed only this site's images.
 *
 * An asset whose bytes have been swept is **left alone deliberately**. Its URL
 * is the address it already occupies on the published site, and `previewDocument`
 * gives the preview a `<base>`, so the browser fetches it from there. Replacing
 * it with nothing would blank a picture that is working perfectly well.
 */
export async function embedWebsiteAssets(site: Site, html: string): Promise<string> {
  const assets = await referencedAssets(site, html);
  const bytes = await assetBytes(assets.map((asset) => asset.id));
  let out = html;
  for (const asset of assets) {
    const content = bytes.get(asset.id);
    if (!content) continue;
    const replacement = asset.contentType.startsWith("image/")
      ? `data:${asset.contentType};base64,${content.toString("base64")}`
      : `/api/website/sites/${site.id}/assets/${asset.id}/content`;
    out = out.split(assetUrl(site, asset.repoPath)).join(replacement);
  }
  return out;
}

/**
 * The files a publish has to commit alongside the page that references them.
 *
 * Here a missing `content` is a fault and not a normal state: this runs at the
 * moment of a commit, and an asset with no bytes would be written to the
 * repository as an empty file — a broken image, committed, reported as a
 * successful publish. It refuses instead, naming the file.
 */
export async function websiteAssetFiles(site: Site, html: string) {
  const assets = await referencedAssets(site, html);
  const bytes = await assetBytes(assets.map((asset) => asset.id));
  return assets.map((asset) => {
    const content = bytes.get(asset.id);
    if (!content) throw new WebsiteError(409, `The image at ${asset.repoPath} is already published and is no longer held here, so it cannot be committed again. Re-upload it if this page needs it.`);
    return {
      path: [site.repoPath.replace(/^\/+|\/+$/g, ""), asset.repoPath].filter(Boolean).join("/"),
      content: content.toString("base64"),
      encoding: "base64" as const,
    };
  });
}

/**
 * The same, for the framework publish path, which puts a file somewhere else.
 *
 * The framework's own static folder rather than the site's page folder: a build
 * copies `public/` to the root, and an image committed anywhere else is a file
 * in the repository that the built site cannot see.
 */
export async function websiteAssetFilesIn(site: Site, source: string, folder: string) {
  const assets = await referencedAssets(site, source);
  const bytes = await assetBytes(assets.map((asset) => asset.id));
  return assets.map((asset) => {
    const content = bytes.get(asset.id);
    if (!content) throw new WebsiteError(409, `The image at ${asset.repoPath} is already published and is no longer held here, so it cannot be committed again. Re-upload it if this page needs it.`);
    return { path: [folder, asset.repoPath].filter(Boolean).join("/"), content: content.toString("base64"), encoding: "base64" as const };
  });
}

/** Which of a site's assets a set of pages reference, as repo paths. Metadata only. */
export async function referencedAssetPaths(site: Pick<Site, "id" | "publicUrl">, htmls: string[]): Promise<Set<string>> {
  const assets = await prisma.siteAsset.findMany({ where: { siteId: site.id }, select: REF });
  const paths = new Set<string>();
  for (const asset of assets) {
    const url = assetUrl(site, asset.repoPath);
    if (htmls.some((html) => html.includes(url))) paths.add(asset.repoPath);
  }
  return paths;
}

/**
 * The unpublished changes that still need a given image, named for a person.
 *
 * Deleting an upload is safe exactly when nothing unpublished still points at
 * it: a reference from an already-published page is not a reason to refuse,
 * because that file is in the customer's repository and stays there whatever
 * happens to this row.
 *
 * **There are two places an unpublished change lives, and only one is obvious.**
 * A page draft is the first. The second is a shared element — a logo swapped in
 * the header that seven pages carry is stored once against the element, keyed
 * by slot, and deliberately never copied into any page's draft. Scanning only
 * pages therefore answered "nothing is using this" about a file the next shared
 * publish was about to need, and that publish does not fail when the row has
 * gone: `websiteAssetFiles` commits the assets that exist, so a deleted one
 * simply contributes no file and the page goes live pointing at a picture that
 * was never committed.
 *
 * Returns what to say rather than what was found: a shared element is named as
 * itself — "the Header" — because that is where somebody goes to change it.
 * Listing the seven pages carrying it would send them to seven places, none of
 * which holds the value.
 */
export async function unpublishedUsesOf(site: Pick<Site, "id" | "publicUrl">, repoPath: string): Promise<string[]> {
  const url = assetUrl(site, repoPath);
  const [pages, shared] = await Promise.all([
    prisma.sitePage.findMany({
      where: { siteId: site.id, NOT: { draft: { equals: Prisma.DbNull } } },
      select: { title: true, draft: true },
    }),
    prisma.sharedElement.findMany({
      where: { siteId: site.id, NOT: { draft: { equals: Prisma.DbNull } } },
      select: { name: true, draft: true },
    }),
  ]);

  const mentions = (draft: unknown) => JSON.stringify(draft ?? {}).includes(url);
  return [
    ...pages.filter((page) => mentions(page.draft)).map((page) => page.title),
    ...shared.filter((element) => mentions(element.draft)).map((element) => `the ${element.name}`),
  ];
}
