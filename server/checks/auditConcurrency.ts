import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import { mapConcurrent, singleFlight } from "../src/lib/concurrency.js";
import { localRateStore, rateBucketKey, takeSharedRateBucket, clearSharedRateBucket } from "../src/lib/rateLimitStore.js";
import { withWebsitePublishLock, commitPublication } from "../src/services/websitePublishing.js";

let active = 0;
let peak = 0;
const output = await mapConcurrent(Array.from({ length: 20 }, (_, i) => i), 3, async value => {
  peak = Math.max(peak, ++active);
  await new Promise(resolve => setTimeout(resolve, 2));
  active--;
  return value * 2;
});
assert.equal(peak, 3);
assert.deepEqual(output, Array.from({ length: 20 }, (_, i) => i * 2));
let calls = 0;
const once = singleFlight(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 2)); });
await Promise.all(Array.from({ length: 10 }, () => once()));
assert.equal(calls, 1);
await once(); assert.equal(calls, 2);
const failing = singleFlight(async () => { throw new Error("failed tick"); });
await assert.rejects(failing(), /failed tick/);
await assert.rejects(failing(), /failed tick/);
// A full local store makes room rather than refusing: it used to throw, which
// the limiter answered with a 503 for every caller, the legitimate one too.
const local = localRateStore(2);
local.take("a", 100, 10, 0); local.take("b", 100, 10, 0);
assert.equal(local.take("c", 100, 10, 0).count, 1, "a full store still answers a new caller");
assert.equal(local.size, 2);
assert.equal(local.take("b", 100, 10, 0).count, 2, "the newer bucket kept its count");
assert.equal(local.take("a", 100, 10, 0).count, 1, "the oldest bucket was the one let go");
local.take("c", 100, 10, 101);
assert.ok(local.size <= 2);
const expiring = localRateStore(2);
expiring.take("live", 1_000, 10, 0); expiring.take("short", 10, 10, 0);
expiring.take("newcomer", 1_000, 10, 20);
assert.equal(expiring.take("live", 1_000, 10, 20).count, 2, "an expired bucket goes before a live one");
const flooded = localRateStore(100);
for (let i = 0; i < 10_000; i++) assert.equal(flooded.take(`caller-${i}`, 60_000, 5, 1).count, 1);
assert.equal(flooded.size, 100, "ten thousand distinct callers never grow it past its bound");
for (let i = 0; i < 5; i++) flooded.take("caller-9999", 60_000, 5, 1);
assert.ok(flooded.take("caller-9999", 60_000, 5, 1).count > 5, "and the caller still sending is still limited");

const suffix = randomUUID();
const id = rateBucketKey("audit-check", suffix);
try {
  const counters = await Promise.all(Array.from({ length: 30 }, () => takeSharedRateBucket(id, 60_000, 10)));
  assert.equal(counters.filter(row => row.count <= 10).length, 10, "all concurrent callers share one allowance");
  await clearSharedRateBucket(id);
  assert.equal((await takeSharedRateBucket(id, 60_000, 10)).count, 1);

  await withWebsitePublishLock(suffix, async () => {
    const open = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'idle in transaction'`;
    assert.equal(Number(open[0]!.count), 0, "network work does not hold an idle transaction");
    await assert.rejects(commitPublication(async tx => {
      await tx.appSetting.create({ data: { key: suffix, value: "must roll back" } });
      throw new Error("finalization failed");
    }), /finalization failed/);
    assert.equal(await prisma.appSetting.findUnique({ where: { key: suffix } }), null, "finalization stays atomic");

    await prisma.serviceLease.updateMany({ where: { key: `publication:page:${suffix}` }, data: { expiresAt: new Date(0) } });
    await withWebsitePublishLock(suffix, async () => undefined);
    await assert.rejects(commitPublication(async () => "stale owner"), /ownership expired/);
  });
  console.log("Audit concurrency: bounded fan-out, scheduler coalescing, shared limits, atomic completion and stale-owner fencing passed.");
} finally {
  await clearSharedRateBucket(id);
  await prisma.appSetting.deleteMany({ where: { key: suffix } });
  await prisma.serviceLease.deleteMany({ where: { key: `publication:page:${suffix}` } });
  await prisma.$disconnect();
}
