/**
 * The page tools save a draft, and a draft is measured against the page's base.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/websiteToolDrafts.ts
 *
 * On a hosted or imported page the base is `sourceHtml`, and the draft's
 * `$document` records its hash. Six tools — the five SEO tools that rewrite a
 * page and Insert section — used to write their result into `sourceHtml` as
 * well as into the draft. From the next read the draft was stale: the editor
 * said publishing was blocked, every layout change was refused, and Publish
 * refused the draft until it was discarded — which left the tool's change in
 * the base, where no publish could reach it.
 *
 * Each tool is run on its own hosted page here, and the page is then held to
 * what a person expects: the base is where it was, the draft is not stale, and
 * Publish puts the change live.
 *
 * Needs Postgres and nothing else. Every row it makes is removed at the end.
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) || !/(test|check|editor)/i.test(databaseUrl.pathname)) {
  throw new Error("These checks require an isolated local test/editor database. Set DATABASE_URL to one.");
}

let passed = 0;
const failures: string[] = [];
async function check(name: string, test: () => unknown | Promise<unknown>) {
  try { await test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) {
    failures.push(name);
    const detail = error instanceof assert.AssertionError && error.operator !== "fail" ? ` (got ${JSON.stringify(error.actual)}, wanted ${JSON.stringify(error.expected)})` : "";
    console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}${detail}`);
  }
}

// Admission off: the tools and the publish run in the request.
Object.assign(process.env, { DEV_NO_AUTH: "false", NODE_ENV: "development", JOB_ADMISSION_ENABLED: "false" });

const { prisma } = await import("../src/lib/prisma.js");
const { ensureSystemRoles } = await import("../src/lib/accessRoles.js");
const { createSession } = await import("../src/lib/session.js");
const { attachUser, requireAuth } = await import("../src/middleware/auth.js");
const { websiteRouter } = await import("../src/routes/website.js");

await ensureSystemRoles();
const mark = `tooldrafts-${randomUUID().slice(0, 8)}`;
const ownerRole = await prisma.accessRole.findUniqueOrThrow({ where: { key: "owner" } });
const owner = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Abena Tools", role: "OWNER", accessRoleId: ownerRole.id } });
const cookie = `dw_session=${await createSession(owner.id)}`;

const app = express();
app.use(express.json({ limit: "8mb" })); app.use(attachUser); app.use("/api", requireAuth); app.use("/api/website", websiteRouter);
app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/website`;
async function call(method: string, url: string, data?: unknown) {
  const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: data === undefined ? undefined : JSON.stringify(data) });
  const text = await response.text();
  let body: { error?: string } & Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* 204 or not JSON */ }
  return { status: response.status, body };
}

const html = () => `<!doctype html><html><head><title>Tool check</title><meta name="description" content="Before the tools"></head><body><main><h1>Tool check</h1><section class="intro"><h2>Welcome</h2><p>First words</p><img src="/photo.jpg" alt="A photo"><a href="https://example.com/out">Out</a></section></main><footer><p>Footer words</p></footer></body></html>`;

let siteId = "";
let clientId: string | null = null;
let productId: string | null = null;

try {
  // The SEO tools are a Pro feature, so the site is on Pro.
  const client = await prisma.client.create({ data: { name: `${mark}-client` } }); clientId = client.id;
  const product = await prisma.product.create({ data: { key: `${mark}-product`, name: `${mark} product`, monthlyPrice: 1 } }); productId = product.id;
  await prisma.websitePurchase.create({ data: {
    clientId: client.id, productId: product.id, userId: owner.id, tier: "CARE", status: "ACTIVE", billingState: "ACTIVE",
    businessName: "Tool Shop", contactName: "Abena Tools", email: owner.email, websiteUrl: "https://tool-drafts.example.test",
    compatibilityStatus: "COMPATIBLE", monthlyPrice: 1, setupPrice: 0, currency: "GHS",
    setupPaidAt: new Date(), activatedAt: new Date(), nextBillingAt: new Date(Date.now() + 20 * 86_400_000),
  } });

  const tools: Array<{ name: string; run: (pageId: string) => ReturnType<typeof call>; live: string }> = [
    { name: "saving a page's SEO", run: (pageId) => call("POST", `/sites/${siteId}/seo/page`, { pageId, title: "Tool title words", description: "Tool title words, described" }), live: "Tool title words" },
    { name: "adding structured data", run: (pageId) => call("POST", `/sites/${siteId}/seo/technical`, { pageId, organizationName: "Structured Words Ltd" }), live: "Structured Words Ltd" },
    { name: "adding the conversion bar", run: (pageId) => call("POST", `/sites/${siteId}/seo/conversion-bar`, { pageId, enabled: true, whatsapp: "233200000000", ctaLabel: "Bar words" }), live: "Bar words" },
    { name: "the speed optimiser", run: (pageId) => call("POST", `/sites/${siteId}/seo/speed-optimize`, { pageId, applyFixes: true }), live: "fonts.gstatic.com" },
    { name: "the brand theme", run: (pageId) => call("POST", `/sites/${siteId}/seo/brand-theme`, { pageId, fontPairId: "playfair-inter" }), live: "BEGIN BRAND THEME" },
    { name: "inserting a section", run: (pageId) => call("POST", `/sites/${siteId}/pages/${pageId}/insert-section`, { templateId: "faq" }), live: "Frequently asked questions" },
  ];

  const site = await prisma.site.create({ data: {
    name: mark, slug: mark, publicUrl: "https://tool-drafts.example.test", clientId: client.id,
    pages: { create: tools.map((_tool, index) => ({ title: `Page ${index}`, path: index === 0 ? "/" : `/page-${index}`, filePath: index === 0 ? "index.html" : `page-${index}.html`, sourceHtml: html(), sortOrder: index })) },
  }, include: { pages: { orderBy: { sortOrder: "asc" } } } });
  siteId = site.id;
  const row = (pageId: string) => prisma.sitePage.findUniqueOrThrow({ where: { id: pageId } });

  for (const [index, tool] of tools.entries()) {
    const pageId = site.pages[index]!.id;
    console.log(`\n${tool.name[0]!.toUpperCase()}${tool.name.slice(1)}, on a hosted page`);
    await check("saves its change as a draft and leaves the page's base where it was", async () => {
      const response = await tool.run(pageId);
      assert.equal(response.status, 200, response.body.error);
      const page = await row(pageId);
      assert.equal(page.sourceHtml, html(), "sourceHtml is what the draft is measured against");
      assert.ok(JSON.stringify(page.draft ?? null).includes(tool.live), "the change is in the draft");
    });
    await check("the draft is not stale, so the editor does not say publishing is blocked", async () => {
      const detail = await call("GET", `/pages/${pageId}`);
      assert.equal(detail.status, 200, detail.body.error);
      assert.equal((detail.body.structure as { stale?: boolean } | undefined)?.stale, false);
    });
    await check("and Publish puts the change live", async () => {
      const published = await call("POST", `/pages/${pageId}/publish`, {});
      assert.equal(published.status, 200, published.body.error);
      const page = await row(pageId);
      assert.ok(page.publishedHtml?.includes(tool.live), "the published page has the change");
      assert.equal(page.draft, null, "the draft was cleared by the publish");
    });
  }

  console.log("\nAuto-Optimize All Pages, with no page named");
  await check("saves generated tags as drafts on every page and says how many (it used to be refused outright)", async () => {
    const before = await prisma.sitePage.findMany({ where: { siteId }, select: { id: true, sourceHtml: true } });
    const response = await call("POST", `/sites/${siteId}/seo/auto-generate`, { applyDraft: true });
    assert.equal(response.status, 200, response.body.error?.trim());
    assert.equal(typeof response.body.updatedPages, "number");
    assert.ok((response.body.updatedPages as number) + (response.body.unchangedPages as number) === before.length, "every page is accounted for");
    for (const page of before) {
      assert.equal((await row(page.id)).sourceHtml, page.sourceHtml, "nothing is published and no base moves");
      const detail = await call("GET", `/pages/${page.id}`);
      assert.equal((detail.body.structure as { stale?: boolean } | undefined)?.stale, false);
    }
  });
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (siteId) await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.websitePurchase.deleteMany({ where: { userId: owner.id } });
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
  if (productId) await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.delete({ where: { id: owner.id } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
