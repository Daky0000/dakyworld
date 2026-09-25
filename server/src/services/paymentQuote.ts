import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { PaystackError, toMinor } from "../lib/paystack.js";
import { WEBSITE_TIER_PLANS } from "./websiteTierPlans.js";
import { amountsFor, resolveCurrency, type PlanCurrency } from "./websitePricing.js";

// Merchant-approved rate: GHS 12 per USD. Override deliberately at deployment;
// existing purchases retain their accepted prices throughout the subscription.
export function usdToGhsRate(): number {
  const rate = Number(process.env.PAYSTACK_USD_GHS_RATE ?? "12");
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10000) throw new PaystackError("Checkout exchange rate is not configured correctly.", 503);
  return rate;
}

/**
 * What this customer will be charged, as an object they accept by id.
 *
 * The quote is the contract: the customer agrees to a `quoteId`, and the
 * purchase is refused if the numbers behind it have moved since. So this is
 * the one place an amount is decided, and everything else — the pricing page,
 * the plan panel, a dunning notice — only ever *says* a price.
 *
 * Prices come from `websitePricing.ts` and nowhere else. They used to be read
 * off the `Product` row, which is editable in the OS, while the standard price
 * came from the tier table — two rows that drifted apart into a standard price
 * below the promotional one, so every customer's bill would have fallen after
 * their introductory period. The three tiers are six numbers in one file now.
 */
export async function websitePaymentQuote(
  productKey: string,
  billingCycle: "monthly" | "annual",
  currencyInput?: { currency?: string | null; country?: string | null },
) {
  const tier = Object.values(WEBSITE_TIER_PLANS).find(plan => plan.productKey === productKey);
  const product = await prisma.product.findFirst({ where: { key: productKey, active: true } });
  if (!product || !tier) throw new PaystackError("This plan is unavailable.", 404);

  // Ghana in cedis, everywhere else in dollars — and never a currency the
  // processor cannot settle, which `resolveCurrency` enforces.
  const currency: PlanCurrency = resolveCurrency(currencyInput);
  const { promo, standard: standardMonthly } = amountsFor(tier.tier, currency);

  const months = billingCycle === "annual" ? 10 : 1; // annual bills ten months for twelve
  const monthly = promo;
  const recurring = promo * months;
  const standard = standardMonthly * months;
  const setup = 0;
  const upfront = recurring;
  toMinor(upfront); toMinor(recurring); toMinor(standard);

  const quote = {
    productKey,
    billingCycle,
    currency,
    usdToGhs: usdToGhsRate(),
    upfront,
    setup,
    monthly,
    recurring,
    standard,
    promoMonths: tier.promoMonths,
  };
  return { ...quote, quoteId: crypto.createHash("sha256").update(JSON.stringify(quote)).digest("hex") };
}
