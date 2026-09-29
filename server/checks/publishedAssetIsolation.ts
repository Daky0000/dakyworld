import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/lib/prisma.js";
import { legacyPublishedAsset, readPublishedAsset } from "../src/services/publishedAssets.js";

const suffix = randomUUID();
const first = await prisma.site.create({ data: { name: "Asset check", slug: `audit-${suffix}`, publicUrl: "https://one.example.invalid" } });
const second = await prisma.site.create({ data: { name: "Other site", slug: `other-${suffix}`, publicUrl: "https://two.example.invalid" } });
const repoPath = "assets/dw/shared-name.svg";
const path = `/${repoPath}`;
const app = express();
app.get("/assets/dw/:filename", legacyPublishedAsset);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
const oldSlug = process.env.LEGACY_ASSET_SITE_SLUG;
process.env.LEGACY_ASSET_SITE_SLUG = first.slug;
try {
  for (const [siteId, content] of [[first.id, "first"], [second.id, "second"]]) {
    await prisma.siteAsset.create({ data: { siteId: siteId!, filename: "shared-name.svg", repoPath, contentType: "image/svg+xml", content: Buffer.from(content!), size: content!.length } });
  }
  assert.equal((await fetch(url)).status, 404, "unpublished asset is not public");
  await prisma.sitePage.create({ data: { siteId: second.id, path: "/", filePath: "index.html", title: "Other", status: "LIVE", publishedHtml: `<img src="${path}">` } });
  assert.equal((await fetch(url)).status, 404, "another site's publication cannot authorize this asset");
  const page = await prisma.sitePage.create({ data: { siteId: first.id, path: "/", filePath: "index.html", title: "First", status: "LIVE", publishedHtml: `<img src="${path}">` } });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "first", "legacy URL resolves only the configured site");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("content-security-policy"));
  assert.equal((await readPublishedAsset(second, repoPath, path))?.content?.toString(), "second");
  assert.equal(await readPublishedAsset(first, repoPath, "/wrong/path"), null);
  await prisma.sitePage.update({ where: { id: page.id }, data: { publishedHtml: "<p>Image removed</p>" } });
  assert.equal((await fetch(url)).status, 404);
  console.log("Published assets: draft refusal, cross-site collisions, publication removal and SVG protection passed.");
} finally {
  if (oldSlug === undefined) delete process.env.LEGACY_ASSET_SITE_SLUG; else process.env.LEGACY_ASSET_SITE_SLUG = oldSlug;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.site.deleteMany({ where: { id: { in: [first.id, second.id] } } });
  await prisma.cacheInvalidation.deleteMany({ where: { siteId: { in: [first.id, second.id] } } });
  await prisma.$disconnect();
}
