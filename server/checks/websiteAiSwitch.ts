/**
 * One AI switch per website, on for Business unless somebody switched it off.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/websiteAiSwitch.ts
 *
 * Until 21 Oct 2026 the switch was the design assistant's alone and defaulted
 * to off, while the Builder agent ignored it. Held here: a Business site with
 * nothing saved is on, a site with no plan is off, the agent obeys the switch,
 * and the settings screen sending the switch back unchanged does not count as
 * changing it.
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
    console.log(`FAIL  ${name}\n      ${(error as Error).message.trim().split("\n")[0]}${detail}`);
  }
}

// Admission off: the plan is made in the request.
Object.assign(process.env, { DEV_NO_AUTH: "false", NODE_ENV: "development", JOB_ADMISSION_ENABLED: "false" });

const { prisma } = await import("../src/lib/prisma.js");
const { ensureSystemRoles } = await import("../src/lib/accessRoles.js");
const { createSession } = await import("../src/lib/session.js");
const { attachUser, requireAuth } = await import("../src/middleware/auth.js");
const { websiteRouter } = await import("../src/routes/website.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { siteAiEnabled } = await import("../src/services/websiteAiSwitch.js");

await ensureSystemRoles();
const mark = `aiswitch-${randomUUID().slice(0, 8)}`;
const ownerRole = await prisma.accessRole.findUniqueOrThrow({ where: { key: "owner" } });
const owner = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Yaw Switch", role: "OWNER", accessRoleId: ownerRole.id } });
const cookie = `dw_session=${await createSession(owner.id)}`;

const app = express();
app.use(express.json()); app.use(attachUser); app.use("/api", requireAuth); app.use("/api/website", websiteRouter);
app.use(errorHandler);
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

const siteIds: string[] = [];
let clientId: string | null = null;
let productId: string | null = null;

try {
  const client = await prisma.client.create({ data: { name: `${mark}-client` } }); clientId = client.id;
  const product = await prisma.product.create({ data: { key: `${mark}-product`, name: `${mark} product`, monthlyPrice: 1 } }); productId = product.id;
  await prisma.websitePurchase.create({ data: {
    clientId: client.id, productId: product.id, userId: owner.id, tier: "MANAGED", status: "ACTIVE", billingState: "ACTIVE",
    businessName: "Switch Shop", contactName: "Yaw Switch", email: owner.email, websiteUrl: "https://switch.example.test",
    compatibilityStatus: "COMPATIBLE", monthlyPrice: 1, setupPrice: 0, currency: "GHS",
    setupPaidAt: new Date(), activatedAt: new Date(), nextBillingAt: new Date(Date.now() + 20 * 86_400_000),
  } });
  async function site(suffix: string, data: Record<string, unknown> = {}) {
    const row = await prisma.site.create({ data: {
      name: `${mark} ${suffix}`, slug: `${mark}-${suffix}`, publicUrl: `https://${suffix}.switch.example.test`, ...data,
      pages: { create: [{ title: "Home", path: "/", filePath: "index.html", sourceHtml: "<!doctype html><html><body><h1>Home</h1></body></html>" }] },
    }, include: { pages: true } });
    siteIds.push(row.id);
    return row;
  }
  const business = await site("business", { clientId: client.id });
  const switchedOff = await site("off", { clientId: client.id, settings: { aiEnabled: false } });
  const unpaid = await site("unpaid");
  const undo = (row: { pages: Array<{ id: string }> }) => ({ action: "instruction", prompt: "Undo my last change", pageId: row.pages[0]!.id });

  console.log("\nWhat the switch says");
  await check("a Business website nobody has chosen for is on", async () => {
    assert.equal(await siteAiEnabled(business), true);
    assert.equal((await call("GET", `/sites/${business.id}/design`)).body.options && ((await call("GET", `/sites/${business.id}/design`)).body.options as { aiEnabled: boolean }).aiEnabled, true);
  });
  await check("a website with no plan behind it is off until somebody switches it on", async () => {
    assert.equal(await siteAiEnabled(unpaid), false);
  });
  await check("a Business website somebody switched off stays off", async () => {
    assert.equal(await siteAiEnabled(switchedOff), false);
  });

  console.log("\nThe Builder agent obeys it");
  await check("the agent answers on a Business website with nothing saved", async () => {
    const response = await call("POST", `/sites/${business.id}/agent/plan`, undo(business));
    assert.equal(response.status, 200, response.body.error?.trim());
  });
  await check("and refuses, in a sentence, where AI is switched off", async () => {
    const response = await call("POST", `/sites/${switchedOff.id}/agent/plan`, undo(switchedOff));
    assert.equal(response.status, 403);
    assert.match(response.body.error ?? "", /AI is switched off for this website/);
  });
  await check("the fixed commands are not AI and still run", async () => {
    const response = await call("POST", `/sites/${switchedOff.id}/agent/plan`, { action: "replace_font", toFont: "Inter" });
    assert.equal(response.status, 200, response.body.error?.trim());
  });

  console.log("\nThe settings screen");
  await check("sending the switch back as it was shown is not a change", async () => {
    const shown = (await call("GET", `/sites/${business.id}/design`)).body.options as Record<string, unknown>;
    const response = await call("PUT", `/sites/${business.id}/design`, { aiEnabled: shown.aiEnabled });
    assert.equal(response.status, 200, response.body.error?.trim());
    assert.equal(response.body.saved, false);
  });
  await check("switching it off is saved, and the agent then refuses", async () => {
    const response = await call("PUT", `/sites/${business.id}/design`, { aiEnabled: false });
    assert.equal(response.status, 200, response.body.error?.trim());
    assert.equal((await call("POST", `/sites/${business.id}/agent/plan`, undo(business))).status, 403);
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
