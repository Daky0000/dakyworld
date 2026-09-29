/**
 * websitePublishScheduler.ts — Scheduled & Temporary Publishing.
 *
 * Supports scheduling page publications (e.g. "Publish October 1 at 8:00 AM")
 * and temporary promotional updates that automatically revert (e.g. "Revert October 31").
 */

import { randomUUID } from "node:crypto";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { publishPage } from "./website/site.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";
import { applyValues, editingSource, fieldValues, type FieldValue } from "./website/index.js";

export type ScheduledPublishJob = {
  id: string;
  siteId: string;
  pageId: string;
  pageTitle: string;
  status: "PENDING" | "ACTIVE_TEMPORARY" | "COMPLETED" | "REVERTED" | "FAILED" | "CANCELLED";
  scheduledAt: string; // ISO date
  revertAt?: string;   // optional auto-revert ISO date
  draftSnapshot: Record<string, FieldValue>;
  revertSnapshot?: {
    html: string;
    versionNumber: number;
  };
  notes?: string;
  executedAt?: string;
  revertedAt?: string;
  error?: string;
  createdAt: string;
  createdBy: string;
};

function readScheduledJobs(settings: unknown): ScheduledPublishJob[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
  const s = settings as Record<string, unknown>;
  return Array.isArray(s.scheduledPublishJobs) ? (s.scheduledPublishJobs as ScheduledPublishJob[]) : [];
}

export function registerWebsiteSchedulerRoutes(router: Router): void {
  // 1. Create a Scheduled Publish
  router.post("/pages/:pageId/schedule", async (req: Request, res: Response, next) => {
    try {
      const page = await prisma.sitePage.findUnique({
        where: { id: req.params.pageId },
        include: { site: true, versions: { orderBy: { number: "desc" }, take: 1 } },
      });
      if (!page) return res.status(404).json({ error: "Page not found" });
      await assertWebsiteSiteAccess(req, page.siteId, "publish");

      const body = z.object({
        scheduledAt: z.string().datetime(),
        revertAt: z.string().datetime().optional(),
        notes: z.string().max(300).optional(),
      }).parse(req.body);

      const draft = (page.draft ?? {}) as Record<string, FieldValue>;
      if (Object.keys(draft).length === 0) {
        return res.status(400).json({ error: "Cannot schedule publish with no draft changes." });
      }

      const existingJobs = readScheduledJobs(page.site.settings);
      const newJob: ScheduledPublishJob = {
        id: randomUUID(),
        siteId: page.siteId,
        pageId: page.id,
        pageTitle: page.title,
        status: "PENDING",
        scheduledAt: body.scheduledAt,
        revertAt: body.revertAt,
        draftSnapshot: draft,
        notes: body.notes,
        createdAt: new Date().toISOString(),
        createdBy: req.dbUser?.name || "Editor",
      };

      const updatedJobs = [newJob, ...existingJobs.filter(j => j.status !== "PENDING" || j.pageId !== page.id)].slice(0, 50);

      const nextSettings = {
        ...(typeof page.site.settings === "object" && page.site.settings !== null ? page.site.settings : {}),
        scheduledPublishJobs: updatedJobs,
      };

      await prisma.site.update({
        where: { id: page.siteId },
        data: { settings: nextSettings as any },
      });

      await prisma.siteAuditEvent.create({
        data: {
          siteId: page.siteId,
          kind: "PUBLISH_SCHEDULED",
          summary: `Publish scheduled for ${page.title} on ${new Date(body.scheduledAt).toLocaleString()}${body.revertAt ? ` (auto-reverts on ${new Date(body.revertAt).toLocaleString()})` : ""}`,
          actorName: req.dbUser?.name || "Editor",
          actorId: req.dbUser?.id,
          detail: { jobId: newJob.id, pageId: page.id, scheduledAt: body.scheduledAt, revertAt: body.revertAt },
        },
      });

      res.status(201).json({ job: newJob });
    } catch (err) {
      next(err);
    }
  });

  // 2. List Scheduled Publishes
  router.get("/pages/:pageId/schedule", async (req: Request, res: Response, next) => {
    try {
      const page = await prisma.sitePage.findUnique({
        where: { id: req.params.pageId },
        include: { site: true },
      });
      if (!page) return res.status(404).json({ error: "Page not found" });
      await assertWebsiteSiteAccess(req, page.siteId, "view");

      const jobs = readScheduledJobs(page.site.settings).filter(j => j.pageId === page.id);
      res.json({ jobs });
    } catch (err) {
      next(err);
    }
  });

  // 3. Cancel Scheduled Publish
  router.delete("/pages/:pageId/schedule/:jobId", async (req: Request, res: Response, next) => {
    try {
      const page = await prisma.sitePage.findUnique({
        where: { id: req.params.pageId },
        include: { site: true },
      });
      if (!page) return res.status(404).json({ error: "Page not found" });
      await assertWebsiteSiteAccess(req, page.siteId, "publish");

      const existingJobs = readScheduledJobs(page.site.settings);
      const updatedJobs = existingJobs.map(j => {
        if (j.id === req.params.jobId && (j.status === "PENDING" || j.status === "ACTIVE_TEMPORARY")) {
          return { ...j, status: "CANCELLED" as const };
        }
        return j;
      });

      const nextSettings = {
        ...(typeof page.site.settings === "object" && page.site.settings !== null ? page.site.settings : {}),
        scheduledPublishJobs: updatedJobs,
      };

      await prisma.site.update({
        where: { id: page.siteId },
        data: { settings: nextSettings as any },
      });

      res.json({ ok: true, cancelledJobId: req.params.jobId });
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Periodically called by background worker or scheduler to process due jobs.
 */
export async function tickScheduledPublishes(): Promise<{ executed: number; reverted: number }> {
  let executedCount = 0;
  let revertedCount = 0;
  const now = new Date();

  const sites = await prisma.site.findMany({
    select: { id: true, name: true, settings: true },
  });

  for (const site of sites) {
    const jobs = readScheduledJobs(site.settings);
    let mutated = false;

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];

      // Case A: Pending job due for publishing
      if (job.status === "PENDING" && new Date(job.scheduledAt) <= now) {
        try {
          const page = await prisma.sitePage.findUnique({
            where: { id: job.pageId },
            include: { versions: { orderBy: { number: "desc" }, take: 1 } },
          });

          if (page) {
            // Store previous version snapshot for auto-revert if revertAt is configured
            const latestVer = page.versions[0];
            const revertSnapshot = latestVer ? { html: latestVer.html, versionNumber: latestVer.number } : undefined;
            const draft = (page.draft ?? {}) as Record<string, FieldValue>;
            const publishHtml = Object.keys(draft).length > 0
              ? applyValues(editingSource(page.sourceHtml || "", draft), fieldValues(draft)).html
              : (page.sourceHtml || "");

            await publishPage({
              site: site as any,
              page: page as any,
              html: publishHtml,
              expectedSource: page.sourceHtml || "",
              message: `Scheduled Publish: ${job.notes || "Auto-published by schedule"}`,
            });

            job.status = job.revertAt ? "ACTIVE_TEMPORARY" : "COMPLETED";
            job.executedAt = now.toISOString();
            job.revertSnapshot = revertSnapshot;
            mutated = true;
            executedCount++;
          }
        } catch (err: any) {
          job.status = "FAILED";
          job.error = err.message || "Publish failed during schedule execution";
          mutated = true;
        }
      }

      // Case B: Active temporary job due for auto-revert
      else if (job.status === "ACTIVE_TEMPORARY" && job.revertAt && new Date(job.revertAt) <= now) {
        try {
          if (job.revertSnapshot?.html) {
            const page = await prisma.sitePage.findUnique({ where: { id: job.pageId } });
            if (page) {
              await publishPage({
                site: site as any,
                page: { ...page, sourceHtml: job.revertSnapshot.html } as any,
                html: job.revertSnapshot.html,
                expectedSource: page.sourceHtml || "",
                message: `Automatic revert of temporary promotion scheduled for ${new Date(job.revertAt).toLocaleDateString()}`,
              });
            }
          }
          job.status = "REVERTED";
          job.revertedAt = now.toISOString();
          mutated = true;
          revertedCount++;
        } catch (err: any) {
          job.status = "FAILED";
          job.error = `Revert failed: ${err.message}`;
          mutated = true;
        }
      }
    }

    if (mutated) {
      const nextSettings = {
        ...(typeof site.settings === "object" && site.settings !== null ? site.settings : {}),
        scheduledPublishJobs: jobs,
      };
      await prisma.site.update({
        where: { id: site.id },
        data: { settings: nextSettings as any },
      });
    }
  }

  return { executed: executedCount, reverted: revertedCount };
}
