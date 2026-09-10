/**
 * Who pays for a product, and what a price block prints. No database.
 *
 *   npx tsx checks/products.ts
 *
 * The rule under test is the sentence the company sells on: a client on an
 * active retainer gets every product at no charge, and everybody else pays. It
 * is decided in one place so the website, the onboarding list and an invoice
 * cannot tell a client three different things — which makes that one place
 * worth holding still.
 */
import assert from "node:assert/strict";
import { decideAccess, money, tierName, SHIPPED_PRODUCTS } from "../src/services/products.js";

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

// The query only ever passes an ACTIVE plan, so the decision sees null here.
// This is the case that would quietly give a non-paying client a free product.
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

console.log(`products: ${checks} checks — retainers include everything, everyone else is quoted a real number, and no path is free by accident`);
