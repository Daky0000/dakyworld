/**
 * Developer requests: filed on the person's yes, numbered once, announced to
 * staff, and seen only by the people they concern.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/websiteEscalations.ts
 *
 * Until 21 Oct 2026 a request's number was recomputed from list positions on
 * every read (so the chat and the list could disagree), every site member saw
 * every request on the site, a site manager could mark one resolved, and no
 * one was told a request existed. Each of those is held here.
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

Object.assign(process.env, { DEV_NO_AUTH: "false", NODE_ENV: "development", JOB_ADMISSION_ENABLED: "false" });
delete process.env.OWNER_EMAIL;

const { prisma } = await import("../src/lib/prisma.js");
const { ensureSystemRoles } = await import("../src/lib/accessRoles.js");
const { createSession } = await import("../src/lib/session.js");
const { attachUser, requireAuth } = await import("../src/middleware/auth.js");
const { websiteRouter } = await import("../src/routes/website.js");
const { SETTING, clearSettingsCache, setSetting } = await import("../src/lib/settings.js");
const { FLAG, forgetFlags, setFlag } = await import("../src/lib/featureFlags.js");
const { developerRequestEmail } = await import("../src/services/websiteEscalationService.js");

await ensureSystemRoles();
const mark = `escalations-${randomUUID().slice(0, 8)}`;
const ownerRole = await prisma.accessRole.findUniqueOrThrow({ where: { key: "owner" } });
const staff = await prisma.user.create({ data: { email: `${mark}-staff@example.test`, name: "Kojo Staff", role: "OWNER", accessRoleId: ownerRole.id } });
const customerRole = await prisma.accessRole.create({ data: { key: mark, name: mark, external: true, permissions: [] } });
const [manager, editor, viewer] = await Promise.all(["manager", "editor", "viewer"].map((name) =>
  prisma.user.create({ data: { email: `${mark}-${name}@example.test`, name: `Ama ${name}`, accessRoleId: customerRole.id } })));
const cookies = Object.fromEntries(await Promise.all(
  ([["staff", staff], ["manager", manager!], ["editor", editor!], ["viewer", viewer!]] as const).map(async ([who, user]) => [who, `dw_session=${await createSession(user.id)}`] as const),
)) as Record<"staff" | "manager" | "editor" | "viewer", string>;

const app = express();
app.use(express.json()); app.use(attachUser); app.use("/api", requireAuth); app.use("/api/website", websiteRouter);
app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/website`;
async function call(who: keyof typeof cookies, method: string, url: string, data?: unknown) {
  const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", Cookie: cookies[who] }, body: data === undefined ? undefined : JSON.stringify(data) });
  const text = await response.text();
  let body: { error?: string } & Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body };
}

type Listed = { id: string; reportNumber: string; userPrompt: string };
// The two rows this check switches on, as they were, so they can be put back exactly.
delete process.env.SLACK_WEBHOOK_URL; delete process.env.SLACK_BOT_TOKEN;
const savedSettings = await prisma.appSetting.findMany({ where: { key: { in: [SETTING.SLACK_WEBHOOK_URL, FLAG.SLACK_QUEUE] } } });
let siteId = "";
let otherSiteId = "";
let clientId: string | null = null;
let productId: string | null = null;

try {
  // The agent is a Business feature, so the site is on Business.
  const client = await prisma.client.create({ data: { name: `${mark}-client` } }); clientId = client.id;
  const product = await prisma.product.create({ data: { key: `${mark}-product`, name: `${mark} product`, monthlyPrice: 1 } }); productId = product.id;
  await prisma.websitePurchase.create({ data: {
    clientId: client.id, productId: product.id, userId: manager!.id, tier: "MANAGED", status: "ACTIVE", billingState: "ACTIVE",
    businessName: "Request Shop", contactName: "Ama manager", email: manager!.email, websiteUrl: "https://requests.example.test",
    compatibilityStatus: "COMPATIBLE", monthlyPrice: 1, setupPrice: 0, currency: "GHS",
    setupPaidAt: new Date(), activatedAt: new Date(), nextBillingAt: new Date(Date.now() + 20 * 86_400_000),
  } });
  const site = await prisma.site.create({ data: {
    name: `${mark} site`, slug: mark, publicUrl: "https://requests.example.test", clientId: client.id,
    pages: { create: [{ title: "Home", path: "/", filePath: "index.html", sourceHtml: "<!doctype html><html><body><h1>Home</h1></body></html>" }] },
  }, include: { pages: true } });
  siteId = site.id;
  const pageId = site.pages[0]!.id;
  const other = await prisma.site.create({ data: { name: `${mark} other`, slug: `${mark}-other`, publicUrl: "https://other.example.test",
    pages: { create: [{ title: "Elsewhere", path: "/", filePath: "index.html", sourceHtml: "<p>x</p>" }] } }, include: { pages: true } });
  otherSiteId = other.id;
  await prisma.siteMember.createMany({ data: [
    { siteId, userId: manager!.id, role: "MANAGER" },
    { siteId, userId: editor!.id, role: "EDITOR" },
    { siteId, userId: viewer!.id, role: "VIEWER" },
  ] });

  // Slack is connected and the queue is on, so a notice is a SlackDelivery row.
  await setSetting(SETTING.SLACK_WEBHOOK_URL, "https://hooks.slack.invalid/escalations-check");
  await setFlag(FLAG.SLACK_QUEUE, true);
  clearSettingsCache(); forgetFlags();

  console.log("\nFiling a request");
  let filed: { ticketId: string; reportNumber: string } = { ticketId: "", reportNumber: "" };
  await check("the editor's Request developer help files one, with a stored number", async () => {
    const response = await call("editor", "POST", `/sites/${siteId}/agent/escalate`, { prompt: `${mark}: connect our booking system`, pageId });
    assert.equal(response.status, 200, response.body.error?.trim());
    filed = response.body as typeof filed;
    assert.match(filed.reportNumber, /^ESC-\d{4}-\d{3,}$/);
    const row = await prisma.websiteEscalation.findUniqueOrThrow({ where: { id: filed.ticketId } });
    assert.equal(row.reportNumber, filed.reportNumber, "the number the chat quoted is the one stored");
    assert.equal(row.userId, editor!.id);
    assert.equal(row.pageTitle, "Home", "the page's title is recorded with it");
  });
  await check("a second request gets the next number, not the same one", async () => {
    const response = await call("manager", "POST", `/sites/${siteId}/agent/escalate`, { prompt: `${mark}: add a members area` });
    assert.equal(response.status, 200, response.body.error?.trim());
    const [year, n] = [filed.reportNumber.slice(4, 8), Number(filed.reportNumber.slice(9))];
    assert.equal((response.body as { reportNumber: string }).reportNumber, `ESC-${year}-${String(n + 1).padStart(3, "0")}`);
  });
  await check("a page from another website is refused", async () => {
    const response = await call("editor", "POST", `/sites/${siteId}/agent/escalate`, { prompt: `${mark}: wrong page`, pageId: other.pages[0]!.id });
    assert.equal(response.status, 400);
  });
  await check("staff are told: a Slack notice is queued for each request", async () => {
    const rows = await prisma.slackDelivery.findMany({ where: { idempotencyKey: { startsWith: "website-escalation:" }, text: { contains: `${mark} site` } } });
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.text.includes(filed.reportNumber)), "the notice quotes the number");
  });
  await check("the email names the site, page, number, request and who asked", async () => {
    const row = await prisma.websiteEscalation.findUniqueOrThrow({ where: { id: filed.ticketId }, include: { site: { select: { id: true, name: true } } } });
    const email = developerRequestEmail(row, "https://editor.example.test/website/ai");
    const text = [email.subject, ...email.paragraphs].join("\n");
    for (const part of [`${mark} site`, "Home", filed.reportNumber, "connect our booking system", "Ama editor"]) assert.ok(text.includes(part), `the email mentions ${part}`);
    assert.equal(email.replyTo, editor!.email);
  });

  console.log("\nWho sees what");
  await check("staff see every request, with the number the chat quoted", async () => {
    const response = await call("staff", "GET", `/escalations?siteId=${siteId}`);
    assert.equal(response.status, 200, response.body.error?.trim());
    const items = response.body.items as Listed[];
    assert.equal(items.length, 2);
    assert.equal(items.find((item) => item.id === filed.ticketId)?.reportNumber, filed.reportNumber);
    assert.equal(response.body.canUpdate, true);
  });
  await check("the person who asked sees their own request and no one else's", async () => {
    const response = await call("editor", "GET", `/escalations?siteId=${siteId}`);
    assert.equal(response.status, 200, response.body.error?.trim());
    assert.deepEqual((response.body.items as Listed[]).map((item) => item.id), [filed.ticketId]);
    assert.equal(response.body.canUpdate, false);
  });
  await check("a viewer who asked for nothing sees nothing", async () => {
    const response = await call("viewer", "GET", "/escalations");
    assert.equal(response.status, 200, response.body.error?.trim());
    assert.equal((response.body.items as Listed[]).length, 0);
    assert.equal(response.body.openCount, 0);
  });
  await check("asking about a website you cannot reach is refused", async () => {
    const response = await call("editor", "GET", `/escalations?siteId=${otherSiteId}`);
    assert.ok([403, 404].includes(response.status), `got ${response.status}`);
  });

  console.log("\nSettling a request");
  await check("a site manager cannot mark a request resolved", async () => {
    const response = await call("manager", "PATCH", `/escalations/${filed.ticketId}`, { status: "RESOLVED" });
    assert.equal(response.status, 403);
  });
  await check("staff can", async () => {
    const response = await call("staff", "PATCH", `/escalations/${filed.ticketId}`, { status: "RESOLVED", ownerNotes: "Booking widget added." });
    assert.equal(response.status, 200, response.body.error?.trim());
    const row = await prisma.websiteEscalation.findUniqueOrThrow({ where: { id: filed.ticketId } });
    assert.equal(row.status, "RESOLVED");
    assert.equal(row.reportNumber, filed.reportNumber, "settling it does not renumber it");
  });
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.slackDelivery.deleteMany({ where: { idempotencyKey: { startsWith: "website-escalation:" }, text: { contains: mark } } });
  await prisma.appSetting.deleteMany({ where: { key: { in: [SETTING.SLACK_WEBHOOK_URL, FLAG.SLACK_QUEUE] } } });
  for (const row of savedSettings) await prisma.appSetting.create({ data: row });
  clearSettingsCache(); forgetFlags();
  for (const id of [siteId, otherSiteId]) if (id) await prisma.site.deleteMany({ where: { id } });
  await prisma.websitePurchase.deleteMany({ where: { userId: manager!.id } });
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
  if (productId) await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.session.deleteMany({ where: { userId: { in: [staff.id, manager!.id, editor!.id, viewer!.id] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [staff.id, manager!.id, editor!.id, viewer!.id] } } });
  await prisma.accessRole.deleteMany({ where: { id: customerRole.id } });
  await prisma.$disconnect();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
