import { createHash, randomUUID } from "node:crypto";
import type { Request, Router } from "express";
import { Prisma, type WebsiteWorkJob } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { capacity, CapacityError } from "../lib/capacity.js";
import { effectivePermissions } from "../lib/accessRoles.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";
import { WebsiteError } from "./website/site.js";
import { resolveEntitlement, usagePeriod } from "./websiteEntitlement.js";
import { WEBSITE_TIER_PLANS } from "./websiteTierPlans.js";
import { withWebsiteWork, WorkCancelledError, UncertainExternalError } from "../lib/websiteWorkContext.js";
import { editingLockedForNonPayment } from "./websiteDunning.js";
import { backgroundRunAllowed } from "../lib/backgroundOwnership.js";
import { SESSION_USER } from "../lib/userSelect.js";

export type WebsiteWorkKind = "ASSISTANT" | "BUILDER_PLAN" | "PUBLISH_PAGE" | "PUBLISH_SHARED" | "PUBLISH_VERSION" | "PUBLISH_BATCH";
const aiKinds = ["ASSISTANT", "BUILDER_PLAN"];
const publishKinds = ["PUBLISH_PAGE", "PUBLISH_SHARED", "PUBLISH_VERSION", "PUBLISH_BATCH"];
const isPublish = (kind: string) => publishKinds.includes(kind);
export async function enqueueWebsiteWork(req: Request, siteId: string, kind: WebsiteWorkKind, input: unknown) {
  const isAi = !isPublish(kind);
  await assertWebsiteSiteAccess(req, siteId, isAi ? "edit" : "publish");
  const userId = req.dbUser!.id;
  const entitlement = await resolveEntitlement(req);
  if (await editingLockedForNonPayment(entitlement.purchaseId)) throw new WebsiteError(403, "Editing is paused until the subscription payment is resolved.");
  if (entitlement.userId !== userId) throw new WebsiteError(409, "Sign in as this account before submitting queued work.");
  const plan = WEBSITE_TIER_PLANS[entitlement.tier];
  if (isAi && !plan.features[kind === "ASSISTANT" ? "aiAssistant" : "aiBuilderAgent"]) throw new WebsiteError(403, "Your plan does not include this AI feature.");
  const idempotencyKey = req.get("Idempotency-Key");
  if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) throw new WebsiteError(400, "A valid Idempotency-Key is required.");
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 256 * 1024) throw new WebsiteError(413, "Choose a smaller page or instruction.");
  const inputHash = createHash("sha256").update(`${siteId}:${kind}:${serialized}`).digest("hex");
  return prisma.$transaction(async tx => {
    // One short admission transaction reserves both the daily quota and a queue position.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(942611)`;
    const prior = await tx.websiteWorkJob.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
    if (prior) {
      if (prior.inputHash !== inputHash) throw new WebsiteError(409, "This submission key already belongs to another request.");
      return { queued: true as const, jobId: prior.id, siteId, state: prior.state };
    }
    if (isAi && Number(process.env.RAILWAY_PROJECTED_MONTHLY_USD ?? 0) >= 45) throw new CapacityError("New AI jobs are paused by the hosting budget. Editing remains available.", 429, 3600);
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    const [daily, pending, ownPending] = await Promise.all([
      tx.websiteWorkJob.count({ where: { userId, kind: { in: aiKinds }, createdAt: { gte: day } } }),
      tx.websiteWorkJob.count({ where: { state: "QUEUED", kind: { in: isAi ? aiKinds : publishKinds } } }),
      tx.websiteWorkJob.count({ where: { userId, state: "QUEUED", kind: { in: isAi ? aiKinds : publishKinds } } }),
    ]);
    if (isAi && daily >= capacity.dailyJobs) throw new CapacityError("Your daily AI allowance is used. Ordinary editing remains available.", 429, Math.ceil((day.getTime() + 86_400_000 - Date.now()) / 1000));
    const budgetLimit = Number(process.env.RAILWAY_PROJECTED_MONTHLY_USD ?? 0) >= 40 ? Math.floor(capacity.pendingJobs / 2) : capacity.pendingJobs;
    if (pending >= (isAi ? budgetLimit : 200) || ownPending >= 2) throw new CapacityError(`${isAi ? "The AI" : "The publishing"} queue is full. Please try again later.`);
    if (isAi) {
    const period = usagePeriod();
    const usage = await tx.websiteUsage.upsert({ where: { userId_period: { userId, period } }, create: { userId, period }, update: {} });
    if (usage.aiPrompts >= plan.aiPromptsLimit) throw new CapacityError("Your monthly AI allowance is used.", 429, 3600);
    await tx.websiteUsage.update({ where: { id: usage.id }, data: { aiPrompts: { increment: 1 } } });
    }
    const job = await tx.websiteWorkJob.create({ data: { userId, siteId, kind, idempotencyKey, inputHash,
      usagePeriod: isAi ? usagePeriod() : null, usageState: isAi ? "RESERVED" : "NONE", input: JSON.parse(serialized) as Prisma.InputJsonValue } });
    return { queued: true as const, jobId: job.id, siteId, state: job.state };
  });
}

async function jobPrincipal(job: WebsiteWorkJob) {
  const selected = await prisma.user.findUnique({ where: { id: job.userId }, select: SESSION_USER });
  const user = selected ? { ...selected, passwordHash: null, totpSecret: null, totpLastStep: null, totpRecoveryHashes: [] } : null;
  if (!user?.active) throw new WebsiteError(403, "This account no longer has access.");
  const req = { dbUser: user, permissions: effectivePermissions(user), headers: {}, params: { siteId: job.siteId } } as unknown as Request;
  await assertWebsiteSiteAccess(req, job.siteId, isPublish(job.kind) ? "publish" : "edit");
  const entitlement = await resolveEntitlement(req);
  if (await editingLockedForNonPayment(entitlement.purchaseId)) throw new WebsiteError(403, "Editing is paused until the subscription payment is resolved.");
  if (!isPublish(job.kind) && !WEBSITE_TIER_PLANS[entitlement.tier].features[job.kind === "ASSISTANT" ? "aiAssistant" : "aiBuilderAgent"]) throw new WebsiteError(403, "This account no longer has the required AI feature.");
  return req;
}

export function registerWebsiteWorkQueue(router: Router) {
  router.get("/sites/:siteId/work-jobs/:jobId", async (req, res, next) => {
    try {
      await assertWebsiteSiteAccess(req, req.params.siteId, "view");
      const job = await prisma.websiteWorkJob.findFirst({ where: { id: req.params.jobId, siteId: req.params.siteId, userId: req.dbUser!.id } });
      if (!job) throw new WebsiteError(404, "That job is not available.");
      res.json({ id: job.id, state: job.state, result: job.state === "COMPLETED" ? job.result : null,
        failure: ["FAILED", "RECONCILIATION_REQUIRED"].includes(job.state) ? job.result : null,
        error: job.error, createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt });
    } catch (error) { next(error); }
  });
  router.post("/sites/:siteId/work-jobs/:jobId/cancel", async (req, res, next) => {
    try {
      await assertWebsiteSiteAccess(req, req.params.siteId, "edit");
      const where = { id: req.params.jobId, siteId: req.params.siteId, userId: req.dbUser!.id };
      await prisma.$transaction(async tx => {
        const job = await tx.websiteWorkJob.findFirst({ where });
        if (!job) throw new WebsiteError(404, "That job is not available.");
        const cancelled = await tx.websiteWorkJob.updateMany({ where: { ...where, state: "QUEUED" }, data: { state: "CANCELLED", cancelRequested: true, completedAt: new Date() } });
        if (cancelled.count) await settleWebsiteUsage(tx, job.id, false);
        await tx.websiteWorkJob.updateMany({ where: { ...where, state: "RUNNING" }, data: { cancelRequested: true } });
      });
      res.json({ cancelled: true, message: "Queued work is cancelled. Any provider call already running may still be charged; its result will be discarded." });
    } catch (error) { next(error); }
  });
}

export async function claimWebsiteWork(owner: string): Promise<WebsiteWorkJob | null> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(942612)`;
    // An interrupted request may have reached the provider. Never automatically charge again.
    const expired = await tx.websiteWorkJob.findMany({ where: { state: "RUNNING", leaseUntil: { lt: new Date() } } });
    for (const job of expired) {
      const safeRetry = !job.externalStartedAt && !job.cancelRequested && job.attempts < 3;
      await tx.websiteWorkJob.update({ where: { id: job.id }, data: {
        state: safeRetry ? "QUEUED" : job.externalStartedAt ? "RECONCILIATION_REQUIRED" : job.cancelRequested ? "CANCELLED" : "FAILED",
        error: safeRetry ? null : job.externalStartedAt ? "The worker stopped during external execution. Review provider and source records before submitting again." : "The worker stopped before execution; its reserved allowance was released.",
        completedAt: safeRetry ? null : new Date(), leaseOwner: null, leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + 5000 * 2 ** job.attempts),
      } });
      if (!safeRetry && !job.externalStartedAt) await settleWebsiteUsage(tx, job.id, false);
    }
    const running = await tx.websiteWorkJob.findMany({ where: { state: "RUNNING" }, select: { userId: true, siteId: true, kind: true } });

    const siteCounts = new Map<string, number>();
    for (const job of running) siteCounts.set(job.siteId, (siteCounts.get(job.siteId) ?? 0) + 1);
    // Oldest waiting site first; a busy customer cannot occupy every slot.
    const candidates = await tx.websiteWorkJob.findMany({ where: { state: "QUEUED", nextAttemptAt: { lte: new Date() },
      userId: { notIn: running.map(j => j.userId) }, siteId: { notIn: [...siteCounts].filter(([, n]) => n >= 2).map(([id]) => id) } },
      orderBy: { createdAt: "asc" }, take: capacity.pendingJobs });
    const runnable = candidates.filter(job => isPublish(job.kind) ? running.filter(row => isPublish(row.kind)).length < 2 && !running.some(row => isPublish(row.kind) && row.siteId === job.siteId) : running.filter(row => !isPublish(row.kind)).length < capacity.aiConcurrency);
    const candidate = runnable.sort((a, b) => (siteCounts.get(a.siteId) ?? 0) - (siteCounts.get(b.siteId) ?? 0) || a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (!candidate) return null;
    return tx.websiteWorkJob.update({ where: { id: candidate.id }, data: { state: "RUNNING", startedAt: new Date(), attempts: { increment: 1 }, leaseOwner: owner, leaseUntil: new Date(Date.now() + 120_000) } });
  });
}

async function execute(job: WebsiteWorkJob) {
  const req = await jobPrincipal(job);
  if (job.kind === "PUBLISH_SHARED") {
    const input = job.input as { sharedId: string; body: unknown };
    const element = await prisma.sharedElement.findFirst({ where: { id: input.sharedId, siteId: job.siteId }, select: { id: true } });
    if (!element) throw new WebsiteError(404, "That shared element is not available.");
    req.params = { sharedId: element.id }; req.body = input.body;
    const { executeSharedPublish } = await import("./websiteShared.js");
    return executeSharedPublish(req);
  }
  if (job.kind === "PUBLISH_VERSION") {
    const input = job.input as { pageId: string; versionId: string; body: unknown };
    const page = await prisma.sitePage.findFirst({ where: { id: input.pageId, siteId: job.siteId }, select: { id: true } });
    if (!page) throw new WebsiteError(404, "That page is not available.");
    const { publishVersionCommand } = await import("./websitePagePublication.js");
    return publishVersionCommand(req, { pageId: page.id, versionId: input.versionId, body: input.body });
  }
  if (job.kind === "PUBLISH_BATCH") {
    req.body = job.input;
    const { executeBatchPublish } = await import("./websiteBuilderAgent.js");
    const site = await prisma.site.findUniqueOrThrow({ where: { id: job.siteId } });
    return executeBatchPublish(req, site);
  }
  if (job.kind === "PUBLISH_PAGE") {
    const input = job.input as { pageId: string; body: unknown };
    const page = await prisma.sitePage.findFirst({ where: { id: input.pageId, siteId: job.siteId }, select: { id: true } });
    if (!page) throw new WebsiteError(404, "That page is not available.");
    const { publishPageCommand } = await import("./websitePagePublication.js");
    return publishPageCommand(req, { pageId: page.id, body: input.body });
  }
  if (job.kind === "ASSISTANT") {
    const { executeQueuedAssistant } = await import("./websiteAssistant.js");
    return executeQueuedAssistant(req, job.siteId, job.input);
  }
  if (job.kind === "BUILDER_PLAN") {
    const { executeBuilderPlan } = await import("./websiteBuilderAgent.js");
    const site = await prisma.site.findUniqueOrThrow({ where: { id: job.siteId } });
    return executeBuilderPlan(site, job.input);
  }
  throw new WebsiteError(400, "Unsupported job type.");
}

export async function runWebsiteWork(job: WebsiteWorkJob) {
  let finishing = false;
  const timer = setInterval(() => {
    const deadline = setTimeout(() => { if (!finishing) process.exit(1); }, 30_000);
    void prisma.websiteWorkJob.updateMany({ where: { id: job.id, leaseOwner: job.leaseOwner, state: "RUNNING" }, data: { leaseUntil: new Date(Date.now() + 120_000) } })
      .then(result => { if (!result.count && !finishing) process.exit(1); }).catch(() => { if (!finishing) process.exit(1); }).finally(() => clearTimeout(deadline));
  }, 30_000);
  timer.unref();
  try {
    const value = await withWebsiteWork({ jobId: job.id, leaseOwner: job.leaseOwner!, authorize: () => jobPrincipal(job) }, () => execute(job));
    finishing = true; clearInterval(timer);
    await jobPrincipal(job); // Membership may have been revoked during the provider call.
    await prisma.$transaction(async tx => {
      const completed = await tx.websiteWorkJob.updateMany({ where: { id: job.id, leaseOwner: job.leaseOwner, state: "RUNNING", cancelRequested: false }, data: {
        state: "COMPLETED", completedAt: new Date(), leaseOwner: null, leaseUntil: null,
        result: JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue,
      } });
      const cancelled = await tx.websiteWorkJob.updateMany({ where: { id: job.id, leaseOwner: job.leaseOwner, state: "RUNNING", cancelRequested: true }, data: {
        state: "CANCELLED", completedAt: new Date(), leaseOwner: null, leaseUntil: null, result: Prisma.DbNull,
      } });
      if (completed.count || cancelled.count) await settleWebsiteUsage(tx, job.id, true);
    });
  } catch (error) {
    finishing = true; clearInterval(timer);
    const current = await prisma.websiteWorkJob.findUniqueOrThrow({ where: { id: job.id } });
    const retry = !current.externalStartedAt && !current.cancelRequested && error instanceof CapacityError && job.attempts < 3;
    const cancelled = current.cancelRequested || error instanceof WorkCancelledError;
    const uncertain = Boolean(current.externalStartedAt) && !cancelled;
    const message = error instanceof WebsiteError || error instanceof CapacityError || error instanceof WorkCancelledError || error instanceof UncertainExternalError
      ? error.message : "Generation failed. Review usage before trying again.";
    const failure = { status: uncertain ? 409 : error instanceof WebsiteError || error instanceof CapacityError ? error.status : 503,
      error: message, ...(error instanceof WebsiteError ? Object.fromEntries(["problems", "conflicts", "missing"].filter(key => key in error).map(key => [key, (error as unknown as Record<string, unknown>)[key]])) : {}) };
    const serializedFailure = JSON.stringify(failure);
    await prisma.$transaction(async tx => {
      const changed = await tx.websiteWorkJob.updateMany({ where: { id: job.id, leaseOwner: job.leaseOwner, state: "RUNNING" }, data: {
        state: retry ? "QUEUED" : cancelled ? "CANCELLED" : uncertain ? "RECONCILIATION_REQUIRED" : "FAILED",
        nextAttemptAt: new Date(Date.now() + 5000 * 2 ** job.attempts),
        error: message,
        result: retry ? Prisma.DbNull : JSON.parse(Buffer.byteLength(serializedFailure) <= 256 * 1024 ? serializedFailure : JSON.stringify({ status: failure.status, error: message })) as Prisma.InputJsonValue,
        completedAt: retry ? null : new Date(), leaseOwner: null, leaseUntil: null,
      } });
      if (changed.count && !retry && !uncertain) await settleWebsiteUsage(tx, job.id, Boolean(current.externalStartedAt));
    });
  } finally { clearInterval(timer); }
}

/** Settle once in the same transaction as a terminal state; refunds never race cancellation. */
export async function settleWebsiteUsage(tx: Prisma.TransactionClient, jobId: string, used: boolean) {
  const job = await tx.websiteWorkJob.findUniqueOrThrow({ where: { id: jobId } });
  if (job.usageState !== "RESERVED" || !job.usagePeriod) return;
  const changed = await tx.websiteWorkJob.updateMany({ where: { id: jobId, usageState: "RESERVED" },
    data: { usageState: used ? "ACCOUNTED" : "RELEASED" } });
  if (changed.count && !used) await tx.websiteUsage.updateMany({
    where: { userId: job.userId, period: job.usagePeriod, aiPrompts: { gt: 0 } }, data: { aiPrompts: { decrement: 1 } },
  });
}

export function startWebsiteWorkQueue() {
  const owner = randomUUID();
  let polling = false;
  let stopped = false;
  let claiming: Promise<unknown> | undefined;
  const active = new Set<Promise<void>>();
  const timer = setInterval(() => {
    if (stopped || !backgroundRunAllowed() || polling || active.size >= capacity.aiConcurrency + 2) return;
    polling = true;
    claiming = claimWebsiteWork(owner).then(job => {
      if (!job) return;
      const task = runWebsiteWork(job).catch(() => undefined).finally(() => active.delete(task));
      active.add(task);
    }).catch(() => undefined).finally(() => { polling = false; });
  }, 1000);
  return async () => { stopped = true; clearInterval(timer); await claiming; await Promise.allSettled(active); };
}
