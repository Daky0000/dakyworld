/**
 * There is no AI switch: the Builder agent is on for every website.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/websiteAiOn.ts
 *
 * Until 22 Oct 2026 each website had one AI switch, on by default only for
 * Business sites, so every other site — the Owner's own connected WordPress
 * site among them — had no agent until somebody found the box, and anybody
 * could switch it off. The Owner's call: on for everybody, never off. Held
 * here: the agent answers on a Business site, on a site with no plan, and on a
 * site whose settings still say `aiEnabled: false`; the settings screen no
 * longer shows a switch; and sending one changes nothing.
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

await ensureSystemRoles();
const mark = `aion-${randomUUID().slice(0, 8)}`;
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

  console.log("\nThe agent answers everywhere");
  for (const [name, row] of [["a Business website", business], ["a website with no plan behind it", unpaid], ["a website whose settings still say aiEnabled: false", switchedOff]] as const) {
    await check(`on ${name}`, async () => {
      const response = await call("POST", `/sites/${row.id}/agent/plan`, undo(row));
      assert.equal(response.status, 200, response.body.error?.trim());
    });
  }

  console.log("\nThe settings screen");
  await check("shows no switch", async () => {
    const shown = (await call("GET", `/sites/${switchedOff.id}/design`)).body.options as Record<string, unknown>;
    assert.equal("aiEnabled" in shown, false);
  });
  await check("and sending one changes nothing: not saved, and the agent still answers", async () => {
    const response = await call("PUT", `/sites/${business.id}/design`, { aiEnabled: false });
    assert.equal(response.status, 200, response.body.error?.trim());
    assert.equal(response.body.saved, false);
    assert.equal((await call("POST", `/sites/${business.id}/agent/plan`, undo(business))).status, 200);
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
