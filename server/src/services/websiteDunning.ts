import { prisma } from "../lib/prisma.js";
import { sendMail, mailerConfigured } from "../lib/mailer.js";
import { priceFor } from "./websitePricing.js";
import { WEBSITE_TIER_PLANS } from "./websiteTierPlans.js";

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

/** How many failed attempts before editing is closed. */
export const DUNNING_ATTEMPTS_BEFORE_LOCK = 3;

type Notice = { subject: string; body: string; closing: string };

function noticeFor(attempt: number, planName: string, priceLabel: string, updateUrl: string): Notice {
  if (attempt <= 1) {
    return {
      subject: "We could not take this month's payment",
      body: `This month's ${planName} payment (${priceLabel}) was declined. This is usually an expired card or a bank blocking the charge, and it is normally fixed in a minute.`,
      closing: "We will try again in a few days. Your website is unaffected.",
    };
  }
  if (attempt === 2) {
    return {
      subject: "Second attempt declined — please update your card",
      body: `We tried this month's ${planName} payment (${priceLabel}) again and it was declined a second time.`,
      closing: "Your website is still online and will stay online. If the next attempt fails, editing will pause until a payment goes through.",
    };
  }
  return {
    subject: "Editing paused — payment still outstanding",
    body: `Three attempts at this month's ${planName} payment (${priceLabel}) have now been declined, so editing is paused on your account.`,
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
      failedPaymentCount: true,
      invoice: { select: { paymentUrl: true } },
    },
  });
  if (!purchase) return;

  const plan = WEBSITE_TIER_PLANS[purchase.tier];
  const price = priceFor(purchase.tier, purchase.currency === "USD" ? "USD" : "GHS");
  const updateUrl = purchase.invoice?.paymentUrl ?? "https://dakyworld.com/website-builder";
  const notice = noticeFor(purchase.failedPaymentCount, plan.name, `${price.standardDisplay}/mo`, updateUrl);

  if (!(await mailerConfigured())) {
    console.warn(`[dunning] no mailer configured — attempt ${purchase.failedPaymentCount} notice for ${purchase.email} not sent`);
    return;
  }

  const first = purchase.contactName.split(" ")[0] ?? "there";
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#1b2029">
  <p>Hello ${escapeHtml(first)},</p>
  <p>${escapeHtml(notice.body)}</p>
  <p style="margin:26px 0"><a href="${updateUrl}" style="background:#1b2029;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block">Update payment details</a></p>
  <p>${escapeHtml(notice.closing)}</p>
  <p>Dakyworld</p>
</div>`;
  const text = `Hello ${first},\n\n${notice.body}\n\nUpdate payment details: ${updateUrl}\n\n${notice.closing}\n\nDakyworld`;

  await sendMail({ to: purchase.email, toName: purchase.contactName, subject: notice.subject, html, text }).catch((error) =>
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
    select: { failedPaymentCount: true },
  });
  return (purchase?.failedPaymentCount ?? 0) >= DUNNING_ATTEMPTS_BEFORE_LOCK;
}
