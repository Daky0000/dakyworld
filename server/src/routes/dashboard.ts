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

    res.json({
      revenueThisMonth: invoicesThisMonth._sum.amountTotal ?? 0,
      monthlyRecurringRevenue: activeCarePlans._sum.monthlyFee ?? 0,
      activeCarePlanCount: activeCarePlans._count,
      outstandingInvoiceTotal: outstandingInvoices._sum.amountTotal ?? 0,
      outstandingInvoiceCount: outstandingInvoices._count,
      pipelineValue: openProposals._sum.priceAmount ?? 0,
      openProposalCount: openProposals._count,
      leadsByStatus,
    });
  } catch (err) {
    next(err);
  }
});
