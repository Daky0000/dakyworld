import type { Request } from "express";
import type { WebsitePlanTier } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { IS_PRODUCTION } from "../middleware/auth.js";

/**
 * Who somebody is, what they are paying for, and what they have used.
 *
 * This file exists because the answer used to come from three places that a
 * customer could reach: an `x-dw-test-user` header the browser sends, a
 * module-level "switched user" shared by everybody on the instance, and a guess
 * made from the shape of an email address — an address containing "dan" or
 * "owner" was given the top tier. Any of the three handed out paid features to
 * anyone who asked for them.
 *
 * There is one rule now. Entitlement follows the signed-in user's subscription
 * row, and nothing a request carries can change it. The test switches survive
 * for local work only, behind the same two-signal check `middleware/auth.ts`
 * fails closed on, so a stray header on the live service means nothing.
 */

/** The same deployment signals middleware/auth.ts refuses to trust a header on. */
const DEPLOYED = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_ID ||
    process.env.RENDER ||
    process.env.FLY_APP_NAME ||
    process.env.DYNO ||
    process.env.VERCEL ||
    process.env.KUBERNETES_SERVICE_HOST,
);

/** True only where nothing is deployed and nothing is in production mode. */
export const TEST_SWITCHING_ALLOWED = !IS_PRODUCTION && !DEPLOYED;

/**
 * What somebody with no subscription at all may do.
 *
 * The lowest paid tier rather than nothing: an account exists here for reasons
 * other than buying — a colleague an Owner invited, a client given access to
 * one site — and locking the editor entirely would break the internal use of
 * it. What it must never be is the *highest* tier, which is what guessing from
 * the email address produced.
 */
const DEFAULT_TIER: WebsitePlanTier = "EDITOR";

/**
 * Staff get the full product, from a permission rather than from their address.
 *
 * `website.manage` is already the permission that means "runs the website side
 * of this business", it is assigned on the Access screen, and it is auditable.
 * An attacker cannot grant it to themselves by choosing an email.
 */
const STAFF_TIER: WebsitePlanTier = "MANAGED";
const STAFF_PERMISSION = "website.manage";

export type Entitlement = {
  userId: string | null;
  email: string;
  name: string;
  tier: WebsitePlanTier;
  /** When the paid subscription started, which is what the promotional window counts from. */
  subscribedAt: Date;
  /** The live subscription behind this tier, when the tier came from one. */
  purchaseId: string | null;
  currency: string;
  /** "subscription", "staff", or "default" — worth showing on screen and in support. */
  source: "subscription" | "staff" | "default" | "test-switch";
  /** Local only: pretend the promotional months have passed. */
  simulateAfter3Months: boolean;
};

/** Local-only override, set from the tier screen while working on the tiers. */
let switchedEmail: string | null = null;

export function getSwitchedUserEmail(): string | null {
  return TEST_SWITCHING_ALLOWED ? switchedEmail : null;
}

export function setSwitchedUserEmail(email: string | null): void {
  if (!TEST_SWITCHING_ALLOWED) return;
  switchedEmail = email ? email.trim().toLowerCase() : null;
}

/**
 * The live subscription for an account, if there is one.
 *
 * Matched on `userId` first, because that is the link a purchase creates now.
 * The email fallback covers subscriptions bought before the account existed —
 * a customer pays, then gets their login — and is safe because the address
 * compared is the one on the *authenticated* user, never one from the request.
 */
/**
 * Whether one paid-for subscription row still entitles its owner, and why.
 *
 * Pure, and separate from the query, because this is the decision and the
 * decision is what was wrong. Three faults met here and two of them cancelled
 * each other out, which is why nothing looked broken:
 *
 * 1. The query filtered `status` to the four healthy values, so a row the
 *    billing machine had marked `CANCELLED` or `FAILED` was **excluded by the
 *    database** and the grace logic below it never ran at all. A customer who
 *    cancelled lost their tier the same second, having paid to the end of the
 *    period.
 * 2. Cancelling wrote `nextBillingAt: null` at the same moment, and the grace
 *    test read a missing date as "has not started billing yet, keep serving".
 *    So repairing the filter alone would have swapped an instant cut-off for
 *    free access forever.
 * 3. `PAST_DUE` was written as `status: FAILED`, so a customer behind on
 *    payment also vanished from this query — dropping them to the default tier
 *    with no `purchaseId`, which is the one argument `editingLockedForNonPayment`
 *    needs. The entire dunning design was unreachable, and instead of the
 *    honest "editing is paused, your website is still online" they were quietly
 *    demoted to Starter and allowed to carry on editing at it.
 *
 * So `PAST_DUE` keeps its tier on purpose. Losing *editing* with the website
 * still served is the intended consequence of a declined card, and that is
 * decided by `editingLockedForNonPayment`, not by taking the plan away.
 */
export type EntitlingRow = {
  billingState: string;
  /** The date the customer is paid up to. Paystack's next billing date. */
  nextBillingAt: Date | null;
};

export function stillEntitled(row: EntitlingRow, now = new Date()): boolean {
  // Ending, but paid up to a date: serve until it passes. No date to honour
  // means there is nothing left to serve — never "serve indefinitely".
  if (row.billingState === "CANCELLED" || row.billingState === "NON_RENEWING") {
    return Boolean(row.nextBillingAt && row.nextBillingAt.getTime() > now.getTime());
  }
  // Mid-cancellation, and the outcome is not known yet. The customer asked to
  // stop and may still be paid up; refusing them here would take the product
  // away during our own uncertainty.
  if (row.billingState === "CANCELLING" || row.billingState === "CANCEL_UNCERTAIN") {
    return Boolean(row.nextBillingAt && row.nextBillingAt.getTime() > now.getTime());
  }
  // NONE, ACTIVE, PAST_DUE, CREATING, UNCERTAIN — the plan stands.
  return true;
}

async function liveSubscription(userId: string, email: string) {
  const now = new Date();
  const rows = await prisma.websitePurchase.findMany({
    where: {
      // Money has been taken at least once. This replaces a list of healthy
      // statuses, which is what hid a cancelled or past-due subscription from
      // its own grace period. `setupPaidAt` is set on the first settlement and
      // never cleared, so it separates "has paid" from "abandoned the checkout
      // or the first charge was declined" without naming a single status — and
      // it cannot fall behind when a status is added.
      setupPaidAt: { not: null },
      OR: [{ userId }, { userId: null, email: email.toLowerCase() }],
    },
    orderBy: [{ activatedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      tier: true,
      currency: true,
      activatedAt: true,
      createdAt: true,
      nextBillingAt: true,
      billingState: true,
    },
  });
  return rows.find((row) => stillEntitled(row, now)) ?? null;
}

export async function resolveEntitlement(req: Request): Promise<Entitlement> {
  const user = req.dbUser;
  const headerUser =
    TEST_SWITCHING_ALLOWED && typeof req.headers["x-dw-test-user"] === "string"
      ? req.headers["x-dw-test-user"].trim().toLowerCase()
      : null;
  const switchTarget = headerUser || getSwitchedUserEmail();

  const simHeader = Number(req.headers["x-dw-simulate-months"] ?? 0);
  const simulateAfter3Months = TEST_SWITCHING_ALLOWED && Number.isFinite(simHeader) && simHeader >= 3;

  if (switchTarget) {
    const target = await prisma.user.findUnique({ where: { email: switchTarget }, select: { id: true, email: true, name: true } });
    if (target) {
      const subscription = await liveSubscription(target.id, target.email);
      return {
        userId: target.id,
        email: target.email,
        name: target.name,
        tier: subscription?.tier ?? DEFAULT_TIER,
        subscribedAt: subscription?.activatedAt ?? subscription?.createdAt ?? new Date(),
        purchaseId: subscription?.id ?? null,
        currency: subscription?.currency ?? "GHS",
        source: "test-switch",
        simulateAfter3Months,
      };
    }
  }

  if (!user) {
    // No session. Every website route sits behind requireAuth, so this is a
    // check harness or an internal caller rather than a visitor.
    return {
      userId: null,
      email: "",
      name: "Not signed in",
      tier: DEFAULT_TIER,
      subscribedAt: new Date(),
      purchaseId: null,
      currency: "GHS",
      source: "default",
      simulateAfter3Months,
    };
  }

  const subscription = await liveSubscription(user.id, user.email);
  if (subscription) {
    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      tier: subscription.tier,
      subscribedAt: subscription.activatedAt ?? subscription.createdAt,
      purchaseId: subscription.id,
      currency: subscription.currency,
      source: "subscription",
      simulateAfter3Months,
    };
  }

  const isStaff = req.permissions?.has(STAFF_PERMISSION) || Boolean(user.accessRole?.superAdmin);
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    tier: isStaff ? STAFF_TIER : DEFAULT_TIER,
    subscribedAt: user.createdAt ?? new Date(),
    purchaseId: null,
    currency: "GHS",
    source: isStaff ? "staff" : "default",
    simulateAfter3Months,
  };
}

/* -------------------------------------------------------------- usage ----- */

export type UsageCounters = { imports: number; edits: number; aiPrompts: number };

const EMPTY: UsageCounters = { imports: 0, edits: 0, aiPrompts: 0 };

/** `2026-09`, in UTC, so a customer's month does not depend on where the server is. */
export function usagePeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export async function readUsage(userId: string | null, now = new Date()): Promise<UsageCounters> {
  if (!userId) return { ...EMPTY };
  const row = await prisma.websiteUsage.findUnique({
    where: { userId_period: { userId, period: usagePeriod(now) } },
    select: { imports: true, edits: true, aiPrompts: true },
  });
  return row ?? { ...EMPTY };
}

/**
 * Adds to one counter for this month.
 *
 * An upsert with an increment, so two requests arriving together add two rather
 * than reading the same number and writing it back twice. The whole point of
 * moving these out of process memory is that they survive a restart and agree
 * across instances; a read-modify-write would have given up half of that.
 */
export async function bumpUsage(
  userId: string | null,
  field: keyof UsageCounters,
  by = 1,
  now = new Date(),
): Promise<void> {
  if (!userId) return;
  const period = usagePeriod(now);
  await prisma.websiteUsage.upsert({
    where: { userId_period: { userId, period } },
    create: { userId, period, [field]: by },
    update: { [field]: { increment: by } },
  });
}
