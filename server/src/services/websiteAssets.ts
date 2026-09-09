import type { Site } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export function assetUrl(site: Pick<Site, "publicUrl">, repoPath: string) { return `${new URL(site.publicUrl).pathname.replace(/\/+$/, "")}/${repoPath}`; }

/** Draft uploads are local until publication; embed only this site's images. */
export async function embedWebsiteAssets(site: Site, html: string): Promise<string> {
  const assets = await prisma.siteAsset.findMany({ where: { siteId: site.id } });
  let out = html;
  for (const asset of assets) {
    const url = assetUrl(site, asset.repoPath);
    const encoded = `data:${asset.contentType};base64,${Buffer.from(asset.content).toString("base64")}`;
    out = out.split(url).join(encoded);
  }
  return out;
}

export async function websiteAssetFiles(site: Site, html: string) {
  const assets = await prisma.siteAsset.findMany({ where: { siteId: site.id } });
  return assets.filter(asset => html.includes(assetUrl(site, asset.repoPath))).map(asset => ({
    path: [site.repoPath.replace(/^\/+|\/+$/g, ""), asset.repoPath].filter(Boolean).join("/"),
    content: Buffer.from(asset.content).toString("base64"), encoding: "base64" as const,
  }));
}
