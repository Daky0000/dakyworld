import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import http from "node:http";
if (!process.argv.includes("--database")) {
  console.log("HTTP cache integration requires --database with dedicated local PostgreSQL and Redis fixtures.");
  process.exit(0);
}

const database = new URL(process.env.DATABASE_URL ?? "");
assert.ok(["localhost", "127.0.0.1"].includes(database.hostname) && database.pathname.includes("cache_verify_http_test"), "Requires a dedicated local cache_verify_http_test database");
assert.ok(process.env.REDIS_URL && ["localhost", "127.0.0.1"].includes(new URL(process.env.REDIS_URL).hostname));
process.env.NODE_ENV = "test";
process.env.DEV_NO_AUTH = "false";
process.env.RESPONSE_CACHE_ENABLED = "true";
process.env.EDGE_HTML_CACHE_ENABLED = "true";
process.env.JOB_ADMISSION_ENABLED = "true";
process.env.WEBSITE_HOST_DOMAIN = "cache-test.invalid";
process.env.CLOUDFLARE_API_TOKEN = "local-stub-only";
const marker = randomUUID();
const hosts = [`a-${marker}.cache-test.invalid`, `b-${marker}.cache-test.invalid`];
process.env.CLOUDFLARE_HOST_ZONES = JSON.stringify(Object.fromEntries(hosts.map(host => [host, "a".repeat(32)])));

const { prisma, databaseMetrics } = await import("../src/lib/prisma.js");
const { createSession, revokeSession } = await import("../src/lib/session.js");
const { attachUser, requireAuth, scopeExternal } = await import("../src/middleware/auth.js");
const { publicSiteHosting } = await import("../src/services/websiteHosting.js");
const { websiteRouter } = await import("../src/routes/website.js");
const { dashboardRouter } = await import("../src/routes/dashboard.js");
const { operationsRouter } = await import("../src/routes/operations.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { deliverInvalidations } = await import("../src/services/cacheInvalidation.js");
const { requestCacheContext } = await import("../src/lib/requestCache.js");
const { cacheMetrics } = await import("../src/lib/cache.js");
const role = await prisma.accessRole.create({ data: { key: marker, name: "HTTP cache customer", external: true } });
const ownerRole = await prisma.accessRole.create({ data: { key: `${marker}-owner`, name: "HTTP cache owner", superAdmin: true } });
const owner = await prisma.user.create({ data: { email: `owner-${marker}@example.invalid`, name: "Owner", accessRoleId: ownerRole.id } });
const customers = await Promise.all([0, 1].map(i => prisma.user.create({ data: { email: `${i}-${marker}@example.invalid`, name: `Customer ${i}`, accessRoleId: role.id } })));
const sites = await Promise.all(customers.map((user, i) => prisma.site.create({ data: { name: `Private site ${i}`, slug: `${i}-${marker}`,
  publicUrl: `https://${hosts[i]}`, hostedSlug: `${i === 0 ? "a" : "b"}-${marker}`, hostedEnabled: true,
  members: { create: { userId: user.id, role: "MANAGER" } } } })));
const pages = await Promise.all(sites.map((site, i) => prisma.sitePage.create({ data: { siteId: site.id, title: `Page ${i}`, path: "/", filePath: "index.html",
  status: "LIVE", sourceHtml: `<p>Tenant ${i}</p>`, publishedHtml: `<p>Tenant ${i}</p>` } })));
const tokens = await Promise.all([...customers, owner].map(user => createSession(user.id)));
const app = express(); app.use(requestCacheContext, publicSiteHosting(), express.json());
app.get("/os-host-check", (_req, res) => res.send("OS"));
app.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
app.use("/api", attachUser, requireAuth, scopeExternal);
app.use("/api/website", websiteRouter); app.use("/api/dashboard", dashboardRouter); app.use("/api/operations", operationsRouter);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const originalFetch = globalThis.fetch;
let purgeFail = false; const purges: string[] = [];
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
  if (String(input).startsWith("https://api.cloudflare.com/")) {
    purges.push(...JSON.parse(String(options?.body)).hosts);
    return new Response(JSON.stringify({ success: !purgeFail }), { status: purgeFail ? 503 : 200, headers: { "Content-Type": "application/json" } });
  }
  // Node's fetch normalizes Host; native HTTP permits testing customer-domain routing.
  if (new Headers(options?.headers).has("Host")) return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(options?.headers).forEach((value, name) => { headers[name] = value; });
    const request = http.get(String(input), { headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(new Response(response.statusCode === 304 ? null : Buffer.concat(chunks), {
        status: response.statusCode, headers: response.headers as Record<string, string>,
      })));
    });
    request.on("error", reject);
  });
  return originalFetch(input, options);
}) as typeof fetch;
const api = (path: string, token: string, options: RequestInit = {}) => fetch(`${base}/api${path}`, { ...options,
  headers: { Cookie: `dw_session=${token}`, "Content-Type": "application/json", ...options.headers } });
try {
  await deliverInvalidations();
  let response = await fetch(`${base}/`, { headers: { Host: hosts[0]! } });
  assert.equal(await response.text(), "<p>Tenant 0</p>");
  assert.match(response.headers.get("cache-control")!, /s-maxage=25/);
  const etag = response.headers.get("etag")!;
  const initialHits = cacheMetrics.hits;
  for (let attempt = 0; cacheMetrics.hits === initialHits && attempt < 8; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await fetch(`${base}/`, { headers: { Host: hosts[0]! } });
  }
  assert.ok(cacheMetrics.hits > initialHits, "Redis startup fallback eventually recovers to cache hits");
  const before = databaseMetrics.queries;
  response = await fetch(`${base}/`, { headers: { Host: hosts[0]!, "If-None-Match": etag } });
  assert.equal(response.status, 304); assert.equal(databaseMetrics.queries, before, "warm published ETag response makes no database reads");
  response = await fetch(`${base}/`, { headers: { Host: hosts[1]! } });
  assert.equal(await response.text(), "<p>Tenant 1</p>");
  response = await fetch(`${base}/`, { headers: { Host: hosts[0]!, Cookie: "anything=1" } });
  assert.equal(response.headers.get("cache-control"), "private, no-cache");
  response = await fetch(`${base}/`, { headers: { Host: "unknown.cache-test.invalid" } });
  assert.equal(response.status, 404); assert.equal(response.headers.get("cache-control"), "no-store");
  const osBefore = databaseMetrics.queries;
  assert.equal(await (await fetch(`${base}/os-host-check`)).text(), "OS");
  assert.equal(databaseMetrics.queries, osBefore, "OS host skips domain queries");
  const ownPath = `/website/sites/${sites[0]!.id}/pages`;
  assert.equal((await api(ownPath, tokens[0]!)).status, 200);
  assert.equal((await api(`/website/sites/${sites[1]!.id}/pages`, tokens[1]!)).status, 200);
  assert.equal((await api(`/website/sites/${sites[1]!.id}/pages`, tokens[0]!)).status, 404, "authorization precedes a tenant cache hit");
  const job = await prisma.websiteWorkJob.create({ data: { userId: customers[1]!.id, siteId: sites[1]!.id, kind: "ASSISTANT",
    idempotencyKey: marker, inputHash: marker, input: {}, state: "COMPLETED", result: { private: "tenant 1" } } });
  assert.equal((await api(`/website/sites/${sites[1]!.id}/work-jobs/${job.id}`, tokens[0]!)).status, 404);
  assert.equal((await api("/operations/capacity", tokens[0]!)).status, 403);
  const coldBefore = databaseMetrics.queries;
  assert.equal((await api("/dashboard", tokens[2]!)).status, 200);
  const coldQueries = databaseMetrics.queries - coldBefore;
  const warmBefore = databaseMetrics.queries;
  for (let i = 0; i < 20; i++) assert.equal((await api("/dashboard", tokens[2]!)).status, 200);
  const warmPerRead = (databaseMetrics.queries - warmBefore) / 20;
  assert.ok(warmPerRead <= coldQueries * 0.3, `Dashboard query reduction: cold ${coldQueries}, warm ${warmPerRead}`);
  await prisma.accessRole.update({ where: { id: ownerRole.id }, data: { superAdmin: false } });
  assert.equal((await api("/dashboard", tokens[2]!)).status, 403, "permission revocation applies to the next cached request");
  await prisma.accessRole.update({ where: { id: ownerRole.id }, data: { superAdmin: true } });
  const period = new Date().toISOString().slice(0, 7);
  await prisma.websiteUsage.upsert({ where: { userId_period: { userId: customers[1]!.id, period } }, create: { userId: customers[1]!.id, period, aiPrompts: 1 }, update: { aiPrompts: 1 } });
  const interrupted = await prisma.websiteWorkJob.create({ data: { userId: customers[1]!.id, siteId: sites[1]!.id, kind: "ASSISTANT", idempotencyKey: `${marker}-interrupted`, inputHash: marker,
    input: {}, state: "RECONCILIATION_REQUIRED", externalStartedAt: new Date(), usagePeriod: period, usageState: "RESERVED", attempts: 1 } });
  const evidence = { outcome: "NOT_EXECUTED", action: "FAIL", evidence: "Checked the local provider fixture: no request was received." };
  assert.equal((await api(`/operations/work-jobs/${interrupted.id}/reconcile`, tokens[2]!, { method: "POST", body: JSON.stringify(evidence) })).status, 200);
  assert.equal((await prisma.websiteUsage.findUniqueOrThrow({ where: { userId_period: { userId: customers[1]!.id, period } } })).aiPrompts, 0);
  assert.equal((await api(`/operations/work-jobs/${interrupted.id}/reconcile`, tokens[2]!, { method: "POST", body: JSON.stringify(evidence) })).status, 409, "reconciliation cannot refund twice");
  const charged = await prisma.websiteWorkJob.create({ data: { userId: customers[1]!.id, siteId: sites[1]!.id, kind: "ASSISTANT", idempotencyKey: `${marker}-charged`, inputHash: marker,
    input: {}, state: "RECONCILIATION_REQUIRED", externalStartedAt: new Date(), usagePeriod: period, usageState: "RESERVED", actualCostUsd: 0.1, attempts: 1 } });
  assert.equal((await api(`/operations/work-jobs/${charged.id}/reconcile`, tokens[2]!, { method: "POST", body: JSON.stringify(evidence) })).status, 409, "recorded charges cannot be refunded as unexecuted work");
  await revokeSession(tokens[0]!);
  assert.equal((await api(ownPath, tokens[0]!)).status, 401);
  purgeFail = true;
  await prisma.sitePage.update({ where: { id: pages[0]!.id }, data: { publishedHtml: "<p>Updated tenant 0</p>" } });
  await deliverInvalidations();
  assert.ok(await prisma.cacheInvalidation.count({ where: { siteId: sites[0]!.id, deliveredAt: null, attempts: { gt: 0 } } }), "failed CDN purge remains durable");
  assert.equal(await (await fetch(`${base}/`, { headers: { Host: hosts[0]! } })).text(), "<p>Updated tenant 0</p>");
  purgeFail = false;
  await prisma.cacheInvalidation.updateMany({ where: { siteId: { in: sites.map(site => site.id) }, deliveredAt: null }, data: { nextAttemptAt: new Date(0) } });
  await deliverInvalidations();
  assert.equal(await prisma.cacheInvalidation.count({ where: { siteId: sites[0]!.id, deliveredAt: null } }), 0);
  await prisma.site.update({ where: { id: sites[0]!.id }, data: { hostedSlug: `retired-${marker}` } });
  await prisma.site.update({ where: { id: sites[1]!.id }, data: { hostedSlug: `a-${marker}` } });
  await deliverInvalidations();
  assert.equal(await (await fetch(`${base}/`, { headers: { Host: hosts[0]! } })).text(), "<p>Tenant 1</p>");
  assert.ok(purges.includes(hosts[0]!), "domain reassignment purges the previous hostname");
  console.log(`HTTP cache isolation, authoritative revocation, public ETags, hostname reassignment, durable purge retry, and dashboard reduction passed (cold ${coldQueries} queries; warm ${warmPerRead}).`);
} finally {
  globalThis.fetch = originalFetch;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.websiteWorkJob.deleteMany({ where: { userId: { in: customers.map(user => user.id) } } });
  await prisma.site.deleteMany({ where: { id: { in: sites.map(site => site.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: [...customers, owner].map(user => user.id) } } });
  await prisma.accessRole.deleteMany({ where: { id: { in: [role.id, ownerRole.id] } } });
  await prisma.cacheInvalidation.deleteMany({ where: { siteId: { in: sites.map(site => site.id) } } });
  await prisma.$disconnect();
}
process.exit(0); // Shared Redis deliberately stays open for application lifetime.
