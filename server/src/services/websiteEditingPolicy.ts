/**
 * websiteEditingPolicy.ts — Client Editing Modes, Locked Elements, Edit Boundaries, and Asset Map.
 *
 * Implements:
 * 12. Client Editing Mode (Owner / Designer / Developer)
 * 13. Locked Elements
 * 14. Editing Permissions Per Element
 * 15. Edit Boundaries (Safe / Flexible / Full)
 * 18. Asset Optimizer
 * 19. Asset Usage Map
 */

import type { Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { updateSiteSettings } from "./websiteSiteSettings.js";
import { pageSource } from "./website/site.js";
import { applyValues, discoverFields, editingSource, fieldValues, type FieldValue } from "./website/index.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";

export type ClientEditingMode = "owner" | "designer" | "developer";
export type EditBoundary = "safe" | "flexible" | "full";

export type ElementPermissionRule = {
  selectorOrFieldId: string;
  label?: string;
  locked: boolean;
  allowed: {
    editText: boolean;
    replaceImage: boolean;
    changeUrl: boolean;
    changeColors: boolean;
    changeSpacing: boolean;
    moveSection: boolean;
    deleteSection: boolean;
  };
};

export type SiteEditingPolicy = {
  boundary: EditBoundary;
  defaultMode: ClientEditingMode;
  lockedElements: Record<string, ElementPermissionRule>;
  brandGuard: {
    enabled: boolean;
    approvedColors: string[];
    approvedFonts: string[];
    allowedHeadingSizes: string[];
    enforcePalette: boolean;
  };
};

const DEFAULT_POLICY: SiteEditingPolicy = {
  boundary: "flexible",
  defaultMode: "owner",
  lockedElements: {},
  brandGuard: {
    enabled: true,
    approvedColors: ["#08101F", "#0B66C3", "#F4F5F0", "#10B981", "#F59E0B", "#EF4444", "#FFFFFF"],
    approvedFonts: ["Inter", "System-UI", "Playfair Display", "Geist"],
    allowedHeadingSizes: ["text-2xl", "text-3xl", "text-4xl", "text-5xl"],
    enforcePalette: false,
  },
};

function readPolicy(settings: unknown): SiteEditingPolicy {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return DEFAULT_POLICY;
  const s = settings as Record<string, unknown>;
  const policy = s.editingPolicy as Partial<SiteEditingPolicy> | undefined;
  return {
    boundary: policy?.boundary || "flexible",
    defaultMode: policy?.defaultMode || "owner",
    lockedElements: policy?.lockedElements || {},
    brandGuard: {
      ...DEFAULT_POLICY.brandGuard,
      ...(policy?.brandGuard || {}),
    },
  };
}

export function registerWebsiteEditingPolicyRoutes(router: Router): void {
  // 1. Get Editing Policy & Locked Elements for a site
  router.get("/sites/:siteId/editing-policy", async (req: Request, res: Response, next) => {
    try {
      const site = await prisma.site.findUnique({
        where: { id: req.params.siteId },
      });
      if (!site) return res.status(404).json({ error: "Site not found" });
      await assertWebsiteSiteAccess(req, site.id, "view");

      const policy = readPolicy(site.settings);
      res.json({ policy });
    } catch (err) {
      next(err);
    }
  });

  // 2. Update Editing Policy (Set boundary, toggle locked elements, brand guard)
  router.patch("/sites/:siteId/editing-policy", async (req: Request, res: Response, next) => {
    try {
      const site = await prisma.site.findUnique({
        where: { id: req.params.siteId },
      });
      if (!site) return res.status(404).json({ error: "Site not found" });
      await assertWebsiteSiteAccess(req, site.id, "manage");

      const body = z.object({
        boundary: z.enum(["safe", "flexible", "full"]).optional(),
        defaultMode: z.enum(["owner", "designer", "developer"]).optional(),
        lockedElements: z.record(z.object({
          selectorOrFieldId: z.string(),
          label: z.string().optional(),
          locked: z.boolean(),
          allowed: z.object({
            editText: z.boolean(),
            replaceImage: z.boolean(),
            changeUrl: z.boolean(),
            changeColors: z.boolean(),
            changeSpacing: z.boolean(),
            moveSection: z.boolean(),
            deleteSection: z.boolean(),
          }),
        })).optional(),
        brandGuard: z.object({
          enabled: z.boolean().optional(),
          approvedColors: z.array(z.string()).optional(),
          approvedFonts: z.array(z.string()).optional(),
          allowedHeadingSizes: z.array(z.string()).optional(),
          enforcePalette: z.boolean().optional(),
        }).optional(),
      }).parse(req.body);

      // Merged into the policy as it stands under the row lock, not as it stood
      // when this request read the site.
      let nextPolicy: SiteEditingPolicy | null = null;
      await updateSiteSettings(site.id, (settings) => {
        const current = readPolicy(settings);
        nextPolicy = {
          boundary: body.boundary ?? current.boundary,
          defaultMode: body.defaultMode ?? current.defaultMode,
          lockedElements: body.lockedElements ? { ...current.lockedElements, ...body.lockedElements } : current.lockedElements,
          brandGuard: {
            ...current.brandGuard,
            ...(body.brandGuard || {}),
          },
        };
        return { ...settings, editingPolicy: nextPolicy };
      });

      res.json({ ok: true, policy: nextPolicy });
    } catch (err) {
      next(err);
    }
  });

  // 3. Asset Usage Map: Scans all pages to find where an asset is referenced
  router.get("/sites/:siteId/assets/usage-map", async (req: Request, res: Response, next) => {
    try {
      const site = await prisma.site.findUnique({
        where: { id: req.params.siteId },
        include: {
          pages: { where: { status: "LIVE" } },
          assets: true,
        },
      });
      if (!site) return res.status(404).json({ error: "Site not found" });
      await assertWebsiteSiteAccess(req, site.id, "view");

      // Build usage map: assetPath/assetId -> array of { pageId, pageTitle, pagePath }
      const usageMap: Record<string, { count: number; pages: Array<{ id: string; title: string; path: string }> }> = {};

      for (const asset of site.assets) {
        usageMap[asset.id] = { count: 0, pages: [] };
        usageMap[asset.repoPath] = { count: 0, pages: [] };
      }

      for (const page of site.pages) {
        const source = await pageSource(site, page, { fresh: true });
        const draft = (page.draft ?? {}) as Record<string, FieldValue>;
        const html = Object.keys(draft).length > 0
          ? applyValues(editingSource(source.html, draft), fieldValues(draft)).html
          : source.html;

        for (const asset of site.assets) {
          const needleRepo = asset.repoPath;
          const needleName = asset.filename;
          if (html.includes(needleRepo) || (needleName && html.includes(needleName))) {
            usageMap[asset.id].count++;
            usageMap[asset.id].pages.push({ id: page.id, title: page.title, path: page.path });
            usageMap[asset.repoPath].count++;
            usageMap[asset.repoPath].pages.push({ id: page.id, title: page.title, path: page.path });
          }
        }
      }

      res.json({ usageMap });
    } catch (err) {
      next(err);
    }
  });
}

export function evaluateElementEditAllowed(
  fieldIdOrSelector: string,
  action: keyof ElementPermissionRule["allowed"],
  policy: SiteEditingPolicy,
  mode: ClientEditingMode
): boolean {
  if (mode === "developer") return true;

  const rule = policy.lockedElements[fieldIdOrSelector];
  if (rule?.locked) {
    return Boolean(rule.allowed?.[action]);
  }

  if (mode === "owner") {
    if (action === "editText" || action === "replaceImage" || action === "changeUrl") return true;
    return false;
  }

  return true;
}

