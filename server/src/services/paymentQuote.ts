import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { PaystackError, toMinor } from "../lib/paystack.js";
import { WEBSITE_TIER_PLANS } from "./websiteTierPlans.js";

// Merchant-approved rate: GHS 12 per USD. Override deliberately at deployment;
// existing purchases retain their accepted GHS prices throughout the subscription.
export function usdToGhsRate(): number {
  const rate = Number(process.env.PAYSTACK_USD_GHS_RATE ?? "12");
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10000) throw new PaystackError("Checkout exchange rate is not configured correctly.", 503);
  return rate;
}

export async function websitePaymentQuote(productKey: string, billingCycle: "monthly" | "annual") {
  const tier = Object.values(WEBSITE_TIER_PLANS).find(plan => plan.productKey === productKey);
  const product = await prisma.product.findFirst({ where: { key: productKey, active: true } });
  if (!product || !tier) throw new PaystackError("This plan is unavailable.", 404);
  if (!["USD", "GHS"].includes(product.currency)) throw new PaystackError("This product needs a USD or GHS price.", 503);
  // Standard prices are defined in USD. Do not infer standard GHS prices from
  // an independently edited local catalogue price.
  const rate = usdToGhsRate();
  const multiplier = product.currency === "USD" ? rate : 1;
  const round = (amount: number) => Math.round(amount * 100) / 100;
  const monthly = round(Number(product.monthlyPrice) * multiplier);
  const setup = round(Number(product.setupPrice ?? 0) * multiplier);
  const recurring = round(monthly * (billingCycle === "annual" ? 10 : 1));
  const standard = round(tier.standardMonthlyPrice * rate * (billingCycle === "annual" ? 10 : 1));
  const upfront = setup > 0 ? setup : recurring;
  toMinor(upfront); toMinor(recurring); toMinor(standard);
  const quote = { productKey, billingCycle, currency: "GHS", usdToGhs: rate, upfront, setup, monthly, recurring, standard, promoMonths: tier.promoMonths };
  return { ...quote, quoteId: crypto.createHash("sha256").update(JSON.stringify(quote)).digest("hex") };
}
