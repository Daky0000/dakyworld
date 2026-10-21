import type { WebsiteActor } from "./websiteActor.js";
import type { Request, Response, Router } from "express";
import { randomUUID } from "node:crypto";
import type { Prisma, WebsitePlanTier } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { dailyAiLimit } from "../lib/capacity.js";
import { hashPassword } from "../lib/password.js";
import { WebsiteError } from "./website/site.js";
import { websitePathId } from "./websiteAccess.js";
import { IS_PRODUCTION } from "../middleware/auth.js";
import {
  bumpUsage,
  readUsage,
  resolveEntitlement,
  resolveSiteEntitlement,
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

/**
 * Which plan feature a website API route needs, from its path alone.
 *
 * One table for every route, whichever file registers it. It used to live in a
 * middleware that only saw the routes registered after it, so whether a new
 * route was covered depended on which line of routes/website.ts its register
 * call happened to land on. The gate now runs ahead of every route and asks
 * this; `checks/websiteTierFeatures.ts` walks the real router and holds the
 * matrix, so a new SEO, assistant, agent or source route cannot ship ungated.
 *
 * Features decided by what a request changes rather than where it goes — theme
 * settings on a design save, pull-request publishing — stay in their handlers.
 */
export function websiteTierFeature(path: string): keyof TierFeatureFlags | null {
  if (/\/(?:source|source-project)(?:\/|$)/.test(path)) return "sourceCodeEditor";
  if (/\/agent(?:\/|$)/.test(path)) return "aiBuilderAgent";
  if (/\/(?:assistant|suggest|ai)(?:\/|$)/.test(path)) return "aiAssistant";
  if (/\/seo(?:\/|$)/.test(path)) return "seoInspector";
  return null;
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
  currency: PlanCurrency,
  describe: (plan: TierPlanDefinition) => string,
): string {
  const next = nextTierUp(tier);
  if (!next) return "";
  return ` Upgrade to ${tierLabels(next, currency).upgrade} for ${describe(WEBSITE_TIER_PLANS[next])}.`;
}

/**
 * "Pro (GHS 300/mo)" — the plan a limit message names, at the price this
 * customer pays now and in their own currency. The messages used to quote the
 * cedi promotional price to everybody, so a customer paying in dollars was told
 * their plan cost GHS 300, and one past the promotion was quoted the old price.
 */
type PlanStatus = { plan: TierPlanDefinition; pricing: { currentDisplay: string }; websitePlan: boolean };
function planLabel(status: PlanStatus): string {
  return `${status.plan.name} (${status.pricing.currentDisplay}/mo)`;
}

/**
 * "your Pro (GHS 300/mo) plan" — or "this website's" to somebody working on a
 * website under another account's plan, which is not theirs to call their own.
 */
function yourPlan(status: PlanStatus): string {
  return `${status.websitePlan ? "this website's" : "your"} ${planLabel(status)} plan`;
}

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

/**
 * A video's single-file ceiling, the same on every plan (Dan, 20 Oct 2026).
 * Pictures keep each plan's own limit and every file still counts against the
 * plan's storage. A video this size never passes through one request: it goes
 * to storage in pieces (`websiteVideoUpload.ts`).
 */
export const MAX_VIDEO_UPLOAD_BYTES = GB;
export const MAX_VIDEO_UPLOAD_LABEL = "1 GB";

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
    editsLimitLabel: "30 page edits / mo (a page counts once a day)",
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
      "30 page edits a month — a page counts once a day, however many changes you make",
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
    editsLimitLabel: "200 page edits / mo (a page counts once a day)",
    aiPromptsLimit: 50,
    // And a daily ceiling the queue enforces, from the number it reads — the
    // eleventh run of a day is refused, and a label that said only "a month"
    // left that to be found out by being refused.
    aiPromptsLimitLabel: `50 AI prompts / mo, up to ${dailyAiLimit("CARE")} a day`,
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
      "200 page edits a month — a page counts once a day, however many changes you make",
      "Global Theme Color System & Brand Presets",
      "Full Page SEO Inspector & Metadata Auditor",
      `AI Copy & Section Assistant (50 runs/mo, up to ${dailyAiLimit("CARE")} a day)`,
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
    // Unlimited in the month, with a daily ceiling the queue enforces. Said
    // here from the same number the queue reads, so the label cannot promise
    // more than the refusal allows.
    aiPromptsLimitLabel: `Unlimited AI runs (fair use: ${dailyAiLimit("MANAGED")} a day)`,
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
      `Autonomous AI Builder Agent & unlimited AI runs (fair use: ${dailyAiLimit("MANAGED")} a day)`,
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
  /** "GHS 300" or "$25" — formatted in the customer's own currency, so no screen has to guess the symbol. */
  promoDisplay: string;
  standardDisplay: string;
  currentDisplay: string;
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
    promoDisplay: price.promoDisplay,
    standardDisplay: price.standardDisplay,
    currentDisplay: revertedToStandard ? price.standardDisplay : price.promoDisplay,
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

export async function resolveEffectiveUserIdentity(req: WebsiteActor): Promise<Entitlement> {
  return resolveEntitlement(req);
}

/**
 * The plan, its prices, its counters and its storage, for somebody — on one
 * website when `siteId` is given, which is the website's plan when it has a
 * paying owner (`resolveSiteEntitlement`), and their own otherwise.
 */
export async function computeUserStorageAndUsage(req: WebsiteActor, siteId?: string) {
  const identity = await resolveSiteEntitlement(req, siteId);
  const plan = WEBSITE_TIER_PLANS[identity.tier];
  const simulateAfter3Months = identity.simulateAfter3Months;
  const counters = await readUsage(identity.chargedUserId);
  const pricing = resolveSubscriptionPricing({
    tier: identity.tier,
    subscribedAt: identity.subscribedAt,
    simulateAfter3Months,
    // The currency the customer actually pays in. Left out, every price came
    // back in cedis — and the banner then printed those cedi numbers after a
    // dollar sign, twelve times what a dollar customer is charged.
    currency: identity.currency === "USD" ? "USD" : "GHS",
  });

  // On a website with a paying owner, storage is the plan's: every website of
  // that client, whoever is uploading — and not the other websites a colleague
  // happens to belong to, which are on somebody else's plan. Otherwise a
  // customer's storage is their account's: every site they belong to, and
  // nobody else's. Without a site this used to sum every asset in the system —
  // each customer's meter showed the whole platform's usage, and the quota was
  // checked against it. Staff have no quota; for them a site narrows it.
  let dbAssetBytes = 0;
  let dbAssetCount = 0;
  try {
    const external = Boolean(req.dbUser?.accessRole?.external);
    const where = identity.siteClientId
      ? { site: { clientId: identity.siteClientId } }
      : external
        ? { site: { members: { some: { userId: req.dbUser!.id } } } }
        : siteId ? { siteId } : {};
    const agg = await prisma.siteAsset.aggregate({ where, _sum: { size: true }, _count: { id: true } });
    dbAssetBytes = Number(agg._sum.size ?? 0);
    dbAssetCount = Number(agg._count.id ?? 0);
  } catch {
    // Fallback if database is unreachable in offline check mode
  }

  const usedBytes = dbAssetBytes;
  const quotaBytes = plan.storageQuotaBytes;
  const remainingBytes = Math.max(0, quotaBytes - usedBytes);
  const percentUsed = Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10);

  // Which account pays, and its purchase, are the owner's business: a
  // colleague's screen names the plan and not the account behind it.
  const { chargedUserId: _charged, siteClientId: _client, ...person } = identity;
  const websitePlan = identity.source === "site" && identity.chargedUserId !== identity.userId;
  return {
    user: { ...person, purchaseId: websitePlan ? null : identity.purchaseId },
    /** True when this is a website's plan, paid for by another account. */
    websitePlan,
    userId: identity.userId,
    userEmail: identity.email,
    userName: identity.name,
    planCode: plan.tier,
    tierName: plan.name,
    tierBadge: tierLabels(plan.tier, identity.currency === "USD" ? "USD" : "GHS").badge,
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
      maxVideoUploadBytes: MAX_VIDEO_UPLOAD_BYTES,
      maxVideoUploadFormatted: MAX_VIDEO_UPLOAD_LABEL,
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
export async function assertMediaStorageAllowance(req: WebsiteActor, incomingBytes: number, siteId?: string, kind: "image" | "video" | "audio" = "image"): Promise<void> {
  const status = await computeUserStorageAndUsage(req, siteId);
  const { plan, storage } = status;

  // Audio rides the video allowance: a podcast episode is the same order of
  // size as a short clip, and both are refused by the plan's picture limit.
  if (kind !== "image" && incomingBytes > MAX_VIDEO_UPLOAD_BYTES) {
    const smaller = kind === "video" ? "Make a smaller copy (1080p is plenty for a page) and upload that." : "Export it at a lower bitrate (a 128 kbps MP3 is plenty for speech and most music) and upload that.";
    throw new WebsiteError(413, `This ${kind === "video" ? "video" : "audio file"} (${formatBytes(incomingBytes)}) is larger than ${MAX_VIDEO_UPLOAD_LABEL}, the most one can be. ${smaller}`);
  }
  if (kind === "image" && incomingBytes > plan.maxUploadBytes) {
    throw new WebsiteError(
      413,
      `This file (${formatBytes(incomingBytes)}) exceeds the maximum single-file upload size of ${plan.maxUploadLabel} on ${yourPlan(status)}.${upgradeSentence(plan.tier, status.pricing.currency, (next) => `uploads up to ${next.maxUploadLabel}`) || " This is the largest plan."}`,
    );
  }

  if (storage.usedBytes + incomingBytes > storage.quotaBytes) {
    throw new WebsiteError(
      403,
      `Media Library storage quota reached on ${yourPlan(status)} (${storage.usedFormatted} / ${storage.quotaFormatted} used). Delete files you no longer use.${upgradeSentence(plan.tier, status.pricing.currency, (next) => `${next.storageQuotaLabel} of storage`)}`,
    );
  }
}

/**
 * Storage needs no counter: what a customer is using is the sum of the asset
 * rows they own, which the database already knows and which stays true when a
 * deletion happens somewhere this function never sees.
 */
export function recordMediaStorageAdded(_req: WebsiteActor, _addedBytes: number): void {
  /* intentionally nothing */
}

/**
 * Enforces monthly HTML / Page import allowance for the user's tier plan.
 */
export async function assertImportAllowance(req: WebsiteActor, siteId?: string): Promise<void> {
  const status = await computeUserStorageAndUsage(req, siteId);
  const { plan, usage } = status;
  if (usage.importsUsed >= plan.importsLimit) {
    throw new WebsiteError(
      403,
      `Monthly HTML import limit reached (${usage.importsUsed}/${plan.importsLimit}) on ${yourPlan(status)}.${upgradeSentence(plan.tier, status.pricing.currency, (next) => next.importsLimitLabel)}`,
    );
  }
}

/** Spends an import — the website's owner's, when `siteId` names a website that has one. */
export async function recordImportUsed(req: WebsiteActor, siteId?: string): Promise<void> {
  const identity = await resolveSiteEntitlement(req, siteId);
  await bumpUsage(identity.chargedUserId, "imports");
}

/* -------------------------------------------------------- page edits ----- */

/**
 * What one edit on the plan is: one page, changed on one UTC day.
 *
 * It was one save, and the editor saves by itself about a second after typing
 * stops — so every pause in a sentence spent an edit, a Starter customer's
 * thirty a month were gone inside their first sitting, and they were told
 * "Monthly page edit limit reached" having changed one heading. Now the first
 * change to a page on a day counts and nothing else on that page that day does.
 *
 * The record is `SitePage.editCountedOn`, the day the page last spent an edit,
 * and nothing but a counted edit writes it. It was `updatedAt` until 13 Oct
 * 2026, which every write to the row moves — so at the limit a rename to the
 * same title, discarding a draft that was not there, or a publish made the
 * page's next save look already paid for, and it went through free for the
 * rest of the day. `draftSavedAt` was never a candidate: publishing clears it,
 * discarding clears it, and so does every save of a shared header, whose words
 * are stored on the shared element.
 */
export type PageEditStamp = { editCountedOn: Date | null };

function startOfUtcDay(now: Date): Date {
  const day = new Date(now.getTime());
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

/** True when this page has already spent its edit today, so changing it again is free. */
export function editCountedToday(page: PageEditStamp, now = new Date()): boolean {
  return Boolean(page.editCountedOn && page.editCountedOn.getTime() >= startOfUtcDay(now).getTime());
}

/** The rows a counted edit may still be spent on: not counted today, or never. */
function notCountedSince(day: Date): Prisma.SitePageWhereInput {
  return { OR: [{ editCountedOn: null }, { editCountedOn: { lt: day } }] };
}

/** What `assertEditAllowance` hands to the write that follows it. `userId` is the account charged. */
export type EditAllowance = { userId: string | null; now: Date };

const PAUSED_FOR_NON_PAYMENT =
  "Editing is paused because the last three payment attempts were declined. Your website is still online and nothing has been deleted — update your card and editing comes back straight away.";

/**
 * Refuses any change to a website while its plan is paused for non-payment —
 * editing and publishing alike. The published website is untouched and stays
 * online; see services/websiteDunning.ts for why that line is where it is.
 */
export async function assertEditingNotPaused(req: WebsiteActor, siteId?: string): Promise<void> {
  const identity = await resolveSiteEntitlement(req, siteId);
  if (await editingLockedForNonPayment(identity.purchaseId)) throw new WebsiteError(402, PAUSED_FOR_NON_PAYMENT);
}

/**
 * The guard a change to a page's words goes through — the page save, a layout
 * change, find & replace, putting a version back, copying a field out of one,
 * inserting a section and saving a shared element — so that however a page is
 * changed, it is the same edit.
 *
 * Refuses everything while editing is paused for non-payment, and refuses a
 * change only when it would count and the month has no edits left for it: a
 * page already changed today can always be changed again today, at the limit
 * or not. `pages` are the pages the change would write — one, several for find
 * & replace, none for a change that would alter nothing — and without them the
 * change is treated as one that counts.
 *
 * Returns what `writePageEdit` counts with, taken at the same moment as the
 * check, so a save checked a moment before midnight UTC is counted on the day
 * it was allowed on.
 */
export async function assertEditAllowance(req: WebsiteActor, siteId?: string, pages?: PageEditStamp | PageEditStamp[]): Promise<EditAllowance> {
  const status = await computeUserStorageAndUsage(req, siteId);
  const { plan, usage } = status;
  const now = new Date();
  const identity = await resolveSiteEntitlement(req, siteId);
  if (await editingLockedForNonPayment(identity.purchaseId)) throw new WebsiteError(402, PAUSED_FOR_NON_PAYMENT);

  const counting = pages === undefined ? 1 : (Array.isArray(pages) ? pages : [pages]).filter((page) => !editCountedToday(page, now)).length;
  const left = Math.max(0, plan.editsLimit - usage.editsUsed);
  if (counting > left) {
    const upgrade = upgradeSentence(plan.tier, status.pricing.currency, (next) => next.editsLimitLabel);
    // All of it or none of it: a replace that stopped at the second of three
    // pages would leave a site saying two different things.
    throw new WebsiteError(
      403,
      left === 0
        ? `Monthly page edit limit reached (${usage.editsUsed}/${plan.editsLimit}) on ${yourPlan(status)}. Pages already changed today can still be edited.${upgrade}`
        : `This would change ${counting} pages that have not been changed today, and ${left} of this month's page edits ${left === 1 ? "is" : "are"} left (${usage.editsUsed}/${plan.editsLimit}) on ${yourPlan(status)}. Nothing was changed.${upgrade}`,
    );
  }
  return { userId: identity.chargedUserId, now };
}

/**
 * Writes one change to a page, and spends an edit if — and only if — it is the
 * first counted change to that page today.
 *
 * The question is asked by the write rather than before it. Two saves of one
 * page arriving together would both read "not counted today" if they read
 * first; as a condition on the update, the first to land sets `editCountedOn`
 * and the second no longer matches. A save that loses on the revision as well
 * writes nothing and counts nothing, so the caller answers it as the conflict it
 * always was.
 *
 * `where` is the caller's own compare-and-swap — the page, and the revision the
 * editor was showing — and `data` is what it would have written anyway. Run it
 * inside a transaction, so the edit is spent only if the change is kept.
 * `counts: false` is a write that changes nothing anybody would see — putting a
 * page back the way it already is — which neither spends an edit nor marks the
 * page as having spent one.
 */
export async function writePageEdit(
  tx: Prisma.TransactionClient,
  allowance: EditAllowance,
  where: { id: string; draftRevision: number },
  data: Prisma.SitePageUncheckedUpdateManyInput,
  options: { counts?: boolean } = {},
): Promise<{ count: number; counted: boolean }> {
  if (options.counts !== false) {
    const today = startOfUtcDay(allowance.now);
    const first = await tx.sitePage.updateMany({ where: { AND: [where, notCountedSince(today)] }, data: { ...data, editCountedOn: today } });
    if (first.count) {
      await bumpUsage(allowance.userId, "edits", 1, allowance.now, tx);
      return { count: first.count, counted: true };
    }
  }
  const again = await tx.sitePage.updateMany({ where, data });
  return { count: again.count, counted: false };
}

/**
 * Spends a page's edit for today without writing the page, for a change whose
 * words are stored elsewhere — a shared element, typed on this page. The same
 * condition as `writePageEdit`, so it counts once a page a day however the
 * page was changed; run it in the transaction that makes the change.
 */
export async function countPageEdit(tx: Prisma.TransactionClient, allowance: EditAllowance, pageId: string): Promise<boolean> {
  const today = startOfUtcDay(allowance.now);
  const marked = await tx.sitePage.updateMany({ where: { AND: [{ id: pageId }, notCountedSince(today)] }, data: { editCountedOn: today } });
  if (!marked.count) return false;
  await bumpUsage(allowance.userId, "edits", 1, allowance.now, tx);
  return true;
}

/**
 * Enforces feature availability & AI usage quota for the user's tier plan.
 */
export async function assertTierFeatureAccess(
  req: WebsiteActor,
  feature: keyof TierFeatureFlags,
  siteId?: string,
  options: { skipUsageLimit?: boolean } = {},
): Promise<void> {
  const status = await computeUserStorageAndUsage(req, siteId);
  const { plan, features, usage } = status;

  const featureLabels: Record<keyof TierFeatureFlags, { name: string; minPlan: string }> = {
    visualEditor: { name: "Visual Editor", minPlan: tierLabels("EDITOR", status.pricing.currency).upgrade },
    mediaLibrary: { name: "Media Library", minPlan: tierLabels("EDITOR", status.pricing.currency).upgrade },
    themeSettings: { name: "Global Theme Settings", minPlan: tierLabels("CARE", status.pricing.currency).upgrade },
    seoInspector: { name: "SEO Inspector & Auditor", minPlan: tierLabels("CARE", status.pricing.currency).upgrade },
    aiAssistant: { name: "AI Copy & Layout Assistant", minPlan: tierLabels("CARE", status.pricing.currency).upgrade },
    aiBuilderAgent: { name: "Autonomous AI Builder Agent", minPlan: tierLabels("MANAGED", status.pricing.currency).upgrade },
    sourceCodeEditor: { name: "Raw Source Code Editor", minPlan: tierLabels("MANAGED", status.pricing.currency).upgrade },
    pullRequestPublish: { name: "GitHub Pull Request Workflow", minPlan: tierLabels("MANAGED", status.pricing.currency).upgrade },
    brandPresets: { name: "Brand Style Presets", minPlan: tierLabels("CARE", status.pricing.currency).upgrade },
  };

  if (!features[feature]) {
    const info = featureLabels[feature];
    throw new WebsiteError(
      403,
      `${info.name} is not available on the ${planLabel(status)} plan. Upgrade to ${info.minPlan} to unlock this feature.`,
    );
  }

  if (!options.skipUsageLimit && feature === "aiAssistant" && usage.aiPromptsUsed >= plan.aiPromptsLimit) {
    throw new WebsiteError(
      403,
      `Monthly AI Assistant prompt limit reached (${usage.aiPromptsUsed}/${plan.aiPromptsLimit}) on ${yourPlan(status)}.${upgradeSentence(plan.tier, status.pricing.currency, (next) => next.aiPromptsLimitLabel)}`,
    );
  }
}

/** Spends an AI prompt, against the same account `assertTierFeatureAccess` checked with this `siteId`. */
export async function recordAiPromptUsed(req: WebsiteActor, siteId?: string | null): Promise<void> {
  const identity = await resolveSiteEntitlement(req, siteId);
  await bumpUsage(identity.chargedUserId, "aiPrompts");
}

/**
 * The website a request is about, from its path — the same three shapes the
 * access gate reads: `/sites/:id`, `/pages/:id` and `/shared/:id`. Null for a
 * route about the account rather than one website. An id that does not decode
 * is the gate's 404, never a URIError.
 */
export async function websiteRequestSiteId(path: string): Promise<string | null> {
  const site = /^\/sites\/([^/]+)(?:\/|$)/.exec(path);
  if (site) return websitePathId(site[1]!);
  const page = /^\/pages\/([^/]+)(?:\/|$)/.exec(path);
  if (page) return (await prisma.sitePage.findUnique({ where: { id: websitePathId(page[1]!) }, select: { siteId: true } }))?.siteId ?? null;
  const shared = /^\/shared\/([^/]+)(?:\/|$)/.exec(path);
  if (shared) return (await prisma.sharedElement.findUnique({ where: { id: websitePathId(shared[1]!) }, select: { siteId: true } }))?.siteId ?? null;
  return null;
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
export type CaptureResultItem = {
  url: string;
  status: "captured" | "failed" | "skipped";
  reason?: string;
  repoPath?: string;
  bytes?: number;
};

export async function captureHtmlImagesIntoMediaLibrary(
  req: WebsiteActor,
  siteId: string,
  html: string,
): Promise<{
  html: string;
  capturedCount: number;
  totalBytesAdded: number;
  skippedCount: number;
  details: CaptureResultItem[];
}> {
  const status = await computeUserStorageAndUsage(req, siteId);
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { publicUrl: true } });
  let remainingQuota = status.storage.remainingBytes;
  let capturedCount = 0;
  let totalBytesAdded = 0;
  let skippedCount = 0;
  let updatedHtml = html;
  const details: CaptureResultItem[] = [];

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
    if (capturedCount >= 50 || remainingQuota <= 0) {
      skippedCount += 1;
      details.push({
        url: rawUrl,
        status: "skipped",
        reason: capturedCount >= 50 ? "Per-import limit of 50 images reached" : "Media library storage quota reached",
      });
      continue;
    }
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
      details.push({
        url: rawUrl,
        status: "captured",
        repoPath,
        bytes: optimized.content.length,
      });
    } catch (err) {
      skippedCount += 1;
      details.push({
        url: rawUrl,
        status: "failed",
        reason: err instanceof Error ? err.message : "Failed to capture image",
      });
    }
  }

  return { html: updatedHtml, capturedCount, totalBytesAdded, skippedCount, details };
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

      // In the currency this customer pays in, like their own plan above.
      const currency = status.user.currency === "USD" ? "USD" : "GHS";
      const availableTiers = Object.values(WEBSITE_TIER_PLANS).map((p) => ({
        planCode: p.tier,
        tierName: p.name,
        tierBadge: tierLabels(p.tier, currency).badge,
        priceDisplay: tierLabels(p.tier, currency).priceDisplay,
        promoDisplay: tierLabels(p.tier, currency).promoDisplay,
        standardDisplay: tierLabels(p.tier, currency).standardDisplay,
        promoMonthlyPrice: priceFor(p.tier, currency).promoMonthlyPrice,
        standardMonthlyPrice: priceFor(p.tier, currency).standardMonthlyPrice,
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
