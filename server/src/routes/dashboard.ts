import { Router } from "express";
import { prisma } from "../lib/prisma.js";

export const dashboardRouter = Router();

// GET /api/dashboard — the "Revenue Dashboard" workflow: total revenue this
// month, recurring revenue, outstanding invoices, pipeline value, all
// computed live (no manual reporting).
dashboardRouter.get("/", async (_req, res, next) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
    const quarterAgo = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());

    const [invoicesThisMonth, activeCarePlans, outstandingInvoices, openProposals, leadsByStatus] = await Promise.all([
      prisma.invoice.aggregate({
        where: { status: "PAID", paidAt: { gte: monthStart } },
        _sum: { amountTotal: true },
      }),
      prisma.carePlan.aggregate({
        where: { status: "ACTIVE" },
        _sum: { monthlyFee: true },
        _count: true,
      }),
      prisma.invoice.aggregate({
        where: { status: { in: ["SENT", "VIEWED", "OVERDUE"] } },
        _sum: { amountTotal: true },
        _count: true,
      }),
      prisma.proposal.aggregate({
        where: { status: { in: ["DRAFT", "SENT", "VIEWED"] } },
        _sum: { priceAmount: true },
        _count: true,
      }),
      prisma.lead.groupBy({ by: ["status"], _count: true }),
    ]);

    // Retainer health. MRR alone says nothing about whether it is about to
    // stop — a paused plan, an overdue review and a draft invoice nobody sent
    // are each a month of revenue quietly not happening.
    const [pausedPlans, churnedThisQuarter, billingSoon, reviewsDue, draftCarePlanInvoices, nextBilling] = await Promise.all([
      prisma.carePlan.count({ where: { status: "PAUSED" } }),
      prisma.carePlan.count({ where: { status: "CHURNED", churnedAt: { gte: quarterAgo } } }),
      prisma.carePlan.count({ where: { status: "ACTIVE", nextBillingAt: { lte: weekAhead } } }),
      prisma.carePlan.count({ where: { status: "ACTIVE", nextReviewAt: { lte: now } } }),
      prisma.invoice.count({ where: { status: "DRAFT", carePlanId: { not: null } } }),
      prisma.carePlan.findFirst({
        where: { status: "ACTIVE", nextBillingAt: { not: null } },
        orderBy: { nextBillingAt: "asc" },
        include: { client: { select: { name: true } } },
      }),
    ]);

    res.json({
      revenueThisMonth: invoicesThisMonth._sum.amountTotal ?? 0,
      monthlyRecurringRevenue: activeCarePlans._sum.monthlyFee ?? 0,
      activeCarePlanCount: activeCarePlans._count,
      outstandingInvoiceTotal: outstandingInvoices._sum.amountTotal ?? 0,
      outstandingInvoiceCount: outstandingInvoices._count,
      pipelineValue: openProposals._sum.priceAmount ?? 0,
      openProposalCount: openProposals._count,
      leadsByStatus,
      carePlans: {
        active: activeCarePlans._count,
        paused: pausedPlans,
        churnedThisQuarter,
        billingWithin7Days: billingSoon,
        reviewsDue,
        draftInvoices: draftCarePlanInvoices,
        nextBilling: nextBilling
          ? {
              id: nextBilling.id,
              client: nextBilling.client.name,
              at: nextBilling.nextBillingAt,
              amount: nextBilling.monthlyFee,
              currency: nextBilling.currency,
            }
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
});
