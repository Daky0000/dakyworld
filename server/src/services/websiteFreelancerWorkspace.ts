/**
 * websiteFreelancerWorkspace.ts — Operating Layer Between Developers & Website Owners.
 *
 * Provides a unified cockpit for freelancers and digital systems teams managing
 * multiple clients, live sites, demos, approvals, analytics, and client access boundaries.
 */

import type { Request, Response, Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requirePermission } from "../middleware/auth.js";
import { appUrl } from "./emailSender.js";

export type FreelancerClientSummary = {
  clientId: string;
  clientName: string;
  companyName: string;
  contactEmail: string | null;
  liveSite: {
    id: string;
    name: string;
    slug: string;
    publicUrl: string;
    pagesCount: number;
    lastPublishedAt: string | null;
    lastDraftEditAt: string | null;
    lastEditorName: string | null;
    hasUnpublishedDrafts: boolean;
    editingBoundary: string;
  } | null;
  activeDemo: {
    id: string;
    title: string;
    slug: string;
    url: string;
    views: number;
    lastViewedAt: string | null;
    status: string;
    expiresAt: string | null;
    isExpired: boolean;
    isProtected: boolean;
  } | null;
  pendingApproval: {
    id: string;
    token: string;
    pageTitle: string;
    shareUrl: string;
    status: string;
    createdAt: string;
  } | null;
  recentViewsCount: number;
  totalDwellMinutes: number;
};

export type FreelancerWorkspaceOverview = {
  totalClients: number;
  activeSites: number;
  activeDemos: number;
  pendingApprovalsCount: number;
  clients: FreelancerClientSummary[];
};

/**
 * The cockpit reads every client, site, demo and approval link in the company,
 * so it is a staff screen and nothing else. It is mounted once, at `/api`, and
 * never under the website router: that router is reachable from
 * editor.dakyx.com and lets external accounts in, and an unscoped read there
 * handed the whole client book to any signed-in customer.
 */
export function registerWebsiteFreelancerWorkspaceRoutes(router: Router): void {
  router.get("/freelancer-workspace/overview", requirePermission("clients.view"), async (req: Request, res: Response, next) => {
    try {
      // Belt and braces: an external role must never see this even if somebody
      // ticks `clients.view` on it, because nothing below is scoped to a client.
      if (req.dbUser?.accessRole?.external) return res.status(403).json({ error: "This account does not have access to the internal system." });
      const base = await appUrl();
      const baseUrl = base.replace(/\/+$/, "");

      const clients = await prisma.client.findMany({
        include: {
          sites: {
            include: {
              pages: {
                select: {
                  id: true,
                  title: true,
                  draft: true,
                  draftSavedAt: true,
                  draftSavedBy: { select: { name: true } },
                  lastPublishedAt: true,
                },
              },
            },
          },
          leads: {
            include: {
              demos: {
                orderBy: { updatedAt: "desc" },
                take: 3,
                include: {
                  visits: {
                    select: {
                      durationSeconds: true,
                      createdAt: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
      });

      // Also load sites with no clientId (e.g. internal or prospect sites)
      const orphanSites = await prisma.site.findMany({
        where: { clientId: null },
        include: {
          pages: {
            select: {
              id: true,
              title: true,
              draft: true,
              draftSavedAt: true,
              draftSavedBy: { select: { name: true } },
              lastPublishedAt: true,
            },
          },
        },
      });

      const clientSummaries: FreelancerClientSummary[] = [];

      for (const client of clients) {
        const primarySite = client.sites[0] || null;
        let siteData: FreelancerClientSummary["liveSite"] = null;
        let pendingApprovalData: FreelancerClientSummary["pendingApproval"] = null;

        if (primarySite) {
          let lastDraftTime: Date | null = null;
          let lastEditor: string | null = null;
          let hasDrafts = false;
          let lastPubTime: Date | null = null;

          for (const p of primarySite.pages) {
            if (p.draftSavedAt && (!lastDraftTime || p.draftSavedAt > lastDraftTime)) {
              lastDraftTime = p.draftSavedAt;
              lastEditor = p.draftSavedBy?.name || null;
            }
            if (p.draft && Object.keys(p.draft as object).length > 0) {
              hasDrafts = true;
            }
            if (p.lastPublishedAt && (!lastPubTime || p.lastPublishedAt > lastPubTime)) {
              lastPubTime = p.lastPublishedAt;
            }
          }

          // Check settings for approval links & boundary
          const settings = primarySite.settings as Record<string, any> | null;
          const approvals = Array.isArray(settings?.approvalLinks) ? settings!.approvalLinks : [];
          const pending = approvals.find((a: any) => a.status === "PENDING");
          if (pending) {
            pendingApprovalData = {
              id: pending.id,
              token: pending.token,
              pageTitle: pending.pageTitle || "Page",
              shareUrl: `${baseUrl}/review/${pending.token}`,
              status: pending.status,
              createdAt: pending.createdAt,
            };
          }

          const boundary = settings?.editingPolicy?.boundary || "flexible";

          siteData = {
            id: primarySite.id,
            name: primarySite.name,
            slug: primarySite.slug,
            publicUrl: primarySite.publicUrl,
            pagesCount: primarySite.pages.length,
            lastPublishedAt: lastPubTime ? lastPubTime.toISOString() : null,
            lastDraftEditAt: lastDraftTime ? lastDraftTime.toISOString() : null,
            lastEditorName: lastEditor,
            hasUnpublishedDrafts: hasDrafts,
            editingBoundary: boundary,
          };
        }

        // Demo data
        const primaryDemo = client.leads.flatMap(l => l.demos)[0] || null;
        let demoData: FreelancerClientSummary["activeDemo"] = null;
        let totalDwell = 0;
        let recentViews = 0;

        if (primaryDemo) {
          const meta = (primaryDemo.brief || {}) as Record<string, any>;
          const expiresAt = meta.expiresAt || null;
          const isExpired = expiresAt ? new Date(expiresAt) < new Date() : false;
          const isProtected = meta.accessMode === "PASSWORD";

          for (const v of primaryDemo.visits) {
            totalDwell += v.durationSeconds || 0;
            if (new Date(v.createdAt).getTime() > Date.now() - 7 * 86400 * 1000) {
              recentViews++;
            }
          }

          demoData = {
            id: primaryDemo.id,
            title: primaryDemo.title,
            slug: primaryDemo.slug,
            url: `${baseUrl}/demos/${primaryDemo.slug}`,
            views: primaryDemo.views,
            lastViewedAt: primaryDemo.lastViewedAt ? primaryDemo.lastViewedAt.toISOString() : null,
            status: primaryDemo.status,
            expiresAt,
            isExpired,
            isProtected,
          };
        }

        clientSummaries.push({
          clientId: client.id,
          clientName: client.name,
          companyName: client.company || client.name,
          contactEmail: client.email,
          liveSite: siteData,
          activeDemo: demoData,
          pendingApproval: pendingApprovalData,
          recentViewsCount: recentViews,
          totalDwellMinutes: Math.round(totalDwell / 60),
        });
      }

      // Add orphan sites as independent workspace entries
      for (const site of orphanSites) {
        let lastDraftTime: Date | null = null;
        let lastEditor: string | null = null;
        let hasDrafts = false;
        let lastPubTime: Date | null = null;

        for (const p of site.pages) {
          if (p.draftSavedAt && (!lastDraftTime || p.draftSavedAt > lastDraftTime)) {
            lastDraftTime = p.draftSavedAt;
            lastEditor = p.draftSavedBy?.name || null;
          }
          if (p.draft && Object.keys(p.draft as object).length > 0) {
            hasDrafts = true;
          }
          if (p.lastPublishedAt && (!lastPubTime || p.lastPublishedAt > lastPubTime)) {
            lastPubTime = p.lastPublishedAt;
          }
        }

        const settings = site.settings as Record<string, any> | null;
        const approvals = Array.isArray(settings?.approvalLinks) ? settings!.approvalLinks : [];
        const pending = approvals.find((a: any) => a.status === "PENDING");
        const pendingApprovalData = pending
          ? {
              id: pending.id,
              token: pending.token,
              pageTitle: pending.pageTitle || "Page",
              shareUrl: `${baseUrl}/review/${pending.token}`,
              status: pending.status,
              createdAt: pending.createdAt,
            }
          : null;

        clientSummaries.push({
          clientId: site.id,
          clientName: site.name,
          companyName: site.name,
          contactEmail: null,
          liveSite: {
            id: site.id,
            name: site.name,
            slug: site.slug,
            publicUrl: site.publicUrl,
            pagesCount: site.pages.length,
            lastPublishedAt: lastPubTime ? lastPubTime.toISOString() : null,
            lastDraftEditAt: lastDraftTime ? lastDraftTime.toISOString() : null,
            lastEditorName: lastEditor,
            hasUnpublishedDrafts: hasDrafts,
            editingBoundary: settings?.editingPolicy?.boundary || "flexible",
          },
          activeDemo: null,
          pendingApproval: pendingApprovalData,
          recentViewsCount: 0,
          totalDwellMinutes: 0,
        });
      }

      const activeSitesCount = clientSummaries.filter(c => c.liveSite !== null).length;
      const activeDemosCount = clientSummaries.filter(c => c.activeDemo !== null).length;
      const pendingApprovalsCount = clientSummaries.filter(c => c.pendingApproval !== null).length;

      const overview: FreelancerWorkspaceOverview = {
        totalClients: clientSummaries.length,
        activeSites: activeSitesCount,
        activeDemos: activeDemosCount,
        pendingApprovalsCount,
        clients: clientSummaries,
      };

      res.json(overview);
    } catch (err) {
      next(err);
    }
  });
}
