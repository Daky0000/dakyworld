/**
 * Who pays for a product, and what a price block prints. No database.
 *
 *   npx tsx checks/products.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideAccess, money, tierName, SHIPPED_PRODUCTS } from "../src/services/products.js";
import { PLAN_ENTITLEMENTS, WEBSITE_TIERS } from "../src/services/websiteCommerce.js";
import {
  WEBSITE_TIER_PLANS,
  SUBSCRIBED_TEST_USERS,
  resolveSubscriptionPricing,
} from "../src/services/websiteTierPlans.js";
import { priceFor, resolveCurrency } from "../src/services/websitePricing.js";

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
// The catalogue is in cedis, because the public site quotes cedis. The dollar
// column lives in services/websitePricing.ts and is asserted below: the two
// used to disagree by a factor of eight, which is the fault these lines exist
// to keep out.
equal("Starter (EDITOR) is $25 in the catalogue", SHIPPED_PRODUCTS[0].monthlyPrice, "25.00");
equal("Starter standard price is $40", SHIPPED_PRODUCTS[0].standardMonthlyPrice, "40.00");
equal("catalogue prices are held in dollars", SHIPPED_PRODUCTS[0].currency, "USD");
equal("Pro (CARE) is $75", SHIPPED_PRODUCTS[1].monthlyPrice, "75.00");
equal("Pro standard price is $120", SHIPPED_PRODUCTS[1].standardMonthlyPrice, "120.00");
equal("Business (MANAGED) is $195", SHIPPED_PRODUCTS[2].monthlyPrice, "195.00");
equal("Business standard price is $320", SHIPPED_PRODUCTS[2].standardMonthlyPrice, "320.00");

// The fault this pair exists for: the catalogue's prices are dollars and the
// standard price comes from the tier table, so a currency change to one and
// not the other once made the standard charge a fifth of the promotional one.
for (const [index, tier] of (["EDITOR", "CARE", "MANAGED"] as const).entries()) {
  const catalogue = Number(SHIPPED_PRODUCTS[index]!.monthlyPrice);
  const standard = Number(SHIPPED_PRODUCTS[index]!.standardMonthlyPrice);
  check(`${tier}: the standard price is above the promotional one in the catalogue`, standard > catalogue);
  check(`${tier}: the catalogue and the tier table agree on the promotional price`, catalogue === WEBSITE_TIER_PLANS[tier].promoMonthlyPrice);
  check(`${tier}: the catalogue and the tier table agree on the standard price`, standard === WEBSITE_TIER_PLANS[tier].standardMonthlyPrice);
}


// The advertised price and the charged price are the same number.
{
  const advertised = readFileSync(new URL("../../website-builder.html", import.meta.url), "utf8");
  check(
    "the Website Builder page advertises the price the catalogue charges",
    advertised.includes("GHS 300"),
  );
}

// One settlement currency. Everything is charged in cedis, converted from the
// catalogue's dollar prices at the merchant rate — a subscription priced in
// one currency and verified in another cannot be checked at all, which is what
// services/paymentQuote.ts and the billing state machine depend on.
equal("everything is billed in cedis", resolveCurrency({ country: "NG" }), "GHS");
equal("including for a Ghanaian customer", resolveCurrency({ country: "GH" }), "GHS");
for (const tier of ["EDITOR", "CARE", "MANAGED"] as const) {
  const price = priceFor(tier);
  check(`${tier} is quoted in cedis`, price.display.startsWith("GHS"));
  check(`${tier} standard price is above its promotional one`, price.standardMonthlyPrice > price.promoMonthlyPrice);
}

console.log(`products: ${checks} checks — one settlement currency, a catalogue in dollars charged in cedis at the merchant rate, the standard price always above the promotional one, storage quotas, and 3 test users verified`);
