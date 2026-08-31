import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { gapsReadyToDecide } from "../services/agents/hiring.js";
import { gateBy } from "../middleware/permissionGate.js";

export const dashboardRouter = Router();

dashboardRouter.use(gateBy({ view: "dashboard.view" }));

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
      // Rehearsals are not pipeline. Counting them would put a number on this
      // screen that no amount of selling produced.
      prisma.lead.groupBy({ by: ["status"], _count: true, where: { rehearsal: false } }),
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

    // Crafts nobody here has, asked for by enough separate agents to be an
    // argument rather than an anecdote. On the revenue dashboard rather than
    // buried on the Agents screen because every one of them is work that
    // stopped: an agent hit a job, found nobody to hand it to, and said so.
    // Read-only — deciding still happens on the Agent Creator's proposal.
    const hiringGaps = await gapsReadyToDecide();

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
      hiringGaps: {
        readyToDecide: hiringGaps.length,
        // The ones with no review open on them are the ones nothing is
        // carrying forward — the Agent Creator is a draft, retired, or its
        // review was cancelled. Named separately because that is a different
        // problem from a gap somebody has simply not decided yet.
        unreviewed: hiringGaps.filter((gap) => gap.reviewTaskId === null).length,
        gaps: hiringGaps,
      },
    });
  } catch (err) {
    next(err);
  }
});
