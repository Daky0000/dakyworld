/** Offline adversarial checks: no real Paystack calls or database writes. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { prisma } from "../src/lib/prisma.js";
import { toMinor, verifyPaystackSignature, verifyTransaction, createPaymentLink, createSubscription, createSubscriptionPlan, isPaystackUrl, cancelSubscription } from "../src/lib/paystack.js";
import { settleFromProvider, settleManually, raisePayment } from "../src/services/payments.js";
import { websitePaymentQuote } from "../src/services/paymentQuote.js";
import { redactPaystackData, processPaystackEvents } from "../src/services/paystackEvents.js";
import { paystackWebhook } from "../src/routes/paymentWebhooks.js";
import { decryptSecret, encryptSecret } from "../src/lib/secrets.js";
import { updatePurchaseStatus, publicPurchase } from "../src/services/websiteCommerce.js";

process.env.PAYSTACK_SECRET_KEY = "sk_test_offlinechecks";
process.env.APP_SECRET = "offline-paystack-checks-only";
process.env.PAYSTACK_USD_GHS_RATE = "12";
const db = prisma as any;
let checks = 0;
async function check(name: string, fn: () => unknown) { await fn(); checks++; console.log(`PASS ${name}`); }
let upstream: any = {};
let httpStatus = 200;
let requests: Array<{ url: string; options: RequestInit; body: any }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), options, body: options.body ? JSON.parse(String(options.body)) : null });
  return new Response(typeof upstream === "string" ? upstream : JSON.stringify({ status: httpStatus === 200, data: typeof upstream === "function" ? upstream(String(url)) : upstream }), { status: httpStatus });
};
const verified = (overrides: any = {}) => ({ reference: "REF-1", status: "success", amount: 3600, currency: "GHS", domain: "test", paid_at: "2026-09-24T10:00:00Z", channel: "card", customer: { email: "buyer@example.com" }, authorization: { authorization_code: "AUTH_secret", reusable: true, channel: "card" }, ...overrides });

await check("money rejects zero, negative, nonfinite, unsafe and fractional minor units", () => {
  for (const value of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER, 1.001]) assert.throws(() => toMinor(value));
  assert.equal(toMinor(36.01), 3601);
});
await check("signature covers exact bytes and rejects malformed signatures", async () => {
  const raw = Buffer.from('{"event":"charge.success"}');
  const sig = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY!).update(raw).digest("hex");
  assert.equal(await verifyPaystackSignature(raw, sig), true);
  assert.equal(await verifyPaystackSignature(Buffer.concat([raw, Buffer.from(" ")]), sig), false);
  for (const invalid of [undefined, "z".repeat(128), "a", "00".repeat(64)]) assert.equal(await verifyPaystackSignature(raw, invalid), false);
});
await check("checkout URLs cannot escape Paystack", () => {
  assert.ok(isPaystackUrl("https://checkout.paystack.com/abc"));
  for (const url of ["http://checkout.paystack.com/abc", "https://checkout.paystack.com.evil.test/a", "https://evil.test", "https://user@checkout.paystack.com/a"]) assert.equal(isPaystackUrl(url), false);
});
await check("recurring checkout uses hosted card collection and exact minor amount", async () => {
  upstream = { reference: "REF-1", authorization_url: "https://checkout.paystack.com/abc", access_code: "abc" };
  await createPaymentLink({ email: "buyer@example.com", amount: 36, reference: "REF-1", recurring: true });
  const request = requests.at(-1)!;
  assert.equal(request.body.amount, 3600); assert.deepEqual(request.body.channels, ["card"]);
  assert.equal(request.options.redirect, "error"); assert.ok(request.options.signal);
});
await check("verification rejects wrong reference and live/test mismatch", async () => {
  upstream = verified({ reference: "OTHER" }); await assert.rejects(verifyTransaction("REF-1"));
  upstream = verified({ domain: "live" }); await assert.rejects(verifyTransaction("REF-1"));
});
await check("only reusable card authorizations survive verification", async () => {
  upstream = verified({ authorization: { authorization_code: "AUTH_secret", reusable: false, channel: "card" } });
  assert.equal((await verifyTransaction("REF-1")).authorizationCode, null);
  upstream = verified({ authorization: { authorization_code: "AUTH_secret", reusable: true, channel: "mobile_money" } });
  assert.equal((await verifyTransaction("REF-1")).authorizationCode, null);
});
await check("malformed response and rate limiting yield safe errors", async () => {
  upstream = "<html>bad gateway</html>"; await assert.rejects(verifyTransaction("REF-1"));
  upstream = {}; httpStatus = 429; await assert.rejects(verifyTransaction("REF-1"), /busy/); httpStatus = 200;
});

let invoice: any;
let lifetimeValue = 0;
let purchaseUpdate: any;
function resetInvoice() {
  invoice = { id: "invoice1", invoiceNumber: "INV1", status: "SENT", clientId: "client1", amountTotal: 36, currency: "GHS", paymentRef: "REF-1", paymentProvider: "paystack" };
  lifetimeValue = 0; purchaseUpdate = null; upstream = verified();
}
db.paymentAttempt.findUnique = async () => ({ invoiceId: "invoice1", reference: "REF-1", amount: 36, currency: "GHS", email: "buyer@example.com", provider: "paystack" });
db.invoice.findUnique = async () => ({ ...invoice });
db.invoice.findFirst = async () => ({ ...invoice });
db.invoice.findUniqueOrThrow = async () => ({ ...invoice });
db.invoice.updateMany = async ({ where, data }: any) => {
  if (invoice.status === "PAID" || invoice.amountTotal !== where.amountTotal) return { count: 0 };
  Object.assign(invoice, data); return { count: 1 };
};
db.websitePurchase.updateMany = async ({ data }: any) => { purchaseUpdate = data; return { count: 1 }; };
db.paymentAttempt.updateMany = async () => ({ count: 1 });
db.client.update = async ({ data }: any) => { lifetimeValue += Number(data.lifetimeValue.increment); return {}; };
// Dossier side effects are deliberately unavailable; settlement must still commit.
db.contextNote.create = async () => ({});
let transactionTail: Promise<unknown> = Promise.resolve();
db.$transaction = (fn: any) => {
  const task = transactionTail.then(() => fn(db)); transactionTail = task.catch(() => {}); return task;
};
await check("underpayment and wrong currency cannot settle an invoice", async () => {
  resetInvoice(); upstream = verified({ amount: 3500 }); await assert.rejects(settleFromProvider("REF-1"));
  assert.equal(invoice.status, "SENT");
  upstream = verified({ currency: "USD" }); await assert.rejects(settleFromProvider("REF-1")); assert.equal(lifetimeValue, 0);
});
await check("provider mismatch and payer mismatch cannot settle", async () => {
  resetInvoice(); await assert.rejects(settleFromProvider("REF-1", "hubtel"));
  upstream = verified({ customer: { email: "other@example.com" } }); await assert.rejects(settleFromProvider("REF-1"));
});
await check("concurrent provider/manual settlement grants value once", async () => {
  resetInvoice();
  const result = await Promise.all([settleFromProvider("REF-1"), settleFromProvider("REF-1"), settleManually("invoice1")]);
  assert.equal(result.filter(row => row?.changed).length, 1); assert.equal(lifetimeValue, 36);
});
await check("saved reusable authorization is encrypted", async () => {
  resetInvoice(); await settleFromProvider("REF-1");
  assert.notEqual(purchaseUpdate.paymentAuthorization, "AUTH_secret"); assert.equal(decryptSecret(purchaseUpdate.paymentAuthorization), "AUTH_secret");
});
await check("USD pricing produces approved GHS totals and different annual terms", async () => {
  db.product.findFirst = async () => ({ key: "website-builder", currency: "USD", monthlyPrice: 3, setupPrice: null });
  const monthly = await websitePaymentQuote("website-builder", "monthly");
  const annual = await websitePaymentQuote("website-builder", "annual");
  assert.equal(monthly.upfront, 36); assert.equal(monthly.standard, 60);
  assert.equal(annual.upfront, 360); assert.equal(annual.standard, 600); assert.notEqual(annual.quoteId, monthly.quoteId);
});
await check("annual plans and delayed first subscription charge use provider parameters", async () => {
  upstream = { plan_code: "PLN_test" }; await createSubscriptionPlan({ name: "Annual", amount: 600, currency: "GHS", interval: "annually" });
  assert.equal(requests.at(-1)!.body.interval, "annually");
  upstream = { subscription_code: "SUB_test" }; const startDate = new Date("2027-09-24T10:00:00Z");
  await createSubscription({ email: "buyer@example.com", planCode: "PLN_test", authorizationCode: "AUTH_secret", startDate });
  assert.equal(requests.at(-1)!.body.start_date, startDate.toISOString());
});
await check("commerce responses and webhook records omit billing secrets", () => {
  const safe = publicPurchase({ paymentAuthorization: "secret", billingEmail: "private", checkoutKey: "key", checkoutFingerprint: "hash", id: "1" });
  assert.deepEqual(safe, { id: "1", hasReusableCard: true });
  const redacted = JSON.stringify(redactPaystackData({ authorization: { authorization_code: "secret" }, email_token: "token", customer: { email: "private" }, reference: "REF-1" }));
  assert.ok(!redacted.includes("secret") && !redacted.includes("token") && !redacted.includes("private"));
});
await check("activation requires consent and a reusable authorization", async () => {
  db.websitePurchase.findUnique = async () => ({ id: "purchase1", status: "SETUP_PAID", setupPaidAt: new Date(), paymentAuthorization: encryptSecret("AUTH_secret"), recurringConsentAt: null });
  await assert.rejects(updatePurchaseStatus("purchase1", "ACTIVE"), /consent/);
});
await check("queue failures remain durable and scheduled for retry", async () => {
  db.paystackEvent.findMany = async () => [{ id: "evt", event: "charge.success", payload: { reference: "REF-1" }, attempts: 0 }];
  db.paystackEvent.updateMany = async () => ({ count: 1 });
  let update: any; db.paystackEvent.update = async ({ data }: any) => { update = data; return {}; };
  resetInvoice(); upstream = verified({ amount: 1 }); await processPaystackEvents();
  assert.ok(update.error); assert.ok(update.nextTryAt > new Date()); assert.equal(update.handledAt, undefined);
});
await check("webhook rejects forged input and retries when durable storage fails", async () => {
  db.paystackEvent.upsert = async () => { throw new Error("database unavailable"); };
  const app = express(); app.post("/hook", express.raw({ type: "*/*" }), paystackWebhook);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  try {
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "REF-1" } });
    const url = `http://127.0.0.1:${address.port}/hook`;
    assert.equal((await originalFetch(url, { method: "POST", body: raw })).status, 401);
    const signature = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY!).update(raw).digest("hex");
    assert.equal((await originalFetch(url, { method: "POST", body: raw, headers: { "x-paystack-signature": signature } })).status, 503);
  } finally { server.close(); }
});

await check("cancellation reaches Paystack and never repeats an already cancelled subscription", async () => {
  upstream = { domain: "test", subscription_code: "SUB_cancel", status: "active", email_token: "private-token", customer: { email: "buyer@example.com" }, plan: { plan_code: "PLN_test" } };
  await cancelSubscription("SUB_cancel");
  assert.equal(requests.at(-1)!.url, "https://api.paystack.co/subscription/disable");
  assert.deepEqual(requests.at(-1)!.body, { code: "SUB_cancel", token: "private-token" });
  upstream.status = "cancelled";
  const before = requests.length; await cancelSubscription("SUB_cancel");
  assert.equal(requests.length - before, 1);
});
await check("a lost subscription response blocks a second creation attempt", async () => {
  const purchase: any = { id: "purchase1", status: "SETUP_PAID", setupPaidAt: new Date(), paymentAuthorization: encryptSecret("AUTH_secret"), recurringConsentAt: new Date(), billingEmail: "buyer@example.com", billingCycle: "monthly", monthlyPrice: 36, standardRecurringPrice: 60, currency: "GHS", setupPrice: 0, billingState: "NONE", providerPlanCode: "PLN_test", providerSubscriptionCode: null, product: { name: "Starter" } };
  db.websitePurchase.findUnique = async () => ({ ...purchase });
  db.websitePurchase.updateMany = async ({ where, data }: any) => {
    if (purchase.billingState !== where.billingState) return { count: 0 };
    Object.assign(purchase, data); return { count: 1 };
  };
  db.websitePurchase.update = async ({ data }: any) => { Object.assign(purchase, data); return { ...purchase }; };
  httpStatus = 503;
  await assert.rejects(updatePurchaseStatus("purchase1", "ACTIVE"));
  assert.equal(purchase.billingState, "UNCERTAIN");
  const before = requests.length;
  await assert.rejects(updatePurchaseStatus("purchase1", "ACTIVE"), /reconciliation/);
  assert.equal(requests.length, before); httpStatus = 200;
});
await check("an existing invoice checkout is reused without another provider request", async () => {
  resetInvoice(); invoice.client = { email: "buyer@example.com" };
  db.paymentAttempt.findUnique = async () => ({ invoiceId: "invoice1", reference: "REF-1", provider: "paystack", amount: 36, currency: "GHS", url: "https://checkout.paystack.com/existing" });
  const before = requests.length;
  assert.equal((await raisePayment("invoice1", "paystack")).url, "https://checkout.paystack.com/existing");
  assert.equal(requests.length, before);
});

await check("recurring receipt replay credits once and stale events use current provider state", async () => {
  const purchase = { id: "purchase1", clientId: "client1", status: "ACTIVE", billingState: "ACTIVE", billingCycle: "monthly", monthlyPrice: 36, standardRecurringPrice: 60, currency: "GHS", billingEmail: "buyer@example.com", providerPlanCode: "PLN_test", providerSubscriptionCode: "SUB_test" };
  db.websitePurchase.findFirst = async () => purchase;
  let latest: any;
  db.websitePurchase.updateMany = async ({ data }: any) => { latest = data; return { count: 1 }; };
  const receipts = new Set(); lifetimeValue = 0;
  db.paymentReceipt.createMany = async ({ data }: any) => {
    if (receipts.has(data[0].reference)) return { count: 0 };
    receipts.add(data[0].reference); return { count: 1 };
  };
  upstream = (url: string) => url.includes("/subscription/")
    ? { domain: "test", subscription_code: "SUB_test", status: "active", customer: { email: "buyer@example.com" }, plan: { plan_code: "PLN_test", amount: 3600, currency: "GHS" }, next_payment_date: "2026-11-24T10:00:00Z" }
    : verified({ reference: "REF-RENEW" });
  db.paystackEvent.findMany = async () => [1, 2].map(number => ({ id: `evt${number}`, event: "invoice.update", payload: { subscription: { subscription_code: "SUB_test" }, transaction: { reference: "REF-RENEW" } }, attempts: 0 }));
  await processPaystackEvents(); assert.equal(receipts.size, 1); assert.equal(lifetimeValue, 36);
  db.paystackEvent.findMany = async () => [{ id: "old", event: "subscription.disable", payload: { subscription_code: "SUB_test" }, attempts: 0 }];
  await processPaystackEvents(); assert.equal(latest.billingState, "ACTIVE");
});

globalThis.fetch = originalFetch;
await prisma.$disconnect();
console.log(`Paystack safety: ${checks} scenarios passed.`);
