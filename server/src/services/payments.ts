import type { Invoice } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createPaymentLink, paystackConfigured, verifyTransaction } from "../lib/paystack.js";
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

/**
 * A reference that ties a payment back to one invoice.
 *
 * Carries the invoice number so a person reading a Paystack dashboard can tell
 * what they are looking at, and a timestamp because both providers require
 * global uniqueness for ever — a second attempt at the same invoice, after the
 * first link was abandoned, is a second transaction rather than a replacement.
 */
function referenceFor(invoice: Pick<Invoice, "invoiceNumber">): string {
  return `${invoice.invoiceNumber.replace(/[^A-Za-z0-9]+/g, "-")}-${Date.now().toString(36)}`.toUpperCase();
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
export async function raisePayment(invoiceId: string, rail: Rail): Promise<RaisedPayment> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { client: { select: { name: true, company: true, email: true, phone: true } } },
  });
  if (!invoice) throw new PaymentRefused("There is no such invoice.", 404);
  if (invoice.status === "PAID") throw new PaymentRefused(`${invoice.invoiceNumber} has already been paid.`, 409);

  const amount = Number(invoice.amountTotal.toString());
  if (!(amount > 0)) throw new PaymentRefused("That invoice is for nothing, so there is nothing to collect.", 400);

  const reference = referenceFor(invoice);
  const base = await appUrl();
  let url: string | null = null;

  if (rail === "paystack") {
    if (!invoice.client.email) {
      throw new PaymentRefused(`${invoice.client.name} has no email address on file, and Paystack needs one to open a payment page.`, 400);
    }
    const link = await createPaymentLink({
      email: invoice.client.email,
      amount,
      currency: invoice.currency,
      reference,
      callbackUrl: `${base}/invoices`,
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

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { paymentProvider: rail, paymentRef: reference, paymentUrl: url },
  });

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
export async function settleFromProvider(reference: string): Promise<{ invoice: Invoice; changed: boolean } | null> {
  const invoice = await prisma.invoice.findFirst({ where: { paymentRef: reference } });
  if (!invoice) return null;

  if (invoice.status === "PAID") return { invoice, changed: false };

  const provider = invoice.paymentProvider === "hubtel" ? "hubtel" : "paystack";
  const status = provider === "hubtel" ? await checkStatus(reference) : await verifyTransaction(reference);
  if (!status.paid) return { invoice, changed: false };

  const paidVia = describeChannel(status.channel);
  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "PAID", paidAt: status.paidAt ?? new Date(), paidVia },
  });

  // Lifetime value is the client's, and it is what the dashboard and the
  // upsell analysis both read. Incremented only on the transition, which is
  // what the early return above protects.
  await prisma.client.update({
    where: { id: invoice.clientId },
    data: { lifetimeValue: { increment: invoice.amountTotal } },
  });

  // So the collector agent stops chasing, and so a person reading the client's
  // history can see how it was settled without opening a provider dashboard.
  try {
    await appendNote({
      subject: `client:${invoice.clientId}`,
      kind: "OUTCOME",
      summary: `${invoice.invoiceNumber} paid — ${invoice.currency} ${Number(invoice.amountTotal.toString()).toLocaleString("en-GB")}${paidVia ? ` by ${paidVia}` : ""}`,
      authorKey: "system",
    });
  } catch (err) {
    console.error("[payments] could not note the payment:", (err as Error).message);
  }

  return { invoice: updated, changed: true };
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
