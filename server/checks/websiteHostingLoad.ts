/**
 * A hosted page under an ordinary load: its pictures all at once, and the
 * visitor allowance (services/websiteHosting.ts, services/publishedAssets.ts).
 *
 * With the response cache off — the default — every database read behind a
 * hosted request goes through the cache's fallback gate, which refuses rather
 * than queues once twenty are running. A picture request took two of those
 * reads, and the second re-extracted every LIVE page's HTML, so a page with
 * forty pictures fetched together (one browser, HTTP/2) got about half of them
 * as 503. So:
 *
 *  1. **Forty pictures at once are forty 200s**, with the cache off and the
 *     gate at its default — and a second site's forty at the same moment are
 *     not starved by the first's.
 *  2. **What is held is exact both ways**: a picture published a moment ago is
 *     served on the first request for it, one taken off the site is refused on
 *     the next, and a refusal is never remembered.
 *  3. **Pictures do not spend the pages' allowance.** A page and its forty
 *     pictures, loaded ten times from one address (a school, an office, a
 *     mobile carrier's shared address), is never refused; 301 pages in a minute
 *     still are, with a page that says so rather than a blank one. Pictures
 *     have an allowance of their own, ten times larger, and are not unlimited.
 *
 * Needs an isolated local database (name containing test, check or editor). No
 * network. Binds port 0.
 *   npx tsx checks/websiteHostingLoad.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteHostingLoad needs an isolated local test/editor database.");
}
// The configuration the defect needs, set before `lib/capacity.ts` reads it at
// import: no response cache, and the fallback gate at its default of twenty.
process.env.RESPONSE_CACHE_ENABLED = "false";
process.env.CACHE_FALLBACK_CONCURRENCY = "20";
process.env.WEBSITE_HOST_DOMAIN = "sites.hostingload.test";
const { prisma } = await import("../src/lib/prisma.js");
const { publicSiteHosting } = await import("../src/services/websiteHosting.js");
const { flushVisits } = await import("../src/services/websiteVisits.js");
const { capacity } = await import("../src/lib/capacity.js");

// After the imports, which load a local .env: each section sets what it needs.
const ENV_KEYS = ["WEBSITE_HOST_RATE_LIMIT", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];

let passed = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}`); }
}
const tally = (statuses: number[]) => statuses.reduce<Record<number, number>>((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});

const mark = `hostload-${randomUUID().slice(0, 8)}`;
const PICTURES = 40;
const siteIds: string[] = [];
let server: http.Server | undefined;
let agent: http.Agent | undefined;

// About a hundred kilobytes a page, ten pages: enough HTML that extracting the
// site's references is real work, as it is on a real site.
const filler = `<p>${"Fresh bread every morning, delivered across Accra. ".repeat(2000)}</p>`;
async function siteWithPictures(name: string) {
  const paths = Array.from({ length: PICTURES }, () => `assets/dw/${randomUUID()}.png`);
  const site = await prisma.site.create({
    data: {
      name: `${mark}-${name}`, slug: `${mark}-${name}`, publicUrl: `https://${mark}-${name}.example.test`, hostedEnabled: true, hostedSlug: `${mark}-${name}`,
      pages: { create: Array.from({ length: 10 }, (_, i) => ({
        title: `Page ${i}`, path: i ? `/p${i}` : "/", filePath: `p${i}.html`, status: "LIVE" as const,
        publishedHtml: `<html><body>${filler}${i === 0 ? paths.map((path) => `<img src="/${path}">`).join("") : ""}</body></html>`,
      })) },
    },
  });
  siteIds.push(site.id);
  const bytes = Buffer.alloc(20_000, 7);
  await prisma.siteAsset.createMany({ data: paths.map((repoPath) => ({ siteId: site.id, repoPath, filename: "photo.png", contentType: "image/png", content: bytes, size: bytes.length })) });
  return { site, paths, host: `${mark}-${name}.sites.hostingload.test` };
}

try {
  check("the cache is off and the gate is at its default, as in production today", () => {
    assert.equal(capacity.cache, false);
    assert.equal(capacity.fallbackConcurrency, 20);
  });
  const bakery = await siteWithPictures("bakery");
  const tailor = await siteWithPictures("tailor");

  const app = express();
  // So each section can be its own visitor, as X-Forwarded-For says.
  app.set("trust proxy", true);
  app.use(publicSiteHosting());
  app.use((_req, res) => { res.status(418).end(); });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  // One socket per request, all open at once: the shape of a browser fetching a
  // page's pictures over HTTP/2.
  agent = new http.Agent({ keepAlive: true, maxSockets: 2 * PICTURES });
  function get(host: string, path: string, visitor: string) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path, agent, headers: { Host: host, "X-Forwarded-For": visitor } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject);
      request.end();
    });
  }
  const pictures = (target: typeof bakery, visitor: string) => Promise.all(target.paths.map((path) => get(target.host, `/${path}`, visitor)));

  console.log("\nForty pictures at once, with the cache off");
  const burst = (await pictures(bakery, "198.51.100.1")).map((response) => response.status);
  check(`one page's ${PICTURES} pictures fetched together are all served`, () => assert.deepEqual(tally(burst), { 200: PICTURES }, JSON.stringify(tally(burst))));
  const [first, second] = await Promise.all([pictures(bakery, "198.51.100.2"), pictures(tailor, "198.51.100.3")]);
  check("and two sites' pages at the same moment: neither starves the other", () => {
    assert.deepEqual(tally(first.map((response) => response.status)), { 200: PICTURES }, `the first site: ${JSON.stringify(tally(first.map((response) => response.status)))}`);
    assert.deepEqual(tally(second.map((response) => response.status)), { 200: PICTURES }, `the second site: ${JSON.stringify(tally(second.map((response) => response.status)))}`);
  });
  check("each answer is the picture, not an empty success", () => assert.ok(second.every((response) => response.text.length === 20_000)));

  console.log("\nWhat is held is exact both ways");
  const home = await prisma.sitePage.findFirstOrThrow({ where: { siteId: bakery.site.id, path: "/" } });
  const homeHtml = home.publishedHtml!;
  const fresh = `assets/dw/${randomUUID()}.png`;
  await prisma.siteAsset.create({ data: { siteId: bakery.site.id, repoPath: fresh, filename: "new.png", contentType: "image/png", content: Buffer.from("new"), size: 3 } });
  let response = await get(bakery.host, `/${fresh}`, "198.51.100.4");
  check("a file no live page points at yet is refused", () => { assert.equal(response.status, 404); assert.equal(response.headers["cache-control"], "no-store"); });
  await prisma.sitePage.update({ where: { id: home.id }, data: { publishedHtml: homeHtml.replace("</body>", `<img src="/${fresh}"></body>`) } });
  response = await get(bakery.host, `/${fresh}`, "198.51.100.4");
  check("published a moment later, it is served on the very next request — the refusal was not remembered", () => assert.equal(response.status, 200));
  await prisma.sitePage.update({ where: { id: home.id }, data: { publishedHtml: homeHtml.replace(`<img src="/${bakery.paths[0]}">`, "") } });
  response = await get(bakery.host, `/${bakery.paths[0]}`, "198.51.100.4");
  check("a picture taken off the page is refused on the next request, not after a while", () => assert.equal(response.status, 404));
  response = await get(bakery.host, `/${bakery.paths[1]}`, "198.51.100.4");
  check("while the rest of the page's pictures are still served", () => assert.equal(response.status, 200));
  await prisma.sitePage.update({ where: { id: home.id }, data: { status: "HIDDEN" } });
  response = await get(bakery.host, `/${bakery.paths[1]}`, "198.51.100.4");
  check("and a page hidden takes its pictures with it at once", () => assert.equal(response.status, 404));
  await prisma.sitePage.update({ where: { id: home.id }, data: { status: "LIVE", publishedHtml: homeHtml } });
  response = await get(bakery.host, `/${bakery.paths[0]}`, "198.51.100.4");
  check("put back, served again", () => assert.equal(response.status, 200));

  console.log("\nThe visitor allowance");
  const office = "203.0.113.50";
  const loads: number[][] = [];
  for (let view = 0; view < 10; view += 1) {
    const page = await get(tailor.host, "/", office);
    loads.push([page.status, ...(await pictures(tailor, office)).map((picture) => picture.status)]);
  }
  check("a page and its forty pictures, loaded five times from one address, is never refused", () => {
    assert.deepEqual(tally(loads.slice(0, 5).flat()), { 200: 5 * (PICTURES + 1) }, JSON.stringify(tally(loads.slice(0, 5).flat())));
  });
  check("nor ten times — the pictures do not spend the pages' allowance", () => {
    assert.deepEqual(tally(loads.flat()), { 200: 10 * (PICTURES + 1) }, JSON.stringify(tally(loads.flat())));
  });
  const scraper = "203.0.113.51";
  const pages: number[] = [];
  for (let i = 0; i < 300; i += 1) pages.push((await get(tailor.host, i % 2 ? "/p1" : "/", scraper)).status);
  response = await get(tailor.host, "/", scraper);
  check("300 pages in a minute from one address are served", () => assert.deepEqual(tally(pages), { 200: 300 }, JSON.stringify(tally(pages))));
  check("the 301st is refused, told when to come back, and not cached", () => {
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers["retry-after"]) >= 1);
    assert.equal(response.headers["cache-control"], "no-store");
  });
  check("with a page that says so, rather than a blank one", () => {
    assert.match(response.headers["content-type"] ?? "", /^text\/html/);
    assert.match(response.text, /<title>[^<]+<\/title>/);
    assert.match(response.text, /a moment/i);
  });
  response = await get(tailor.host, `/${tailor.paths[0]}`, scraper);
  check("the same address's pictures still have their own allowance", () => assert.equal(response.status, 200));
  response = await get(tailor.host, "/", "203.0.113.52");
  check("and somebody else at the same site is not refused", () => assert.equal(response.status, 200));

  process.env.WEBSITE_HOST_RATE_LIMIT = "3";
  const flood: number[] = [];
  for (let i = 0; i < 30; i += 1) flood.push((await get(tailor.host, `/${tailor.paths[i % PICTURES]}`, "203.0.113.53")).status);
  response = await get(tailor.host, `/${tailor.paths[0]}`, "203.0.113.53");
  check("pictures are limited too, at ten times the pages' allowance", () => { assert.deepEqual(tally(flood), { 200: 30 }, JSON.stringify(tally(flood))); assert.equal(response.status, 429); });
  delete process.env.WEBSITE_HOST_RATE_LIMIT;
} finally {
  agent?.destroy();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  await flushVisits().catch(() => 0);
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.cacheInvalidation.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
