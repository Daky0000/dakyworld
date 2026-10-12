/**
 * The address a hosted website is given is one it is served at.
 *
 *   DATABASE_URL=<isolated local test database> npx tsx checks/websiteHostedLabel.ts
 *
 * A site is served at `<hostedSlug>.<WEBSITE_HOST_DOMAIN>`, and its first
 * publish chooses that label: the slug cut to fifty characters, with a random
 * suffix when another website already has it. The address shown before then
 * (`POST /sites`) and the one the boot fix-up wrote (`adoptHostedAddresses`)
 * were built from the whole slug instead — so a website whose name slugs to
 * more than 41 characters was promised a host nothing ever serves, and every
 * "view live" link, canonical and og:url pointed at a 404. So:
 *
 *  1. **A long-named website started through the real `POST /sites`** is shown
 *     the address it is served at once it publishes.
 *  2. **A second one with the same long name is never handed the first one's
 *     address.** It waits on the placeholder, and its first publish settles it
 *     at the label it actually got.
 *  3. **The boot fix-up uses the same rule**: a placeholder becomes the address
 *     the site will be served at, and a whole-slug address given before this
 *     is corrected to where the site is served.
 *  4. **A verified domain wins** when an address is being replaced anyway; a
 *     working hosted address is never moved.
 *  5. **Never touched**: a repository's site, a customer's own domain, a
 *     lookalike host, a label somebody chose. And a second run writes nothing,
 *     asserted on `updatedAt`.
 *
 * The fix-up runs over the whole table, so any other row it would rewrite is
 * put back afterwards: a check must leave the database as it found it.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteHostedLabel needs an isolated local test/editor database.");
}
// Read into a module constant at import: the serving half needs it from the start.
const DOMAIN = "sites.hostedlabel.test";
process.env.WEBSITE_HOST_DOMAIN = DOMAIN;
process.env.NODE_ENV = "development";

const { prisma } = await import("../src/lib/prisma.js");
const { adoptHostedAddresses, registerWebsiteManagement } = await import("../src/services/websiteManagement.js");
const { ensureHostedAddress, publicSiteHosting } = await import("../src/services/websiteHosting.js");
const { flushVisits } = await import("../src/services/websiteVisits.js");
const { reachableAddress } = await import("../client/src/lib/websiteAddress.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}`); }
}
const hostOf = (address: string) => new URL(address).hostname;

const mark = `lbl${randomUUID().slice(0, 6)}`;
const LONG_NAME = `${mark} Accra Premium Plumbing and Electrical Services Limited`;
const siteIds: string[] = [];
const suffixes = [".sites.dakyx.com", ".hosting.invalid", `.${DOMAIN}`];
// Every row the fix-up could reach before this ran, so foreign ones go back.
const before = await prisma.site.findMany({
  where: { repoName: null, OR: suffixes.map((suffix) => ({ publicUrl: { contains: suffix } })) },
  select: { id: true, publicUrl: true },
});
let server: http.Server | undefined;

try {
  const app = express();
  app.use(publicSiteHosting());
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { dbUser: unknown }).dbUser = { id: undefined, name: "Hosted label check", active: true, accessRole: { external: false, superAdmin: true }, deniedPermissions: [] };
    next();
  });
  const router = express.Router();
  registerWebsiteManagement(router, {
    loadSite: async () => { throw new Error("Not used by POST /sites."); },
    loadPage: async () => { throw new Error("Not used by POST /sites."); },
  });
  app.use("/api/website", router);
  app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;

  function get(host: string, path = "/") {
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path, headers: { Host: host } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject);
      request.end();
    });
  }
  async function start(name: string) {
    const response = await fetch(`http://127.0.0.1:${port}/api/website/sites`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const { id } = (await response.json()) as { id: string };
    siteIds.push(id);
    return prisma.site.findUniqueOrThrow({ where: { id } });
  }
  async function make(name: string, data: Record<string, unknown>) {
    const row = await prisma.site.create({ data: { name: `${mark} ${name}`, slug: `${mark}-${name}`, ...data } as never });
    siteIds.push(row.id);
    return row;
  }
  // What every publish path does: a LIVE page, and `ensureHostedAddress` in the same breath.
  async function publish(siteId: string, words: string) {
    await prisma.sitePage.upsert({
      where: { siteId_path: { siteId, path: "/" } },
      create: { siteId, path: "/", filePath: "index.html", title: "Home", status: "LIVE", publishedHtml: `<p>${words}</p>` },
      update: { status: "LIVE", publishedHtml: `<p>${words}</p>` },
    });
    await ensureHostedAddress(siteId);
    return prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  }
  const read = (id: string) => prisma.site.findUniqueOrThrow({ where: { id }, select: { publicUrl: true, updatedAt: true } });

  console.log("\nA long name, started through the route");
  const first = await start(LONG_NAME);
  check("its slug is long enough for the label to be cut", () => assert.ok(first.slug.length > 50, first.slug));
  const firstLive = await publish(first.id, "first plumbers");
  check("before publishing, it was shown the address its first publish then gave it", () => assert.equal(first.publicUrl, `https://${firstLive.hostedSlug}.${DOMAIN}`, first.publicUrl));
  check("so publishing does not move it", () => assert.equal(firstLive.publicUrl, first.publicUrl));
  let response = await get(hostOf(firstLive.publicUrl));
  check("and that address serves the website", () => { assert.equal(response.status, 200, firstLive.publicUrl); assert.equal(response.text, "<p>first plumbers</p>"); });

  console.log("\nThe same long name again");
  const second = await start(LONG_NAME);
  check("it is not handed the first website's address", () => assert.notEqual(hostOf(second.publicUrl), hostOf(firstLive.publicUrl)));
  check("it waits on the placeholder, which no screen offers as an address", () => {
    assert.ok(hostOf(second.publicUrl).endsWith(".hosting.invalid"), second.publicUrl);
    assert.equal(reachableAddress(second.publicUrl), null);
  });
  const secondLive = await publish(second.id, "second plumbers");
  check("its first publish gives it a label of its own", () => { assert.ok(secondLive.hostedSlug); assert.notEqual(secondLive.hostedSlug, firstLive.hostedSlug); });
  check("and the address moves to it", () => assert.equal(secondLive.publicUrl, `https://${secondLive.hostedSlug}.${DOMAIN}`));
  response = await get(hostOf(secondLive.publicUrl));
  check("which serves this website, not the first one", () => { assert.equal(response.status, 200, secondLive.publicUrl); assert.equal(response.text, "<p>second plumbers</p>"); });

  console.log("\nThe boot fix-up, by the same rule");
  const longSlug = `${mark}-${"tamale-premium-roofing-and-carpentry-services-limited".slice(0, 60)}-1a2b3c4d`;
  const placeholder = await make("placeholder", { slug: longSlug, publicUrl: `https://${longSlug}.hosting.invalid` });
  // Made before the first website had published: its label is that one's now.
  const clashSlug = `${first.slug.slice(0, 60)}-9c8d7e6f`;
  const clashing = await make("clashing", { slug: clashSlug, publicUrl: `https://${clashSlug}.hosting.invalid` });
  const wholeSlug = `${mark}-old-${"accra-premium-plumbing-and-electrical-services-limited".slice(0, 50)}-5e6f7a8b`;
  const published = await make("published", {
    slug: wholeSlug, publicUrl: `https://${wholeSlug}.${DOMAIN}`, hostedSlug: wholeSlug.slice(0, 50), hostedEnabled: true,
    pages: { create: [{ path: "/", filePath: "index.html", title: "Home", status: "LIVE", publishedHtml: "<p>published plumbers</p>" }] },
  });
  const domain = `${mark}-bakery.example`;
  const withDomain = await make("domain", {
    publicUrl: `https://${mark}-domain.hosting.invalid/shop`, hostedEnabled: true,
    customDomain: domain, customDomainToken: "t", customDomainVerifiedAt: new Date(),
    pages: { create: [{ path: "/", filePath: "index.html", title: "Home", status: "LIVE", publishedHtml: "<p>bakery</p>" }] },
  });
  const servedAlready = await make("served", {
    publicUrl: `https://${mark}-served.${DOMAIN}`, hostedSlug: `${mark}-served`, hostedEnabled: true,
    customDomain: `${mark}-served.example`, customDomainToken: "t", customDomainVerifiedAt: new Date(),
  });
  const untouched = [
    await make("repo", { publicUrl: `https://${mark}-repo.${DOMAIN}`, repoOwner: "owner", repoName: "repo" }),
    await make("own", { publicUrl: `https://${mark}-own.example` }),
    await make("lookalike", { publicUrl: `https://${mark}-lookalike.${DOMAIN}.attacker.example` }),
    await make("chosen", { publicUrl: `https://${mark}-somebody-chose-this.${DOMAIN}` }),
    servedAlready,
  ];

  await adoptHostedAddresses(DOMAIN);
  const adopted = await read(placeholder.id);
  check("a placeholder becomes a real address", () => assert.ok(hostOf(adopted.publicUrl).endsWith(`.${DOMAIN}`), adopted.publicUrl));
  const adoptedLive = await publish(placeholder.id, "adopted plumbers");
  check("the one its first publish then gives it", () => assert.equal(adopted.publicUrl, `https://${adoptedLive.hostedSlug}.${DOMAIN}`));
  response = await get(hostOf(adopted.publicUrl));
  check("and once it publishes, that address serves it", () => { assert.equal(response.status, 200, adopted.publicUrl); assert.equal(response.text, "<p>adopted plumbers</p>"); });
  const kept = await read(clashing.id);
  check("a placeholder whose label another website now holds is not handed that website's address", () => {
    assert.notEqual(hostOf(kept.publicUrl), hostOf(firstLive.publicUrl));
    assert.ok(hostOf(kept.publicUrl).endsWith(".hosting.invalid"), kept.publicUrl);
  });
  const clashingLive = await publish(clashing.id, "clashing plumbers");
  response = await get(hostOf(clashingLive.publicUrl));
  check("…and its first publish settles it where it is served", () => { assert.equal(response.status, 200, clashingLive.publicUrl); assert.equal(response.text, "<p>clashing plumbers</p>"); });
  const corrected = await read(published.id);
  check("a whole-slug address given before is corrected to where the site is served", () => assert.equal(corrected.publicUrl, `https://${published.hostedSlug}.${DOMAIN}`));
  response = await get(hostOf(corrected.publicUrl));
  check("…which serves it", () => { assert.equal(response.status, 200, corrected.publicUrl); assert.equal(response.text, "<p>published plumbers</p>"); });
  const domained = await read(withDomain.id);
  check("a site with a verified domain is given the domain, keeping its path", () => assert.equal(domained.publicUrl, `https://${domain}/shop`));
  response = await get(domain);
  check("…which serves it", () => { assert.equal(response.status, 200); assert.equal(response.text, "<p>bakery</p>"); });
  const after = await Promise.all(untouched.map((site) => read(site.id)));
  untouched.forEach((site, i) => {
    check(`never ${site.slug.slice(mark.length + 1)}: ${site.publicUrl}`, () => assert.equal(after[i]!.publicUrl, site.publicUrl));
  });

  const settled = await Promise.all(siteIds.map(read));
  await adoptHostedAddresses(DOMAIN);
  const again = await Promise.all(siteIds.map(read));
  check("a second run writes nothing — not even updatedAt moves", () => assert.deepEqual(again, settled));
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await flushVisits().catch(() => 0);
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  for (const row of before) await prisma.site.updateMany({ where: { id: row.id }, data: { publicUrl: row.publicUrl } });
  await prisma.cacheInvalidation.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
