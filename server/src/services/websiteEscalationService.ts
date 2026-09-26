import type { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { WebsiteError } from "./website/site.js";
import { assertWebsiteSiteAccess, websiteSiteFilter } from "./websiteAccess.js";

const handler =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export type CreateEscalationInput = {
  siteId: string;
  pageId?: string | null;
  pageTitle?: string | null;
  userPrompt: string;
  reason: "OUT_OF_SCOPE" | "UNSUPPORTED_CAPABILITY" | "EXECUTION_FAILURE" | "OWNER_REQUESTED";
  category: "custom_backend" | "third_party_integration" | "crm_or_leads" | "billing_or_account" | "complex_engineering" | "other";
  agentNotes: string;
  userEmail?: string | null;
  userName?: string | null;
};

export async function createWebsiteEscalation(input: CreateEscalationInput) {
  const count = await prisma.websiteEscalation.count({
    where: { siteId: input.siteId },
  });
  const reportNumber = `ESC-${new Date().getFullYear()}-${String(count + 1).padStart(3, "0")}`;

  const record = await prisma.websiteEscalation.create({
    data: {
      siteId: input.siteId,
      pageId: input.pageId ?? null,
      pageTitle: input.pageTitle ?? null,
      userPrompt: input.userPrompt,
      reason: input.reason,
      category: input.category,
      agentNotes: input.agentNotes,
      userEmail: input.userEmail ?? null,
      userName: input.userName ?? null,
      status: "OPEN",
    },
    include: {
      site: { select: { id: true, name: true } },
    },
  });

  // Log to Site Audit Trail
  await prisma.siteAuditEvent.create({
    data: {
      siteId: input.siteId,
      kind: "ESCALATION_FILED",
      summary: `Escalation report ${reportNumber} filed to owner (${input.reason})`,
      actorName: input.userName || "Website Builder Agent",
      detail: {
        escalationId: record.id,
        reportNumber,
        category: input.category,
        reason: input.reason,
        prompt: input.userPrompt.slice(0, 150),
      },
    },
  });

  return {
    ...record,
    reportNumber,
  };
}

export function registerWebsiteEscalationRoutes(router: Router) {
  /**
   * GET /website/escalations
   * Lists all escalations filed from the Website Builder Agent to the business owner.
   */
  router.get(
    "/escalations",
    handler(async (req, res) => {
      const user = req.dbUser;
      if (!user) throw new WebsiteError(401, "Sign in to view escalations.");

      const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
      const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;

      // Filter to sites the user has access to
      const accessibleSites = await prisma.site.findMany({
        where: websiteSiteFilter(req),
        select: { id: true },
      });
      const accessibleIds = accessibleSites.map((s) => s.id);

      const where: { siteId: { in: string[] } & (string | undefined); status?: string } = {
        siteId: siteId && accessibleIds.includes(siteId) ? (siteId as any) : { in: accessibleIds },
      };
      if (status && status !== "ALL") {
        where.status = status;
      }

      const items = await prisma.websiteEscalation.findMany({
        where: where as any,
        include: {
          site: { select: { id: true, name: true, publicUrl: true } },
        },
        orderBy: [{ createdAt: "desc" }],
        take: 100,
      });

      const openCount = await prisma.websiteEscalation.count({
        where: {
          siteId: { in: accessibleIds },
          status: "OPEN",
        },
      });

      res.json({
        openCount,
        total: items.length,
        items: items.map((item, index) => ({
          ...item,
          reportNumber: `ESC-${item.createdAt.getFullYear()}-${String(items.length - index).padStart(3, "0")}`,
        })),
      });
    }),
  );

  /**
   * POST /website/sites/:siteId/escalations
   * Explicitly file an escalation report from the user or the assistant.
   */
  router.post(
    "/sites/:siteId/escalations",
    handler(async (req, res) => {
      const site = await prisma.site.findUniqueOrThrow({ where: { id: req.params.siteId } });
      const input = z
        .object({
          pageId: z.string().optional().nullable(),
          pageTitle: z.string().optional().nullable(),
          userPrompt: z.string().min(1).max(3000),
          reason: z
            .enum(["OUT_OF_SCOPE", "UNSUPPORTED_CAPABILITY", "EXECUTION_FAILURE", "OWNER_REQUESTED"])
            .default("OWNER_REQUESTED"),
          category: z
            .enum([
              "custom_backend",
              "third_party_integration",
              "crm_or_leads",
              "billing_or_account",
              "complex_engineering",
              "other",
            ])
            .default("other"),
          agentNotes: z.string().max(2000).default("Requested by user from the website workspace."),
        })
        .parse(req.body);

      const created = await createWebsiteEscalation({
        siteId: site.id,
        pageId: input.pageId,
        pageTitle: input.pageTitle,
        userPrompt: input.userPrompt,
        reason: input.reason,
        category: input.category,
        agentNotes: input.agentNotes,
        userEmail: req.dbUser?.email ?? null,
        userName: req.dbUser?.name ?? null,
      });

      res.status(201).json(created);
    }),
  );

  /**
   * PATCH /website/escalations/:id
   * Update escalation status (e.g. mark IN_REVIEW or RESOLVED) and add owner notes.
   */
  router.patch(
    "/escalations/:id",
    handler(async (req, res) => {
      const user = req.dbUser;
      if (!user) throw new WebsiteError(401, "Sign in to update escalations.");

      const { status, ownerNotes } = z
        .object({
          status: z.enum(["OPEN", "IN_REVIEW", "RESOLVED"]),
          ownerNotes: z.string().trim().max(2000).optional(),
        })
        .parse(req.body);

      const existing = await prisma.websiteEscalation.findUniqueOrThrow({
        where: { id: req.params.id },
      });

      await assertWebsiteSiteAccess(req, existing.siteId, "manage");

      const updated = await prisma.websiteEscalation.update({
        where: { id: existing.id },
        data: {
          status,
          ownerNotes: ownerNotes ?? existing.ownerNotes,
          resolvedAt: status === "RESOLVED" ? new Date() : null,
          resolvedBy: status === "RESOLVED" ? user.name || user.email : null,
        },
      });

      res.json(updated);
    }),
  );
}
