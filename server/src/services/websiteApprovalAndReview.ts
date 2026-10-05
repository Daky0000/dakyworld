/**
 * websiteApprovalAndReview.ts — Public Approval Links & Visual Comments.
 *
 * Enables freelancers to generate zero-friction review links (e.g. review.dakyx.com/3jA9kx)
 * where clients can view Before / After changes, approve or request changes with one click,
 * and attach point-and-click visual comment pins directly to elements on the page without logging in.
 */

import { randomUUID } from "node:crypto";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { pageSource } from "./website/site.js";
import { applyValues, editingSource, fieldValues, type FieldValue } from "./website/index.js";
import { appUrl } from "./emailSender.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";

export type ApprovalLinkRecord = {
  id: string;
  siteId: string;
  pageId: string;
  token: string;
  title: string;
  pageTitle: string;
  status: "PENDING" | "APPROVED" | "CHANGES_REQUESTED";
  versionNumber: number;
  draftSnapshot: Record<string, FieldValue>;
  reviewerName?: string;
  reviewerEmail?: string;
  feedback?: string;
  reviewedAt?: string;
  createdAt: string;
};

export type VisualCommentPin = {
  id: string;
  approvalToken: string;
  siteId: string;
  pageId: string;
  elementSelector: string;
  elementLabel: string;
  xPercent: number;
  yPercent: number;
  authorName: string;
  content: string;
  status: "OPEN" | "RESOLVED";
  createdAt: string;
};

function readSiteApprovals(settings: unknown): ApprovalLinkRecord[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
  const s = settings as Record<string, unknown>;
  return Array.isArray(s.approvalLinks) ? (s.approvalLinks as ApprovalLinkRecord[]) : [];
}

function readVisualComments(settings: unknown): VisualCommentPin[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
  const s = settings as Record<string, unknown>;
  return Array.isArray(s.visualCommentPins) ? (s.visualCommentPins as VisualCommentPin[]) : [];
}

function generateToken(): string {
  // Generates short, readable URL tokens like "3jA9kx"
  const chars = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  let token = "";
  for (let i = 0; i < 7; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

export function registerWebsiteApprovalRoutes(router: Router): void {
  // 1. Authenticated: Create Approval Link
  router.post("/pages/:pageId/approval-link", async (req: Request, res: Response, next) => {
    try {
      const pageId = req.params.pageId;
      const page = await prisma.sitePage.findUnique({
        where: { id: pageId },
        include: { site: true, versions: { orderBy: { number: "desc" }, take: 1 } },
      });
      if (!page) return res.status(404).json({ error: "Page not found" });
      await assertWebsiteSiteAccess(req, page.siteId, "edit");

      const draft = (page.draft ?? {}) as Record<string, FieldValue>;
      const existingApprovals = readSiteApprovals(page.site.settings);
      const existingComments = readVisualComments(page.site.settings);

      const token = generateToken();
      const latestVersionNum = page.versions[0]?.number ?? 1;

      const newApproval: ApprovalLinkRecord = {
        id: randomUUID(),
        siteId: page.siteId,
        pageId: page.id,
        token,
        title: req.body?.title?.trim() || `${page.title} Review`,
        pageTitle: page.title,
        status: "PENDING",
        versionNumber: latestVersionNum,
        draftSnapshot: draft,
        createdAt: new Date().toISOString(),
      };

      const updatedApprovals = [newApproval, ...existingApprovals.filter(a => a.pageId !== page.id || a.status !== "PENDING")].slice(0, 100);

      const siteSettings = {
        ...(typeof page.site.settings === "object" && page.site.settings !== null ? page.site.settings : {}),
        approvalLinks: updatedApprovals,
      };

      await prisma.site.update({
        where: { id: page.siteId },
        data: { settings: siteSettings as any },
      });

      const base = await appUrl();
      const shareUrl = `${base.replace(/\/+$/, "")}/review/${token}`;

      res.status(201).json({
        approval: newApproval,
        shareUrl,
        token,
      });
    } catch (err) {
      next(err);
    }
  });

  // 2. Authenticated: List approval status for a page
  router.get("/pages/:pageId/approvals", async (req: Request, res: Response, next) => {
    try {
      const page = await prisma.sitePage.findUnique({
        where: { id: req.params.pageId },
        include: { site: true },
      });
      if (!page) return res.status(404).json({ error: "Page not found" });
      await assertWebsiteSiteAccess(req, page.siteId, "view");

      const approvals = readSiteApprovals(page.site.settings).filter(a => a.pageId === page.id);
      const comments = readVisualComments(page.site.settings).filter(c => c.pageId === page.id);

      res.json({ approvals, comments });
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Public endpoints for client review without login.
 * Mounted on public API or directly accessible by token.
 */
export function registerPublicReviewRoutes(router: Router): void {
  // Get Review Data
  router.get("/review/:token", async (req: Request, res: Response, next) => {
    try {
      const token = req.params.token;
      const sites = await prisma.site.findMany({
        select: { id: true, name: true, slug: true, publicUrl: true, settings: true },
      });

      let foundSite: any = null;
      let foundApproval: ApprovalLinkRecord | null = null;

      for (const site of sites) {
        const approvals = readSiteApprovals(site.settings);
        const match = approvals.find(a => a.token === token);
        if (match) {
          foundSite = site;
          foundApproval = match;
          break;
        }
      }

      if (!foundSite || !foundApproval) {
        return res.status(404).json({ error: "Approval link not found or expired." });
      }

      const page = await prisma.sitePage.findUnique({
        where: { id: foundApproval.pageId },
      });
      if (!page) return res.status(404).json({ error: "Page associated with approval link not found." });

      const source = await pageSource(foundSite, page, { fresh: true });
      const draft = foundApproval.draftSnapshot || {};
      const renderedDraft = Object.keys(draft).length > 0
        ? applyValues(editingSource(source.html, draft), fieldValues(draft)).html
        : source.html;

      const comments = readVisualComments(foundSite.settings).filter(c => c.approvalToken === token);

      res.json({
        approval: foundApproval,
        siteName: foundSite.name,
        pageTitle: page.title,
        pagePath: page.path,
        sourceHtml: source.html,
        draftHtml: renderedDraft,
        comments,
      });
    } catch (err) {
      next(err);
    }
  });

  // Client Action: Approve or Request Changes
  router.post("/review/:token/action", async (req: Request, res: Response, next) => {
    try {
      const token = req.params.token;
      const body = z.object({
        action: z.enum(["APPROVE", "REQUEST_CHANGES"]),
        reviewerName: z.string().min(1).max(100),
        reviewerEmail: z.string().email().optional(),
        feedback: z.string().max(2000).optional(),
      }).parse(req.body);

      const sites = await prisma.site.findMany();

      let foundSite: any = null;
      let foundApprovalIndex = -1;
      let approvals: ApprovalLinkRecord[] = [];

      for (const site of sites) {
        approvals = readSiteApprovals(site.settings);
        const idx = approvals.findIndex(a => a.token === token);
        if (idx !== -1) {
          foundSite = site;
          foundApprovalIndex = idx;
          break;
        }
      }

      if (!foundSite || foundApprovalIndex === -1) {
        return res.status(404).json({ error: "Approval link not found." });
      }

      const target = approvals[foundApprovalIndex];
      target.status = body.action === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED";
      target.reviewerName = body.reviewerName;
      target.reviewerEmail = body.reviewerEmail;
      target.feedback = body.feedback;
      target.reviewedAt = new Date().toISOString();

      approvals[foundApprovalIndex] = target;

      const siteSettings = {
        ...(typeof foundSite.settings === "object" && foundSite.settings !== null ? foundSite.settings : {}),
        approvalLinks: approvals,
      };

      await prisma.site.update({
        where: { id: foundSite.id },
        data: { settings: siteSettings as any },
      });

      // Audit event
      const summaryText = body.action === "APPROVE"
        ? `${body.reviewerName} approved ${target.pageTitle} V${target.versionNumber}`
        : `${body.reviewerName} requested changes on ${target.pageTitle}: ${body.feedback || "See comments"}`;

      await prisma.siteAuditEvent.create({
        data: {
          siteId: foundSite.id,
          kind: body.action === "APPROVE" ? "APPROVAL_GRANTED" : "APPROVAL_REJECTED",
          summary: summaryText,
          actorName: body.reviewerName,
          detail: {
            token,
            pageId: target.pageId,
            feedback: body.feedback,
            versionNumber: target.versionNumber,
          },
        },
      });

      res.json({
        ok: true,
        approval: target,
        message: summaryText,
      });
    } catch (err) {
      next(err);
    }
  });

  // Client Visual Comment Pin Submission
  router.post("/review/:token/comments", async (req: Request, res: Response, next) => {
    try {
      const token = req.params.token;
      const body = z.object({
        elementSelector: z.string().max(200).default("body"),
        elementLabel: z.string().max(200).default("Element"),
        xPercent: z.number().min(0).max(100).default(50),
        yPercent: z.number().min(0).max(100).default(50),
        authorName: z.string().min(1).max(100),
        content: z.string().min(1).max(1000),
      }).parse(req.body);

      const sites = await prisma.site.findMany();

      let foundSite: any = null;
      let foundApproval: ApprovalLinkRecord | null = null;

      for (const site of sites) {
        const approvals = readSiteApprovals(site.settings);
        const match = approvals.find(a => a.token === token);
        if (match) {
          foundSite = site;
          foundApproval = match;
          break;
        }
      }

      if (!foundSite || !foundApproval) {
        return res.status(404).json({ error: "Approval link not found." });
      }

      const existingComments = readVisualComments(foundSite.settings);
      const newComment: VisualCommentPin = {
        id: randomUUID(),
        approvalToken: token,
        siteId: foundSite.id,
        pageId: foundApproval.pageId,
        elementSelector: body.elementSelector,
        elementLabel: body.elementLabel,
        xPercent: body.xPercent,
        yPercent: body.yPercent,
        authorName: body.authorName,
        content: body.content,
        status: "OPEN",
        createdAt: new Date().toISOString(),
      };

      const updatedComments = [newComment, ...existingComments].slice(0, 300);

      const siteSettings = {
        ...(typeof foundSite.settings === "object" && foundSite.settings !== null ? foundSite.settings : {}),
        visualCommentPins: updatedComments,
      };

      await prisma.site.update({
        where: { id: foundSite.id },
        data: { settings: siteSettings as any },
      });

      res.status(201).json({
        comment: newComment,
        comments: updatedComments.filter(c => c.approvalToken === token),
      });
    } catch (err) {
      next(err);
    }
  });
}

const PrismaJsonNull = undefined;
