/**
 * The three tiers, in both currencies, everywhere a price is said. No database.
 *
 *   npx tsx checks/websitePriceDisplay.ts
 *
 * There are three Website Builder tiers and six authored numbers, in
 * `USD_PRICES`. Ghana is quoted the cedi conversion at the merchant rate;
 * everywhere else is quoted the dollars. Everything this covers is a way that
 * one plan came to have more than one price:
 *
 * - `badge` and `priceDisplay` were literals that stayed at "$3 ($5)" while the
 *   amounts beside them changed, so a customer read one price and was charged
 *   another.
 * - Nine upgrade messages each carried their own copy of the figures.
 * - The catalogue published the authored dollars beside `currency: "USD"` while
 *   the pricing page's markup said GHS, so the page rewrote its own price into
 *   the wrong money.
 * - The catalogue's promotional price and the tier table's standard price drifted
 *   into different currencies, making the plan look cheaper after month three.
 *
 * The rule: no price is a literal, and the cedi figure is always the dollar
 * figure times the rate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tierLabels, nextTierUp, WEBSITE_TIER_PLANS } from "../src/services/websiteTierPlans.js";
import { USD_PRICES, priceFor, amountsFor, enabledPlanCurrencies } from "../src/services/websitePricing.js";
import { usdToGhsRate } from "../src/services/paymentQuote.js";

let checks = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks += 1;
}
function equal(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name);
  checks += 1;
}

const TIERS = ["EDITOR", "CARE", "MANAGED"] as const;

/* ----------------------------------------- the tiers the founder set -- */

equal("Starter is $3, reverting to $5", USD_PRICES.EDITOR, { promo: 3, standard: 5 });
equal("Pro is $10, reverting to $16", USD_PRICES.CARE, { promo: 10, standard: 16 });
equal("Business is $25, reverting to $45", USD_PRICES.MANAGED, { promo: 25, standard: 45 });
equal("there are exactly three tiers", Object.keys(USD_PRICES).sort(), ["CARE", "EDITOR", "MANAGED"]);

for (const tier of TIERS) {
  equal(
    `${tier}: the tier table carries the same dollars as the price list`,
    { promo: WEBSITE_TIER_PLANS[tier].promoMonthlyPrice, standard: WEBSITE_TIER_PLANS[tier].standardMonthlyPrice },
    USD_PRICES[tier],
  );
}

/* -------------------------------- cedis are the dollars times the rate -- */

const rate = usdToGhsRate();
for (const tier of TIERS) {
  const usd = priceFor(tier, "USD");
  const ghs = priceFor(tier, "GHS");
  equal(`${tier}: the dollar price is the authored one`, usd.promoMonthlyPrice, USD_PRICES[tier].promo);
  equal(`${tier}: the cedi price is that times the rate`, ghs.promoMonthlyPrice, Math.round(USD_PRICES[tier].promo * rate));
  equal(`${tier}: and the standard cedi price likewise`, ghs.standardMonthlyPrice, Math.round(USD_PRICES[tier].standard * rate));
  check(`${tier}: the promotional price is below the standard one in dollars`, usd.promoMonthlyPrice < usd.standardMonthlyPrice);
  check(`${tier}: and in cedis`, ghs.promoMonthlyPrice < ghs.standardMonthlyPrice);
  equal(`${tier}: a cedi amount is the same however it is asked for`, amountsFor(tier, "GHS").promo, ghs.promoMonthlyPrice);
}

// The exact figures, so a silent change to the rate default or the rounding
// cannot pass unnoticed at GHS 12 per dollar.
if (rate === 12) {
  equal("at GHS 12/$: Starter is GHS 36 (GHS 60)", priceFor("EDITOR", "GHS").display, "GHS 36 (GHS 60)");
  equal("at GHS 12/$: Pro is GHS 120 (GHS 192)", priceFor("CARE", "GHS").display, "GHS 120 (GHS 192)");
  equal("at GHS 12/$: Business is GHS 300 (GHS 540)", priceFor("MANAGED", "GHS").display, "GHS 300 (GHS 540)");
}
equal("Starter reads as $3 ($5) in dollars", priceFor("EDITOR", "USD").display, "$3 ($5)");
equal("Pro reads as $10 ($16)", priceFor("CARE", "USD").display, "$10 ($16)");
equal("Business reads as $25 ($45)", priceFor("MANAGED", "USD").display, "$25 ($45)");

/* ----------------------------- a label is in the currency it was asked for -- */

for (const tier of TIERS) {
  for (const [what, value] of Object.entries(tierLabels(tier, "GHS"))) {
    if (what === "name") continue;
    check(`${tier}: ${what} is in cedis when cedis were asked for`, /GHS/.test(String(value)) && !/\$/.test(String(value)));
  }
  for (const [what, value] of Object.entries(tierLabels(tier, "USD"))) {
    if (what === "name") continue;
    check(`${tier}: ${what} is in dollars when dollars were asked for`, /\$/.test(String(value)) && !/GHS/.test(String(value)));
  }
}

/* ------------------------------------------------ upgrades point upwards -- */

equal("Starter upgrades to Pro", nextTierUp("EDITOR"), "CARE");
equal("Pro upgrades to Business", nextTierUp("CARE"), "MANAGED");
equal("Business is the top, and is never told to upgrade to itself", nextTierUp("MANAGED"), null);
for (const tier of TIERS) {
  const next = nextTierUp(tier);
  if (!next) continue;
  check(`${tier}: the tier it is sent to actually costs more`, USD_PRICES[next].promo > USD_PRICES[tier].promo);
}

/* ------------------------------ dollars are not offered until they can be taken -- */

const before = process.env.WEBSITE_USD_ENABLED;
process.env.WEBSITE_USD_ENABLED = "";
equal("with dollars switched off, only cedis are offered", enabledPlanCurrencies(), ["GHS"]);
process.env.WEBSITE_USD_ENABLED = "true";
equal("with dollars switched on, both are", enabledPlanCurrencies(), ["GHS", "USD"]);
if (before === undefined) delete process.env.WEBSITE_USD_ENABLED;
else process.env.WEBSITE_USD_ENABLED = before;

/* --------------------------------------- no price survives as a literal -- */

for (const file of [
  "../src/services/websiteTierPlans.ts",
  "../src/services/products.ts",
  "../src/routes/products.ts",
  "../src/services/paymentQuote.ts",
]) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  // Comments may quote the old prices — that is how the defect is recorded.
  // Code may not.
  const code = source.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
  check(`${file}: no dollar amount is written into the code`, !/\$\s?\d/.test(code));
  check(`${file}: no cedi amount is written into the code`, !/GHS\s?\d/.test(code));
}

const plans = readFileSync(new URL("../src/services/websiteTierPlans.ts", import.meta.url), "utf8");
check("the tier table stores no price as a string", !/^\s*(badge|priceDisplay):\s*"/m.test(plans));

const catalogue = readFileSync(new URL("../src/services/products.ts", import.meta.url), "utf8");
check("the catalogue publishes every currency it can charge", /currencies:\s*enabled/.test(catalogue));
check("product seeds take their price from the one list", /USD_PRICES\.\w+\.promo/.test(catalogue));

console.log(`websitePriceDisplay: ${checks} checks passed`);
