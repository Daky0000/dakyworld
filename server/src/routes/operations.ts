import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { settleWebsiteUsage } from "../services/websiteWorkQueue.js";
import { WebsiteError } from "../services/website/site.js";

export const operationsRouter = Router();
operationsRouter.use((req, res, next) => {
  if (!req.dbUser?.accessRole?.superAdmin) { res.status(403).json({ error: "Owner access required." }); return; }
  next();
});
operationsRouter.get("/work-jobs", async (req, res, next) => {
  try {
    const input = z.object({ cursor: z.string().optional(), state: z.enum(["QUEUED", "RUNNING", "FAILED", "RECONCILIATION_REQUIRED"]).default("RECONCILIATION_REQUIRED") }).parse(req.query);
    const items = await prisma.websiteWorkJob.findMany({ where: { state: input.state }, take: 26,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}), orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, userId: true, siteId: true, kind: true, state: true, usageState: true, actualCostUsd: true,
        externalStartedAt: true, attempts: true, error: true, createdAt: true, startedAt: true } });
    res.json({ items: items.slice(0, 25), nextCursor: items.length > 25 ? items[24]!.id : null });
  } catch (error) { next(error); }
});
operationsRouter.get("/capacity", async (_req, res, next) => {
  try {
    const [jobs, pendingInvalidations, oldestInvalidation, oldestJob] = await Promise.all([
      prisma.websiteWorkJob.groupBy({ by: ["kind", "state"], _count: true }),
      prisma.cacheInvalidation.count({ where: { deliveredAt: null } }),
      prisma.cacheInvalidation.findFirst({ where: { deliveredAt: null }, orderBy: { createdAt: "asc" }, select: { createdAt: true, attempts: true, lastError: true } }),
      prisma.websiteWorkJob.findFirst({ where: { state: "QUEUED" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    ]);
    res.json({ jobs, pendingInvalidations, oldestInvalidation, oldestJob });
  } catch (error) { next(error); }
});
operationsRouter.post("/work-jobs/:jobId/reconcile", async (req, res, next) => {
  try {
    const body = z.object({ outcome: z.enum(["NOT_EXECUTED", "EXECUTED"]), action: z.enum(["FAIL", "RETRY"]).default("FAIL"),
      evidence: z.string().trim().min(20).max(2000) }).parse(req.body);
    const job = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(942612)`;
      const current = await tx.websiteWorkJob.findUnique({ where: { id: req.params.jobId } });
      if (!current || current.state !== "RECONCILIATION_REQUIRED") throw new WebsiteError(409, "Only interrupted work awaiting reconciliation can be resolved.");
      if (body.outcome === "NOT_EXECUTED" && Number(current.actualCostUsd) > 0) throw new WebsiteError(409, "Recorded provider charges contradict this outcome. Review the provider evidence.");
      if (body.action === "RETRY" && (body.outcome !== "NOT_EXECUTED" || current.attempts >= 3 || current.cancelRequested)) throw new WebsiteError(409, "Retry requires proof that no action ran, fewer than three attempts, and no cancellation.");
      const retry = body.action === "RETRY";
      const updated = await tx.websiteWorkJob.update({ where: { id: current.id }, data: {
        state: retry ? "QUEUED" : "FAILED", leaseOwner: null, leaseUntil: null,
        externalStartedAt: retry ? null : current.externalStartedAt, nextAttemptAt: new Date(),
        completedAt: retry ? null : new Date(), error: retry ? null : body.outcome === "EXECUTED"
          ? "An external action ran, but its result was not recovered. Your manager has checked the provider records; this job will not run again."
          : "Your manager confirmed that no external action ran. The reserved allowance was released.",
      } });
      if (!retry) await settleWebsiteUsage(tx, current.id, body.outcome === "EXECUTED");
      const site = await tx.site.findUnique({ where: { id: current.siteId }, select: { id: true } });
      if (site) await tx.siteAuditEvent.create({ data: { siteId: site.id, kind: "WORK_RECONCILIATION",
        actorId: req.dbUser!.id, actorName: req.dbUser!.name, summary: `Reconciled ${current.kind} work: ${body.outcome}`,
        detail: { jobId: current.id, action: body.action, evidence: body.evidence } } });
      return { id: updated.id, state: updated.state };
    });
    res.json(job);
  } catch (error) { next(error); }
});
