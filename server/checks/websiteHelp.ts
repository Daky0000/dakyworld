/**
 * The editor's "Talk to a person" (GET /api/website/help).
 *
 * WhatsApp is offered only once a number has been set for it in System
 * settings — a link to a number that is not on WhatsApp is worse than no link —
 * and the link is built from digits only, so a number typed with spaces and a
 * plus still opens the right chat. A customer can read it; a stranger cannot.
 *
 * Needs an isolated local database (name containing test, check or editor).
 *   npx tsx checks/websiteHelp.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteHelp needs an isolated local test/editor database.");
}
process.env.DEV_NO_AUTH = "false";
const { prisma } = await import("../src/lib/prisma.js");
const { createSession } = await import("../src/lib/session.js");
const { attachUser, requireAuth, scopeExternal } = await import("../src/middleware/auth.js");
const { websiteRouter } = await import("../src/routes/website.js");
const { clearSystemProfileCache, companyProfile, saveCompanyProfile } = await import("../src/services/systemProfile.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}`); }
}

const mark = `helpcheck-${randomUUID().slice(0, 8)}`;
const before = await prisma.appSetting.findUnique({ where: { key: "system.profile" } });
const role = await prisma.accessRole.create({ data: { key: mark, name: mark, external: true, permissions: [] } });
const customer = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Customer", accessRoleId: role.id } });
const token = await createSession(customer.id);
const app = express();
app.use(express.json());
app.use("/api", attachUser, requireAuth, scopeExternal);
app.use("/api/website", websiteRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/website/help`;
type Help = { email: string; phone: string; whatsapp: { display: string; link: string } | null; guide: string };

async function setWhatsapp(whatsapp: string) {
  await saveCompanyProfile({ ...(await companyProfile()), whatsapp });
  clearSystemProfileCache();
}

try {
  await setWhatsapp("");
  let response = await fetch(base, { headers: { Cookie: `dw_session=${token}` } });
  let help = await response.json() as Help;
  check("a customer can read how to reach a person", () => { assert.equal(response.status, 200); assert.ok(help.email); assert.ok(help.phone); assert.match(help.guide, /website-builder-setup/); });
  check("no WhatsApp is offered until a number is set for it", () => assert.equal(help.whatsapp, null));

  await setWhatsapp("+233 54 595 0611");
  response = await fetch(base, { headers: { Cookie: `dw_session=${token}` } });
  help = await response.json() as Help;
  check("once it is, the link opens that chat, built from digits only", () => assert.equal(help.whatsapp?.link, "https://wa.me/233545950611"));

  const stranger = await fetch(base);
  check("somebody signed out is not given the numbers", () => assert.equal(stranger.status, 401));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Put the company's details back exactly as they were.
  if (before) await prisma.appSetting.update({ where: { key: "system.profile" }, data: { value: before.value } });
  else await prisma.appSetting.deleteMany({ where: { key: "system.profile" } });
  clearSystemProfileCache();
  await prisma.user.delete({ where: { id: customer.id } }).catch(() => {});
  await prisma.accessRole.delete({ where: { id: role.id } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
