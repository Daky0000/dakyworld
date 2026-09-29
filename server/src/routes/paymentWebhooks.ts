import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { verifyPaystackSignature } from "../lib/paystack.js";
import { enqueuePaystackEvent, processPaystackEvents } from "../services/paystackEvents.js";
import { getStripe, stripeWebhookSecret } from "../lib/stripe.js";
import { enqueuePaymentEvent } from "../services/paymentWebhookEvents.js";

/** Provider callbacks use raw bodies. Paystack signatures are checked before
 * parsing, and accepted Paystack events enter a durable queue before HTTP 200. */

/** HMAC-SHA512 authentication and durable, redacted Paystack ingestion. */
export async function paystackWebhook(req: Request, res: Response) {
  try {
    if (!Buffer.isBuffer(req.body)) return res.status(400).send("raw body required");
    const signature = req.headers["x-paystack-signature"];
    if (typeof signature !== "string" || !await verifyPaystackSignature(req.body, signature)) return res.status(401).send("bad signature");
    let payload;
    try { payload = JSON.parse(req.body.toString("utf8")); }
    catch { return res.status(400).send("not json"); }
    if (!payload || typeof payload.event !== "string" || payload.event.length > 100 || !payload.data || typeof payload.data !== "object") return res.status(400).send("invalid event");
    await enqueuePaystackEvent(req.body, payload.event, payload.data);
    res.status(200).json({ received: true });
    void processPaystackEvents().catch(() => console.error("[paystack] Queue worker failed; scheduler will retry"));
  } catch {
    // Never acknowledge an event which has not reached durable storage.
    return res.status(503).json({ error: "Please retry delivery" });
  }
}



/**
 * Hubtel.
 *
 * Carries no signature of any kind, so the payload is a *notification* and
 * nothing more — the reference is taken out of it and everything else is
 * ignored in favour of asking Hubtel directly. Recorded as `verified: false`
 * always, honestly, rather than claiming a check that did not happen.
 */
export async function hubtelWebhook(req: Request, res: Response) {
  if (!Buffer.isBuffer(req.body)) return res.status(400).send("raw body required");
  let payload;
  try { payload = JSON.parse(req.body.toString("utf8")); }
  catch { return res.status(400).send("not json"); }
  const reference = payload?.Data?.ClientReference ?? payload?.data?.clientReference;
  if (typeof reference !== "string" || !reference.length || reference.length > 200) return res.status(400).send("invalid reference");
  try {
    // Unsigned callbacks can only schedule verification of an existing checkout.
    const known = await prisma.paymentAttempt.findFirst({ where: { reference, provider: "hubtel" }, select: { id: true } })
      ?? await prisma.invoice.findFirst({ where: { paymentRef: reference, paymentProvider: "hubtel" }, select: { id: true } });
    if (known) await enqueuePaymentEvent("hubtel", reference, reference);
    return res.json({ received: true });
  } catch { return res.status(503).json({ error: "Please retry delivery" }); }
}

export async function stripeWebhook(req: Request, res: Response) {
  try {
    const stripe = await getStripe();
    const secret = await stripeWebhookSecret();
    if (!stripe || !secret) return res.status(503).send("Stripe webhook not configured");
    const signature = req.headers["stripe-signature"];
    if (!Buffer.isBuffer(req.body) || typeof signature !== "string") return res.status(400).send("raw body and signature required");
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, signature, secret); }
    catch { return res.status(400).send("Webhook signature verification failed"); }
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      await enqueuePaymentEvent("stripe", event.id, event.data.object.id);
    }
    return res.json({ received: true });
  } catch { return res.status(503).json({ error: "Please retry delivery" }); }
}
