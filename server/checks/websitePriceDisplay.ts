/**
 * Every price a customer reads, against the price they are charged. No database.
 *
 *   npx tsx checks/websitePriceDisplay.ts
 *
 * Prices are authored in USD and charged in cedis at `PAYSTACK_USD_GHS_RATE`.
 * That leaves two numbers for one thing, and every defect this covers is a
 * screen that picked the wrong one:
 *
 * - `badge` and `priceDisplay` said "$3 ($5)" long after the amounts beside
 *   them had become 25 and 40 and long after billing had moved to cedis, so a
 *   Starter customer read "$3 ($5)" while being charged GHS 300 — eight times
 *   that, in another currency.
 * - Nine upgrade messages each carried their own copy, e.g. "Pro ($10/$16)".
 * - The public catalogue published the authored dollars beside `currency:
 *   "USD"`, and `assets/pricing.js` prints `currency + " " + amount` — so the
 *   pricing page replaced its own "GHS 300" with "USD 25" on load.
 *
 * The rule asserted here: **no price is a literal**, and everything a customer
 * reads is the cedi figure.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tierLabels, nextTierUp, WEBSITE_TIER_PLANS } from "../src/services/websiteTierPlans.js";
import { priceFor } from "../src/services/websitePricing.js";
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

/* ------------------------------------------- every shown price is in cedis -- */

for (const tier of TIERS) {
  const labels = tierLabels(tier);
  for (const [what, value] of Object.entries(labels)) {
    if (what === "name") continue;
    check(`${tier}: ${what} is quoted in cedis`, /GHS/.test(String(value)));
    check(`${tier}: ${what} carries no dollar sign`, !/\$/.test(String(value)));
  }
}

/* ------------------------- the shown price is the one that will be charged -- */

const rate = usdToGhsRate();
for (const tier of TIERS) {
  const plan = WEBSITE_TIER_PLANS[tier];
  const price = priceFor(tier);
  equal(
    `${tier}: the promotional price shown is the USD price at the merchant rate`,
    price.promoMonthlyPrice,
    Math.round(plan.promoMonthlyPrice * rate),
  );
  equal(
    `${tier}: and so is the standard one`,
    price.standardMonthlyPrice,
    Math.round(plan.standardMonthlyPrice * rate),
  );
  check(`${tier}: the promotional price is below the standard one`, price.promoMonthlyPrice < price.standardMonthlyPrice);
}

/* ------------------------------------------------ upgrades point upwards -- */

equal("Starter upgrades to Pro", nextTierUp("EDITOR"), "CARE");
equal("Pro upgrades to Business", nextTierUp("CARE"), "MANAGED");
equal("Business is the top, and is never told to upgrade to itself", nextTierUp("MANAGED"), null);

for (const tier of TIERS) {
  const next = nextTierUp(tier);
  if (!next) continue;
  check(
    `${tier}: the tier it is sent to actually costs more`,
    priceFor(next).promoMonthlyPrice > priceFor(tier).promoMonthlyPrice,
  );
  check(
    `${tier}: the upgrade is named with its price`,
    tierLabels(next).upgrade.includes(WEBSITE_TIER_PLANS[next].name) && /GHS/.test(tierLabels(next).upgrade),
  );
}

/* --------------------------------------------- no price survives as a literal -- */

const STALE = /\$\s?(3|5|10|16|25|45)\b(?!\d)/;
for (const file of [
  "../src/services/websiteTierPlans.ts",
  "../src/services/products.ts",
  "../src/routes/products.ts",
]) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  // Comments are allowed to quote the old prices — that is how the defect is
  // recorded. Code is not.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  check(`${file}: no dollar price is written into the code`, !STALE.test(code));
}

const catalogue = readFileSync(new URL("../src/services/products.ts", import.meta.url), "utf8");
check(
  "the public catalogue publishes cedis, whatever currency the product is authored in",
  /currency:\s*"GHS"/.test(catalogue),
);
check(
  "...converted at the same rate the customer is charged at",
  /usdToGhsRate\(\)/.test(catalogue),
);

const plans = readFileSync(new URL("../src/services/websiteTierPlans.ts", import.meta.url), "utf8");
check(
  "the tier table no longer stores a price as a string",
  !/^\s*(badge|priceDisplay):\s*"/m.test(plans),
);

console.log(`websitePriceDisplay: ${checks} checks passed`);
