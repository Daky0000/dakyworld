/**
 * Serving hosted websites, and who holds a custom domain (services/websiteHosting.ts,
 * services/publishedAssets.ts).
 *
 * The pictures: served while the database holds them, sent to R2 once the
 * deploy script has moved them (it empties the column — every image answered
 * 404 the morning after), 404 only when they are in neither place, and never a
 * file that no LIVE page of the same site points at. Upload paths are cached
 * for a year, everything else revalidates, and a revalidation does not depend
 * on the bytes being here.
 *
 * The files every site is asked for — robots.txt, sitemap.xml, favicon.ico —
 * and a page of the site's own at one of those paths winning. A tracked link
 * (?utm_source=) served like any other. The other spelling of a verified domain
 * redirected, and an unverified one not — and an icon named at that other
 * spelling (or the site's hosted address) answered here, followed redirect by
 * redirect: favicon.ico and the www redirect used to send a browser between
 * them until it gave up. A flood from one address slowed. The editor's
 * hostnames in a comma-separated CLIENT_ORIGIN left alone.
 *
 * And the squatting fix: two websites may both claim a domain, verifying one
 * clears the other, a verified domain cannot be claimed, and the database
 * refuses a second verified row outright. Two proofs landing at once leave one
 * holder and a 409 — the first version deadlocked and handed the loser a 500.
 *
 * Needs an isolated local database (name containing test, check or editor). No
 * network: DNS is answered by a stub, and R2 is configuration with no request.
 *   npx tsx checks/websiteHosting.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Prisma } from "@prisma/client";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteHosting needs an isolated local test/editor database.");
}
process.env.DEV_NO_AUTH = "false";
process.env.WEBSITE_HOST_DOMAIN = "sites.hostingcheck.test";
const { prisma } = await import("../src/lib/prisma.js");
const { publicSiteHosting, verifyCustomDomain, isApexDomain } = await import("../src/services/websiteHosting.js");
const { legacyPublishedAsset } = await import("../src/services/publishedAssets.js");
const { deliverInvalidations } = await import("../src/services/cacheInvalidation.js");
const { flushVisits } = await import("../src/services/websiteVisits.js");
const { cacheMetrics } = await import("../src/lib/cache.js");
const { createSession } = await import("../src/lib/session.js");
const { attachUser, requireAuth, scopeExternal } = await import("../src/middleware/auth.js");
const { websiteRouter } = await import("../src/routes/website.js");

// After the imports: `dotenv/config` runs inside them and would put back any of
// these a local .env carries. Each section sets exactly what it needs.
const ENV_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL", "WEBSITE_HOST_RATE_LIMIT", "CLIENT_ORIGIN", "LEGACY_ASSET_SITE_SLUG"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
const cacheOn = process.env.RESPONSE_CACHE_ENABLED === "true";

let passed = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}`); }
}

const mark = `hostcheck-${randomUUID().slice(0, 8)}`;
const hostOf = (slug: string) => `${slug}.sites.hostingcheck.test`;
const uploaded = `assets/dw/${randomUUID()}.png`;
const hiddenOnly = `assets/dw/${randomUUID()}.png`;
const unreferenced = `assets/dw/${randomUUID()}.png`;
const basedOk = `assets/dw/${randomUUID()}.png`;
const basedBare = `assets/dw/${randomUUID()}.png`;
const basedLookalike = `assets/dw/${randomUUID()}.png`;
const named = "assets/dw/opening-hours.svg";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`;
const published = new Date("2026-10-01T09:30:00.000Z");

const siteIds: string[] = [];
const userIds: string[] = [];
let server: http.Server | undefined;

type PageInput = Partial<Prisma.SitePageCreateWithoutSiteInput> & { path: string };
async function site(slug: string, data: Partial<Prisma.SiteCreateInput> = {}, pages: PageInput[] = []) {
  const created = await prisma.site.create({
    data: { slug, name: slug, publicUrl: `https://${slug}.example.test`, hostedEnabled: true, hostedSlug: slug, ...data,
      pages: { create: pages.map((page, i) => ({ title: `Page ${i}`, filePath: `page-${i}.html`, status: "LIVE", ...page })) } },
  });
  siteIds.push(created.id);
  return created;
}

try {
  const main = await site(`${mark}-main`, {}, [
    { path: "/", filePath: "index.html", lastPublishedAt: published,
      publishedHtml: `<html><head><link rel="shortcut icon" href="/${uploaded}"></head><body><h1>Home</h1><img src="/${uploaded}"><img src='/${named}'></body></html>` },
    { path: "/food&drink", lastPublishedAt: published, publishedHtml: "<html><body><h1>Food</h1></body></html>" },
    { path: "/draft", publishedHtml: null },
    { path: "/secret", status: "HIDDEN", publishedHtml: `<img src="/${hiddenOnly}">` },
  ]);
  const neighbour = await site(`${mark}-neighbour`, {}, [
    { path: "/", filePath: "index.html", publishedHtml: `<html><head><link rel="icon" href="https://cdn.example.test/icon.png"></head><body><img src="/${unreferenced}"></body></html>` },
    { path: "/robots.txt", publishedHtml: "<p>The robots page this site published itself.</p>" },
  ]);
  const plain = await site(`${mark}-plain`, {}, [
    { path: "/", filePath: "index.html", publishedHtml: `<html><head><link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="http://cdn.example.test/icon.png"></head></html>` },
  ]);
  const looping = await site(`${mark}-loop`, {}, [
    { path: "/", filePath: "index.html", publishedHtml: `<html><head><link rel="icon" href="/favicon.ico"></head></html>` },
  ]);
  // Served from a path, and the path has a dot in it: a reference counts only
  // with this exact prefix, read literally rather than as a pattern.
  const based = await site(`${mark}-based`, { publicUrl: `https://${mark}-based.example.test/shop.v2` }, [
    { path: "/", filePath: "index.html", publishedHtml: `<img src="/shop.v2/${basedOk}"><img src="/${basedBare}"><img src="/shopXv2/${basedLookalike}">` },
  ]);
  const bytes = Buffer.from("not really a png, but bytes all the same");
  const files: Array<[string, string, Buffer, string]> = [
    [main.id, uploaded, bytes, "image/png"], [main.id, hiddenOnly, bytes, "image/png"], [main.id, unreferenced, bytes, "image/png"],
    [main.id, named, Buffer.from(SVG), "image/svg+xml"],
    [based.id, basedOk, bytes, "image/png"], [based.id, basedBare, bytes, "image/png"], [based.id, basedLookalike, bytes, "image/png"],
  ];
  for (const [siteId, repoPath, content, contentType] of files) {
    await prisma.siteAsset.create({ data: { siteId, repoPath, filename: repoPath.split("/").pop()!, contentType, content, size: content.length } });
  }

  const apex = `${mark}-apex.example`;
  const wwwFirst = `${mark}-www.example`;
  const pending = `${mark}-pending.example`;
  await site(`${mark}-apex`, { customDomain: apex, customDomainToken: "t1", customDomainVerifiedAt: new Date() }, [{ path: "/", filePath: "index.html", publishedHtml: "<p>apex</p>" }]);
  await site(`${mark}-www`, { customDomain: `www.${wwwFirst}`, customDomainToken: "t2", customDomainVerifiedAt: new Date() }, [{ path: "/", filePath: "index.html", publishedHtml: "<p>www</p>" }]);
  await site(`${mark}-pending`, { customDomain: pending, customDomainToken: "t3" }, [{ path: "/", filePath: "index.html", publishedHtml: "<p>pending</p>" }]);
  // Icons named at another address of the same site: the other spelling of its
  // domain (either way round), or its hosted address.
  const iconApex = `${mark}-iconapex.example`;
  const iconWww = `${mark}-iconwww.example`;
  const iconPath = `${mark}-iconpath.example`;
  const iconHosted = `${mark}-iconhosted.example`;
  const iconFile = `assets/dw/${randomUUID()}.png`;
  const verifiedAs = (domain: string, token: string) => ({ customDomain: domain, customDomainToken: token, customDomainVerifiedAt: new Date() });
  const iconHome = (href: string) => [{ path: "/", filePath: "index.html", publishedHtml: `<html><head><link rel="icon" href="${href}"></head><body>icons</body></html>` }];
  await site(`${mark}-iconapex`, verifiedAs(iconApex, "t5"), iconHome(`https://www.${iconApex}/favicon.ico`));
  await site(`${mark}-iconwww`, verifiedAs(`www.${iconWww}`, "t6"), iconHome(`https://${iconWww}/favicon.ico`));
  const iconPathSite = await site(`${mark}-iconpath`, verifiedAs(iconPath, "t7"), iconHome(`https://www.${iconPath}/${iconFile}`));
  await prisma.siteAsset.create({ data: { siteId: iconPathSite.id, repoPath: iconFile, filename: "icon.png", contentType: "image/png", content: Buffer.from("icon"), size: 4 } });
  await site(`${mark}-iconhosted`, verifiedAs(iconHosted, "t8"), iconHome(`https://${hostOf(`${mark}-iconhosted`)}/favicon.ico`));

  const role = await prisma.accessRole.create({ data: { key: mark, name: mark, external: true, permissions: [] } });
  const manager = await prisma.user.create({ data: { email: `${mark}-manager@example.test`, name: "Manager", accessRoleId: role.id } });
  userIds.push(manager.id);
  const claimantA = await site(`${mark}-a`, { members: { create: { userId: manager.id, role: "MANAGER" } } }, [{ path: "/", filePath: "index.html", publishedHtml: "<p>A</p>" }, { path: "/hidden", status: "HIDDEN", publishedHtml: "<p>old</p>" }]);
  const claimantB = await site(`${mark}-b`, { members: { create: { userId: manager.id, role: "MANAGER" } } });
  const token = await createSession(manager.id);
  await deliverInvalidations();

  const app = express();
  app.set("trust proxy", true);
  app.use(publicSiteHosting());
  app.get("/assets/dw/:filename", legacyPublishedAsset);
  app.use(express.json());
  app.use("/api", attachUser, requireAuth, scopeExternal);
  app.use("/api/website", websiteRouter);
  app.use((_req, res) => { res.type("text").send("OS"); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((error as { status?: number }).status ?? 500).json({ error: (error as Error).message });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;

  function call(path: string, options: { host?: string; method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, method: options.method ?? "GET", path, headers: {
        Host: options.host ?? "127.0.0.1",
        ...(body ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } : {}),
        ...options.headers,
      } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }
  const host = hostOf(main.hostedSlug!);

  console.log("\nPictures");
  let response = await call(`/${uploaded}`, { host });
  const etag = response.headers.etag;
  check("an uploaded picture a live page shows is served, bytes and all", () => { assert.equal(response.status, 200); assert.equal(response.text, bytes.toString()); assert.equal(response.headers["content-type"], "image/png"); });
  check("an upload's random path is cached for a year", () => assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable"));
  response = await call(`/${named}`, { host });
  check("a file under its own name revalidates instead — an import can replace it", () => { assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "public, max-age=60, must-revalidate"); });
  check("and an SVG still carries its own content policy", () => assert.ok(response.headers["content-security-policy"]));
  response = await call(`/${uploaded}`, { host, headers: { "If-None-Match": etag! } });
  check("a browser holding it is told it is current", () => { assert.equal(response.status, 304); assert.equal(response.text, ""); });
  response = await call(`/${unreferenced}`, { host });
  // The neighbour's live page does show it — another site's page is not this one's.
  check("a file no page of this site points at is not served, though the row exists", () => { assert.equal(response.status, 404); assert.equal(response.headers["cache-control"], "no-store"); });
  response = await call(`/${hiddenOnly}`, { host });
  check("nor one only a hidden page points at", () => assert.equal(response.status, 404));
  response = await call(`/${unreferenced}`, { host: hostOf(neighbour.hostedSlug!) });
  check("and a live page cannot reach into another site's files", () => assert.equal(response.status, 404));
  const basedHost = hostOf(based.hostedSlug!);
  response = await call(`/shop.v2/${basedOk}`, { host: basedHost });
  check("a site served under a path serves what it references under that path", () => assert.equal(response.status, 200));
  response = await call(`/shop.v2/${basedBare}`, { host: basedHost });
  check("but not a file referenced without the path", () => assert.equal(response.status, 404));
  response = await call(`/shop.v2/${basedLookalike}`, { host: basedHost });
  check("nor one under a path that only matches if the dot is a wildcard", () => assert.equal(response.status, 404));
  response = await call(`/${basedOk}`, { host: basedHost });
  check("nor the right file at the wrong address", () => assert.equal(response.status, 404));

  // What scripts/migrate-images-to-r2.mjs does to every row, before every deploy.
  await prisma.siteAsset.updateMany({ where: { siteId: main.id, repoPath: { in: [uploaded, named] } }, data: { content: null } });
  response = await call(`/${uploaded}`, { host });
  check("bytes moved out with no R2 configured: 404, not an empty 200", () => { assert.equal(response.status, 404); assert.equal(response.headers["cache-control"], "no-store"); });
  Object.assign(process.env, { R2_ACCOUNT_ID: "check", R2_ACCESS_KEY_ID: "check", R2_SECRET_ACCESS_KEY: "check", R2_PUBLIC_URL: "https://r2.hostingcheck.invalid/" });
  response = await call(`/${uploaded}`, { host });
  check("bytes moved to R2: the visitor is sent there", () => { assert.equal(response.status, 302); assert.equal(response.headers.location, `https://r2.hostingcheck.invalid/${uploaded}`); });
  check("and the redirect may be cached, for a day", () => assert.equal(response.headers["cache-control"], "public, max-age=86400"));
  response = await call(`/${uploaded}`, { host, headers: { "If-None-Match": etag! } });
  check("the ETag never came from the bytes, so a browser holding them still hears 304", () => assert.equal(response.status, 304));
  response = await call(`/${unreferenced}`, { host });
  check("R2 does not widen what is served: an unreferenced file is still 404", () => assert.equal(response.status, 404));

  console.log("\nThe company's old root asset addresses");
  process.env.LEGACY_ASSET_SITE_SLUG = main.slug;
  response = await call(`/${uploaded}`);
  check("served from R2 once the bytes have moved", () => { assert.equal(response.status, 302); assert.equal(response.headers.location, `https://r2.hostingcheck.invalid/${uploaded}`); });
  for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL"]) delete process.env[key];
  response = await call(`/${uploaded}`);
  check("and 404 when R2 is not configured either", () => assert.equal(response.status, 404));
  response = await call(`/${unreferenced}`);
  check("never a file no live page points at", () => assert.equal(response.status, 404));

  console.log("\nPages");
  response = await call("/?utm_source=facebook&utm_campaign=launch", { host });
  check("a tracked link is the page", () => { assert.equal(response.status, 200); assert.match(response.text, /<h1>Home<\/h1>/); });
  check("with a referrer policy, and none of the OS's own framing or content rules", () => {
    assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin");
    assert.equal(response.headers["x-frame-options"], undefined);
    assert.equal(response.headers["content-security-policy"], undefined);
  });
  if (cacheOn) {
    // Misses, not hits: the hostname lookup is cached as well, and would count
    // as a hit even if the page itself missed.
    await call("/food&drink?utm_source=a", { host });
    const misses = cacheMetrics.misses;
    response = await call("/food&drink?utm_source=b&fbclid=zzz", { host });
    check("a second tracked link to the same page is not a cache miss", () => { assert.equal(response.status, 200); assert.equal(cacheMetrics.misses, misses); });
  }
  response = await call("/nowhere", { host });
  check("a page that does not exist is still the not-found page", () => { assert.equal(response.status, 404); assert.match(response.text, /Page not found/); });

  console.log("\nrobots.txt, sitemap.xml and favicon.ico");
  response = await call("/robots.txt", { host });
  check("robots.txt allows everything and names the sitemap at this host", () => {
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"]!, /^text\/plain/);
    assert.match(response.text, /^User-agent: \*\nAllow: \/\n/);
    assert.match(response.text, new RegExp(`Sitemap: https://${host.replace(/\./g, "\\.")}/sitemap\\.xml`));
  });
  response = await call("/robots.txt", { host: hostOf(neighbour.hostedSlug!) });
  check("a robots page the site published itself wins", () => { assert.equal(response.status, 200); assert.match(response.text, /published itself/); });
  response = await call("/sitemap.xml", { host });
  const locs = [...response.text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
  check("sitemap.xml lists the live, published pages at this host", () => {
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"]!, /xml/);
    assert.deepEqual(locs.sort(), [`https://${host}/`, `https://${host}/food&amp;drink`]);
  });
  check("and not a hidden page, or a live one never published", () => { assert.doesNotMatch(response.text, /secret|draft/); });
  check("with when each was published", () => assert.match(response.text, /<lastmod>2026-10-01T09:30:00\.000Z<\/lastmod>/));
  response = await call("/favicon.ico", { host });
  check("favicon.ico goes to the icon the home page declares", () => { assert.equal(response.status, 302); assert.equal(response.headers.location, `/${uploaded}`); });
  response = await call("/favicon.ico", { host: hostOf(neighbour.hostedSlug!) });
  check("an https icon elsewhere is fine", () => { assert.equal(response.status, 302); assert.equal(response.headers.location, "https://cdn.example.test/icon.png"); });
  response = await call("/favicon.ico", { host: hostOf(plain.hostedSlug!) });
  check("an insecure icon elsewhere, or only a touch icon, is 'no icon', cached for a day", () => {
    assert.equal(response.status, 204);
    assert.equal(response.headers["cache-control"], "public, max-age=86400");
  });
  response = await call("/favicon.ico", { host: hostOf(looping.hostedSlug!) });
  check("an icon declared at /favicon.ico is not a redirect to itself", () => assert.equal(response.status, 204));
  response = await call("/robots.txt", { host, method: "POST" });
  check("only GET and HEAD", () => assert.equal(response.status, 405));

  console.log("\nwww and the bare domain");
  response = await call("/menu?x=1", { host: `www.${apex}` });
  check("www. of a verified domain goes to the domain, path and query kept", () => { assert.equal(response.status, 301); assert.equal(response.headers.location, `https://${apex}/menu?x=1`); });
  check("for an hour, not for ever", () => assert.equal(response.headers["cache-control"], "public, max-age=3600"));
  response = await call("/", { host: wwwFirst });
  check("the bare domain goes to www. when www. is what was verified", () => { assert.equal(response.status, 301); assert.equal(response.headers.location, `https://www.${wwwFirst}/`); });
  response = await call("/", { host: `www.${pending}` });
  check("an unverified domain is not redirected to", () => assert.equal(response.status, 404));
  response = await call("/", { host: apex });
  check("and the verified one itself is served", () => { assert.equal(response.status, 200); assert.match(response.text, /apex/); });

  console.log("\nfavicon.ico across a site's own addresses");
  // Follows redirects the way a browser does, and stops at ten: a loop of
  // favicon.ico and the www redirect used to run until the browser gave up.
  async function follow(startHost: string, startPath: string) {
    const hops: string[] = [];
    let at = new URL(startPath, `https://${startHost}/`);
    for (let i = 0; i < 10; i += 1) {
      const answer = await call(`${at.pathname}${at.search}`, { host: at.host });
      if (answer.status < 300 || answer.status >= 400) return { status: answer.status, hops };
      at = new URL(answer.headers.location!, at);
      hops.push(at.href);
    }
    return { status: 0, hops };
  }
  let chain = await follow(iconApex, "/favicon.ico");
  check("an icon named at /favicon.ico on the www spelling is no icon on the bare one, not a loop", () => assert.deepEqual(chain, { status: 204, hops: [] }, JSON.stringify(chain)));
  chain = await follow(`www.${iconApex}`, "/favicon.ico");
  check("and asked for at www, one hop to the bare domain and done", () => assert.deepEqual(chain, { status: 204, hops: [`https://${iconApex}/favicon.ico`] }, JSON.stringify(chain)));
  chain = await follow(`www.${iconWww}`, "/favicon.ico");
  check("the other way round — www connected, the bare spelling in the HTML — is no loop either", () => assert.deepEqual(chain, { status: 204, hops: [] }, JSON.stringify(chain)));
  chain = await follow(iconWww, "/favicon.ico");
  check("…from either spelling", () => assert.deepEqual(chain, { status: 204, hops: [`https://www.${iconWww}/favicon.ico`] }, JSON.stringify(chain)));
  chain = await follow(iconPath, "/favicon.ico");
  check("an icon at another path on the other spelling is that path, here: one hop, then the picture", () => {
    assert.deepEqual(chain, { status: 200, hops: [`https://${iconPath}/${iconFile}`] }, JSON.stringify(chain));
  });
  chain = await follow(`www.${iconPath}`, "/favicon.ico");
  check("and from the other spelling it still ends in the picture", () => { assert.equal(chain.status, 200, JSON.stringify(chain)); assert.ok(chain.hops.length <= 2); });
  chain = await follow(iconHosted, "/favicon.ico");
  check("the site's own hosted address counts as the same site too", () => assert.deepEqual(chain, { status: 204, hops: [] }, JSON.stringify(chain)));

  console.log("\nThe editor's own hostnames");
  process.env.CLIENT_ORIGIN = `https://a-${mark}.os.invalid,https://b-${mark}.os.invalid`;
  response = await call("/", { host: `b-${mark}.os.invalid` });
  check("every origin in a comma-separated CLIENT_ORIGIN is the app, not a website", () => { assert.equal(response.status, 200); assert.equal(response.text, "OS"); });
  delete process.env.CLIENT_ORIGIN;
  response = await call("/", { host: `b-${mark}.os.invalid` });
  check("and without it the same host is looked up as a website", () => assert.equal(response.status, 404));

  console.log("\nWho holds a domain");
  check("a two-label domain is a zone apex", () => assert.ok(isApexDomain("kofibakes.com")));
  check("so is one under a country's second level", () => { assert.ok(isApexDomain("kofibakes.com.gh")); assert.ok(isApexDomain("kofibakes.co.uk")); });
  check("a subdomain is not", () => { assert.ok(!isApexDomain("www.kofibakes.com")); assert.ok(!isApexDomain("shop.kofibakes.com.gh.example")); });
  const api = (path: string, method = "GET", body?: unknown) => call(`/api/website${path}`, { method, body, headers: { Cookie: `dw_session=${token}` } });
  const contested = `${mark}-contested.com`;
  const claimA = await api(`/sites/${claimantA.id}/hosting/domain`, "PUT", { domain: contested });
  const claimB = await api(`/sites/${claimantB.id}/hosting/domain`, "PUT", { domain: `https://${contested.toUpperCase()}/` });
  const claimed = await prisma.site.findMany({ where: { customDomain: contested }, select: { id: true, customDomainToken: true } });
  check("two websites may both claim a domain nobody has proved", () => { assert.equal(claimA.status, 200); assert.equal(claimB.status, 200); assert.equal(claimed.length, 2); });
  const instructions = JSON.parse(claimA.text).dnsInstructions;
  check("a bare domain is told about ALIAS and www rather than a CNAME DNS forbids", () => {
    assert.equal(instructions.apex, true);
    assert.deepEqual(instructions.www, { name: `www.${contested}`, value: hostOf(claimantA.hostedSlug!) });
    assert.match(instructions.guidance, /ALIAS, ANAME or CNAME flattening/);
  });
  response = await api(`/sites/${claimantA.id}/hosting`);
  const hosting = JSON.parse(response.text);
  check("the hosting answer counts published pages without loading them", () => { assert.equal(response.status, 200); assert.equal(hosting.publishedPages, 2); });
  check("and repeats the same instructions", () => { assert.equal(hosting.dnsInstructions.apex, true); assert.equal(hosting.dnsInstructions.cname.name, contested); });

  const tokenA = claimed.find((row) => row.id === claimantA.id)!.customDomainToken!;
  const tokenB = claimed.find((row) => row.id === claimantB.id)!.customDomainToken!;
  const wrong = await verifyCustomDomain(claimantB.id, async () => [["some-other-record"]]);
  const afterWrong = await prisma.site.count({ where: { customDomain: contested, customDomainVerifiedAt: null } });
  check("a TXT record that does not match verifies nothing and clears nothing", () => { assert.equal(wrong.verified, false); assert.equal(afterWrong, 2); });
  let moved: unknown = null;
  await verifyCustomDomain(claimantB.id, async () => {
    await prisma.site.update({ where: { id: claimantB.id }, data: { customDomain: `${mark}-elsewhere.com` } });
    return [[tokenB]];
  }).catch((error) => { moved = error; });
  const notVerified = await prisma.site.findUniqueOrThrow({ where: { id: claimantB.id }, select: { customDomainVerifiedAt: true } });
  check("a domain changed while DNS was being read is not verified on the old one's record", () => { assert.equal((moved as { status?: number })?.status, 409); assert.equal(notVerified.customDomainVerifiedAt, null); });
  await prisma.site.update({ where: { id: claimantB.id }, data: { customDomain: contested, customDomainToken: tokenB } });

  const result = await verifyCustomDomain(claimantA.id, async (name) => (name === `_dakyworld.${contested}` ? [[tokenA]] : []));
  const [winner, loser] = await Promise.all([claimantA, claimantB].map((row) => prisma.site.findUniqueOrThrow({ where: { id: row.id }, select: { customDomain: true, customDomainToken: true, customDomainVerifiedAt: true } })));
  check("the first to prove it wins it", () => { assert.equal(result.verified, true); assert.equal(winner.customDomain, contested); assert.ok(winner.customDomainVerifiedAt); });
  check("and the other claim is cleared in the same step", () => { assert.equal(loser.customDomain, null); assert.equal(loser.customDomainToken, null); assert.equal(loser.customDomainVerifiedAt, null); });
  response = await api(`/sites/${claimantB.id}/hosting/domain`, "PUT", { domain: contested });
  check("a verified domain cannot be claimed by another website", () => assert.equal(response.status, 409));
  let refused: unknown = null;
  await prisma.site.update({ where: { id: claimantB.id }, data: { customDomain: contested, customDomainVerifiedAt: new Date() } }).catch((error) => { refused = error; });
  check("and the database refuses a second verified row outright", () => assert.equal((refused as { code?: string })?.code, "P2002"));
  await prisma.site.update({ where: { id: claimantB.id }, data: { customDomain: contested, customDomainToken: "late", customDomainVerifiedAt: null } });
  let raced: unknown = null;
  await verifyCustomDomain(claimantB.id, async () => [["late"]]).catch((error) => { raced = error; });
  check("a late proof for a domain already won is refused, not a crash", () => { assert.equal((raced as { status?: number })?.status, 409); });
  await deliverInvalidations();
  response = await call("/", { host: contested });
  check("and the winner is what the domain serves", () => { assert.equal(response.status, 200); assert.equal(response.text, "<p>A</p>"); });

  // Two proofs landing together, both past DNS before either has written.
  const raced2 = `${mark}-race.com`;
  const racers = await Promise.all(["c", "d"].map((label) => site(`${mark}-${label}`, { customDomain: raced2, customDomainToken: `race-${label}` })));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const outcomes = Promise.allSettled(racers.map((row, i) => verifyCustomDomain(row.id, async () => { await gate; return [[`race-${["c", "d"][i]}`]]; })));
  release();
  const settled = await outcomes;
  const holders = await prisma.site.findMany({ where: { customDomain: raced2 }, select: { id: true, customDomainVerifiedAt: true } });
  const rejected = settled.filter((outcome) => outcome.status === "rejected") as PromiseRejectedResult[];
  check("two proofs at once: exactly one website ends up holding the domain", () => { assert.equal(holders.length, 1); assert.ok(holders[0]!.customDomainVerifiedAt); });
  check("and the other is told so, not handed a server error", () => {
    assert.equal(rejected.length, 1, `rejected ${rejected.length}`);
    assert.equal((rejected[0]!.reason as { status?: number }).status, 409, String((rejected[0]!.reason as Error).message).slice(0, 200));
  });

  console.log("\nA flood from one address");
  process.env.WEBSITE_HOST_RATE_LIMIT = "5";
  const flood: number[] = [];
  for (let i = 0; i < 6; i += 1) flood.push((await call("/", { host, headers: { "X-Forwarded-For": "203.0.113.9" } })).status);
  response = await call("/", { host, headers: { "X-Forwarded-For": "203.0.113.9" } });
  check("is served up to the limit and then refused", () => { assert.deepEqual(flood, [200, 200, 200, 200, 200, 429]); assert.equal(response.status, 429); });
  check("told when to come back, and the refusal is not cached", () => { assert.ok(Number(response.headers["retry-after"]) >= 1); assert.equal(response.headers["cache-control"], "no-store"); });
  response = await call("/", { host, headers: { "X-Forwarded-For": "203.0.113.10" } });
  check("while somebody else at the same site is not", () => assert.equal(response.status, 200));
  response = await call("/", { host: hostOf(neighbour.hostedSlug!), headers: { "X-Forwarded-For": "203.0.113.9" } });
  check("and the same visitor at another site is not either", () => assert.equal(response.status, 200));
  delete process.env.WEBSITE_HOST_RATE_LIMIT;
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  await flushVisits().catch(() => 0);
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.accessRole.deleteMany({ where: { key: mark } });
  await prisma.cacheInvalidation.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
