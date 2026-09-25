import type { Request, Response, Router } from "express";
import { randomUUID } from "node:crypto";
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
import { editingLockedForNonPayment } from "./websiteDunning.js";
import { fetchWebsiteBytes } from "../lib/websiteFetch.js";
import { sniff } from "../lib/fileType.js";
import { optimizeImageBuffer } from "../lib/imageOptimization.js";
import { looksLikeSvg } from "../lib/svgSanitize.js";
import { assetUrl } from "./websiteAssets.js";

/**
 * Website Builder Three-Tier Plan, Storage Quota, 3-Month Promo Pricing Reversion,
 * Feature Matrix, Usage Limits & Subscribed Test Users.
 *
 * Prices are authored in USD on each tier below and charged in cedis at
 * `PAYSTACK_USD_GHS_RATE` — `paymentQuote.ts` is the only thing that decides
 * what a customer actually pays.
 *
 * **No price is written as a string in this file.** It used to be: `badge` and
 * `priceDisplay` said "$3 ($5)" long after the numbers beside them had become
 * 25 and 40, and long after billing had moved to cedis — so a Starter customer
 * read "$3 ($5)" on their own plan screen while being charged GHS 300, which is
 * eight times that and in another currency. A price that depends on a rate read
 * at call time cannot be a literal. `tierLabels()` below is how a screen asks
 * for one.
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
  /** What the plan is for. Deliberately carries no price — see `tierLabels`. */
  tagline: string;
  /** Both prices are USD. Cedis are these times PAYSTACK_USD_GHS_RATE. */
  promoMonthlyPrice: number;
  standardMonthlyPrice: number;
  promoMonths: number;
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

/**
 * What a tier costs, in words, at today's rate.
 *
 * The one place a screen or an error message may get a price from. Every
 * caller used to hold its own — "Pro ($10/$16)" was written out nine times in
 * the upgrade messages below, and each copy was a price nobody had been
 * charged since billing moved to cedis. Naming the tier and asking here means
 * a rate change reaches all of them at once, and none of them can drift.
 */
export function tierLabels(tier: WebsitePlanTier, currency: PlanCurrency = "GHS") {
  const plan = WEBSITE_TIER_PLANS[tier];
  const price = priceFor(tier, currency);
  return {
    name: plan.name,
    /** "GHS 300 (GHS 500)" — promotional, with the standard price after it. */
    badge: price.display,
    priceDisplay: price.display,
    promoDisplay: price.promoDisplay,
    standardDisplay: price.standardDisplay,
    /** "Pro (GHS 900)" — how an upgrade is named to somebody being asked to buy it. */
    upgrade: `${plan.name} (${price.promoDisplay})`,
  };
}

/** The tier above this one, or null at the top. What "upgrade" means, once. */
export function nextTierUp(tier: WebsitePlanTier): WebsitePlanTier | null {
  return tier === "EDITOR" ? "CARE" : tier === "CARE" ? "MANAGED" : null;
}

/**
 * " Upgrade to Pro (GHS 900) for 500 MB storage." — or nothing at all on the
 * top tier, which is the case every hand-written version of this got wrong by
 * telling a Business customer to upgrade to Business.
 *
 * `describe` is given the tier being offered, so the sentence quotes that
 * tier's own limits rather than a number copied beside it.
 */
function upgradeSentence(
  tier: WebsitePlanTier,
  describe: (plan: TierPlanDefinition) => string,
  currency: PlanCurrency = "GHS",
): string {
  const next = nextTierUp(tier);
  if (!next) return "";
  return ` Upgrade to ${tierLabels(next, currency).upgrade} for ${describe(WEBSITE_TIER_PLANS[next])}.`;
}

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export const WEBSITE_TIER_PLANS: Record<WebsitePlanTier, TierPlanDefinition> = {
  EDITOR: {
    tier: "EDITOR",
    productKey: "website-builder",
    name: "Starter",
    tagline: "Essential visual page editing and media storage for solo creators.",
    promoMonthlyPrice: 3,
    standardMonthlyPrice: 5,
    promoMonths: 3,
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
    tagline: "Expanded storage, global theme tokens, SEO inspector and AI assistant.",
    promoMonthlyPrice: 10,
    standardMonthlyPrice: 16,
    promoMonths: 3,
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
    monitoring: false,
    technicalOversight: true,
    monthlyReview: false,
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
    tagline: "5 GB media storage, unlimited imports and edits, AI Builder Agent and source code access.",
    promoMonthlyPrice: 25,
    standardMonthlyPrice: 45,
    promoMonths: 3,
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
    monitoring: false,
    technicalOversight: true,
    monthlyReview: false,
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
    name: "Ama Mensah (Starter)",
    tier: "EDITOR",
    businessName: "Mensah Creative Studio",
    websiteUrl: "https://mensahstudio.example.com",
    subscribedMonthsAgo: 1, // In month 2 of the 3-month promotional period
    initialStorageUsedBytes: 12 * MB, // 12 MB of 50 MB used
    initialImportsUsed: 1, // 1 of 3 imports used
    initialEditsUsed: 8, // 8 of 30 edits used
    initialAiPromptsUsed: 0,
  },
  {
    id: "user-tier-pro",
    email: "pro@dakyworld.test",
    password: "ProTier#2026!",
    name: "Kofi Owusu (Pro)",
    tier: "CARE",
    businessName: "Owusu Digital Agency",
    websiteUrl: "https://owusudigital.example.com",
    subscribedMonthsAgo: 2, // In month 3 of the 3-month promotional period
    initialStorageUsedBytes: 85 * MB, // 85 MB of 500 MB used
    initialImportsUsed: 4, // 4 of 15 imports used
    initialEditsUsed: 42, // 42 of 200 edits used
    initialAiPromptsUsed: 11, // 11 of 50 AI prompts used
  },
  {
    id: "user-tier-business",
    email: "business@dakyworld.test",
    password: "Business#2026!",
    name: "Esi Asante (Business)",
    tier: "MANAGED",
    businessName: "Asante Enterprise Group",
    websiteUrl: "https://asantegroup.example.com",
    subscribedMonthsAgo: 0, // Subscribed this month, at the start of the promotional period
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
 * window or has automatically reverted to the standard price after the first
 * 3 months. Prices are read from the same GHS catalogue used at checkout.
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
    tierBadge: tierLabels(plan.tier).badge,
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
      `This file (${formatBytes(incomingBytes)}) exceeds the maximum single-file upload size of ${plan.maxUploadLabel} on your ${plan.name} (${tierLabels(plan.tier).promoDisplay}/mo) plan.${upgradeSentence(plan.tier, (next) => `uploads up to ${next.maxUploadLabel}`) || " This is the largest plan."}`,
    );
  }

  if (storage.usedBytes + incomingBytes > storage.quotaBytes) {
    throw new WebsiteError(
      403,
      `Media Library storage quota reached on your ${plan.name} (${tierLabels(plan.tier).promoDisplay}/mo) plan (${storage.usedFormatted} / ${storage.quotaFormatted} used). Delete unused images.${upgradeSentence(plan.tier, (next) => `${next.storageQuotaLabel} of storage`)}`,
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
      `Monthly HTML import limit reached (${usage.importsUsed}/${plan.importsLimit}) on your ${plan.name} (${tierLabels(plan.tier).promoDisplay}/mo) plan.${upgradeSentence(plan.tier, (next) => next.importsLimitLabel)}`,
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

  // Three declined renewals pause editing. The published website is untouched
  // and stays online — see services/websiteDunning.ts for why that line is
  // where it is.
  const identity = await resolveEntitlement(req);
  if (await editingLockedForNonPayment(identity.purchaseId)) {
    throw new WebsiteError(
      402,
      "Editing is paused because the last three payment attempts were declined. Your website is still online and nothing has been deleted — update your card and editing comes back straight away.",
    );
  }
  if (usage.editsUsed >= plan.editsLimit) {
    throw new WebsiteError(
      403,
      `Monthly page edit limit reached (${usage.editsUsed}/${plan.editsLimit}) on your ${plan.name} (${tierLabels(plan.tier).promoDisplay}/mo) plan.${upgradeSentence(plan.tier, (next) => next.editsLimitLabel)}`,
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
    visualEditor: { name: "Visual Editor", minPlan: tierLabels("EDITOR").upgrade },
    mediaLibrary: { name: "Media Library", minPlan: tierLabels("EDITOR").upgrade },
    themeSettings: { name: "Global Theme Settings", minPlan: tierLabels("CARE").upgrade },
    seoInspector: { name: "SEO Inspector & Auditor", minPlan: tierLabels("CARE").upgrade },
    aiAssistant: { name: "AI Copy & Layout Assistant", minPlan: tierLabels("CARE").upgrade },
    aiBuilderAgent: { name: "Autonomous AI Builder Agent", minPlan: tierLabels("MANAGED").upgrade },
    sourceCodeEditor: { name: "Raw Source Code Editor", minPlan: tierLabels("MANAGED").upgrade },
    pullRequestPublish: { name: "GitHub Pull Request Workflow", minPlan: tierLabels("MANAGED").upgrade },
    brandPresets: { name: "Brand Style Presets", minPlan: tierLabels("CARE").upgrade },
  };

  if (!features[feature]) {
    const info = featureLabels[feature];
    throw new WebsiteError(
      403,
      `${info.name} is not available on the ${plan.name} (${tierLabels(plan.tier).promoDisplay}/mo) plan. Upgrade to ${info.minPlan} to unlock this feature.`,
    );
  }

  if (feature === "aiAssistant" && usage.aiPromptsUsed >= plan.aiPromptsLimit) {
    throw new WebsiteError(
      403,
      `Monthly AI Assistant prompt limit reached (${usage.aiPromptsUsed}/${plan.aiPromptsLimit}) on your ${plan.name} (${tierLabels(plan.tier).promoDisplay}/mo) plan.${upgradeSentence(plan.tier, (next) => next.aiPromptsLimitLabel)}`,
    );
  }
}

export async function recordAiPromptUsed(req: Request): Promise<void> {
  const identity = await resolveEntitlement(req);
  await bumpUsage(identity.userId, "aiPrompts");
}




/**
 * Seeds the 3 tier plans and the 3 subscribed test users
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
    priceDisplay: tierLabels(u.tier).priceDisplay,
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
              compatibilityNotes: `Subscribed to ${plan.name} (${tierLabels(plan.tier).priceDisplay}/mo). First 3 months at ${tierLabels(plan.tier).promoDisplay}/mo until ${promoEndsAt.toISOString().slice(0, 10)}, then reverts to ${tierLabels(plan.tier).standardDisplay}/mo standard price.`,
              monthlyPrice: plan.promoMonthlyPrice.toFixed(2),
              setupPrice: "0.00",
              currency: "GHS",
              setupPaidAt: subscribedAt,
              activatedAt: subscribedAt,
              nextBillingAt,
              notes: `3-Month Promo (GHS ${plan.promoMonthlyPrice}/mo -> GHS ${plan.standardMonthlyPrice}/mo standard after ${promoEndsAt.toISOString().slice(0, 10)})`,
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
): Promise<{ html: string; capturedCount: number; totalBytesAdded: number; skippedCount: number }> {
  const status = await computeUserStorageAndUsage(req, siteId);
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { publicUrl: true } });
  let remainingQuota = status.storage.remainingBytes;
  let capturedCount = 0;
  let totalBytesAdded = 0;
  let skippedCount = 0;
  let updatedHtml = html;

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
    if (capturedCount >= 50 || remainingQuota <= 0) { skippedCount += 1; continue; }
    try {
      const limit = Math.min(status.plan.maxUploadBytes, remainingQuota);
      let bytes: Buffer;
      if (/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,/i.test(rawUrl)) {
        bytes = Buffer.from(rawUrl.slice(rawUrl.indexOf(",") + 1), "base64");
      } else if (/^data:image\/svg\+xml(?:;charset=[\w-]+)?(?:;utf8)?,/i.test(rawUrl)) {
        // An SVG written straight into the attribute, percent-encoded.
        bytes = Buffer.from(decodeURIComponent(rawUrl.slice(rawUrl.indexOf(",") + 1)), "utf8");
      } else {
        const url = new URL(rawUrl, site.publicUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported image URL");
        bytes = await fetchWebsiteBytes(url.href, limit);
      }
      if (!bytes.length || bytes.length > limit) throw new Error("Image exceeds upload limit");
      const mime = sniff(bytes);
      // SVG has no signature to sniff; `optimizeImageBuffer` recognises it and
      // rebuilds it through the sanitiser, and refuses it if that fails.
      if (!(mime ? ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime) : looksLikeSvg(bytes))) throw new Error("Unsupported image format");
      const optimized = await optimizeImageBuffer(bytes);
      if (optimized.content.length > limit) throw new Error("Image exceeds storage limit");
      const repoPath = `assets/dw/${randomUUID()}.${optimized.extension}`;
      await prisma.siteAsset.create({ data: {
        siteId, repoPath, filename: rawUrl.startsWith("data:") ? `imported.${optimized.extension}` : new URL(rawUrl, site.publicUrl).pathname.split("/").pop()?.slice(0, 200) || `imported.${optimized.extension}`,
        contentType: optimized.contentType, content: optimized.content, size: optimized.content.length,
        alt: "",
      } });
      updatedHtml = updatedHtml.split(rawUrl).join(assetUrl(site, repoPath));
      remainingQuota -= optimized.content.length;
      totalBytesAdded += optimized.content.length;
      capturedCount += 1;
    } catch {
      skippedCount += 1;
    }
  }

  return { html: updatedHtml, capturedCount, totalBytesAdded, skippedCount };
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
          priceDisplay: tierLabels(plan.tier).priceDisplay,
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
        tierBadge: tierLabels(p.tier).badge,
        priceDisplay: tierLabels(p.tier).priceDisplay,
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
