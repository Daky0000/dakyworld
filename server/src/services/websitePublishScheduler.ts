/**
 * Scheduled publishing: "publish these changes on Friday at 8am", and
 * optionally "put the page back on Monday" — a promotion that ends by itself.
 *
 * A scheduled publish is the same publish a person's click makes, run later by
 * the worker as the person who scheduled it: `publishPageCommand`, with its
 * conflict checks, version row, publish job and verification. The first
 * version of this file (never reachable: the access gate refused the route)
 * kept jobs in `Site.settings` and, when one was due, called the low-level file
 * writer directly — with a site row missing its repository fields and the
 * page's stored HTML, which is empty for any site that has a repository.
 *
 * Two rules worth keeping:
 *
 * - **What was scheduled is what goes out.** The job records the draft
 *   revision it was made from. If the draft has changed by the time it is due,
 *   it is not published — nobody scheduled those words — and the job says why.
 * - **A revert is "publish this version"** of whatever was live just before, the
 *   same emergency rollback a person can press, so it goes through the same
 *   guards and leaves the same record.
 */

import type { Request, Response, Router } from "express";
import type { ScheduledPublish } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { WITH_ACCESS, effectivePermissions } from "../lib/accessRoles.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";
import { publishPageCommand, publishVersionCommand } from "./websitePagePublication.js";
import type { WebsiteActor } from "./websiteActor.js";
import { WebsiteError } from "./website/site.js";

const MAX_AHEAD_DAYS = 366;

function jobView(job: ScheduledPublish & { createdBy?: { name: string } | null }) {
  return {
    id: job.id,
    pageId: job.pageId,
    status: job.status,
    scheduledAt: job.scheduledAt.toISOString(),
    revertAt: job.revertAt?.toISOString() ?? null,
    notes: job.notes,
    error: job.error,
    executedAt: job.executedAt?.toISOString() ?? null,
    revertedAt: job.revertedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    createdBy: job.createdBy?.name ?? null,
  };
}

const scheduleInput = z.object({
  scheduledAt: z.string().datetime(),
  revertAt: z.string().datetime().optional(),
  notes: z.string().trim().max(300).optional(),
}).superRefine((input, ctx) => {
  const at = new Date(input.scheduledAt).getTime();
  if (at < Date.now() - 60_000) ctx.addIssue({ code: "custom", message: "Choose a time in the future." });
  if (at > Date.now() + MAX_AHEAD_DAYS * 86_400_000) ctx.addIssue({ code: "custom", message: "Schedules can be up to a year ahead." });
  if (input.revertAt && new Date(input.revertAt).getTime() <= at) ctx.addIssue({ code: "custom", message: "The page can only be put back after it has gone out." });
});

export function registerWebsiteSchedulerRoutes(router: Router): void {
  router.post("/pages/:pageId/schedule", async (req: Request, res: Response, next) => {
    try {
      const page = await prisma.sitePage.findUnique({ where: { id: req.params.pageId }, select: { id: true, siteId: true, title: true, draft: true, draftRevision: true } });
      if (!page) throw new WebsiteError(404, "That page is not in the editor.");
      await assertWebsiteSiteAccess(req, page.siteId, "publish");
      const parsed = scheduleInput.safeParse(req.body ?? {});
      if (!parsed.success) throw new WebsiteError(400, parsed.error.issues[0]?.message ?? "Check the date and time.");
      const body = parsed.data;
      if (!page.draft || !Object.keys(page.draft as object).length) throw new WebsiteError(409, "There is nothing to schedule — this page has no unpublished changes.");
      // One scheduled publish per page at a time: a second would publish the
      // same draft twice, or race the first.
      const pending = await prisma.scheduledPublish.findFirst({ where: { pageId: page.id, status: { in: ["PENDING", "RUNNING"] } }, select: { id: true } });
      if (pending) throw new WebsiteError(409, "This page already has a publish scheduled. Cancel that one first.");
      const job = await prisma.scheduledPublish.create({
        data: {
          siteId: page.siteId,
          pageId: page.id,
          scheduledAt: new Date(body.scheduledAt),
          revertAt: body.revertAt ? new Date(body.revertAt) : null,
          draftRevision: page.draftRevision,
          notes: body.notes || null,
          createdById: req.dbUser?.id ?? null,
        },
        include: { createdBy: { select: { name: true } } },
      });
      await prisma.siteAuditEvent.create({
        data: {
          siteId: page.siteId,
          kind: "PUBLISH_SCHEDULED",
          summary: `Scheduled ${page.title} to publish on ${job.scheduledAt.toISOString()}${job.revertAt ? `, back on ${job.revertAt.toISOString()}` : ""}`,
          actorName: req.dbUser?.name ?? "Website editor",
          actorId: req.dbUser?.id,
          detail: { pageId: page.id, jobId: job.id },
        },
      });
      res.status(201).json({ job: jobView(job) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/pages/:pageId/schedule", async (req: Request, res: Response, next) => {
    try {
      const page = await prisma.sitePage.findUnique({ where: { id: req.params.pageId }, select: { id: true, siteId: true } });
      if (!page) throw new WebsiteError(404, "That page is not in the editor.");
      await assertWebsiteSiteAccess(req, page.siteId, "view");
      const jobs = await prisma.scheduledPublish.findMany({ where: { pageId: page.id }, orderBy: { createdAt: "desc" }, take: 20, include: { createdBy: { select: { name: true } } } });
      res.json({ jobs: jobs.map(jobView) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/pages/:pageId/schedule/:jobId", async (req: Request, res: Response, next) => {
    try {
      const page = await prisma.sitePage.findUnique({ where: { id: req.params.pageId }, select: { id: true, siteId: true } });
      if (!page) throw new WebsiteError(404, "That page is not in the editor.");
      await assertWebsiteSiteAccess(req, page.siteId, "publish");
      // Only a job that has not started can be cancelled; an active temporary
      // one is cancelled by stopping its revert, which leaves the page as it is.
      const cancelled = await prisma.scheduledPublish.updateMany({
        where: { id: req.params.jobId, pageId: page.id, status: { in: ["PENDING", "ACTIVE_TEMPORARY"] } },
        data: { status: "CANCELLED" },
      });
      if (!cancelled.count) throw new WebsiteError(409, "That scheduled publish has already run or been cancelled.");
      res.json({ ok: true, cancelledJobId: req.params.jobId });
    } catch (err) {
      next(err);
    }
  });
}

/** The person who scheduled it, as an actor the publish command can check. */
async function actorFor(job: ScheduledPublish): Promise<WebsiteActor | null> {
  if (!job.createdById) return null;
  const user = await prisma.user.findUnique({ where: { id: job.createdById }, include: WITH_ACCESS });
  if (!user?.active) return null;
  return { dbUser: user, permissions: effectivePermissions(user), headers: {} };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "The publish did not happen.";
}

/**
 * Runs what is due. Called by the scheduler on the worker.
 *
 * Each job is claimed with a conditional update before anything happens to it,
 * so two workers — or a tick that overlaps the next — cannot both publish it.
 */
export async function tickScheduledPublishes(now = new Date()): Promise<{ executed: number; reverted: number }> {
  let executed = 0;
  let reverted = 0;

  const due = await prisma.scheduledPublish.findMany({ where: { status: "PENDING", scheduledAt: { lte: now } }, orderBy: { scheduledAt: "asc" }, take: 20 });
  for (const job of due) {
    const claimed = await prisma.scheduledPublish.updateMany({ where: { id: job.id, status: "PENDING" }, data: { status: "RUNNING" } });
    if (!claimed.count) continue;
    try {
      const page = await prisma.sitePage.findUnique({ where: { id: job.pageId }, select: { draftRevision: true, draft: true } });
      if (!page) throw new Error("The page is no longer in the editor.");
      if (page.draftRevision !== job.draftRevision) throw new Error("The draft changed after it was scheduled, so it was not published. Schedule it again.");
      const actor = await actorFor(job);
      if (!actor) throw new Error("The person who scheduled this no longer has an active account.");
      const before = await prisma.sitePageVersion.findFirst({ where: { pageId: job.pageId }, orderBy: { number: "desc" }, select: { id: true } });
      const result = await publishPageCommand(actor, { pageId: job.pageId, body: { ifRevision: job.draftRevision } }) as { version?: number };
      const published = typeof result?.version === "number"
        ? await prisma.sitePageVersion.findFirst({ where: { pageId: job.pageId, number: result.version }, select: { id: true } })
        : null;
      await prisma.scheduledPublish.update({
        where: { id: job.id },
        data: {
          status: job.revertAt ? "ACTIVE_TEMPORARY" : "COMPLETED",
          executedAt: new Date(),
          revertToVersionId: before?.id ?? null,
          publishedVersionId: published?.id ?? null,
          error: null,
        },
      });
      executed++;
    } catch (error) {
      await prisma.scheduledPublish.update({ where: { id: job.id }, data: { status: "FAILED", error: reason(error) } });
      await prisma.siteAuditEvent.create({ data: { siteId: job.siteId, kind: "PUBLISH_SCHEDULE_FAILED", summary: `A scheduled publish did not go out: ${reason(error)}`.slice(0, 500), actorName: "Scheduler", detail: { pageId: job.pageId, jobId: job.id } } }).catch(() => {});
    }
  }

  const ending = await prisma.scheduledPublish.findMany({ where: { status: "ACTIVE_TEMPORARY", revertAt: { lte: now } }, orderBy: { revertAt: "asc" }, take: 20 });
  for (const job of ending) {
    const claimed = await prisma.scheduledPublish.updateMany({ where: { id: job.id, status: "ACTIVE_TEMPORARY" }, data: { status: "REVERTING" } });
    if (!claimed.count) continue;
    try {
      if (!job.revertToVersionId) throw new Error("There was no earlier version to put back.");
      const actor = await actorFor(job);
      if (!actor) throw new Error("The person who scheduled this no longer has an active account.");
      await publishVersionCommand(actor, { pageId: job.pageId, versionId: job.revertToVersionId });
      await prisma.scheduledPublish.update({ where: { id: job.id }, data: { status: "REVERTED", revertedAt: new Date(), error: null } });
      reverted++;
    } catch (error) {
      await prisma.scheduledPublish.update({ where: { id: job.id }, data: { status: "FAILED", error: `Putting the page back did not happen: ${reason(error)}` } });
      await prisma.siteAuditEvent.create({ data: { siteId: job.siteId, kind: "PUBLISH_REVERT_FAILED", summary: `A scheduled revert did not happen: ${reason(error)}`.slice(0, 500), actorName: "Scheduler", detail: { pageId: job.pageId, jobId: job.id } } }).catch(() => {});
    }
  }

  return { executed, reverted };
}
