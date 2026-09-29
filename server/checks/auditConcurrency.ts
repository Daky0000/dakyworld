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
const local = localRateStore(2);
local.take("a", 100, 10, 0); local.take("b", 100, 10, 0);
assert.throws(() => local.take("c", 100, 10, 0), /capacity/);
assert.equal(local.size, 2);
local.take("c", 100, 10, 101);
assert.ok(local.size <= 2);

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
