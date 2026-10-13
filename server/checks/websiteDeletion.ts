/**
 * Deleting a website or a customer account: offline at once, restorable for
 * thirty days, then really gone — and the refusals that stop a customer
 * deleting the wrong thing.
 *
 * What an erasure takes out of object storage is asserted with an injected
 * remover, so no bucket and no network are needed. Two things it must find
 * that no remaining row names: an object the asset delete route kept when it
 * deleted the row (recorded only in that route's audit event), and — the
 * other way round — a picture a repository site's own pages still load from
 * the bucket, which has to stay or the customer's live site breaks.
 *
 * Needs an isolated local database (its name must contain test, check or
 * editor); it creates and removes its own rows.
 *   npx tsx checks/websiteDeletion.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteDeletion needs an isolated local test/editor database.");
}

const { prisma } = await import("../src/lib/prisma.js");
const { hashPassword } = await import("../src/lib/password.js");
const { createSession } = await import("../src/lib/session.js");
const { WebsiteError } = await import("../src/services/website/site.js");
const { scheduleSiteDeletion, cancelSiteDeletion, requestAccountDeletion, purgeDueDeletions, assertSiteNotPendingDeletion, eraseSiteNow, mediaKeysToRemove, DELETION_HOLD_DAYS } = await import("../src/services/websiteDeletion.js");
const { registerWebsiteManagement } = await import("../src/services/websiteManagement.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}`); }
}
async function refusal(run: () => Promise<unknown>): Promise<{ status: number; message: string } | null> {
  try { await run(); return null; }
  catch (error) { if (error instanceof WebsiteError) return { status: error.status, message: error.message }; throw error; }
}

const mark = `deletioncheck-${randomUUID().slice(0, 8)}`;
const userIds: string[] = [];
const siteIds: string[] = [];
let clientId: string | null = null;
let productId: string | null = null;
const DAY = 24 * 60 * 60_000;

try {
  const role = await prisma.accessRole.findFirst({ where: { external: true }, select: { id: true } })
    ?? await prisma.accessRole.create({ data: { key: `${mark}-role`, name: `${mark}-role`, external: true, permissions: [] } });
  const password = "correct horse battery staple";
  const person = async (name: string) => {
    const user = await prisma.user.create({ data: { email: `${mark}-${name}@example.test`, name, accessRoleId: role.id, passwordHash: await hashPassword(password) } });
    userIds.push(user.id);
    return user;
  };
  const site = async (name: string, members: Array<[{ id: string }, "MANAGER" | "EDITOR"]>) => {
    const row = await prisma.site.create({ data: { slug: `${mark}-${name}`, name: `${mark} ${name}`, publicUrl: "https://example.test" } });
    siteIds.push(row.id);
    for (const [user, memberRole] of members) await prisma.siteMember.create({ data: { siteId: row.id, userId: user.id, role: memberRole } });
    return row;
  };

  console.log("\nA website");
  const owner = await person("owner");
  const shop = await site("shop", [[owner, "MANAGER"]]);
  const page = await prisma.sitePage.create({ data: { siteId: shop.id, title: "Home", path: "/", filePath: "index.html", sourceHtml: "<h1>Hi</h1>" } });
  await prisma.scheduledPublish.create({ data: { siteId: shop.id, pageId: page.id, scheduledAt: new Date(Date.now() + DAY), draftRevision: 0, createdById: owner.id } });
  const before = Date.now();
  const deletesOn = await scheduleSiteDeletion(shop.id, { id: owner.id, name: owner.name });
  check(`is held for ${DELETION_HOLD_DAYS} days`, () => assert.ok(Math.abs(deletesOn.getTime() - before - DELETION_HOLD_DAYS * DAY) < 60_000));
  const held = await prisma.site.findUniqueOrThrow({ where: { id: shop.id } });
  check("goes offline at once — publishing is refused while it waits", () => assert.throws(() => assertSiteNotPendingDeletion(held), /scheduled for deletion/));
  const jobs = await prisma.scheduledPublish.findMany({ where: { siteId: shop.id }, select: { status: true } });
  check("its scheduled publishes are cancelled", () => assert.deepEqual(jobs.map((job) => job.status), ["CANCELLED"]));
  const again = await refusal(() => scheduleSiteDeletion(shop.id, { id: owner.id }));
  check("asking twice is refused rather than restarting the clock", () => assert.equal(again?.status, 409));
  await cancelSiteDeletion(shop.id, { id: owner.id, name: owner.name });
  const restored = await prisma.site.findUniqueOrThrow({ where: { id: shop.id } });
  check("can be restored inside the hold", () => assert.equal(restored.deletionScheduledFor, null));
  const notHeld = await refusal(() => cancelSiteDeletion(shop.id, { id: owner.id }));
  check("restoring a site that is not held is refused", () => assert.equal(notHeld?.status, 409));
  const events = await prisma.siteAuditEvent.findMany({ where: { siteId: shop.id }, select: { kind: true }, orderBy: { createdAt: "asc" } });
  check("both are on the audit trail", () => assert.deepEqual(events.map((event) => event.kind), ["SITE_DELETION_SCHEDULED", "SITE_DELETION_CANCELLED"]));
  await scheduleSiteDeletion(shop.id, { id: owner.id });
  await purgeDueDeletions(new Date(Date.now() + 10 * DAY));
  const early = await prisma.site.count({ where: { id: shop.id } });
  check("is not erased before the hold runs out", () => assert.equal(early, 1));
  const swept = await purgeDueDeletions(new Date(Date.now() + (DELETION_HOLD_DAYS + 1) * DAY));
  const gone = await prisma.site.count({ where: { id: shop.id } });
  check("is erased, with everything under it, once it has", () => { assert.equal(gone, 0); assert.ok(swept.websites >= 1); });
  const pagesLeft = await prisma.sitePage.count({ where: { siteId: shop.id } });
  check("its pages went with it", () => assert.equal(pagesLeft, 0));

  console.log("\nIts pictures in object storage");
  // The rows cascade with the site; the R2 objects are in another system and
  // do not. The remover is injected so this proves *which* keys go without a
  // bucket or a network — the real one is R2's, used only when R2 is configured.
  const upload = (siteId: string, repoPath: string) =>
    prisma.siteAsset.create({ data: { siteId, filename: repoPath.split("/").pop()!, repoPath, contentType: "image/png", size: 1 } });
  const key = (ext = "png") => `assets/dw/${randomUUID()}.${ext}`;

  const [ownA, ownB, sharedUpload] = [key(), key(), key()];
  check("the pure rule: only an upload's own key, and only one no other site holds", () =>
    assert.deepEqual(mediaKeysToRemove([ownA, "assets/img/logo.png", ownB, sharedUpload], [sharedUpload]), [ownA, ownB]));

  const gallery = await site("gallery", [[owner, "MANAGER"]]);
  const neighbour = await site("neighbour", []);
  const galleryKeys = [key(), key("webp")];
  for (const repoPath of galleryKeys) await upload(gallery.id, repoPath);
  // A package import keeps the archive's own paths: a key like these is not one
  // customer's, and may be where the company's own image sits in the bucket.
  await upload(gallery.id, "images/logo.png");
  await upload(neighbour.id, "images/logo.png");
  await upload(gallery.id, "assets/img/hero.png");
  // An upload's path on two sites, as after one exported a package another imported.
  await upload(gallery.id, sharedUpload);
  await upload(neighbour.id, sharedUpload);
  const neighbourKey = key();
  await upload(neighbour.id, neighbourKey);

  const removed: string[] = [];
  const erasedNow = await eraseSiteNow(gallery.id, async (objectKey) => { removed.push(objectKey); });
  check("erasing a website removes exactly its own uploads' objects", () => assert.deepEqual([...removed].sort(), [...galleryKeys].sort()));
  check("…never a path from a package, which is not its alone", () => { assert.ok(!removed.includes("images/logo.png")); assert.ok(!removed.includes("assets/img/hero.png")); });
  check("…never an upload another site's library still names", () => assert.ok(!removed.includes(sharedUpload)));
  check("…never the other site's own", () => assert.ok(!removed.includes(neighbourKey)));
  check("…and says which it removed", () => assert.deepEqual([...erasedNow.mediaRemoved].sort(), [...galleryKeys].sort()));
  const neighbourRows = await prisma.siteAsset.count({ where: { siteId: neighbour.id } });
  check("the other site's library is untouched", () => assert.equal(neighbourRows, 3));
  const galleryGone = await prisma.site.count({ where: { id: gallery.id } });
  check("the website itself is gone", () => assert.equal(galleryGone, 0));

  const flakySite = await site("flaky", []);
  const [failsKey, worksKey] = [key(), key()];
  await upload(flakySite.id, failsKey);
  await upload(flakySite.id, worksKey);
  const tried: string[] = [];
  const quiet = console.error;
  console.error = () => {};
  let flaky: { mediaRemoved: string[] } | null = null;
  try {
    flaky = await eraseSiteNow(flakySite.id, async (objectKey) => {
      tried.push(objectKey);
      if (objectKey === failsKey) throw new Error("R2 is down");
    });
  } finally {
    console.error = quiet;
  }
  const flakyGone = await prisma.site.count({ where: { id: flakySite.id } });
  check("object storage failing does not fail the erasure", () => { assert.ok(flaky); assert.equal(flakyGone, 0); });
  check("…the other objects are still tried", () => assert.deepEqual([...tried].sort(), [failsKey, worksKey].sort()));
  check("…and only what really went is reported", () => assert.deepEqual(flaky?.mediaRemoved, [worksKey]));

  const unconfigured = await site("unconfigured", []);
  await upload(unconfigured.id, key());
  const withoutR2 = await eraseSiteNow(unconfigured.id, null);
  const unconfiguredGone = await prisma.site.count({ where: { id: unconfigured.id } });
  check("with R2 not configured nothing is attempted, and the site is still erased", () => { assert.deepEqual(withoutR2.mediaRemoved, []); assert.equal(unconfiguredGone, 0); });

  const due = await site("due", [[owner, "MANAGER"]]);
  const kept = await site("kept", [[owner, "MANAGER"]]);
  const [dueKey, keptKey] = [key(), key()];
  await upload(due.id, dueKey);
  await upload(kept.id, keptKey);
  await scheduleSiteDeletion(due.id, { id: owner.id });
  await scheduleSiteDeletion(kept.id, { id: owner.id });
  await cancelSiteDeletion(kept.id, { id: owner.id });
  const sweptKeys: string[] = [];
  const sweep = await purgeDueDeletions(new Date(Date.now() + (DELETION_HOLD_DAYS + 1) * DAY), async (objectKey) => { sweptKeys.push(objectKey); });
  check("the daily sweep removes the objects of a website whose hold ran out", () => { assert.ok(sweptKeys.includes(dueKey)); assert.ok(sweep.mediaRemoved.includes(dueKey)); });
  check("…and not those of one restored inside the hold", () => assert.ok(!sweptKeys.includes(keptKey)));
  const keptRows = await prisma.siteAsset.count({ where: { siteId: kept.id } });
  check("…whose library is still there", () => assert.equal(keptRows, 1));

  console.log("\nPictures a delete kept, and pictures a repository still loads");
  // The asset delete route keeps the stored object when something published may
  // still point at it, and its audit event is the only record of that key once
  // the row has gone. It is driven through the real route, so what the erasure
  // reads back is what the route writes. Every delete here is one the route
  // keeps the object for: one it removed would go to R2 for real.
  const app = express();
  const router = express.Router();
  registerWebsiteManagement(router, {
    loadSite: async (_req, id) => prisma.site.findUniqueOrThrow({ where: { id } }),
    loadPage: async () => { throw new Error("Not used by this route."); },
  });
  app.use("/api/website", router);
  app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  const server = app.listen(0, "127.0.0.1");
  server.unref();
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const routeBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/website`;
  const media = "https://media.deletioncheck.invalid";
  // A bucket that does not exist as well as made-up credentials, so a fixture
  // that went wrong can never reach a real object.
  const r2Env: Record<string, string> = { R2_ACCOUNT_ID: "check", R2_ACCESS_KEY_ID: "check", R2_SECRET_ACCESS_KEY: "check", R2_BUCKET_NAME: `${mark}-no-such-bucket`, R2_PUBLIC_URL: media };
  /** DELETE /sites/:id/assets/:id with R2 configured, and what its audit event says about the object. */
  const deleteRow = async (siteId: string, assetId: string) => {
    const before = Object.fromEntries(Object.keys(r2Env).map((name) => [name, process.env[name]]));
    Object.assign(process.env, r2Env);
    let status: number;
    try {
      status = (await fetch(`${routeBase}/sites/${siteId}/assets/${assetId}`, { method: "DELETE" })).status;
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const event = await prisma.siteAuditEvent.findFirst({ where: { kind: "ASSET_DELETED", detail: { path: ["assetId"], equals: assetId } }, select: { detail: true } });
    return { status, storedObject: (event?.detail as { storedObject?: string } | null)?.storedObject };
  };

  type Kept = { key: string; why: string };
  type Outcome = { removed: string[]; kept: Kept[]; logged: string[] };
  /** Runs an erasure with its log lines collected rather than printed. */
  const logged: string[] = [];
  const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
    const print = console.log;
    console.log = (...parts: unknown[]) => { logged.push(parts.join(" ")); };
    try { return await run(); } finally { console.log = print; }
  };
  /**
   * One hosted website and one with a repository, with every kind of key the
   * erasure has to decide about, and a neighbour that is never erased.
   */
  const erasureFixture = async (tag: string) => {
    const hosted = await prisma.site.create({ data: { slug: `${mark}-${tag}-hosted`, name: `${mark} ${tag} hosted`, publicUrl: "https://shop.hosting.invalid", hostedEnabled: true } });
    const repo = await prisma.site.create({ data: { slug: `${mark}-${tag}-repo`, name: `${mark} ${tag} repo`, publicUrl: `https://owner.github.io/${tag}`, repoOwner: "owner", repoName: `${mark}-${tag}` } });
    const neighbour = await prisma.site.create({ data: { slug: `${mark}-${tag}-neighbour`, name: `${mark} ${tag} neighbour`, publicUrl: "https://example.test" } });
    siteIds.push(hosted.id, repo.id, neighbour.id);
    const k = {
      hostedRow: key(), hostedHiddenOnly: key(), hostedPackage: `images/${mark}-${tag}-banner.png`, hostedShared: key(),
      repoLive: key(), repoLiveRowDeleted: key(), repoSource: key(), repoDraft: key(), repoHiddenPage: key(),
      repoUnused: key(), repoDropped: key(), repoPackage: `images/${mark}-${tag}-logo.png`, repoShared: key(), cross: key(),
    };
    const r2 = (repoPath: string) => `<img src="${media}/${repoPath}">`;
    const rows: Record<string, { id: string }> = {};
    for (const [role, repoPath] of Object.entries(k)) {
      if (role.startsWith("hosted")) rows[role] = await upload(hosted.id, repoPath);
      else rows[role] = await upload(repo.id, repoPath);
    }
    // The same upload in two libraries, as after a package export and import.
    await upload(neighbour.id, k.hostedShared);
    await upload(neighbour.id, k.repoShared);
    await upload(hosted.id, k.cross);
    await prisma.sitePage.createMany({ data: [
      { siteId: hosted.id, title: "Home", path: "/", filePath: "index.html", sortOrder: 0, sourceHtml: "<h1>Shop</h1>", publishedHtml: "<h1>Shop</h1>" },
      // Not served, so the route lets its picture go — and keeps the object.
      { siteId: hosted.id, title: "Old offer", path: "/old", filePath: "old.html", sortOrder: 1, status: "HIDDEN", sourceHtml: "<h1>Old</h1>", publishedHtml: r2(k.hostedHiddenOnly) },
      { siteId: repo.id, title: "Home", path: "/", filePath: "index.html", sortOrder: 0, publishedHtml: [k.repoLive, k.repoLiveRowDeleted, k.repoDropped].map(r2).join("") + `<img src="/${tag}/${k.repoPackage}">` },
      { siteId: repo.id, title: "About", path: "/about", filePath: "about.html", sortOrder: 1, sourceHtml: `<img src="/${tag}/${k.repoSource}">` },
      { siteId: repo.id, title: "Pricing", path: "/pricing", filePath: "pricing.html", sortOrder: 2, draft: { hero: { src: `${media}/${k.repoDraft}` } } },
      // Hidden from the editor's list, still a file in the repository.
      { siteId: repo.id, title: "Old offer", path: "/old", filePath: "old.html", sortOrder: 3, status: "HIDDEN", publishedHtml: r2(k.repoHiddenPage) },
    ] });
    const deletions = {
      hostedHiddenOnly: await deleteRow(hosted.id, rows.hostedHiddenOnly!.id),
      hostedPackage: await deleteRow(hosted.id, rows.hostedPackage!.id),
      hostedShared: await deleteRow(hosted.id, rows.hostedShared!.id),
      repoLiveRowDeleted: await deleteRow(repo.id, rows.repoLiveRowDeleted!.id),
      repoDropped: await deleteRow(repo.id, rows.repoDropped!.id),
      cross: await deleteRow(repo.id, rows.cross!.id),
    };
    // Republished without it: kept when its row went, and loaded by nothing now.
    const home = await prisma.sitePage.findFirstOrThrow({ where: { siteId: repo.id, path: "/" } });
    await prisma.sitePage.update({ where: { id: home.id }, data: { publishedHtml: home.publishedHtml!.replace(r2(k.repoDropped), "") } });
    return { hosted, repo, neighbour, k, deletions };
  };

  const outcomes: Array<[string, Outcome, Awaited<ReturnType<typeof erasureFixture>>]> = [];
  const nowFixture = await erasureFixture("now");
  check("the route deleted every row and kept every object (the fixture is what it claims)", () => {
    for (const [role, deletion] of Object.entries(nowFixture.deletions)) assert.deepEqual(deletion, { status: 204, storedObject: "kept" }, role);
  });
  {
    const removed: string[] = [];
    const remover = async (objectKey: string) => { removed.push(objectKey); };
    logged.length = 0;
    const first = await quietly(() => eraseSiteNow(nowFixture.hosted.id, remover));
    check("an upload another website kept when it deleted its row is not taken by this site's erasure", () => assert.ok(!removed.includes(nowFixture.k.cross)));
    const second = await quietly(() => eraseSiteNow(nowFixture.repo.id, remover));
    check("…but goes with the last website that knew about it", () => assert.equal(removed.filter((objectKey) => objectKey === nowFixture.k.cross).length, 1));
    check("each erasure reports only what it removed", () => assert.deepEqual([...first.mediaRemoved, ...second.mediaRemoved].sort(), [...removed].sort()));
    outcomes.push(["erased now", { removed, kept: [...(first.mediaKept ?? []), ...(second.mediaKept ?? [])], logged: [...logged] }, nowFixture]);
  }
  const heldFixture = await erasureFixture("held");
  {
    const removed: string[] = [];
    await scheduleSiteDeletion(heldFixture.hosted.id, { id: owner.id });
    await scheduleSiteDeletion(heldFixture.repo.id, { id: owner.id });
    logged.length = 0;
    const swept = await quietly(() => purgeDueDeletions(new Date(Date.now() + (DELETION_HOLD_DAYS + 1) * DAY), async (objectKey) => { removed.push(objectKey); }));
    check("after the hold: the cross-site upload goes exactly once, whichever site the sweep reaches first", () => assert.equal(removed.filter((objectKey) => objectKey === heldFixture.k.cross).length, 1));
    outcomes.push(["after the hold", { removed: swept.mediaRemoved, kept: swept.mediaKept ?? [], logged: [...logged] }, heldFixture]);
  }

  for (const [when, outcome, { k, repo, neighbour }] of outcomes) {
    const mine = new Set(Object.values(k));
    const removedHere = outcome.removed.filter((objectKey) => mine.has(objectKey)).sort();
    const keptHere = outcome.kept.filter((entry) => mine.has(entry.key));
    const keptKeys = keptHere.map((entry) => entry.key).sort();
    const why = (objectKey: string) => keptHere.find((entry) => entry.key === objectKey)?.why ?? "";
    check(`${when}: a hosted site's objects all go, the ones its delete route kept included`, () => {
      assert.ok(removedHere.includes(k.hostedRow), "its library's own upload");
      assert.ok(removedHere.includes(k.hostedHiddenOnly), "the upload only a hidden page carried, kept when its row was deleted");
    });
    check(`${when}: a repository site keeps exactly the uploads its own pages mention`, () =>
      assert.deepEqual(keptKeys, [k.repoLive, k.repoLiveRowDeleted, k.repoSource, k.repoDraft, k.repoHiddenPage].sort()));
    check(`${when}: …and removes the rest, a kept-on-delete one nothing loads any more included`, () =>
      assert.deepEqual(removedHere, [k.hostedRow, k.hostedHiddenOnly, k.repoUnused, k.repoDropped, k.cross].sort()));
    check(`${when}: …saying for each which pages and which repository still load it`, () => {
      assert.match(why(k.repoLiveRowDeleted), /Home/);
      assert.match(why(k.repoDraft), /Pricing/);
      assert.match(why(k.repoHiddenPage), /Old offer/);
      for (const entry of keptHere) assert.ok(entry.why.includes(repo.repoName!), entry.why);
    });
    check(`${when}: …and the log carries each kept key with the website and the reason, the only record once the site is gone`, () => {
      for (const entry of keptHere) {
        assert.ok(outcome.logged.some((line) => line.includes(entry.key) && line.includes(repo.id) && line.includes(entry.why)), entry.key);
      }
      assert.equal(outcome.logged.filter((line) => line.includes(repo.id)).length, keptHere.length);
    });
    check(`${when}: a key another site's library holds is never removed, nor reported as kept for this one`, () => {
      for (const shared of [k.hostedShared, k.repoShared]) { assert.ok(!removedHere.includes(shared), shared); assert.ok(!keptKeys.includes(shared), shared); }
    });
    check(`${when}: a package's own path is never removed, from a row or from a delete that kept it`, () => {
      for (const path of [k.hostedPackage, k.repoPackage]) { assert.ok(!removedHere.includes(path), path); assert.ok(!keptKeys.includes(path), path); }
    });
    const neighbourRows = await prisma.siteAsset.count({ where: { siteId: neighbour.id } });
    check(`${when}: the neighbour's library is untouched`, () => assert.equal(neighbourRows, 2));
  }
  server.close();

  console.log("\nA customer's account");
  const customer = await person("customer");
  const external = { ...customer, external: true };
  const wrong = await refusal(() => requestAccountDeletion(external, "not the password"));
  check("is not closed with the wrong password", () => assert.equal(wrong?.status, 401));

  const staff = await refusal(() => requestAccountDeletion({ ...customer, external: false }, password));
  check("a staff account is closed by an administrator, not from here", () => assert.equal(staff?.status, 403));

  const client = await prisma.client.create({ data: { name: `${mark}-client` } }); clientId = client.id;
  const product = await prisma.product.create({ data: { key: `${mark}-product`, name: `${mark} product`, monthlyPrice: 1 } }); productId = product.id;
  const purchase = await prisma.websitePurchase.create({ data: {
    clientId: client.id, productId: product.id, userId: customer.id, tier: "EDITOR", status: "ACTIVE",
    businessName: "Shop", contactName: "Customer", email: customer.email, websiteUrl: "https://example.test",
    compatibilityStatus: "COMPATIBLE", monthlyPrice: 1, setupPrice: 0,
  } });
  const paying = await refusal(() => requestAccountDeletion(external, password));
  check("is not closed while they are paying — cancel first", () => { assert.equal(paying?.status, 409); assert.match(paying!.message, /Cancel your subscription/); });
  await prisma.websitePurchase.delete({ where: { id: purchase.id } });

  const colleague = await person("colleague");
  const shared = await site("shared", [[customer, "MANAGER"], [colleague, "EDITOR"]]);
  const stranded = await refusal(() => requestAccountDeletion(external, password));
  check("is not closed while they are the only manager of a site others use", () => { assert.equal(stranded?.status, 409); assert.match(stranded!.message, /only manager/); });
  await prisma.siteMember.update({ where: { siteId_userId: { siteId: shared.id, userId: colleague.id } }, data: { role: "MANAGER" } });

  const alone = await site("alone", [[customer, "MANAGER"]]);
  await createSession(customer.id);
  const result = await requestAccountDeletion(external, password);
  const closed = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
  const sessionsLeft = await prisma.session.count({ where: { userId: customer.id } });
  check("closes at once: switched off and signed out everywhere", () => { assert.equal(closed.active, false); assert.equal(sessionsLeft, 0); });
  check("…and held for the same thirty days", () => assert.ok(closed.deletionScheduledFor));
  const aloneHeld = await prisma.site.findUniqueOrThrow({ where: { id: alone.id } });
  const sharedHeld = await prisma.site.findUniqueOrThrow({ where: { id: shared.id } });
  check("the website that was theirs alone is held for deletion with them", () => { assert.ok(aloneHeld.deletionScheduledFor); assert.deepEqual(result.websites, [alone.name]); });
  check("the shared website is left to the people still using it", () => assert.equal(sharedHeld.deletionScheduledFor, null));

  await purgeDueDeletions(new Date(Date.now() + (DELETION_HOLD_DAYS + 1) * DAY));
  const erased = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
  const memberships = await prisma.siteMember.count({ where: { userId: customer.id } });
  check("after the hold their personal details are erased", () => {
    assert.equal(erased.name, "Deleted account");
    assert.match(erased.email, /@deleted\.invalid$/);
    assert.equal(erased.passwordHash, null);
    assert.equal(erased.deletionScheduledFor, null);
  });
  check("and they are no longer a member of anything", () => assert.equal(memberships, 0));
  const aloneLeft = await prisma.site.count({ where: { id: alone.id } });
  check("their own website is gone", () => assert.equal(aloneLeft, 0));
} finally {
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.websitePurchase.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (productId) await prisma.product.delete({ where: { id: productId } }).catch(() => {});
  if (clientId) await prisma.client.delete({ where: { id: clientId } }).catch(() => {});
  await prisma.accessRole.deleteMany({ where: { key: `${mark}-role` } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
