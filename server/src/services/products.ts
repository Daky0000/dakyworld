import type { Prisma, Product } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { WEBSITE_TIER_PLANS, ensureWebsiteTierUsersAndPlans, tierLabels } from "./websiteTierPlans.js";
import { usdToGhsRate } from "./paymentQuote.js";

/**
 * What Dakyworld sells that is not capacity, and who has to pay for it.
 *
 * Prices on a `Product` row are authored in USD and charged in cedis at
 * `PAYSTACK_USD_GHS_RATE`. Anything shown to a customer is the cedi figure,
 * because cedis are what leaves their account — see `publicCatalogue` below.
 */

export const SHIPPED_PRODUCTS: Array<
  Pick<Product, "key" | "name" | "tagline" | "publicPath" | "sortOrder"> & {
    monthlyPrice: string;
    standardMonthlyPrice: string;
    promoMonths: number;
    currency: string;
    setupPrice: string | null;
  }
> = [
  {
    key: "website-builder",
    name: "Starter (Editor)",
    tagline: "Self-service website editing, 50 MB media storage, 3 HTML imports and 30 edits a month.",
    monthlyPrice: "25.00",
    standardMonthlyPrice: "40.00",
    promoMonths: 3,
    currency: "USD",
    setupPrice: null,
    publicPath: "/website-builder",
    sortOrder: 1,
  },
  {
    key: "website-care",
    name: "Pro (Website Care)",
    tagline: "Global theme system, SEO inspector, AI assistant, 500 MB media storage, 15 imports and 200 edits a month.",
    monthlyPrice: "75.00",
    standardMonthlyPrice: "120.00",
    promoMonths: 3,
    currency: "USD",
    setupPrice: null,
    publicPath: "/website-builder",
    sortOrder: 2,
  },
  {
    key: "managed-website",
    name: "Business (Managed Website)",
    tagline: "5 GB media storage, unlimited imports and edits, Autonomous AI Builder Agent, source code editor and priority technical oversight.",
    monthlyPrice: "195.00",
    standardMonthlyPrice: "320.00",
    promoMonths: 3,
    currency: "USD",
    setupPrice: null,
    publicPath: "/website-builder",
    sortOrder: 3,
  },
];

/** Creates the catalogue on boot, and the tier plans and test users with it. */
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

/**
 * The public catalogue, exactly as the website renders it.
 *
 * **Every figure here is in cedis**, because cedis are what a customer is
 * charged. The `Product` row holds dollars — that is where a price is authored
 * and edited — and this converts at the same rate `paymentQuote.ts` charges at,
 * using the same arithmetic, so the number on the pricing page and the number
 * on the card cannot disagree.
 *
 * It published the authored dollars for a while, alongside `currency: "USD"`,
 * and `assets/pricing.js` renders `currency + " " + amount` — so a page whose
 * markup reads "GHS 300" replaced it with "USD 25" as soon as the catalogue
 * loaded. The same plan, quoted at an eighth of its price in the wrong money.
 */
export async function publicCatalogue() {
  const products = await prisma.product.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
  const rate = usdToGhsRate();
  return {
    includedWithRetainer: "Included at no extra cost with every Dakyworld retainer. 3-month promotional pricing reverts to standard price after month 3.",
    products: products.map((product) => {
      const tierDef = WEBSITE_TIER_PLANS[TIER_BY_KEY[product.key] ?? "EDITOR"];
      // The same two lines as `websitePaymentQuote`: a USD product price is
      // multiplied by the rate, a GHS one is already what it will be charged.
      const multiplier = product.currency === "USD" ? rate : 1;
      const chargedMonthly = Math.round(Number(product.monthlyPrice) * multiplier);
      const chargedStandard = Math.round(tierDef.standardMonthlyPrice * rate);
      const chargedSetup = product.setupPrice ? Math.round(Number(product.setupPrice) * multiplier) : null;
      return {
        key: product.key,
        name: product.name,
        tagline: product.tagline,
        currency: "GHS",
        monthly: chargedMonthly.toFixed(2),
        monthlyDisplay: money(chargedMonthly),
        standardMonthly: chargedStandard.toFixed(2),
        standardMonthlyDisplay: money(chargedStandard),
        priceDisplay: tierLabels(tierDef.tier).priceDisplay,
        promoMonths: tierDef.promoMonths,
        storageQuotaLabel: tierDef.storageQuotaLabel,
        importsLimitLabel: tierDef.importsLimitLabel,
        editsLimitLabel: tierDef.editsLimitLabel,
        features: tierDef.features,
        featureHighlights: tierDef.featureHighlights,
        restrictedFeatures: tierDef.restrictedFeatures,
        setup: chargedSetup === null ? null : chargedSetup.toFixed(2),
        setupDisplay: chargedSetup === null ? null : money(chargedSetup),
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
