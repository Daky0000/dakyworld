import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { sendMail, mailerConfigured } from "../lib/mailer.js";
import { brandedNotice } from "./transactionalEmail.js";
import { WEBSITE_TIER_PLANS } from "./websiteTierPlans.js";
import { subscriptionManagementLink } from "../lib/paystack.js";
import { customerAppUrl } from "./emailSender.js";

/**
 * What happens when a renewal does not go through.
 *
 * Not a suspension on the first miss. A card expires, a bank declines a foreign
 * charge, a balance is short for a day — treating any of those as "this
 * customer has left" would take a working website off the internet over a
 * temporary problem, and taking somebody's website down is the most expensive
 * mistake available here.
 *
 * So: three notices, then the editor closes while the published site stays up.
 * The website a customer has already paid to have online keeps being served
 * whatever happens to their card, and what they lose is the ability to change
 * it. That is the honest line between "you have not paid" and "we have taken
 * your business off the web".
 */

/**
 * How long a subscription may sit past due before editing closes.
 *
 * Counted in days rather than in failed attempts, because the attempts belong
 * to Paystack now: it retries on its own schedule and tells us the state of
 * the subscription, not how many times it has tried. Fourteen days is long
 * enough for an expired card to be replaced by somebody who only reads email
 * weekly, and short enough that a subscription nobody intends to pay does not
 * run indefinitely.
 */
export const DUNNING_DAYS_BEFORE_LOCK = 14;

/** The parts of a purchase that say how long it has gone unpaid. */
export type UnpaidRow = { billingState: string; nextBillingAt: Date | null; pastDueSince: Date | null; updatedAt: Date };

/**
 * The date a past-due subscription has been unpaid since.
 *
 * The date it was paid up to, when the processor gave one. When it did not,
 * the moment it went past due, which the Paystack event handler records on the
 * way in and leaves alone until the subscription leaves PAST_DUE. This used to
 * be the last time the row was written, and every Paystack event writes the
 * row whether anything changed or not — so each further declined charge
 * started the fortnight again and unlocked editing for somebody still unpaid.
 *
 * The last write remains the answer for a past-due row with neither date,
 * which nothing makes any more: it is no earlier than the write that marked
 * the row past due, so a lock counted from it comes late but never early, and
 * the next event gives the row a date taken from it.
 */
export function unpaidSince(row: Pick<UnpaidRow, "nextBillingAt" | "pastDueSince" | "updatedAt">): Date {
  return row.nextBillingAt ?? row.pastDueSince ?? row.updatedAt;
}

/**
 * The decision, kept pure so it can be checked with dates rather than trusted
 * from a reading of the query. Only a past-due subscription is ever locked; a
 * cancelled one is decided by `stillEntitled`, and a healthy one never.
 */
export function lockedForNonPayment(row: UnpaidRow, now = new Date()): boolean {
  if (row.billingState !== "PAST_DUE") return false;
  return now.getTime() - unpaidSince(row).getTime() >= DUNNING_DAYS_BEFORE_LOCK * 86_400_000;
}

type Notice = { subject: string; body: string; closing: string };
type Charge = { label: string; period: "month" | "year" };

/**
 * The amount the Paystack plan charges, which is the amount that was declined.
 *
 * Read off the purchase, in its own currency, never recomputed from the price
 * list or the exchange rate. A monthly plan is created at the introductory
 * price and raised to the standard one only once `updateDuePaystackPrices` has
 * done it at Paystack, which is what `billingPriceUpdatedAt` records; an annual
 * plan renews at the standard price once a year (`updatePurchaseStatus` in
 * websiteCommerce.ts creates both). This quoted the standard monthly list price
 * instead: $45/mo to somebody whose $25 had just been declined, "/mo" to an
 * annual customer, and cedis converted at today's rate rather than the amount
 * the customer agreed to.
 */
function chargedAmount(purchase: {
  billingCycle: string;
  currency: string;
  monthlyPrice: Prisma.Decimal;
  standardRecurringPrice: Prisma.Decimal | null;
  billingPriceUpdatedAt: Date | null;
}): Charge {
  const annual = purchase.billingCycle === "annual";
  // The same fallback the event handler checks Paystack's amount against.
  const introductory = Number(purchase.monthlyPrice) * (annual ? 10 : 1);
  const standard = purchase.standardRecurringPrice === null ? introductory : Number(purchase.standardRecurringPrice);
  const amount = annual || purchase.billingPriceUpdatedAt ? standard : introductory;
  const figure = amount.toLocaleString("en-GB", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 });
  const money = purchase.currency === "USD" ? `$${figure}` : `${purchase.currency} ${figure}`;
  return annual ? { label: `${money}/yr`, period: "year" } : { label: `${money}/mo`, period: "month" };
}

function noticeFor(stage: number, planName: string, charge: Charge): Notice {
  const payment = `This ${charge.period}'s ${planName} payment (${charge.label})`;
  if (stage <= 1) {
    return {
      subject: `We could not take this ${charge.period}'s payment`,
      body: `${payment} was declined. This is usually an expired card or a bank blocking the charge, and it is normally fixed in a minute.`,
      closing: "We will try again in a few days. Your website is unaffected.",
    };
  }
  if (stage === 2) {
    return {
      subject: "Still declined — please update your card",
      body: `${payment} is still being declined.`,
      closing: "Your website is still online and will stay online. If it stays unpaid for two weeks, editing pauses until a payment goes through.",
    };
  }
  return {
    subject: "Editing paused — payment still outstanding",
    body: `${payment} is still outstanding after two weeks, so editing is paused on your account.`,
    closing:
      "Your website stays online exactly as it is — nothing has been taken down and nothing has been deleted. Update your card and editing comes back immediately.",
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/**
 * Tells the customer, in the words that fit how long it has been.
 *
 * Called from the Paystack event handler once the past-due state is committed,
 * so the date it counts from is the one the lock reads.
 */
export async function sendDunningNotice(purchaseId: string): Promise<void> {
  const purchase = await prisma.websitePurchase.findUnique({
    where: { id: purchaseId },
    select: {
      email: true,
      contactName: true,
      tier: true,
      currency: true,
      billingCycle: true,
      monthlyPrice: true,
      standardRecurringPrice: true,
      billingPriceUpdatedAt: true,
      billingState: true,
      nextBillingAt: true,
      pastDueSince: true,
      updatedAt: true,
      providerSubscriptionCode: true,
    },
  });
  if (!purchase) return;

  const plan = WEBSITE_TIER_PLANS[purchase.tier];
  const fallbackUrl = `${customerAppUrl()}/website/balance`;
  const updateUrl = purchase.providerSubscriptionCode
    ? await subscriptionManagementLink(purchase.providerSubscriptionCode).catch(() => fallbackUrl)
    : fallbackUrl;
  // How far past due, in whole days, decides which of the three notices this
  // is — the first the day it fails, the second a few days in, the third once
  // editing has paused. Counted from the same date the lock is.
  const overdueDays = Math.max(0, Math.floor((Date.now() - unpaidSince(purchase).getTime()) / 86_400_000));
  const stage = overdueDays >= DUNNING_DAYS_BEFORE_LOCK ? 3 : overdueDays >= 4 ? 2 : 1;
  const notice = noticeFor(stage, plan.name, chargedAmount(purchase));

  if (!(await mailerConfigured())) {
    console.warn(`[dunning] no mailer configured — past-due notice for ${purchase.email} not sent`);
    return;
  }

  const first = purchase.contactName.split(" ")[0] ?? "there";
  const { html, text } = await brandedNotice({
    greeting: first,
    paragraphs: [notice.body],
    action: { label: "Update payment details", url: updateUrl },
    after: [notice.closing],
  });

  await sendMail({ to: purchase.email, toName: purchase.contactName, subject: notice.subject, html, text, category: `billing:past-due-${stage}` }).catch((error) =>
    console.error(`[dunning] could not write to ${purchase.email}:`, (error as Error).message),
  );
}

/**
 * Whether editing is paused for non-payment.
 *
 * Read by the entitlement layer. Note what it does *not* cover: serving the
 * published website, which continues regardless. See the comment at the top.
 */
export async function editingLockedForNonPayment(purchaseId: string | null): Promise<boolean> {
  if (!purchaseId) return false;
  const purchase = await prisma.websitePurchase.findUnique({
    where: { id: purchaseId },
    select: { billingState: true, nextBillingAt: true, pastDueSince: true, updatedAt: true },
  });
  // A missing paid-up date used to answer "not locked", for ever — and that
  // date is exactly what a subscription the processor never confirmed lacks.
  return purchase ? lockedForNonPayment(purchase) : false;
}
