import crypto from "node:crypto";
import { decryptSecret } from "../lib/secrets.js";
import { websitePaymentQuote } from "./paymentQuote.js";
import { PaystackError, cancelSubscription } from "../lib/paystack.js";
import type { ManagedBookingStatus, WebsitePurchaseStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createNumberedInvoice } from "./invoiceNumber.js";
import { raisePayment } from "./payments.js";
import { createSubscription, createSubscriptionPlan } from "../lib/paystack.js";
import { ensureCustomerAccount, sendSetPasswordLink } from "./accountAccess.js";
import { fetchWebsiteText } from "../lib/websiteFetch.js";
import { discoverFields } from "./website/index.js";
import { WebsiteError } from "./website/site.js";

export const WEBSITE_TIERS = {
  "website-builder": "EDITOR",
  "website-care": "CARE",
  "managed-website": "MANAGED",
} as const;

export async function assessPurchaseCompatibility(websiteUrl: string) {
  const html = await fetchWebsiteText(websiteUrl).catch(error => { throw new WebsiteError(422, `We could not read that website before payment. ${(error as Error).message}`); });
  const lower = html.toLowerCase();
  if (/wp-content|wp-includes|name=["']generator["'][^>]+wordpress/.test(lower)) return { status: "NOT_SUPPORTED", notes: "WordPress uses its own editing and publishing model." };
  if (/cdn\.shopify\.com|shopify\.theme|myshopify\.com/.test(lower)) return { status: "NOT_SUPPORTED", notes: "Shopify themes use Shopify's own editing and publishing model." };
  const dynamic = /id=["'](?:root|__next|__nuxt)["']/.test(lower) || /data-reactroot|_next\/static|_nuxt\//.test(lower);
  return dynamic
    ? { status: "COMPATIBLE_WITH_LIMITATIONS", notes: "This appears to be a framework website. Source access is required and some dynamic components remain developer-managed." }
    : { status: "COMPATIBLE", notes: "The public page can be read and uses a supported document structure. Repository checks still run during setup." };
}

export async function inspectPublicWebsite(rawUrl: string) {
  let normalizedUrl = rawUrl.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = `https://${normalizedUrl}`;
  }
  const html = await fetchWebsiteText(normalizedUrl).catch((error) => {
    throw new WebsiteError(422, `Could not reach ${normalizedUrl}: ${(error as Error).message}`);
  });
  const lower = html.toLowerCase();
  let status: "COMPATIBLE" | "COMPATIBLE_WITH_LIMITATIONS" | "NOT_SUPPORTED" = "COMPATIBLE";
  let notes = "Ready for visual editing, AI Agent commands, and 1-click GitHub publishing.";
  if (/wp-content|wp-includes|name=["']generator["'][^>]+wordpress/.test(lower)) {
    status = "NOT_SUPPORTED";
    notes = "WordPress uses its own database editing model. We can migrate it to a fast static/GitHub site for you on our Care or Managed plan.";
  } else if (/cdn\.shopify\.com|shopify\.theme|myshopify\.com/.test(lower)) {
    status = "NOT_SUPPORTED";
    notes = "Shopify themes use Shopify's liquid theme editor.";
  } else if (/id=["'](?:root|__next|__nuxt)["']/.test(lower) || /data-reactroot|_next\/static|_nuxt\//.test(lower)) {
    status = "COMPATIBLE_WITH_LIMITATIONS";
    notes = "Framework site detected (React / Next / Astro). Visual editing and literal source mapping work with your connected GitHub repository.";
  }

  const { fields, sections } = discoverFields(html);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const firstHeading = fields.find((f) => /^h[1-2]$/i.test(f.tag))?.value ?? "";
  const pageTitle = (titleMatch?.[1]?.replace(/\s+/g, " ").trim() || firstHeading || normalizedUrl).slice(0, 100);

  const headingsCount = fields.filter((f) => /^h[1-6]$/i.test(f.tag)).length;
  const buttonsCount = fields.filter((f) => f.kind === "button" || f.tag === "button" || (f.tag === "a" && /btn|button|cta/i.test(f.classes ?? ""))).length;
  const imagesCount = fields.filter((f) => f.kind === "image").length;

  const hexMatches = html.match(/#(?:[0-9a-fA-F]{6})\b/g) ?? [];
  const detectedColors = Array.from(
    new Set(hexMatches.map((c) => c.toLowerCase()).filter((c) => c !== "#ffffff" && c !== "#000000")),
  ).slice(0, 6);

  const sampleFields = fields
    .filter((f) => f.kind !== "container" && (f.value?.trim().length ?? 0) >= 3)
    .slice(0, 5)
    .map((f) => ({
      id: f.id,
      label: f.label,
      kind: f.kind,
      tag: f.tag,
      section: f.id.split(".")[0] ?? "page",
      value: (f.value ?? "").slice(0, 140),
      href: f.href ?? null,
    }));

  return {
    websiteUrl: normalizedUrl,
    pageTitle,
    status,
    notes,
    stats: {
      editableFields: fields.length,
      sectionsCount: Math.max(sections.length, 1),
      headingsCount,
      buttonsCount,
      imagesCount,
    },
    detectedColors,
    sampleFields,
  };
}

import { WEBSITE_TIER_PLANS, addMonthsUtc } from "./websiteTierPlans.js";

export const PLAN_ENTITLEMENTS = WEBSITE_TIER_PLANS;

type PurchaseInput = {
  productKey: keyof typeof WEBSITE_TIERS;
  billingCycle?: "monthly" | "annual";
  recurringConsent: true;
  quoteId: string;
  checkoutKey: string;
  businessName: string;
  contactName: string;
  email: string;
  phone?: string;
  websiteUrl: string;
  notes?: string;
  /** ISO country code from the checkout form. Ghana is billed in cedis. */
  country?: string | null;
  /** An explicit choice on the pricing page wins over the country. */
  currency?: string | null;
};

export async function startWebsitePurchase(input: PurchaseInput) {
  const tierKey = WEBSITE_TIERS[input.productKey];
  const tierPlan = WEBSITE_TIER_PLANS[tierKey];
  const product = await prisma.product.findFirst({ where: { key: input.productKey, active: true } });
  if (!product) throw new Error("That website plan is not available.");
  const quote = await websitePaymentQuote(input.productKey, input.billingCycle ?? "monthly", {
    currency: input.currency,
    country: input.country,
  });
  if (!input.recurringConsent || quote.quoteId !== input.quoteId) throw new PaystackError("Review the current price and accept recurring billing before continuing.", 409);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const prior = await prisma.websitePurchase.findUnique({ where: { checkoutKey: input.checkoutKey }, include: { invoice: true } });
  if (prior) {
    if (prior.checkoutFingerprint !== fingerprint) throw new PaystackError("Checkout details changed. Review the quote and start again.", 409);
    if (!prior.invoiceId || prior.invoice?.status === "PAID") throw new PaystackError("This purchase is already paid or needs support. Do not pay again.", 409);
    const payment = await raisePayment(prior.invoiceId, "paystack", { recurring: true });
    return { purchaseId: prior.id, status: prior.status, paymentUrl: payment.url, quote };
  }
  const compatibility = await assessPurchaseCompatibility(input.websiteUrl);
  if (compatibility.status === "NOT_SUPPORTED") throw new WebsiteError(422, `This website is not supported by the editor. ${compatibility.notes}`);
  const setupPrice = quote.setup;
  const monthlyPrice = quote.monthly;
  const isAnnual = input.billingCycle === "annual";
  const upfrontAmount = quote.upfront;
  const promoEndsAt = addMonthsUtc(new Date(), tierPlan.promoMonths);

  const email = input.email.toLowerCase();
  // The account exists from here, with no password on it. The link sent below
  // is what makes it usable, so nothing has to be told to a customer by a
  // person and no password ever travels by email.
  const account = await ensureCustomerAccount({ email, name: input.contactName, businessName: input.businessName });
  const existing = await prisma.client.findFirst({ where: { email } });
  const client = existing
    ? existing
    : await prisma.client.create({ data: { name: input.contactName, company: input.businessName, email, phone: input.phone } });

  const lineItemDescription = setupPrice > 0
    ? `${product.name} website setup`
    : isAnnual
      ? `${product.name} annual subscription (12 months — 2 months free)`
      : `${product.name} subscription (${quote.currency} ${quote.monthly}/mo for the first ${quote.promoMonths} months, then ${quote.currency} ${quote.standard}/mo standard)`;

  // The rate is recorded only where it was actually applied. Printing
  // "USD 1 = GHS 12" on a dollar purchase states a conversion that did not
  // happen to that customer.
  const rateNote = quote.currency === "GHS" ? `USD 1 = GHS ${quote.usdToGhs}; ` : "";
  const terms = `${rateNote}upfront ${quote.currency} ${quote.upfront}; ${quote.billingCycle} recurring ${quote.currency} ${quote.recurring}; standard recurring ${quote.currency} ${quote.standard}; accepted quote ${quote.quoteId}`;
  let records;
  try {
    records = await createNumberedInvoice(invoiceNumber => prisma.$transaction(async tx => {
      const invoice = await tx.invoice.create({ data: {
        clientId: client.id, invoiceNumber, currency: quote.currency, amountTotal: upfrontAmount,
        dueDate: new Date(Date.now() + 7 * 86_400_000),
        lineItems: { create: [{ description: lineItemDescription, quantity: 1, unitPrice: upfrontAmount, amount: upfrontAmount }] },
      } });
      const purchase = await tx.websitePurchase.create({ data: {
        clientId: client.id, invoiceId: invoice.id, productId: product.id, tier: WEBSITE_TIERS[input.productKey],
        businessName: input.businessName, contactName: input.contactName, email: input.email.toLowerCase(), phone: input.phone,
        websiteUrl: input.websiteUrl, notes: input.notes ? `${input.notes} | ${terms}` : terms,
        compatibilityStatus: compatibility.status, compatibilityNotes: compatibility.notes, monthlyPrice, setupPrice, currency: quote.currency,
        billingCycle: input.billingCycle ?? "monthly", recurringConsentAt: new Date(), standardRecurringPrice: quote.standard,
        checkoutKey: input.checkoutKey, checkoutFingerprint: fingerprint, userId: account.user.id,
      } });
      return { invoice, purchase };
    }));
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new PaystackError("This checkout is already being prepared. Retry with the same checkout details.", 409);
    throw error;
  }
  const { invoice, purchase } = records;
  const payment = await raisePayment(invoice.id, "paystack", { recurring: true, callbackUrl: "https://dakyworld.com/website-builder?payment=returned#price" });
  if (account.created) {
    // Logged rather than thrown: the customer has a payment link in front of
    // them, and a missing welcome email is recoverable from the Purchases
    // screen. Losing the purchase over it would not be.
    await sendSetPasswordLink(account.user, "purchase").catch((error) =>
      console.error(`[commerce] could not send the set-password link to ${account.user.email}:`, (error as Error).message),
    );
  }
  return { purchaseId: purchase.id, status: purchase.status, compatibility, paymentUrl: payment.url, quote, promoEndsAt: promoEndsAt.toISOString(), promoMonthlyPrice: quote.monthly, standardMonthlyPrice: quote.standard };
}

export async function createManagedBooking(input: { businessName: string; contactName: string; email: string; phone: string; websiteUrl: string; reason: string; goals: string; notes?: string; requestedAt: Date }) {
  return prisma.managedBooking.create({ data: { ...input, email: input.email.toLowerCase() } });
}

export async function listWebsiteCommerce() {
  const [purchases, bookings, paymentAlerts] = await Promise.all([
    prisma.websitePurchase.findMany({ orderBy: { createdAt: "desc" }, include: { product: { select: { name: true } }, invoice: { select: { invoiceNumber: true, status: true, paymentUrl: true } } } }),
    prisma.managedBooking.findMany({ orderBy: { requestedAt: "asc" } }),
    prisma.paystackEvent.findMany({ where: { OR: [{ error: { not: null } }, { reviewRequired: true }] }, select: { id: true, event: true, error: true, createdAt: true, reviewRequired: true }, take: 50, orderBy: { createdAt: "desc" } }),
  ]);
  return { purchases: purchases.map(publicPurchase), bookings, paymentAlerts };
}

/** Billing credentials are never returned through commerce APIs. */
export function publicPurchase<T extends { paymentAuthorization: string | null; checkoutKey: string | null; checkoutFingerprint: string | null; billingEmail: string | null }>(purchase: T) {
  const { paymentAuthorization, checkoutKey, checkoutFingerprint, billingEmail, ...safe } = purchase;
  return { ...safe, hasReusableCard: Boolean(paymentAuthorization) };
}

export async function updatePurchaseStatus(id: string, status: WebsitePurchaseStatus) {
  const purchase = await prisma.websitePurchase.findUnique({ where: { id }, include: { product: true } });
  if (!purchase) throw new PaystackError("That website purchase no longer exists.", 404);
  if (status === "CANCELLED") {
    if (purchase.billingState === "CREATING" || purchase.billingState === "UNCERTAIN") throw new PaystackError("Subscription creation needs reconciliation before cancellation.", 409);
    if (!purchase.setupPaidAt && purchase.invoiceId && await prisma.paymentAttempt.findUnique({ where: { invoiceId: purchase.invoiceId } })) throw new PaystackError("The hosted checkout may still be payable. Reconcile it before cancelling this purchase.", 409);
    const claim = await prisma.websitePurchase.updateMany({ where: { id, billingState: purchase.billingState }, data: { billingState: "CANCELLING" } });
    if (!claim.count) throw new PaystackError("Billing changed while cancellation was requested. Refresh and try again.", 409);
    try {
      if (purchase.providerSubscriptionCode) await cancelSubscription(purchase.providerSubscriptionCode);
    } catch (error) {
      await prisma.websitePurchase.updateMany({ where: { id, billingState: "CANCELLING" }, data: { billingState: "CANCEL_UNCERTAIN" } });
      throw error;
    }
    // `nextBillingAt` is kept, not cleared. It is the date the customer is paid
    // up to, and it is the only thing that can tell entitlement how long they
    // are still owed the product they bought — clearing it here is what made
    // cancelling take the editor away the same second. Paystack has already
    // been told to raise no further charge, so a date in the future is a
    // period served, not a renewal.
    return publicPurchase(await prisma.websitePurchase.update({ where: { id }, data: { status: "CANCELLED", billingState: "CANCELLED" } }));
  }
  if (purchase.status === "CANCELLED") throw new PaystackError("A cancelled purchase cannot be restarted without a new checkout.", 409);
  if (status !== "READY" && status !== "ACTIVE") {
    if (purchase.providerSubscriptionCode) throw new PaystackError("Use subscription cancellation or reconciliation before changing an active billing status.", 409);
    if (["SETUP_PAID", "SETUP_IN_PROGRESS"].includes(status) && !purchase.setupPaidAt) throw new PaystackError("Verify the setup payment first.", 409);
    return publicPurchase(await prisma.websitePurchase.update({ where: { id }, data: { status } }));
  }
  if (purchase.providerSubscriptionCode) return publicPurchase(purchase);
  if (!purchase.setupPaidAt || !purchase.paymentAuthorization || !purchase.recurringConsentAt || !purchase.billingEmail) throw new PaystackError("A verified reusable card payment and recurring billing consent are required.", 409);
  const authorizationCode = decryptSecret(purchase.paymentAuthorization);
  if (!authorizationCode) throw new PaystackError("The billing authorization needs to be collected again securely.", 409);
  const claimed = await prisma.websitePurchase.updateMany({ where: { id, status: { not: "CANCELLED" }, billingState: "NONE", providerSubscriptionCode: null }, data: { billingState: "CREATING", promoEndsAt: purchase.billingCycle === "annual" ? null : addMonthsUtc(purchase.setupPaidAt, 3) } });
  if (!claimed.count) throw new PaystackError("Subscription creation is pending reconciliation. Do not retry with another subscription.", 409);
  let subscriptionRequested = false;
  try {
    const annual = purchase.billingCycle === "annual";
    const amount = annual ? Number(purchase.standardRecurringPrice) : Number(purchase.monthlyPrice);
    const planCode = purchase.providerPlanCode ?? await createSubscriptionPlan({ name: `${purchase.product.name} ${purchase.id}`, amount, currency: purchase.currency, interval: annual ? "annually" : "monthly" });
    await prisma.websitePurchase.update({ where: { id }, data: { providerPlanCode: planCode } });
    // An upfront period is already paid when there is no separate setup fee.
    const prepaidUntil = Number(purchase.setupPrice) > 0 ? new Date(Date.now() + 5 * 60_000) : addMonthsUtc(purchase.setupPaidAt, annual ? 12 : 1);
    const startDate = new Date(Math.max(prepaidUntil.getTime(), Date.now() + 5 * 60_000));
    subscriptionRequested = true;
    const subscription = await createSubscription({ email: purchase.billingEmail, planCode, authorizationCode, startDate });
    await prisma.websitePurchase.updateMany({ where: { id, billingState: { in: ["CREATING", "UNCERTAIN"] }, status: { not: "CANCELLED" } }, data: { status: "ACTIVE", billingState: "ACTIVE", providerSubscriptionCode: subscription.code, activatedAt: new Date(), promoEndsAt: annual ? null : addMonthsUtc(purchase.setupPaidAt, 3), nextBillingAt: subscription.nextPaymentAt ?? startDate } });
    return publicPurchase(await prisma.websitePurchase.findUniqueOrThrow({ where: { id } }));
  } catch (error) {
    // A timeout can mean the subscription was created. Only a verified provider
    // event or explicit reconciliation may recover this state, never a blind POST retry.
    await prisma.websitePurchase.updateMany({ where: { id, billingState: "CREATING" }, data: { billingState: subscriptionRequested ? "UNCERTAIN" : "NONE" } });
    throw error;
  }
}

export async function updateBooking(id: string, data: { status?: ManagedBookingStatus; requestedAt?: Date; adminNotes?: string }) {
  return prisma.managedBooking.update({ where: { id }, data });
}

/**
 * The customer's own cancel button.
 *
 * A thin wrapper over `updatePurchaseStatus`, which is where cancellation
 * actually lives: it claims the billing state before calling Paystack, parks
 * the row in CANCEL_UNCERTAIN when the call fails rather than assuming it
 * worked, and refuses while a checkout may still be payable. This adds only
 * what a customer needs — a reason, and words that say what they keep.
 *
 * Their subscription ends at the processor immediately, so nothing is charged
 * again. The website itself keeps being served: they paid for the period.
 */
export async function cancelWebsiteSubscription(input: { purchaseId: string; reason?: string | null; now?: Date }) {
  const purchase = await prisma.websitePurchase.findUnique({ where: { id: input.purchaseId }, select: { id: true, status: true, notes: true, nextBillingAt: true } });
  if (!purchase) throw new WebsiteError(404, "That subscription no longer exists.");
  if (purchase.status === "CANCELLED") return { ...purchase, servesUntil: purchase.nextBillingAt };

  const servesUntil = purchase.nextBillingAt;
  await updatePurchaseStatus(input.purchaseId, "CANCELLED");

  // The reason is worth keeping and belongs with the purchase rather than in
  // a column of its own — churn is read by a person, not queried.
  const updated = await prisma.websitePurchase.update({
    where: { id: input.purchaseId },
    data: {
      notes: `${purchase.notes ? purchase.notes + " | " : ""}Cancelled by the customer on ${new Date().toISOString().slice(0, 10)}${input.reason ? `: ${input.reason.slice(0, 400)}` : ""}`,
    },
  });
  return { ...updated, servesUntil };
}

