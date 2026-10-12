/**
 * The address a hosted website is given, before and after there is a domain
 * to give it.
 *
 *   DATABASE_URL=<isolated local test database> npx tsx checks/websiteHostedAddress.ts
 *
 * With no WEBSITE_HOST_DOMAIN, a website started with no address of its own
 * used to be given `https://<slug>.sites.dakyx.com`. Nothing serves that, so
 * customers were shown a dead address; and were it ever pointed at the app,
 * every customer's script would run same-site with os.dakyx.com. So:
 *
 *  1. **The fallback is never a dakyx.com address** — through the real
 *     `POST /sites`, not only the helper, because the helper being right says
 *     nothing about whether the route still uses it.
 *  2. **The boot fix-up gives placeholder addresses the real one** once a host
 *     domain is set, and turns a stale dakyx.com one into the `.invalid`
 *     placeholder while there is none.
 *  3. **It touches only what it should** — never a site with a repository,
 *     never a customer's own domain, never a host that merely *contains* the
 *     placeholder — and keeps the path, which every published picture's address
 *     is built from.
 *  4. **It is idempotent**: the second run writes nothing, asserted on
 *     `updatedAt` rather than on a count somebody could make agree.
 *
 * The fix-up runs over the whole table, so any other row it would rewrite is
 * put back afterwards: a check must leave the database as it found it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteHostedAddress needs an isolated local test/editor database.");
}
// Read into a module constant at import, so it has to be gone before then:
// this is the no-domain case, which is the one that used to invent dakyx.com.
delete process.env.WEBSITE_HOST_DOMAIN;
process.env.NODE_ENV = "development";

const { prisma } = await import("../src/lib/prisma.js");
const { assetUrl } = await import("../src/services/websiteAssets.js");
const { adoptHostedAddresses, registerWebsiteManagement } = await import("../src/services/websiteManagement.js");
const { hostedPublicUrl } = await import("../src/services/websiteHosting.js");
const { reachableAddress } = await import("../client/src/lib/websiteAddress.js");

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }
const host = (address: string) => new URL(address).hostname;
const notDakyx = (address: string) => host(address) !== "dakyx.com" && !host(address).endsWith(".dakyx.com");

const mark = `hostedcheck-${randomUUID().slice(0, 8)}`;
const siteIds: string[] = [];
// Every row the fix-up could reach before this ran, so foreign ones go back.
const before = await prisma.site.findMany({
  where: { repoName: null, OR: [{ publicUrl: { contains: ".sites.dakyx.com" } }, { publicUrl: { contains: ".hosting.invalid" } }] },
  select: { id: true, publicUrl: true },
});

try {
  /* ------------------------------------------- 1. the fallback */
  const placeholder = hostedPublicUrl("shop-1a2b3c4d", "");
  equal("with no host domain the address is a reserved placeholder", placeholder, "https://shop-1a2b3c4d.hosting.invalid");
  check("…which is not a dakyx.com address", notDakyx(placeholder));
  equal("with one, it is the address the site is served at", hostedPublicUrl("shop-1a2b3c4d", "dakyxsites.test"), "https://shop-1a2b3c4d.dakyxsites.test");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { dbUser: unknown }).dbUser = { id: undefined, name: "Hosted address check", active: true, accessRole: { external: false, superAdmin: true }, deniedPermissions: [] };
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
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  let createdId = "";
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/website/sites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${mark} starter` }),
    });
    equal("a website with no address of its own can still be started", response.status, 201);
    createdId = ((await response.json()) as { id: string }).id;
    siteIds.push(createdId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  const created = await prisma.site.findUniqueOrThrow({ where: { id: createdId } });
  check("the route gives it the placeholder, not a dakyx.com address", host(created.publicUrl).endsWith(".hosting.invalid") && notDakyx(created.publicUrl));
  equal("…built from its slug", created.publicUrl, `https://${created.slug}.hosting.invalid`);
  // The screens' half: the address they would link to is the one they leave out.
  equal("the screens do not offer the placeholder as an address to open", reachableAddress(created.publicUrl), null);
  equal("…but do offer a real one", reachableAddress("https://shop.dakyxsites.test/about"), "https://shop.dakyxsites.test/about");
  equal("…and nothing for no address at all", reachableAddress(""), null);

  /* ------------------------------------------- 2 and 3. the boot fix-up */
  const make = async (name: string, publicUrl: string, extra: Record<string, unknown> = {}) => {
    const row = await prisma.site.create({ data: { name: `${mark} ${name}`, slug: `${mark}-${name}`, publicUrl, ...extra } });
    siteIds.push(row.id);
    return row;
  };
  const oldDakyx = await make("old", `https://${mark}-old.sites.dakyx.com`);
  const relabelled = await make("relabelled", `https://${mark}-relabelled.hosting.invalid`, { hostedSlug: `${mark}-relabelled-live` });
  const withPath = await make("path", `https://${mark}-path.sites.dakyx.com/shop`);
  const repository = await make("repo", `https://${mark}-repo.sites.dakyx.com`, { repoOwner: "owner", repoName: "repo" });
  const ownDomain = await make("own", `https://${mark}-own.example`);
  const lookalike = await make("lookalike", `https://${mark}-lookalike.sites.dakyx.com.attacker.example`);
  const untouched = [repository, ownDomain, lookalike];

  const read = async (id: string) => prisma.site.findUniqueOrThrow({ where: { id }, select: { publicUrl: true, updatedAt: true } });

  await adoptHostedAddresses("");
  equal("with no host domain, a dakyx.com placeholder becomes the reserved one", (await read(oldDakyx.id)).publicUrl, `https://${oldDakyx.slug}.hosting.invalid`);
  equal("…keeping its path", (await read(withPath.id)).publicUrl, `https://${withPath.slug}.hosting.invalid/shop`);
  equal("…and a placeholder is labelled where the site is really served", (await read(relabelled.id)).publicUrl, `https://${mark}-relabelled-live.hosting.invalid`);

  await adoptHostedAddresses("dakyxsites.test");
  equal("once a host domain is set, a placeholder becomes the real address", (await read(oldDakyx.id)).publicUrl, `https://${oldDakyx.slug}.dakyxsites.test`);
  equal("…under the hosted label, where the site has one", (await read(relabelled.id)).publicUrl, `https://${mark}-relabelled-live.dakyxsites.test`);
  equal("…keeping its path", (await read(withPath.id)).publicUrl, `https://${withPath.slug}.dakyxsites.test/shop`);
  equal("…so every published picture's address is unchanged", assetUrl(await read(withPath.id), "assets/dw/x.png"), assetUrl(withPath, "assets/dw/x.png"));
  equal("the website started through the route is given it too", (await read(createdId)).publicUrl, `https://${created.slug}.dakyxsites.test`);
  for (const site of untouched) {
    equal(`never ${site.name.slice(mark.length + 1)}: ${site.publicUrl}`, (await read(site.id)).publicUrl, site.publicUrl);
  }

  /* ------------------------------------------- 4. idempotent */
  const settled = await Promise.all(siteIds.map(read));
  await adoptHostedAddresses("dakyxsites.test");
  const again = await Promise.all(siteIds.map(read));
  equal("a second run writes nothing — not even updatedAt moves", again, settled);

  console.log(`websiteHostedAddress: ${checks} checks passed — no dakyx.com fallback, placeholders adopted once a domain is set, repositories and real domains left alone, idempotent.`);
} finally {
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  for (const row of before) {
    await prisma.site.updateMany({ where: { id: row.id }, data: { publicUrl: row.publicUrl } });
  }
  await prisma.$disconnect();
}
