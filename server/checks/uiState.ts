/**
 * What a person has been shown — guided tours, the welcome — kept on their
 * account (PATCH /api/auth/ui-state, client: lib/uiState.ts).
 *
 * The property that matters is that nothing undoes a finished tour: a slow tab
 * that reports "started" after another tab reported "done" must not put the
 * tour back, or a customer is offered it again on every device. Also: two tabs
 * finishing different tours both stick, `/auth/me` hands the state back, and
 * nothing but the three known keys is stored.
 *
 * Needs an isolated local database (name containing test, check or editor).
 *   npx tsx checks/uiState.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("uiState needs an isolated local test/editor database.");
}
// Real sessions: with DEV_NO_AUTH every request is the Owner and proves nothing.
process.env.DEV_NO_AUTH = "false";
const { prisma } = await import("../src/lib/prisma.js");
const { createSession } = await import("../src/lib/session.js");
const { attachUser } = await import("../src/middleware/auth.js");
const { authRouter } = await import("../src/routes/auth.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}`); }
}

const mark = `uistate-${randomUUID().slice(0, 8)}`;
const user = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Tour Taker" } });
const token = await createSession(user.id);
const app = express();
app.use(express.json());
app.use("/api", attachUser);
app.use("/api/auth", authRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
const send = (path: string, method = "GET", body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { Cookie: `dw_session=${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const at = new Date().toISOString();

try {
  let response = await send("/ui-state", "PATCH", { tours: { editor: { status: "started", step: 0, at } } });
  check("starting a tour is recorded", () => assert.equal(response.status, 200));
  response = await send("/ui-state", "PATCH", { tours: { editor: { status: "done", step: 6, at } } });
  await response.json();
  response = await send("/ui-state", "PATCH", { tours: { editor: { status: "started", step: 0, at } } });
  const afterLateStart = await response.json() as { tours: Record<string, { status: string }> };
  check("a late \"started\" never turns a finished tour back on", () => assert.equal(afterLateStart.tours.editor.status, "done"));

  await Promise.all([
    send("/ui-state", "PATCH", { tours: { publishing: { status: "dismissed", at } } }),
    send("/ui-state", "PATCH", { tours: { pictures: { status: "done", at } } }),
  ]);
  const stored = (await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { uiState: true } })).uiState as { tours: Record<string, { status: string }> };
  check("two tabs finishing different tours both stick", () => {
    assert.equal(stored.tours.publishing.status, "dismissed");
    assert.equal(stored.tours.pictures.status, "done");
    assert.equal(stored.tours.editor.status, "done");
  });

  response = await send("/ui-state", "PATCH", { welcome: { status: "skipped", at }, checklist: { hidden: true } });
  check("the welcome and the checklist are kept too", () => assert.equal(response.status, 200));

  response = await send("/me");
  const me = await response.json() as { uiState?: { tours?: Record<string, unknown>; welcome?: { status: string } } };
  check("/auth/me hands the state back, so a second device knows", () => {
    assert.equal(me.uiState?.welcome?.status, "skipped");
    assert.ok(me.uiState?.tours?.editor);
  });

  response = await send("/ui-state", "PATCH", { tours: { editor: { status: "done", at } }, theme: "dark" });
  check("anything but the known keys is refused", () => assert.equal(response.status, 400));
  response = await send("/ui-state", "PATCH", { tours: { "Not A Tour!": { status: "done", at } } });
  check("a tour name that is not a tour name is refused", () => assert.equal(response.status, 400));

  const flood = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`tour-${index}`, { status: "done", at }]));
  response = await send("/ui-state", "PATCH", { tours: flood });
  check("the record cannot be used to fill a column", () => assert.equal(response.status, 400));

  const anonymous = await fetch(`${base}/ui-state`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ checklist: { hidden: true } }) });
  check("nobody signed out can write one", () => assert.equal(anonymous.status, 401));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
