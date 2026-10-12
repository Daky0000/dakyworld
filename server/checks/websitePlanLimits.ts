/**
 * What a plan's limits count, through the real routes and a real database.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/websitePlanLimits.ts
 *
 * Four ways the plans said one thing and did another:
 *
 * - **Every autosave spent one of the month's page edits.** The editor saves
 *   about a second after typing stops, so a Starter customer's thirty were gone
 *   in their first sitting. An edit is one page changed on one UTC day now.
 * - **"Unlimited AI runs" was two a day.** One `AI_DAILY_USER_LIMIT`, default 2,
 *   applied to every plan once admission was on. The daily number is the plan's.
 * - **A past-due subscription with no paid-up date was never locked.** A missing
 *   date answered "not locked", for ever.
 * - **A dollar customer's declined-payment notice quoted cedis.**
 *
 * Needs Postgres and nothing else: mail goes to a sink on a local port, and the
 * AI jobs are only queued, never run. Every row it makes is removed at the end.
 */
import assert from "node:assert/strict";
import express from "express";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

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

/* ------------------------------------------------- the daily AI numbers -- */

// Read in a child process, because they are fixed when the module loads — which
// is the point: a deployment's limits are decided at boot, not per request.
// An empty .env keeps the developer's own file out of it.
console.log("\nThe daily AI allowance, by plan");
const envDir = mkdtempSync(join(tmpdir(), "dakyworld-plan-limits-"));
const emptyEnv = join(envDir, ".env");
writeFileSync(emptyEnv, "");
const capacityUrl = new URL("../src/lib/capacity.ts", import.meta.url).href;
const tiersUrl = new URL("../src/services/websiteTierPlans.ts", import.meta.url).href;
function boot(env: Record<string, string>, withLabel = false) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: emptyEnv };
  for (const key of ["AI_DAILY_USER_LIMIT", "AI_DAILY_LIMIT_EDITOR", "AI_DAILY_LIMIT_CARE", "AI_DAILY_LIMIT_MANAGED"]) delete childEnv[key];
  Object.assign(childEnv, env);
  const script = `const { dailyAiLimit } = await import(${JSON.stringify(capacityUrl)});
    const label = ${withLabel} ? (await import(${JSON.stringify(tiersUrl)})).WEBSITE_TIER_PLANS.MANAGED.aiPromptsLimitLabel : null;
    console.log(JSON.stringify({ EDITOR: dailyAiLimit("EDITOR"), CARE: dailyAiLimit("CARE"), MANAGED: dailyAiLimit("MANAGED"), label }));
    process.exit(0);`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { env: childEnv, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) return { failed: result.stderr };
  return JSON.parse(result.stdout.trim().split("\n").pop()!) as { EDITOR: number; CARE: number; MANAGED: number; label: string | null };
}
try {
  await check("unset, the plans get their own numbers: Starter 0, Pro 10, Business 50", () => {
    assert.deepEqual(boot({}), { EDITOR: 0, CARE: 10, MANAGED: 50, label: null });
  });
  await check("each plan's number can be moved on its own", () => {
    assert.deepEqual(boot({ AI_DAILY_LIMIT_CARE: "3", AI_DAILY_LIMIT_MANAGED: "80" }), { EDITOR: 0, CARE: 3, MANAGED: 80, label: null });
  });
  await check("a blank line means the default, never zero", () => {
    assert.deepEqual(boot({ AI_DAILY_LIMIT_CARE: "", AI_DAILY_USER_LIMIT: " " }), { EDITOR: 0, CARE: 10, MANAGED: 50, label: null });
  });
  await check("the old single number, where it is set, still caps every plan", () => {
    assert.deepEqual(boot({ AI_DAILY_USER_LIMIT: "2" }), { EDITOR: 0, CARE: 2, MANAGED: 2, label: null });
    assert.deepEqual(boot({ AI_DAILY_USER_LIMIT: "20" }), { EDITOR: 0, CARE: 10, MANAGED: 20, label: null });
  });
  await check("a nonsense value stops the service at boot rather than switching AI off", () => {
    const refused = boot({ AI_DAILY_LIMIT_MANAGED: "-1" });
    assert.ok("failed" in refused && /Invalid AI_DAILY_LIMIT_MANAGED/.test(refused.failed), JSON.stringify(refused));
  });
  await check("Business's label states the number the queue enforces", () => {
    const label = (env: Record<string, string>) => {
      const booted = boot(env, true);
      return "failed" in booted ? booted.failed : booted.label;
    };
    assert.equal(label({}), "Unlimited AI runs (fair use: 50 a day)");
    assert.equal(label({ AI_DAILY_LIMIT_MANAGED: "30" }), "Unlimited AI runs (fair use: 30 a day)");
    assert.equal(label({ AI_DAILY_USER_LIMIT: "5" }), "Unlimited AI runs (fair use: 5 a day)", "under the old ceiling, the label says the ceiling");
  });
} finally {
  rmSync(envDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------- set-up ---- */

// Production's shape: admission on, so AI work goes through the queue whose
// daily limit is being checked. The numbers are pinned rather than left to the
// environment, so a developer's own .env cannot change what this asserts.
Object.assign(process.env, {
  DEV_NO_AUTH: "false",
  NODE_ENV: "development",
  JOB_ADMISSION_ENABLED: "true",
  AI_DAILY_USER_LIMIT: "",
  AI_DAILY_LIMIT_CARE: "10",
  AI_DAILY_LIMIT_MANAGED: "50",
});
delete process.env.RAILWAY_PROJECTED_MONTHLY_USD;

// A mail server on a local port that keeps what it is sent.
const delivered: string[] = [];
const sink = net.createServer((socket) => {
  socket.write("220 sink ESMTP\r\n");
  let data: string | null = null;
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("latin1");
    let at: number;
    while ((at = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (data !== null) {
        if (line === ".") { delivered.push(data); data = null; socket.write("250 2.0.0 queued\r\n"); }
        else data += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
        continue;
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === "EHLO" || verb === "HELO") socket.write("250-sink\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (verb === "AUTH") socket.write("235 2.7.0 ok\r\n");
      else if (verb === "DATA") { data = ""; socket.write("354 go\r\n"); }
      else if (verb === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
      else socket.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
  SMTP_HOST: "127.0.0.1", SMTP_PORT: String((sink.address() as AddressInfo).port), SMTP_SECURE: "false",
  SMTP_USER: "sink@plan-limits.test", SMTP_PASSWORD: "local-sink", MAIL_FROM_EMAIL: "sink@plan-limits.test", MAIL_TRANSPORT: "SMTP",
});

/** The readable text of a captured message, whatever transfer encoding each part used. */
function readable(raw: string): string {
  const unfolded = raw.replace(/=\r\n/g, "");
  const decodedQp = unfolded.replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const base64Parts = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n(?:[^\r\n]+\r\n)*\r\n([A-Za-z0-9+/=\r\n]+)/gi)]
    .map((match) => Buffer.from(match[1]!.replace(/\s/g, ""), "base64").toString("utf8"));
  return [decodedQp, ...base64Parts].join("\n");
}

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
const { assertEditAllowance, writePageEdit } = await import("../src/services/websiteTierPlans.js");
const { editingLockedForNonPayment, sendDunningNotice } = await import("../src/services/websiteDunning.js");
const { priceFor } = await import("../src/services/websitePricing.js");

await ensureSystemRoles();
const mark = `planlimits-${randomUUID().slice(0, 8)}`;
const ownerRole = await prisma.accessRole.findUniqueOrThrow({ where: { key: "owner" } });
const owner = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Ama Plan", role: "OWNER", accessRoleId: ownerRole.id } });
const cookie = `dw_session=${await createSession(owner.id)}`;

const app = express();
app.use(express.json({ limit: "8mb" })); app.use(attachUser); app.use("/api", requireAuth); app.use("/api/website", websiteRouter);
app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/website`;
async function call(method: string, url: string, data?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  const text = await response.text();
  let body: { error?: string } & Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* 204 or not JSON */ }
  return { status: response.status, body };
}

const html = '<!doctype html><html><head><title>Plan check</title></head><body><main><section data-dw-field="hero"><h1 data-dw-field="hero.title">Hello world</h1><p data-dw-field="hero.lede">First words</p></section></main></body></html>';
const siteIds: string[] = [];
let clientId: string | null = null;
let productId: string | null = null;

try {
  // Created while the account is still staff, so the site exists before the
  // plan under test is attached.
  const created = await call("POST", "/sites", { name: mark, publicUrl: "https://plan-limits.example.test", html });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const siteId = created.body.id as string;
  siteIds.push(siteId);
  const pageA = created.body.pageId as string;
  const extraPage = (slug: string) => prisma.sitePage.create({ data: { siteId, title: slug, path: `/${slug}`, filePath: `${slug}.html`, sourceHtml: html } });
  const pageB = (await extraPage("about")).id;
  const pageC = (await extraPage("contact")).id;

  const client = await prisma.client.create({ data: { name: `${mark}-client` } }); clientId = client.id;
  const product = await prisma.product.create({ data: { key: `${mark}-product`, name: `${mark} product`, monthlyPrice: 1 } }); productId = product.id;
  const purchase = await prisma.websitePurchase.create({ data: {
    clientId: client.id, productId: product.id, userId: owner.id, tier: "EDITOR", status: "ACTIVE", billingState: "ACTIVE",
    businessName: "Plan Shop", contactName: "Ama Plan", email: owner.email, websiteUrl: "https://plan-limits.example.test",
    compatibilityStatus: "COMPATIBLE", monthlyPrice: 1, setupPrice: 0, currency: "GHS",
    setupPaidAt: new Date(), activatedAt: new Date(), nextBillingAt: new Date(Date.now() + 20 * 86_400_000),
  } });

  const editsUsed = async () => (await prisma.websiteUsage.findUnique({ where: { userId_period: { userId: owner.id, period: usagePeriod() } } }))?.edits ?? 0;
  const setEdits = (edits: number) => prisma.websiteUsage.upsert({ where: { userId_period: { userId: owner.id, period: usagePeriod() } }, create: { userId: owner.id, period: usagePeriod(), edits }, update: { edits } });
  const revisionOf = async (pageId: string) => (await prisma.sitePage.findUniqueOrThrow({ where: { id: pageId } })).draftRevision;
  // "Yesterday", as far as the page row can tell: the stamp every change moves.
  const lastChangedYesterday = (pageId: string) => {
    const lastNight = new Date(Date.now() - (Date.now() % 86_400_000) - 3_600_000);
    return prisma.$executeRaw`UPDATE "SitePage" SET "updatedAt" = ${lastNight} WHERE "id" = ${pageId}`;
  };
  // Pages made a minute ago were changed today, and a page changed today edits
  // for free; these stand for pages a customer has had for a while.
  for (const pageId of [pageA, pageB, pageC]) await lastChangedYesterday(pageId);
  let words = 0;
  const save = async (pageId: string, values?: Record<string, unknown>) =>
    call("PUT", `/pages/${pageId}/draft`, { ifRevision: await revisionOf(pageId), values: values ?? { "hero.title": { value: `Draft ${++words}` } } });
  const restructure = async (pageId: string) =>
    call("POST", `/pages/${pageId}/structure`, { ifRevision: await revisionOf(pageId), kind: "duplicate", fieldId: "hero.lede" });

  /* --------------------------------------------- an edit is a page a day -- */

  console.log("\nAn edit is one page on one day (Starter, 30 a month)");
  await check("the first save of a page today spends one edit", async () => {
    assert.equal((await save(pageA)).status, 200);
    assert.equal(await editsUsed(), 1);
  });
  await check("saving the same page again today spends nothing — the autosave case", async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await save(pageA)).status, 200);
    assert.equal(await editsUsed(), 1);
  });
  await check("a save that empties the page's own draft does not start its day over", async () => {
    // Every save of a shared header leaves the page's own draft empty, and so
    // does undoing back to the page as it was. Both clear `draftSavedAt`.
    assert.equal((await save(pageA, {})).status, 200);
    assert.equal((await prisma.sitePage.findUniqueOrThrow({ where: { id: pageA } })).draftSavedAt, null);
    assert.equal((await save(pageA)).status, 200);
    assert.equal(await editsUsed(), 1);
  });
  await check("a different page counts on its own", async () => {
    assert.equal((await save(pageB)).status, 200);
    assert.equal(await editsUsed(), 2);
  });
  await check("the same page on the next day counts again", async () => {
    await lastChangedYesterday(pageA);
    assert.equal((await save(pageA)).status, 200);
    assert.equal(await editsUsed(), 3);
    assert.equal((await save(pageA)).status, 200);
    assert.equal(await editsUsed(), 3);
  });
  await check("a correction after publishing the page the same day is the same day's edit", async () => {
    await lastChangedYesterday(pageC);
    assert.equal((await save(pageC)).status, 200);
    assert.equal(await editsUsed(), 4);
    // What a publish does to the row: the draft and its date are cleared.
    await prisma.sitePage.update({ where: { id: pageC }, data: { draft: Prisma.DbNull, draftSavedAt: null, draftSavedById: null, lastPublishedAt: new Date(), draftRevision: { increment: 1 } } });
    assert.equal((await save(pageC)).status, 200);
    assert.equal(await editsUsed(), 4);
  });
  await check("a save refused as a conflict spends nothing", async () => {
    await lastChangedYesterday(pageB);
    const stale = await call("PUT", `/pages/${pageB}/draft`, { ifRevision: (await revisionOf(pageB)) - 1, values: { "hero.title": { value: "Stale" } } });
    assert.equal(stale.status, 409);
    assert.equal(await editsUsed(), 4);
  });

  /* ------------------------------------------------------------ the race -- */

  console.log("\nTwo saves at once");
  await check("two saves of one page arriving together: one is kept, one edit is spent", async () => {
    await lastChangedYesterday(pageB);
    const revision = await revisionOf(pageB);
    const both = await Promise.all([1, 2].map((n) => call("PUT", `/pages/${pageB}/draft`, { ifRevision: revision, values: { "hero.title": { value: `Race ${n}` } } })));
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await editsUsed(), 5);
  });
  await check("the write decides, not the read before it", async () => {
    // Both saves were checked against a copy of the page read before either
    // wrote — the copy says "not changed today" to each of them.
    await lastChangedYesterday(pageB);
    const staleCopy = await prisma.sitePage.findUniqueOrThrow({ where: { id: pageB } });
    const req = { dbUser: await prisma.user.findUniqueOrThrow({ where: { id: owner.id }, include: { accessRole: true } }), headers: {} } as never;
    const allowance = await assertEditAllowance(req, siteId, staleCopy);
    const first = await prisma.$transaction((tx) => writePageEdit(tx, allowance, { id: pageB, draftRevision: staleCopy.draftRevision }, { draftRevision: { increment: 1 } }));
    const second = await prisma.$transaction((tx) => writePageEdit(tx, allowance, { id: pageB, draftRevision: staleCopy.draftRevision + 1 }, { draftRevision: { increment: 1 } }));
    assert.deepEqual([first, second], [{ count: 1, counted: true }, { count: 1, counted: false }]);
    assert.equal(await editsUsed(), 6);
  });
  await check("two writes of one revision in flight together count once between them", async () => {
    await lastChangedYesterday(pageB);
    const revision = await revisionOf(pageB);
    const allowance = { userId: owner.id, now: new Date() };
    const both = await Promise.all([1, 2].map(() => prisma.$transaction((tx) => writePageEdit(tx, allowance, { id: pageB, draftRevision: revision }, { draftRevision: { increment: 1 } }))));
    assert.deepEqual(both.map((r) => `${r.count}:${r.counted}`).sort(), ["0:false", "1:true"]);
    assert.equal(await editsUsed(), 7);
  });

  /* ----------------------------------------------------------- the limit -- */

  console.log("\nAt the limit");
  await setEdits(30);
  await check("a page already changed today can still be saved", async () => {
    assert.equal((await save(pageA)).status, 200);
    assert.equal(await editsUsed(), 30);
  });
  await check("a save that would count is refused, says why, and writes nothing", async () => {
    await lastChangedYesterday(pageB);
    const before = await revisionOf(pageB);
    const refused = await save(pageB);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error ?? "", /Monthly page edit limit reached \(30\/30\)/);
    assert.match(refused.body.error ?? "", /already changed today can still be edited/);
    assert.match(refused.body.error ?? "", /a page counts once a day/, "the upgrade names what is counted");
    assert.equal(await revisionOf(pageB), before);
    assert.equal(await editsUsed(), 30);
  });
  await check("a layout change follows the same rule: allowed on a page changed today", async () => {
    const moved = await restructure(pageA);
    assert.equal(moved.status, 200, moved.body.error);
    assert.equal(await editsUsed(), 30);
  });
  await check("…and refused on one that is not", async () => {
    const before = await revisionOf(pageB);
    const refused = await restructure(pageB);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error ?? "", /Monthly page edit limit reached/);
    assert.equal(await revisionOf(pageB), before);
  });
  await setEdits(10);
  await check("layout changes count once a page a day, as saves do", async () => {
    assert.equal((await restructure(pageB)).status, 200);
    assert.equal(await editsUsed(), 11);
    assert.equal((await restructure(pageB)).status, 200);
    assert.equal(await editsUsed(), 11);
  });

  /* ------------------------------------------- past due, with no date ---- */

  console.log("\nPast due with no paid-up date");
  const pastDue = (state: string, nextBillingAt: Date | null, daysSinceWritten: number) =>
    prisma.$executeRaw`UPDATE "WebsitePurchase" SET "billingState" = ${state}, "nextBillingAt" = ${nextBillingAt}, "updatedAt" = ${new Date(Date.now() - daysSinceWritten * 86_400_000)} WHERE "id" = ${purchase.id}`;
  await check("is locked once the fortnight has passed since it was marked past due", async () => {
    await pastDue("PAST_DUE", null, 15);
    assert.equal(await editingLockedForNonPayment(purchase.id), true);
    const refused = await save(pageA);
    assert.equal(refused.status, 402);
    assert.match(refused.body.error ?? "", /Editing is paused/);
  });
  await check("is not locked inside the fortnight", async () => {
    await pastDue("PAST_DUE", null, 13);
    assert.equal(await editingLockedForNonPayment(purchase.id), false);
  });
  await check("a subscription that is not past due is never locked, however old", async () => {
    await pastDue("ACTIVE", null, 400);
    assert.equal(await editingLockedForNonPayment(purchase.id), false);
    await pastDue("CANCELLED", null, 400);
    assert.equal(await editingLockedForNonPayment(purchase.id), false);
  });
  await check("a paid-up date, where there is one, is what the fortnight runs from", async () => {
    await pastDue("PAST_DUE", new Date(Date.now() - 3 * 86_400_000), 30);
    assert.equal(await editingLockedForNonPayment(purchase.id), false);
    await pastDue("PAST_DUE", new Date(Date.now() - 15 * 86_400_000), 0);
    assert.equal(await editingLockedForNonPayment(purchase.id), true);
  });
  await pastDue("ACTIVE", new Date(Date.now() + 20 * 86_400_000), 0);

  /* ----------------------------------------- the notice, in their money -- */

  console.log("\nThe declined-payment notice");
  for (const currency of ["USD", "GHS"] as const) {
    await check(`a ${currency} purchase is told its price in ${currency === "USD" ? "dollars" : "cedis"}`, async () => {
      await prisma.websitePurchase.update({ where: { id: purchase.id }, data: { tier: "MANAGED", currency, billingState: "PAST_DUE" } });
      delivered.length = 0;
      await sendDunningNotice(purchase.id);
      assert.equal(delivered.length, 1, "one notice reached the mail server");
      const text = readable(delivered[0]!);
      const price = priceFor("MANAGED", currency).standardDisplay;
      assert.ok(text.includes(`payment (${price}/mo)`), `expected ${price}/mo in the notice`);
      if (currency === "USD") assert.ok(!/GHS/.test(text), "no cedi figure in a dollar customer's notice");
      else assert.ok(!/\(\$\d/.test(text), "no dollar figure in a cedi customer's notice");
    });
  }
  await prisma.websitePurchase.update({ where: { id: purchase.id }, data: { currency: "GHS", billingState: "ACTIVE" } });

  /* ----------------------------------------------- AI, a day at a time ---- */

  console.log("\nAI runs a day, through the queue");
  await prisma.site.update({ where: { id: siteId }, data: { settings: { aiEnabled: true } } });
  const jobsToday = (count: number) => prisma.$transaction([
    prisma.websiteWorkJob.deleteMany({ where: { userId: owner.id } }),
    prisma.websiteWorkJob.createMany({ data: Array.from({ length: count }, () => ({
      userId: owner.id, siteId, kind: "ASSISTANT", idempotencyKey: randomUUID().replace(/-/g, ""), inputHash: "done", input: {}, state: "COMPLETED", completedAt: new Date(),
    })) }),
  ]);
  const ask = () => call("POST", `/pages/${pageC}/assistant`, { prompt: "Make the heading warmer" }, { "Idempotency-Key": randomUUID().replace(/-/g, "") });
  const jobCount = () => prisma.websiteWorkJob.count({ where: { userId: owner.id } });

  await prisma.websitePurchase.update({ where: { id: purchase.id }, data: { tier: "CARE" } });
  await check("Pro: the eleventh run of the day is refused, naming the plan's number", async () => {
    await jobsToday(10);
    const refused = await ask();
    assert.equal(refused.status, 429, refused.body.error);
    assert.match(refused.body.error ?? "", /AI allowance on Pro \(10 a day\)/);
    assert.equal(await jobCount(), 10, "and nothing was queued");
  });
  await check("Pro: the tenth is queued", async () => {
    await jobsToday(9);
    const queued = await ask();
    assert.equal(queued.status, 202, queued.body.error);
    assert.equal(await jobCount(), 10);
  });

  // No subscription: this account is staff, so it is on Business.
  await prisma.websitePurchase.delete({ where: { id: purchase.id } });
  await check("Business: the old two-a-day ceiling is gone — the third run is queued", async () => {
    await jobsToday(2);
    const queued = await ask();
    assert.equal(queued.status, 202, queued.body.error);
  });
  await check("Business: fair use stops at fifty, and says so", async () => {
    await jobsToday(50);
    const refused = await ask();
    assert.equal(refused.status, 429, refused.body.error);
    assert.match(refused.body.error ?? "", /AI allowance on Business \(50 a day\)/);
    assert.equal(await jobCount(), 50);
  });
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => sink.close(() => resolve()));
  await prisma.websiteWorkJob.deleteMany({ where: { userId: owner.id } });
  await prisma.mailDelivery.deleteMany({ where: { toEmail: owner.email } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.websitePurchase.deleteMany({ where: { userId: owner.id } });
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
  if (productId) await prisma.product.deleteMany({ where: { id: productId } });
  // Usage and sessions go with the account.
  await prisma.user.delete({ where: { id: owner.id } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
