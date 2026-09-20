import type { Prisma, Product } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * What Dakyworld sells that is not capacity, and who has to pay for it.
 *
 * The company's ordinary work is a retainer: a defined monthly capacity, sold by
 * the month. A product is the other shape — built once, used by many — and the
 * Website Builder is the first.
 *
 * **The rule, in one line: a client on an active retainer gets every product at
 * no charge.** Everyone else pays the product's own price.
 *
 * That is deliberately not a discount applied when an invoice is raised. It is
 * what the retainer includes, so it has to be answerable *before* anybody is
 * charged — on the site's screens, during onboarding, and on the public pricing
 * block. `productAccess()` is the only place that decides it, so those three
 * cannot drift apart and tell a client different things.
 *
 * Prices live in the database rather than in the website's markup, and the site
 * reads them from `/api/public/products`. Changing a price in the OS changes the
 * public page on its next load — no deploy, and no number retyped in two places.
 * The reverse arrangement, where the site owns the price and the OS syncs it, is
 * what care plans do (see `carePlanCatalogue.ts`) and is right for those: a
 * retainer's price is a published offer with a page of conditions around it. A
 * product's price is a single number on a card.
 */

/** What ships if nobody has priced anything yet. Seeded, then owned by the OS. */
export const SHIPPED_PRODUCTS: Array<Pick<Product, "key" | "name" | "tagline" | "publicPath" | "sortOrder"> & { monthlyPrice: string; setupPrice: string | null }> = [
  {
    key: "website-builder",
    name: "Editor",
    tagline: "Self-service website editing for one website and up to two users.",
    monthlyPrice: "450.00",
    setupPrice: "1500.00",
    publicPath: "/website-builder",
    sortOrder: 1,
  },
  {
    key: "website-care",
    name: "Website Care",
    tagline: "Editing, monitoring and 60 minutes of technical assistance each month.",
    monthlyPrice: "900.00",
    setupPrice: "1500.00",
    publicPath: "/website-builder",
    sortOrder: 2,
  },
  {
    key: "managed-website",
    name: "Managed Website",
    tagline: "Higher-touch ownership with up to four hours of technical work each month.",
    monthlyPrice: "3000.00",
    setupPrice: null,
    publicPath: "/website-builder",
    sortOrder: 3,
  },
];

/**
 * Creates the catalogue on first boot and never overwrites a price afterwards.
 *
 * The same discipline as the system roles in `lib/accessRoles.ts`, and for the
 * same reason: a seeder that reinstated the shipped number on every deploy would
 * quietly undo a commercial decision somebody made on a Tuesday.
 */
export async function ensureProducts(): Promise<void> {
  for (const seed of SHIPPED_PRODUCTS) {
    await prisma.product.upsert({
      where: { key: seed.key },
      // Note the absence of prices. See above.
      update: { name: seed.name, publicPath: seed.publicPath, sortOrder: seed.sortOrder },
      create: {
        key: seed.key,
        name: seed.name,
        tagline: seed.tagline,
        publicPath: seed.publicPath,
        sortOrder: seed.sortOrder,
        monthlyPrice: seed.monthlyPrice,
        setupPrice: seed.setupPrice,
      },
    });
  }
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

/**
 * The rule itself, with nothing around it.
 *
 * Separated from the query because this is the sentence the company is selling
 * — "on a retainer, the products are yours" — and a rule that can only be
 * exercised through a database is a rule nobody checks. `checks/products.ts`
 * holds it to this.
 *
 * A paused retainer does not count. Pausing is what a client does when they are
 * not paying this month, and a product that stayed free through it would be a
 * reason not to resume.
 */
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
    reason: input.price && input.productName
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

  // Only an ACTIVE plan. A paused or churned one covers nothing.
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

/** The public catalogue, exactly as the website renders it. */
export async function publicCatalogue() {
  const products = await prisma.product.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
  return {
    /** Said once, here, so the website never hard-codes the rule. */
    includedWithRetainer: "Included at no extra cost with every Dakyworld retainer.",
    products: products.map((product) => ({
      key: product.key,
      name: product.name,
      tagline: product.tagline,
      currency: product.currency,
      monthly: product.monthlyPrice.toFixed(2),
      monthlyDisplay: money(product.monthlyPrice.toFixed(2)),
      setup: product.setupPrice ? product.setupPrice.toFixed(2) : null,
      setupDisplay: product.setupPrice ? money(product.setupPrice.toFixed(2)) : null,
      path: product.publicPath,
      updatedAt: product.updatedAt,
    })),
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
