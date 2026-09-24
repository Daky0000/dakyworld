import crypto from "node:crypto";
import { encryptSecret } from "../lib/secrets.js";
import type { Invoice } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createPaymentLink, paystackConfigured, verifyTransaction, toMinor } from "../lib/paystack.js";
import { checkStatus, createCheckout, hubtelConfigured } from "../lib/hubtel.js";
import { appUrl } from "./emailSender.js";
import { appendNote } from "./context/dossier.js";

/**
 * Getting an invoice paid.
 *
 * Two rails, because Ghana has two answers: a hosted page that takes a card,
 * mobile money or a bank transfer, and a prompt that arrives on the client's
 * phone. Stripe acquires in neither, which is why every invoice this system has
 * ever produced printed with no way to settle it.
 *
 * **The rail is recorded on the invoice, not inferred.** `paymentProvider` and
 * `paymentRef` are what a webhook is matched against, and a payment nobody can
 * trace back to a decision is a reconciliation problem three months later.
 *
 * **Marking an invoice paid is always done by asking the provider**, never by
 * believing a callback. Paystack signs its webhooks and Hubtel does not sign
 * anything at all, so an unverified "this was paid" is a free invoice to
 * whoever guesses the URL. `settleFromProvider` is the only thing that writes
 * `PAID`, and it verifies first every time.
 */

export type Rail = "paystack" | "hubtel";

export class PaymentRefused extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "PaymentRefused";
  }
}

/** Which rails could be used right now, for the agent and for the Settings screen. */
export async function availableRails(): Promise<Rail[]> {
  const [paystack, hubtel] = await Promise.all([paystackConfigured(), hubtelConfigured()]);
  const rails: Rail[] = [];
  if (paystack) rails.push("paystack");
  if (hubtel) rails.push("hubtel");
  return rails;
}

/** Human-readable invoice prefix plus a collision-resistant checkout ID. */
function referenceFor(invoice: Pick<Invoice, "invoiceNumber">): string {
  return `${invoice.invoiceNumber.replace(/[^A-Za-z0-9]+/g, "-")}-${crypto.randomUUID()}`.toUpperCase();
}

export interface RaisedPayment {
  rail: Rail;
  reference: string;
  /** Where to pay. Null only on a Hubtel checkout that returned none. */
  url: string | null;
  amount: number;
  currency: string;
}

/**
 * Opens a payment for an invoice and records it against the row.
 *
 * Refuses an invoice that is already paid — which is the case the agent is
 * most likely to hit, because a card can sit in the approval queue for a day
 * and get settled by bank transfer in the meantime.
 */
export async function raisePayment(invoiceId: string, rail: Rail, options: { callbackUrl?: string; recurring?: boolean } = {}): Promise<RaisedPayment> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { client: { select: { name: true, company: true, email: true, phone: true } } },
  });
  if (!invoice) throw new PaymentRefused("There is no such invoice.", 404);
  if (invoice.status === "PAID") throw new PaymentRefused(`${invoice.invoiceNumber} has already been paid.`, 409);

  const amount = Number(invoice.amountTotal.toString());
  if (!(amount > 0)) throw new PaymentRefused("That invoice is for nothing, so there is nothing to collect.", 400);

  if (rail !== "paystack" && rail !== "hubtel") throw new PaymentRefused("Unsupported payment provider.");
  if (rail === "paystack" && (!invoice.client.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invoice.client.email))) throw new PaymentRefused("A valid client billing email is required.");
  if (rail === "paystack" && !await paystackConfigured()) throw new PaymentRefused("Paystack is not connected. Configure it under Settings > Payments.", 503);
  if (invoice.paymentProvider && invoice.paymentProvider !== rail) throw new PaymentRefused("Reconcile the existing payment provider before switching payment methods.", 409);
  toMinor(amount);
  if (rail === "paystack" && invoice.currency !== "GHS") throw new PaymentRefused("This Ghana Paystack account requires an invoice in GHS.");
  const existing = await prisma.paymentAttempt.findUnique({ where: { invoiceId } });
  if (existing) {
    if (existing.provider !== rail || Number(existing.amount) !== amount || existing.currency !== invoice.currency) throw new PaymentRefused("The invoice has an existing payment attempt. Reconcile it before changing billing details.", 409);
    if (existing.url) return { rail, reference: existing.reference, url: existing.url, amount, currency: existing.currency };
    throw new PaymentRefused("Checkout is pending confirmation. Check this invoice before creating another payment.", 409);
  }
  const reference = invoice.paymentRef || referenceFor(invoice);
  // The unique invoice constraint serializes concurrent checkout requests.
  try {
    await prisma.paymentAttempt.create({ data: { invoiceId, reference, provider: rail, amount, currency: invoice.currency, email: invoice.client.email, url: invoice.paymentUrl } });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new PaymentRefused("A checkout already exists or is being created. Refresh this invoice.", 409);
    throw error;
  }
  if (invoice.paymentRef) throw new PaymentRefused("An earlier payment reference exists. Reconcile it before creating another payment.", 409);
  const base = await appUrl();
  let url: string | null = null;

  if (rail === "paystack") {
    if (!invoice.client.email) {
      throw new PaymentRefused(`${invoice.client.name} has no email address on file, and Paystack needs one to open a payment page.`, 400);
    }
    const link = await createPaymentLink({
      recurring: options.recurring,
      email: invoice.client.email,
      amount,
      currency: invoice.currency,
      reference,
      callbackUrl: options.callbackUrl ?? `${base}/invoices`,
      metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
    });
    url = link.url;
  } else {
    if (!invoice.client.phone && !invoice.client.email) {
      throw new PaymentRefused(`${invoice.client.name} has neither a phone number nor an email on file, so there is nobody to send the prompt to.`, 400);
    }
    const checkout = await createCheckout({
      amount,
      description: `${invoice.invoiceNumber} — ${invoice.client.company ?? invoice.client.name}`,
      clientReference: reference,
      callbackUrl: `${base}/api/webhooks/hubtel`,
      returnUrl: `${base}/invoices`,
      payeeName: invoice.client.company ?? invoice.client.name,
      payeeEmail: invoice.client.email ?? undefined,
      payeePhone: invoice.client.phone ?? undefined,
    });
    url = checkout.url;
  }

  await prisma.$transaction([
    prisma.paymentAttempt.updateMany({ where: { invoiceId, state: "INITIALIZING" }, data: { url, state: "PENDING" } }),
    prisma.invoice.update({ where: { id: invoice.id }, data: { paymentProvider: rail, paymentRef: reference, paymentUrl: url } }),
  ]);

  return { rail, reference, url, amount, currency: invoice.currency };
}

/**
 * Marks an invoice paid, on the provider's word rather than the caller's.
 *
 * Called from both webhook routes and from a manual re-check. The verification
 * is not optional and not skippable: Hubtel's callback carries no signature at
 * all, so the callback's job is only to say "go and look".
 *
 * Idempotent. Both providers retry a webhook they do not get a 200 from, and a
 * retried "paid" must not add a second payment to the client's lifetime value.
 */
export async function settleFromProvider(reference: string, expectedProvider?: Rail): Promise<{ invoice: Invoice; changed: boolean } | null> {
  const attempt = await prisma.paymentAttempt.findUnique({ where: { reference } });
  const invoice = attempt
    ? await prisma.invoice.findUnique({ where: { id: attempt.invoiceId } })
    : await prisma.invoice.findFirst({ where: { paymentRef: reference } });
  if (!invoice) return null;
  const provider = attempt?.provider ?? invoice.paymentProvider;
  if ((provider !== "paystack" && provider !== "hubtel") || (expectedProvider && provider !== expectedProvider)) throw new PaymentRefused("Payment provider mismatch.", 409);
  if (invoice.status === "PAID") return { invoice, changed: false };
  const status = provider === "hubtel" ? await checkStatus(reference) : await verifyTransaction(reference);
  if (!status.paid) return { invoice, changed: false };
  const amount = Number(attempt?.amount ?? invoice.amountTotal);
  if (status.reference !== reference || status.amount === null || toMinor(status.amount) !== toMinor(amount) || toMinor(amount) !== toMinor(Number(invoice.amountTotal))) throw new PaymentRefused("Payment amount does not match the invoice. Manual reconciliation is required.", 409);
  if (provider === "paystack" && (!("currency" in status) || status.currency !== invoice.currency || (attempt && status.currency !== attempt.currency))) throw new PaymentRefused("Payment currency does not match the invoice.", 409);
  if (provider === "hubtel" && invoice.currency !== "GHS") throw new PaymentRefused("Hubtel currency mismatch.", 409);
  const authorization = "authorizationCode" in status && typeof status.authorizationCode === "string" ? status.authorizationCode : null;
  const billingEmail = "customerEmail" in status && typeof status.customerEmail === "string" ? status.customerEmail : null;
  if (provider === "paystack" && attempt?.email && billingEmail?.toLowerCase() !== attempt.email.toLowerCase()) throw new PaymentRefused("Payment customer does not match the checkout.", 409);
  // Store the exact email tied to the reusable authorization, not an editable profile email.
  return settleInvoice(invoice, status.paidAt ?? new Date(), describeChannel(status.channel), authorization && billingEmail ? encryptSecret(authorization) : null, billingEmail, reference);
}

async function settleInvoice(invoice: Invoice, paidAt: Date, paidVia: string | null, authorization: string | null = null, billingEmail: string | null = null, reference?: string) {
  const result = await prisma.$transaction(async tx => {
    const claimed = await tx.invoice.updateMany({ where: { id: invoice.id, status: { not: "PAID" }, amountTotal: invoice.amountTotal, currency: invoice.currency }, data: { status: "PAID", paidAt, paidVia } });
    const current = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    if (!claimed.count) return { invoice: current, changed: false };
    await tx.websitePurchase.updateMany({ where: { invoiceId: invoice.id, status: "PAYMENT_PENDING" }, data: { status: "SETUP_PAID", setupPaidAt: paidAt, paymentAuthorization: authorization, billingEmail } });
    await tx.client.update({ where: { id: invoice.clientId }, data: { lifetimeValue: { increment: invoice.amountTotal } } });
    if (reference) await tx.paymentAttempt.updateMany({ where: { reference }, data: { state: "PAID" } });
    return { invoice: current, changed: true };
  });
  if (result.changed) {
    try {
      await appendNote({ subject: `client:${invoice.clientId}`, kind: "OUTCOME", summary: `${invoice.invoiceNumber} paid: ${invoice.currency} ${invoice.amountTotal}${paidVia ? ` by ${paidVia}` : ""}`, authorKey: "system" });
    } catch { console.error("[payments] Could not append payment note", invoice.id); }

    // Start the recurring subscription here rather than waiting for somebody to
    // press a button on the Purchases screen. A customer who paid at two in the
    // morning owns the product from that moment; leaving it to a person meant
    // the first month was taken and the second one never was until somebody
    // noticed. It goes through `updatePurchaseStatus`, which claims the billing
    // state before calling Paystack and parks the row for reconciliation if the
    // call fails — outside the transaction, because the payment has settled and
    // must not be rolled back over a subscription that can be retried.
    const purchase = await prisma.websitePurchase.findFirst({
      where: { invoiceId: invoice.id, status: "SETUP_PAID", billingState: "NONE" },
      select: { id: true, email: true },
    });
    if (purchase) {
      const { updatePurchaseStatus } = await import("./websiteCommerce.js");
      await updatePurchaseStatus(purchase.id, "ACTIVE").catch((error) =>
        console.error(`[payments] recurring billing did not start for ${purchase.email}:`, (error as Error).message),
      );
    }
  }
  return result;
}

/** Manual and provider settlement share one atomic transition. */
export async function settleManually(invoiceId: string, options: { paidVia?: string; paidAt?: Date } = {}): Promise<{ invoice: Invoice; changed: boolean } | null> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return null;
  return settleInvoice(invoice, options.paidAt ?? new Date(), options.paidVia ?? "manual");
}

/** The provider's own word for how it was paid, in the Owner's words. */
function describeChannel(channel: string | null): string | null {
  if (!channel) return null;
  const lower = channel.toLowerCase();
  if (lower.includes("mobile") || lower === "momo") return "mobile money";
  if (lower.includes("card")) return "card";
  if (lower.includes("bank")) return "bank transfer";
  if (lower.includes("ussd")) return "USSD";
  return channel;
}
