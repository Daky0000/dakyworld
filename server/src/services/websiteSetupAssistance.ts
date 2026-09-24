import type { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { createNumberedInvoice } from "./invoiceNumber.js";
import { raisePayment } from "./payments.js";
import { appUrl } from "./emailSender.js";
import { SETUP_ASSISTANCE, resolveCurrency, type PlanCurrency } from "./websitePricing.js";
import { resolveEntitlement } from "./websiteEntitlement.js";
import { WebsiteError } from "./website/site.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";

/**
 * "Do it for me", as a thing somebody can buy in the connect dialog.
 *
 * Connecting a website is two DNS records or one GitHub installation. Most
 * people manage it from the guide; for the rest it is the step where they stop,
 * and the honest options at that point are a longer document or a person. This
 * is the person, for a fixed fee, raised as an ordinary invoice so it lands in
 * the same place as every other payment rather than in somebody's inbox.
 *
 * It deliberately does no work itself. It records what the customer needs help
 * with, takes the payment, and puts the request where staff already look.
 */

const requestInput = z.object({
  siteId: z.string().min(1).nullable().optional(),
  /** Which of the two paths they were on when they asked. */
  route: z.enum(["hosted", "github"]),
  websiteUrl: z.string().trim().max(500).optional(),
  /** What they have already tried, in their words. */
  notes: z.string().trim().max(2000).optional(),
  currency: z.string().trim().max(3).optional(),
  country: z.string().trim().max(60).optional(),
});

const ROUTE_LABEL: Record<"hosted" | "github", string> = {
  hosted: "Hosted by Dakyworld — domain and DNS setup",
  github: "GitHub repository connection and first publish",
};

const handler =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function registerWebsiteSetupAssistance(router: Router) {
  /** What it costs, in the currency this customer is billed in. */
  router.get(
    "/setup-assistance",
    handler(async (req, res) => {
      const entitlement = await resolveEntitlement(req);
      const currency: PlanCurrency = entitlement.currency === "USD" ? "USD" : "GHS";
      const price = SETUP_ASSISTANCE[currency];
      const base = (await appUrl()).replace(/\/$/, "");
      res.json({
        currency,
        amount: price.amount,
        display: price.display,
        guides: {
          hosted: "https://dakyworld.com/website-builder-setup#hosted",
          github: "https://dakyworld.com/website-builder-setup#github",
        },
        appUrl: base,
      });
    }),
  );

  /**
   * Asks for it, and comes back with somewhere to pay.
   *
   * The request is recorded before the payment link is raised, so a customer
   * who closes the tab at the payment page has still told us they are stuck —
   * which is the more useful half of this for them and for us.
   */
  router.post(
    "/setup-assistance",
    handler(async (req, res) => {
      const input = requestInput.parse(req.body ?? {});
      const entitlement = await resolveEntitlement(req);
      if (!entitlement.userId) throw new WebsiteError(401, "Sign in to ask for setup help.");
      if (input.siteId) await assertWebsiteSiteAccess(req, input.siteId, "manage");

      const user = await prisma.user.findUnique({
        where: { id: entitlement.userId },
        select: { id: true, email: true, name: true },
      });
      if (!user) throw new WebsiteError(401, "Sign in to ask for setup help.");

      const currency: PlanCurrency = resolveCurrency({
        currency: input.currency ?? (entitlement.currency === "USD" ? "USD" : "GHS"),
        country: input.country,
      });
      const price = SETUP_ASSISTANCE[currency];

      const client =
        (await prisma.client.findFirst({ where: { email: user.email } })) ??
        (await prisma.client.create({ data: { name: user.name, email: user.email } }));

      const site = input.siteId
        ? await prisma.site.findUnique({ where: { id: input.siteId }, select: { name: true, publicUrl: true } })
        : null;
      const subject = site?.name ?? input.websiteUrl ?? "a new website";

      const invoice = await createNumberedInvoice((invoiceNumber) =>
        prisma.invoice.create({
          data: {
            clientId: client.id,
            invoiceNumber,
            currency,
            amountTotal: price.amount,
            dueDate: new Date(Date.now() + 7 * 86_400_000),
            lineItems: {
              create: [
                {
                  description: `Website Builder setup assistance — ${ROUTE_LABEL[input.route]} — ${subject}`,
                  quantity: 1,
                  unitPrice: price.amount,
                  amount: price.amount,
                },
              ],
            },
          },
        }),
      );

      // Recorded against the site so whoever picks this up can see which
      // website, which path, and what the customer had already tried.
      if (input.siteId) {
        await prisma.siteAuditEvent.create({
          data: {
            siteId: input.siteId,
            kind: "setup.assistance.requested",
            summary: `Setup assistance requested (${ROUTE_LABEL[input.route]}) — invoice ${invoice.invoiceNumber}`,
            actorName: user.name,
            actorId: user.id,
            detail: { route: input.route, notes: input.notes ?? null, invoiceId: invoice.id },
          },
        });
      }

      let paymentUrl: string | null = null;
      try {
        const payment = await raisePayment(invoice.id, "paystack", {
          callbackUrl: `${(await appUrl()).replace(/\/$/, "")}/website/settings?setup=paid`,
        });
        paymentUrl = payment.url;
      } catch (error) {
        // The request stands whether or not a payment link could be raised —
        // a processor that is unconfigured or refusing must not swallow
        // somebody asking for help.
        console.error("[setup-assistance] could not raise a payment link:", (error as Error).message);
      }

      res.status(201).json({
        ok: true,
        invoiceNumber: invoice.invoiceNumber,
        amount: price.amount,
        currency,
        display: price.display,
        paymentUrl,
        message: paymentUrl
          ? "Pay and we will set it up for you — usually the same working day."
          : "Your request is logged. We will send the payment link and set this up for you — usually the same working day.",
      });
    }),
  );
}
