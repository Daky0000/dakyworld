import type { ManagedBookingStatus, WebsitePurchaseStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createNumberedInvoice } from "./invoiceNumber.js";
import { raisePayment } from "./payments.js";
import { createSubscription, createSubscriptionPlan } from "../lib/paystack.js";
import { fetchWebsiteText } from "../lib/websiteFetch.js";
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

export const PLAN_ENTITLEMENTS = {
  EDITOR: { websiteLimit: 1, userLimit: 2, monitoring: false, technicalOversight: false, monthlyReview: false, supportPriority: "STANDARD", includedTechnicalMinutes: 0, improvementRecommendations: "NONE" },
  CARE: { websiteLimit: 1, userLimit: 5, monitoring: true, technicalOversight: true, monthlyReview: true, supportPriority: "PRIORITY", includedTechnicalMinutes: 60, improvementRecommendations: "BASIC" },
  MANAGED: { websiteLimit: 1, userLimit: 10, monitoring: true, technicalOversight: true, monthlyReview: true, supportPriority: "HIGHEST", includedTechnicalMinutes: 240, improvementRecommendations: "PROACTIVE" },
} as const;

type PurchaseInput = { productKey: keyof typeof WEBSITE_TIERS; businessName: string; contactName: string; email: string; phone?: string; websiteUrl: string; notes?: string };

export async function startWebsitePurchase(input: PurchaseInput) {
  if (input.productKey === "managed-website") throw new Error("Managed Website starts with a consultation booking.");
  const product = await prisma.product.findFirst({ where: { key: input.productKey, active: true } });
  if (!product) throw new Error("That website plan is not available.");
  const compatibility = await assessPurchaseCompatibility(input.websiteUrl);
  if (compatibility.status === "NOT_SUPPORTED") throw new WebsiteError(422, `This website is not supported by the editor. ${compatibility.notes}`);
  const setupPrice = Number(product.setupPrice ?? 0);
  if (!(setupPrice > 0)) throw new Error("This plan has no setup payment configured.");

  const email = input.email.toLowerCase();
  const existing = await prisma.client.findFirst({ where: { email } });
  const client = existing
    ? await prisma.client.update({ where: { id: existing.id }, data: { name: input.contactName, company: input.businessName, phone: input.phone || undefined } })
    : await prisma.client.create({ data: { name: input.contactName, company: input.businessName, email, phone: input.phone } });

  const invoice = await createNumberedInvoice((invoiceNumber) => prisma.invoice.create({ data: {
    clientId: client.id, invoiceNumber, currency: product.currency, amountTotal: setupPrice,
    dueDate: new Date(Date.now() + 7 * 86_400_000),
    lineItems: { create: [{ description: `${product.name} website setup`, quantity: 1, unitPrice: setupPrice, amount: setupPrice }] },
  } }));

  const purchase = await prisma.websitePurchase.create({ data: {
    clientId: client.id, invoiceId: invoice.id, productId: product.id, tier: WEBSITE_TIERS[input.productKey],
    businessName: input.businessName, contactName: input.contactName, email: input.email.toLowerCase(), phone: input.phone,
    websiteUrl: input.websiteUrl, notes: input.notes, compatibilityStatus: compatibility.status, compatibilityNotes: compatibility.notes, monthlyPrice: product.monthlyPrice, setupPrice, currency: product.currency,
  } });
  const payment = await raisePayment(invoice.id, "paystack", { callbackUrl: "https://dakyworld.com/website-builder?payment=returned#price" });
  return { purchaseId: purchase.id, status: purchase.status, compatibility, paymentUrl: payment.url };
}

export async function createManagedBooking(input: { businessName: string; contactName: string; email: string; phone: string; websiteUrl: string; reason: string; goals: string; notes?: string; requestedAt: Date }) {
  return prisma.managedBooking.create({ data: { ...input, email: input.email.toLowerCase() } });
}

export async function listWebsiteCommerce() {
  const [purchases, bookings] = await Promise.all([
    prisma.websitePurchase.findMany({ orderBy: { createdAt: "desc" }, include: { product: { select: { name: true } }, invoice: { select: { invoiceNumber: true, status: true, paymentUrl: true } } } }),
    prisma.managedBooking.findMany({ orderBy: { requestedAt: "asc" } }),
  ]);
  return { purchases, bookings };
}

export async function updatePurchaseStatus(id: string, status: WebsitePurchaseStatus) {
  if (status !== "READY" && status !== "ACTIVE") return prisma.websitePurchase.update({ where: { id }, data: { status } });
  const purchase = await prisma.websitePurchase.findUnique({ where: { id }, include: { product: true } });
  if (!purchase) throw new Error("That website purchase no longer exists.");
  if (purchase.status === "ACTIVE") return purchase;
  if (!purchase.setupPaidAt || !purchase.paymentAuthorization) throw new Error("The setup payment must be confirmed before recurring billing can start.");
  const planCode = purchase.providerPlanCode ?? await createSubscriptionPlan({ name: `${purchase.product.name} Website Builder`, amount: Number(purchase.monthlyPrice), currency: purchase.currency });
  if (!purchase.providerPlanCode) await prisma.websitePurchase.update({ where: { id }, data: { providerPlanCode: planCode, status: "READY" } });
  const subscription = await createSubscription({ email: purchase.email, planCode, authorizationCode: purchase.paymentAuthorization });
  return prisma.websitePurchase.update({ where: { id }, data: { status: "ACTIVE", providerSubscriptionCode: subscription.code, activatedAt: new Date(), nextBillingAt: subscription.nextPaymentAt } });
}

export async function updateBooking(id: string, data: { status?: ManagedBookingStatus; requestedAt?: Date; adminNotes?: string }) {
  return prisma.managedBooking.update({ where: { id }, data });
}
