import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCache, cacheKey, redisBackend, type CacheBackend } from "../src/lib/cache.js";
import { concurrencyGate, CapacityError } from "../src/lib/capacity.js";
import { sourceGeneration, writeCache, readCache, invalidateSource, clearSourceCache } from "../src/services/website/sourceCache.js";

const generations = new Map<string, string>();
const values = new Map<string, string>();
const backend: CacheBackend = {
  async generation(key) { if (!generations.has(key)) generations.set(key, randomUUID()); return generations.get(key)!; },
  async get(key) { return values.get(key) ?? null; },
  async put(key, gkey, generation, value) { if (generations.get(gkey) === generation) values.set(key, value); },
  async invalidate(key) { generations.set(key, randomUUID()); },
};
const cache = createCache(backend, true);
const key = { scope: "site:a:user:u", resource: "metadata", identity: "page" };
let loads = 0;
const loader = async () => { loads++; await new Promise(resolve => setTimeout(resolve, 10)); return { secret: "a" }; };
await Promise.all(Array.from({ length: 50 }, () => cache.getOrLoad(key, { ttlMs: 1000 }, loader)));
assert.equal(loads, 1, "coalesces concurrent misses");
await cache.getOrLoad(key, { ttlMs: 1000 }, loader); assert.equal(loads, 1);
assert.notEqual(cacheKey(key), cacheKey({ ...key, scope: "site:b:user:u" }));
assert.notEqual(cacheKey(key), cacheKey({ ...key, revision: "2" }));
await cache.invalidate(key.scope, key.resource);
await cache.getOrLoad(key, { ttlMs: 1000 }, loader); assert.equal(loads, 2);
let release!: () => void;
const waiting = new Promise<void>(resolve => { release = resolve; });
const raceKey = { ...key, identity: "race" };
const racing = cache.getOrLoad(raceKey, { ttlMs: 1000 }, async () => { await waiting; return "old"; });
await new Promise(resolve => setTimeout(resolve, 5));
await cache.invalidate(key.scope, key.resource); release(); await racing;
assert.equal(await cache.getOrLoad(raceKey, { ttlMs: 1000 }, async () => "new"), "new", "invalidated fetch cannot refill the current generation");
const before = values.size;
await cache.getOrLoad({ ...key, identity: "large" }, { ttlMs: 1000, maxBytes: 10 }, async () => "too large to cache");
assert.equal(values.size, before);
const broken = createCache({ ...backend, generation: async () => { throw new Error("offline"); } }, true);
assert.equal(await broken.getOrLoad(key, { ttlMs: 1000 }, async () => "database"), "database");
const gate = concurrencyGate(1);
let finish!: () => void;
const running = gate(() => new Promise<void>(resolve => { finish = resolve; }));
await assert.rejects(gate(async () => 1), CapacityError); finish(); await running;
clearSourceCache(); const generation = sourceGeneration(); invalidateSource("a");
writeCache("a|repo|main|file|", { html: "old", from: "repository" }, generation);
assert.equal(readCache("a|repo|main|file|"), null);
writeCache("a|repo|main|file|", { html: "x".repeat(1024 * 1024 + 1), from: "repository" });
assert.equal(readCache("a|repo|main|file|"), null);
console.log("Cache isolation, coalescing, invalidation race, size limit, outage fallback, and admission checks passed.");

if (process.argv.includes("--redis")) {
  const url = new URL(process.env.REDIS_URL ?? "");
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Redis checks require a local disposable instance");
  const backend = redisBackend()!;
  const scope = `test:${randomUUID()}`;
  try {
    for (let attempt = 0; ; attempt++) {
      try { await backend.generation(`${scope}:ready`); break; }
      catch (error) { if (attempt >= 20) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const cache = createCache(backend, true);
    const key = { scope, resource: "test", identity: "value" };
    let calls = 0;
    const load = async () => ({ revision: ++calls });
    assert.deepEqual(await cache.getOrLoad(key, { ttlMs: 1000 }, load), { revision: 1 });
    assert.deepEqual(await cache.getOrLoad(key, { ttlMs: 1000 }, load), { revision: 1 });
    await cache.invalidate(scope, "test");
    assert.deepEqual(await cache.getOrLoad(key, { ttlMs: 1000 }, load), { revision: 2 });
    await backend.close?.();
    assert.deepEqual(await cache.getOrLoad(key, { ttlMs: 1000 }, load), { revision: 3 });
    console.log("Real Redis generation, hit, invalidation, and disconnect fallback checks passed.");
  } finally { await backend.close?.().catch(() => undefined); }
}

if (process.argv.includes("--database")) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && /cache_(check|verify)/.test(url.pathname), "Requires an isolated local cache test database");
  const { prisma } = await import("../src/lib/prisma.js");
  const { createSession, resolveSession, revokeSession } = await import("../src/lib/session.js");
  const { enqueueWebsiteWork, claimWebsiteWork, runWebsiteWork } = await import("../src/services/websiteWorkQueue.js");
  const { effectivePermissions } = await import("../src/lib/accessRoles.js");
  const suffix = randomUUID();
  const role = await prisma.accessRole.create({ data: { key: suffix, name: "Cache test", superAdmin: true } });
  const user = await prisma.user.create({ data: { email: `${suffix}@example.invalid`, name: "Cache test", accessRoleId: role.id }, include: { accessRole: true } });
  const site = await prisma.site.create({ data: { name: "Cache test", slug: suffix, publicUrl: `https://${suffix}.example.invalid` } });
  try {
    const token = await createSession(user.id);
    await prisma.session.updateMany({ where: { userId: user.id }, data: { lastRefreshedAt: new Date(Date.now() - 2 * 86_400_000) } });
    await Promise.all(Array.from({ length: 20 }, () => resolveSession(token)));
    const first = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    await Promise.all(Array.from({ length: 20 }, () => resolveSession(token)));
    const second = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(first.lastRefreshedAt.getTime(), second.lastRefreshedAt.getTime());
    await revokeSession(token); assert.equal(await resolveSession(token), null);
    const count = await prisma.cacheInvalidation.count({ where: { siteId: site.id } });
    await assert.rejects(prisma.$transaction(async tx => { await tx.site.update({ where: { id: site.id }, data: { name: "rollback" } }); throw new Error("rollback"); }));
    assert.equal(await prisma.cacheInvalidation.count({ where: { siteId: site.id } }), count, "rolled back writes do not emit events");
    const page = await prisma.sitePage.create({ data: { siteId: site.id, path: "/", filePath: "index.html", title: "Test", publishedHtml: "<p>hello</p>" } });
    assert.ok(page.publishedEtag, "publication computes etag in the writing transaction");
    const request = (id: string) => ({ dbUser: user, permissions: effectivePermissions(user), headers: {}, get: (name: string) => name === "Idempotency-Key" ? id : undefined }) as unknown as import("express").Request;
    const id = randomUUID();
    const [a, b] = await Promise.all([enqueueWebsiteWork(request(id), site.id, "ASSISTANT", { prompt: "test" }), enqueueWebsiteWork(request(id), site.id, "ASSISTANT", { prompt: "test" })]);
    assert.equal(a.jobId, b.jobId, "idempotency reserves only one job");
    await assert.rejects(enqueueWebsiteWork(request(id), site.id, "ASSISTANT", { prompt: "different" }));
    await enqueueWebsiteWork(request(randomUUID()), site.id, "ASSISTANT", { prompt: "second" });
    await assert.rejects(enqueueWebsiteWork(request(randomUUID()), site.id, "ASSISTANT", { prompt: "third" }), CapacityError);
    const claims = await Promise.all([claimWebsiteWork("a"), claimWebsiteWork("b")]);
    assert.equal(claims.filter(Boolean).length, 1, "one active job per user across workers");
    const claimed = claims.find(Boolean)!;
    const { withWebsiteWork, beforeWebsiteExternalAction, WorkCancelledError } = await import("../src/lib/websiteWorkContext.js");
    await assert.rejects(withWebsiteWork({ jobId: claimed.id, leaseOwner: "stale-owner", authorize: async () => undefined }, beforeWebsiteExternalAction), WorkCancelledError,
      "a stale worker cannot begin an external action after ownership changes");
    await prisma.websiteWorkJob.update({ where: { id: claimed.id }, data: { leaseUntil: new Date(0), externalStartedAt: new Date() } });
    await claimWebsiteWork("c");
    assert.equal((await prisma.websiteWorkJob.findUniqueOrThrow({ where: { id: claimed.id } })).state, "RECONCILIATION_REQUIRED");
    const secondJob = await prisma.websiteWorkJob.findFirstOrThrow({ where: { userId: user.id, state: "RUNNING" } });
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    await runWebsiteWork(secondJob);
    assert.equal((await prisma.websiteWorkJob.findUniqueOrThrow({ where: { id: secondJob.id } })).state, "FAILED", "revoked users cannot execute queued work");
    assert.equal((await prisma.websiteWorkJob.findUniqueOrThrow({ where: { id: secondJob.id } })).usageState, "RELEASED", "work refused before external execution releases its allowance");
    await prisma.user.update({ where: { id: user.id }, data: { active: true } });
    const unpublished = await prisma.sitePage.create({ data: { siteId: site.id, path: "/new", filePath: "new.html", title: "New", sourceHtml: "<p>Queued publication</p>" } });
    const acceptedPublish = await enqueueWebsiteWork(request(randomUUID()), site.id, "PUBLISH_PAGE", { pageId: unpublished.id, body: { ifRevision: 0 } });
    const publication = await claimWebsiteWork("publish-test");
    assert.equal(publication?.id, acceptedPublish.jobId);
    await runWebsiteWork(publication!);
    const outcome = await prisma.websiteWorkJob.findUniqueOrThrow({ where: { id: acceptedPublish.jobId } });
    assert.equal(outcome.state, "COMPLETED", outcome.error ?? "queued publish completes");
    assert.equal((await prisma.sitePage.findUniqueOrThrow({ where: { id: unpublished.id } })).publishedHtml, "<p>Queued publication</p>");
    const historical = await prisma.sitePageVersion.create({ data: { pageId: unpublished.id, number: 50, html: "<p>Previous publication</p>", publishedById: user.id } });
    const restoredPage = await prisma.sitePage.findUniqueOrThrow({ where: { id: unpublished.id } });
    const acceptedVersion = await enqueueWebsiteWork(request(randomUUID()), site.id, "PUBLISH_VERSION", { pageId: unpublished.id, versionId: historical.id, body: { ifRevision: restoredPage.draftRevision } });
    const versionWork = await claimWebsiteWork("version-test");
    assert.equal(versionWork?.id, acceptedVersion.jobId);
    await runWebsiteWork(versionWork!);
    assert.equal((await prisma.websiteWorkJob.findUniqueOrThrow({ where: { id: acceptedVersion.jobId } })).state, "COMPLETED");
    assert.equal((await prisma.sitePage.findUniqueOrThrow({ where: { id: unpublished.id } })).publishedHtml, historical.html);
    await prisma.site.update({ where: { id: site.id }, data: { hostedSlug: `old-${suffix}` } });
    await prisma.site.update({ where: { id: site.id }, data: { hostedSlug: `new-${suffix}` } });
    assert.ok(await prisma.cacheInvalidation.findFirst({ where: { siteId: site.id, hostedSlugs: { has: `old-${suffix}` } } }), "old hosted hostname remains available for purging");
    console.log("PostgreSQL session, transactional invalidation, ETag, quota, idempotency, lease, and crash-recovery checks passed.");
  } finally {
    await prisma.websiteWorkJob.deleteMany({ where: { userId: user.id } });
    await prisma.site.delete({ where: { id: site.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.accessRole.delete({ where: { id: role.id } });
    await prisma.cacheInvalidation.deleteMany({ where: { siteId: site.id } });
    await prisma.$disconnect();
  }
}
