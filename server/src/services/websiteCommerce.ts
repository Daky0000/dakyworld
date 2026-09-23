import type { ManagedBookingStatus, WebsitePurchaseStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createNumberedInvoice } from "./invoiceNumber.js";
import { raisePayment } from "./payments.js";
import { createSubscription, createSubscriptionPlan } from "../lib/paystack.js";
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

export const PLAN_ENTITLEMENTS = {
  EDITOR: { websiteLimit: 1, userLimit: 2, monitoring: false, technicalOversight: false, monthlyReview: false, supportPriority: "STANDARD", includedTechnicalMinutes: 0, improvementRecommendations: "NONE" },
  CARE: { websiteLimit: 1, userLimit: 5, monitoring: true, technicalOversight: true, monthlyReview: true, supportPriority: "PRIORITY", includedTechnicalMinutes: 60, improvementRecommendations: "BASIC" },
  MANAGED: { websiteLimit: 1, userLimit: 10, monitoring: true, technicalOversight: true, monthlyReview: true, supportPriority: "HIGHEST", includedTechnicalMinutes: 240, improvementRecommendations: "PROACTIVE" },
} as const;

type PurchaseInput = {
  productKey: keyof typeof WEBSITE_TIERS;
  billingCycle?: "monthly" | "annual";
  businessName: string;
  contactName: string;
  email: string;
  phone?: string;
  websiteUrl: string;
  notes?: string;
};

export async function startWebsitePurchase(input: PurchaseInput) {
  if (input.productKey === "managed-website") throw new Error("Managed Website starts with a consultation booking.");
  const product = await prisma.product.findFirst({ where: { key: input.productKey, active: true } });
  if (!product) throw new Error("That website plan is not available.");
  const compatibility = await assessPurchaseCompatibility(input.websiteUrl);
  if (compatibility.status === "NOT_SUPPORTED") throw new WebsiteError(422, `This website is not supported by the editor. ${compatibility.notes}`);
  const setupPrice = Number(product.setupPrice ?? 0);
  const monthlyPrice = Number(product.monthlyPrice ?? 0);
  const isAnnual = input.billingCycle === "annual";
  const recurringAmount = isAnnual ? monthlyPrice * 10 : monthlyPrice;
  const upfrontAmount = setupPrice > 0 ? setupPrice : recurringAmount;
  if (!(upfrontAmount > 0)) throw new Error("This plan has no payment amount configured.");

  const email = input.email.toLowerCase();
  const existing = await prisma.client.findFirst({ where: { email } });
  const client = existing
    ? await prisma.client.update({ where: { id: existing.id }, data: { name: input.contactName, company: input.businessName, phone: input.phone || undefined } })
    : await prisma.client.create({ data: { name: input.contactName, company: input.businessName, email, phone: input.phone } });

  const lineItemDescription = setupPrice > 0
    ? `${product.name} website setup`
    : isAnnual
      ? `${product.name} annual subscription (12 months — 2 months free)`
      : `${product.name} subscription (first month)`;

  const invoice = await createNumberedInvoice((invoiceNumber) => prisma.invoice.create({ data: {
    clientId: client.id, invoiceNumber, currency: product.currency, amountTotal: upfrontAmount,
    dueDate: new Date(Date.now() + 7 * 86_400_000),
    lineItems: { create: [{ description: lineItemDescription, quantity: 1, unitPrice: upfrontAmount, amount: upfrontAmount }] },
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
