import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { fetchSubscription, toMinor, verifyTransaction, updatePlanAmount, PaystackError } from "../lib/paystack.js";
import { settleFromProvider } from "./payments.js";
import { sendDunningNotice } from "./websiteDunning.js";

type Data = Record<string, any>;

/** Retain routing fields only. Authorization codes, card data and email tokens
 * must never enter the webhook audit table or application logs. */
export function redactPaystackData(data: Data): Data {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return {
    providerId: typeof data.id === "number" || typeof data.id === "string" ? String(data.id).slice(0, 100) : null,
    reference: typeof data.reference === "string" ? data.reference.slice(0, 100) : null,
    subscription_code: typeof data.subscription_code === "string" ? data.subscription_code.slice(0, 100) : null,
    subscription: { subscription_code: typeof data.subscription?.subscription_code === "string" ? data.subscription.subscription_code.slice(0, 100) : null },
    plan: { plan_code: typeof data.plan?.plan_code === "string" ? data.plan.plan_code.slice(0, 100) : null },
    transaction: { reference: typeof data.transaction?.reference === "string" ? data.transaction.reference.slice(0, 100) : null },
  };
}

export async function enqueuePaystackEvent(raw: Buffer, event: string, data: Data) {
  const id = crypto.createHash("sha256").update(raw).digest("hex");
  const reviewRequired = /^(refund\.|charge\.dispute\.|subscription\.expiring_cards$)/.test(event);
  await prisma.paystackEvent.upsert({ where: { id }, update: {}, create: { id, event, payload: redactPaystackData(data), reviewRequired } });
}

async function handle(event: string, data: Data) {
  if (event === "charge.success" && data.reference) {
    const result = await settleFromProvider(data.reference, "paystack");
    if (result && result.invoice.status !== "PAID") throw new Error("Successful charge is not yet verified");
  }
  const code = data.subscription_code ?? data.subscription?.subscription_code;
  if (!code || !/^(subscription\.|invoice\.)/.test(event)) return;
  // Fetch current state, so delayed/out-of-order events cannot roll billing back.
  const subscription = await fetchSubscription(code);
  const purchase = await prisma.websitePurchase.findFirst({ where: { OR: [
    { providerSubscriptionCode: code },
    { providerPlanCode: subscription.plan.plan_code, providerSubscriptionCode: null, billingState: { in: ["CREATING", "UNCERTAIN"] } },
  ] } });
  if (!purchase) return;
  if (purchase.providerPlanCode !== subscription.plan.plan_code || purchase.billingEmail?.toLowerCase() !== subscription.customer.email.toLowerCase() || subscription.plan.currency !== purchase.currency) throw new Error("Subscription identity mismatch");
  const initial = Number(purchase.monthlyPrice) * (purchase.billingCycle === "annual" ? 10 : 1);
  const standard = Number(purchase.standardRecurringPrice ?? initial);
  if (![toMinor(initial), toMinor(standard)].includes(subscription.plan.amount)) throw new Error("Subscription amount mismatch");
  const state = subscription.status === "attention" ? "PAST_DUE" : ["cancelled", "completed", "complete"].includes(subscription.status) ? "CANCELLED" : subscription.status === "non-renewing" ? "NON_RENEWING" : subscription.status === "active" ? "ACTIVE" : "REVIEW";
  if (purchase.status === "CANCELLED" && !["CANCELLED", "NON_RENEWING"].includes(state)) throw new Error("Cancellation needs current provider confirmation");
  const reference = data.transaction?.reference;
  if (event === "invoice.update" && reference) {
    const payment = await verifyTransaction(reference);
    if (payment.paid) {
      if (payment.currency !== purchase.currency || payment.customerEmail?.toLowerCase() !== purchase.billingEmail?.toLowerCase() || ![toMinor(initial), toMinor(standard)].includes(toMinor(payment.amount))) throw new Error("Recurring payment mismatch");
      // Unique receipt and financial side effect commit together.
      await prisma.$transaction(async tx => {
        const receipt = await tx.paymentReceipt.createMany({ data: [{ reference, purchaseId: purchase.id, amount: payment.amount, currency: payment.currency, paidAt: payment.paidAt ?? new Date() }], skipDuplicates: true });
        if (receipt.count) await tx.client.update({ where: { id: purchase.clientId }, data: { lifetimeValue: { increment: payment.amount } } });
      });
    }
  }
  if (purchase.billingState === "CANCELLING" || (purchase.billingState === "CANCEL_UNCERTAIN" && !["CANCELLED", "NON_RENEWING"].includes(state))) throw new Error("Cancellation reconciliation is pending");
  const changed = await prisma.websitePurchase.updateMany({ where: { id: purchase.id, billingState: purchase.billingState, status: purchase.status }, data: {
    providerSubscriptionCode: code, billingState: state,
    ...(state === "CANCELLED" ? { status: "CANCELLED" } : state === "PAST_DUE" ? { status: "FAILED" } : purchase.status !== "CANCELLED" && state === "ACTIVE" ? { status: "ACTIVE" } : {}),
    // Only ever written when the provider offers a real date. It used to be
    // nulled whenever one was absent, and Paystack stops reporting a next
    // payment date as soon as a subscription is cancelled — so the first event
    // after a cancellation erased the date the customer is paid up to, which is
    // the only thing entitlement can serve a paid-for period from. A stale date
    // in the past costs nothing, because `stillEntitled` compares it to now.
    ...(subscription.next_payment_date && Number.isFinite(Date.parse(subscription.next_payment_date))
      ? { nextBillingAt: new Date(subscription.next_payment_date) }
      : {}),
  } });
  if (!changed.count) throw new Error("Billing changed during reconciliation; retry with current state");

  // A subscription Paystack has given up on for now is the one moment the
  // customer has to hear from us: their card is refusing and nothing else
  // will tell them. Deliberately after the state is committed, and never
  // allowed to fail the event — an email that did not send must not make a
  // reconciled subscription look unreconciled and be retried.
  if (state === "PAST_DUE") {
    await sendDunningNotice(purchase.id).catch((error) =>
      console.error("[paystack] past-due notice not sent:", (error as Error).message),
    );
  }
}

export async function processPaystackEvents(now = new Date()) {
  const events = await prisma.paystackEvent.findMany({ where: { handledAt: null, nextTryAt: { lte: now } }, take: 25, orderBy: { createdAt: "asc" } });
  for (const event of events) {
    // Database lease coordinates workers and recovers after process termination.
    const lease = await prisma.paystackEvent.updateMany({ where: { id: event.id, handledAt: null, nextTryAt: { lte: now } }, data: { nextTryAt: new Date(now.getTime() + 120_000), attempts: { increment: 1 } } });
    if (!lease.count) continue;
    try {
      await handle(event.event, event.payload as Data);
      await prisma.paystackEvent.update({ where: { id: event.id }, data: { handledAt: new Date(), error: null } });
    } catch {
      await prisma.paystackEvent.update({ where: { id: event.id }, data: { error: "Payment reconciliation failed; investigate this event.", nextTryAt: new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(event.attempts, 7))) } });
      console.error("[paystack] Event requires reconciliation", event.id);
    }
  }
}

/** An administrator can recover a lost creation response without another debit. */
export async function reconcilePurchaseSubscription(id: string, code: string) {
  const purchase = await prisma.websitePurchase.findUnique({ where: { id } });
  const subscription = await fetchSubscription(code);
  if (!purchase || purchase.providerPlanCode !== subscription.plan.plan_code || purchase.billingEmail?.toLowerCase() !== subscription.customer.email.toLowerCase() || (purchase.providerSubscriptionCode && purchase.providerSubscriptionCode !== code)) throw new PaystackError("This subscription does not belong to this purchase.", 409);
  await handle("subscription.create", { subscription_code: code });
}

export async function reconcilePaystackPayments() {
  const attempts = await prisma.paymentAttempt.findMany({ where: { provider: "paystack", state: { in: ["INITIALIZING", "PENDING"] }, updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, orderBy: { updatedAt: "asc" }, take: 10 });
  for (const attempt of attempts) {
    const lease = await prisma.paymentAttempt.updateMany({ where: { id: attempt.id, updatedAt: attempt.updatedAt }, data: { updatedAt: new Date() } });
    if (!lease.count) continue;
    try { await settleFromProvider(attempt.reference, "paystack"); }
    catch { console.error("[paystack] Pending checkout needs reconciliation", attempt.id); }
  }
}

export async function updateDuePaystackPrices(now = new Date()): Promise<number> {
  // Paystack prepares invoices three days before charging. Update after the
  // second promo renewal but five days before the first standard renewal.
  const purchases = await prisma.websitePurchase.findMany({ where: { billingState: "ACTIVE", billingCycle: "monthly", providerPlanCode: { not: null }, standardRecurringPrice: { not: null }, billingPriceUpdatedAt: null, promoEndsAt: { lte: new Date(now.getTime() + 5 * 86400_000) } } });
  let count = 0;
  for (const purchase of purchases) {
    try {
      await updatePlanAmount(purchase.providerPlanCode!, Number(purchase.standardRecurringPrice));
      await prisma.websitePurchase.update({ where: { id: purchase.id }, data: { billingPriceUpdatedAt: now } });
      count++;
    } catch { console.error("[paystack] Plan price update needs retry", purchase.id); }
  }
  return count;
}
