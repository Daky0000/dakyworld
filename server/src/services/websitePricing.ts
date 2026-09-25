import type { WebsitePlanTier } from "@prisma/client";
import { usdToGhsRate } from "./paymentQuote.js";

/**
 * What a Website Builder tier costs. The only price list there is.
 *
 * **Prices are authored in dollars and there are exactly three tiers.** Ghana
 * is quoted and charged the cedi equivalent at the merchant rate
 * (`PAYSTACK_USD_GHS_RATE`); everywhere else is quoted and charged the dollar
 * figure itself. The cedi column is a *conversion*, not a second market price —
 * moving a dollar figure here moves both.
 *
 * This file has been rewritten in both directions now, so the history is worth
 * keeping. An early pass held two independent lists — GHS 300 against $3 for
 * the same tier, one price and a tenth of it, and whichever a customer got
 * depended on a country field the checkout never sent. That was collapsed to a
 * single cedi list on 24 September 2026 for a good reason: the billing state
 * machine in `paystackEvents.ts` verifies the amount *and currency* Paystack
 * reports against what it expects, and two unrelated lists make that check
 * meaningless.
 *
 * Dual currency is restored here, and that verification still holds, because
 * the two columns are one list: a purchase stores the currency it was sold in,
 * the Paystack plan is created in that same currency, and the cedi figure is
 * always the dollar figure times the rate. There is one number per tier to
 * change, and nothing can drift from it.
 *
 * What this file is *for* is saying a price — a panel, a price list, a dunning
 * notice. It must never raise a payment: take a quote from `paymentQuote.ts`,
 * so the number a customer accepted and the number their card is charged are
 * the same object.
 */

export type PlanCurrency = "GHS" | "USD";

export type TierPrice = {
  currency: PlanCurrency;
  /** Charged for the first `promoMonths`, in `currency`. */
  promoMonthlyPrice: number;
  standardMonthlyPrice: number;
  /** "$3 ($5)" — the promotional price with the standard one after it. */
  display: string;
  promoDisplay: string;
  standardDisplay: string;
};

/**
 * The three tiers, in dollars. Everything anybody is ever charged comes from
 * these six numbers.
 */
export const USD_PRICES: Record<WebsitePlanTier, { promo: number; standard: number }> = {
  EDITOR: { promo: 3, standard: 5 },
  CARE: { promo: 10, standard: 16 },
  MANAGED: { promo: 25, standard: 45 },
};

export const PLAN_CURRENCIES: readonly PlanCurrency[] = ["GHS", "USD"];

/**
 * Whether the processor can actually settle dollars.
 *
 * Paystack charges in the currencies a merchant account is *enabled* for. On a
 * cedi-only account, sending `currency: "USD"` is refused outright — and that
 * refusal reaches the customer as a broken checkout at the last step rather
 * than as a currency we do not take yet. A USD-enabled account can charge a
 * card in dollars and settle the merchant in cedis, which is the intended
 * arrangement here, but it has to be turned on by Paystack first.
 *
 * Off by default for that reason: the failure it guards against is silent and
 * total for every international customer, and the guard costs one variable.
 * Confirm the account is USD-enabled with Paystack, then set
 * `WEBSITE_USD_ENABLED=true` — no deploy, no code change.
 */
export function usdEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.WEBSITE_USD_ENABLED ?? "").trim());
}

/** The currencies a customer may be quoted and charged in right now. */
export function enabledPlanCurrencies(): PlanCurrency[] {
  return PLAN_CURRENCIES.filter((code) => code === "GHS" || usdEnabled());
}

const money = (amount: number) => Math.round(amount).toLocaleString("en-GB");
const label = (currency: PlanCurrency, amount: number) =>
  currency === "USD" ? `$${money(amount)}` : `GHS ${money(amount)}`;

/** What one tier costs in one currency. Cedis are the dollars times the rate. */
export function amountsFor(tier: WebsitePlanTier, currency: PlanCurrency) {
  const usd = USD_PRICES[tier];
  const multiplier = currency === "USD" ? 1 : usdToGhsRate();
  return {
    promo: Math.round(usd.promo * multiplier),
    standard: Math.round(usd.standard * multiplier),
  };
}

export function priceFor(tier: WebsitePlanTier, currency: PlanCurrency = "GHS"): TierPrice {
  const { promo, standard } = amountsFor(tier, currency);
  return {
    currency,
    promoMonthlyPrice: promo,
    standardMonthlyPrice: standard,
    display: `${label(currency, promo)} (${label(currency, standard)})`,
    promoDisplay: label(currency, promo),
    standardDisplay: label(currency, standard),
  };
}

/**
 * Setting it up for them, once, for a fee.
 *
 * Connecting a website is two DNS records or one GitHub installation, and for
 * most people that is twenty minutes with the guide open. For the rest it is
 * the thing that stops them ever starting, and "ask us and we will do it" is
 * worth more than another paragraph of documentation.
 */
export const SETUP_ASSISTANCE_USD = 10;

export function setupAssistancePrice(currency: PlanCurrency = "GHS"): {
  amount: number;
  display: string;
  currency: PlanCurrency;
} {
  const amount = Math.round(SETUP_ASSISTANCE_USD * (currency === "USD" ? 1 : usdToGhsRate()));
  return { amount, display: label(currency, amount), currency };
}

/** Ghana pays in cedis. Everywhere else pays in dollars. */
export function currencyForCountry(country: string | null | undefined): PlanCurrency {
  const code = (country ?? "").trim().toUpperCase();
  if (code === "GH" || code === "GHA" || code === "GHANA") return "GHS";
  // No country is not "not Ghana". This is a Ghanaian company and its own
  // market is the safe default; quoting a Ghanaian visitor in dollars because
  // a header was missing is the worse of the two mistakes.
  return code ? "USD" : "GHS";
}

/**
 * The currency a request should be quoted and charged in.
 *
 * An explicit choice on the pricing page wins, because somebody who picked a
 * currency has told us more than any header can. Then the country the network
 * reports. Then cedis.
 */
export function resolveCurrency(input?: { currency?: string | null; country?: string | null }): PlanCurrency {
  const explicit = (input?.currency ?? "").trim().toUpperCase();
  const wanted: PlanCurrency =
    explicit === "GHS" || explicit === "USD" ? explicit : currencyForCountry(input?.country);
  // A currency the processor cannot settle is not a choice, whoever asked for
  // it. Quoting somebody in dollars and then failing their card is worse than
  // quoting them in cedis, so this falls back rather than throwing.
  return enabledPlanCurrencies().includes(wanted) ? wanted : "GHS";
}
