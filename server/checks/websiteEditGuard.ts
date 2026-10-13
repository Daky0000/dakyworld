/**
 * Every way of changing a page's words is an edit, through the real routes.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/websiteEditGuard.ts
 *
 * The page save and the layout change were the only writes that checked the
 * plan. Find & replace, putting an old version back, copying one field out of
 * a version, inserting a ready-made section and saving a shared element all
 * changed a page's words with nothing counted and nothing refused — at the edit
 * limit, and while editing was paused because the card had been declined three
 * times. Publishing did not check the pause either, so a paused customer could
 * still change the site and put it live.
 *
 * Each now goes through the one guard: paused means refused, a change that
 * would be a page's first counted edit today is refused at the limit, and what
 * is counted is one page a day, however it was changed. Find & replace counts
 * each page it touches; putting a page back the way it already is counts
 * nothing; publishing a draft that was already counted counts nothing.
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

// Admission off: publishing runs in the request, which is the path that did
// not check the pause. The queued path is checked in websitePlanLimits.ts.
Object.assign(process.env, { DEV_NO_AUTH: "false", NODE_ENV: "development", JOB_ADMISSION_ENABLED: "false" });

// A clean UTC day to work in: "the same day" must not turn into tomorrow
// half-way through.
const msToMidnight = 86_400_000 - (Date.now() % 86_400_000);
if (msToMidnight < 120_000) await new Promise((resolve) => setTimeout(resolve, msToMidnight + 2_000));

const { prisma } = await import("../src/lib/prisma.js");
const { ensureSystemRoles } = await import("../src/lib/accessRoles.js");
const { createSession } = await import("../src/lib/session.js");
const { attachUser, requireAuth } = await import("../src/middleware/auth.js");
const { websiteRouter } = await import("../src/routes/website.js");
const { usagePeriod } = await import("../src/services/websiteEntitlement.js");

await ensureSystemRoles();
const mark = `editguard-${randomUUID().slice(0, 8)}`;
const ownerRole = await prisma.accessRole.findUniqueOrThrow({ where: { key: "owner" } });
const owner = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Efua Guard", role: "OWNER", accessRoleId: ownerRole.id } });
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

// Three pages of the same shape, so one section can be shared across them.
const html = (words = "Hello world") => `<!doctype html><html><head><title>Guard check</title></head><body><main><h1>Guard check</h1><section class="cta"><h2>${words}</h2><p>First words</p></section></main></body></html>`;
let siteId = "";
let clientId: string | null = null;
let productId: string | null = null;

try {
  const client = await prisma.client.create({ data: { name: `${mark}-client` } }); clientId = client.id;
  const product = await prisma.product.create({ data: { key: `${mark}-product`, name: `${mark} product`, monthlyPrice: 1 } }); productId = product.id;
  const purchase = await prisma.websitePurchase.create({ data: {
    clientId: client.id, productId: product.id, userId: owner.id, tier: "EDITOR", status: "ACTIVE", billingState: "ACTIVE",
    businessName: "Guard Shop", contactName: "Efua Guard", email: owner.email, websiteUrl: "https://edit-guard.example.test",
    compatibilityStatus: "COMPATIBLE", monthlyPrice: 1, setupPrice: 0, currency: "GHS",
    setupPaidAt: new Date(), activatedAt: new Date(), nextBillingAt: new Date(Date.now() + 20 * 86_400_000),
  } });
  const site = await prisma.site.create({ data: {
    name: mark, slug: mark, publicUrl: "https://edit-guard.example.test", clientId: client.id,
    pages: { create: ["/", "/about", "/contact"].map((path, sortOrder) => ({ title: path === "/" ? "Home" : path.slice(1), path, filePath: `${path === "/" ? "index" : path.slice(1)}.html`, sourceHtml: html(), sortOrder })) },
  }, include: { pages: { orderBy: { sortOrder: "asc" } } } });
  siteId = site.id;
  const [pageA, pageB, pageC] = site.pages.map((page) => page.id) as [string, string, string];

  const editsUsed = async () => (await prisma.websiteUsage.findUnique({ where: { userId_period: { userId: owner.id, period: usagePeriod() } } }))?.edits ?? 0;
  const setEdits = (edits: number) => prisma.websiteUsage.upsert({ where: { userId_period: { userId: owner.id, period: usagePeriod() } }, create: { userId: owner.id, period: usagePeriod(), edits }, update: { edits } });
  const row = (pageId: string) => prisma.sitePage.findUniqueOrThrow({ where: { id: pageId } });
  const draftText = async (pageId: string) => JSON.stringify((await row(pageId)).draft ?? null);
  const countedYesterday = (...pageIds: string[]) => {
    const lastNight = new Date(Date.now() - (Date.now() % 86_400_000) - 3_600_000);
    return prisma.$executeRaw`UPDATE "SitePage" SET "updatedAt" = ${lastNight}, "editCountedOn" = ${lastNight.toISOString().slice(0, 10)}::date WHERE "id" IN (${pageIds[0]}, ${pageIds[1] ?? pageIds[0]}, ${pageIds[2] ?? pageIds[0]})`;
  };
  await countedYesterday(pageA, pageB, pageC);
  const replace = (query: string, replacement: string) => call("POST", `/sites/${siteId}/find-replace/apply`, { query, replacement });

  /* ---------------------------------------------------- find & replace -- */

  console.log("\nFind & replace (Starter, 30 a month)");
  await setEdits(30);
  await check("at the limit, a replace across pages not changed today is refused and writes nothing", async () => {
    const refused = await replace("Hello", "Howdy");
    assert.equal(refused.status, 403, refused.body.error);
    assert.match(refused.body.error ?? "", /page edit limit/i);
    for (const pageId of [pageA, pageB, pageC]) assert.ok(!(await draftText(pageId)).includes("Howdy"), "no draft was touched");
    assert.equal(await editsUsed(), 30);
  });
  await check("with room, it counts once for each page it changes", async () => {
    await setEdits(10);
    const applied = await replace("Hello", "Howdy");
    assert.equal(applied.status, 200, applied.body.error);
    assert.equal(applied.body.affectedPagesCount, 3);
    for (const pageId of [pageA, pageB, pageC]) assert.ok((await draftText(pageId)).includes("Howdy world"));
    assert.equal(await editsUsed(), 13);
  });
  await check("and a second replace the same day on the same pages counts nothing more", async () => {
    assert.equal((await replace("Howdy", "Hi")).status, 200);
    assert.equal(await editsUsed(), 13);
  });
  await check("so at the limit it can still change pages already changed today", async () => {
    await setEdits(30);
    const applied = await replace("Hi world", "Hi there");
    assert.equal(applied.status, 200, applied.body.error);
    assert.equal(await editsUsed(), 30);
  });
  await check("it never needs more edits than are left: two left, three pages, nothing changed", async () => {
    await countedYesterday(pageA, pageB, pageC);
    await setEdits(28);
    const refused = await replace("Hi there", "Hey there");
    assert.equal(refused.status, 403, refused.body.error);
    assert.match(refused.body.error ?? "", /3 pages/);
    for (const pageId of [pageA, pageB, pageC]) assert.ok(!(await draftText(pageId)).includes("Hey there"));
    assert.equal(await editsUsed(), 28);
  });

  /* ---------------------------------------------------- version restore -- */

  console.log("\nPutting an old version back as the draft");
  const older = await prisma.sitePageVersion.create({ data: { pageId: pageA, number: 1, html: html("Older words") } });
  const asPublished = await prisma.sitePageVersion.create({ data: { pageId: pageB, number: 1, html: html() } });
  const restore = async (pageId: string, versionId: string) => call("POST", `/pages/${pageId}/versions/${versionId}/restore`, { ifRevision: (await row(pageId)).draftRevision });
  await check("at the limit, a restore that would be the page's first edit today is refused", async () => {
    await setEdits(30);
    const before = await row(pageA);
    const refused = await restore(pageA, older.id);
    assert.equal(refused.status, 403, refused.body.error);
    assert.equal((await row(pageA)).draftRevision, before.draftRevision, "nothing written");
  });
  await check("with room, it counts", async () => {
    await setEdits(10);
    const restored = await restore(pageA, older.id);
    assert.equal(restored.status, 200, restored.body.error);
    assert.ok((await draftText(pageA)).includes("Older words"));
    assert.equal(await editsUsed(), 11);
  });
  await check("putting the page back the way it already is counts nothing, even at the limit tomorrow", async () => {
    await countedYesterday(pageA);
    await setEdits(30);
    const again = await restore(pageA, older.id);
    assert.equal(again.status, 200, again.body.error);
    assert.equal(await editsUsed(), 30);
    assert.equal((await row(pageA)).editCountedOn?.toISOString().slice(0, 10), new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), "and does not mark the page counted");
  });
  await check("nor does restoring the version the page already says, which only clears the draft", async () => {
    await countedYesterday(pageB);
    const cleared = await restore(pageB, asPublished.id);
    assert.equal(cleared.status, 200, cleared.body.error);
    assert.equal(cleared.body.empty, true);
    assert.equal(await editsUsed(), 30);
  });

  /* -------------------------------------------------------- cherry-pick -- */

  console.log("\nCopying one field out of a version");
  const picked = await prisma.sitePageVersion.create({ data: { pageId: pageC, number: 1, html: html("Picked words"), values: { "s0.0": { value: "Picked words", original: "Hello world" } } } });
  const cherryPick = () => call("POST", `/pages/${pageC}/versions/${picked.id}/cherry-pick`, { fieldId: "s0.0" });
  await check("at the limit, it is refused like any other first edit of the day", async () => {
    await countedYesterday(pageC);
    const refused = await cherryPick();
    assert.equal(refused.status, 403, refused.body.error);
    assert.ok(!(await draftText(pageC)).includes("Picked words"));
  });
  await check("with room, it counts", async () => {
    await setEdits(10);
    const copied = await cherryPick();
    assert.equal(copied.status, 200, copied.body.error);
    assert.ok((await draftText(pageC)).includes("Picked words"));
    assert.equal(await editsUsed(), 11);
  });

  /* ----------------------------------------------------- insert section -- */

  console.log("\nInserting a ready-made section");
  const insert = (pageId: string) => call("POST", `/sites/${siteId}/pages/${pageId}/insert-section`, { templateId: "faq" });
  await check("at the limit, it is refused and the page is untouched", async () => {
    await countedYesterday(pageB);
    await setEdits(30);
    const before = await row(pageB);
    const refused = await insert(pageB);
    assert.equal(refused.status, 403, refused.body.error);
    assert.equal((await row(pageB)).draftRevision, before.draftRevision);
  });
  await check("with room, it counts once for the page", async () => {
    await setEdits(10);
    assert.equal((await insert(pageB)).status, 200);
    assert.equal(await editsUsed(), 11);
    assert.equal((await insert(pageB)).status, 200);
    assert.equal(await editsUsed(), 11);
  });

  /* ---------------------------------------------------- shared elements -- */

  console.log("\nSaving a shared element");
  const shared = await call("POST", `/sites/${siteId}/shared`, { name: "Call to action", pageId: pageA, fieldId: "layout.1", instances: [{ pageId: pageC, fieldId: "layout.1" }] });
  assert.equal(shared.status, 201, JSON.stringify(shared.body));
  const sharedId = shared.body.id as string;
  const sharedRevision = async () => (await prisma.sharedElement.findUniqueOrThrow({ where: { id: sharedId } })).draftRevision;
  const saveShared = async (words: string) => call("PUT", `/shared/${sharedId}/draft`, { ifRevision: await sharedRevision(), pageId: pageA, values: { "0": { value: words } } });
  await check("at the limit, a shared save from a page not changed today is refused", async () => {
    await countedYesterday(pageA);
    await setEdits(30);
    const before = await sharedRevision();
    const refused = await saveShared("Shared words");
    assert.equal(refused.status, 403, refused.body.error);
    assert.equal(await sharedRevision(), before, "the shared element is untouched");
  });
  await check("with room, it counts once for the page it was typed on", async () => {
    await setEdits(10);
    assert.equal((await saveShared("Shared words")).status, 200);
    assert.equal(await editsUsed(), 11);
    assert.equal((await saveShared("Shared words, again")).status, 200);
    assert.equal(await editsUsed(), 11);
  });

  /* --------------------------------------------------- paused editing ---- */

  console.log("\nEditing paused for non-payment");
  await prisma.$executeRaw`UPDATE "WebsitePurchase" SET "billingState" = 'PAST_DUE', "nextBillingAt" = NULL, "updatedAt" = ${new Date(Date.now() - 15 * 86_400_000)} WHERE "id" = ${purchase.id}`;
  await setEdits(0);
  const revisions = async () => Promise.all([pageA, pageB, pageC].map(async (pageId) => (await row(pageId)).draftRevision));
  const frozen = await revisions();
  const frozenShared = await sharedRevision();
  const paused = (response: { status: number; body: { error?: string } }) => {
    assert.equal(response.status, 402, response.body.error);
    assert.match(response.body.error ?? "", /Editing is paused/);
  };
  await check("find & replace is refused", async () => paused(await replace("First words", "Paused")));
  await check("restoring a version is refused", async () => { await countedYesterday(pageA); paused(await restore(pageA, older.id)); });
  await check("copying a field out of a version is refused", async () => paused(await cherryPick()));
  await check("inserting a section is refused", async () => paused(await insert(pageB)));
  await check("saving a shared element is refused", async () => paused(await saveShared("Paused words")));
  await check("publishing a page is refused", async () => paused(await call("POST", `/pages/${pageA}/publish`, {})));
  await check("publishing an old version is refused", async () => paused(await call("POST", `/pages/${pageA}/versions/${older.id}/publish`, {})));
  await check("publishing a shared change is refused", async () => paused(await call("POST", `/shared/${sharedId}/publish`, { ifRevision: await sharedRevision(), pages: {} })));
  await check("and none of them wrote anything or spent anything", async () => {
    assert.deepEqual(await revisions(), frozen);
    assert.equal(await sharedRevision(), frozenShared);
    assert.equal(await editsUsed(), 0);
  });
  await prisma.websitePurchase.update({ where: { id: purchase.id }, data: { billingState: "ACTIVE", nextBillingAt: new Date(Date.now() + 20 * 86_400_000) } });

  /* -------------------------------------------------------- publishing --- */

  console.log("\nPublishing");
  await check("publishing a draft that was already counted spends nothing", async () => {
    await setEdits(10);
    const published = await call("POST", `/pages/${pageC}/publish`, {});
    assert.equal(published.status, 200, published.body.error);
    assert.equal((await row(pageC)).draft, null, "the draft went live");
    assert.equal(await editsUsed(), 10);
  });
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (siteId) await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.websitePurchase.deleteMany({ where: { userId: owner.id } });
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
  if (productId) await prisma.product.deleteMany({ where: { id: productId } });
  // Usage and sessions go with the account.
  await prisma.user.delete({ where: { id: owner.id } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
