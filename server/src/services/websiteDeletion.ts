import type { User } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
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
export async function purgeDueDeletions(now = new Date()): Promise<{ websites: number; accounts: number }> {
  const sites = await prisma.site.findMany({ where: { deletionScheduledFor: { lte: now } }, select: { id: true } });
  let websites = 0;
  for (const site of sites) {
    // Pages, versions, assets, members, review links and the audit trail all
    // cascade from the site row (schema.prisma).
    websites += (await prisma.site.deleteMany({ where: { id: site.id, deletionScheduledFor: { lte: now } } })).count;
  }
  const due = await prisma.user.findMany({ where: { deletionScheduledFor: { lte: now }, active: false }, select: { id: true } });
  for (const account of due) await anonymiseAccount(account.id);
  return { websites, accounts: due.length };
}
