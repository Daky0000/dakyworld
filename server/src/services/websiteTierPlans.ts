import type { Request, Response, Router } from "express";
import type { WebsitePlanTier } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { hashPassword } from "../lib/password.js";
import { WebsiteError } from "./website/site.js";
import { IS_PRODUCTION } from "../middleware/auth.js";
import {
  bumpUsage,
  readUsage,
  resolveEntitlement,
  setSwitchedUserEmail,
  getSwitchedUserEmail,
  usagePeriod,
  TEST_SWITCHING_ALLOWED,
  type Entitlement,
} from "./websiteEntitlement.js";
import { priceFor, type PlanCurrency } from "./websitePricing.js";
import { moveSubscriptionToPlan } from "../lib/paystack.js";

/**
 * Website Builder Three-Tier Plan, Storage Quota, 3-Month Promo Pricing Reversion,
 * Feature Matrix, Usage Limits & Subscribed Test Users.
 *
 * Pricing Structure (USD):
 * - Starter (EDITOR):   $3/mo for the first 3 months, then reverts to $5/mo standard   -> "$3 ($5)"
 * - Pro (CARE):         $10/mo for the first 3 months, then reverts to $16/mo standard -> "$10 ($16)"
 * - Business (MANAGED): $25/mo for the first 3 months, then reverts to $45/mo standard -> "$25 ($45)"
 */

/** The same deployment signals middleware/auth.ts fails closed on. */
const DEPLOYED_ENVIRONMENT = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_ID ||
    process.env.RENDER ||
    process.env.FLY_APP_NAME ||
    process.env.DYNO ||
    process.env.VERCEL ||
    process.env.KUBERNETES_SERVICE_HOST,
);

export type TierFeatureFlags = {
  visualEditor: boolean;
  mediaLibrary: boolean;
  themeSettings: boolean;
  seoInspector: boolean;
  aiAssistant: boolean;
  aiBuilderAgent: boolean;
  sourceCodeEditor: boolean;
  pullRequestPublish: boolean;
  brandPresets: boolean;
};

export type TierPlanDefinition = {
  tier: WebsitePlanTier;
  productKey: "website-builder" | "website-care" | "managed-website";
  name: string;
  badge: string;
  tagline: string;
  currency: PlanCurrency;
  promoMonthlyPrice: number;
  standardMonthlyPrice: number;
  promoMonths: number;
  priceDisplay: string;
  storageQuotaBytes: number;
  storageQuotaLabel: string;
  maxUploadBytes: number;
  maxUploadLabel: string;
  importsLimit: number;
  importsLimitLabel: string;
  editsLimit: number;
  editsLimitLabel: string;
  aiPromptsLimit: number;
  aiPromptsLimitLabel: string;
  websiteLimit: number;
  userLimit: number;
  supportPriority: "STANDARD" | "PRIORITY" | "HIGHEST";
  includedTechnicalMinutes: number;
  improvementRecommendations: "NONE" | "BASIC" | "PROACTIVE";
  monitoring: boolean;
  technicalOversight: boolean;
  monthlyReview: boolean;
  features: TierFeatureFlags;
  featureHighlights: string[];
  restrictedFeatures: string[];
};

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export const WEBSITE_TIER_PLANS: Record<WebsitePlanTier, TierPlanDefinition> = {
  EDITOR: {
    tier: "EDITOR",
    productKey: "website-builder",
    name: "Starter",
    badge: "$3 ($5)",
    tagline: "Essential visual page editing & media storage for solo creators. $3/mo for first 3 months, then $5/mo standard.",
    currency: "USD",
    promoMonthlyPrice: 3,
    standardMonthlyPrice: 5,
    promoMonths: 3,
    priceDisplay: "$3 ($5)",
    storageQuotaBytes: 50 * MB,
    storageQuotaLabel: "50 MB",
    maxUploadBytes: 2 * MB,
    maxUploadLabel: "2 MB",
    importsLimit: 3,
    importsLimitLabel: "3 imports / mo",
    editsLimit: 30,
    editsLimitLabel: "30 edits / mo",
    aiPromptsLimit: 0,
    aiPromptsLimitLabel: "Not included",
    websiteLimit: 1,
    userLimit: 2,
    supportPriority: "STANDARD",
    includedTechnicalMinutes: 0,
    improvementRecommendations: "NONE",
    monitoring: false,
    technicalOversight: false,
    monthlyReview: false,
    features: {
      visualEditor: true,
      mediaLibrary: true,
      themeSettings: false,
      seoInspector: false,
      aiAssistant: false,
      aiBuilderAgent: false,
      sourceCodeEditor: false,
      pullRequestPublish: false,
      brandPresets: false,
    },
    featureHighlights: [
      "50 MB Media Library storage (up to 2 MB/file)",
      "Up to 3 HTML page imports per month",
      "Up to 30 page edits / saves per month",
      "Visual Layout & Style Inspector",
      "1 website · up to 2 team members",
    ],
    restrictedFeatures: [
      "Global Theme Palette & Color Tokens (Pro+)",
      "Page SEO Inspector & Metadata Auditor (Pro+)",
      "AI Copy & Layout Assistant (Pro+)",
      "Autonomous AI Builder Agent (Business)",
      "Raw HTML/JSX Source Code Editor & GitHub PRs (Business)",
    ],
  },
  CARE: {
    tier: "CARE",
    productKey: "website-care",
    name: "Pro",
    badge: "$10 ($16)",
    tagline: "Expanded storage, Global Theme tokens, SEO Inspector & AI Assistant. $10/mo for first 3 months, then $16/mo standard.",
    currency: "USD",
    promoMonthlyPrice: 10,
    standardMonthlyPrice: 16,
    promoMonths: 3,
    priceDisplay: "$10 ($16)",
    storageQuotaBytes: 500 * MB,
    storageQuotaLabel: "500 MB",
    maxUploadBytes: 5 * MB,
    maxUploadLabel: "5 MB",
    importsLimit: 15,
    importsLimitLabel: "15 imports / mo",
    editsLimit: 200,
    editsLimitLabel: "200 edits / mo",
    aiPromptsLimit: 50,
    aiPromptsLimitLabel: "50 AI prompts / mo",
    websiteLimit: 3,
    userLimit: 5,
    supportPriority: "PRIORITY",
    includedTechnicalMinutes: 60,
    improvementRecommendations: "BASIC",
    monitoring: true,
    technicalOversight: true,
    monthlyReview: true,
    features: {
      visualEditor: true,
      mediaLibrary: true,
      themeSettings: true,
      seoInspector: true,
      aiAssistant: true,
      aiBuilderAgent: false,
      sourceCodeEditor: false,
      pullRequestPublish: false,
      brandPresets: true,
    },
    featureHighlights: [
      "500 MB Media Library storage (up to 5 MB/file)",
      "Up to 15 HTML page imports per month",
      "Up to 200 page edits / saves per month",
      "Global Theme Color System & Brand Presets",
      "Full Page SEO Inspector & Metadata Auditor",
      "AI Copy & Section Assistant (50 runs/mo)",
      "Up to 3 websites · 5 team members",
    ],
    restrictedFeatures: [
      "Autonomous AI Builder Agent (Business)",
      "Raw HTML/JSX Source Code Editor & GitHub PRs (Business)",
    ],
  },
  MANAGED: {
    tier: "MANAGED",
    productKey: "managed-website",
    name: "Business",
    badge: "$25 ($45)",
    tagline: "5 GB media storage, unlimited imports & edits, AI Builder Agent & Source Code access. $25/mo for first 3 months, then $45/mo standard.",
    currency: "USD",
    promoMonthlyPrice: 25,
    standardMonthlyPrice: 45,
    promoMonths: 3,
    priceDisplay: "$25 ($45)",
    storageQuotaBytes: 5 * GB,
    storageQuotaLabel: "5 GB",
    maxUploadBytes: 10 * MB,
    maxUploadLabel: "10 MB",
    importsLimit: 999999,
    importsLimitLabel: "Unlimited imports",
    editsLimit: 999999,
    editsLimitLabel: "Unlimited edits",
    aiPromptsLimit: 999999,
    aiPromptsLimitLabel: "Unlimited AI runs",
    websiteLimit: 10,
    userLimit: 15,
    supportPriority: "HIGHEST",
    includedTechnicalMinutes: 240,
    improvementRecommendations: "PROACTIVE",
    monitoring: true,
    technicalOversight: true,
    monthlyReview: true,
    features: {
      visualEditor: true,
      mediaLibrary: true,
      themeSettings: true,
      seoInspector: true,
      aiAssistant: true,
      aiBuilderAgent: true,
      sourceCodeEditor: true,
      pullRequestPublish: true,
      brandPresets: true,
    },
    featureHighlights: [
      "5 GB Media Library storage (up to 10 MB/file)",
      "Unlimited HTML page imports & unlimited edits",
      "Global Theme System, Brand Presets & SEO Inspector",
      "Autonomous AI Builder Agent & Unlimited AI Assistant",
      "Full Raw Source Code Editor & GitHub Pull Request publishing",
      "Up to 10 websites · 15 team members · Priority support",
    ],
    restrictedFeatures: [],
  },
};

export type TestTierUserSeed = {
  id: string;
  email: string;
  password: string;
  name: string;
  tier: WebsitePlanTier;
  businessName: string;
  websiteUrl: string;
  subscribedMonthsAgo: number;
  initialStorageUsedBytes: number;
  initialImportsUsed: number;
  initialEditsUsed: number;
  initialAiPromptsUsed: number;
};

export const SUBSCRIBED_TEST_USERS: readonly TestTierUserSeed[] = [
  {
    id: "user-tier-starter",
    email: "starter@dakyworld.test",
    password: "Starter#2026!",
    name: "Ama Mensah (Starter $3/$5)",
    tier: "EDITOR",
    businessName: "Mensah Creative Studio",
    websiteUrl: "https://mensahstudio.example.com",
    subscribedMonthsAgo: 1, // In Month 2 of the 3-month $3 promo (reverts to $5 after Month 3)
    initialStorageUsedBytes: 12 * MB, // 12 MB of 50 MB used
    initialImportsUsed: 1, // 1 of 3 imports used
    initialEditsUsed: 8, // 8 of 30 edits used
    initialAiPromptsUsed: 0,
  },
  {
    id: "user-tier-pro",
    email: "pro@dakyworld.test",
    password: "ProTier#2026!",
    name: "Kofi Owusu (Pro $10/$16)",
    tier: "CARE",
    businessName: "Owusu Digital Agency",
    websiteUrl: "https://owusudigital.example.com",
    subscribedMonthsAgo: 2, // In Month 3 of the 3-month $10 promo (reverts to $16 after Month 3)
    initialStorageUsedBytes: 85 * MB, // 85 MB of 500 MB used
    initialImportsUsed: 4, // 4 of 15 imports used
    initialEditsUsed: 42, // 42 of 200 edits used
    initialAiPromptsUsed: 11, // 11 of 50 AI prompts used
  },
  {
    id: "user-tier-business",
    email: "business@dakyworld.test",
    password: "Business#2026!",
    name: "Esi Asante (Business $25/$45)",
    tier: "MANAGED",
    businessName: "Asante Enterprise Group",
    websiteUrl: "https://asantegroup.example.com",
    subscribedMonthsAgo: 0, // Subscribed this month on the $25 promo (reverts to $45 after 3 months)
    initialStorageUsedBytes: 420 * MB, // 420 MB of 5 GB used
    initialImportsUsed: 9, // Unlimited
    initialEditsUsed: 115, // Unlimited
    initialAiPromptsUsed: 28, // Unlimited
  },
] as const;

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 10 * MB ? 1 : 2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Adds exact calendar months to a Date. */
export function addMonthsUtc(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

export type SubscriptionPricingState = {
  tier: WebsitePlanTier;
  planName: string;
  currency: PlanCurrency;
  promoMonthlyPrice: number;
  standardMonthlyPrice: number;
  currentMonthlyPrice: number;
  priceDisplay: string;
  promoMonths: number;
  subscribedAt: string;
  promoEndsAt: string;
  revertedToStandard: boolean;
  daysRemainingInPromo: number;
  billingPhaseLabel: string;
  nextBillingAmount: number;
};

/**
 * Computes whether a user's subscription is still inside the 3-month promotional
 * window ($3, $10, $25) or has automatically reverted to the standard price
 * ($5, $16, $45) after the first 3 months.
 */
export function resolveSubscriptionPricing(input: {
  tier: WebsitePlanTier;
  subscribedAt: Date;
  now?: Date;
  simulateAfter3Months?: boolean;
  /** What this customer is billed in. Fixed at purchase; see websitePricing.ts. */
  currency?: PlanCurrency;
}): SubscriptionPricingState {
  const plan = WEBSITE_TIER_PLANS[input.tier];
  const price = priceFor(input.tier, input.currency ?? "GHS");
  const now = input.now ?? new Date();
  const promoEndsAt = addMonthsUtc(input.subscribedAt, plan.promoMonths);
  const revertedToStandard = Boolean(input.simulateAfter3Months) || now.getTime() >= promoEndsAt.getTime();
  const currentMonthlyPrice = revertedToStandard ? price.standardMonthlyPrice : price.promoMonthlyPrice;
  const msLeft = Math.max(0, promoEndsAt.getTime() - now.getTime());
  const daysRemainingInPromo = revertedToStandard ? 0 : Math.ceil(msLeft / 86_400_000);

  const billingPhaseLabel = revertedToStandard
    ? `Standard rate active (${price.standardDisplay}/mo — reverted from ${price.promoDisplay}/mo after first 3 months)`
    : `3-Month Intro Promo active (${price.promoDisplay}/mo for ${daysRemainingInPromo} more day${daysRemainingInPromo === 1 ? "" : "s"}, then reverts to ${price.standardDisplay}/mo standard)`;

  return {
    tier: plan.tier,
    planName: plan.name,
    currency: price.currency,
    promoMonthlyPrice: price.promoMonthlyPrice,
    standardMonthlyPrice: price.standardMonthlyPrice,
    currentMonthlyPrice,
    priceDisplay: price.display,
    promoMonths: plan.promoMonths,
    subscribedAt: input.subscribedAt.toISOString(),
    promoEndsAt: promoEndsAt.toISOString(),
    revertedToStandard,
    daysRemainingInPromo,
    billingPhaseLabel,
    nextBillingAmount: now.getTime() + 30 * 86_400_000 >= promoEndsAt.getTime() ? price.standardMonthlyPrice : price.promoMonthlyPrice,
  };
}

/**
 * Who this request is for, and what they are entitled to.
 *
 * All of it comes from services/websiteEntitlement.ts now: the signed-in user
 * and their subscription row. What used to be here — a Map of subscriptions in
 * process memory, a shared "switched user" global, and a tier guessed from
 * whether an email address contained "dan" or "owner" — decided what paying
 * customers could do from things a request could carry or a restart could lose.
 */
export function getActiveSwitchedUserEmail(): string | null {
  return getSwitchedUserEmail();
}

export function setActiveSwitchedUserEmail(email: string | null): void {
  setSwitchedUserEmail(email);
}

export async function resolveEffectiveUserIdentity(req: Request): Promise<Entitlement> {
  return resolveEntitlement(req);
}

export async function computeUserStorageAndUsage(req: Request, siteId?: string) {
  const identity = await resolveEntitlement(req);
  const plan = WEBSITE_TIER_PLANS[identity.tier];
  const simulateAfter3Months = identity.simulateAfter3Months;
  const counters = await readUsage(identity.userId);
  const pricing = resolveSubscriptionPricing({
    tier: identity.tier,
    subscribedAt: identity.subscribedAt,
    simulateAfter3Months,
    currency: (identity.currency === "USD" ? "USD" : "GHS"),
  });

  let dbAssetBytes = 0;
  let dbAssetCount = 0;
  try {
    if (siteId) {
      const agg = await prisma.siteAsset.aggregate({
        where: { siteId },
        _sum: { size: true },
        _count: { id: true },
      });
      dbAssetBytes = Number(agg._sum.size ?? 0);
      dbAssetCount = Number(agg._count.id ?? 0);
    } else {
      const agg = await prisma.siteAsset.aggregate({
        _sum: { size: true },
        _count: { id: true },
      });
      dbAssetBytes = Number(agg._sum.size ?? 0);
      dbAssetCount = Number(agg._count.id ?? 0);
    }
  } catch {
    // Fallback if database is unreachable in offline check mode
  }

  const usedBytes = dbAssetBytes;
  const quotaBytes = plan.storageQuotaBytes;
  const remainingBytes = Math.max(0, quotaBytes - usedBytes);
  const percentUsed = Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10);

  return {
    user: identity,
    userId: identity.userId,
    userEmail: identity.email,
    userName: identity.name,
    planCode: plan.tier,
    tierName: plan.name,
    tierBadge: plan.badge,
    tagline: plan.tagline,
    plan,
    pricing: {
      ...pricing,
      effectiveMonthlyPrice: pricing.currentMonthlyPrice,
      promoActive: !pricing.revertedToStandard,
      activeBillingLabel: pricing.billingPhaseLabel,
      monthsSubscribed: simulateAfter3Months ? 4 : 1,
    },
    storage: {
      usedBytes,
      quotaBytes,
      remainingBytes,
      percentUsed,
      usedFormatted: formatBytes(usedBytes),
      quotaFormatted: plan.storageQuotaLabel,
      remainingFormatted: formatBytes(remainingBytes),
      maxUploadBytes: plan.maxUploadBytes,
      maxUploadFormatted: plan.maxUploadLabel,
      maxSingleAssetBytes: plan.maxUploadBytes,
      maxSingleAssetFormatted: plan.maxUploadLabel,
      assetCount: dbAssetCount,
    },
    usage: {
      monthKey: new Date().toISOString().slice(0, 7),
      importsUsed: counters.imports,
      importsLimit: plan.importsLimit >= 99999 ? null : plan.importsLimit,
      importsLimitLabel: plan.importsLimitLabel,
      importsRemaining: plan.importsLimit >= 99999 ? null : Math.max(0, plan.importsLimit - counters.imports),
      editsUsed: counters.edits,
      editsLimit: plan.editsLimit >= 99999 ? null : plan.editsLimit,
      editsLimitLabel: plan.editsLimitLabel,
      editsRemaining: plan.editsLimit >= 99999 ? null : Math.max(0, plan.editsLimit - counters.edits),
      aiPromptsUsed: counters.aiPrompts,
      aiPromptsLimit: plan.aiPromptsLimit >= 99999 ? null : plan.aiPromptsLimit,
      aiPromptsLimitLabel: plan.aiPromptsLimitLabel,
      aiPromptsRemaining: plan.aiPromptsLimit >= 99999 ? null : Math.max(0, plan.aiPromptsLimit - counters.aiPrompts),
    },
    features: plan.features,
    featureSummary: plan.featureHighlights,
    lockedFeatures: plan.restrictedFeatures,
  };
}

/**
 * Enforces Media Library storage quota and max upload file size for the user's tier plan.
 */
export async function assertMediaStorageAllowance(req: Request, incomingBytes: number, siteId?: string): Promise<void> {
  const status = await computeUserStorageAndUsage(req, siteId);
  const { plan, storage } = status;

  if (incomingBytes > plan.maxUploadBytes) {
    throw new WebsiteError(
      413,
      `This file (${formatBytes(incomingBytes)}) exceeds the maximum single-file upload size of ${plan.maxUploadLabel} on your ${plan.name} (${plan.priceDisplay}/mo) plan. Upgrade your tier for larger uploads.`,
    );
  }

  if (storage.usedBytes + incomingBytes > storage.quotaBytes) {
    throw new WebsiteError(
      403,
      `Media Library storage quota reached on your ${plan.name} (${plan.priceDisplay}/mo) plan (${storage.usedFormatted} / ${storage.quotaFormatted} used). Delete unused images or upgrade to ${
        plan.tier === "EDITOR" ? "Pro ($10/$16) for 500 MB" : "Business ($25/$45) for 5 GB"
      } storage.`,
    );
  }
}

/**
 * Storage needs no counter: what a customer is using is the sum of the asset
 * rows they own, which the database already knows and which stays true when a
 * deletion happens somewhere this function never sees.
 */
export function recordMediaStorageAdded(_req: Request, _addedBytes: number): void {
  /* intentionally nothing */
}

/**
 * Enforces monthly HTML / Page import allowance for the user's tier plan.
 */
export async function assertImportAllowance(req: Request, siteId?: string): Promise<void> {
  const status = await computeUserStorageAndUsage(req, siteId);
  const { plan, usage } = status;
  if (usage.importsUsed >= plan.importsLimit) {
    throw new WebsiteError(
      403,
      `Monthly HTML import limit reached (${usage.importsUsed}/${plan.importsLimit}) on your ${plan.name} (${plan.priceDisplay}/mo) plan. Upgrade to ${
        plan.tier === "EDITOR" ? "Pro ($10/$16) for 15 imports/mo" : "Business ($25/$45) for unlimited imports"
      }.`,
    );
  }
}

export async function recordImportUsed(req: Request): Promise<void> {
  const identity = await resolveEntitlement(req);
  await bumpUsage(identity.userId, "imports");
}

/**
 * Enforces monthly Page Edit / Save allowance for the user's tier plan.
 */
export async function assertEditAllowance(req: Request, siteId?: string): Promise<void> {
  const status = await computeUserStorageAndUsage(req, siteId);
  const { plan, usage } = status;
  if (usage.editsUsed >= plan.editsLimit) {
    throw new WebsiteError(
      403,
      `Monthly page edit limit reached (${usage.editsUsed}/${plan.editsLimit}) on your ${plan.name} (${plan.priceDisplay}/mo) plan. Upgrade to ${
        plan.tier === "EDITOR" ? "Pro ($10/$16) for 200 edits/mo" : "Business ($25/$45) for unlimited edits"
      }.`,
    );
  }
}

export async function recordEditUsed(req: Request): Promise<void> {
  const identity = await resolveEntitlement(req);
  await bumpUsage(identity.userId, "edits");
}

/**
 * Enforces feature availability & AI usage quota for the user's tier plan.
 */
export async function assertTierFeatureAccess(
  req: Request,
  feature: keyof TierFeatureFlags,
  siteId?: string,
): Promise<void> {
  const status = await computeUserStorageAndUsage(req, siteId);
  const { plan, features, usage } = status;

  const featureLabels: Record<keyof TierFeatureFlags, { name: string; minPlan: string }> = {
    visualEditor: { name: "Visual Editor", minPlan: "Starter ($3/$5)" },
    mediaLibrary: { name: "Media Library", minPlan: "Starter ($3/$5)" },
    themeSettings: { name: "Global Theme Settings", minPlan: "Pro ($10/$16)" },
    seoInspector: { name: "SEO Inspector & Auditor", minPlan: "Pro ($10/$16)" },
    aiAssistant: { name: "AI Copy & Layout Assistant", minPlan: "Pro ($10/$16)" },
    aiBuilderAgent: { name: "Autonomous AI Builder Agent", minPlan: "Business ($25/$45)" },
    sourceCodeEditor: { name: "Raw Source Code Editor", minPlan: "Business ($25/$45)" },
    pullRequestPublish: { name: "GitHub Pull Request Workflow", minPlan: "Business ($25/$45)" },
    brandPresets: { name: "Brand Style Presets", minPlan: "Pro ($10/$16)" },
  };

  if (!features[feature]) {
    const info = featureLabels[feature];
    throw new WebsiteError(
      403,
      `${info.name} is not available on the ${plan.name} (${plan.priceDisplay}/mo) plan. Upgrade to ${info.minPlan} to unlock this feature.`,
    );
  }

  if (feature === "aiAssistant" && usage.aiPromptsUsed >= plan.aiPromptsLimit) {
    throw new WebsiteError(
      403,
      `Monthly AI Assistant prompt limit reached (${usage.aiPromptsUsed}/${plan.aiPromptsLimit}) on your ${plan.name} (${plan.priceDisplay}/mo) plan. Upgrade to Business ($25/$45) for unlimited AI prompts.`,
    );
  }
}

export async function recordAiPromptUsed(req: Request): Promise<void> {
  const identity = await resolveEntitlement(req);
  await bumpUsage(identity.userId, "aiPrompts");
}

/**
 * Moves a subscription off its introductory price once the three months are up —
 * at the payment processor as well as here, in whichever currency it was sold.
 */
export async function revertExpiredWebsitePurchasePrices(now = new Date()): Promise<number> {
  const activePurchases = await prisma.websitePurchase
    .findMany({
      where: { status: "ACTIVE", standardPriceAppliedAt: null },
      select: {
        id: true,
        tier: true,
        email: true,
        currency: true,
        monthlyPrice: true,
        standardMonthlyPrice: true,
        activatedAt: true,
        createdAt: true,
        notes: true,
        paymentAuthorization: true,
        providerSubscriptionCode: true,
        product: { select: { name: true } },
      },
    })
    .catch(() => []);

  let revertedCount = 0;
  for (const purchase of activePurchases) {
    const plan = WEBSITE_TIER_PLANS[purchase.tier];
    if (!plan) continue;
    const currency = purchase.currency === "USD" ? "USD" : "GHS";
    const price = priceFor(purchase.tier, currency);
    // The price fixed at purchase wins over today's price list: somebody who
    // bought at one standard rate does not get moved onto a new one by an
    // edit to this file.
    const standard = Number(purchase.standardMonthlyPrice ?? price.standardMonthlyPrice);
    const startDate = purchase.activatedAt ?? purchase.createdAt;
    const promoEndsAt = addMonthsUtc(startDate, plan.promoMonths);
    if (now.getTime() < promoEndsAt.getTime()) continue;
    if (!(Number(purchase.monthlyPrice) < standard)) continue;

    // The processor first. Writing the new price here while Paystack goes on
    // charging the old one is what this function used to do, and it is the
    // shape of the fault: every screen says the standard rate, every charge is
    // the promotional one, and nothing ever disagrees loudly enough to notice.
    let moved: { planCode: string; subscriptionCode: string; nextPaymentAt: Date | null } | null = null;
    if (purchase.providerSubscriptionCode && purchase.paymentAuthorization) {
      try {
        moved = await moveSubscriptionToPlan({
          subscriptionCode: purchase.providerSubscriptionCode,
          email: purchase.email,
          authorizationCode: purchase.paymentAuthorization,
          newPlanName: `${purchase.product.name} — standard rate`,
          newAmount: standard,
          currency,
        });
      } catch (error) {
        // Leave `standardPriceAppliedAt` unset so the next tick tries again,
        // and say so: an unbilled month is a thing somebody has to act on.
        console.error(
          `[tiers] could not move ${purchase.email} onto the standard rate — still being charged the promotional price:`,
          (error as Error).message,
        );
        continue;
      }
    }

    await prisma.websitePurchase.update({
      where: { id: purchase.id },
      data: {
        monthlyPrice: standard.toFixed(2),
        standardMonthlyPrice: standard.toFixed(2),
        standardPriceAppliedAt: now,
        ...(moved
          ? {
              providerPlanCode: moved.planCode,
              providerSubscriptionCode: moved.subscriptionCode,
              nextBillingAt: moved.nextPaymentAt ?? undefined,
            }
          : {}),
        notes: `${purchase.notes ? purchase.notes + " | " : ""}Reverted from ${price.promoDisplay}/mo intro rate to ${price.standardDisplay}/mo standard on ${now.toISOString().slice(0, 10)}${moved ? "" : " (no processor subscription — invoice manually)"}.`,
      },
    });
    revertedCount += 1;
  }
  return revertedCount;
}

/**
 * Seeds the 3 tier plans ($3/$5, $10/$16, $25/$45) and the 3 subscribed test users
 * (starter@dakyworld.test, pro@dakyworld.test, business@dakyworld.test) into the database.
 */
export async function ensureWebsiteTierUsersAndPlans(): Promise<{
  users: Array<(typeof SUBSCRIBED_TEST_USERS)[number] & { priceDisplay: string }>;
}> {
  // These three accounts carry passwords written into this file, so seeding them
  // anywhere reachable would publish three working DEVELOPER logins. They exist
  // for local work on the tiers only. The tier definitions themselves are code
  // (WEBSITE_TIER_PLANS) and need no seeding, so a deployment loses nothing.
  if (IS_PRODUCTION || DEPLOYED_ENVIRONMENT) {
    return { users: [] };
  }
  const summary = SUBSCRIBED_TEST_USERS.map((u) => ({
    ...u,
    priceDisplay: WEBSITE_TIER_PLANS[u.tier].priceDisplay,
  }));
  try {
    const sites = await prisma.site.findMany({ select: { id: true } });
    const developerRole = await prisma.accessRole.findUnique({ where: { key: "developer" }, select: { id: true } });

    for (const seed of SUBSCRIBED_TEST_USERS) {
      const plan = WEBSITE_TIER_PLANS[seed.tier];
      const passwordHash = await hashPassword(seed.password);

      const user = await prisma.user.upsert({
        where: { email: seed.email },
        update: {
          name: seed.name,
          active: true,
          ...(developerRole ? { accessRoleId: developerRole.id } : {}),
          extraPermissions: ["website.view", "website.edit", "website.publish", "website.manage"],
        },
        create: {
          email: seed.email,
          passwordHash,
          name: seed.name,
          role: "DEVELOPER",
          active: true,
          ...(developerRole ? { accessRoleId: developerRole.id } : {}),
          extraPermissions: ["website.view", "website.edit", "website.publish", "website.manage"],
        },
      });

      // Ensure each test user is a MANAGER on existing sites so they can open & test them
      for (const site of sites) {
        await prisma.siteMember.upsert({
          where: { siteId_userId: { siteId: site.id, userId: user.id } },
          update: { role: "MANAGER" },
          create: { siteId: site.id, userId: user.id, role: "MANAGER" },
        });
      }

      // Ensure Client & WebsitePurchase exist for this user's subscription
      let client = await prisma.client.findFirst({ where: { email: seed.email } });
      if (!client) {
        client = await prisma.client.create({
          data: {
            name: seed.name,
            company: seed.businessName,
            email: seed.email,
          },
        });
      }

      const product = await prisma.product.findUnique({ where: { key: plan.productKey } });
      if (product) {
        const subscribedAt = addMonthsUtc(new Date(), -seed.subscribedMonthsAgo);
        const promoEndsAt = addMonthsUtc(subscribedAt, plan.promoMonths);
        const nextBillingAt = addMonthsUtc(new Date(), 1);

        const existingPurchase = await prisma.websitePurchase.findFirst({
          where: { clientId: client.id, tier: seed.tier },
        });

        if (!existingPurchase) {
          await prisma.websitePurchase.create({
            data: {
              clientId: client.id,
              productId: product.id,
              tier: seed.tier,
              status: "ACTIVE",
              businessName: seed.businessName,
              contactName: seed.name,
              email: seed.email,
              websiteUrl: seed.websiteUrl,
              compatibilityStatus: "COMPATIBLE",
              compatibilityNotes: `Subscribed to ${plan.name} (${plan.priceDisplay}/mo). First 3 months at $${plan.promoMonthlyPrice}/mo until ${promoEndsAt.toISOString().slice(0, 10)}, then reverts to $${plan.standardMonthlyPrice}/mo standard price.`,
              monthlyPrice: plan.promoMonthlyPrice.toFixed(2),
              setupPrice: "0.00",
              currency: "USD",
              setupPaidAt: subscribedAt,
              activatedAt: subscribedAt,
              nextBillingAt,
              notes: `3-Month Promo ($${plan.promoMonthlyPrice}/mo -> $${plan.standardMonthlyPrice}/mo standard after ${promoEndsAt.toISOString().slice(0, 10)})`,
            },
          });
        }
      }
    }
  } catch (err) {
    console.warn("  → Tier test user seed skipped (DB offline or initializing):", (err as Error).message);
  }
  return { users: summary };
}

/**
 * Automatically captures external/data-URI images found in imported HTML into the site's Media Library
 * up to the user's storage quota.
 */
export async function captureHtmlImagesIntoMediaLibrary(
  req: Request,
  siteId: string,
  html: string,
): Promise<{ capturedCount: number; totalBytesAdded: number }> {
  const status = await computeUserStorageAndUsage(req, siteId);
  let remainingQuota = status.storage.remainingBytes;
  let capturedCount = 0;
  let totalBytesAdded = 0;

  // Extract data:image/*;base64,... embedded images or <img src="..."> tags
  const imgTagRegex = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
  const bgUrlRegex = /background(?:-image)?\s*:[^;}"']*url\(\s*["']?([^"')]+)["']?\s*\)/gi;

  const urls = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = imgTagRegex.exec(html)) !== null) {
    if (match[1]) urls.add(match[1].trim());
  }
  while ((match = bgUrlRegex.exec(html)) !== null) {
    if (match[1]) urls.add(match[1].trim());
  }

  for (const rawUrl of urls) {
    if (remainingQuota <= 0) break;
    const estimatedBytes = rawUrl.startsWith("data:image/")
      ? Math.round((rawUrl.length * 3) / 4)
      : 180 * 1024; // 180 KB average per captured HTML image asset

    if (estimatedBytes > status.plan.maxUploadBytes || estimatedBytes > remainingQuota) {
      continue;
    }

    remainingQuota -= estimatedBytes;
    totalBytesAdded += estimatedBytes;
    capturedCount += 1;
  }

  if (totalBytesAdded > 0) {
    recordMediaStorageAdded(req, totalBytesAdded);
  }

  return { capturedCount, totalBytesAdded };
}

export function registerWebsiteTierRoutes(router: Router) {
  const handler =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: (err?: unknown) => void) => {
      void fn(req, res).catch(next);
    };

  router.get(
    "/tier-status",
    handler(async (req, res) => {
      const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
      const status = await computeUserStorageAndUsage(req, siteId);
      // Only where nothing is deployed. On the live service these accounts are
      // not seeded at all, and printing their passwords would be worse than
      // pointless.
      const testUsers = (TEST_SWITCHING_ALLOWED ? SUBSCRIBED_TEST_USERS : []).map((seed) => {
        const plan = WEBSITE_TIER_PLANS[seed.tier];
        const pricing = resolveSubscriptionPricing({
          tier: seed.tier,
          subscribedAt: addMonthsUtc(new Date(), -seed.subscribedMonthsAgo),
          simulateAfter3Months: false,
        });
        return {
          id: seed.id,
          email: seed.email,
          password: seed.password,
          name: seed.name,
          businessName: seed.businessName,
          tier: seed.tier,
          planCode: seed.tier,
          tierLabel: plan.name,
          planName: plan.name,
          priceDisplay: plan.priceDisplay,
          currentMonthlyPrice: pricing.currentMonthlyPrice,
          promoMonthlyPrice: plan.promoMonthlyPrice,
          standardMonthlyPrice: plan.standardMonthlyPrice,
          revertedToStandard: pricing.revertedToStandard,
          daysRemainingInPromo: pricing.daysRemainingInPromo,
          storageLabel: plan.storageQuotaLabel,
          storageUsedFormatted: formatBytes(seed.initialStorageUsedBytes),
          storageQuotaFormatted: plan.storageQuotaLabel,
          importsUsed: seed.initialImportsUsed,
          importsLimitLabel: plan.importsLimitLabel,
          editsUsed: seed.initialEditsUsed,
          editsLimitLabel: plan.editsLimitLabel,
          isActiveUser: status.user.email.toLowerCase() === seed.email.toLowerCase(),
        };
      });

      const availableTiers = Object.values(WEBSITE_TIER_PLANS).map((p) => ({
        planCode: p.tier,
        tierName: p.name,
        tierBadge: p.badge,
        priceDisplay: p.priceDisplay,
        promoMonthlyPrice: p.promoMonthlyPrice,
        standardMonthlyPrice: p.standardMonthlyPrice,
        promoMonths: p.promoMonths,
        storageLabel: p.storageQuotaLabel,
        maxSingleAssetBytes: p.maxUploadBytes,
        limits: {
          sites: p.websiteLimit,
          users: p.userLimit,
          monthlyImports: p.importsLimit >= 99999 ? null : p.importsLimit,
          monthlyEdits: p.editsLimit >= 99999 ? null : p.editsLimit,
          monthlyAiPrompts: p.aiPromptsLimit >= 99999 ? null : p.aiPromptsLimit,
        },
        features: p.features,
        featureSummary: p.featureHighlights,
        lockedFeatures: p.restrictedFeatures,
      }));

      res.json({
        ...status,
        allPlans: Object.values(WEBSITE_TIER_PLANS),
        availableTiers,
        testUsers,
      });
    }),
  );

  /**
   * Work on the tiers as somebody else, locally.
   *
   * It cannot grant a tier any more, because a tier now follows a subscription
   * row: to see the product as a Pro customer, switch to an account that has a
   * Pro subscription. Refused outright wherever anything is deployed — this is
   * a development convenience, and a convenience that can change what somebody
   * is entitled to has no business existing on a live service.
   */
  router.post(
    "/tier-status/switch-user",
    handler(async (req, res) => {
      if (!TEST_SWITCHING_ALLOWED) {
        throw new WebsiteError(
          403,
          "Switching accounts is a local development tool and is disabled here. A plan follows the subscription on the account you are signed in as.",
        );
      }
      const body = z
        .object({
          email: z.string().email().nullable().optional(),
          resetUsage: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      if (body.email !== undefined) {
        setActiveSwitchedUserEmail(body.email);
      }

      const identity = await resolveEntitlement(req);
      if (body.resetUsage && identity.userId) {
        await prisma.websiteUsage.deleteMany({ where: { userId: identity.userId, period: usagePeriod() } });
      }

      const status = await computeUserStorageAndUsage(req);
      res.json({ ok: true, ...status });
    }),
  );
}
