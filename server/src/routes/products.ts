import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requirePermission } from "../middleware/auth.js";
import { listProducts, publicCatalogue, updateProduct } from "../services/products.js";
import { createManagedBooking, inspectPublicWebsite, listWebsiteCommerce, startWebsitePurchase, updateBooking, updatePurchaseStatus } from "../services/websiteCommerce.js";
import { WEBSITE_TIER_PLANS, SUBSCRIBED_TEST_USERS, tierLabels } from "../services/websiteTierPlans.js";
import { rateLimit } from "../middleware/security.js";
import { websitePaymentQuote } from "../services/paymentQuote.js";
import { subscriptionManagementLink } from "../lib/paystack.js";
import { reconcilePurchaseSubscription } from "../services/paystackEvents.js";
import { countryForIp } from "../lib/geoCountry.js";
import { resolveCurrency } from "../services/websitePricing.js";

/**
 * The product catalogue: one door for the public website, one for the office.
 */

export const publicProductsRouter = Router();

publicProductsRouter.get("/products", async (req, res, next) => {
  try {
    const catalogue = await publicCatalogue();
    // The page quotes whatever this says, with no switch of its own: Ghana in
    // cedis, everywhere else in dollars, and cedis whenever dollars cannot be
    // charged. The answer now depends on who is asking, so no shared cache may
    // keep one visitor's currency for the next.
    catalogue.defaultCurrency = resolveCurrency({ country: countryHint(req) });
    res
      .set("Cache-Control", "private, max-age=120")
      .set("Access-Control-Allow-Origin", "*")
      .set("Vary", "Origin")
      .json(catalogue);
  } catch (err) {
    next(err);
  }
});

publicProductsRouter.options("/products", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*").set("Access-Control-Allow-Methods", "GET, OPTIONS").status(204).end();
});

export const purchaseInput = z.object({
  productKey: z.enum(["website-builder", "website-care", "managed-website"]),
  billingCycle: z.enum(["monthly", "annual"]).optional().default("monthly"),
  recurringConsent: z.literal(true),
  quoteId: z.string().regex(/^[a-f0-9]{64}$/),
  checkoutKey: z.string().uuid(),
  businessName: z.string().trim().min(2).max(160),
  contactName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).optional(),
  websiteUrl: z.string().trim().url().max(500),
  notes: z.string().trim().max(2000).optional(),
  /**
   * What the customer was quoted in, and where they are.
   *
   * These were absent, and a zod object drops what it does not name — so the
   * checkout could not have sent them even had the form collected them, and
   * every purchase anywhere in the world resolved to cedis.
   */
  currency: z.enum(["GHS", "USD"]).optional(),
  country: z.string().trim().max(60).optional(),
});

/**
 * Where the request appears to come from, when the form did not say.
 *
 * Cloudflare and Vercel both put a two-letter country on a request. This API
 * is behind neither, so when no header arrives the caller's address is looked
 * up in the country database this server carries (see lib/geoCountry.ts). It
 * is a hint: an explicit currency sent by the checkout always wins, and
 * `resolveCurrency` applies that precedence. Somebody behind a VPN gets the
 * wrong default, which is the right failure for a price display.
 */
export function countryHint(req: { headers: Record<string, unknown>; ip?: string }): string | null {
  for (const header of ["cf-ipcountry", "x-vercel-ip-country", "x-country-code"]) {
    const value = req.headers[header];
    if (typeof value !== "string") continue;
    const code = value.trim().toUpperCase();
    // `XX` is Cloudflare saying it does not know and `T1` is Tor. Both are
    // worse than no answer: read as "not Ghana" they would quote dollars,
    // where not knowing should fall through to the default.
    if (/^[A-Z]{2}$/.test(code) && code !== "XX") return code;
  }
  return countryForIp(req.ip);
}

const websiteCheckInput = z.object({
  websiteUrl: z.string().trim().min(3).max(500),
});

const bookingInput = z.object({
  businessName: z.string().trim().min(2).max(160), contactName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200), phone: z.string().trim().min(7).max(40), websiteUrl: z.string().trim().url().max(500),
  reason: z.string().trim().min(2).max(500), goals: z.string().trim().min(10).max(3000), notes: z.string().trim().max(2000).optional(),
  requestedAt: z.coerce.date().refine(value => value.getTime() > Date.now(), "Choose a future consultation time."),
});
const commerceRateLimit = rateLimit({ windowMs: 60 * 60_000, max: 10, message: "Too many purchase or booking attempts. Try again in {minutes}." });
const websiteCheckRateLimit = rateLimit({ windowMs: 15 * 60_000, max: 25, message: "Too many website scan requests. Try again in {minutes}." });
const paymentStatusRateLimit = rateLimit({ windowMs: 60_000, max: 30, message: "Too many payment checks. Try again in {minutes}." });

publicProductsRouter.get("/website-payment-quote", paymentStatusRateLimit, async (req, res, next) => {
  try {
    publicCors(req, res); res.set("Cache-Control", "no-store");
    const input = z.object({
      productKey: z.enum(["website-builder", "website-care", "managed-website"]),
      billingCycle: z.enum(["monthly", "annual"]),
      currency: z.enum(["GHS", "USD"]).optional(),
      country: z.string().trim().max(60).optional(),
    }).parse(req.query);
    res.json(await websitePaymentQuote(input.productKey, input.billingCycle, {
      currency: input.currency,
      country: input.country ?? countryHint(req),
    }));
  } catch (error) { next(error); }
});

publicProductsRouter.post("/website-payment-status", paymentStatusRateLimit, async (req, res, next) => {
  try {
    publicCors(req, res); res.set("Cache-Control", "no-store");
    const { checkoutKey } = z.object({ checkoutKey: z.string().uuid() }).parse(req.body);
    const purchase = await prisma.websitePurchase.findUnique({ where: { checkoutKey }, select: { setupPaidAt: true, status: true, billingState: true } });
    if (!purchase) return res.status(404).json({ error: "Checkout not found." });
    res.json({ paid: Boolean(purchase.setupPaidAt), status: purchase.status, billingState: purchase.billingState });
  } catch (error) { next(error); }
});

function publicCors(req: { headers: { origin?: string } }, res: { set: (field: string, value: string) => unknown }) {
  const origin = req.headers.origin;
  if (origin && ["https://dakyworld.com", "https://www.dakyworld.com", "http://localhost:5173"].includes(origin)) res.set("Access-Control-Allow-Origin", origin);
  else res.set("Access-Control-Allow-Origin", "*");
  res.set("Vary", "Origin");
}

publicProductsRouter.post("/website-check", websiteCheckRateLimit, async (req, res, next) => {
  try {
    publicCors(req, res);
    const { websiteUrl } = websiteCheckInput.parse(req.body ?? {});
    const inspection = await inspectPublicWebsite(websiteUrl);
    res.json(inspection);
  } catch (err) {
    next(err);
  }
});

publicProductsRouter.post("/website-purchases", commerceRateLimit, async (req, res, next) => {
  try {
    publicCors(req, res);
    const input = purchaseInput.parse(req.body);
    // The form's answer first, then the network's. `resolveCurrency` decides
    // between them; this only makes sure it has both to decide from.
    res.status(201).json(await startWebsitePurchase({ ...input, country: input.country ?? countryHint(req) }));
  } catch (err) { next(err); }
});

publicProductsRouter.post("/managed-bookings", commerceRateLimit, async (req, res, next) => {
  try { publicCors(req, res); const booking = await createManagedBooking(bookingInput.parse(req.body)); res.status(201).json({ id: booking.id, status: booking.status, requestedAt: booking.requestedAt }); }
  catch (err) { next(err); }
});

publicProductsRouter.options(["/website-check", "/website-purchases", "/website-payment-status", "/managed-bookings"], (req, res) => {
  publicCors(req, res); res.set("Access-Control-Allow-Methods", "POST, OPTIONS").set("Access-Control-Allow-Headers", "Content-Type").status(204).end();
});

export const productsRouter = Router();

const TIER_MAP: Record<string, "EDITOR" | "CARE" | "MANAGED"> = {
  "website-builder": "EDITOR",
  "website-care": "CARE",
  "managed-website": "MANAGED",
};

productsRouter.get("/", requirePermission("website.view"), async (_req, res, next) => {
  try {
    const products = await listProducts();
    res.json({
      products: products.map((product) => {
        const tierKey = TIER_MAP[product.key] ?? "EDITOR";
        const tierDef = WEBSITE_TIER_PLANS[tierKey];
        return {
          key: product.key,
          name: product.name,
          tagline: product.tagline,
          currency: product.currency,
          monthlyPrice: product.monthlyPrice.toFixed(2),
          standardMonthlyPrice: tierDef.standardMonthlyPrice.toFixed(2),
          priceDisplay: tierLabels(tierDef.tier).priceDisplay,
          promoMonths: tierDef.promoMonths,
          storageQuotaLabel: tierDef.storageQuotaLabel,
          maxUploadLabel: tierDef.maxUploadLabel,
          importsLimitLabel: tierDef.importsLimitLabel,
          editsLimitLabel: tierDef.editsLimitLabel,
          aiPromptsLimitLabel: tierDef.aiPromptsLimitLabel,
          featureHighlights: tierDef.featureHighlights,
          restrictedFeatures: tierDef.restrictedFeatures,
          setupPrice: product.setupPrice ? product.setupPrice.toFixed(2) : null,
          publicPath: product.publicPath,
          active: product.active,
          updatedAt: product.updatedAt,
          updatedBy: product.updatedBy,
        };
      }),
      testUsers: SUBSCRIBED_TEST_USERS,
      /** Said here so the screen states the rule rather than inventing wording. */
      includedWithRetainer: `Every client on an active retainer gets all products at no charge. Promotional pricing runs for the first 3 months and then reverts to the standard rate: ${["EDITOR", "CARE", "MANAGED"].map((tier) => `${tierLabels(tier as "EDITOR").name} ${tierLabels(tier as "EDITOR").priceDisplay}`).join(", ")}.`,
    });
  } catch (err) {
    next(err);
  }
});

productsRouter.get("/website-commerce", requirePermission("website.manage"), async (_req, res, next) => {
  try { res.json(await listWebsiteCommerce()); } catch (err) { next(err); }
});

productsRouter.post("/website-commerce/purchases/:id/manage-billing", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const purchase = await prisma.websitePurchase.findUnique({ where: { id: req.params.id } });
    if (!purchase?.providerSubscriptionCode) return res.status(409).json({ error: "No subscription is available to manage." });
    res.set("Cache-Control", "no-store").json({ url: await subscriptionManagementLink(purchase.providerSubscriptionCode) });
  } catch (error) { next(error); }
});

productsRouter.post("/website-commerce/purchases/:id/reconcile-billing", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const { subscriptionCode } = z.object({ subscriptionCode: z.string().regex(/^SUB_[a-zA-Z0-9]+$/) }).parse(req.body);
    await reconcilePurchaseSubscription(req.params.id, subscriptionCode);
    res.json({ reconciled: true });
  } catch (error) { next(error); }
});

productsRouter.patch("/website-commerce/purchases/:id", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(["PAYMENT_PENDING", "SETUP_PAID", "SETUP_IN_PROGRESS", "READY", "ACTIVE", "FAILED", "CANCELLED"]) }).parse(req.body);
    res.json(await updatePurchaseStatus(req.params.id, status));
  } catch (err) { next(err); }
});

productsRouter.patch("/website-commerce/bookings/:id", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const body = z.object({ status: z.enum(["REQUESTED", "CONFIRMED", "COMPLETED", "CANCELLED"]).optional(), requestedAt: z.coerce.date().optional(), adminNotes: z.string().max(3000).optional() }).parse(req.body);
    res.json(await updateBooking(req.params.id, body));
  } catch (err) { next(err); }
});

const priceInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  tagline: z.string().trim().max(300).optional(),
  monthlyPrice: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter an amount like 3 or 3.00").optional(),
  setupPrice: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).nullable().optional(),
  currency: z.string().trim().length(3).regex(/^[A-Z]{3}$/).optional(),
  publicPath: z.string().trim().max(200).regex(/^\/[a-z0-9/-]*$/i, "Use a path like /website-builder").optional(),
  active: z.boolean().optional(),
});

productsRouter.patch("/:key", requirePermission("website.manage"), async (req, res, next) => {
  try {
    const body = priceInput.parse(req.body);
    const before = await prisma.product.findUnique({ where: { key: req.params.key } });
    if (!before) {
      res.status(404).json({ error: "There is no product with that key." });
      return;
    }

    const product = await updateProduct(req.params.key, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.tagline === undefined ? {} : { tagline: body.tagline }),
      ...(body.monthlyPrice === undefined ? {} : { monthlyPrice: body.monthlyPrice }),
      ...(body.setupPrice === undefined ? {} : { setupPrice: body.setupPrice }),
      ...(body.currency === undefined ? {} : { currency: body.currency }),
      ...(body.publicPath === undefined ? {} : { publicPath: body.publicPath }),
      ...(body.active === undefined ? {} : { active: body.active }),
      updatedBy: req.dbUser?.id ? { connect: { id: req.dbUser.id } } : { disconnect: true },
    });

    const moved =
      before.monthlyPrice.toFixed(2) !== product.monthlyPrice.toFixed(2) ||
      (before.setupPrice?.toFixed(2) ?? null) !== (product.setupPrice?.toFixed(2) ?? null) ||
      before.currency !== product.currency;

    res.json({
      key: product.key,
      name: product.name,
      tagline: product.tagline,
      currency: product.currency,
      monthlyPrice: product.monthlyPrice.toFixed(2),
      setupPrice: product.setupPrice ? product.setupPrice.toFixed(2) : null,
      publicPath: product.publicPath,
      active: product.active,
      updatedAt: product.updatedAt,
      priceMoved: moved,
    });
  } catch (err) {
    next(err);
  }
});
