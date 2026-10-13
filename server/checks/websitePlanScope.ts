/**
 * On a website, the plan is the website's, through the real routes.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/websitePlanScope.ts
 *
 * Business is sold with fifteen team accounts, and every one of them was on
 * Starter: the plan came from the signed-in person's own subscription, and a
 * colleague has none. On a Business website they were refused at thirty page
 * edits "on your Starter plan", refused the AI assistant, and measured against
 * 50 MB — so on a site with more media than that they could not upload at all.
 * The other way round, every colleague on a Starter website had thirty edits
 * of their own.
 *
 * On a website the plan, its limits and its counters are those of the client
 * the website belongs to — its live subscription and the account that pays for
 * it — whoever is signed in. DakyX staff keep the whole product there, and
 * what they use is their own: thirty fixes a Starter client asked DakyX for
 * used to spend the client's thirty edits and lock the client out of their own
 * website. Only a website with no paying owner falls
 * back to the person's own plan, which is what it always did. Whose plan
 * applies changes; who may do what on the website does not.
 *
 * Needs Postgres and nothing else: AI work is queued and run only as far as the
 * worker's own checks, never to a model. Every row it makes is removed.
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { WebsitePlanTier } from "@prisma/client";

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

// Production's shape: AI work goes through the queue. Numbers pinned so a
// developer's .env cannot move them.
Object.assign(process.env, {
  DEV_NO_AUTH: "false", NODE_ENV: "development", JOB_ADMISSION_ENABLED: "true",
  AI_DAILY_USER_LIMIT: "", AI_DAILY_LIMIT_CARE: "10", AI_DAILY_LIMIT_MANAGED: "50",
});
delete process.env.RAILWAY_PROJECTED_MONTHLY_USD;

const msToMidnight = 86_400_000 - (Date.now() % 86_400_000);
if (msToMidnight < 120_000) await new Promise((resolve) => setTimeout(resolve, msToMidnight + 2_000));

const { prisma } = await import("../src/lib/prisma.js");
const { ensureSystemRoles } = await import("../src/lib/accessRoles.js");
const { createSession } = await import("../src/lib/session.js");
const { attachUser, requireAuth } = await import("../src/middleware/auth.js");
const { websiteRouter } = await import("../src/routes/website.js");
const { usagePeriod } = await import("../src/services/websiteEntitlement.js");
const { runWebsiteWork } = await import("../src/services/websiteWorkQueue.js");

await ensureSystemRoles();
const mark = `planscope-${randomUUID().slice(0, 8)}`;
const staffRole = await prisma.accessRole.findUniqueOrThrow({ where: { key: "owner" } });
const customerRole = await prisma.accessRole.findFirstOrThrow({ where: { external: true } });
const person = (name: string, external = true) => prisma.user.create({ data: {
  email: `${mark}-${name.toLowerCase().replace(/\W+/g, "-")}@example.test`, name, role: external ? "DEVELOPER" : "OWNER",
  accessRoleId: external ? customerRole.id : staffRole.id, ...(external ? { extraPermissions: ["website.view"] } : {}),
} });
const businessOwner = await person("Abena Business");
const starterOwner = await person("Yaw Starter");
const colleague = await person("Kojo Colleague");
const viewer = await person("Esi Viewer");
const staff = await person("DakyX Staff", false);
const userIds = [businessOwner, starterOwner, colleague, viewer, staff].map((user) => user.id);
const cookies = new Map<string, string>();
for (const user of [businessOwner, starterOwner, colleague, viewer, staff]) cookies.set(user.id, `dw_session=${await createSession(user.id)}`);

const app = express();
app.use(express.json({ limit: "8mb" })); app.use(attachUser); app.use("/api", requireAuth); app.use("/api/website", websiteRouter);
app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/website`;
async function call(as: { id: string }, method: string, url: string, data?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", Cookie: cookies.get(as.id)!, ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  const text = await response.text();
  let body: { error?: string } & Record<string, any> = {};
  try { body = JSON.parse(text); } catch { /* 204 or not JSON */ }
  return { status: response.status, body };
}

const MB = 1024 * 1024;
const html = '<!doctype html><html><head><title>Scope check</title></head><body><main><section><h2>Hello world</h2><p>First words</p></section></main></body></html>';
// One transparent pixel, which is all an upload needs to be.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const clientIds: string[] = [];
const siteIds: string[] = [];
let productId: string | null = null;

try {
  const product = await prisma.product.create({ data: { key: `${mark}-product`, name: `${mark} product`, monthlyPrice: 1 } }); productId = product.id;
  const subscribe = async (buyer: { id: string; email: string }, tier: WebsitePlanTier, live = true) => {
    const client = await prisma.client.create({ data: { name: `${mark}-${tier}` } });
    clientIds.push(client.id);
    const purchase = await prisma.websitePurchase.create({ data: {
      clientId: client.id, productId: product.id, userId: buyer.id, tier, status: live ? "ACTIVE" : "CANCELLED", billingState: live ? "ACTIVE" : "CANCELLED",
      businessName: "Scope Shop", contactName: "Scope", email: buyer.email, websiteUrl: "https://plan-scope.example.test",
      compatibilityStatus: "COMPATIBLE", monthlyPrice: 1, setupPrice: 0, currency: "GHS",
      // A cancelled subscription whose paid-up date has passed entitles nobody.
      setupPaidAt: new Date(Date.now() - 60 * 86_400_000), activatedAt: new Date(Date.now() - 60 * 86_400_000),
      nextBillingAt: new Date(Date.now() + (live ? 20 : -2) * 86_400_000),
    } });
    return { client, purchase };
  };
  const website = async (name: string, clientId: string | null, members: Array<[{ id: string }, "MANAGER" | "EDITOR" | "VIEWER"]>) => {
    const site = await prisma.site.create({ data: {
      name: `${mark}-${name}`, slug: `${mark}-${name}`, publicUrl: `https://${name}.plan-scope.example.test`, clientId,
      settings: { aiEnabled: true },
      pages: { create: { title: "Home", path: "/", filePath: "index.html", sourceHtml: html } },
      members: { create: members.map(([user, role]) => ({ userId: user.id, role })) },
    }, include: { pages: true } });
    siteIds.push(site.id);
    return { siteId: site.id, pageId: site.pages[0]!.id };
  };

  const business = await subscribe(businessOwner, "MANAGED");
  const starter = await subscribe(starterOwner, "EDITOR");
  const lapsed = await subscribe(await person("Ama Lapsed"), "MANAGED", false);
  userIds.push(lapsed.purchase.userId!);
  const biz = await website("business", business.client.id, [[businessOwner, "MANAGER"], [colleague, "EDITOR"], [viewer, "VIEWER"]]);
  const small = await website("starter", starter.client.id, [[starterOwner, "MANAGER"], [colleague, "EDITOR"]]);
  const free = await website("unowned", null, [[colleague, "EDITOR"]]);
  const old = await website("lapsed", lapsed.client.id, [[colleague, "EDITOR"]]);
  const elsewhere = await website("elsewhere", business.client.id, [[businessOwner, "MANAGER"]]);

  const usageOf = async (user: { id: string }) => (await prisma.websiteUsage.findUnique({ where: { userId_period: { userId: user.id, period: usagePeriod() } } })) ?? { edits: 0, aiPrompts: 0, imports: 0 };
  const setEdits = (user: { id: string }, edits: number) => prisma.websiteUsage.upsert({ where: { userId_period: { userId: user.id, period: usagePeriod() } }, create: { userId: user.id, period: usagePeriod(), edits }, update: { edits } });
  const countedYesterday = (pageId: string) => {
    const lastNight = new Date(Date.now() - (Date.now() % 86_400_000) - 3_600_000);
    return prisma.$executeRaw`UPDATE "SitePage" SET "updatedAt" = ${lastNight}, "editCountedOn" = ${lastNight.toISOString().slice(0, 10)}::date WHERE "id" = ${pageId}`;
  };
  const save = async (as: { id: string }, pageId: string) => {
    await countedYesterday(pageId);
    const { draftRevision } = await prisma.sitePage.findUniqueOrThrow({ where: { id: pageId } });
    return call(as, "PUT", `/pages/${pageId}/draft`, { ifRevision: draftRevision, values: { "s0.0": { value: `Words ${randomUUID().slice(0, 6)}` } } });
  };
  const planOn = (as: { id: string }, siteId: string) => call(as, "GET", `/tier-status?siteId=${siteId}`);
  const ask = (as: { id: string }, pageId: string) => call(as, "POST", `/pages/${pageId}/assistant`, { prompt: "Make the heading warmer" }, { "Idempotency-Key": randomUUID().replace(/-/g, "") });

  /* ------------------------------------------------- a Business website -- */

  console.log("\nA colleague on a Business website");
  await check("is on Business there: no edit limit, the AI assistant, 5 GB", async () => {
    const plan = await planOn(colleague, biz.siteId);
    assert.equal(plan.status, 200, plan.body.error);
    assert.equal(plan.body.planCode, "MANAGED");
    assert.equal(plan.body.usage.editsLimit, null);
    assert.equal(plan.body.features.aiAssistant, true);
    assert.equal(plan.body.storage.quotaFormatted, "5 GB");
    assert.equal(plan.body.userEmail, colleague.email, "the screen is still about the person signed in");
  });
  await check("edits there whatever their own count says, and the edit is the owner's", async () => {
    await setEdits(colleague, 30);
    const saved = await save(colleague, biz.pageId);
    assert.equal(saved.status, 200, saved.body.error);
    assert.equal((await usageOf(businessOwner)).edits, 1);
    assert.equal((await usageOf(colleague)).edits, 30);
    await setEdits(colleague, 0);
  });
  await check("two people saving two pages at once both keep their saves, and both are counted on the one plan", async () => {
    // With no counter row yet for the month, both reach the insert together:
    // the count must never be what refuses, or rolls back, either save.
    const about = await prisma.sitePage.create({ data: { siteId: biz.siteId, title: "About", path: "/about", filePath: "about.html", sourceHtml: html } });
    await prisma.websiteUsage.deleteMany({ where: { userId: businessOwner.id } });
    const both = await Promise.all([save(colleague, biz.pageId), save(businessOwner, about.id)]);
    assert.deepEqual(both.map((response) => response.status), [200, 200]);
    assert.equal((await usageOf(businessOwner)).edits, 2);
  });
  let jobId = "";
  await check("can ask the AI assistant, and the run is counted against the owner", async () => {
    const queued = await ask(colleague, biz.pageId);
    assert.equal(queued.status, 202, queued.body.error);
    jobId = queued.body.jobId;
    const job = await prisma.websiteWorkJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.userId, colleague.id, "the job is still the colleague's, for access");
    assert.equal(job.chargedUserId, businessOwner.id);
    assert.equal((await usageOf(businessOwner)).aiPrompts, 1);
    assert.equal((await usageOf(colleague)).aiPrompts, 0);
  });
  await check("and the worker, re-checking it as the colleague, finds the plan the request did", async () => {
    // Switched off so the run stops at the website's own setting, after the
    // worker's checks and before any model is called.
    await prisma.site.update({ where: { id: biz.siteId }, data: { settings: { aiEnabled: false } } });
    const running = await prisma.websiteWorkJob.update({ where: { id: jobId }, data: { state: "RUNNING", leaseOwner: mark, leaseUntil: new Date(Date.now() + 60_000), attempts: 1 } });
    await runWebsiteWork(running);
    const finished = await prisma.websiteWorkJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(finished.state, "FAILED");
    assert.match(finished.error ?? "", /AI suggestions are disabled for this site/, "stopped by the site setting, not by a plan the colleague does not have");
    await prisma.site.update({ where: { id: biz.siteId }, data: { settings: { aiEnabled: true } } });
  });
  await check("a run that never reached a model goes back to the account it was counted against", async () => {
    assert.equal((await usageOf(businessOwner)).aiPrompts, 0);
    assert.equal((await usageOf(colleague)).aiPrompts, 0);
  });
  await check("their storage is the plan's websites, not every website they belong to", async () => {
    await prisma.siteAsset.create({ data: { siteId: biz.siteId, filename: "big.jpg", repoPath: `assets/dw/${randomUUID()}.jpg`, contentType: "image/jpeg", size: 60 * MB } });
    await prisma.siteAsset.create({ data: { siteId: free.siteId, filename: "theirs.jpg", repoPath: `assets/dw/${randomUUID()}.jpg`, contentType: "image/jpeg", size: 30 * MB } });
    await prisma.siteAsset.create({ data: { siteId: elsewhere.siteId, filename: "plan.jpg", repoPath: `assets/dw/${randomUUID()}.jpg`, contentType: "image/jpeg", size: 5 * MB } });
    const plan = await planOn(colleague, biz.siteId);
    assert.equal(plan.body.storage.usedBytes, 65 * MB, "both of the client's websites, and not the unowned one");
  });
  await check("so a website with more than Starter's 50 MB still takes their upload", async () => {
    const uploaded = await call(colleague, "POST", `/sites/${biz.siteId}/assets`, { filename: "pixel.png", data: PIXEL });
    assert.equal(uploaded.status, 201, uploaded.body.error);
  });
  await check("a payment problem on the owner's plan pauses the colleague's editing too", async () => {
    await prisma.$executeRaw`UPDATE "WebsitePurchase" SET "billingState" = 'PAST_DUE', "nextBillingAt" = NULL, "updatedAt" = ${new Date(Date.now() - 15 * 86_400_000)} WHERE "id" = ${business.purchase.id}`;
    const refused = await save(colleague, biz.pageId);
    assert.equal(refused.status, 402, refused.body.error);
    const queued = await ask(colleague, biz.pageId);
    assert.equal(queued.status, 403, queued.body.error);
    assert.match(queued.body.error ?? "", /Editing is paused/);
    await prisma.websitePurchase.update({ where: { id: business.purchase.id }, data: { billingState: "ACTIVE", nextBillingAt: new Date(Date.now() + 20 * 86_400_000) } });
  });
  await check("on Pro, colleagues share the plan's ten runs a day", async () => {
    await prisma.websitePurchase.update({ where: { id: business.purchase.id }, data: { tier: "CARE" } });
    await prisma.websiteWorkJob.deleteMany({ where: { siteId: { in: siteIds } } });
    await prisma.websiteWorkJob.createMany({ data: Array.from({ length: 10 }, () => ({
      userId: businessOwner.id, chargedUserId: businessOwner.id, siteId: biz.siteId, kind: "ASSISTANT", idempotencyKey: randomUUID().replace(/-/g, ""), inputHash: "done", input: {}, state: "COMPLETED", completedAt: new Date(),
    })) });
    const refused = await ask(colleague, biz.pageId);
    assert.equal(refused.status, 429, refused.body.error);
    assert.match(refused.body.error ?? "", /AI allowance on Pro \(10 a day\)/);
    await prisma.websitePurchase.update({ where: { id: business.purchase.id }, data: { tier: "MANAGED" } });
  });

  /* --------------------------------------------------- who may act -------- */

  console.log("\nWhose plan applies changes; who may act does not");
  await check("a viewer on a Business website still cannot edit it", async () => {
    const refused = await save(viewer, biz.pageId);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error ?? "", /does not include editing/);
  });
  await check("nobody can read the plan of a website they are not on", async () => {
    const refused = await planOn(colleague, elsewhere.siteId);
    assert.equal(refused.status, 404, JSON.stringify(refused.body).slice(0, 200));
  });

  /* --------------------------------------------------- a Starter website -- */

  console.log("\nA colleague on a Starter website");
  await check("shares the owner's thirty edits rather than having thirty more", async () => {
    await setEdits(starterOwner, 30);
    const refused = await save(colleague, small.pageId);
    assert.equal(refused.status, 403, refused.body.error);
    assert.match(refused.body.error ?? "", /\(30\/30\) on this website's Starter/, "the plan is named as the website's, not theirs");
    assert.equal((await usageOf(colleague)).edits, 0);
  });
  await check("and an edit that fits is spent from that pool", async () => {
    await setEdits(starterOwner, 29);
    assert.equal((await save(colleague, small.pageId)).status, 200);
    assert.equal((await usageOf(starterOwner)).edits, 30);
    assert.equal((await usageOf(colleague)).edits, 0);
  });
  await check("DakyX staff working on the client's website spend their own allowance, never the client's", async () => {
    await setEdits(starterOwner, 10);
    const saved = await save(staff, small.pageId);
    assert.equal(saved.status, 200, saved.body.error);
    assert.equal((await usageOf(starterOwner)).edits, 10, "the client's thirty are untouched");
    assert.equal((await usageOf(staff)).edits, 1);
  });
  await check("so thirty fixes the client asked DakyX for do not lock the client out of their own website", async () => {
    await setEdits(starterOwner, 29);
    for (let fix = 0; fix < 3; fix += 1) assert.equal((await save(staff, small.pageId)).status, 200);
    assert.equal((await usageOf(starterOwner)).edits, 29);
    const own = await save(colleague, small.pageId);
    assert.equal(own.status, 200, own.body.error);
    assert.equal((await usageOf(starterOwner)).edits, 30, "the client's own edit is still the client's");
  });
  await check("and the AI they run there is theirs too, even where the client's plan has none", async () => {
    const queued = await ask(staff, small.pageId);
    assert.equal(queued.status, 202, queued.body.error);
    const job = await prisma.websiteWorkJob.findUniqueOrThrow({ where: { id: queued.body.jobId } });
    assert.equal(job.userId, staff.id);
    assert.equal(job.chargedUserId, staff.id);
    assert.equal((await usageOf(staff)).aiPrompts, 1);
    assert.equal((await usageOf(starterOwner)).aiPrompts, 0, "a Starter meter never shows AI it cannot have");
    const plan = await planOn(starterOwner, small.siteId);
    assert.equal(plan.body.usage.aiPromptsUsed, 0);
  });
  await check("but keep the whole product there: the client's limit or a payment problem does not stop them", async () => {
    assert.equal((await planOn(staff, small.siteId)).body.planCode, "MANAGED");
    await setEdits(starterOwner, 30);
    assert.equal((await save(staff, small.pageId)).status, 200, "a fix the client asked for, at their limit");
    assert.equal((await usageOf(starterOwner)).edits, 30);
    await prisma.$executeRaw`UPDATE "WebsitePurchase" SET "billingState" = 'PAST_DUE', "nextBillingAt" = NULL, "updatedAt" = ${new Date(Date.now() - 15 * 86_400_000)} WHERE "id" = ${starter.purchase.id}`;
    assert.equal((await save(staff, small.pageId)).status, 200, "while the client's editing is paused");
    assert.equal((await save(colleague, small.pageId)).status, 402, "which it still is for the client's own people");
    await prisma.websitePurchase.update({ where: { id: starter.purchase.id }, data: { billingState: "ACTIVE", nextBillingAt: new Date(Date.now() + 20 * 86_400_000) } });
  });

  /* ------------------------------------------- no paying owner: as before -- */

  console.log("\nA website with no paying owner");
  await check("a colleague is on their own plan there, as before", async () => {
    assert.equal((await planOn(colleague, free.siteId)).body.planCode, "EDITOR");
    assert.equal((await save(colleague, free.pageId)).status, 200);
    assert.equal((await usageOf(colleague)).edits, 1);
  });
  await check("so are staff, on their own staff plan", async () => {
    assert.equal((await planOn(staff, free.siteId)).body.planCode, "MANAGED");
    const before = (await usageOf(staff)).edits;
    assert.equal((await save(staff, free.pageId)).status, 200);
    assert.equal((await usageOf(staff)).edits, before + 1);
  });
  await check("a client whose subscription has run out is not a paying owner", async () => {
    assert.equal((await planOn(colleague, old.siteId)).body.planCode, "EDITOR");
    assert.equal((await save(colleague, old.pageId)).status, 200);
    assert.equal((await usageOf(colleague)).edits, 2);
    assert.equal((await usageOf({ id: lapsed.purchase.userId! })).edits, 0);
  });
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.websiteWorkJob.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { siteId: { in: siteIds } }] } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.websitePurchase.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  if (productId) await prisma.product.deleteMany({ where: { id: productId } });
  // Usage and sessions go with the accounts.
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
