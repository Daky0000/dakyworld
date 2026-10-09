/**
 * The API's view of whether the worker is alive.
 *
 * It reads the `background-runtime` lease the worker renews every 10 s for
 * 45 s. The arithmetic is the part a change would break silently. If the lease
 * length moves and this does not, a live worker either reads as dead (an
 * email every deploy) or a dead one reads as alive, which is how a five-hour
 * crash loop went unseen on 9 Oct 2026.
 *
 * Needs no database: the one read is stubbed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma.js";
import { ALERT_AFTER_MS, DOWN_AFTER_MS, isDown, needsAlert, workerStatus } from "../src/services/workerWatch.js";

const now = Date.UTC(2026, 9, 9, 12, 0, 0);
let expiresAt: Date | null = null;
const original = prisma.serviceLease.findUnique;
prisma.serviceLease.findUnique = (async ({ where }: { where: { key: string } }) => {
  assert.equal(where.key, "background-runtime", "the watcher must read the lease the worker renews");
  return expiresAt ? { expiresAt } : null;
}) as unknown as typeof original;

try {
  // Just renewed: expiry is 45 s ahead, so it was last seen now.
  expiresAt = new Date(now + 45_000);
  let status = await workerStatus(now);
  assert.equal(status.silentMs, 0);
  assert.equal(isDown(status), false);
  assert.equal(needsAlert(status), false);

  // Lease lapsed a moment ago: a deploy handing over, not an outage.
  expiresAt = new Date(now - 30_000);
  status = await workerStatus(now);
  assert.equal(status.silentMs, 75_000);
  assert.equal(isDown(status), false, "a handover must not read as down");

  // Quiet past the public threshold, not yet past the email one.
  expiresAt = new Date(now + 45_000 - DOWN_AFTER_MS - 1_000);
  status = await workerStatus(now);
  assert.equal(isDown(status), true);
  assert.equal(needsAlert(status), false, "a slow deploy must not email anybody");

  // A real outage.
  expiresAt = new Date(now + 45_000 - ALERT_AFTER_MS - 1_000);
  status = await workerStatus(now);
  assert.equal(needsAlert(status), true);
  assert.ok(status.lastSeen && status.lastSeen.getTime() === now - ALERT_AFTER_MS - 1_000);

  // Never ran: down for the monitor, but not an emergency to email about.
  expiresAt = null;
  status = await workerStatus(now);
  assert.equal(isDown(status), true);
  assert.equal(needsAlert(status), false);
} finally {
  prisma.serviceLease.findUnique = original;
}

// The lease the watcher reads is the one the worker writes, for as long as it says.
const runtime = readFileSync(new URL("../src/services/backgroundRuntime.ts", import.meta.url), "utf8");
assert.match(runtime, /acquireLease\("background-runtime", owner, 45\)/, "backgroundRuntime's lease changed: update RUNTIME_LEASE_SECONDS in workerWatch.ts");

console.log("workerWatch: lease read correctly, handover tolerated, outage alerted, empty database not alarmed");
