import type { CarePlanTier, WebsitePlanTier } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { WITH_ACCESS, effectivePermissions } from "../lib/accessRoles.js";
import { stillEntitled } from "./websiteEntitlement.js";

/**
 * What a person is entitled to, product by product, across everything DakyX
 * sells — the one answer the Website Builder and the Marketing SaaS both read.
 *
 * The promise this enforces: **a client on an active retainer gets every
 * product.** Somebody who bought one product gets that one. Until 16 Oct 2026
 * the rule existed only as a schema comment and `productAccess()`, which only
 * the onboarding screen called; the code that decided what a signed-in person
 * could do never looked at a retainer, so a retainer client opening the
 * builder was given Starter.
 *
 * The decision is `decideEntitlements` — pure, so `checks/entitlements.ts`
 * can hold it to the rules without HTTP. `entitlementsFor` only gathers its
 * inputs. See docs/cross-product-access.md.
 */

export const PRODUCT_KEYS = ["website-builder", "marketing-suite"] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

/** Each product's tiers, lowest first, in that product's own vocabulary. */
export const PRODUCT_TIERS: Record<ProductKey, readonly string[]> = {
  "website-builder": ["EDITOR", "CARE", "MANAGED"] satisfies WebsitePlanTier[],
  // The keys of PLAN_QUOTA_BY_TIER in the Marketing SaaS. Never a display name:
  // that side used to guess a tier from a plan's name by substring.
  "marketing-suite": ["free", "starter", "growth", "pro", "agency"],
};

/**
 * What each retainer includes. Every retainer gets the whole builder — the
 * public pricing page already says "included at no extra cost with every
 * DakyXTech retainer" across all three tiers — and a Marketing SaaS tier that
 * grows with the retainer.
 */
export const RETAINER_TIERS: Record<CarePlanTier, Record<ProductKey, string>> = {
  FOUNDATION: { "website-builder": "MANAGED", "marketing-suite": "growth" },
  GROWTH: { "website-builder": "MANAGED", "marketing-suite": "pro" },
  TRANSFORMATION: { "website-builder": "MANAGED", "marketing-suite": "agency" },
};

/** Staff get the builder from `website.manage`, as before. Nothing else from a permission. */
const STAFF_PERMISSION = "website.manage";
const STAFF_BUILDER_TIER: WebsitePlanTier = "MANAGED";

export type GrantSource = "retainer" | "subscription" | "staff" | "comp";

export type Grant = {
  product: ProductKey;
  tier: string;
  source: GrantSource;
  /** The client whose retainer covers it, when one does. */
  clientId: string | null;
  /** ISO. Null is open-ended while its source stands. */
  validUntil: string | null;
};

export type Entitlements = {
  /** The OS `User.id` — the `sub` a partner product keys its mapping on. */
  subject: string;
  /** When this answer was worked out, in ms. A receiver drops anything older than what it holds. */
  version: number;
  active: boolean;
  grants: Grant[];
};

export type EntitlementInputs = {
  user: { id: string; active: boolean; deletionScheduledFor: Date | null };
  /** Active retainers of every client this person is a member of. */
  retainers: Array<{ clientId: string; tier: CarePlanTier }>;
  /** The builder subscription that `stillEntitled` accepts, if any. */
  seat: { tier: WebsitePlanTier; validUntil: Date | null } | null;
  staff: boolean;
  comps: Array<{ productKey: string; tier: string; validUntil: Date | null; revokedAt: Date | null }>;
  now?: Date;
};

export function tierRank(product: ProductKey, tier: string): number {
  return PRODUCT_TIERS[product].indexOf(tier);
}

/** When two sources give the same tier, the one shown is the one a person would name. */
const SOURCE_ORDER: GrantSource[] = ["retainer", "subscription", "comp", "staff"];

function better(a: Grant, b: Grant): Grant {
  const ra = tierRank(a.product, a.tier);
  const rb = tierRank(b.product, b.tier);
  if (ra !== rb) return ra > rb ? a : b;
  return SOURCE_ORDER.indexOf(a.source) <= SOURCE_ORDER.indexOf(b.source) ? a : b;
}

export function decideEntitlements(input: EntitlementInputs): Grant[] {
  const now = input.now ?? new Date();
  const { user } = input;
  // A switched-off account, or one waiting to be erased, holds nothing — not
  // even what a still-active retainer of its old client would give.
  if (!user.active || user.deletionScheduledFor) return [];

  const candidates: Grant[] = [];

  for (const retainer of input.retainers) {
    const tiers = RETAINER_TIERS[retainer.tier];
    if (!tiers) continue;
    for (const product of PRODUCT_KEYS) {
      candidates.push({ product, tier: tiers[product], source: "retainer", clientId: retainer.clientId, validUntil: null });
    }
  }

  if (input.seat) {
    candidates.push({
      product: "website-builder",
      tier: input.seat.tier,
      source: "subscription",
      clientId: null,
      validUntil: input.seat.validUntil ? input.seat.validUntil.toISOString() : null,
    });
  }

  if (input.staff) {
    candidates.push({ product: "website-builder", tier: STAFF_BUILDER_TIER, source: "staff", clientId: null, validUntil: null });
  }

  for (const comp of input.comps) {
    if (comp.revokedAt) continue;
    if (comp.validUntil && comp.validUntil.getTime() <= now.getTime()) continue;
    if (!(PRODUCT_KEYS as readonly string[]).includes(comp.productKey)) continue;
    const product = comp.productKey as ProductKey;
    // A tier the product does not have is a typo, and a typo must not grant.
    if (tierRank(product, comp.tier) < 0) continue;
    candidates.push({ product, tier: comp.tier, source: "comp", clientId: null, validUntil: comp.validUntil ? comp.validUntil.toISOString() : null });
  }

  const best = new Map<ProductKey, Grant>();
  for (const grant of candidates) {
    const held = best.get(grant.product);
    best.set(grant.product, held ? better(held, grant) : grant);
  }
  return PRODUCT_KEYS.flatMap((product) => (best.has(product) ? [best.get(product)!] : []));
}

/** The best active retainer covering this person, if any. */
export async function retainerFor(userId: string): Promise<{ clientId: string; tier: CarePlanTier } | null> {
  const plans = await activeRetainers(userId);
  const order: CarePlanTier[] = ["FOUNDATION", "GROWTH", "TRANSFORMATION"];
  return plans.sort((a, b) => order.indexOf(b.tier) - order.indexOf(a.tier))[0] ?? null;
}

async function activeRetainers(userId: string) {
  const plans = await prisma.carePlan.findMany({
    where: { status: "ACTIVE", client: { members: { some: { userId } } } },
    select: { clientId: true, tier: true },
  });
  return plans;
}

async function liveSeat(userId: string, email: string) {
  const rows = await prisma.websitePurchase.findMany({
    where: { setupPaidAt: { not: null }, OR: [{ userId }, { userId: null, email: email.toLowerCase() }] },
    orderBy: [{ activatedAt: "desc" }, { createdAt: "desc" }],
    select: { tier: true, nextBillingAt: true, billingState: true },
  });
  const now = new Date();
  const ranked = rows.filter((row) => stillEntitled(row, now));
  if (!ranked.length) return null;
  const top = ranked.reduce((a, b) => (tierRank("website-builder", b.tier) > tierRank("website-builder", a.tier) ? b : a));
  const ending = top.billingState === "CANCELLED" || top.billingState === "NON_RENEWING" || top.billingState === "CANCELLING";
  return { tier: top.tier, validUntil: ending ? top.nextBillingAt : null };
}

export async function entitlementsFor(userId: string, now = new Date()): Promise<Entitlements> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: WITH_ACCESS });
  if (!user) return { subject: userId, version: now.getTime(), active: false, grants: [] };

  const [retainers, seat, comps] = await Promise.all([
    activeRetainers(user.id),
    liveSeat(user.id, user.email),
    prisma.productGrant.findMany({ where: { userId: user.id }, select: { productKey: true, tier: true, validUntil: true, revokedAt: true } }),
  ]);
  const permissions = effectivePermissions(user);
  const staff = permissions.has(STAFF_PERMISSION) && !user.accessRole?.external;

  const grants = decideEntitlements({ user, retainers, seat, staff, comps, now });
  return { subject: user.id, version: now.getTime(), active: user.active && !user.deletionScheduledFor, grants };
}

/* ------------------------------------------------- telling the partners --- */

/**
 * Queues "this person's entitlements may have changed" for every partner
 * product. Cheap and idempotent from the receiver's side — it refetches — so
 * callers announce generously rather than working out whether a grant moved.
 */
export async function announceEntitlementChange(userIds: Iterable<string>): Promise<void> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (!unique.length || !partnerEventsConfigured()) return;
  await prisma.entitlementEvent.createMany({ data: unique.map((userId) => ({ userId })) });
}

/** Everybody a client's retainer reaches. */
export async function announceClientChange(clientId: string): Promise<void> {
  const members = await prisma.clientMember.findMany({ where: { clientId }, select: { userId: true } });
  await announceEntitlementChange(members.map((member) => member.userId));
}

/** Fire-and-forget for route handlers: an announcement must never fail the write it follows. */
export function announceSoon(work: () => Promise<void>): void {
  void work().catch((err) => console.error("Could not queue an entitlement change:", (err as Error).message));
}

export function partnerEventsConfigured(): boolean {
  return Boolean(process.env.PARTNER_MARKETING_EVENTS_URL?.trim() && process.env.PARTNER_MARKETING_API_KEY?.trim());
}
