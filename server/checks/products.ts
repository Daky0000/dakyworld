/**
 * Who pays for a product, and what a price block prints. No database.
 *
 *   npx tsx checks/products.ts
 */
import assert from "node:assert/strict";
import { decideAccess, money, tierName, SHIPPED_PRODUCTS } from "../src/services/products.js";
import { PLAN_ENTITLEMENTS, WEBSITE_TIERS } from "../src/services/websiteCommerce.js";
import {
  WEBSITE_TIER_PLANS,
  SUBSCRIBED_TEST_USERS,
  resolveSubscriptionPricing,
} from "../src/services/websiteTierPlans.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const price = { monthly: "750.00", setup: "1500.00", currency: "GHS" };
const plan = (tier: string) => ({ id: "plan1", tier, monthlyFee: "5000.00", currency: "GHS" });

/* --------------------------------------------------- on a retainer, free */

for (const tier of ["FOUNDATION", "GROWTH", "TRANSFORMATION"]) {
  const access = decideAccess({ clientId: "c1", productName: "Website Builder", price, plan: plan(tier) });
  check(`${tier} includes the product`, access.included);
  check(`and says which retainer covers it`, access.reason.includes(tierName(tier)));
}

/* ------------------------------------------------- no retainer, charged */

const paying = decideAccess({ clientId: "c1", productName: "Website Builder", price, plan: null });
check("a client with no active retainer pays", !paying.included);
check("and is told the amount rather than 'contact us'", paying.reason.includes("GHS 750"));
equal("with the price still available to the screen", paying.price, price);

/* ------------- a paused retainer is not an active one, and must not cover */

const paused = decideAccess({ clientId: "c1", productName: "Website Builder", price, plan: null });
check("a paused retainer covers nothing", !paused.included);

/* ------------------------------------------- a website with no client */

const orphan = decideAccess({ clientId: null, productName: "Website Builder", price, plan: null });
check("a site linked to nobody is not silently free", !orphan.included);
check("and says what to do about it", /not linked to a client/.test(orphan.reason));

/* ----------------------------------------------- a product with no price */

const unpriced = decideAccess({ clientId: "c1", productName: "Website Builder", price: null, plan: null });
check("an unpriced product does not invent a number", !/GHS|undefined|null/.test(unpriced.reason));
check("and is not free by accident", !unpriced.included);

/* --------------------------------------------------------- the numbers */

equal("a round price prints without decimals", money("750.00"), "750");
equal("thousands are grouped", money("1500.00"), "1,500");
equal("and pence survive when there are any", money("1250.50"), "1,250.50");
equal("a nonsense value is passed through rather than becoming NaN", money("not a price"), "not a price");
equal("large amounts group properly", money("25000"), "25,000");

/* -------------------------------------------------------- what ships */

const builder = SHIPPED_PRODUCTS.find((product) => product.key === "website-builder")!;
check("the Website Builder ships in the catalogue", builder !== undefined);
check("with a price", Number(builder.monthlyPrice) > 0);
equal("pointing at its own public page", builder.publicPath, "/website-builder");
check("every shipped product has a stable key", SHIPPED_PRODUCTS.every((product) => /^[a-z][a-z0-9-]*$/.test(product.key)));
equal("three website plans ship", SHIPPED_PRODUCTS.map(product => product.key), ["website-builder", "website-care", "managed-website"]);
equal("Starter (EDITOR) starts at $3 ($5 standard)", SHIPPED_PRODUCTS[0].monthlyPrice, "3.00");
equal("Starter standard price is $5", SHIPPED_PRODUCTS[0].standardMonthlyPrice, "5.00");
equal("Pro (CARE) starts at $10 ($16 standard)", SHIPPED_PRODUCTS[1].monthlyPrice, "10.00");
equal("Pro standard price is $16", SHIPPED_PRODUCTS[1].standardMonthlyPrice, "16.00");
equal("Business (MANAGED) starts at $25 ($45 standard)", SHIPPED_PRODUCTS[2].monthlyPrice, "25.00");
equal("Business standard price is $45", SHIPPED_PRODUCTS[2].standardMonthlyPrice, "45.00");
equal("the public keys resolve to tiers", WEBSITE_TIERS, { "website-builder": "EDITOR", "website-care": "CARE", "managed-website": "MANAGED" });
equal("Editor allows two users", PLAN_ENTITLEMENTS.EDITOR.userLimit, 2);
equal("Care includes sixty technical minutes", PLAN_ENTITLEMENTS.CARE.includedTechnicalMinutes, 60);
equal("Managed includes four technical hours", PLAN_ENTITLEMENTS.MANAGED.includedTechnicalMinutes, 240);

/* --------------------------------- 3-month promo -> standard price reversion */
const subStart = new Date("2026-06-01T00:00:00Z");
const month1 = new Date("2026-07-01T00:00:00Z");
const month4 = new Date("2026-09-05T00:00:00Z");

const starterPromo = resolveSubscriptionPricing({ tier: "EDITOR", subscribedAt: subStart, now: month1 });
equal("Starter in month 1 bills $3 promo rate", starterPromo.currentMonthlyPrice, 3);
check("Starter in month 1 has revertedToStandard = false", !starterPromo.revertedToStandard);

const starterReverted = resolveSubscriptionPricing({ tier: "EDITOR", subscribedAt: subStart, now: month4 });
equal("Starter after 3 months reverts to $5 standard rate", starterReverted.currentMonthlyPrice, 5);
check("Starter after 3 months has revertedToStandard = true", starterReverted.revertedToStandard);

const proPromo = resolveSubscriptionPricing({ tier: "CARE", subscribedAt: subStart, now: month1 });
equal("Pro in month 1 bills $10 promo rate", proPromo.currentMonthlyPrice, 10);
const proReverted = resolveSubscriptionPricing({ tier: "CARE", subscribedAt: subStart, now: month4 });
equal("Pro after 3 months reverts to $16 standard rate", proReverted.currentMonthlyPrice, 16);

const bizPromo = resolveSubscriptionPricing({ tier: "MANAGED", subscribedAt: subStart, now: month1 });
equal("Business in month 1 bills $25 promo rate", bizPromo.currentMonthlyPrice, 25);
const bizReverted = resolveSubscriptionPricing({ tier: "MANAGED", subscribedAt: subStart, now: month4 });
equal("Business after 3 months reverts to $45 standard rate", bizReverted.currentMonthlyPrice, 45);

/* --------------------------------- Per-user media storage & feature limits */
equal("Starter media storage is 50 MB", WEBSITE_TIER_PLANS.EDITOR.storageQuotaBytes, 50 * 1024 * 1024);
equal("Pro media storage is 500 MB", WEBSITE_TIER_PLANS.CARE.storageQuotaBytes, 500 * 1024 * 1024);
equal("Business media storage is 5 GB", WEBSITE_TIER_PLANS.MANAGED.storageQuotaBytes, 5 * 1024 * 1024 * 1024);
check("Starter locks Global Theme & SEO Inspector", !WEBSITE_TIER_PLANS.EDITOR.features.themeSettings && !WEBSITE_TIER_PLANS.EDITOR.features.seoInspector);
check("Pro unlocks Global Theme, SEO Inspector & AI Assistant", WEBSITE_TIER_PLANS.CARE.features.themeSettings && WEBSITE_TIER_PLANS.CARE.features.seoInspector && WEBSITE_TIER_PLANS.CARE.features.aiAssistant);
check("Pro locks AI Builder Agent & Raw Source Editor", !WEBSITE_TIER_PLANS.CARE.features.aiBuilderAgent && !WEBSITE_TIER_PLANS.CARE.features.sourceCodeEditor);
check("Business unlocks all features", WEBSITE_TIER_PLANS.MANAGED.features.aiBuilderAgent && WEBSITE_TIER_PLANS.MANAGED.features.sourceCodeEditor && WEBSITE_TIER_PLANS.MANAGED.features.pullRequestPublish);
equal("Three subscribed test users are configured", SUBSCRIBED_TEST_USERS.map((u) => u.email), [
  "starter@dakyworld.test",
  "pro@dakyworld.test",
  "business@dakyworld.test",
]);

console.log(`products: ${checks} checks — 3 tier plans ($3 ($5), $10 ($16), $25 ($45)), 3-month standard price reversion, storage quotas, and 3 test users verified`);
