import type { Prisma, Product } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { WEBSITE_TIER_PLANS, ensureWebsiteTierUsersAndPlans, tierLabels } from "./websiteTierPlans.js";
import { PLAN_CURRENCIES, USD_PRICES, enabledPlanCurrencies, priceFor, type PlanCurrency } from "./websitePricing.js";

/**
 * What Dakyworld sells that is not capacity, and who has to pay for it.
 *
 * The three Website Builder tiers take their prices from `USD_PRICES` in
 * websitePricing.ts and nowhere else — a `Product` row is seeded from it, so
 * the catalogue, the quote and the tier panel cannot hold three different
 * numbers for one plan, which they have twice before.
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
    monthlyPrice: USD_PRICES.EDITOR.promo.toFixed(2),
    standardMonthlyPrice: USD_PRICES.EDITOR.standard.toFixed(2),
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
    monthlyPrice: USD_PRICES.CARE.promo.toFixed(2),
    standardMonthlyPrice: USD_PRICES.CARE.standard.toFixed(2),
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
    monthlyPrice: USD_PRICES.MANAGED.promo.toFixed(2),
    standardMonthlyPrice: USD_PRICES.MANAGED.standard.toFixed(2),
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
 * Every product carries **both currencies**, because the page decides which to
 * show: Ghana is quoted cedis, everywhere else dollars, and a visitor can
 * switch. Only currencies the processor can actually settle are published, so
 * the page can never offer one the checkout would refuse.
 *
 * The single-currency fields below it are what this endpoint has always
 * published and are kept so an older cached page keeps working. They are cedis,
 * which is what Ghana pays and what the markup on the pricing page says.
 *
 * Two failures worth not repeating. It published the authored dollars beside
 * `currency: "USD"`, and `assets/pricing.js` prints `currency + " " + amount` —
 * so a page whose markup read "GHS 300" replaced it with "USD 25" on load. And
 * before that it published a dollar standard price beside a cedi promotional
 * one, which reads as a plan that gets cheaper after three months.
 */
export async function publicCatalogue() {
  const products = await prisma.product.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
  const enabled = enabledPlanCurrencies();
  return {
    includedWithRetainer: "Included at no extra cost with every Dakyworld retainer. 3-month promotional pricing reverts to standard price after month 3.",
    /** What the page may offer. One entry means no currency switch is shown. */
    currencies: enabled,
    /** Ghana is the home market, so cedis are what a page shows before it knows better. */
    defaultCurrency: "GHS" as PlanCurrency,
    products: products.map((product) => {
      const tierDef = WEBSITE_TIER_PLANS[TIER_BY_KEY[product.key] ?? "EDITOR"];
      const prices = Object.fromEntries(
        enabled.map((code) => {
          const price = priceFor(tierDef.tier, code);
          return [code, {
            currency: code,
            promoMonthly: price.promoMonthlyPrice.toFixed(2),
            promoDisplay: money(price.promoMonthlyPrice),
            promoLabel: price.promoDisplay,
            standardMonthly: price.standardMonthlyPrice.toFixed(2),
            standardDisplay: money(price.standardMonthlyPrice),
            standardLabel: price.standardDisplay,
            display: price.display,
          }];
        }),
      ) as Record<PlanCurrency, {
        currency: PlanCurrency; promoMonthly: string; promoDisplay: string; promoLabel: string;
        standardMonthly: string; standardDisplay: string; standardLabel: string; display: string;
      }>;
      const home = priceFor(tierDef.tier, "GHS");
      return {
        key: product.key,
        name: product.name,
        tagline: product.tagline,
        prices,
        currency: "GHS",
        monthly: home.promoMonthlyPrice.toFixed(2),
        monthlyDisplay: money(home.promoMonthlyPrice),
        standardMonthly: home.standardMonthlyPrice.toFixed(2),
        standardMonthlyDisplay: money(home.standardMonthlyPrice),
        priceDisplay: home.display,
        promoMonths: tierDef.promoMonths,
        storageQuotaLabel: tierDef.storageQuotaLabel,
        importsLimitLabel: tierDef.importsLimitLabel,
        editsLimitLabel: tierDef.editsLimitLabel,
        features: tierDef.features,
        featureHighlights: tierDef.featureHighlights,
        restrictedFeatures: tierDef.restrictedFeatures,
        setup: null,
        setupDisplay: null,
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
