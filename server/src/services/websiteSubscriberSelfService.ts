import type { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { WebsiteError } from "./website/site.js";
import { cancelWebsiteSubscription } from "./websiteCommerce.js";
import { resolveEntitlement } from "./websiteEntitlement.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";
import { subscriptionManagementLink } from "../lib/paystack.js";

/**
 * What a customer can do about their own subscription and their own data,
 * without asking anybody at Dakyworld to do it for them.
 *
 * Three things, and they are the three a paying customer is entitled to expect:
 * see what they are on, stop paying, and take their content with them or have
 * it deleted. A product that can only be left by emailing the founder is a
 * product people are right not to trust with their website.
 */

const handler =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function registerSubscriberSelfService(router: Router) {
  /** The subscription this account is on, in the words a customer would use. */
  router.get(
    "/subscription",
    handler(async (req, res) => {
      const entitlement = await resolveEntitlement(req);
      const purchase = entitlement.purchaseId
        ? await prisma.websitePurchase.findUnique({
            where: { id: entitlement.purchaseId },
            select: {
              id: true,
              tier: true,
              status: true,
              currency: true,
              monthlyPrice: true,
              standardRecurringPrice: true,
              billingPriceUpdatedAt: true,
              billingState: true,
              billingCycle: true,
              promoEndsAt: true,
              activatedAt: true,
              nextBillingAt: true,
              invoice: { select: { invoiceNumber: true, status: true } },
            },
          })
        : null;
      res.json({
        tier: entitlement.tier,
        source: entitlement.source,
        subscribedAt: entitlement.subscribedAt,
        subscription: purchase,
        /** What it would take to stop, said plainly rather than hidden. */
        cancellation: purchase
          ? {
              cancellable: purchase.status !== "CANCELLED" && purchase.billingState !== "CANCELLING",
              alreadyCancelled: purchase.status === "CANCELLED",
              // What they keep: the period Paystack last billed them to.
              servesUntil: purchase.nextBillingAt,
            }
          : null,
      });
    }),
  );

  router.post(
    "/subscription/cancel",
    handler(async (req, res) => {
      const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
      const entitlement = await resolveEntitlement(req);
      if (!entitlement.purchaseId) throw new WebsiteError(400, "There is no paid subscription on this account to cancel.");
      const cancelled = await cancelWebsiteSubscription({ purchaseId: entitlement.purchaseId, reason });
      res.json({
        ok: true,
        servesUntil: cancelled.servesUntil,
        message: `Your subscription is cancelled. You keep the editor and your website stays online until ${cancelled.servesUntil?.toISOString().slice(0, 10) ?? "the end of the paid period"}, and you will not be charged again.`,
      });
    }),
  );

  router.post("/subscription/manage", handler(async (req, res) => {
    const entitlement = await resolveEntitlement(req);
    if (!entitlement.purchaseId) throw new WebsiteError(404, "No subscription is available to manage.");
    const purchase = await prisma.websitePurchase.findUnique({
      where: { id: entitlement.purchaseId }, select: { providerSubscriptionCode: true, billingState: true },
    });
    if (!purchase?.providerSubscriptionCode || purchase.billingState === "CANCELLED") throw new WebsiteError(409, "No active subscription is available to manage.");
    res.set("Cache-Control", "no-store").json({ url: await subscriptionManagementLink(purchase.providerSubscriptionCode) });
  }));

  /**
   * Everything the OS holds about one website, as a file.
   *
   * Pages, their published and draft content, the version history, the media
   * metadata and the audit trail. Image bytes are left out on purpose — a
   * customer with 500 MB of pictures does not want them base64'd into a JSON
   * file, and each is downloadable from its own address, which the export
   * lists.
   */
  router.get(
    "/sites/:id/export",
    handler(async (req, res) => {
      await assertWebsiteSiteAccess(req, req.params.id!, "manage");
      const site = await prisma.site.findUnique({
        where: { id: req.params.id! },
        select: {
          id: true,
          name: true,
          slug: true,
          publicUrl: true,
          customDomain: true,
          createdAt: true,
          pages: {
            select: {
              path: true,
              title: true,
              filePath: true,
              status: true,
              sourceHtml: true,
              publishedHtml: true,
              draft: true,
              lastPublishedAt: true,
              versions: {
                select: { number: true, html: true, createdAt: true, commitSha: true },
                orderBy: { number: "asc" },
              },
            },
          },
          assets: { select: { id: true, filename: true, contentType: true, size: true, createdAt: true } },
          auditEvents: { select: { kind: true, summary: true, actorName: true, detail: true, createdAt: true }, orderBy: { createdAt: "asc" }, take: 5000 },
          members: { select: { role: true, user: { select: { email: true, name: true } } } },
        },
      });
      if (!site) throw new WebsiteError(404, "No such website.");
      res
        .set("Content-Type", "application/json; charset=utf-8")
        .set("Content-Disposition", `attachment; filename="${site.slug}-export.json"`)
        .set("Cache-Control", "no-store")
        .json({
          exportedAt: new Date().toISOString(),
          site: { id: site.id, name: site.name, slug: site.slug, publicUrl: site.publicUrl, customDomain: site.customDomain, createdAt: site.createdAt },
          pages: site.pages,
          media: site.assets.map((asset) => ({ ...asset, downloadPath: `/api/website/sites/${site.id}/assets/${asset.id}/content` })),
          members: site.members,
          auditTrail: site.auditEvents,
        });
    }),
  );

  /**
   * Deletes a website and everything under it.
   *
   * Typing the site's name is the confirmation, because this cannot be undone
   * and a dialog with a button is not a decision. It refuses while a
   * subscription is still live: somebody who is paying and clicks delete has
   * almost always meant cancel, and the two are one keystroke apart.
   */
  router.post(
    "/sites/:id/erase",
    handler(async (req, res) => {
      await assertWebsiteSiteAccess(req, req.params.id!, "manage");
      const { confirmName } = z.object({ confirmName: z.string().trim().min(1).max(200) }).parse(req.body ?? {});
      const site = await prisma.site.findUnique({ where: { id: req.params.id! }, select: { id: true, name: true } });
      if (!site) throw new WebsiteError(404, "No such website.");
      if (confirmName.trim().toLowerCase() !== site.name.trim().toLowerCase()) {
        throw new WebsiteError(400, `Type the website's name exactly — "${site.name}" — to confirm. Nothing has been deleted.`);
      }
      const entitlement = await resolveEntitlement(req);
      if (entitlement.purchaseId) {
        const live = await prisma.websitePurchase.findFirst({
          where: { id: entitlement.purchaseId, status: { in: ["ACTIVE", "READY"] } },
          select: { id: true },
        });
        if (live) {
          throw new WebsiteError(
            409,
            "Cancel the subscription first. Deleting a website while it is being paid for is almost always a cancellation that was clicked in the wrong place — cancel, and the website stays up until the paid period ends.",
          );
        }
      }
      // Pages, versions, assets, members and audit events all cascade from the
      // site row; see the relations in schema.prisma.
      await prisma.site.delete({ where: { id: site.id } });
      res.json({ ok: true, deleted: site.name });
    }),
  );
}
