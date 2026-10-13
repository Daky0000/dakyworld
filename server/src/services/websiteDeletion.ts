import type { User } from "@prisma/client";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "../lib/prisma.js";
import { getR2Client, isR2Configured } from "../lib/r2.js";
import { isUploadKey } from "./websiteAssets.js";
import { verifyPassword } from "../lib/password.js";
import { WebsiteError } from "./website/site.js";

/**
 * Deleting a website, or a customer's whole account, the way a person expects:
 * gone from the public at once, recoverable for a while, and then really gone.
 *
 * The hold is the point. A website is somebody's business, and the click that
 * deletes it is one slip away from the one that cancels a subscription, so a
 * deletion takes the site offline straight away and erases it thirty days
 * later — long enough to notice, short enough that the right to have your data
 * removed (Ghana's Data Protection Act 2012, s.33) is honoured within a month.
 *
 * A customer's account is erased by anonymising rather than deleting the row:
 * their name, address, password and second factor are wiped, and the row stays
 * so that the audit trail and the invoices the law requires us to keep still
 * point at something. Billing records are kept; nothing else personal is.
 */

export const DELETION_HOLD_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

/** When something asked for now is erased. */
export function deletionDate(from = new Date()): Date {
  return new Date(from.getTime() + DELETION_HOLD_DAYS * DAY_MS);
}

/** Publishing, scheduling and serving all stop while a website waits to be deleted. */
export function assertSiteNotPendingDeletion(site: { deletionScheduledFor: Date | null }): void {
  if (site.deletionScheduledFor) {
    throw new WebsiteError(
      409,
      `This website is scheduled for deletion on ${site.deletionScheduledFor.toISOString().slice(0, 10)}. Restore it from your account page to publish again.`,
    );
  }
}

type Actor = { id?: string | null; name?: string | null };

/**
 * Takes a website offline and schedules it for erasure. Pending scheduled
 * publishes are cancelled and open review links withdrawn, so nothing goes live
 * and no client is left reviewing a page that is about to disappear.
 */
export async function scheduleSiteDeletion(siteId: string, actor: Actor): Promise<Date> {
  const deletesOn = deletionDate();
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.site.updateMany({ where: { id: siteId, deletionScheduledFor: null }, data: { deletionScheduledFor: deletesOn } });
    if (!claimed.count) throw new WebsiteError(409, "This website is already scheduled for deletion.");
    await tx.scheduledPublish.updateMany({ where: { siteId, status: { in: ["PENDING", "ACTIVE_TEMPORARY"] } }, data: { status: "CANCELLED" } });
    await tx.reviewLink.updateMany({ where: { siteId, status: "PENDING" }, data: { status: "WITHDRAWN" } });
    await tx.siteAuditEvent.create({
      data: {
        siteId,
        kind: "SITE_DELETION_SCHEDULED",
        summary: `Asked for the website to be deleted. It is offline now and will be erased on ${deletesOn.toISOString().slice(0, 10)}.`,
        actorId: actor.id ?? null,
        actorName: actor.name ?? "Website manager",
      },
    });
  });
  return deletesOn;
}

export async function cancelSiteDeletion(siteId: string, actor: Actor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const restored = await tx.site.updateMany({ where: { id: siteId, deletionScheduledFor: { not: null, gt: new Date() } }, data: { deletionScheduledFor: null } });
    if (!restored.count) throw new WebsiteError(409, "This website is not waiting to be deleted.");
    await tx.siteAuditEvent.create({
      data: { siteId, kind: "SITE_DELETION_CANCELLED", summary: "Restored the website. It is back online.", actorId: actor.id ?? null, actorName: actor.name ?? "Website manager" },
    });
  });
}

/** Removes one stored object by key, and throws when it could not. */
export type MediaRemover = (key: string) => Promise<void>;

/**
 * R2's remover. Not `deleteFromR2`, which swallows every failure: an erasure
 * that left a customer's picture behind has to at least reach the log.
 */
const removeFromR2: MediaRemover = async (key) => {
  const r2 = getR2Client();
  if (!r2) throw new Error("Cloudflare R2 is not configured.");
  await r2.s3.send(new DeleteObjectCommand({ Bucket: r2.bucketName, Key: key }));
};
const defaultRemover = (): MediaRemover | null => (isR2Configured() ? removeFromR2 : null);

/**
 * An object an erasure left in the bucket on purpose, and why. Once the site
 * has gone this, and the log line written with it, is the only record of the
 * key — which is what somebody needs to remove it by hand if the customer asks.
 */
export type KeptObject = { key: string; why: string };

/**
 * What an erasure has to decide about a site's media, read before its rows
 * cascade away: every key it may own, and — for a site with a repository —
 * which of those its own pages still mention.
 */
type SiteMedia = { siteId: string; name: string; repository: string | null; keys: string[]; onPages: Map<string, string[]> };

/** An upload's uuid, read off its key, and the same shape found anywhere in a page. */
const UPLOAD_ID = /^assets\/dw\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
const UPLOAD_ID_IN_TEXT = "assets/dw/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

/**
 * The keys a site may own, and the pages that still load each one.
 *
 * Two sources, because the remaining asset rows are not all of it. When the
 * delete route removes a row but keeps the object (`storedObjectStillNeeded`
 * in websiteAssets.ts), the only record of that key is the route's
 * ASSET_DELETED event — which cascades away with the site. Reading the rows
 * alone left every such object in the public bucket for good.
 *
 * A repository's pages are files in the customer's own repository, and with R2
 * on the editor writes the R2 address into them, so their live site loads
 * those pictures from this bucket whatever happens here. Which uploads the
 * site's pages mention — published copy, source or draft, hidden pages
 * included, as the delete route counts them — is worked out in the database,
 * by the upload's uuid: every address an upload can be written as contains
 * `assets/dw/<uuid>` (`mentionsAsset`), no other file has that uuid, and so
 * each page is read once, in Postgres, rather than once per key — and none of
 * its HTML comes back here. Testing every key against every page instead took
 * eight to eleven seconds on a 60-page site with 400 uploads; this takes a
 * quarter of one.
 */
async function siteMedia(siteId: string): Promise<SiteMedia | null> {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { name: true, repoOwner: true, repoName: true } });
  if (!site) return null;
  const [assets, deletions] = await Promise.all([
    prisma.siteAsset.findMany({ where: { siteId }, select: { repoPath: true } }),
    prisma.siteAuditEvent.findMany({ where: { siteId, kind: "ASSET_DELETED", detail: { path: ["storedObject"], equals: "kept" } }, select: { detail: true } }),
  ]);
  const keptOnDelete = deletions.map((event) => (event.detail as { repoPath?: unknown } | null)?.repoPath).filter((key): key is string => typeof key === "string");
  const keys = [...new Set([...assets.map((asset) => asset.repoPath), ...keptOnDelete].map((key) => key.replace(/^\/+/, "")).filter(Boolean))];
  const repository = site.repoName ? [site.repoOwner, site.repoName].filter(Boolean).join("/") : null;
  const onPages = new Map<string, string[]>();
  if (repository && keys.some(isUploadKey)) {
    const found = await prisma.$queryRaw<Array<{ id: string; titles: string[] }>>`
      SELECT mention.id, array_agg(mention.title ORDER BY mention."sortOrder", mention.path) AS titles
      FROM (
        SELECT DISTINCT m[1] AS id, p."title" AS title, p."sortOrder", p."path" AS path
        FROM "SitePage" p
        CROSS JOIN LATERAL regexp_matches(concat_ws(' ', p."publishedHtml", p."sourceHtml", p."draft"::text), ${UPLOAD_ID_IN_TEXT}, 'g') AS m
        WHERE p."siteId" = ${siteId}
      ) mention
      GROUP BY mention.id`;
    const titles = new Map(found.map((row) => [row.id, row.titles]));
    for (const key of keys.filter(isUploadKey)) {
      const pages = titles.get(UPLOAD_ID.exec(key)?.[1] ?? "");
      if (pages) onPages.set(key, pages);
    }
  }
  return { siteId, name: site.name, repository, keys, onPages };
}

/**
 * Reads a site's media for an erasure without ever failing it: a site whose
 * media could not be read is erased with nothing removed from the bucket,
 * which strands objects but never breaks a page somebody else still serves.
 */
async function readSiteMedia(siteId: string, remove: MediaRemover | null): Promise<SiteMedia | null> {
  if (!remove) return null;
  try {
    return await siteMedia(siteId);
  } catch (error) {
    console.error(`[website deletion] could not read website ${siteId}'s media, so none of it will be removed from object storage: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Which of an erased site's keys may go: an upload's own key (`isUploadKey`)
 * that nothing outside the site still holds — no other site's library, and no
 * other site's delete that kept the object.
 *
 * The bucket is shared and a key is a bare repoPath, so a package import's
 * `images/logo.png` may be another customer's or the company's own, and erasing
 * one customer must not take somebody else's picture with it. An upload's uuid
 * path can still be on two sites when one exported a package another imported,
 * hence the second test — and the site that deleted its copy's row first kept
 * the object because the other still had one, so its record counts as a hold
 * until that site is erased in turn.
 */
export function mediaKeysToRemove(siteKeys: string[], heldElsewhere: Iterable<string>): string[] {
  const kept = new Set(heldElsewhere);
  return siteKeys.filter((key) => isUploadKey(key) && !kept.has(key));
}

/**
 * Removes an erased site's media from R2, best effort, after the erasure has
 * already happened.
 *
 * The rows cascade with the site, but the objects are in another system and a
 * cascade cannot reach them, so a deleted website's pictures sat in the public
 * bucket for ever — which is not what "erased within the month" promises. It
 * never throws: object storage being down must not make an erasure fail or be
 * retried, so a failure is logged with the key and the sweep goes on.
 *
 * **A site with a repository keeps every upload its own pages mention**, and
 * says so: that site is still live on the customer's host and loads them from
 * here. Only a site DakyX served itself (no repository) has nothing outside
 * this system pointing at its objects, so only there does everything go.
 */
async function removeErasedSiteMedia(media: SiteMedia | null, remove: MediaRemover | null): Promise<{ removed: string[]; kept: KeptObject[] }> {
  const removed: string[] = [];
  const kept: KeptObject[] = [];
  if (!remove || !media?.keys.length) return { removed, kept };
  try {
    // Read after the cascade, so whatever still holds a key belongs to another site.
    const [rows, deletions] = await Promise.all([
      prisma.siteAsset.findMany({ where: { repoPath: { in: media.keys } }, select: { repoPath: true } }),
      prisma.$queryRaw<Array<{ key: string }>>`
        SELECT DISTINCT "detail"->>'repoPath' AS key FROM "SiteAuditEvent"
        WHERE "kind" = 'ASSET_DELETED' AND "detail"->>'storedObject' = 'kept' AND "detail"->>'repoPath' = ANY(${media.keys}::text[])`,
    ]);
    for (const key of mediaKeysToRemove(media.keys, [...rows.map((row) => row.repoPath), ...deletions.map((row) => row.key)])) {
      const pages = media.onPages.get(key);
      if (pages?.length) {
        const why = `${media.repository} still loads it from object storage, on ${pages.join(", ")}`;
        kept.push({ key, why });
        console.log(`[website deletion] kept ${key} after erasing website ${media.siteId} ("${media.name}"): ${why}`);
        continue;
      }
      try {
        await remove(key);
        removed.push(key);
      } catch (error) {
        console.error(`[website deletion] could not remove ${key} from object storage: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    console.error(`[website deletion] could not clear an erased website's media: ${(error as Error).message}`);
  }
  return { removed, kept };
}

/**
 * Erases a website straight away, for the person who is sure. Pages, versions,
 * assets, members, review links and the audit trail cascade from the site row
 * (schema.prisma), so there is nothing to restore afterwards; its media in R2
 * goes after it, except what a repository's pages still load (`mediaKept`).
 * `remove` is there for checks — it defaults to R2 when R2 is configured and
 * to nothing when it is not.
 */
export async function eraseSiteNow(siteId: string, remove: MediaRemover | null = defaultRemover()): Promise<{ mediaRemoved: string[]; mediaKept: KeptObject[] }> {
  const media = await readSiteMedia(siteId, remove);
  const erased = await prisma.site.deleteMany({ where: { id: siteId } });
  if (!erased.count) throw new WebsiteError(404, "No such website.");
  const { removed, kept } = await removeErasedSiteMedia(media, remove);
  return { mediaRemoved: removed, mediaKept: kept };
}

/**
 * A customer closing their own account.
 *
 * Refused while they are paying (cancel first, and keep the site until the
 * paid period ends), and refused while they are the only manager of a website
 * other people still use — that website would be left with nobody able to run
 * it. Websites that are theirs alone are scheduled for deletion with the
 * account. Every session ends now; the account cannot be signed into again.
 */
export async function requestAccountDeletion(user: Pick<User, "id" | "name" | "passwordHash"> & { external: boolean }, password: string): Promise<{ deletesOn: Date; websites: string[] }> {
  if (!user.external) throw new WebsiteError(403, "DakyXTech staff accounts are closed by an administrator, not from here.");
  if (!(await verifyPassword(password, user.passwordHash))) throw new WebsiteError(401, "That password is not right. Nothing has been deleted.");

  const paying = await prisma.websitePurchase.findFirst({
    where: { userId: user.id, status: { in: ["ACTIVE", "READY"] }, billingState: { notIn: ["CANCELLING", "CANCELLED"] } },
    select: { id: true },
  });
  if (paying) throw new WebsiteError(409, "Cancel your subscription first, from Balance & Invoices. Your website stays online until the paid period ends; after that you can delete your account here.");

  const memberships = await prisma.siteMember.findMany({
    where: { userId: user.id, site: { deletionScheduledFor: null } },
    select: { role: true, site: { select: { id: true, name: true, members: { where: { userId: { not: user.id } }, select: { role: true, user: { select: { active: true } } } } } } },
  });
  const stranded = memberships.filter((m) => m.role === "MANAGER" && m.site.members.length > 0 && !m.site.members.some((other) => other.role === "MANAGER" && other.user.active));
  if (stranded.length) {
    throw new WebsiteError(
      409,
      `You are the only manager of ${stranded.map((m) => `“${m.site.name}”`).join(", ")}, and other people use ${stranded.length === 1 ? "it" : "them"}. Make one of them a manager first, or delete ${stranded.length === 1 ? "that website" : "those websites"}.`,
    );
  }
  const theirsAlone = memberships.filter((m) => m.site.members.length === 0).map((m) => m.site);

  const deletesOn = deletionDate();
  for (const site of theirsAlone) {
    await scheduleSiteDeletion(site.id, { id: user.id, name: user.name }).catch((error) => {
      if (!(error instanceof WebsiteError && error.status === 409)) throw error;
    });
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { active: false, deletionScheduledFor: deletesOn } }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
    prisma.authToken.deleteMany({ where: { userId: user.id } }),
  ]);
  return { deletesOn, websites: theirsAlone.map((site) => site.name) };
}

/**
 * Erases a closed account's personal details. The row stays, renamed, so the
 * audit trail and billing records still resolve; the person does not.
 */
async function anonymiseAccount(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.siteMember.deleteMany({ where: { userId } }),
    prisma.session.deleteMany({ where: { userId } }),
    prisma.authToken.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: {
        email: `deleted-${userId}@deleted.invalid`,
        name: "Deleted account",
        passwordHash: null,
        active: false,
        totpSecret: null,
        totpConfirmedAt: null,
        totpRecoveryHashes: [],
        totpLastStep: null,
        emailVerifiedAt: null,
        extraPermissions: [],
        uiState: {},
        deletionScheduledFor: null,
      },
    }),
  ]);
}

/**
 * The daily sweep: websites and accounts whose hold has run out. Each delete
 * re-checks the date, so a restore that lands while this runs wins.
 */
export async function purgeDueDeletions(now = new Date(), remove: MediaRemover | null = defaultRemover()): Promise<{ websites: number; accounts: number; mediaRemoved: string[]; mediaKept: KeptObject[] }> {
  const sites = await prisma.site.findMany({ where: { deletionScheduledFor: { lte: now } }, select: { id: true } });
  let websites = 0;
  const mediaRemoved: string[] = [];
  const mediaKept: KeptObject[] = [];
  for (const site of sites) {
    // Pages, versions, assets, members, review links and the audit trail all
    // cascade from the site row (schema.prisma); the R2 objects do not, so
    // what decides them is read first — the same read and the same rules as
    // `eraseSiteNow` — and acted on only if the delete really happened.
    const media = await readSiteMedia(site.id, remove);
    const erased = (await prisma.site.deleteMany({ where: { id: site.id, deletionScheduledFor: { lte: now } } })).count;
    websites += erased;
    if (!erased) continue;
    const { removed, kept } = await removeErasedSiteMedia(media, remove);
    mediaRemoved.push(...removed);
    mediaKept.push(...kept);
  }
  const due = await prisma.user.findMany({ where: { deletionScheduledFor: { lte: now }, active: false }, select: { id: true } });
  for (const account of due) await anonymiseAccount(account.id);
  return { websites, accounts: due.length, mediaRemoved, mediaKept };
}
