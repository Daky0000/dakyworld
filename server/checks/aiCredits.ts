/**
 * AI credits: what a request costs, which credits it spends, and a paid pack
 * arriving once.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/aiCredits.ts
 *
 * The Owner's call, 22 Oct 2026: every plan has a month's credits (Starter 30,
 * Pro 100, Business 300) spent first, and packs that never expire. A request
 * costs 1 when a free model answered it and 2, 3 or 5 — by the router's level
 * — when a paid one did; nothing when no model was asked. Held here: the cost
 * table, the month's credits before bought ones, all-or-nothing holding and
 * partial settling, bought credits given back first, a queued run settled by
 * what answered it and refunded when it failed, and a paid invoice granting
 * its pack once however often it is settled.
 *
 * Needs Postgres and nothing else. Every row it makes is removed at the end.
 */
import assert from "node:assert/strict";
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
    console.log(`FAIL  ${name}\n      ${(error as Error).message.trim().split("\n")[0]}${detail}`);
  }
}

const { prisma } = await import("../src/lib/prisma.js");
const { CREDIT_COST, creditsFor, takeCredits, settleCredits, creditBalance, CREDIT_PACKS } = await import("../src/services/aiCredits.js");
const { settleWebsiteUsage } = await import("../src/services/websiteWorkQueue.js");
const { settleManually } = await import("../src/services/payments.js");
const { usagePeriod } = await import("../src/services/websiteEntitlement.js");
const { WEBSITE_TIER_PLANS } = await import("../src/services/websiteTierPlans.js");

const mark = `credits-${randomUUID().slice(0, 8)}`;
const user = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Esi Credit", role: "CLIENT_VIEWER" } });
const period = usagePeriod();
const set = async (planUsed: number, bought: number) => {
  await prisma.websiteUsage.upsert({ where: { userId_period: { userId: user.id, period } }, create: { userId: user.id, period, aiPrompts: planUsed }, update: { aiPrompts: planUsed } });
  await prisma.user.update({ where: { id: user.id }, data: { aiCreditsBought: bought } });
};
const balance = () => creditBalance(user.id, 30);
let clientId: string | null = null;
let siteId: string | null = null;

try {
  console.log("\nWhat a request costs");
  await check("1 from a free model; 2, 3 or 5 from a paid one by the router's level; nothing with no model", () => {
    assert.equal(creditsFor({ provider: "nvidia", level: "complex" }), CREDIT_COST.free);
    assert.equal(creditsFor({ provider: "anthropic", level: "simple" }), 2);
    assert.equal(creditsFor({ provider: "openai", level: "standard" }), 3);
    assert.equal(creditsFor({ provider: "gemini", level: "complex" }), 5);
    assert.equal(creditsFor({ provider: "anthropic" }), 3, "a paid answer with no level is standard");
    assert.equal(creditsFor(null), 0);
    assert.equal(creditsFor({ provider: null }), 0);
  });
  await check("the plans' months: Starter 30, Pro 100, Business 300", () => {
    assert.deepEqual([WEBSITE_TIER_PLANS.EDITOR.aiPromptsLimit, WEBSITE_TIER_PLANS.CARE.aiPromptsLimit, WEBSITE_TIER_PLANS.MANAGED.aiPromptsLimit], [30, 100, 300]);
    assert.deepEqual(CREDIT_PACKS.map((pack) => [pack.credits, pack.amount]), [[100, 150], [300, 400], [1000, 1200]]);
  });

  console.log("\nWhich credits are spent");
  await check("the month's first, then bought ones", async () => {
    await set(28, 10);
    const took = await prisma.$transaction((tx) => takeCredits(tx, { userId: user.id, limit: 30, wanted: 5 }));
    assert.deepEqual(took, { plan: 2, bought: 3 });
    assert.deepEqual(await balance(), { planLimit: 30, planUsed: 30, planLeft: 0, bought: 7, total: 7 });
  });
  await check("holding is all or nothing: short by one takes nothing", async () => {
    await set(30, 2);
    const took = await prisma.$transaction((tx) => takeCredits(tx, { userId: user.id, limit: 30, wanted: 3 }));
    assert.equal(took, null);
    assert.equal((await balance()).bought, 2, "nothing was taken");
  });
  await check("settling takes what there is and says what was not covered", async () => {
    await set(30, 2);
    const charged = await prisma.$transaction((tx) => settleCredits(tx, { userId: user.id, limit: 30, held: { plan: 0, bought: 0 }, cost: 5, note: "Builder agent · complex · answered by a paid model" }));
    assert.deepEqual(charged, { plan: 0, bought: 2 });
    const entry = await prisma.aiCreditEntry.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    assert.equal(entry.boughtDelta, -2);
    assert.match(entry.note, /3 not covered/);
  });
  await check("a request that cost less than it held gives the bought credit back first", async () => {
    await set(29, 0);
    const charged = await prisma.$transaction(async (tx) => {
      const held = (await takeCredits(tx, { userId: user.id, limit: 30, wanted: 1 }))!;
      await tx.user.update({ where: { id: user.id }, data: { aiCreditsBought: { increment: 1 } } });
      return settleCredits(tx, { userId: user.id, limit: 30, held: { plan: held.plan, bought: 1 }, cost: 1, note: "x" });
    });
    assert.deepEqual(charged, { plan: 1, bought: 0 });
  });

  console.log("\nA queued run is settled by what answered it");
  const client = await prisma.client.create({ data: { name: `${mark}-client` } }); clientId = client.id;
  const site = await prisma.site.create({ data: { name: mark, slug: mark, publicUrl: "https://credits.example.test" } }); siteId = site.id;
  const job = async (held: { plan: number; bought: number }) => prisma.websiteWorkJob.create({ data: {
    userId: user.id, chargedUserId: user.id, siteId: site.id, kind: "BUILDER_PLAN", idempotencyKey: randomUUID().replace(/-/g, ""), inputHash: "x", input: {},
    usagePeriod: period, usageState: "RESERVED", creditsPlan: held.plan, creditsBought: held.bought, creditLimit: 30, state: "RUNNING",
  } });
  await check("a complex request a paid model answered costs 5: the held one and four more", async () => {
    await set(11, 0);
    const row = await job({ plan: 1, bought: 0 });
    await prisma.$transaction((tx) => settleWebsiteUsage(tx, row.id, true, { answeredBy: { provider: "anthropic", level: "complex" } }));
    assert.equal((await balance()).planUsed, 15);
    const settled = await prisma.websiteWorkJob.findUniqueOrThrow({ where: { id: row.id } });
    assert.deepEqual([settled.usageState, settled.creditsPlan, settled.creditsBought], ["ACCOUNTED", 5, 0]);
  });
  await check("one a free model answered costs the one it held", async () => {
    await set(11, 0);
    const row = await job({ plan: 1, bought: 0 });
    await prisma.$transaction((tx) => settleWebsiteUsage(tx, row.id, true, { answeredBy: { provider: "nvidia", level: "complex" } }));
    assert.equal((await balance()).planUsed, 11);
  });
  await check("one no model answered — undo, a fixed command — costs nothing", async () => {
    await set(11, 0);
    const row = await job({ plan: 1, bought: 0 });
    await prisma.$transaction((tx) => settleWebsiteUsage(tx, row.id, true, { explanation: "Undid the last change." }));
    assert.equal((await balance()).planUsed, 10);
  });
  await check("a run that failed before any model gives back what it held, to the pocket it came from", async () => {
    await set(30, 4);
    const row = await job({ plan: 0, bought: 1 });
    await prisma.$transaction((tx) => settleWebsiteUsage(tx, row.id, false));
    assert.equal((await balance()).bought, 5);
    await prisma.$transaction((tx) => settleWebsiteUsage(tx, row.id, false));
    assert.equal((await balance()).bought, 5, "and only once");
  });

  console.log("\nA paid pack");
  await check("paying the invoice adds the credits once, however often it is settled", async () => {
    await set(0, 0);
    const invoice = await prisma.invoice.create({ data: { clientId: client.id, invoiceNumber: `${mark}-1`, currency: "GHS", amountTotal: 150, status: "SENT", dueDate: new Date() } });
    await prisma.aiCreditPurchase.create({ data: { userId: user.id, invoiceId: invoice.id, packId: "credits_100", credits: 100 } });
    await settleManually(invoice.id);
    await settleManually(invoice.id);
    assert.equal((await balance()).bought, 100);
    assert.equal(await prisma.aiCreditEntry.count({ where: { userId: user.id, kind: "PURCHASE" } }), 1);
  });
  await check("an invoice that is not a pack grants nothing", async () => {
    const invoice = await prisma.invoice.create({ data: { clientId: client.id, invoiceNumber: `${mark}-2`, currency: "GHS", amountTotal: 600, status: "SENT", dueDate: new Date() } });
    await settleManually(invoice.id);
    assert.equal((await balance()).bought, 100);
  });
} finally {
  if (siteId) await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.websiteWorkJob.deleteMany({ where: { userId: user.id } });
  if (clientId) {
    await prisma.invoice.deleteMany({ where: { clientId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
  }
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
