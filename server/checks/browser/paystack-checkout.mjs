import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.PLAYWRIGHT_URL || require.resolve("playwright"));
const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = resolve(root, `.${pathname === "/website-builder" ? "/website-builder.html" : pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    res.setHeader("content-type", types[extname(file)] || "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const payloads = [];
  let paid = false;
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET, OPTIONS" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.includes("/website-payment-quote?")) return route.fulfill({ headers, json: { quoteId: "a".repeat(64), productKey: "website-builder", billingCycle: "monthly", upfront: 36, recurring: 36, standard: 60, usdToGhs: 12 } });
    if (url.endsWith("/website-purchases")) {
      payloads.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, headers, json: { error: "Payment status pending. Retry the same checkout." } });
    }
    if (url.endsWith("/website-payment-status")) return route.fulfill({ headers, json: { paid, status: paid ? "SETUP_PAID" : "PAYMENT_PENDING" } });
    return route.abort();
  });
  await page.goto(`${base}/website-builder?purchase=website-builder`);
  await page.locator("#dw-email").fill("buyer@example.com");
  await page.locator("#dw-contact").fill("Test Buyer");
  await page.locator("#dw-biz").fill("Example Company");
  await page.locator("#dw-url").fill("https://example.com");
  await page.locator("#builderSubmitBtn").click();
  await page.waitForFunction(() => document.getElementById("builderBillingTerms").textContent.includes("GHS 36.00"));
  assert.equal(payloads.length, 0, "Reviewing a quote must not open a payment");
  await page.locator("#builderSubmitBtn").click();
  assert.equal(payloads.length, 0, "Unchecked consent must block checkout");
  await page.locator('[name="recurringConsent"]').check();
  await page.evaluate(() => { const form = document.getElementById("builderPurchaseForm"); form.requestSubmit(); form.requestSubmit(); });
  await page.waitForFunction(() => document.getElementById("builderFormStatus").textContent.includes("Payment status pending"));
  assert.equal(payloads.length, 1, "Double submit must create only one request");
  assert.equal(payloads[0].recurringConsent, true);
  await page.locator("#builderSubmitBtn").click();
  await page.waitForFunction(() => document.getElementById("builderFormStatus").textContent.includes("Review the GHS"));
  await page.locator('[name="recurringConsent"]').check();
  await page.locator("#builderSubmitBtn").click();
  await page.waitForFunction(() => document.getElementById("builderFormStatus").textContent.includes("Payment status pending"));
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].checkoutKey, payloads[1].checkoutKey, "Retry must preserve checkout identity");
  await page.goto(`${base}/website-builder?payment=returned`);
  assert.equal(await page.locator("#builderSuccess").evaluate(node => node.open), false, "Return URL must not claim success");
  assert.match(await page.locator(".builder-payment-return").textContent(), /pending/);
  paid = true;
  await page.waitForFunction(() => document.querySelector(".builder-payment-return")?.textContent.includes("Payment verified"));
  assert.ok(!errors.length, `Browser errors: ${errors.join(", ")}`);
  console.log("Paystack browser checks passed: GHS quote, explicit consent, double-submit guard, stable retry key, verified return.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
