import { prisma } from "../lib/prisma.js";
import { sendMail, mailerConfigured } from "../lib/mailer.js";
import { brandedNotice } from "./transactionalEmail.js";
import { priceFor } from "./websitePricing.js";
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
export type UnpaidRow = { billingState: string; nextBillingAt: Date | null; updatedAt: Date };

/**
 * The date a past-due subscription has been unpaid since.
 *
 * The date it was paid up to, when the processor gave one. When it did not,
 * the last time the row was written — which is no earlier than the write that
 * marked it past due, so a lock counted from it can come late but never early.
 * Late in one way worth knowing: every later event from Paystack writes the row
 * again, so without a paid-up date the fortnight runs from the last of them.
 * The alternative was what this replaced — no date, no lock, ever.
 */
export function unpaidSince(row: Pick<UnpaidRow, "nextBillingAt" | "updatedAt">): Date {
  return row.nextBillingAt ?? row.updatedAt;
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

function noticeFor(stage: number, planName: string, priceLabel: string, updateUrl: string): Notice {
  if (stage <= 1) {
    return {
      subject: "We could not take this month's payment",
      body: `This month's ${planName} payment (${priceLabel}) was declined. This is usually an expired card or a bank blocking the charge, and it is normally fixed in a minute.`,
      closing: "We will try again in a few days. Your website is unaffected.",
    };
  }
  if (stage === 2) {
    return {
      subject: "Still declined — please update your card",
      body: `This month's ${planName} payment (${priceLabel}) is still being declined.`,
      closing: "Your website is still online and will stay online. If it stays unpaid for two weeks, editing pauses until a payment goes through.",
    };
  }
  return {
    subject: "Editing paused — payment still outstanding",
    body: `This month's ${planName} payment (${priceLabel}) is still outstanding after two weeks, so editing is paused on your account.`,
    closing:
      "Your website stays online exactly as it is — nothing has been taken down and nothing has been deleted. Update your card and editing comes back immediately.",
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/**
 * Tells the customer, in the words that fit which attempt this is.
 *
 * Called from the payment webhook after the count has been incremented, so the
 * number it reads is the number of failures including this one.
 */
export async function sendDunningNotice(purchaseId: string): Promise<void> {
  const purchase = await prisma.websitePurchase.findUnique({
    where: { id: purchaseId },
    select: {
      email: true,
      contactName: true,
      tier: true,
      currency: true,
      billingState: true,
      nextBillingAt: true,
      updatedAt: true,
      providerSubscriptionCode: true,
    },
  });
  if (!purchase) return;

  const plan = WEBSITE_TIER_PLANS[purchase.tier];
  // In the currency the purchase is billed in. Left to its default this quoted
  // cedis to a customer paying in dollars — twelve times their bill, in money
  // they have never been charged.
  const price = priceFor(purchase.tier, purchase.currency === "USD" ? "USD" : "GHS");
  const fallbackUrl = `${customerAppUrl()}/website/balance`;
  const updateUrl = purchase.providerSubscriptionCode
    ? await subscriptionManagementLink(purchase.providerSubscriptionCode).catch(() => fallbackUrl)
    : fallbackUrl;
  // How far past due, in whole days, decides which of the three notices this
  // is — the first the day it fails, the second a few days in, the third once
  // editing is about to close. Counted from the same date the lock is.
  const overdueDays = Math.max(0, Math.floor((Date.now() - unpaidSince(purchase).getTime()) / 86_400_000));
  const stage = overdueDays >= DUNNING_DAYS_BEFORE_LOCK ? 3 : overdueDays >= 4 ? 2 : 1;
  const notice = noticeFor(stage, plan.name, `${price.standardDisplay}/mo`, updateUrl);

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
    select: { billingState: true, nextBillingAt: true, updatedAt: true },
  });
  // A missing paid-up date used to answer "not locked", for ever — and that
  // date is exactly what a subscription the processor never confirmed lacks.
  return purchase ? lockedForNonPayment(purchase) : false;
}
