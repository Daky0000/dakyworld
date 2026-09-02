import { businessOffer } from "./context/business.js";
import { SHIPPED_OFFER, type CarePlanTier as OfferPlan } from "./dakyworld.js";

/**
 * What each monthly partnership tier costs, read off the company's own website.
 *
 * **The defect this exists for.** The tier picker in the care plan editor
 * carried three hard-coded numbers — 5,000 / 12,500 / 25,000 — under three
 * names the website had stopped using. dakyworld.com by then sold Foundation,
 * Growth and Transformation, led with a Founding Partner rate of 3,000 / 7,000
 * / from 15,000 for the first three months, and said so on the page the client
 * was reading while agreeing the plan. Nothing failed. The OS simply priced a
 * different company's product, and the only way to notice was to have both
 * tabs open.
 *
 * So the numbers are not in this file and they are not in the schema. They come
 * from `services/context/business.ts`, which reads the site and stores what it
 * found, with `SHIPPED_OFFER` as the floor when there is no stored answer. The
 * chain is:
 *
 * ```
 * monthly-support.html --> syncBusinessOffer() --> AppSetting business.offer
 *                                                        |
 *                          carePlanCatalogue() <---------+
 *                                   |
 *                    the tier picker, and the price it fills in
 * ```
 *
 * Publish a price change to the site and the editor offers the new price on the
 * next sync. Nothing is redeployed and nobody retypes a number.
 *
 * **Three things deliberately do not come from the website.**
 *
 * 1. *Included hours.* The site publishes "a defined monthly capacity
 *    allocation" and no number, which is the correct thing to publish and
 *    useless to bill against. The figures below are the internal ones and are
 *    the only invented values in this file — they are a starting point in a
 *    form, not a promise anybody has made to a client.
 * 2. *An overage rate.* The site says work outside the allocation is estimated
 *    and approved as a separate project **before** it starts. An hourly
 *    overage that quietly appeared on the next invoice would contradict that,
 *    so no tier prefills one and `overageHourlyRate` stays null unless somebody
 *    types one for a client who agreed to it.
 * 3. *The tier list itself.* `CarePlanTier` is a database enum; a fourth plan
 *    on the site cannot become a fourth row here without a migration. Rather
 *    than drop it silently — which is how this drifted the first time — a plan
 *    the enum has no home for is returned in `unmatched` and the editor says so.
 */

export const CARE_PLAN_TIERS = ["FOUNDATION", "GROWTH", "TRANSFORMATION"] as const;
export type CarePlanTierKey = (typeof CARE_PLAN_TIERS)[number];

/** The tier as it is written on the website, and so on the invoice. */
export const TIER_LABEL: Record<CarePlanTierKey, string> = {
  FOUNDATION: "Foundation",
  GROWTH: "Growth",
  TRANSFORMATION: "Transformation",
};

/**
 * How long a Founding Partner rate runs before the standard rate takes over.
 * The site says "the first three months" in four separate places.
 */
export const FOUNDING_MONTHS = 3;

/**
 * Internal delivery capacity per tier — see (1) above. Not published, not a
 * claim, and overridable per plan in the editor.
 */
const INCLUDED_HOURS: Record<CarePlanTierKey, number> = {
  FOUNDATION: 6,
  GROWTH: 12,
  TRANSFORMATION: 25,
};

/** How often the plan's formal review falls due, in months. */
const REVIEW_EVERY_MONTHS: Record<CarePlanTierKey, number> = {
  FOUNDATION: 3,
  GROWTH: 3,
  TRANSFORMATION: 3,
};

export interface CarePlanTierOption {
  tier: CarePlanTierKey;
  label: string;
  /** The published standard rate. Null where the site publishes no number. */
  standardMonthly: number | null;
  /**
   * The rate on offer now. Null when no discount is running, which is the
   * state this should eventually return to — a closed programme must be able
   * to disappear rather than live on as a price nobody can still buy.
   */
  foundingMonthly: number | null;
  /** True where the site prices the tier "from" a number rather than at one. */
  fromPrice: boolean;
  /** The site's own sentence about the discount. Empty when there isn't one. */
  discountNote: string;
  /** Who the site says the tier is for. */
  for: string;
  /** The internal capacity figure, in hours. */
  includedHours: number;
  reviewEveryMonths: number;
}

export interface CarePlanCatalogue {
  tiers: CarePlanTierOption[];
  currency: string;
  foundingMonths: number;
  /** Where the prices came from — the live site, or the shipped constants. */
  source: "website" | "shipped";
  /** When the site was last read, ISO. Null when it never has been. */
  syncedAt: string | null;
  /**
   * Plans the website sells that this database has no tier for. Empty in the
   * ordinary case; anything here is a migration waiting to be written, and the
   * editor shows it rather than pretending the site said nothing.
   */
  unmatched: string[];
}

/** "Foundation" and "FOUNDATION " and "foundation" are the same tier. */
const normalise = (name: string) => name.trim().toLowerCase();

/** A rate is only a discount while it is lower than the standard one. */
function discountOf(plan: OfferPlan): number | null {
  if (plan.discountedMonthly === null) return null;
  if (plan.monthly !== null && plan.discountedMonthly >= plan.monthly) return null;
  return plan.discountedMonthly;
}

function optionFor(tier: CarePlanTierKey, plan: OfferPlan | undefined): CarePlanTierOption {
  return {
    tier,
    label: TIER_LABEL[tier],
    standardMonthly: plan?.monthly ?? null,
    foundingMonthly: plan ? discountOf(plan) : null,
    // Best-effort, and harmless either way: the site writes "From GHS 15,000"
    // for Transformation and a bare figure for the other two, so the note is
    // where the qualifier lives. A miss costs a word on a button, not a price.
    fromPrice: plan ? /\bfrom\s+GHS/i.test(plan.discountNote) || /\bfrom\s+GHS/i.test(plan.for) : false,
    discountNote: plan?.discountNote ?? "",
    for: plan?.for ?? "",
    includedHours: INCLUDED_HOURS[tier],
    reviewEveryMonths: REVIEW_EVERY_MONTHS[tier],
  };
}

/**
 * The three tiers, priced as the website prices them.
 *
 * Never throws and never returns an empty list: a tier the site could not be
 * read for falls back to the shipped plan of the same name, and a tier neither
 * knows about still appears with null prices, because a picker missing a tier
 * is worse than a picker showing one whose price has to be typed.
 */
export async function carePlanCatalogue(): Promise<CarePlanCatalogue> {
  const state = await businessOffer();

  const live = new Map(state.offer.plans.map((plan) => [normalise(plan.tier), plan]));
  const shipped = new Map(SHIPPED_OFFER.plans.map((plan) => [normalise(plan.tier), plan]));

  const tiers = CARE_PLAN_TIERS.map((tier) => {
    const key = normalise(TIER_LABEL[tier]);
    return optionFor(tier, live.get(key) ?? shipped.get(key));
  });

  const known = new Set(CARE_PLAN_TIERS.map((tier) => normalise(TIER_LABEL[tier])));
  const unmatched = state.offer.plans.filter((plan) => !known.has(normalise(plan.tier))).map((plan) => plan.tier);

  return {
    tiers,
    currency: "GHS",
    foundingMonths: FOUNDING_MONTHS,
    source: state.from,
    syncedAt: state.syncedAt,
    unmatched,
  };
}

/** Which of the website's two published rates a plan is being sold at. */
export type CarePlanRate = "FOUNDING" | "STANDARD";

export interface TierPricing {
  /** What the plan bills each month from now. */
  monthlyFee: number;
  /** The rate waiting behind it, or null when there is nothing to step up to. */
  standardMonthlyFee: number | null;
  foundingRateUntil: Date | null;
  includedHours: number;
  reviewEveryMonths: number;
  /**
   * The rate actually applied, which is not always the one asked for: a plan
   * asked for at the Founding Partner rate after the programme has closed is
   * priced at the standard rate and says so, rather than being sold at a
   * discount that no longer exists.
   */
  rate: CarePlanRate;
}

/**
 * What a tier costs, at one of the two rates the website publishes.
 *
 * Returns null when the site publishes no number for that tier at all. That is
 * the one case where the caller has to be told to type a price, and it is
 * deliberately not papered over with a guess — a made-up retainer fee is a
 * number somebody would go on to invoice.
 */
export async function priceForTier(tier: CarePlanTierKey, rate: CarePlanRate, from = new Date()): Promise<TierPricing | null> {
  const catalogue = await carePlanCatalogue();
  const option = catalogue.tiers.find((entry) => entry.tier === tier);
  if (!option) return null;

  const shared = { includedHours: option.includedHours, reviewEveryMonths: option.reviewEveryMonths };

  if (rate === "FOUNDING" && option.foundingMonthly !== null) {
    return {
      monthlyFee: option.foundingMonthly,
      // Null where the site prices the tier only at a discount — then there is
      // genuinely nothing to step up to, and inventing one would be a price
      // rise nobody agreed.
      standardMonthlyFee: option.standardMonthly,
      foundingRateUntil: option.standardMonthly === null ? null : foundingRateEnd(from, catalogue.foundingMonths),
      rate: "FOUNDING",
      ...shared,
    };
  }

  if (option.standardMonthly === null) return null;
  return { monthlyFee: option.standardMonthly, standardMonthlyFee: null, foundingRateUntil: null, rate: "STANDARD", ...shared };
}

/** What a save is asking for. A subset of the care plan input schema. */
export interface PricingRequest {
  tier?: CarePlanTierKey;
  rate?: CarePlanRate;
  monthlyFee?: number;
  includedHours?: number | null;
}

/** The plan being edited, or null when one is being created. */
export interface ExistingPlanPricing {
  tier: CarePlanTierKey;
  /** Non-null on a plan still inside its Founding Partner period. */
  standardMonthlyFee: unknown;
  foundingRateUntil: Date | null;
}

/** The money fields a save should end up with. Absent keys are left alone. */
export interface PricedFields {
  monthlyFee?: number;
  standardMonthlyFee?: number | null;
  foundingRateUntil?: Date | null;
  includedHours?: number | null;
}

/**
 * The one place that answers "changing the tier changed the price, didn't it?"
 * with a yes.
 *
 * It used to be a no. The tier picker prefilled a fee on a *new* plan and
 * deliberately left an existing one alone, so moving a client from Foundation
 * to Growth renamed their plan and went on invoicing the Foundation fee, in
 * silence, until somebody read an invoice. That guard existed for a real
 * reason — an agreed price must not be rewritten by a stray click — so the
 * rule here is narrower than "always reprice" and wider than "never":
 *
 * - **The tier moved, and no fee was sent.** Reprice. This is the case that
 *   was broken, and the case the Care Plans screen now sends.
 * - **A fee was sent.** The fee wins, always. A negotiated number survives
 *   every tier change, which is what the old guard was really protecting.
 * - **A rate was named.** Reprice at that rate even if the tier did not move —
 *   this is how a plan steps off the Founding Partner rate by hand.
 * - **Neither.** Nothing is touched. Editing a billing day never moves a price.
 *
 * Returns null where the website publishes no price for the tier: the caller
 * has to be told to type one rather than handed a guess, because a made-up
 * retainer fee is a number somebody would go on to invoice.
 */
export async function pricedFieldsFor(input: PricingRequest, existing: ExistingPlanPricing | null): Promise<PricedFields | null> {
  const tier = input.tier ?? existing?.tier;
  if (!tier) return {};

  const tierMoved = input.tier !== undefined && input.tier !== existing?.tier;
  const feeGiven = input.monthlyFee !== undefined;
  const rateAsked = input.rate !== undefined;

  // A create with an explicit fee, or any edit that neither moved the tier nor
  // named a rate, is priced by the caller and left alone.
  if (!rateAsked && (feeGiven || (existing && !tierMoved))) return {};

  // No rate named: keep the plan on the footing it is already on. A plan still
  // inside its founding period stays inside it; everything else is standard.
  const rate: CarePlanRate = input.rate ?? (existing?.standardMonthlyFee != null ? "FOUNDING" : "STANDARD");
  const priced = await priceForTier(tier, rate);
  if (!priced) return null;

  return {
    monthlyFee: priced.monthlyFee,
    standardMonthlyFee: priced.standardMonthlyFee,
    // Changing tier mid-discount must not restart the three months. A clock
    // already running is kept; one that is not starts today.
    foundingRateUntil: priced.foundingRateUntil === null ? null : (existing?.foundingRateUntil ?? priced.foundingRateUntil),
    // The capacity belongs to the tier too, but a number somebody typed wins.
    includedHours: input.includedHours === undefined ? priced.includedHours : input.includedHours,
  };
}

/**
 * The date a founding rate agreed today stops applying.
 *
 * Counted from when the rate is *given*, not from when the plan started: a
 * client moved onto the programme in month six gets three months of it from
 * month six, and a date already in the past would step the price up on the
 * very next invoice, which is not what anybody agreeing a discount meant.
 */
export function foundingRateEnd(from: Date, months = FOUNDING_MONTHS): Date {
  const end = new Date(from);
  end.setUTCMonth(end.getUTCMonth() + months);
  return end;
}
