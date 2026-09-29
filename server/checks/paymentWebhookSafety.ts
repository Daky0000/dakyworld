import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/lib/prisma.js";
import { getStripe } from "../src/lib/stripe.js";
import { stripeMinorAmount } from "../src/lib/stripeMoney.js";
import { stripeWebhook, hubtelWebhook } from "../src/routes/paymentWebhooks.js";
import { enqueuePaymentEvent, processPaymentWebhookEvents, reconcileStripeSession } from "../src/services/paymentWebhookEvents.js";

process.env.STRIPE_SECRET_KEY = "sk_test_audit_offline";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_audit_offline";
const suffix = randomUUID();
const reference = `cs_test_${suffix}`;
const stripe = (await getStripe())!;
const retrieve = stripe.checkout.sessions.retrieve;
const originalUpsert = prisma.paymentWebhookEvent.upsert;
const client = await prisma.client.create({ data: { name: "Webhook check", email: `${suffix}@example.invalid` } });
const invoice = await prisma.invoice.create({ data: { clientId: client.id, invoiceNumber: suffix, dueDate: new Date(),
  amountTotal: 36, currency: "GHS", status: "SENT", paymentProvider: "stripe", paymentRef: reference, stripePaymentIntentId: reference } });
const session = { id: reference, mode: "payment", payment_status: "paid", currency: "ghs", amount_total: 3600,
  metadata: { invoiceId: invoice.id }, payment_method_types: ["card"] };
stripe.checkout.sessions.retrieve = (async () => session) as unknown as typeof retrieve;
const app = express();
app.post("/stripe", express.raw({ type: "application/json" }), stripeWebhook);
app.post("/hubtel", express.raw({ type: "application/json" }), hubtelWebhook);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const payload = JSON.stringify({ id: `evt_${suffix}`, type: "checkout.session.completed", data: { object: session } });
const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
const send = (sig = signature) => fetch(`${base}/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": sig }, body: payload });
try {
  assert.equal(stripeMinorAmount(36.01, "GHS"), 3601);
  assert.equal(stripeMinorAmount(36, "JPY"), 36);
  assert.equal(stripeMinorAmount(36, "UGX"), 3600);
  assert.throws(() => stripeMinorAmount(1.5, "JPY"));
  assert.equal((await send("forged")).status, 400);
  prisma.paymentWebhookEvent.upsert = (async () => { throw new Error("storage unavailable"); }) as typeof originalUpsert;
  assert.equal((await send()).status, 503, "durability failure must request provider redelivery");
  prisma.paymentWebhookEvent.upsert = originalUpsert;
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal(await prisma.paymentWebhookEvent.count({ where: { reference } }), 1, "duplicate callback inserts once");
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status, "SENT", "acknowledgement only follows durable enqueue");

  session.payment_status = "unpaid";
  await processPaymentWebhookEvents();
  const pending = await prisma.paymentWebhookEvent.findFirstOrThrow({ where: { reference } });
  assert.equal(pending.handledAt, null);
  assert.ok(pending.error);
  session.payment_status = "paid";
  for (const [key, value] of [["amount_total", 3500], ["currency", "usd"], ["id", "another-session"]] as const) {
    const saved = session[key]; Object.assign(session, { [key]: value });
    await assert.rejects(reconcileStripeSession(reference)); Object.assign(session, { [key]: saved });
  }
  await prisma.paymentWebhookEvent.update({ where: { id: pending.id }, data: { nextTryAt: new Date(0) } });
  await Promise.all([processPaymentWebhookEvents(), processPaymentWebhookEvents()]);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status, "PAID");
  await reconcileStripeSession(reference);
  assert.equal(Number((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).lifetimeValue), 36, "retries credit lifetime value once");

  const hubtelReference = `hubtel-${suffix}`;
  await prisma.invoice.update({ where: { id: invoice.id }, data: { paymentProvider: "hubtel", paymentRef: hubtelReference } });
  for (const body of ["null", "{}", '{"Data":{"ClientReference":42}}']) {
    assert.equal((await fetch(`${base}/hubtel`, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 400);
  }
  const hubtel = await fetch(`${base}/hubtel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ Data: { ClientReference: hubtelReference }, secret: "must-not-persist" }) });
  assert.equal(hubtel.status, 200);
  const stored = await prisma.paymentWebhookEvent.findFirstOrThrow({ where: { reference: hubtelReference } });
  assert.equal(JSON.stringify(stored).includes("must-not-persist"), false);
  console.log("Payment callbacks: signature, durable acknowledgement, deduplication, retry, provider matching and idempotent settlement passed.");
} finally {
  prisma.paymentWebhookEvent.upsert = originalUpsert;
  stripe.checkout.sessions.retrieve = retrieve;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.paymentWebhookEvent.deleteMany({ where: { reference: { in: [reference, `hubtel-${suffix}`] } } });
  await prisma.invoice.delete({ where: { id: invoice.id } });
  // Dossier notes are scoped to this disposable client.
  await prisma.contextNote.deleteMany({ where: { subject: `client:${client.id}` } });
  await prisma.client.delete({ where: { id: client.id } });
  await prisma.$disconnect();
}
