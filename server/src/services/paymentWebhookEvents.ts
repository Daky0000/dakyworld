import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { getStripe } from "../lib/stripe.js";
import { stripeMinorAmount } from "../lib/stripeMoney.js";
import { settleFromProvider, settleStripeInvoice } from "./payments.js";

/** Store identifiers only; neither callback bodies nor payment credentials belong in this inbox. */
export async function enqueuePaymentEvent(provider: "stripe" | "hubtel", deliveryId: string, reference: string) {
  const id = createHash("sha256").update(`${provider}:${deliveryId}`).digest("hex");
  await prisma.paymentWebhookEvent.upsert({ where: { id }, update: {}, create: { id, provider, reference } });
}

export async function reconcileStripeSession(reference: string) {
  const stripe = await getStripe();
  if (!stripe) throw new Error("Stripe is not configured");
  const session = await stripe.checkout.sessions.retrieve(reference);
  if (session.id !== reference || session.mode !== "payment" || session.payment_status !== "paid") throw new Error("Stripe payment is not settled");
  const invoiceId = session.metadata?.invoiceId;
  if (!invoiceId) throw new Error("Stripe invoice association is missing");
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.paymentProvider !== "stripe"
    || (invoice.paymentRef ?? invoice.stripePaymentIntentId) !== reference
    || session.currency?.toUpperCase() !== invoice.currency.toUpperCase()
    || session.amount_total !== stripeMinorAmount(Number(invoice.amountTotal), invoice.currency)) {
    throw new Error("Stripe payment does not match the invoice");
  }
  // The transition also compares these validated fields inside the transaction.
  const result = await settleStripeInvoice(invoice, reference, `Stripe ${session.payment_method_types[0] ?? "card"}`);
  if (result.invoice.status !== "PAID") throw new Error("Invoice changed during payment reconciliation");
}

/** A conditional claim and owner token prevent a late worker from completing a reclaimed event. */
export async function processPaymentWebhookEvents(now = new Date()) {
  const events = await prisma.paymentWebhookEvent.findMany({ where: { handledAt: null, nextTryAt: { lte: now } }, orderBy: { createdAt: "asc" }, take: 25 });
  for (const event of events) {
    const leaseOwner = randomUUID();
    const claimed = await prisma.paymentWebhookEvent.updateMany({ where: { id: event.id, handledAt: null, nextTryAt: { lte: now } },
      data: { leaseOwner, nextTryAt: new Date(Date.now() + 120_000), attempts: { increment: 1 } } });
    if (!claimed.count) continue;
    const where = { id: event.id, leaseOwner, handledAt: null };
    try {
      if (event.provider === "stripe") await reconcileStripeSession(event.reference);
      else if (event.provider === "hubtel") {
        const result = await settleFromProvider(event.reference, "hubtel");
        if (!result || result.invoice.status !== "PAID") throw new Error("Hubtel payment is not settled");
      } else throw new Error("Unsupported payment provider");
      await prisma.paymentWebhookEvent.updateMany({ where, data: { handledAt: new Date(), leaseOwner: null, error: null } });
    } catch {
      await prisma.paymentWebhookEvent.updateMany({ where, data: { leaseOwner: null,
        error: "Payment reconciliation failed; retry scheduled.",
        nextTryAt: new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(event.attempts, 7))) } });
    }
  }
}
