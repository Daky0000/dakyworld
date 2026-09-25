/**
 * Which currency a customer is quoted and charged in. No database.
 *
 *   npx tsx checks/websiteCurrency.ts
 *
 * The defect this exists for: `startWebsitePurchase` has always taken a
 * `country` and a `currency` and resolved between them correctly — and the
 * route's zod schema named neither, so a zod object dropped both before they
 * arrived. Every customer in the world was charged in cedis while the tier
 * screens quoted dollars, and nothing anywhere was wrong when read on its own.
 *
 * So these are assertions against the real functions. A regex would have found
 * `country` in the signature and passed for the whole time the feature was dead.
 */
import assert from "node:assert/strict";
import { purchaseInput, countryHint } from "../src/routes/products.js";
import { resolveCurrency, currencyForCountry } from "../src/services/websitePricing.js";
import { countryForIp } from "../src/lib/geoCountry.js";

let checks = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks += 1;
}
function equal(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name);
  checks += 1;
}

function withUsd<T>(enabled: boolean, fn: () => T): T {
  const before = process.env.WEBSITE_USD_ENABLED;
  process.env.WEBSITE_USD_ENABLED = enabled ? "true" : "";
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.WEBSITE_USD_ENABLED;
    else process.env.WEBSITE_USD_ENABLED = before;
  }
}

/* ------------------------------------ the fields reach the service at all -- */

const base = {
  productKey: "website-builder" as const,
  recurringConsent: true as const,
  quoteId: "a".repeat(64),
  checkoutKey: "3f1d9c2e-5b7a-4c1e-9f2b-8d6a4e0c7b13",
  businessName: "Apex Legal",
  contactName: "Kwame Mensah",
  email: "kwame@apexlegal.com",
  websiteUrl: "https://apexlegal.com",
};

{
  const parsed = purchaseInput.parse({ ...base, currency: "USD", country: "GB" });
  equal("the checkout's chosen currency survives parsing", parsed.currency, "USD");
  equal("the checkout's country survives parsing", parsed.country, "GB");
}
{
  const parsed = purchaseInput.parse(base);
  equal("a checkout that says nothing about currency still parses", parsed.currency, undefined);
}
check(
  "a currency that is not one of the two is refused rather than ignored",
  !purchaseInput.safeParse({ ...base, currency: "EUR" }).success,
);

/* ------------------------------------------------------- the country hint -- */

equal("Cloudflare's country is read", countryHint({ headers: { "cf-ipcountry": "gb" } }), "GB");
equal("Vercel's is read too", countryHint({ headers: { "x-vercel-ip-country": "NG" } }), "NG");
equal("`XX` means Cloudflare does not know, and is not an answer", countryHint({ headers: { "cf-ipcountry": "XX" } }), null);
equal("`T1` is Tor, and is not a country", countryHint({ headers: { "cf-ipcountry": "T1" } }), null);
equal("no header is no answer", countryHint({ headers: {} }), null);

// This API is behind Railway, which sends no country header, so the address
// is what decides. These are real allocations: 102.176.0.0/16 is a Ghanaian
// carrier and 8.8.8.8 is Google in the United States.
equal("a Ghanaian address is Ghana", countryForIp("102.176.0.1"), "GH");
equal("an American address is the United States", countryForIp("8.8.8.8"), "US");
equal("an IPv4 client on a dual-stack socket is still found", countryForIp("::ffff:102.176.0.1"), "GH");
equal("a private address has no country", countryForIp("10.0.0.1"), null);
equal("loopback has no country", countryForIp("127.0.0.1"), null);
equal("no address is no answer", countryForIp(undefined), null);
equal("rubbish is no answer, not a crash", countryForIp("not an address"), null);
equal("with no header the address answers", countryHint({ headers: {}, ip: "102.176.0.1" }), "GH");
equal("a header still wins over the address", countryHint({ headers: { "cf-ipcountry": "GB" }, ip: "102.176.0.1" }), "GB");
withUsd(true, () => {
  equal("a visitor in Ghana is quoted cedis", resolveCurrency({ country: countryHint({ headers: {}, ip: "102.176.0.1" }) }), "GHS");
  equal("a visitor abroad is quoted dollars", resolveCurrency({ country: countryHint({ headers: {}, ip: "8.8.8.8" }) }), "USD");
  equal("a visitor we cannot place is quoted cedis", resolveCurrency({ country: countryHint({ headers: {}, ip: "10.0.0.1" }) }), "GHS");
});
withUsd(false, () => {
  equal("abroad, but dollars cannot be charged: cedis", resolveCurrency({ country: countryHint({ headers: {}, ip: "8.8.8.8" }) }), "GHS");
});

/* ------------------------------------------- which currency each one gets -- */

equal("Ghana is billed in cedis", currencyForCountry("GH"), "GHS");
equal("the full name works as well as the code", currencyForCountry("Ghana"), "GHS");
equal("everywhere else is billed in dollars", currencyForCountry("GB"), "USD");
equal("not knowing where somebody is falls back to cedis", currencyForCountry(""), "GHS");
equal("...and so does no country at all", currencyForCountry(null), "GHS");

withUsd(true, () => {
  equal("a British buyer is quoted in dollars", resolveCurrency({ country: "GB" }), "USD");
  equal("a Ghanaian buyer is quoted in cedis", resolveCurrency({ country: "GH" }), "GHS");
  equal("an explicit choice beats the country it was made from", resolveCurrency({ currency: "GHS", country: "GB" }), "GHS");
  equal("...in the other direction too", resolveCurrency({ currency: "USD", country: "GH" }), "USD");
  equal("a purchase that says nothing at all is cedis", resolveCurrency({}), "GHS");
});

/* --------------------- a currency the processor cannot settle is not offered -- */

withUsd(false, () => {
  equal(
    "with dollars off, a British buyer is quoted cedis rather than a currency their card would be refused in",
    resolveCurrency({ country: "GB" }),
    "GHS",
  );
  equal("asking for dollars outright does not get round it", resolveCurrency({ currency: "USD" }), "GHS");
});

console.log(`websiteCurrency: ${checks} checks passed`);
