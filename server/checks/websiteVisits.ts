/**
 * Visits to hosted websites, counted on the server (services/websiteVisits.ts).
 *
 * The page views and visitors a customer is shown must be people: a crawler, a
 * link preview, a browser prefetching and a HEAD request are not visits, and a
 * person who looks at three pages is three views but one visitor. Where they
 * came from reads as words — "Search · Google", "Facebook", "Direct" — and a
 * click from one page of the site to another is not a source at all. Nothing
 * stored identifies anybody.
 *
 * Needs an isolated local database (name containing test, check or editor).
 *   npx tsx checks/websiteVisits.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteVisits needs an isolated local test/editor database.");
}
process.env.WEBSITE_HOST_DOMAIN = "sites.visitscheck.test";
const { prisma } = await import("../src/lib/prisma.js");
const { publicSiteHosting } = await import("../src/services/websiteHosting.js");
const { flushVisits, sourceOf } = await import("../src/services/websiteVisits.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}`); }
}

console.log("\nWhere a visit came from");
const own = "bakery.sites.visitscheck.test";
check("no referrer is Direct", () => assert.equal(sourceOf(undefined, own), "Direct"));
check("Google is a search", () => assert.equal(sourceOf("https://www.google.com.gh/", own), "Search · Google"));
check("Facebook's link wrapper is Facebook", () => assert.equal(sourceOf("https://l.facebook.com/l.php?u=x", own), "Facebook"));
check("another website is its name", () => assert.equal(sourceOf("https://www.ghanayello.com/listing/1", own), "ghanayello.com"));
check("a click inside the site is not a source", () => assert.equal(sourceOf(`https://${own}/menu`, own), null));

console.log("\nCounting");
const mark = `visitscheck-${randomUUID().slice(0, 8)}`;
const host = `${mark}.sites.visitscheck.test`;
let server: http.Server | undefined;
const site = await prisma.site.create({
  data: {
    slug: mark, name: "Visits Check", publicUrl: "https://example.test", hostedEnabled: true, hostedSlug: mark,
    pages: { create: [
      { title: "Home", path: "/", filePath: "index.html", status: "LIVE", publishedHtml: "<html><body><h1>Home</h1></body></html>" },
      { title: "Menu", path: "/menu", filePath: "menu.html", status: "LIVE", publishedHtml: "<html><body><h1>Menu</h1></body></html>" },
    ] },
  },
});
try {
  const app = express();
  app.set("trust proxy", true);
  app.use(publicSiteHosting());
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const visit = (path: string, headers: Record<string, string>, method = "GET") => new Promise<number>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path, headers: { Host: host, ...headers } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
    request.on("error", reject);
    request.end();
  });
  const laptop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";
  const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

  // Ama, on a laptop: home from Google, then the menu by clicking through.
  await visit("/", { "User-Agent": laptop, "X-Forwarded-For": "41.66.1.1", Referer: "https://www.google.com/" });
  await visit("/menu", { "User-Agent": laptop, "X-Forwarded-For": "41.66.1.1", Referer: `https://${host}/` });
  await visit("/menu", { "User-Agent": laptop, "X-Forwarded-For": "41.66.1.1", Referer: `https://${host}/` });
  // Kojo, on a phone, from a Facebook post.
  await visit("/", { "User-Agent": phone, "X-Forwarded-For": "41.66.2.2", Referer: "https://l.facebook.com/" });
  // Not people.
  await visit("/", { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "X-Forwarded-For": "66.249.1.1" });
  await visit("/", { "User-Agent": "WhatsApp/2.23.20 A", "X-Forwarded-For": "157.240.1.1" });
  await visit("/", { "User-Agent": laptop, "X-Forwarded-For": "41.66.3.3", "Sec-Purpose": "prefetch" });
  await visit("/", { "User-Agent": laptop, "X-Forwarded-For": "41.66.4.4" }, "HEAD");
  await visit("/missing", { "User-Agent": laptop, "X-Forwarded-For": "41.66.5.5" });
  await flushVisits();

  const rows = await prisma.siteVisitDay.findMany({ where: { siteId: site.id }, select: { path: true, views: true, visitors: true, phone: true } });
  const by = Object.fromEntries(rows.map((row) => [row.path, row]));
  check("four page views by people, none by robots, prefetches or HEAD", () => assert.equal(by["*"]?.views, 4));
  check("two visitors, however many pages each looked at", () => assert.equal(by["*"]?.visitors, 2));
  check("one view of the four was on a phone", () => assert.equal(by["*"]?.phone, 1));
  check("the menu was seen twice, by one person", () => { assert.equal(by["/menu"]?.views, 2); assert.equal(by["/menu"]?.visitors, 1); });
  check("a page that does not exist is not a visit", () => assert.equal(by["/missing"], undefined));
  const sources = Object.fromEntries((await prisma.siteReferrerDay.findMany({ where: { siteId: site.id } })).map((row) => [row.source, row.views]));
  check("sources read as words, and clicks inside the site are not one", () => assert.deepEqual(sources, { "Search · Google": 1, Facebook: 1 }));
  const columns = Object.keys((await prisma.siteVisitDay.findFirstOrThrow({ where: { siteId: site.id } })));
  check("nothing stored could identify a visitor", () => assert.deepEqual(columns.sort(), ["day", "id", "path", "phone", "siteId", "views", "visitors"]));

  await visit("/", { "User-Agent": laptop, "X-Forwarded-For": "41.66.1.1" });
  await flushVisits();
  const after = await prisma.siteVisitDay.findUniqueOrThrow({ where: { siteId_day_path: { siteId: site.id, day: (await prisma.siteVisitDay.findFirstOrThrow({ where: { siteId: site.id, path: "*" } })).day, path: "*" } } });
  check("counts add up across writes, and a returning visitor is not new the same day", () => { assert.equal(after.views, 5); assert.equal(after.visitors, 2); });
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await prisma.site.delete({ where: { id: site.id } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
