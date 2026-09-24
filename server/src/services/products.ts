import type { Prisma, Product } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { WEBSITE_TIER_PLANS, ensureWebsiteTierUsersAndPlans } from "./websiteTierPlans.js";

/**
 * What Dakyworld sells that is not capacity, and who has to pay for it.
 *
 * Three Website Builder Tiers:
 * - Starter (`website-builder` / `EDITOR`):   $3/mo for first 3 months, then $5/mo standard  -> "$3 ($5)"
 * - Pro (`website-care` / `CARE`):            $10/mo for first 3 months, then $16/mo standard -> "$10 ($16)"
 * - Business (`managed-website` / `MANAGED`): $25/mo for first 3 months, then $45/mo standard -> "$25 ($45)"
 */

export const SHIPPED_PRODUCTS: Array<
  Pick<Product, "key" | "name" | "tagline" | "publicPath" | "sortOrder"> & {
    monthlyPrice: string;
    standardMonthlyPrice: string;
    promoMonths: number;
    priceDisplay: string;
    currency: string;
    setupPrice: string | null;
  }
> = [
  {
    key: "website-builder",
    name: "Starter (Editor)",
    tagline: "Self-service website editing, 50 MB media storage, 3 HTML imports/mo & 30 edits/mo. GHS 300/mo for first 3 months, then reverts to GHS 500/mo standard.",
    monthlyPrice: "300.00",
    standardMonthlyPrice: "500.00",
    promoMonths: 3,
    priceDisplay: "GHS 300 (GHS 500)",
    currency: "GHS",
    setupPrice: null,
    publicPath: "/website-builder",
    sortOrder: 1,
  },
  {
    key: "website-care",
    name: "Pro (Website Care)",
    tagline: "Global Theme system, SEO Inspector, AI Assistant, 500 MB media storage, 15 imports/mo & 200 edits/mo. GHS 900/mo for first 3 months, then reverts to GHS 1,500/mo standard.",
    monthlyPrice: "900.00",
    standardMonthlyPrice: "1500.00",
    promoMonths: 3,
    priceDisplay: "GHS 900 (GHS 1,500)",
    currency: "GHS",
    setupPrice: null,
    publicPath: "/website-builder",
    sortOrder: 2,
  },
  {
    key: "managed-website",
    name: "Business (Managed Website)",
    tagline: "5 GB media storage, unlimited imports & edits, Autonomous AI Builder Agent, Source Code Editor & priority technical oversight. GHS 2,400/mo for first 3 months, then reverts to GHS 4,000/mo standard.",
    monthlyPrice: "2400.00",
    standardMonthlyPrice: "4000.00",
    promoMonths: 3,
    priceDisplay: "GHS 2,400 (GHS 4,000)",
    currency: "GHS",
    setupPrice: null,
    publicPath: "/website-builder",
    sortOrder: 3,
  },
];

/**
 * Creates the catalogue on boot and ensures the 3 tier plans ($3/$5, $10/$16, $25/$45)
 * and 3 subscribed test users exist in the database.
 */
export async function ensureProducts(): Promise<void> {
  for (const seed of SHIPPED_PRODUCTS) {
    await prisma.product.upsert({
      where: { key: seed.key },
      update: {
        name: seed.name,
        tagline: seed.tagline,
        publicPath: seed.publicPath,
        sortOrder: seed.sortOrder,
        monthlyPrice: seed.monthlyPrice,
        setupPrice: seed.setupPrice,
        currency: seed.currency,
      },
      create: {
        key: seed.key,
        name: seed.name,
        tagline: seed.tagline,
        publicPath: seed.publicPath,
        sortOrder: seed.sortOrder,
        monthlyPrice: seed.monthlyPrice,
        setupPrice: seed.setupPrice,
        currency: seed.currency,
      },
    });
  }
  await ensureWebsiteTierUsersAndPlans();
}

export type ProductAccess = {
  /** True when nothing is owed for it. */
  included: boolean;
  /** Why, in the words a person would use. */
  reason: string;
  /** The retainer that covers it, when one does. */
  plan: { id: string; tier: string; monthlyFee: string; currency: string } | null;
  /** What would be charged if it is not included. */
  price: { monthly: string; setup: string | null; currency: string } | null;
};

export function decideAccess(input: {
  clientId: string | null | undefined;
  productName: string | null;
  price: { monthly: string; setup: string | null; currency: string } | null;
  plan: { id: string; tier: string; monthlyFee: string; currency: string } | null;
}): ProductAccess {
  if (!input.clientId) {
    return {
      included: false,
      reason: "This website is not linked to a client, so nothing decides whether a retainer covers it. Set the client on the site's settings.",
      plan: null,
      price: input.price,
    };
  }

  if (input.plan) {
    return {
      included: true,
      reason: `Included with their ${tierName(input.plan.tier)} retainer.`,
      plan: input.plan,
      price: input.price,
    };
  }

  return {
    included: false,
    reason:
      input.price && input.productName
        ? `No active retainer, so ${input.productName} is charged at ${input.price.currency} ${money(input.price.monthly)} per month.`
        : "No active retainer, and this product has no price set.",
    plan: null,
    price: input.price,
  };
}

/** The same question, against the database. */
export async function productAccess(clientId: string | null | undefined, productKey: string): Promise<ProductAccess> {
  const product = await prisma.product.findUnique({ where: { key: productKey } });
  const price = product
    ? { monthly: product.monthlyPrice.toFixed(2), setup: product.setupPrice ? product.setupPrice.toFixed(2) : null, currency: product.currency }
    : null;

  const plan = clientId
    ? await prisma.carePlan.findFirst({
        where: { clientId, status: "ACTIVE" },
        orderBy: { monthlyFee: "desc" },
        select: { id: true, tier: true, monthlyFee: true, currency: true },
      })
    : null;

  return decideAccess({
    clientId,
    productName: product?.name ?? null,
    price,
    plan: plan ? { id: plan.id, tier: plan.tier, monthlyFee: plan.monthlyFee.toFixed(2), currency: plan.currency } : null,
  });
}

export const tierName = (tier: string) =>
  ({ FOUNDATION: "Foundation", GROWTH: "Growth", TRANSFORMATION: "Transformation" })[tier] ?? tier.toLowerCase();

/** `750.00` → `750`, `1250.50` → `1,250.50`. What a price block prints. */
export function money(amount: string | number): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(value)) return String(amount);
  return value.toLocaleString("en-GB", { minimumFractionDigits: value % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
}

const TIER_BY_KEY: Record<string, keyof typeof WEBSITE_TIER_PLANS> = {
  "website-builder": "EDITOR",
  "website-care": "CARE",
  "managed-website": "MANAGED",
};

/** The public catalogue, exactly as the website renders it. */
export async function publicCatalogue() {
  const products = await prisma.product.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
  return {
    includedWithRetainer: "Included at no extra cost with every Dakyworld retainer. 3-month promotional pricing reverts to standard price after month 3.",
    products: products.map((product) => {
      const tierDef = WEBSITE_TIER_PLANS[TIER_BY_KEY[product.key] ?? "EDITOR"];
      return {
        key: product.key,
        name: product.name,
        tagline: product.tagline,
        currency: product.currency,
        monthly: product.monthlyPrice.toFixed(2),
        monthlyDisplay: money(product.monthlyPrice.toFixed(2)),
        standardMonthly: tierDef.standardMonthlyPrice.toFixed(2),
        standardMonthlyDisplay: money(tierDef.standardMonthlyPrice.toFixed(2)),
        priceDisplay: tierDef.priceDisplay,
        promoMonths: tierDef.promoMonths,
        storageQuotaLabel: tierDef.storageQuotaLabel,
        importsLimitLabel: tierDef.importsLimitLabel,
        editsLimitLabel: tierDef.editsLimitLabel,
        features: tierDef.features,
        featureHighlights: tierDef.featureHighlights,
        restrictedFeatures: tierDef.restrictedFeatures,
        setup: product.setupPrice ? product.setupPrice.toFixed(2) : null,
        setupDisplay: product.setupPrice ? money(product.setupPrice.toFixed(2)) : null,
        path: product.publicPath,
        updatedAt: product.updatedAt,
      };
    }),
  };
}

export async function listProducts() {
  return prisma.product.findMany({ orderBy: { sortOrder: "asc" }, include: { updatedBy: { select: { id: true, name: true } } } });
}

export async function updateProduct(
  key: string,
  data: Prisma.ProductUpdateInput,
): Promise<Product> {
  return prisma.product.update({ where: { key }, data });
}
