import type { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { WebsiteError } from "./website/site.js";
import { resolveEntitlement, readUsage, bumpUsage, usagePeriod } from "./websiteEntitlement.js";
import { WEBSITE_TIER_PLANS, tierLabels } from "./websiteTierPlans.js";
import { createNumberedInvoice } from "./invoiceNumber.js";
import { raisePayment } from "./payments.js";
import { appUrl } from "./emailSender.js";
import { websiteSiteFilter } from "./websiteAccess.js";
import { subscriptionManagementLink } from "../lib/paystack.js";

const handler =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export type AddonItem = {
  id: string;
  name: string;
  description: string;
  amount: number;
  currency: string;
  badge: string;
  kind: "ai" | "maintenance" | "seo" | "domain";
};

export const AVAILABLE_ADDONS: AddonItem[] = [
  {
    id: "ai_booster_100",
    name: "AI Prompt Booster (+100 Prompts)",
    description: "Add 100 high-power AI copy and layout generation runs to your account allowance.",
    amount: 150,
    currency: "GHS",
    badge: "Popular",
    kind: "ai",
  },
  {
    id: "maintenance_5h",
    name: "Priority Maintenance Pack (5 Hours)",
    description: "5 hours of hands-on engineering, custom CSS styling, and section updates from our development team.",
    amount: 600,
    currency: "GHS",
    badge: "Best Value",
    kind: "maintenance",
  },
  {
    id: "seo_audit",
    name: "Full SEO & Speed Optimization Audit",
    description: "In-depth Core Web Vitals optimization, meta tags review, structured schema data, and audit report.",
    amount: 450,
    currency: "GHS",
    badge: "Speed Boost",
    kind: "seo",
  },
  {
    id: "domain_email",
    name: "Custom Domain & Professional Email Setup",
    description: "End-to-end domain connection, DNS configuration, SSL provisioning, and Google Workspace email setup.",
    amount: 350,
    currency: "GHS",
    badge: "Setup",
    kind: "domain",
  },
];

async function resolveClientIds(req: Request): Promise<{ clientIds: string[]; primaryClient: { id: string; name: string; email: string | null; company: string | null } | null }> {
  const user = req.dbUser;
  if (!user) return { clientIds: [], primaryClient: null };

  const userEmail = user.email.trim().toLowerCase();

  // 1. Check purchases
  const purchases = await prisma.websitePurchase.findMany({
    where: {
      OR: [{ userId: user.id }, { email: userEmail }],
    },
    select: { clientId: true },
  });

  // 2. Check site memberships
  const siteMembers = await prisma.siteMember.findMany({
    where: { userId: user.id },
    select: { site: { select: { clientId: true } } },
  });

  // 3. Check direct Client rows
  const directClients = await prisma.client.findMany({
    where: {
      OR: [
        { email: userEmail },
        { contacts: { some: { email: userEmail } } },
      ],
    },
    select: { id: true, name: true, email: true, company: true },
  });

  const ids = new Set<string>();
  purchases.forEach((p) => { if (p.clientId) ids.add(p.clientId); });
  siteMembers.forEach((sm) => { if (sm.site?.clientId) ids.add(sm.site.clientId); });
  directClients.forEach((c) => ids.add(c.id));

  // Staff preview / internal admin fallback
  if (ids.size === 0 && (req.permissions?.has("website.manage") || user.accessRole?.superAdmin)) {
    const firstClient = await prisma.client.findFirst({
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, email: true, company: true },
    });
    if (firstClient) {
      ids.add(firstClient.id);
      return { clientIds: [firstClient.id], primaryClient: firstClient };
    }
  }

  const primaryClient = directClients[0] ?? (ids.size > 0 ? await prisma.client.findUnique({
    where: { id: Array.from(ids)[0] },
    select: { id: true, name: true, email: true, company: true },
  }) : null);

  return { clientIds: Array.from(ids), primaryClient };
}

export function registerWebsiteClientPortal(router: Router) {
  /**
   * GET /website/balance
   * Returns current account balance, unpaid/paid invoices, active subscription,
   * care plan retainers, monthly AI and resource counters, and available self-service add-ons.
   */
  router.get(
    "/balance",
    handler(async (req, res) => {
      const user = req.dbUser;
      if (!user) throw new WebsiteError(401, "Sign in to view your balance.");

      const entitlement = await resolveEntitlement(req);
      const { clientIds, primaryClient } = await resolveClientIds(req);

      // Fetch all invoices for these clientIds
      const invoices = clientIds.length > 0
        ? await prisma.invoice.findMany({
            where: { clientId: { in: clientIds } },
            include: {
              lineItems: {
                select: {
                  id: true,
                  description: true,
                  quantity: true,
                  unitPrice: true,
                  amount: true,
                },
              },
              project: { select: { name: true } },
              carePlan: { select: { tier: true } },
            },
            orderBy: [{ dueDate: "desc" }, { createdAt: "desc" }],
          })
        : [];

      // Calculate totals
      let outstandingAmount = 0;
      let paidLifetime = 0;
      let hasOverdue = false;
      let unpaidCount = 0;
      let paidCount = 0;

      const formattedInvoices = invoices.map((inv) => {
        const total = Number(inv.amountTotal);
        const isPaid = inv.status === "PAID";
        const isUnpaid = inv.status === "SENT" || inv.status === "OVERDUE";

        if (isPaid) {
          paidLifetime += total;
          paidCount++;
        } else if (isUnpaid) {
          outstandingAmount += total;
          unpaidCount++;
          if (inv.status === "OVERDUE" || (inv.dueDate && new Date(inv.dueDate).getTime() < Date.now())) {
            hasOverdue = true;
          }
        }

        return {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amountTotal: total,
          currency: inv.currency,
          status: inv.status,
          issueDate: inv.issueDate.toISOString(),
          dueDate: inv.dueDate.toISOString(),
          paidAt: inv.paidAt?.toISOString() ?? null,
          paymentUrl: inv.paymentUrl,
          pdfUrl: inv.pdfUrl,
          paidVia: inv.paidVia,
          projectName: inv.project?.name ?? null,
          carePlanTier: inv.carePlan?.tier ?? null,
          lineItems: inv.lineItems.map((item) => ({
            id: item.id,
            description: item.description,
            quantity: item.quantity,
            unitPrice: Number(item.unitPrice),
            amount: Number(item.amount),
          })),
        };
      });

      // Active Subscription info
      let subscriptionData = null;
      if (entitlement.purchaseId) {
        const purchase = await prisma.websitePurchase.findUnique({
          where: { id: entitlement.purchaseId },
          select: {
            id: true,
            tier: true,
            status: true,
            currency: true,
            monthlyPrice: true,
            billingCycle: true,
            billingState: true,
            nextBillingAt: true,
            providerSubscriptionCode: true,
          },
        });
        if (purchase) {
          let manageUrl: string | null = null;
          if (purchase.providerSubscriptionCode && purchase.billingState !== "CANCELLED") {
            try {
              manageUrl = await subscriptionManagementLink(purchase.providerSubscriptionCode);
            } catch {
              // Graceful fallback if Paystack link cannot be generated offline
            }
          }
          subscriptionData = {
            id: purchase.id,
            tier: purchase.tier,
            tierName: WEBSITE_TIER_PLANS[purchase.tier]?.name ?? purchase.tier,
            monthlyPrice: Number(purchase.monthlyPrice),
            currency: purchase.currency,
            billingCycle: purchase.billingCycle,
            billingState: purchase.billingState,
            status: purchase.status,
            nextBillingAt: purchase.nextBillingAt?.toISOString() ?? null,
            providerSubscriptionCode: purchase.providerSubscriptionCode,
            manageUrl,
          };
        }
      }

      // Active Care Plan info
      let carePlanData = null;
      if (clientIds.length > 0) {
        const carePlan = await prisma.carePlan.findFirst({
          where: {
            clientId: { in: clientIds },
            status: { in: ["ACTIVE", "PAUSED"] },
          },
          select: {
            id: true,
            tier: true,
            monthlyFee: true,
            currency: true,
            includedHours: true,
            status: true,
            billingDay: true,
            nextBillingAt: true,
          },
        });
        if (carePlan) {
          carePlanData = {
            id: carePlan.id,
            tier: carePlan.tier,
            monthlyFee: Number(carePlan.monthlyFee),
            currency: carePlan.currency,
            includedHours: carePlan.includedHours ? Number(carePlan.includedHours) : null,
            status: carePlan.status,
            billingDay: carePlan.billingDay,
            nextBillingAt: carePlan.nextBillingAt?.toISOString() ?? null,
          };
        }
      }

      // Monthly AI & Resource Usage
      const usage = await readUsage(user.id);
      const planDef = WEBSITE_TIER_PLANS[entitlement.tier];
      const promptsLimit = planDef.aiPromptsLimit;
      const promptsRemaining = Math.max(0, promptsLimit - usage.aiPrompts);
      const promptsPercent = promptsLimit > 0 ? Math.min(100, Math.round((usage.aiPrompts / promptsLimit) * 100)) : 100;

      const overallStatus: "CURRENT" | "OUTSTANDING" | "OVERDUE" = hasOverdue
        ? "OVERDUE"
        : outstandingAmount > 0
          ? "OUTSTANDING"
          : "CURRENT";

      const currency = invoices[0]?.currency ?? entitlement.currency ?? "GHS";

      res.json({
        client: primaryClient,
        summary: {
          outstandingAmount,
          paidLifetime,
          currency,
          status: overallStatus,
          unpaidCount,
          paidCount,
        },
        subscription: subscriptionData,
        carePlan: carePlanData,
        aiUsage: {
          enabled: planDef.features.aiAssistant || planDef.features.aiBuilderAgent,
          period: usagePeriod(),
          promptsUsed: usage.aiPrompts,
          promptsLimit,
          promptsRemaining,
          promptsPercent,
          importsUsed: usage.imports,
          importsLimit: planDef.importsLimit,
          editsUsed: usage.edits,
          editsLimit: planDef.editsLimit,
          storageQuotaBytes: planDef.storageQuotaBytes,
          storageQuotaLabel: planDef.storageQuotaLabel,
          tierName: planDef.name,
          canUpgrade: entitlement.tier !== "MANAGED",
        },
        invoices: formattedInvoices,
        availableAddons: AVAILABLE_ADDONS,
      });
    }),
  );

  /**
   * POST /website/balance/request-addon
   * Allows clients to purchase booster packs, maintenance hours, or SEO packages.
   * Generates a numbered invoice and Paystack checkout link for immediate settlement.
   */
  router.post(
    "/balance/request-addon",
    handler(async (req, res) => {
      const user = req.dbUser;
      if (!user) throw new WebsiteError(401, "Sign in to order add-ons.");

      const { addonId, siteId, notes } = z
        .object({
          addonId: z.string().min(1),
          siteId: z.string().optional().nullable(),
          notes: z.string().trim().max(1000).optional(),
        })
        .parse(req.body);

      const addon = AVAILABLE_ADDONS.find((a) => a.id === addonId);
      if (!addon) throw new WebsiteError(404, "Selected add-on not found.");

      // Ensure client record
      let client = await prisma.client.findFirst({ where: { email: user.email.toLowerCase() } });
      if (!client) {
        client = await prisma.client.create({
          data: {
            name: user.name || "Client",
            email: user.email.toLowerCase(),
          },
        });
      }

      // Create Numbered Invoice
      const dueDate = new Date(Date.now() + 7 * 86_400_000);
      const invoice = await createNumberedInvoice((invoiceNumber) =>
        prisma.invoice.create({
          data: {
            clientId: client.id,
            invoiceNumber,
            currency: addon.currency,
            amountTotal: addon.amount,
            status: "SENT",
            dueDate,
            sentAt: new Date(),
            lineItems: {
              create: [
                {
                  description: `${addon.name} — ${addon.description}${notes ? ` (Notes: ${notes})` : ""}`,
                  quantity: 1,
                  unitPrice: addon.amount,
                  amount: addon.amount,
                },
              ],
            },
          },
          include: {
            lineItems: true,
          },
        }),
      );

      // If this was an AI booster pack, immediately grant the prompts to this month's allowance
      // or record in audit log
      if (siteId) {
        await prisma.siteAuditEvent.create({
          data: {
            siteId,
            kind: "BILLING_ADDON",
            summary: `Ordered ${addon.name} — Invoice ${invoice.invoiceNumber}`,
            actorName: user.name,
            actorId: user.id,
            detail: { addonId, amount: addon.amount, invoiceId: invoice.id },
          },
        });
      }

      // Generate payment link via Paystack
      let paymentUrl: string | null = null;
      try {
        const base = await appUrl();
        const callbackUrl = `${base.replace(/\/$/, "")}/website/balance?addon=ordered&inv=${invoice.invoiceNumber}`;
        const payment = await raisePayment(invoice.id, "paystack", { callbackUrl });
        paymentUrl = payment.url;
      } catch (err) {
        console.error("[websiteClientPortal] Could not generate Paystack link:", (err as Error).message);
      }

      res.status(201).json({
        ok: true,
        invoiceNumber: invoice.invoiceNumber,
        amount: addon.amount,
        currency: addon.currency,
        paymentUrl,
        message: paymentUrl
          ? `Invoice ${invoice.invoiceNumber} created. You can complete payment instantly via Mobile Money or Card.`
          : `Invoice ${invoice.invoiceNumber} created. Our team will contact you to confirm settlement.`,
      });
    }),
  );

  /**
   * GET /website/activity
   * Returns a unified, categorized feed of site changes, publishes, AI runs,
   * uploads, and billing events for the client's workspace.
   */
  router.get(
    "/activity",
    handler(async (req, res) => {
      const user = req.dbUser;
      if (!user) throw new WebsiteError(401, "Sign in to view activity.");

      const categoryFilter = typeof req.query.category === "string" ? req.query.category.toLowerCase() : "all";
      const siteIdFilter = typeof req.query.siteId === "string" ? req.query.siteId : null;

      // 1. Accessible sites
      const sites = await prisma.site.findMany({
        where: websiteSiteFilter(req),
        select: { id: true, name: true },
      });
      const siteIds = siteIdFilter ? sites.filter((s) => s.id === siteIdFilter).map((s) => s.id) : sites.map((s) => s.id);
      const siteNameMap = new Map<string, string>(sites.map((s) => [s.id, s.name]));

      // 2. Fetch site audit events
      const siteEvents = siteIds.length > 0
        ? await prisma.siteAuditEvent.findMany({
            where: { siteId: { in: siteIds } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 100,
          })
        : [];

      // 3. Fetch client billing events
      const { clientIds } = await resolveClientIds(req);
      const invoices = clientIds.length > 0 && (categoryFilter === "all" || categoryFilter === "billing")
        ? await prisma.invoice.findMany({
            where: { clientId: { in: clientIds } },
            orderBy: { createdAt: "desc" },
            take: 40,
            select: {
              id: true,
              invoiceNumber: true,
              amountTotal: true,
              currency: true,
              status: true,
              issueDate: true,
              paidAt: true,
              createdAt: true,
            },
          })
        : [];

      type NormalizedActivity = {
        id: string;
        category: "content" | "ai" | "media" | "billing" | "settings" | "team";
        kind: string;
        title: string;
        description: string;
        actorName: string;
        siteName?: string;
        createdAt: string;
        badgeTone: "positive" | "info" | "warn" | "default" | "muted" | "danger";
      };

      const items: NormalizedActivity[] = [];

      // Process Site Audit Events
      for (const ev of siteEvents) {
        let category: NormalizedActivity["category"] = "content";
        let badgeTone: NormalizedActivity["badgeTone"] = "info";

        const kind = ev.kind.toUpperCase();
        if (kind.includes("AI") || kind.includes("ASSISTANT") || kind.includes("AGENT") || kind.includes("SETUP.ASSISTANCE")) {
          category = "ai";
          badgeTone = "info";
        } else if (kind.includes("ASSET") || kind.includes("MEDIA") || kind.includes("IMAGE")) {
          category = "media";
          badgeTone = "muted";
        } else if (kind.includes("SETTING") || kind.includes("CONNECT") || kind.includes("DOMAIN")) {
          category = "settings";
          badgeTone = "warn";
        } else if (kind.includes("MEMBER") || kind.includes("INVITE") || kind.includes("TEAM")) {
          category = "team";
          badgeTone = "warn";
        } else if (kind.includes("BILLING")) {
          category = "billing";
          badgeTone = "positive";
        } else if (kind === "PUBLISH" || kind === "SOURCE_PUBLISH") {
          category = "content";
          badgeTone = "positive";
        } else if (kind === "ROLLBACK") {
          category = "content";
          badgeTone = "warn";
        }

        if (categoryFilter !== "all" && categoryFilter !== category) continue;

        items.push({
          id: `site-ev-${ev.id}`,
          category,
          kind: ev.kind,
          title: ev.summary,
          description: ev.actorName ? `By ${ev.actorName}` : "System action",
          actorName: ev.actorName || "System",
          siteName: siteNameMap.get(ev.siteId) || "Website",
          createdAt: ev.createdAt.toISOString(),
          badgeTone,
        });
      }

      // Process Invoice / Billing events
      for (const inv of invoices) {
        const amountDisplay = `${inv.currency} ${Number(inv.amountTotal).toLocaleString()}`;
        if (inv.paidAt) {
          items.push({
            id: `inv-paid-${inv.id}`,
            category: "billing",
            kind: "INVOICE_PAID",
            title: `Payment received for ${inv.invoiceNumber} (${amountDisplay})`,
            description: `Settled on ${new Date(inv.paidAt).toLocaleDateString()}`,
            actorName: "Paystack",
            createdAt: inv.paidAt.toISOString(),
            badgeTone: "positive",
          });
        }
        items.push({
          id: `inv-created-${inv.id}`,
          category: "billing",
          kind: "INVOICE_ISSUED",
          title: `Invoice ${inv.invoiceNumber} generated (${amountDisplay})`,
          description: `Status: ${inv.status.toLowerCase()}`,
          actorName: "Billing",
          createdAt: inv.createdAt.toISOString(),
          badgeTone: inv.status === "PAID" ? "positive" : inv.status === "OVERDUE" ? "danger" : "info",
        });
      }

      // Sort descending by date
      items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      res.json({
        total: items.length,
        items: items.slice(0, 100),
      });
    }),
  );
}
