import type { WebsitePlanTier } from "@prisma/client";
import { usdToGhsRate } from "./paymentQuote.js";

/**
 * What a tier costs, for anything that needs to *say* a price.
 *
 * Everything is charged in cedis. The Paystack account settles GHS, and one
 * settlement currency is what lets the billing state machine in
 * `paystackEvents.ts` compare an amount it is shown against an amount it
 * expects — a subscription priced in one currency and verified in another
 * cannot be checked at all.
 *
 * The catalogue's own prices are held in USD and converted at the merchant
 * rate (`PAYSTACK_USD_GHS_RATE`), which is what `paymentQuote.ts` does and is
 * the only place a customer's actual charge is decided. This file exists for
 * the screens and the emails: a plan's price on a panel, a figure in a
 * dunning notice, the fee for setting somebody up. It must never be used to
 * raise a payment — take a quote for that, so the number the customer accepted
 * and the number they are charged are the same object.
 *
 * An earlier pass had two independent price lists, one in cedis and one in
 * dollars, and billed each customer in their own. That was reversed on
 * 24 September 2026 in favour of the safety this buys.
 */

export type PlanCurrency = "GHS";

export type TierPrice = {
  currency: PlanCurrency;
  /** Charged for the first `promoMonths`, in cedis. */
  promoMonthlyPrice: number;
  standardMonthlyPrice: number;
  /** "GHS 300 (GHS 500)" — the promotional price with the standard one after it. */
  display: string;
  promoDisplay: string;
  standardDisplay: string;
};

/** The catalogue's dollar prices, which the rate turns into what is charged. */
const USD_PRICES: Record<WebsitePlanTier, { promo: number; standard: number }> = {
  EDITOR: { promo: 25, standard: 40 },
  CARE: { promo: 75, standard: 120 },
  MANAGED: { promo: 195, standard: 320 },
};

const cedis = (amount: number) => `GHS ${Math.round(amount).toLocaleString("en-GB")}`;

export function priceFor(tier: WebsitePlanTier, _currency: PlanCurrency = "GHS"): TierPrice {
  const rate = usdToGhsRate();
  const promo = Math.round(USD_PRICES[tier].promo * rate);
  const standard = Math.round(USD_PRICES[tier].standard * rate);
  return {
    currency: "GHS",
    promoMonthlyPrice: promo,
    standardMonthlyPrice: standard,
    display: `${cedis(promo)} (${cedis(standard)})`,
    promoDisplay: cedis(promo),
    standardDisplay: cedis(standard),
  };
}

/**
 * Setting it up for them, once, for a fee.
 *
 * Connecting a website is two DNS records or one GitHub installation, and for
 * most people that is twenty minutes with the guide open. For the rest it is
 * the thing that stops them ever starting, and "ask us and we will do it" is
 * worth more than another paragraph of documentation.
 *
 * Quoted at $10, charged in cedis at the same merchant rate as everything else.
 */
export const SETUP_ASSISTANCE_USD = 10;

export function setupAssistancePrice(): { amount: number; display: string; currency: PlanCurrency } {
  const amount = Math.round(SETUP_ASSISTANCE_USD * usdToGhsRate());
  return { amount, display: cedis(amount), currency: "GHS" };
}

/**
 * There is one billing currency, so this answers "GHS" whatever it is asked.
 *
 * Kept as a function rather than deleted because the callers read better for
 * it, and because the question it answers is a real one — it simply has one
 * answer while the merchant account has one settlement currency.
 */
export function resolveCurrency(_input?: { currency?: string | null; country?: string | null }): PlanCurrency {
  return "GHS";
}
