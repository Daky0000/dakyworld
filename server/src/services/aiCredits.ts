import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { isPaidProvider, type TaskLevel } from "../lib/models/registry.js";
import { usagePeriod } from "./websiteEntitlement.js";

/**
 * AI credits: what the Builder agent and the design assistant cost a customer
 * (the Owner's call, 22 Oct 2026).
 *
 * Every plan has a month's credits — Starter 30, Pro 100, Business 300 — that
 * reset on the 1st, and credits can be bought in packs that never expire. A
 * request spends the month's credits first and bought ones after.
 *
 * **A request costs what answered it.** One credit when a free model did; when
 * the three free ones could not and a paid model took over, the size the
 * router gave the request decides: simple 2, standard 3, complex 5. A request
 * no model answered — undo, a whole-site font swap, a section from the
 * library — costs nothing. One credit is held when a request starts, so
 * somebody with none left is told before anything runs; the rest is settled
 * once it is known who answered, and everything held goes back if it fails.
 * A request is never stopped half-way for want of credit: what cannot be
 * covered at settlement is written off and said in the history.
 *
 * DakyXTech staff never spend credits — fixing a client's site must not stop
 * at the client's balance, and the Owner's own sites have no plan to draw on.
 */

export const CREDIT_COST = { free: 1, simple: 2, standard: 3, complex: 5 } as const;

/** Who answered a request: the vendor that served it, and the level the router sized it at. */
export type Answered = { provider: string | null; level?: TaskLevel | null } | null | undefined;

/** Credits a request costs, from what answered it. Nothing when no model was asked. */
export function creditsFor(answered: Answered): number {
  if (!answered?.provider) return 0;
  if (!isPaidProvider(answered.provider)) return CREDIT_COST.free;
  return CREDIT_COST[answered.level ?? "standard"];
}

/** How many came from each pocket. */
export type Taken = { plan: number; bought: number };

export class OutOfCredits extends Error {
  status = 402;
  constructor(public limit: number) {
    super(
      `You are out of AI credits: this month's ${limit} are used and there are no bought credits left. ` +
        "Buy credits on the Balance screen — they never expire — or wait for the month's credits on the 1st. Ordinary editing still works.",
    );
  }
}

/**
 * Takes `wanted` credits, this month's first. All or nothing unless `partial`,
 * which takes what there is (settlement after the work is done).
 *
 * Each pocket is changed with a guarded update, so two requests racing for the
 * last credit cannot both have it: the loser takes nothing and, unless
 * partial, is refused.
 */
export async function takeCredits(
  tx: Prisma.TransactionClient,
  input: { userId: string; limit: number; wanted: number; partial?: boolean; period?: string },
): Promise<Taken | null> {
  const period = input.period ?? usagePeriod();
  if (input.wanted <= 0) return { plan: 0, bought: 0 };
  const usage = await tx.websiteUsage.upsert({ where: { userId_period: { userId: input.userId, period } }, create: { userId: input.userId, period }, update: {} });
  const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { aiCreditsBought: true } });
  const plan = Math.min(Math.max(0, input.limit - usage.aiPrompts), input.wanted);
  const bought = Math.min(Math.max(0, user.aiCreditsBought), input.wanted - plan);
  if (plan + bought < input.wanted && !input.partial) return null;
  if (plan > 0) {
    const took = await tx.websiteUsage.updateMany({ where: { id: usage.id, aiPrompts: { lte: input.limit - plan } }, data: { aiPrompts: { increment: plan } } });
    if (!took.count) return input.partial ? { plan: 0, bought: 0 } : null;
  }
  if (bought > 0) {
    const took = await tx.user.updateMany({ where: { id: input.userId, aiCreditsBought: { gte: bought } }, data: { aiCreditsBought: { decrement: bought } } });
    if (!took.count) {
      if (plan > 0) await tx.websiteUsage.update({ where: { id: usage.id }, data: { aiPrompts: { decrement: plan } } });
      return input.partial ? { plan: 0, bought: 0 } : null;
    }
  }
  return { plan, bought };
}

/** Gives credits back to the pockets they came from. */
export async function returnCredits(tx: Prisma.TransactionClient, input: { userId: string; taken: Taken; period?: string }) {
  const period = input.period ?? usagePeriod();
  if (input.taken.plan > 0) {
    await tx.websiteUsage.updateMany({ where: { userId: input.userId, period, aiPrompts: { gte: input.taken.plan } }, data: { aiPrompts: { decrement: input.taken.plan } } });
  }
  if (input.taken.bought > 0) {
    await tx.user.update({ where: { id: input.userId }, data: { aiCreditsBought: { increment: input.taken.bought } } });
  }
}

/** What a charge was for, in words, for the history. */
export function chargeNote(what: "Builder agent" | "Design assistant", answered: Answered, cost: number): string {
  if (!cost) return `${what} · no model needed`;
  if (!answered?.provider || !isPaidProvider(answered.provider)) return `${what} · answered by a free model`;
  return `${what} · ${answered.level ?? "standard"} · answered by a paid model`;
}

/**
 * Settles a request that held `held` credits: takes the rest of what it cost,
 * or gives back what it did not. Writes one history line for the whole charge.
 * Returns what was finally charged from each pocket.
 */
export async function settleCredits(
  tx: Prisma.TransactionClient,
  input: { userId: string; limit: number; held: Taken; cost: number; period?: string; note: string; siteId?: string | null; jobId?: string | null },
): Promise<Taken> {
  const heldTotal = input.held.plan + input.held.bought;
  let charged: Taken = { ...input.held };
  let shortfall = 0;
  if (input.cost > heldTotal) {
    const extra = await takeCredits(tx, { userId: input.userId, limit: input.limit, wanted: input.cost - heldTotal, partial: true, period: input.period });
    charged = { plan: charged.plan + (extra?.plan ?? 0), bought: charged.bought + (extra?.bought ?? 0) };
    shortfall = input.cost - (charged.plan + charged.bought);
  } else if (input.cost < heldTotal) {
    // Back to bought credits first: they are the ones that cost money.
    let back = heldTotal - input.cost;
    const bought = Math.min(back, charged.bought);
    back -= bought;
    const plan = Math.min(back, charged.plan);
    await returnCredits(tx, { userId: input.userId, taken: { plan, bought }, period: input.period });
    charged = { plan: charged.plan - plan, bought: charged.bought - bought };
  }
  if (charged.plan + charged.bought > 0 || shortfall > 0) {
    await tx.aiCreditEntry.create({ data: {
      userId: input.userId, kind: "CHARGE", planDelta: -charged.plan, boughtDelta: -charged.bought,
      siteId: input.siteId ?? null, jobId: input.jobId ?? null,
      note: shortfall > 0 ? `${input.note} (${shortfall} not covered — the balance ran out during the request)` : input.note,
    } });
  }
  return charged;
}

/** The packs for sale. Prices in GHS, cheaper per credit the more bought. */
export const CREDIT_PACKS = [
  { id: "credits_100", credits: 100, amount: 150 },
  { id: "credits_300", credits: 300, amount: 400 },
  { id: "credits_1000", credits: 1000, amount: 1200 },
] as const;

/**
 * Adds a paid pack's credits to its account, once. Called inside the
 * transaction that marks the invoice paid, so a payment and its credits
 * cannot be separated, and a retried webhook grants nothing twice.
 */
export async function grantCreditsForInvoice(tx: Prisma.TransactionClient, invoiceId: string): Promise<number> {
  const purchase = await tx.aiCreditPurchase.findUnique({ where: { invoiceId } });
  if (!purchase || purchase.grantedAt) return 0;
  const claimed = await tx.aiCreditPurchase.updateMany({ where: { id: purchase.id, grantedAt: null }, data: { grantedAt: new Date() } });
  if (!claimed.count) return 0;
  await tx.user.update({ where: { id: purchase.userId }, data: { aiCreditsBought: { increment: purchase.credits } } });
  await tx.aiCreditEntry.create({ data: { userId: purchase.userId, kind: "PURCHASE", boughtDelta: purchase.credits, invoiceId, note: `Bought ${purchase.credits} credits` } });
  return purchase.credits;
}

/** An account's credits: the month's, and bought. */
export async function creditBalance(userId: string, limit: number) {
  const [usage, user] = await Promise.all([
    prisma.websiteUsage.findUnique({ where: { userId_period: { userId, period: usagePeriod() } }, select: { aiPrompts: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { aiCreditsBought: true } }),
  ]);
  const planUsed = usage?.aiPrompts ?? 0;
  const planLeft = Math.max(0, limit - planUsed);
  const bought = Math.max(0, user?.aiCreditsBought ?? 0);
  return { planLimit: limit, planUsed, planLeft, bought, total: planLeft + bought };
}
