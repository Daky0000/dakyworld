import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Site } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { registerWebsiteManagement } from "../src/services/websiteManagement.js";

// Exercise the actual image response without a database or a public website.
const site = { id: "images", publicUrl: "https://website.example/store/" } as Site;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=", "base64");
const assets = [
  { id: "draft", siteId: site.id, repoPath: "assets/dw/draft.png", contentType: "image/png", content: png, publishedAt: null },
  { id: "published", siteId: site.id, repoPath: "assets/dw/published.png", contentType: "image/png", content: null, publishedAt: new Date() },
  { id: "missing", siteId: site.id, repoPath: "assets/dw/missing.png", contentType: "image/png", content: null, publishedAt: null },
  { id: "other-site", siteId: "another-site", repoPath: "assets/dw/private.png", contentType: "image/png", content: png, publishedAt: null },
];
const originalFind = prisma.siteAsset.findFirst;
prisma.siteAsset.findFirst = (async ({ where }: { where: { id: string; siteId: string } }) =>
  assets.find(asset => asset.id === where.id && asset.siteId === where.siteId) ?? null) as unknown as typeof originalFind;

const app = express();
const router = express.Router();
registerWebsiteManagement(router, {
  loadSite: async () => site,
  loadPage: async () => { throw new Error("Not used by asset content routes."); },
});
app.use("/api/website", router);
app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status ?? 500).json({ error: error.message });
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/website/sites/${site.id}/assets`;
try {
  const draft = await fetch(`${base}/draft/content`);
  assert.equal(draft.status, 200);
  assert.match(draft.headers.get("content-type") ?? "", /^image\/png/);
  assert.equal(draft.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await draft.arrayBuffer()), png);

  const published = await fetch(`${base}/published/content`, { redirect: "manual" });
  assert.equal(published.status, 302);
  assert.equal(published.headers.get("location"), "https://website.example/store/assets/dw/published.png");
  assert.equal(published.headers.get("cache-control"), "private, no-store");

  for (const id of ["missing", "other-site", "unknown"]) {
    const response = await fetch(`${base}/${id}/content`, { redirect: "manual" });
    assert.equal(response.status, 404, `${id} must not return an empty successful image or another site's bytes`);
    assert.equal(response.headers.get("location"), null);
  }
  console.log("websiteAssetContent: draft image bytes, published fallback, missing content and site isolation passed.");
} finally {
  prisma.siteAsset.findFirst = originalFind;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await prisma.$disconnect();
}
