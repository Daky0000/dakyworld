import type { CarePlanTier } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createNumberedInvoice } from "./invoiceNumber.js";
import { raisePayment, PaymentRefused } from "./payments.js";
import { TIER_LABEL, priceForTier, foundingRateEnd } from "./carePlanCatalogue.js";
import { currentPeriodStart, nextPeriodStart, normaliseBillingDay, syncCarePlanSchedule } from "./carePlanBilling.js";
import { appendNote } from "./context/dossier.js";

/**
 * Buying a monthly plan straight off the pricing page.
 *
 * The pricing page used to end every plan with "ask whether it fits", so the
 * only way to start one was a conversation. This is the other way: pick a plan,
 * pay the first month on Paystack, and the retainer exists from that moment.
 *
 * **The plan is written before the payment, and switched on by it.** A
 * `CarePlan` is created PAUSED with auto-invoicing off and a marker in its
 * notes, and the invoice for the first month points at it. Nothing bills a
 * paused plan and nothing grants products from one, so an abandoned checkout
 * leaves a visible, harmless row rather than a retainer nobody paid for. When
 * the invoice settles, `activatePaidRetainer` claims that exact state and turns
 * it into a running plan — once, however often Paystack retries the webhook.
 *
 * **The first month is the first billing cycle.** It is recorded as a
 * `CarePlanCycle` linked to the paid invoice, so `billDuePlans` starts at the
 * second month instead of charging the first one twice. The billing day is
 * the day they paid, and the introductory rate runs three cycles from there —
 * `billPeriod` steps it up on its own.
 *
 * Prices come from `priceForTier`, which reads what the website publishes, so
 * the number on the card and the number charged are one number.
 */

export const RETAINER_PRODUCT_KEYS = {
  foundation: "FOUNDATION",
  growth: "GROWTH",
  transformation: "TRANSFORMATION",
} as const satisfies Record<string, CarePlanTier>;

export type RetainerPlanKey = keyof typeof RETAINER_PRODUCT_KEYS;

/** How a plan bought on the website says it is still waiting for its first payment. */
const AWAITING_PAYMENT = "Awaiting first payment from the website checkout.";

export type RetainerPurchaseInput = {
  plan: RetainerPlanKey;
  businessName: string;
  contactName: string;
  email: string;
  phone?: string;
  notes?: string;
  callbackUrl?: string | null;
};

const RETURN_HOSTS = new Set(["dakyx.com", "www.dakyx.com", "dakyworld.com", "www.dakyworld.com", "localhost", "127.0.0.1"]);

function returnUrl(candidate: string | null | undefined): string {
  const fallback = "https://dakyx.com/pricing?payment=returned#plans";
  if (!candidate) return fallback;
  try {
    return RETURN_HOSTS.has(new URL(candidate).hostname.toLowerCase()) ? candidate : fallback;
  } catch {
    return fallback;
  }
}

export async function startRetainerPurchase(input: RetainerPurchaseInput) {
  const tier = RETAINER_PRODUCT_KEYS[input.plan];
  const pricing = await priceForTier(tier, "FOUNDING");
  if (!pricing) throw new PaymentRefused(`${TIER_LABEL[tier]} has no published price, so it cannot be bought online. Contact us instead.`, 409);

  const email = input.email.trim().toLowerCase();
  const existing = await prisma.client.findFirst({ where: { email } });
  const client = existing
    ?? await prisma.client.create({ data: { name: input.contactName, company: input.businessName, email, phone: input.phone, firstContactAt: new Date() } });

  const label = TIER_LABEL[tier];
  const description = pricing.standardMonthlyFee !== null && pricing.rate === "FOUNDING"
    ? `${label} monthly plan — first month (introductory rate; GHS ${pricing.monthlyFee.toLocaleString("en-GB")}/month for 3 months, then GHS ${pricing.standardMonthlyFee.toLocaleString("en-GB")}/month)`
    : `${label} monthly plan — first month`;

  const { invoice } = await createNumberedInvoice((invoiceNumber) => prisma.$transaction(async (tx) => {
    const plan = await tx.carePlan.create({
      data: {
        clientId: client.id,
        tier,
        monthlyFee: pricing.monthlyFee,
        standardMonthlyFee: pricing.standardMonthlyFee,
        currency: "GHS",
        includedHours: pricing.includedHours,
        reviewEveryMonths: pricing.reviewEveryMonths,
        status: "PAUSED",
        autoInvoice: false,
        notes: [AWAITING_PAYMENT, `Bought by ${input.contactName} for ${input.businessName}.`, input.notes].filter(Boolean).join(" "),
      },
    });
    const created = await tx.invoice.create({
      data: {
        clientId: client.id,
        carePlanId: plan.id,
        invoiceNumber,
        currency: "GHS",
        amountTotal: pricing.monthlyFee,
        dueDate: new Date(Date.now() + 7 * 86_400_000),
        lineItems: { create: [{ description, quantity: 1, unitPrice: pricing.monthlyFee, amount: pricing.monthlyFee }] },
      },
    });
    return { invoice: created, plan };
  }));

  const payment = await raisePayment(invoice.id, "paystack", { callbackUrl: returnUrl(input.callbackUrl) });
  return {
    plan: input.plan,
    label,
    amount: pricing.monthlyFee,
    standardMonthlyFee: pricing.standardMonthlyFee,
    currency: "GHS",
    invoiceNumber: invoice.invoiceNumber,
    paymentUrl: payment.url,
  };
}

/**
 * Switches on the plan a settled invoice was paying for, if it was a website
 * checkout. A no-op for every other invoice, and for this one the second time.
 */
export async function activatePaidRetainer(invoiceId: string, paidAt: Date): Promise<boolean> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { carePlan: true } });
  const plan = invoice?.carePlan;
  if (!invoice || !plan || invoice.status !== "PAID") return false;
  if (plan.status !== "PAUSED" || plan.pausedAt !== null || !plan.notes?.startsWith(AWAITING_PAYMENT)) return false;

  const zone = plan.timezone;
  const billingDay = normaliseBillingDay(Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric" }).format(paidAt)));
  const periodStart = currentPeriodStart(paidAt, zone, billingDay);
  const periodEnd = nextPeriodStart(periodStart, zone, billingDay);

  const activated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.carePlan.updateMany({
      where: { id: plan.id, status: "PAUSED", pausedAt: null, notes: { startsWith: AWAITING_PAYMENT } },
      data: {
        status: "ACTIVE",
        autoInvoice: true,
        billingDay,
        startedAt: paidAt,
        lastBilledAt: paidAt,
        foundingRateUntil: plan.standardMonthlyFee !== null ? foundingRateEnd(periodStart) : null,
        notes: plan.notes!.slice(AWAITING_PAYMENT.length).trim() || null,
      },
    });
    if (!claimed.count) return false;
    await tx.carePlanCycle.create({
      data: {
        carePlanId: plan.id,
        periodStart,
        periodEnd,
        monthlyFee: plan.monthlyFee,
        includedHours: plan.includedHours,
        invoiceId: invoice.id,
      },
    });
    return true;
  });
  if (!activated) return false;

  await syncCarePlanSchedule(plan.id, paidAt);
  try {
    await appendNote({ subject: `client:${invoice.clientId}`, kind: "OUTCOME", summary: `${TIER_LABEL[plan.tier]} monthly plan started from the website checkout (${invoice.invoiceNumber} paid).`, authorKey: "system" });
  } catch { console.error("[retainer-checkout] Could not append the start note", plan.id); }
  return true;
}
