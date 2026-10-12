/**
 * Deleting a website or a customer account: offline at once, restorable for
 * thirty days, then really gone — and the refusals that stop a customer
 * deleting the wrong thing.
 *
 * Needs an isolated local database (its name must contain test, check or
 * editor); it creates and removes its own rows.
 *   npx tsx checks/websiteDeletion.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("websiteDeletion needs an isolated local test/editor database.");
}

const { prisma } = await import("../src/lib/prisma.js");
const { hashPassword } = await import("../src/lib/password.js");
const { createSession } = await import("../src/lib/session.js");
const { WebsiteError } = await import("../src/services/website/site.js");
const { scheduleSiteDeletion, cancelSiteDeletion, requestAccountDeletion, purgeDueDeletions, assertSiteNotPendingDeletion, eraseSiteNow, mediaKeysToRemove, DELETION_HOLD_DAYS } = await import("../src/services/websiteDeletion.js");

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
