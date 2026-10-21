/**
 * Publish All after the Builder agent asks what a page's own Publish asks.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/websiteAgentBatchPublish.ts
 *
 * Until 21 Oct 2026 `POST /agent/publish-batch` skipped the publish guard, did
 * not ask whether the site was scheduled for deletion, left its job
 * "committing" for ever when the commit failed, and with no pages named
 * published every draft on the site. Each is held here.
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

// Admission off: the batch publishes in the request.
Object.assign(process.env, { DEV_NO_AUTH: "false", NODE_ENV: "development", JOB_ADMISSION_ENABLED: "false" });
delete process.env.GITHUB_TOKEN;

const { prisma } = await import("../src/lib/prisma.js");
const { ensureSystemRoles } = await import("../src/lib/accessRoles.js");
const { createSession } = await import("../src/lib/session.js");
const { attachUser, requireAuth } = await import("../src/middleware/auth.js");
const { websiteRouter } = await import("../src/routes/website.js");
const { restoreDocument } = await import("../src/services/website/document.js");
const { pageSource } = await import("../src/services/website/site.js");

await ensureSystemRoles();
const mark = `batchpublish-${randomUUID().slice(0, 8)}`;
const ownerRole = await prisma.accessRole.findUniqueOrThrow({ where: { key: "owner" } });
const owner = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Esi Publisher", role: "OWNER", accessRoleId: ownerRole.id } });
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
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body };
}

const html = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>First words</p></main><footer><p>Footer</p></footer></body></html>`;
const siteIds: string[] = [];
let clientId: string | null = null;
let productId: string | null = null;

try {
  // The agent is a Business feature, so the client is on Business.
  const client = await prisma.client.create({ data: { name: `${mark}-client` } }); clientId = client.id;
  const product = await prisma.product.create({ data: { key: `${mark}-product`, name: `${mark} product`, monthlyPrice: 1 } }); productId = product.id;
  await prisma.websitePurchase.create({ data: {
    clientId: client.id, productId: product.id, userId: owner.id, tier: "MANAGED", status: "ACTIVE", billingState: "ACTIVE",
    businessName: "Batch Shop", contactName: "Esi Publisher", email: owner.email, websiteUrl: "https://batch.example.test",
    compatibilityStatus: "COMPATIBLE", monthlyPrice: 1, setupPrice: 0, currency: "GHS",
    setupPaidAt: new Date(), activatedAt: new Date(), nextBillingAt: new Date(Date.now() + 20 * 86_400_000),
  } });

  async function siteWithPages(suffix: string, extra: Record<string, unknown> = {}) {
    const site = await prisma.site.create({ data: {
      name: `${mark} ${suffix}`, slug: `${mark}-${suffix}`, publicUrl: `https://${suffix}.batch.example.test`, clientId: client.id, ...extra,
      pages: { create: ["Home", "About"].map((title, index) => ({ title, path: index ? "/about" : "/", filePath: index ? "about.html" : "index.html", sourceHtml: html(title), sortOrder: index })) },
    }, include: { pages: { orderBy: { sortOrder: "asc" } } } });
    siteIds.push(site.id);
    return site;
  }
  /** A draft that rewrites the page, as the agent's signed rewrites do. */
  async function draft(site: Awaited<ReturnType<typeof siteWithPages>>, pageIndex: number, rewrite: (source: string) => string) {
    const page = site.pages[pageIndex]!;
    const source = (await pageSource(site, page)).html;
    await prisma.sitePage.update({ where: { id: page.id }, data: { draft: restoreDocument(source, {}, rewrite(source), "Check edit") as object, draftRevision: { increment: 1 } } });
  }
  const ordinary = (source: string) => source.replace("First words", "Batch words");
  const redirect = (source: string) => source.replace("</head>", `<meta http-equiv="refresh" content="0; url=https://elsewhere.example.test"></head>`);

  console.log("\nThe publish guard");
  const guarded = await siteWithPages("guard");
  await draft(guarded, 0, ordinary);
  await draft(guarded, 1, redirect);
  await check("a page the guard refuses stops the batch, and the refusal names it", async () => {
    const response = await call("POST", `/sites/${guarded.id}/agent/publish-batch`, { pageIds: guarded.pages.map((page) => page.id) });
    assert.equal(response.status, 400, response.body.error);
    assert.match(response.body.error ?? "", /About/);
    const blocked = response.body.blockedPages as Array<{ title: string }>;
    assert.deepEqual(blocked.map((page) => page.title), ["About"]);
  });
  await check("and nothing on the site went live", async () => {
    const pages = await prisma.sitePage.findMany({ where: { siteId: guarded.id } });
    assert.ok(pages.every((page) => page.publishedHtml === null));
    assert.ok(pages.every((page) => page.draft !== null), "both drafts are still drafts");
  });
  await check("the pages must be named", async () => {
    const response = await call("POST", `/sites/${guarded.id}/agent/publish-batch`, {});
    assert.equal(response.status, 400);
  });
  await check("the page the guard is happy with publishes on its own", async () => {
    const response = await call("POST", `/sites/${guarded.id}/agent/publish-batch`, { pageIds: [guarded.pages[0]!.id] });
    assert.equal(response.status, 200, response.body.error);
    const page = await prisma.sitePage.findUniqueOrThrow({ where: { id: guarded.pages[0]!.id } });
    assert.ok(page.publishedHtml?.includes("Batch words"));
  });

  console.log("\nA site scheduled for deletion");
  const leaving = await siteWithPages("leaving", { deletionScheduledFor: new Date(Date.now() + 7 * 86_400_000) });
  await draft(leaving, 0, ordinary);
  await check("is refused, and the page stays a draft", async () => {
    const response = await call("POST", `/sites/${leaving.id}/agent/publish-batch`, { pageIds: [leaving.pages[0]!.id] });
    assert.equal(response.status, 409, response.body.error);
    assert.equal((await prisma.sitePage.findUniqueOrThrow({ where: { id: leaving.pages[0]!.id } })).publishedHtml, null);
  });

  console.log("\nA commit that fails");
  const unreachable = await siteWithPages("unreachable", { repoOwner: "dakyx-check-invalid", repoName: mark, repoBranch: "main" });
  await draft(unreachable, 0, ordinary);
  await check("leaves its job failed, with the reason, rather than committing for ever", async () => {
    const response = await call("POST", `/sites/${unreachable.id}/agent/publish-batch`, { pageIds: [unreachable.pages[0]!.id] });
    assert.ok(response.status >= 400, `got ${response.status}`);
    const job = await prisma.publishJob.findFirstOrThrow({ where: { siteId: unreachable.id }, orderBy: { createdAt: "desc" } });
    assert.equal(job.state, "COMMIT_FAILED");
    assert.ok(job.lastError && job.lastError.length > 0, "the reason is kept");
    assert.ok(job.finishedAt, "the job is finished");
  });
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (siteIds.length) await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.websitePurchase.deleteMany({ where: { userId: owner.id } });
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
  if (productId) await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.delete({ where: { id: owner.id } });
  await prisma.$disconnect();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
