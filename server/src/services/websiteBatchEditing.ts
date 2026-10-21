/**
 * websiteBatchEditing.ts — Multi-Page Find & Replace, Batch Editing, and Global Content.
 *
 * Implements:
 * 16. Content Find & Replace across all pages
 * 17. Multi-Page Batch Editing
 * 20. Global Content Tokens (Business phone, email, address, opening hours)
 */

import type { Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { setSiteSetting } from "./websiteSiteSettings.js";
import type { Prisma, SitePage } from "@prisma/client";
import { pageSource, WebsiteError } from "./website/site.js";
import { applyValues, discoverFields, editingSource, fieldValues, replaceTextOnly, type FieldValue } from "./website/index.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";
import { assertEditAllowance, writePageEdit } from "./websiteTierPlans.js";

export type ContentMatchOccurrence = {
  pageId: string;
  pageTitle: string;
  pagePath: string;
  fieldId: string;
  fieldLabel: string;
  currentValue: string;
  proposedValue: string;
  matchCount: number;
};

export type GlobalContentToken = {
  key: string;
  label: string;
  value: string;
  category: "contact" | "company" | "hours" | "cta" | "pricing";
  updatedAt: string;
};

const DEFAULT_GLOBAL_TOKENS: GlobalContentToken[] = [
  { key: "business_phone", label: "Business Phone", value: "+233 24 000 0000", category: "contact", updatedAt: new Date().toISOString() },
  { key: "business_email", label: "Business Email", value: "info@business.com", category: "contact", updatedAt: new Date().toISOString() },
  { key: "office_address", label: "Office Address", value: "12 Independence Avenue, Accra, Ghana", category: "contact", updatedAt: new Date().toISOString() },
  { key: "opening_hours", label: "Opening Hours", value: "Mon - Fri: 8:00 AM - 5:00 PM", category: "hours", updatedAt: new Date().toISOString() },
  { key: "company_name", label: "Company Name", value: "My Business", category: "company", updatedAt: new Date().toISOString() },
  { key: "cta_text", label: "Primary CTA Text", value: "Book Consultation", category: "cta", updatedAt: new Date().toISOString() },
];

function readGlobalTokens(settings: unknown): GlobalContentToken[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return DEFAULT_GLOBAL_TOKENS;
  const s = settings as Record<string, unknown>;
  if (Array.isArray(s.globalContent) && s.globalContent.length > 0) {
    return s.globalContent as GlobalContentToken[];
  }
  return DEFAULT_GLOBAL_TOKENS;
}

/**
 * Writes drafts across several pages as one change: every page an edit, once a
 * page a day, through the same guard as a single save, and all of them or none.
 *
 * A replace that stopped on the second of three pages — the plan ran out, or
 * somebody saved one of them meanwhile — would leave the site saying two
 * different things, so either refuses the lot. Each page is written against
 * the revision it was read at; this used to overwrite a colleague's save made
 * while the pages were being read.
 */
async function writeDrafts(
  req: Request,
  siteId: string,
  changes: Array<{ page: SitePage; data: Prisma.SitePageUncheckedUpdateManyInput }>,
): Promise<void> {
  if (!changes.length) return;
  const allowance = await assertEditAllowance(req, siteId, changes.map(({ page }) => page));
  await prisma.$transaction(async (tx) => {
    for (const { page, data } of changes) {
      const written = await writePageEdit(tx, allowance, { id: page.id, draftRevision: page.draftRevision }, { ...data, draftRevision: { increment: 1 } });
      if (!written.count) throw new WebsiteError(409, `${page.title} was saved by somebody else while this was being applied. Nothing was changed — search again to see the pages as they are now.`);
    }
  }, { timeout: 30_000 });
}

export function registerWebsiteBatchEditingRoutes(router: Router): void {
  // 1. Search Content across all pages in a site
  router.post("/sites/:siteId/find-replace/search", async (req: Request, res: Response, next) => {
    try {
      const site = await prisma.site.findUnique({
        where: { id: req.params.siteId },
        include: { pages: { where: { status: "LIVE" }, orderBy: { sortOrder: "asc" } } },
      });
      if (!site) return res.status(404).json({ error: "Site not found" });
      await assertWebsiteSiteAccess(req, site.id, "view");

      const body = z.object({
        query: z.string().min(1).max(200),
        replacement: z.string().max(200).optional().default(""),
        caseSensitive: z.boolean().default(false),
      }).parse(req.body);

      const occurrences: ContentMatchOccurrence[] = [];
      const queryStr = body.query;
      const flags = body.caseSensitive ? "g" : "gi";
      const regex = new RegExp(escapeRegExp(queryStr), flags);

      for (const page of site.pages) {
        const source = await pageSource(site, page, { fresh: true });
        const draft = (page.draft ?? {}) as Record<string, FieldValue>;
        const html = Object.keys(draft).length > 0
          ? applyValues(editingSource(source.html, draft), fieldValues(draft)).html
          : source.html;

        const discovery = discoverFields(html);

        for (const field of discovery.fields) {
          const val = draft[field.id]?.value ?? field.value;
          const proposed = typeof val === "string" ? replaceTextOnly(val, regex, body.replacement) : val;
          if (typeof val === "string" && proposed !== val) {
            const matches = val.match(regex) || [];
            occurrences.push({
              pageId: page.id,
              pageTitle: page.title,
              pagePath: page.path,
              fieldId: field.id,
              fieldLabel: field.label || field.id,
              currentValue: val,
              proposedValue: proposed,
              matchCount: matches.length,
            });
          }
        }
      }

      const totalMatches = occurrences.reduce((sum, o) => sum + o.matchCount, 0);
      const affectedPages = new Set(occurrences.map(o => o.pageId)).size;

      res.json({
        query: body.query,
        replacement: body.replacement,
        totalMatches,
        affectedPages,
        occurrences,
        summary: `Found ${totalMatches} occurrence${totalMatches === 1 ? "" : "s"} across ${affectedPages} page${affectedPages === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      next(err);
    }
  });

  // 2. Apply Find & Replace Batch Mutation
  router.post("/sites/:siteId/find-replace/apply", async (req: Request, res: Response, next) => {
    try {
      const site = await prisma.site.findUnique({
        where: { id: req.params.siteId },
        include: { pages: { where: { status: "LIVE" } } },
      });
      if (!site) return res.status(404).json({ error: "Site not found" });
      await assertWebsiteSiteAccess(req, site.id, "edit");

      const body = z.object({
        query: z.string().min(1).max(200),
        replacement: z.string().max(200),
        caseSensitive: z.boolean().default(false),
        selectedOccurrences: z.array(z.object({
          pageId: z.string(),
          fieldId: z.string(),
        })).optional(),
      }).parse(req.body);

      const flags = body.caseSensitive ? "g" : "gi";
      const regex = new RegExp(escapeRegExp(body.query), flags);
      const selectedSet = body.selectedOccurrences
        ? new Set(body.selectedOccurrences.map(s => `${s.pageId}:${s.fieldId}`))
        : null;

      let appliedCount = 0;
      const changes: Parameters<typeof writeDrafts>[2] = [];

      for (const page of site.pages) {
        const source = await pageSource(site, page, { fresh: true });
        const draft = (page.draft ?? {}) as Record<string, FieldValue>;
        const html = Object.keys(draft).length > 0
          ? applyValues(editingSource(source.html, draft), fieldValues(draft)).html
          : source.html;

        const discovery = discoverFields(html);
        let pageChanged = false;
        const newDraft = { ...draft };

        for (const field of discovery.fields) {
          if (selectedSet && !selectedSet.has(`${page.id}:${field.id}`)) {
            continue;
          }

          const existingValue = newDraft[field.id]?.value ?? field.value;
          const nextValue = typeof existingValue === "string" ? replaceTextOnly(existingValue, regex, body.replacement) : existingValue;
          if (typeof existingValue === "string" && nextValue !== existingValue) {
            newDraft[field.id] = {
              ...(newDraft[field.id] || {}),
              value: nextValue,
              original: (newDraft[field.id]?.original ?? field.value) as any,
            };
            pageChanged = true;
            appliedCount++;
          }
        }

        if (pageChanged) {
          changes.push({ page, data: { draft: newDraft as unknown as Prisma.InputJsonValue, draftSavedAt: new Date(), draftSavedById: req.dbUser?.id ?? null } });
        }
      }
      await writeDrafts(req, site.id, changes);
      const modifiedPages = changes.map(({ page }) => page.title);

      await prisma.siteAuditEvent.create({
        data: {
          siteId: site.id,
          kind: "BATCH_FIND_REPLACE",
          summary: `Replaced '${body.query}' with '${body.replacement}' (${appliedCount} occurrences across ${modifiedPages.length} pages)`,
          actorName: req.dbUser?.name || "Editor",
          actorId: req.dbUser?.id,
          detail: { query: body.query, replacement: body.replacement, appliedCount, pages: modifiedPages },
        },
      });

      res.json({
        ok: true,
        appliedCount,
        affectedPagesCount: modifiedPages.length,
        modifiedPages,
        summary: `Successfully applied ${appliedCount} replacement${appliedCount === 1 ? "" : "s"} across ${modifiedPages.length} page${modifiedPages.length === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      next(err);
    }
  });

  // 3. Get Global Content Tokens
  router.get("/sites/:siteId/global-content", async (req: Request, res: Response, next) => {
    try {
      const site = await prisma.site.findUnique({
        where: { id: req.params.siteId },
      });
      if (!site) return res.status(404).json({ error: "Site not found" });
      await assertWebsiteSiteAccess(req, site.id, "view");

      const tokens = readGlobalTokens(site.settings);
      res.json({ tokens });
    } catch (err) {
      next(err);
    }
  });

  // 4. Update Global Content Tokens and Safely Sync Across Pages
  router.put("/sites/:siteId/global-content", async (req: Request, res: Response, next) => {
    try {
      const site = await prisma.site.findUnique({
        where: { id: req.params.siteId },
        include: { pages: { where: { status: "LIVE" } } },
      });
      if (!site) return res.status(404).json({ error: "Site not found" });
      await assertWebsiteSiteAccess(req, site.id, "edit");

      const body = z.object({
        tokens: z.array(z.object({
          key: z.string().min(1).max(80),
          label: z.string().min(1).max(100),
          value: z.string().max(500),
          category: z.enum(["contact", "company", "hours", "cta", "pricing"]),
        })),
        syncToPages: z.boolean().default(true),
      }).parse(req.body);

      const oldTokens = readGlobalTokens(site.settings);
      const oldMap = new Map(oldTokens.map(t => [t.key, t.value]));

      const nextTokens: GlobalContentToken[] = body.tokens.map(t => ({
        ...t,
        updatedAt: new Date().toISOString(),
      }));

      // If syncToPages is true: find any occurrences of changed tokens and update draft
      const changedTokens = nextTokens.filter(t => oldMap.has(t.key) && oldMap.get(t.key) !== t.value);
      let syncedCount = 0;
      const changes: Parameters<typeof writeDrafts>[2] = [];

      if (body.syncToPages && changedTokens.length > 0) {
        for (const page of site.pages) {
          const source = await pageSource(site, page, { fresh: true });
          const draft = (page.draft ?? {}) as Record<string, FieldValue>;
          const html = Object.keys(draft).length > 0
            ? applyValues(editingSource(source.html, draft), fieldValues(draft)).html
            : source.html;

          const discovery = discoverFields(html);
          let pageMutated = false;
          const updatedDraft = { ...draft };

          for (const token of changedTokens) {
            const oldVal = oldMap.get(token.key)!;
            if (!oldVal || oldVal.length < 3) continue;

            const regex = new RegExp(escapeRegExp(oldVal), "gi");
            for (const field of discovery.fields) {
              const cur = updatedDraft[field.id]?.value ?? field.value;
              const replaced = typeof cur === "string" ? replaceTextOnly(cur, regex, token.value) : cur;
              if (typeof cur === "string" && replaced !== cur) {
                updatedDraft[field.id] = {
                  ...(updatedDraft[field.id] || {}),
                  value: replaced,
                  original: (updatedDraft[field.id]?.original ?? field.value) as any,
                };
                pageMutated = true;
                syncedCount++;
              }
            }
          }

          if (pageMutated) {
            changes.push({ page, data: { draft: updatedDraft as unknown as Prisma.InputJsonValue, draftSavedAt: new Date() } });
          }
        }
      }
      // Changing the pages a value appears on is editing those pages.
      await writeDrafts(req, site.id, changes);

      await setSiteSetting(site.id, "globalContent", nextTokens);

      res.json({
        ok: true,
        tokens: nextTokens,
        syncedCount,
        message: `Global values saved. ${syncedCount > 0 ? `Updated across ${syncedCount} occurrences.` : "All pages in sync."}`,
      });
    } catch (err) {
      next(err);
    }
  });
}

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyGlobalTokens(
  html: string,
  tokens: Array<{ key: string; value: string }>
): string {
  let result = html;
  for (const token of tokens) {
    const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(token.key)}\\s*\\}\\}`, "g");
    result = result.replace(pattern, token.value);
  }
  return result;
}
