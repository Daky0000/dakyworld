import type { WebsitePlanTier } from "@prisma/client";

/**
 * What each tier costs, in the currency the customer is actually billed in.
 *
 * Two currencies, because the product is sold in two places. Ghana pays in
 * cedis: it is the market Dakyworld sells in, the Paystack account settles GHS,
 * and quoting a Ghanaian business in dollars asks them to do arithmetic before
 * they can decide. Everybody else pays in dollars.
 *
 * The prices are not conversions of each other and should not be kept in step
 * by a rate. A cedi price is what the Ghanaian market pays for this; a dollar
 * price is what the rest of the world pays. Moving one is a commercial decision
 * about that market, not an exchange-rate update.
 *
 * A customer's currency is fixed at purchase and stored on their subscription,
 * so a change here never re-prices somebody who has already bought.
 */

export type PlanCurrency = "GHS" | "USD";

export type TierPrice = {
  currency: PlanCurrency;
  /** Charged for the first `promoMonths`. */
  promoMonthlyPrice: number;
  /** What it becomes afterwards. */
  standardMonthlyPrice: number;
  /** "GHS 300 (GHS 500)" or "$3 ($5)" — the promotional price with the standard one after it. */
  display: string;
  /** Just the promotional amount, for a price tag. */
  promoDisplay: string;
  standardDisplay: string;
};

const ghs = (promo: number, standard: number): TierPrice => ({
  currency: "GHS",
  promoMonthlyPrice: promo,
  standardMonthlyPrice: standard,
  display: `GHS ${promo.toLocaleString("en-GB")} (GHS ${standard.toLocaleString("en-GB")})`,
  promoDisplay: `GHS ${promo.toLocaleString("en-GB")}`,
  standardDisplay: `GHS ${standard.toLocaleString("en-GB")}`,
});

const usd = (promo: number, standard: number): TierPrice => ({
  currency: "USD",
  promoMonthlyPrice: promo,
  standardMonthlyPrice: standard,
  display: `$${promo} ($${standard})`,
  promoDisplay: `$${promo}`,
  standardDisplay: `$${standard}`,
});

/**
 * GHS 300 is the price the public site has advertised for the Website Builder
 * all along, so it stays the entry price and the other two are set around it.
 */
/**
 * A note on the dollar column, which needs a decision.
 *
 * The tiers were written as $3 / $10 / $25 while the public site advertised
 * GHS 300 — roughly $25 — for the same product. Those are not two prices for
 * two markets; they are one price and a tenth of it. Left alone, every customer
 * outside Ghana would have paid about an eighth of what a Ghanaian business
 * pays for the same thing.
 *
 * The dollar figures here are therefore set near parity with the cedi ones at
 * roughly GHS 12 to the dollar, rounded to numbers a price list can show. They
 * are a defensible placeholder, not a considered position on what this is worth
 * to a business in Lagos or London — that is a commercial decision, and this is
 * the one file to change when it is made.
 */
export const TIER_PRICES: Record<WebsitePlanTier, Record<PlanCurrency, TierPrice>> = {
  EDITOR: { GHS: ghs(300, 500), USD: usd(25, 40) },
  CARE: { GHS: ghs(900, 1500), USD: usd(75, 120) },
  MANAGED: { GHS: ghs(2400, 4000), USD: usd(195, 320) },
};

/** Ghana pays in cedis. Everywhere else pays in dollars. */
export function currencyForCountry(country: string | null | undefined): PlanCurrency {
  const code = (country ?? "").trim().toUpperCase();
  if (code === "GH" || code === "GHA" || code === "GHANA") return "GHS";
  return code ? "USD" : "GHS";
}

/**
 * The currency a request should be quoted in.
 *
 * An explicit choice wins, because somebody who has picked a currency on the
 * pricing page has told us more than any header can. Otherwise the country
 * Cloudflare or the browser reports, and failing both, cedis — this is a
 * Ghanaian company, and defaulting a Ghanaian visitor to dollars would be the
 * worse mistake of the two.
 */
export function resolveCurrency(input: {
  currency?: string | null;
  country?: string | null;
}): PlanCurrency {
  const explicit = (input.currency ?? "").trim().toUpperCase();
  if (explicit === "GHS" || explicit === "USD") return explicit;
  return currencyForCountry(input.country);
}

export function priceFor(tier: WebsitePlanTier, currency: PlanCurrency): TierPrice {
  return TIER_PRICES[tier][currency];
}

/** Minor units — pesewas or cents — which is what a processor wants. */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}
