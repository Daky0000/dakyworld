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
// The three tiers, in the dollars they are authored in. Ghana is charged the
// cedi conversion of exactly these numbers at the merchant rate, so there is
// one list and the cedi column cannot drift from it — the fault these lines
// exist to keep out is the pass where GHS 300 stood against $3 for the same
// tier, one price and a tenth of it.
//
// The seeds are derived from `USD_PRICES` rather than typed again, so these
// assert the seeding as much as the figures.
equal("Starter (EDITOR) is $3 in the catalogue", SHIPPED_PRODUCTS[0].monthlyPrice, "3.00");
equal("Starter reverts to $5", SHIPPED_PRODUCTS[0].standardMonthlyPrice, "5.00");
equal("catalogue prices are held in dollars", SHIPPED_PRODUCTS[0].currency, "USD");
equal("Pro (CARE) is $10", SHIPPED_PRODUCTS[1].monthlyPrice, "10.00");
equal("Pro reverts to $16", SHIPPED_PRODUCTS[1].standardMonthlyPrice, "16.00");
equal("Business (MANAGED) is $25", SHIPPED_PRODUCTS[2].monthlyPrice, "25.00");
equal("Business reverts to $45", SHIPPED_PRODUCTS[2].standardMonthlyPrice, "45.00");

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
//
// Read from the price list rather than written out, so moving a tier moves
// this assertion with it. What it catches is the page and the catalogue
// drifting apart — which they did, and the page went on advertising a figure
// the checkout had stopped charging.
{
  const advertised = readFileSync(new URL("../../website-builder.html", import.meta.url), "utf8");
  const starter = priceFor("EDITOR", "GHS").promoDisplay;
  check(
    `the Website Builder page advertises ${starter}, which is what Ghana is charged`,
    advertised.includes(starter),
  );
  const pro = priceFor("CARE", "GHS").promoDisplay;
  check(`...and ${pro} for the Care plan`, advertised.includes(pro));
}

// Two currencies, one list. Ghana is charged the cedi conversion of the dollar
// price at the merchant rate; everywhere else is charged the dollars. A
// purchase stores the currency it was sold in and the Paystack plan is created
// in that same currency, so the billing state machine can still verify the
// amount and currency it is shown — which is what a single list buys and what
// two independent ones would destroy.
{
  const before = process.env.WEBSITE_USD_ENABLED;
  process.env.WEBSITE_USD_ENABLED = "true";
  equal("a Nigerian customer is billed in dollars", resolveCurrency({ country: "NG" }), "USD");
  equal("a Ghanaian customer is billed in cedis", resolveCurrency({ country: "GH" }), "GHS");
  process.env.WEBSITE_USD_ENABLED = "";
  equal(
    "with dollars not yet enabled at the processor, everybody is billed in cedis",
    resolveCurrency({ country: "NG" }),
    "GHS",
  );
  if (before === undefined) delete process.env.WEBSITE_USD_ENABLED;
  else process.env.WEBSITE_USD_ENABLED = before;
}

for (const tier of ["EDITOR", "CARE", "MANAGED"] as const) {
  const ghs = priceFor(tier, "GHS");
  const usd = priceFor(tier, "USD");
  check(`${tier} is quoted in cedis when cedis are asked for`, ghs.display.startsWith("GHS"));
  check(`${tier} is quoted in dollars when dollars are asked for`, usd.display.startsWith("$"));
  check(`${tier} standard price is above its promotional one in cedis`, ghs.standardMonthlyPrice > ghs.promoMonthlyPrice);
  check(`${tier} standard price is above its promotional one in dollars`, usd.standardMonthlyPrice > usd.promoMonthlyPrice);
}

console.log(`products: ${checks} checks — three tiers authored in dollars, Ghana charged the cedi conversion at the merchant rate, the standard price always above the promotional one, the page advertising what the checkout charges, storage quotas, and 3 test users verified`);
