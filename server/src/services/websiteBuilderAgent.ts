import { randomUUID } from "node:crypto";
import type { Request, Response, Router } from "express";
import type { Site, SitePage } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { prisma } from "../lib/prisma.js";
import { callModel } from "../lib/models/call.js";
import { currentRun } from "../lib/runContext.js";
import { sniff } from "../lib/fileType.js";
import { optimizeImageBuffer } from "../lib/imageOptimization.js";
import { assetUrl } from "./websiteAssets.js";
import { ensureHostedAddress } from "./websiteHosting.js";
import { withWebsitePublishLocks } from "./websitePublishing.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";
import { assertMediaStorageAllowance } from "./websiteTierPlans.js";
import { check, scopesForAgent, BudgetExceeded, forgetBudgets } from "./budgets.js";
import { writerSystem } from "./writers/brief.js";
import {
  discoverFields,
  buildPublishPlan,
  editingSource,
  fieldValues,
  versionValues,
  safeStyle,
  sanitizeValue,
  structureControls,
  validateFieldChange,
  type FieldValue,
  type SiteField,
} from "./website/index.js";
import { pageSource, pageUrl, publishPages, siteStylesheets, WebsiteError } from "./website/site.js";
import { generateSmartPageSeo, registerWebsiteSeoRoutes } from "./websiteSeo.js";

// ============================================================================
// Schemas & Types
// ============================================================================

export const agentFieldEditSchema = z.object({
  value: z.string().max(12_000).optional(),
  href: z.string().max(2_000).optional(),
  alt: z.string().max(2_000).optional(),
  style: z.string().max(8_000).optional(),
  variant: z.string().max(120).nullable().optional(),
  newTab: z.boolean().optional(),
  responsive: z.object({
    tablet: z.string().max(2_000).optional(),
    mobile: z.string().max(2_000).optional(),
  }).strict().optional(),
}).strict();
export type AgentFieldEdit = z.infer<typeof agentFieldEditSchema>;

export const agentAttachmentSchema = z.object({
  id: z.string().max(120).optional(),
  filename: z.string().min(1).max(200),
  url: z.string().min(1).max(1_000),
  previewUrl: z.string().max(1_000).optional(),
  contentType: z.string().max(120).optional(),
  kind: z.enum(["image", "file"]).default("file"),
  alt: z.string().max(500).optional(),
});
export type AgentAttachment = z.infer<typeof agentAttachmentSchema>;

export const agentChatHistoryTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(1_500),
  targetFieldIds: z.array(z.string().max(200)).max(20).optional(),
});
export type AgentChatHistoryTurn = z.infer<typeof agentChatHistoryTurnSchema>;

export const siteAgentCommandSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("replace_font"),
      fromFont: z.string().max(200).optional().default(""),
      toFont: z.string().min(1, "Specify the replacement font family.").max(200),
      targetKinds: z.array(z.enum(["heading", "button", "container", "all", "text"])).optional().default(["all"]),
    }).strict(),
    z.object({
      action: z.literal("replace_color"),
      fromColor: z.string().min(1, "Specify the color code to replace.").max(100),
      toColor: z.string().min(1, "Specify the new color code.").max(100),
      properties: z.array(z.string()).optional(),
    }).strict(),
    z.object({
      action: z.literal("replace_content"),
      findText: z.string().min(1, "Specify the text or number to find.").max(1_000),
      replaceText: z.string().max(1_000),
      kind: z.enum(["phone", "email", "text", "auto"]).optional().default("auto"),
    }).strict(),
    z.object({
      action: z.literal("instruction"),
      prompt: z.string().trim().max(3_000).default(""),
      pageId: z.string().max(120).optional(),
      selectedFieldId: z.string().max(200).nullable().optional(),
      edits: z.record(z.string(), agentFieldEditSchema).optional(),
      attachments: z.array(agentAttachmentSchema).max(10).optional().default([]),
      history: z.array(agentChatHistoryTurnSchema).max(12).optional().default([]),
    }).strict(),
  ])
  .refine(
    (val) =>
      val.action !== "instruction" ||
      val.prompt.length >= 2 ||
      (val.attachments && val.attachments.length > 0),
    { message: "Describe the change you want to make or attach a file." }
  );
export type SiteAgentCommand = z.infer<typeof siteAgentCommandSchema>;

export const siteAgentApplyInputSchema = z.object({
  pageRevisions: z.record(z.string(), z.number()),
  plan: z.object({
    explanation: z.string(),
    pages: z.array(z.object({
      pageId: z.string(),
      pageTitle: z.string(),
      pagePath: z.string(),
      draftRevision: z.number(),
      changes: z.array(z.object({
        fieldId: z.string(),
        label: z.string(),
        property: z.string(),
        before: z.string(),
        after: z.string(),
      })),
      edits: z.record(z.string(), agentFieldEditSchema),
    })),
  }),
}).strict();
export type SiteAgentApplyInput = z.infer<typeof siteAgentApplyInputSchema>;

export type SiteAgentPagePlan = {
  pageId: string;
  pageTitle: string;
  pagePath: string;
  draftRevision: number;
  changes: Array<{
    fieldId: string;
    label: string;
    property: string;
    before: string;
    after: string;
  }>;
  edits: Record<string, AgentFieldEdit>;
};

export type SiteAgentStructuralAction = {
  pageId: string;
  pageTitle: string;
  kind: "remove" | "duplicate" | "before" | "after";
  fieldId: string;
  targetId?: string;
  label: string;
};

export type SiteAgentPlan = {
  explanation: string;
  actionKind: "font" | "color" | "content" | "instruction" | "structure" | "attachment" | "command";
  summary: {
    totalPages: number;
    affectedPages: number;
    totalChanges: number;
  };
  pages: SiteAgentPagePlan[];
  structuralActions?: SiteAgentStructuralAction[];
  editorCommand?: "undo" | "redo" | "discard" | null;
  requiresApproval?: boolean;
  approvalReasons?: string[];
  riskLevel?: "low" | "medium" | "high";
  costUsd?: number;
  model?: string;
};

export type SiteOverview = {
  pageCount: number;
  fonts: Array<{ family: string; uses: number; pages: string[] }>;
  colors: Array<{ code: string; uses: number; pages: string[] }>;
  phoneNumbers: Array<{ number: string; uses: number; pages: string[] }>;
  emails: Array<{ email: string; uses: number; pages: string[] }>;
};

// ============================================================================
// Approval & Risk Classifier
// ============================================================================

export function enrichPlanWithApprovalMetadata(plan: SiteAgentPlan): SiteAgentPlan {
  const reasons: string[] = [...(plan.approvalReasons ?? [])];
  let hasDelete = false;
  let hasEntireText = false;
  let isSiteWide = false;

  if (plan.editorCommand === "discard") {
    hasDelete = true;
    if (!reasons.some(r => r.toLowerCase().includes("discard"))) {
      reasons.push("Discards all unpublished draft changes on this page.");
    }
  }

  for (const sAction of plan.structuralActions ?? []) {
    if (sAction.kind === "remove") {
      hasDelete = true;
      reasons.push(`Deletes element/section "${sAction.label}" from ${sAction.pageTitle}.`);
    }
  }

  for (const page of plan.pages) {
    const textValueChanges = page.changes.filter(c => c.property === "value");
    if (textValueChanges.length >= 4) {
      hasEntireText = true;
      reasons.push(`Replaces text across ${textValueChanges.length} elements on ${page.pageTitle}.`);
    }
    for (const change of page.changes) {
      if (change.property === "value" && change.before.trim().length > 0 && change.after.trim().length === 0) {
        hasDelete = true;
        reasons.push(`Deletes text content in "${change.label}" on ${page.pageTitle}.`);
      } else if (change.property === "value" && change.before.trim().length >= 120 && change.after.trim().length > 0) {
        hasEntireText = true;
        reasons.push(`Rewrites entire paragraph/text in "${change.label}" on ${page.pageTitle}.`);
      } else if (change.property === "style" && /\bdisplay\s*:\s*none\b/i.test(change.after)) {
        hasDelete = true;
        reasons.push(`Hides/removes "${change.label}" on ${page.pageTitle}.`);
      }
    }
  }

  if (plan.summary.affectedPages > 1) {
    isSiteWide = true;
    reasons.push(`Modifies ${plan.summary.affectedPages} pages across the entire website (${plan.summary.totalChanges} total changes).`);
  }

  const uniqueReasons = Array.from(new Set(reasons));
  const requiresApproval = Boolean(plan.requiresApproval) || hasDelete || hasEntireText || isSiteWide;
  const riskLevel: "low" | "medium" | "high" = hasDelete
    ? "high"
    : hasEntireText || isSiteWide
      ? "medium"
      : "low";

  return {
    ...plan,
    requiresApproval,
    approvalReasons: uniqueReasons,
    riskLevel,
  };
}

// ============================================================================
// Detection & Color Utilities
// ============================================================================

const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function normalizeColorCode(color: string): string {
  const trimmed = color.trim().toLowerCase();
  if (trimmed.startsWith("#")) {
    if (trimmed.length === 4) {
      return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
    }
    return trimmed;
  }
  return trimmed;
}

export function parseCssDeclarations(styleString: string | undefined): Record<string, string> {
  const declarations: Record<string, string> = {};
  if (!styleString) return declarations;
  for (const part of styleString.split(";")) {
    const colonIdx = part.indexOf(":");
    if (colonIdx > 0) {
      const prop = part.slice(0, colonIdx).trim().toLowerCase();
      const val = part.slice(colonIdx + 1).trim();
      if (prop && val) declarations[prop] = val;
    }
  }
  return declarations;
}

export function serializeCssDeclarations(declarations: Record<string, string>): string {
  return Object.entries(declarations)
    .filter(([_, val]) => Boolean(val))
    .map(([prop, val]) => `${prop}: ${val}`)
    .join("; ");
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractInlineStyleFonts(html: string): string[] {
  const fonts: string[] = [];
  const regex = /font-family\s*:\s*([^;}"']+)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (raw && raw.length <= 100 && !raw.includes("var(")) {
      fonts.push(raw.replace(/^['"]|['"]$/g, "").trim());
    }
  }
  return fonts;
}

function extractColorsFromHtml(html: string): string[] {
  const colors: string[] = [];
  const hexRegex = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  let match: RegExpExecArray | null;
  while ((match = hexRegex.exec(html)) !== null) {
    colors.push(normalizeColorCode(match[0]));
  }
  return colors;
}

// ============================================================================
// Site-Wide Overview Scanner
// ============================================================================
// Parallel Page Loader & Parse Cache
// ============================================================================

const parsedFieldsCache = new Map<string, { html: string; fields: SiteField[]; at: number }>();
const PARSED_CACHE_MAX = 150;
const PARSED_CACHE_TTL_MS = 60_000;

async function loadPageWithFields(
  site: Site,
  page: SitePage
): Promise<{ page: SitePage; html: string; fields: SiteField[]; existingDraft: Record<string, FieldValue> }> {
  const source = await pageSource(site, page);
  const existingDraft = (page.draft ?? {}) as Record<string, FieldValue>;
  const html = editingSource(source.html, existingDraft);
  const cacheKey = `${page.id}:${page.draftRevision}:${html.length}`;
  const now = Date.now();
  const cached = parsedFieldsCache.get(cacheKey);
  if (cached && now - cached.at < PARSED_CACHE_TTL_MS && cached.html === html) {
    return { page, html, fields: cached.fields, existingDraft };
  }
  const { fields } = discoverFields(html);
  if (parsedFieldsCache.size >= PARSED_CACHE_MAX) {
    const oldestKey = parsedFieldsCache.keys().next().value;
    if (oldestKey) parsedFieldsCache.delete(oldestKey);
  }
  parsedFieldsCache.set(cacheKey, { html, fields, at: now });
  return { page, html, fields, existingDraft };
}

async function loadLivePagesWithFields(
  site: Site,
  pages: SitePage[],
  concurrency = 6
): Promise<Array<{ page: SitePage; html: string; fields: SiteField[]; existingDraft: Record<string, FieldValue> }>> {
  const livePages = pages.filter(p => p.status !== "HIDDEN");
  const loaded: Array<{ page: SitePage; html: string; fields: SiteField[]; existingDraft: Record<string, FieldValue> }> = [];
  for (let i = 0; i < livePages.length; i += concurrency) {
    const batch = livePages.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(page => loadPageWithFields(site, page).catch(() => null))
    );
    for (const item of batchResults) {
      if (item) loaded.push(item);
    }
  }
  return loaded;
}

export async function scanSiteOverview(
  site: Site,
  pages: SitePage[]
): Promise<SiteOverview> {
  const fontMap = new Map<string, { uses: number; pages: Set<string> }>();
  const colorMap = new Map<string, { uses: number; pages: Set<string> }>();
  const phoneMap = new Map<string, { uses: number; pages: Set<string> }>();
  const emailMap = new Map<string, { uses: number; pages: Set<string> }>();

  const livePages = pages.filter(p => p.status !== "HIDDEN");
  const loadedPages = await loadLivePagesWithFields(site, pages);

  // Also inspect linked stylesheets on the primary page so sites styled via
  // external CSS / :root custom properties report their real palette & fonts.
  if (loadedPages[0]) {
    try {
      const sheets = await siteStylesheets(site, loadedPages[0].page, loadedPages[0].html, 5);
      for (const sheet of sheets) {
        for (const c of extractColorsFromHtml(sheet.css)) {
          const entry = colorMap.get(c) ?? { uses: 0, pages: new Set<string>() };
          entry.uses += 2;
          entry.pages.add("Site Stylesheet");
          colorMap.set(c, entry);
        }
        const fontDeclMatches = sheet.css.matchAll(/font-family\s*:\s*([^;}{]+)/gi);
        for (const match of fontDeclMatches) {
          const firstFamily = match[1]?.split(",")[0]?.replace(/^['"\s]+|['"\s]+$/g, "").trim();
          if (firstFamily && firstFamily.length >= 2 && !/^(inherit|initial|unset|sans-serif|serif|monospace|var\()/i.test(firstFamily)) {
            const key = firstFamily.toLowerCase();
            const entry = fontMap.get(key) ?? { uses: 0, pages: new Set<string>() };
            entry.uses += 2;
            entry.pages.add("Site Stylesheet");
            fontMap.set(key, entry);
          }
        }
      }
    } catch {
      // External stylesheet inspection is best-effort
    }
  }

  for (const { page, html, fields } of loadedPages) {
    try {
      for (const f of extractInlineStyleFonts(html)) {
        const key = f.toLowerCase();
        const entry = fontMap.get(key) ?? { uses: 0, pages: new Set<string>() };
        entry.uses += 1;
        entry.pages.add(page.title);
        fontMap.set(key, entry);
      }

      for (const c of extractColorsFromHtml(html)) {
        const entry = colorMap.get(c) ?? { uses: 0, pages: new Set<string>() };
        entry.uses += 1;
        entry.pages.add(page.title);
        colorMap.set(c, entry);
      }

      for (const field of fields) {
        if (field.style) {
          const decls = parseCssDeclarations(field.style);
          if (decls["font-family"]) {
            const ff = decls["font-family"].replace(/^['"]|['"]$/g, "").trim();
            const entry = fontMap.get(ff.toLowerCase()) ?? { uses: 0, pages: new Set<string>() };
            entry.uses += 1;
            entry.pages.add(page.title);
            fontMap.set(ff.toLowerCase(), entry);
          }
          for (const [, val] of Object.entries(decls)) {
            const hexMatches = val.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g);
            if (hexMatches) {
              for (const hm of hexMatches) {
                const norm = normalizeColorCode(hm);
                const entry = colorMap.get(norm) ?? { uses: 0, pages: new Set<string>() };
                entry.uses += 1;
                entry.pages.add(page.title);
                colorMap.set(norm, entry);
              }
            }
          }
        }

        const textToScan = `${field.value ?? ""} ${field.href ?? ""}`;
        const phones = textToScan.match(PHONE_REGEX);
        if (phones) {
          for (const rawPhone of phones) {
            const cleaned = rawPhone.trim();
            const digits = cleaned.replace(/\D/g, "");
            if (digits.length >= 8 && digits.length <= 15 && !/^(19|20)\d{2}/.test(cleaned)) {
              const entry = phoneMap.get(cleaned) ?? { uses: 0, pages: new Set<string>() };
              entry.uses += 1;
              entry.pages.add(page.title);
              phoneMap.set(cleaned, entry);
            }
          }
        }

        const emails = textToScan.match(EMAIL_REGEX);
        if (emails) {
          for (const rawEmail of emails) {
            const cleaned = rawEmail.trim().toLowerCase();
            const entry = emailMap.get(cleaned) ?? { uses: 0, pages: new Set<string>() };
            entry.uses += 1;
            entry.pages.add(page.title);
            emailMap.set(cleaned, entry);
          }
        }
      }
    } catch {
      // Skip unreadable pages without breaking site scan
    }
  }

  return {
    pageCount: livePages.length,
    fonts: [...fontMap.entries()]
      .map(([family, data]) => ({ family, uses: data.uses, pages: [...data.pages] }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 20),
    colors: [...colorMap.entries()]
      .map(([code, data]) => ({ code, uses: data.uses, pages: [...data.pages] }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 24),
    phoneNumbers: [...phoneMap.entries()]
      .map(([number, data]) => ({ number, uses: data.uses, pages: [...data.pages] }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 15),
    emails: [...emailMap.entries()]
      .map(([email, data]) => ({ email, uses: data.uses, pages: [...data.pages] }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 15),
  };
}

// ============================================================================
// 1. Global Font Family Replacement Planner
// ============================================================================

export async function planGlobalFontChange(
  site: Site,
  pages: SitePage[],
  options: {
    fromFont?: string;
    toFont: string;
    targetKinds?: Array<"heading" | "button" | "container" | "all" | "text">;
  }
): Promise<SiteAgentPlan> {
  const cleanToFont = options.toFont.trim().replace(/[;<>\\]/g, "");
  if (!cleanToFont || !/^[a-zA-Z0-9 ,\x22\x27-]+$/.test(cleanToFont)) {
    throw new WebsiteError(400, "Please provide a valid font family name (e.g. 'Inter, sans-serif' or 'Space Grotesk').");
  }

  const fromLower = (options.fromFont ?? "").trim().toLowerCase().replace(/^['"]|['"]$/g, "");
  const targetAll = !options.targetKinds || options.targetKinds.includes("all");
  const pagePlans: SiteAgentPagePlan[] = [];
  let totalChanges = 0;

  const loadedPages = await loadLivePagesWithFields(site, pages);

  for (const { page, fields, existingDraft } of loadedPages) {
    try {
      const changes: SiteAgentPagePlan["changes"] = [];
      const edits: Record<string, AgentFieldEdit> = {};

      for (const field of fields) {
        if (field.kind === "image") continue;

        const isHeading = /^h[1-6]$/i.test(field.tag);
        const isButton = field.kind === "button" || field.tag === "button" || (field.tag === "a" && Boolean(field.classes && /btn|button|cta/i.test(field.classes)));
        const isContainer = field.kind === "container";
        const isText = field.kind === "text" || field.kind === "richtext";

        const currentDecls = parseCssDeclarations(field.style);
        const existingFont = currentDecls["font-family"] ?? "";

        let shouldUpdate = false;
        if (fromLower) {
          if (existingFont.toLowerCase().includes(fromLower)) {
            shouldUpdate = true;
          }
        } else {
          if (targetAll) {
            if (isHeading || isButton || isText || existingFont) {
              shouldUpdate = true;
            }
          } else {
            if (options.targetKinds?.includes("heading") && isHeading) shouldUpdate = true;
            if (options.targetKinds?.includes("button") && isButton) shouldUpdate = true;
            if (options.targetKinds?.includes("container") && isContainer) shouldUpdate = true;
            if (options.targetKinds?.includes("text") && isText) shouldUpdate = true;
          }
        }

        if (!shouldUpdate) continue;
        if (existingFont.toLowerCase() === cleanToFont.toLowerCase()) continue;

        const nextDecls = { ...currentDecls, "font-family": cleanToFont };
        const serialized = serializeCssDeclarations(nextDecls);
        const sanitizedStyle = safeStyle(serialized, field.style);

        if (!sanitizedStyle || sanitizedStyle === (field.style ?? "")) continue;

        edits[field.id] = {
          ...(existingDraft[field.id] ? editableValues(existingDraft[field.id]) : {}),
          style: sanitizedStyle,
        };
        changes.push({
          fieldId: field.id,
          label: field.label,
          property: "font-family",
          before: existingFont || "Inherited",
          after: cleanToFont,
        });
      }

      if (changes.length > 0) {
        totalChanges += changes.length;
        pagePlans.push({
          pageId: page.id,
          pageTitle: page.title,
          pagePath: page.path,
          draftRevision: page.draftRevision,
          changes,
          edits,
        });
      }
    } catch {
      // Continue scanning remaining pages
    }
  }

  // Fallback for sites where fonts are set in external CSS rather than inline styles
  if (fromLower && totalChanges === 0) {
    for (const { page, fields, existingDraft } of loadedPages) {
      const changes: SiteAgentPagePlan["changes"] = [];
      const edits: Record<string, AgentFieldEdit> = {};
      for (const field of fields) {
        if (field.kind === "image") continue;
        const isHeading = /^h[1-6]$/i.test(field.tag);
        const isButton = field.kind === "button" || field.tag === "button" || (field.tag === "a" && Boolean(field.classes && /btn|button|cta/i.test(field.classes)));
        if (!isHeading && !isButton) continue;
        const currentDecls = parseCssDeclarations(field.style);
        const existingFont = currentDecls["font-family"] ?? "";
        if (existingFont.toLowerCase() === cleanToFont.toLowerCase()) continue;
        const nextDecls = { ...currentDecls, "font-family": cleanToFont };
        const sanitizedStyle = safeStyle(serializeCssDeclarations(nextDecls), field.style);
        if (!sanitizedStyle || sanitizedStyle === (field.style ?? "")) continue;
        edits[field.id] = {
          ...(existingDraft[field.id] ? editableValues(existingDraft[field.id]) : {}),
          style: sanitizedStyle,
        };
        changes.push({
          fieldId: field.id,
          label: field.label,
          property: "font-family",
          before: existingFont || `Stylesheet (${options.fromFont})`,
          after: cleanToFont,
        });
      }
      if (changes.length > 0) {
        totalChanges += changes.length;
        pagePlans.push({
          pageId: page.id,
          pageTitle: page.title,
          pagePath: page.path,
          draftRevision: page.draftRevision,
          changes,
          edits,
        });
      }
    }
  }

  const explanation = fromLower
    ? `Change font family from "${options.fromFont}" to "${cleanToFont}" across ${pagePlans.length} page${pagePlans.length === 1 ? "" : "s"} (${totalChanges} element${totalChanges === 1 ? "" : "s"}).`
    : `Change font family to "${cleanToFont}" across ${pagePlans.length} page${pagePlans.length === 1 ? "" : "s"} (${totalChanges} element${totalChanges === 1 ? "" : "s"}).`;

  return enrichPlanWithApprovalMetadata({
    explanation,
    actionKind: "font",
    summary: {
      totalPages: pages.filter(p => p.status !== "HIDDEN").length,
      affectedPages: pagePlans.length,
      totalChanges,
    },
    pages: pagePlans,
  });
}

// ============================================================================
// 2. Global Color Code Replacement Planner
// ============================================================================

export async function planGlobalColorChange(
  site: Site,
  pages: SitePage[],
  options: {
    fromColor: string;
    toColor: string;
    properties?: string[];
  }
): Promise<SiteAgentPlan> {
  const cleanFrom = normalizeColorCode(options.fromColor);
  const cleanTo = options.toColor.trim();
  if (!cleanFrom || !cleanTo || /[;<>\\]/.test(cleanTo)) {
    throw new WebsiteError(400, "Provide valid source and target color codes (e.g. #08101F to #3157FF).");
  }

  const pagePlans: SiteAgentPagePlan[] = [];
  let totalChanges = 0;

  const targetProps = options.properties?.length
    ? new Set(options.properties.map(p => p.toLowerCase()))
    : new Set(["color", "background-color", "border-color", "box-shadow"]);

  const loadedPages = await loadLivePagesWithFields(site, pages);

  for (const { page, fields, existingDraft } of loadedPages) {
    try {
      const changes: SiteAgentPagePlan["changes"] = [];
      const edits: Record<string, AgentFieldEdit> = {};

      for (const field of fields) {
        const currentDecls = parseCssDeclarations(field.style);
        let modified = false;
        const nextDecls = { ...currentDecls };

        for (const [prop, val] of Object.entries(currentDecls)) {
          if (!targetProps.has(prop)) continue;
          const valNormalized = val.replace(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (m) => normalizeColorCode(m));
          if (valNormalized.toLowerCase().includes(cleanFrom.toLowerCase())) {
            const replacedVal = valNormalized.replace(
              new RegExp(escapeRegExp(cleanFrom), "gi"),
              cleanTo
            );
            if (replacedVal !== val) {
              nextDecls[prop] = replacedVal;
              modified = true;
              changes.push({
                fieldId: field.id,
                label: field.label,
                property: prop,
                before: val,
                after: replacedVal,
              });
            }
          }
        }

        if (modified) {
          const serialized = serializeCssDeclarations(nextDecls);
          const sanitizedStyle = safeStyle(serialized, field.style);
          if (sanitizedStyle && sanitizedStyle !== (field.style ?? "")) {
            edits[field.id] = {
              ...(existingDraft[field.id] ? editableValues(existingDraft[field.id]) : {}),
              style: sanitizedStyle,
            };
          }
        }
      }

      if (changes.length > 0 && Object.keys(edits).length > 0) {
        totalChanges += changes.length;
        pagePlans.push({
          pageId: page.id,
          pageTitle: page.title,
          pagePath: page.path,
          draftRevision: page.draftRevision,
          changes,
          edits,
        });
      }
    } catch {
      // Skip unreadable pages
    }
  }

  // Fallback for sites styled via external CSS / :root custom properties:
  // If no inline styles matched `fromColor`, apply `cleanTo` to primary CTA buttons
  // across the site so stylesheet-driven websites can still recolor their brand accents.
  if (totalChanges === 0) {
    const wantsBg = targetProps.has("background-color");
    const propToApply = wantsBg ? "background-color" : "color";
    for (const { page, fields, existingDraft } of loadedPages) {
      const changes: SiteAgentPagePlan["changes"] = [];
      const edits: Record<string, AgentFieldEdit> = {};
      for (const field of fields) {
        const isButton = field.kind === "button" || field.tag === "button" || (field.tag === "a" && Boolean(field.classes && /btn|button|cta/i.test(field.classes)));
        const isPrimaryHeading = !wantsBg && /^h[1-2]$/i.test(field.tag);
        if (!isButton && !isPrimaryHeading) continue;
        const currentDecls = parseCssDeclarations(field.style);
        if (currentDecls[propToApply]?.toLowerCase() === cleanTo.toLowerCase()) continue;
        const nextDecls = { ...currentDecls, [propToApply]: cleanTo };
        const sanitizedStyle = safeStyle(serializeCssDeclarations(nextDecls), field.style);
        if (!sanitizedStyle || sanitizedStyle === (field.style ?? "")) continue;
        edits[field.id] = {
          ...(existingDraft[field.id] ? editableValues(existingDraft[field.id]) : {}),
          style: sanitizedStyle,
        };
        changes.push({
          fieldId: field.id,
          label: field.label,
          property: propToApply,
          before: currentDecls[propToApply] || `${options.fromColor} (Stylesheet)`,
          after: cleanTo,
        });
      }
      if (changes.length > 0) {
        totalChanges += changes.length;
        pagePlans.push({
          pageId: page.id,
          pageTitle: page.title,
          pagePath: page.path,
          draftRevision: page.draftRevision,
          changes,
          edits,
        });
      }
    }
  }

  const explanation = totalChanges > 0
    ? `Replace color "${options.fromColor}" with "${cleanTo}" across ${pagePlans.length} page${pagePlans.length === 1 ? "" : "s"} (${totalChanges} style rule${totalChanges === 1 ? "" : "s"}).`
    : `No elements with color "${options.fromColor}" were found across the pages. Tip: Select an element or apply a target color directly.`;

  return enrichPlanWithApprovalMetadata({
    explanation,
    actionKind: "color",
    summary: {
      totalPages: pages.filter(p => p.status !== "HIDDEN").length,
      affectedPages: pagePlans.length,
      totalChanges,
    },
    pages: pagePlans,
  });
}

// ============================================================================
// 3. Cross-Page Content / Phone / Email Replacement Planner
// ============================================================================

export async function planCrossPageContentChange(
  site: Site,
  pages: SitePage[],
  options: {
    findText: string;
    replaceText: string;
    kind?: "phone" | "email" | "text" | "auto";
  }
): Promise<SiteAgentPlan> {
  const trimmedFind = options.findText.trim();
  const trimmedReplace = options.replaceText.trim();
  if (!trimmedFind) {
    throw new WebsiteError(400, "Enter the text, phone number, or email address to find.");
  }

  const isPhone = options.kind === "phone" || (options.kind === "auto" && /^\+?[\d\s().-]{7,20}$/.test(trimmedFind));
  const isEmail = options.kind === "email" || (options.kind === "auto" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedFind));

  const findDigits = isPhone ? trimmedFind.replace(/\D/g, "") : "";
  const replaceTelHref = isPhone ? `tel:${trimmedReplace.replace(/\D/g, "")}` : "";
  const replaceMailHref = isEmail ? `mailto:${trimmedReplace}` : "";

  const pagePlans: SiteAgentPagePlan[] = [];
  let totalChanges = 0;

  const loadedPages = await loadLivePagesWithFields(site, pages);

  for (const { page, fields, existingDraft } of loadedPages) {
    try {
      const changes: SiteAgentPagePlan["changes"] = [];
      const edits: Record<string, AgentFieldEdit> = {};

      for (const field of fields) {
        const currentEdit: AgentFieldEdit = existingDraft[field.id] ? editableValues(existingDraft[field.id]) : {};
        let fieldModified = false;

        if (field.kind !== "image" && field.value) {
          let nextValue = field.value;
          if (field.value.includes(trimmedFind)) {
            nextValue = field.value.split(trimmedFind).join(trimmedReplace);
          } else if (isPhone && findDigits.length >= 8) {
            const matches = field.value.match(PHONE_REGEX);
            if (matches) {
              for (const m of matches) {
                if (m.replace(/\D/g, "") === findDigits) {
                  nextValue = nextValue.split(m).join(trimmedReplace);
                }
              }
            }
          } else if (isEmail) {
            const emailSearch = new RegExp(escapeRegExp(trimmedFind), "gi");
            if (emailSearch.test(field.value)) {
              nextValue = field.value.replace(emailSearch, trimmedReplace);
            }
          }

          if (nextValue !== field.value) {
            currentEdit.value = nextValue;
            fieldModified = true;
            changes.push({
              fieldId: field.id,
              label: field.label,
              property: "value",
              before: field.value,
              after: nextValue,
            });
          }
        }

        if (field.href) {
          let nextHref = field.href;
          if (isPhone && field.href.toLowerCase().startsWith("tel:")) {
            const hrefDigits = field.href.slice(4).replace(/\D/g, "");
            if (hrefDigits === findDigits || field.href.includes(trimmedFind)) {
              nextHref = replaceTelHref;
            }
          } else if (isEmail && field.href.toLowerCase().startsWith("mailto:")) {
            const mailAddr = field.href.slice(7).split("?")[0] ?? "";
            if (mailAddr.toLowerCase() === trimmedFind.toLowerCase() || field.href.toLowerCase().includes(trimmedFind.toLowerCase())) {
              nextHref = replaceMailHref;
            }
          } else if (field.href.includes(trimmedFind)) {
            nextHref = field.href.split(trimmedFind).join(trimmedReplace);
          }

          if (nextHref !== field.href) {
            currentEdit.href = nextHref;
            fieldModified = true;
            changes.push({
              fieldId: field.id,
              label: field.label,
              property: "href",
              before: field.href,
              after: nextHref,
            });
          }
        }

        if (fieldModified) {
          edits[field.id] = currentEdit;
        }
      }

      if (changes.length > 0) {
        totalChanges += changes.length;
        pagePlans.push({
          pageId: page.id,
          pageTitle: page.title,
          pagePath: page.path,
          draftRevision: page.draftRevision,
          changes,
          edits,
        });
      }
    } catch {
      // Skip unreadable page
    }
  }

  const label = isPhone ? "phone number" : isEmail ? "email address" : "content";
  const explanation = totalChanges > 0
    ? `Updated ${label} from "${trimmedFind}" to "${trimmedReplace}" across ${pagePlans.length} page${pagePlans.length === 1 ? "" : "s"} (${totalChanges} field${totalChanges === 1 ? "" : "s"}).`
    : `No matching ${label} found for "${trimmedFind}" on this website.`;

  return enrichPlanWithApprovalMetadata({
    explanation,
    actionKind: "content",
    summary: {
      totalPages: pages.filter(p => p.status !== "HIDDEN").length,
      affectedPages: pagePlans.length,
      totalChanges,
    },
    pages: pagePlans,
  });
}

// ============================================================================
// 4. Attachment & Single-Page / Multi-Page Comprehensive Instruction Planner
// ============================================================================

const AI_AGENT_SYSTEM_DOCTRINE = `You are the Website Builder Agent for a connected website. Your job is to execute ANY website builder task requested by the user across their current page or across all pages of their site.
You can:
- Change any text, heading, paragraph, button label, or rich text content
- Clear or delete text or remove/duplicate/reorder page blocks & sections
- Change any CSS styling (color, background-color, background-image, font-family, font-size, font-weight, line-height, letter-spacing, text-align, text-transform, border-radius, border-color, border-width, padding, margin, gap, opacity, box-shadow, display, justify-content, align-items, width, height)
- Replace background images or <img> sources with attached image URLs
- Set button/anchor links (href) to attached files (like PDFs/documents) or external/internal URLs
- Perform global font family, color code, phone number, or email replacements across all pages
- Execute undo, redo, or discard draft commands
Always return a valid JSON plan matching the schema.`;

const aiPlanSchema = z.object({
  explanation: z.string(),
  intent: z.enum(["font", "color", "phone", "email", "content", "page_edits", "structure", "command"]),
  editorCommand: z.enum(["undo", "redo", "discard"]).nullable().optional(),
  parsedOperation: z.object({
    from: z.string().default(""),
    to: z.string().default(""),
    property: z.string().nullable().default(null),
  }).optional(),
  structuralActions: z.array(z.object({
    pageId: z.string(),
    kind: z.enum(["remove", "duplicate", "before", "after"]),
    fieldId: z.string(),
    targetId: z.string().nullable().optional(),
    label: z.string().default("Block"),
  })).optional().default([]),
  pages: z.array(z.object({
    pageId: z.string(),
    changes: z.array(z.object({
      fieldId: z.string(),
      operation: z.enum(["replace_text", "set_link", "set_alt", "set_style", "set_variant", "set_new_tab"]),
      property: z.string().nullable().default(null),
      value: z.string(),
    })),
  })).default([]),
});

function findMatchingFieldOnPage(
  fields: SiteField[],
  selectedFieldId: string | null | undefined,
  promptLower: string,
  filterFn?: (field: SiteField) => boolean
): SiteField | null {
  const candidates = filterFn ? fields.filter(filterFn) : fields;
  if (!candidates.length) return null;

  if (selectedFieldId) {
    const exactSelected = candidates.find(f => f.id === selectedFieldId);
    if (exactSelected) return exactSelected;
  }

  // Score candidates by how well their label, tag, or current value matches words in promptLower
  let bestField: SiteField | null = null;
  let bestScore = 0;

  for (const field of candidates) {
    let score = 0;
    const labelLower = field.label.toLowerCase();
    const valLower = (field.value ?? "").toLowerCase();
    const tagLower = field.tag.toLowerCase();

    if (labelLower && promptLower.includes(labelLower)) score += 10;
    if (valLower && valLower.length >= 3 && valLower.length <= 50 && promptLower.includes(valLower)) score += 12;

    if (promptLower.includes("hero") && (/hero|banner|header|main/i.test(labelLower) || /hero|banner/i.test(field.classes ?? ""))) score += 8;
    if (promptLower.includes("header") && (/header|nav|top/i.test(labelLower) || tagLower === "header" || tagLower === "nav")) score += 8;
    if (promptLower.includes("footer") && (/footer|bottom/i.test(labelLower) || tagLower === "footer")) score += 8;
    if (promptLower.includes("heading") || promptLower.includes("title") || promptLower.includes("headline")) {
      if (tagLower === "h1") score += 9;
      else if (/^h[2-6]$/.test(tagLower)) score += 6;
    }
    if (promptLower.includes("button") || promptLower.includes("cta")) {
      if (field.kind === "button" || tagLower === "button" || (tagLower === "a" && /btn|button|cta/i.test(field.classes ?? ""))) score += 9;
    }
    if (promptLower.includes("download") && (/download|brochure|pdf|file|get|resume/i.test(valLower) || /download/i.test(labelLower))) score += 11;
    if (promptLower.includes("logo") && (/logo|brand/i.test(labelLower) || /logo/i.test(field.alt ?? "") || /logo/i.test(valLower))) score += 11;

    if (score > bestScore) {
      bestScore = score;
      bestField = field;
    }
  }

  return bestField ?? candidates[0] ?? null;
}

export async function planAgentInstruction(
  site: Site,
  pages: SitePage[],
  prompt: string,
  options?: {
    brandVoice?: string;
    pageId?: string;
    selectedFieldId?: string | null;
    edits?: Record<string, AgentFieldEdit>;
    attachments?: AgentAttachment[];
    history?: AgentChatHistoryTurn[];
  }
): Promise<SiteAgentPlan> {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();
  const attachments = options?.attachments ?? [];
  const history = options?.history ?? [];
  const livePages = pages.filter(p => p.status !== "HIDDEN");
  const currentPage = (options?.pageId ? pages.find(p => p.id === options?.pageId) : null) ?? livePages[0] ?? null;

  // Resolve referential pronouns ("make it bigger", "bold it", "center that") from recent conversation history
  let resolvedSelectedFieldId = options?.selectedFieldId ?? null;
  if (!resolvedSelectedFieldId && history.length > 0 && /\b(it|this|that|same|bigger|smaller|bold|center|colour|color)\b/i.test(lower)) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const turn = history[i];
      if (turn?.targetFieldIds && turn.targetFieldIds.length > 0) {
        resolvedSelectedFieldId = turn.targetFieldIds[0]!;
        break;
      }
    }
  }
  if (options && resolvedSelectedFieldId) {
    options = { ...options, selectedFieldId: resolvedSelectedFieldId };
  }

  // --------------------------------------------------------------------------
  // A. Direct Editor History & Draft Commands (Undo, Redo, Discard)
  // --------------------------------------------------------------------------
  if (/^(?:please\s+|can you\s+)?(?:undo(?:\s+(?:my|the|that|last|previous|recent|change|edit|action))*|go back|revert(?:\s+(?:my|the|that|last|change|edit))*|step back)[.!]?$/i.test(trimmed)) {
    return enrichPlanWithApprovalMetadata({
      explanation: "Undid the last change on the canvas.",
      actionKind: "command",
      editorCommand: "undo",
      summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
      pages: [],
      requiresApproval: false,
    });
  }

  if (/^(?:please\s+|can you\s+)?(?:redo(?:\s+(?:my|the|that|last|previous|change|edit|action))*|step forward)[.!]?$/i.test(trimmed)) {
    return enrichPlanWithApprovalMetadata({
      explanation: "Redid the change on the canvas.",
      actionKind: "command",
      editorCommand: "redo",
      summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
      pages: [],
      requiresApproval: false,
    });
  }

  if (/^(?:please\s+|can you\s+)?(?:discard|reset)(?:\s+(?:all|my|the|unpublished|page|draft|changes|edits))+[.!]?$/i.test(trimmed)) {
    return enrichPlanWithApprovalMetadata({
      explanation: `Discard all unpublished draft edits on "${currentPage?.title ?? "this page"}".`,
      actionKind: "command",
      editorCommand: "discard",
      summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
      pages: [],
      requiresApproval: true,
      approvalReasons: [`Discards all unpublished draft edits on "${currentPage?.title ?? "this page"}".`],
    });
  }

  // --------------------------------------------------------------------------
  // A2. Direct SEO Title, Meta Description & Auto-SEO Optimization Commands
  // --------------------------------------------------------------------------
  if (currentPage && /\b(seo|meta\s+description|page\s+title|browser\s+title|search\s+description)\b/i.test(lower)) {
    try {
      const source = await pageSource(site, currentPage);
      const existingDraft = {
        ...((currentPage.draft ?? {}) as Record<string, FieldValue>),
        ...(options?.edits ?? {}),
      };
      const html = editingSource(source.html, existingDraft);
      const { fields } = discoverFields(html);
      const titleField = fields.find((f) => f.id === "meta.0");
      const descField = fields.find((f) => f.id === "meta.1");

      const seoTitleMatch = /(?:set|change|update)\s+(?:the\s+)?(?:seo\s+title|page\s+title|browser\s+title)\s+(?:to\s+)["']?([^"'\n]+?)["']?$/i.exec(trimmed);
      const seoDescMatch = /(?:set|change|update)\s+(?:the\s+)?(?:seo\s+description|meta\s+description|search\s+description)\s+(?:to\s+)["']?([^"'\n]+?)["']?$/i.exec(trimmed);
      const isAutoSeo = /\b(auto[- ]?generate|optimize|improve|write)\b[\s\S]*\bseo\b/i.test(lower);

      const pageChanges: SiteAgentPagePlan["changes"] = [];
      const pageEdits: Record<string, AgentFieldEdit> = {};

      if (seoTitleMatch?.[1] && titleField) {
        const nextTitle = seoTitleMatch[1].trim();
        pageEdits["meta.0"] = { value: nextTitle };
        pageChanges.push({
          fieldId: "meta.0",
          label: titleField.label,
          property: "value",
          before: titleField.value,
          after: nextTitle,
        });
      } else if (seoDescMatch?.[1] && descField) {
        const nextDesc = seoDescMatch[1].trim();
        pageEdits["meta.1"] = { value: nextDesc };
        pageChanges.push({
          fieldId: "meta.1",
          label: descField.label,
          property: "value",
          before: descField.value,
          after: nextDesc,
        });
      } else if (isAutoSeo && (titleField || descField)) {
        const smart = generateSmartPageSeo(site, currentPage, html);
        if (titleField && smart.title && smart.title !== titleField.value) {
          pageEdits["meta.0"] = { value: smart.title };
          pageChanges.push({
            fieldId: "meta.0",
            label: titleField.label,
            property: "value",
            before: titleField.value,
            after: smart.title,
          });
        }
        if (descField && smart.description && smart.description !== descField.value) {
          pageEdits["meta.1"] = { value: smart.description };
          pageChanges.push({
            fieldId: "meta.1",
            label: descField.label,
            property: "value",
            before: descField.value,
            after: smart.description,
          });
        }
      }

      if (pageChanges.length > 0) {
        return enrichPlanWithApprovalMetadata({
          explanation: `Updated SEO metadata (${pageChanges.map((c) => c.label).join(" & ")}) on "${currentPage.title}". OpenGraph & Twitter Card tags will automatically sync on publish.`,
          actionKind: "instruction",
          summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: pageChanges.length },
          pages: [
            {
              pageId: currentPage.id,
              pageTitle: currentPage.title,
              pagePath: currentPage.path,
              draftRevision: currentPage.draftRevision,
              changes: pageChanges,
              edits: pageEdits,
            },
          ],
          requiresApproval: false,
        });
      }
    } catch {
      // Fall through to general AI planner if needed
    }
  }

  // --------------------------------------------------------------------------
  // B. Attachment-Driven Operations (Replace Background, Swap Image, Link File)
  // --------------------------------------------------------------------------
  if (attachments.length > 0 && currentPage) {
    try {
      const source = await pageSource(site, currentPage);
      const existingDraft = {
        ...((currentPage.draft ?? {}) as Record<string, FieldValue>),
        ...(options?.edits ?? {}),
      };
      const html = editingSource(source.html, existingDraft);
      const { fields } = discoverFields(html);

      const imageAttachments = attachments.filter(a => a.kind === "image" || (a.contentType && a.contentType.startsWith("image/")));
      const fileAttachments = attachments.filter(a => !imageAttachments.includes(a));
      const primaryAttachment = attachments[0]!;

      const wantsBackground =
        /\b(?:background|bg|backdrop|hero background|section background|banner background)\b/i.test(lower) ||
        (imageAttachments.length > 0 && options?.selectedFieldId && fields.find(f => f.id === options.selectedFieldId)?.kind === "container" && !/\b(?:link|href|button)\b/i.test(lower));

      const wantsLink =
        fileAttachments.length > 0 ||
        /\b(?:link|button|download|href|point to|open this|attach to|file|pdf|brochure|document)\b/i.test(lower) ||
        (options?.selectedFieldId && (() => {
          const sel = fields.find(f => f.id === options.selectedFieldId);
          return Boolean(sel && (sel.kind === "button" || sel.tag === "a" || sel.href !== undefined));
        })());

      // 1. Replace Background with Attached Image
      if (wantsBackground && imageAttachments[0]) {
        const img = imageAttachments[0];
        const targetField = findMatchingFieldOnPage(
          fields,
          options?.selectedFieldId,
          lower,
          (f) => f.kind === "container" || /^(?:section|div|header|main|article|aside|footer)$/i.test(f.tag)
        ) ?? fields.find(f => f.kind !== "image") ?? fields[0];

        if (targetField) {
          const currentDecls = parseCssDeclarations(targetField.style);
          const nextDecls = {
            ...currentDecls,
            "background-image": `url(${img.url})`,
            "background-size": currentDecls["background-size"] || "cover",
            "background-position": currentDecls["background-position"] || "center",
          };
          const serialized = serializeCssDeclarations(nextDecls);
          const sanitizedStyle = safeStyle(serialized, targetField.style);

          if (sanitizedStyle) {
            const pagePlan: SiteAgentPagePlan = {
              pageId: currentPage.id,
              pageTitle: currentPage.title,
              pagePath: currentPage.path,
              draftRevision: currentPage.draftRevision,
              changes: [{
                fieldId: targetField.id,
                label: targetField.label,
                property: "background-image",
                before: currentDecls["background-image"] || "None",
                after: `url(${img.url}) (${img.filename})`,
              }],
              edits: {
                [targetField.id]: {
                  ...(existingDraft[targetField.id] ? editableValues(existingDraft[targetField.id]) : {}),
                  style: sanitizedStyle,
                },
              },
            };

            return enrichPlanWithApprovalMetadata({
              explanation: `Updated the background of "${targetField.label}" on ${currentPage.title} using "${img.filename}".`,
              actionKind: "attachment",
              summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
              pages: [pagePlan],
              requiresApproval: false,
            });
          }
        }
      }

      // 2. Link Button or Anchor to Attached File (or Image)
      if (wantsLink) {
        const targetFile = fileAttachments[0] ?? primaryAttachment;
        const targetField = findMatchingFieldOnPage(
          fields,
          options?.selectedFieldId,
          lower,
          (f) => f.kind === "button" || f.tag === "a" || f.href !== undefined
        );

        if (targetField) {
          const prevEdit = existingDraft[targetField.id] ? editableValues(existingDraft[targetField.id]) : {};
          const nextEdit: AgentFieldEdit = {
            ...prevEdit,
            href: targetFile.url,
            newTab: true,
          };

          const changes: SiteAgentPagePlan["changes"] = [
            {
              fieldId: targetField.id,
              label: targetField.label,
              property: "href",
              before: targetField.href || "None",
              after: `${targetFile.url} (${targetFile.filename})`,
            },
          ];

          // Optional button label update if user asked e.g. "and change text to 'Download PDF'"
          const renameMatch = trimmed.match(/(?:call it|text to|label to|rename to|say)\s+['"]([^'"]+)['"]/i);
          if (renameMatch && renameMatch[1]) {
            nextEdit.value = renameMatch[1].trim();
            changes.push({
              fieldId: targetField.id,
              label: targetField.label,
              property: "value",
              before: targetField.value,
              after: nextEdit.value,
            });
          }

          return enrichPlanWithApprovalMetadata({
            explanation: `Linked "${targetField.label}" on ${currentPage.title} to "${targetFile.filename}" (opens in a new tab).`,
            actionKind: "attachment",
            summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: changes.length },
            pages: [{
              pageId: currentPage.id,
              pageTitle: currentPage.title,
              pagePath: currentPage.path,
              draftRevision: currentPage.draftRevision,
              changes,
              edits: { [targetField.id]: nextEdit },
            }],
            requiresApproval: false,
          });
        }
      }

      // 3. Replace an <img> Element with Attached Image
      if (imageAttachments[0]) {
        const img = imageAttachments[0];
        const targetField = findMatchingFieldOnPage(
          fields,
          options?.selectedFieldId,
          lower,
          (f) => f.kind === "image"
        );

        if (targetField) {
          const prevEdit = existingDraft[targetField.id] ? editableValues(existingDraft[targetField.id]) : {};
          const cleanAlt = img.alt || img.filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
          const nextEdit: AgentFieldEdit = {
            ...prevEdit,
            value: img.url,
            alt: cleanAlt,
          };

          return enrichPlanWithApprovalMetadata({
            explanation: `Replaced image "${targetField.label}" on ${currentPage.title} with "${img.filename}".`,
            actionKind: "attachment",
            summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
            pages: [{
              pageId: currentPage.id,
              pageTitle: currentPage.title,
              pagePath: currentPage.path,
              draftRevision: currentPage.draftRevision,
              changes: [{
                fieldId: targetField.id,
                label: targetField.label,
                property: "src",
                before: targetField.value || "Original image",
                after: `${img.url} (${img.filename})`,
              }],
              edits: { [targetField.id]: nextEdit },
            }],
            requiresApproval: false,
          });
        }
      }
    } catch {
      // Fall through to general handlers if attachment heuristic encounters an error
    }
  }

  // --------------------------------------------------------------------------
  // C. Site-Wide Fast Pattern Matchers (Font, Color, Phone, Email)
  // --------------------------------------------------------------------------
  const fontMatch = trimmed.match(/change (?:every |all )?font(?: family)? (?:from (.+?) )?to ([^.,;]+)/i);
  if (fontMatch) {
    const fromFont = fontMatch[1]?.trim() ?? "";
    const toFont = fontMatch[2]?.trim() ?? "";
    if (toFont) {
      return planGlobalFontChange(site, pages, { fromFont, toFont });
    }
  }

  const colorMatch = trimmed.match(/change (?:every |all )?color (?:of )?(#[0-9a-fA-F]{3,8}|[a-zA-Z]+) to (#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/i);
  if (colorMatch) {
    const fromColor = colorMatch[1]?.trim() ?? "";
    const toColor = colorMatch[2]?.trim() ?? "";
    if (fromColor && toColor) {
      return planGlobalColorChange(site, pages, { fromColor, toColor });
    }
  }

  const phoneMatch = trimmed.match(/change (?:the |our )?phone(?: number)? (?:from (.+?) )?to ([^.,;]+)/i);
  if (phoneMatch) {
    const fromPhone = phoneMatch[1]?.trim();
    const toPhone = phoneMatch[2]?.trim() ?? "";
    if (fromPhone && toPhone) {
      return planCrossPageContentChange(site, pages, { findText: fromPhone, replaceText: toPhone, kind: "phone" });
    }
    if (toPhone) {
      const overview = await scanSiteOverview(site, pages);
      const existingPhone = overview.phoneNumbers[0]?.number;
      if (existingPhone) {
        return planCrossPageContentChange(site, pages, { findText: existingPhone, replaceText: toPhone, kind: "phone" });
      }
    }
  }

  const emailMatch = trimmed.match(/change (?:the |our )?email (?:from (.+?) )?to ([^.,;]+)/i);
  if (emailMatch) {
    const fromEmail = emailMatch[1]?.trim();
    const toEmail = emailMatch[2]?.trim() ?? "";
    if (fromEmail && toEmail) {
      return planCrossPageContentChange(site, pages, { findText: fromEmail, replaceText: toEmail, kind: "email" });
    }
    if (toEmail) {
      const overview = await scanSiteOverview(site, pages);
      const existingEmail = overview.emails[0]?.email;
      if (existingEmail) {
        return planCrossPageContentChange(site, pages, { findText: existingEmail, replaceText: toEmail, kind: "email" });
      }
    }
  }

  // --------------------------------------------------------------------------
  // D. Single-Page Structural, Delete, & Styling Operations on Current Page
  // --------------------------------------------------------------------------
  if (currentPage) {
    try {
      const source = await pageSource(site, currentPage);
      const existingDraft = {
        ...((currentPage.draft ?? {}) as Record<string, FieldValue>),
        ...(options?.edits ?? {}),
      };
      const html = editingSource(source.html, existingDraft);
      const { fields } = discoverFields(html);
      const controls = structureControls(html);

      // 1. Delete / Remove Block or Clear Entire Text
      if (/\b(?:delete|remove|erase|clear|wipe)\b/i.test(lower)) {
        const wantsClearAllText = /\b(?:all text|entire text|every text|whole text)\b/i.test(lower);
        if (wantsClearAllText) {
          const textFields = fields.filter(f => (f.kind === "text" || f.kind === "richtext") && f.value.trim().length > 0).slice(0, 20);
          if (textFields.length > 0) {
            const edits: Record<string, AgentFieldEdit> = {};
            const changes: SiteAgentPagePlan["changes"] = [];
            for (const tf of textFields) {
              edits[tf.id] = { ...(existingDraft[tf.id] ? editableValues(existingDraft[tf.id]) : {}), value: "" };
              changes.push({ fieldId: tf.id, label: tf.label, property: "value", before: tf.value, after: "" });
            }
            return enrichPlanWithApprovalMetadata({
              explanation: `Clear text content across ${changes.length} elements on ${currentPage.title}.`,
              actionKind: "content",
              summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: changes.length },
              pages: [{ pageId: currentPage.id, pageTitle: currentPage.title, pagePath: currentPage.path, draftRevision: currentPage.draftRevision, changes, edits }],
              requiresApproval: true,
              approvalReasons: [`Deletes entire text across ${changes.length} elements on ${currentPage.title}.`],
            });
          }
        }

        // Target specific element or section to delete/remove
        const targetField = findMatchingFieldOnPage(
          fields,
          options?.selectedFieldId,
          lower,
          (f) => Boolean(controls[f.id]?.remove)
        ) ?? findMatchingFieldOnPage(fields, options?.selectedFieldId, lower);

        if (targetField) {
          const ctrl = controls[targetField.id];
          if (ctrl?.remove && !/\b(?:text|words)\b/i.test(lower)) {
            return enrichPlanWithApprovalMetadata({
              explanation: `Delete block "${targetField.label}" from ${currentPage.title}.`,
              actionKind: "structure",
              summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
              pages: [],
              structuralActions: [{
                pageId: currentPage.id,
                pageTitle: currentPage.title,
                kind: "remove",
                fieldId: targetField.id,
                label: targetField.label,
              }],
              requiresApproval: true,
              approvalReasons: [`Deletes element/section "${targetField.label}" from ${currentPage.title}.`],
            });
          }

          // Otherwise clear text or hide element
          const wantsTextClear = /\b(?:text|words|heading|title|paragraph)\b/i.test(lower) && targetField.kind !== "image" && targetField.kind !== "container";
          if (wantsTextClear) {
            const nextEdit: AgentFieldEdit = {
              ...(existingDraft[targetField.id] ? editableValues(existingDraft[targetField.id]) : {}),
              value: "",
            };
            return enrichPlanWithApprovalMetadata({
              explanation: `Delete text in "${targetField.label}" on ${currentPage.title}.`,
              actionKind: "content",
              summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
              pages: [{
                pageId: currentPage.id,
                pageTitle: currentPage.title,
                pagePath: currentPage.path,
                draftRevision: currentPage.draftRevision,
                changes: [{ fieldId: targetField.id, label: targetField.label, property: "value", before: targetField.value, after: "" }],
                edits: { [targetField.id]: nextEdit },
              }],
              requiresApproval: true,
              approvalReasons: [`Deletes text content from "${targetField.label}" on ${currentPage.title}.`],
            });
          } else {
            const currentDecls = parseCssDeclarations(targetField.style);
            const sanitizedStyle = safeStyle(serializeCssDeclarations({ ...currentDecls, display: "none" }), targetField.style);
            if (sanitizedStyle) {
              return enrichPlanWithApprovalMetadata({
                explanation: `Remove/hide "${targetField.label}" on ${currentPage.title}.`,
                actionKind: "instruction",
                summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
                pages: [{
                  pageId: currentPage.id,
                  pageTitle: currentPage.title,
                  pagePath: currentPage.path,
                  draftRevision: currentPage.draftRevision,
                  changes: [{ fieldId: targetField.id, label: targetField.label, property: "style", before: targetField.style || "visible", after: sanitizedStyle }],
                  edits: { [targetField.id]: { ...(existingDraft[targetField.id] ? editableValues(existingDraft[targetField.id]) : {}), style: sanitizedStyle } },
                }],
                requiresApproval: true,
                approvalReasons: [`Removes/hides "${targetField.label}" on ${currentPage.title}.`],
              });
            }
          }
        }
      }

      // 2. Duplicate Block / Section
      if (/\b(?:duplicate|clone|copy)\b/i.test(lower) && /\b(?:section|block|card|element|this|item|row)\b/i.test(lower)) {
        const targetField = findMatchingFieldOnPage(
          fields,
          options?.selectedFieldId,
          lower,
          (f) => Boolean(controls[f.id]?.duplicate)
        );
        if (targetField && controls[targetField.id]?.duplicate) {
          return enrichPlanWithApprovalMetadata({
            explanation: `Duplicate "${targetField.label}" on ${currentPage.title}.`,
            actionKind: "structure",
            summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
            pages: [],
            structuralActions: [{
              pageId: currentPage.id,
              pageTitle: currentPage.title,
              kind: "duplicate",
              fieldId: targetField.id,
              label: targetField.label,
            }],
            requiresApproval: false,
          });
        }
      }

      // 3. Move Block Up / Down
      if (/\b(?:move|reorder)\b.*\b(?:up|down|above|below|before|after)\b/i.test(lower)) {
        const moveUp = /\b(?:up|above|before)\b/i.test(lower);
        const targetField = findMatchingFieldOnPage(
          fields,
          options?.selectedFieldId,
          lower,
          (f) => Boolean(moveUp ? controls[f.id]?.previousId : controls[f.id]?.nextId)
        );
        if (targetField) {
          const ctrl = controls[targetField.id];
          const siblingId = moveUp ? ctrl?.previousId : ctrl?.nextId;
          if (siblingId) {
            return enrichPlanWithApprovalMetadata({
              explanation: `Move "${targetField.label}" ${moveUp ? "up" : "down"} on ${currentPage.title}.`,
              actionKind: "structure",
              summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
              pages: [],
              structuralActions: [{
                pageId: currentPage.id,
                pageTitle: currentPage.title,
                kind: moveUp ? "before" : "after",
                fieldId: targetField.id,
                targetId: siblingId,
                label: targetField.label,
              }],
              requiresApproval: false,
            });
          }
        }
      }

      // 4. Direct Text Replacement on Current Page / Site ("replace 'X' with 'Y'" or "change heading to 'Y'")
      const quotedReplace = trimmed.match(/(?:replace|change)\s+['"]([^'"]+)['"]\s+(?:with|to)\s+['"]([^'"]*)['"]/i);
      if (quotedReplace && quotedReplace[1]) {
        return planCrossPageContentChange(site, pages, {
          findText: quotedReplace[1],
          replaceText: quotedReplace[2] ?? "",
          kind: "text",
        });
      }

      const setHeadingOrTextMatch = trimmed.match(/(?:change|set|update|make|rewrite)\s+(?:the\s+)?(heading|title|headline|button|text|subtitle|paragraph|selected element)\s+(?:text\s+)?to\s+['"]?([^'"]+)['"]?$/i);
      if (setHeadingOrTextMatch) {
        const targetKindWord = setHeadingOrTextMatch[1]!.toLowerCase();
        const newText = setHeadingOrTextMatch[2]!.trim();
        const targetField = findMatchingFieldOnPage(
          fields,
          options?.selectedFieldId,
          targetKindWord,
          (f) => f.kind !== "image" && f.kind !== "container"
        );
        if (targetField && newText) {
          const nextEdit: AgentFieldEdit = {
            ...(existingDraft[targetField.id] ? editableValues(existingDraft[targetField.id]) : {}),
            value: newText,
          };
          return enrichPlanWithApprovalMetadata({
            explanation: `Updated "${targetField.label}" text to "${newText}" on ${currentPage.title}.`,
            actionKind: "instruction",
            summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
            pages: [{
              pageId: currentPage.id,
              pageTitle: currentPage.title,
              pagePath: currentPage.path,
              draftRevision: currentPage.draftRevision,
              changes: [{ fieldId: targetField.id, label: targetField.label, property: "value", before: targetField.value, after: newText }],
              edits: { [targetField.id]: nextEdit },
            }],
          });
        }
      }

      // 5. Direct Style Modifications on Selected or Matched Element (font-size, background-color, color, text-align, border-radius, padding)
      const styleTarget = findMatchingFieldOnPage(fields, options?.selectedFieldId, lower);
      if (styleTarget) {
        const currentDecls = parseCssDeclarations(styleTarget.style);
        const nextDecls = { ...currentDecls };
        let styleChangedProp: string | null = null;
        let styleChangedVal: string | null = null;

        const bgMatch = trimmed.match(/(?:change|set|make)\s+(?:the\s+)?background(?:\s+color)?\s+(?:to\s+)?(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/i);
        const textColMatch = trimmed.match(/(?:change|set|make)\s+(?:the\s+)?(?:text\s+)?color\s+(?:to\s+)?(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/i);
        const fontSizeMatch = trimmed.match(/(?:change|set|make)\s+(?:the\s+)?font\s*size\s+(?:to\s+)?(\d+(?:px|rem|em|%))/i);
        const alignMatch = trimmed.match(/(?:align|center|left|right)\s+(?:the\s+)?(?:text|heading|element)?\s*(center|left|right)/i) || (/\bcenter\s+(?:this|the\s+heading|the\s+title|the\s+text)\b/i.test(lower) ? ["", "center"] : null);
        const radiusMatch = trimmed.match(/(?:change|set|make)\s+(?:the\s+)?(?:border\s*)?radius\s+(?:to\s+)?(\d+(?:px|rem|%))/i);
        const paddingMatch = trimmed.match(/(?:change|set|make)\s+(?:the\s+)?padding\s+(?:to\s+)?(\d+(?:px|rem))/i);

        if (bgMatch && bgMatch[1]) {
          styleChangedProp = "background-color";
          styleChangedVal = bgMatch[1].trim();
          nextDecls["background-color"] = styleChangedVal;
        } else if (textColMatch && textColMatch[1]) {
          styleChangedProp = "color";
          styleChangedVal = textColMatch[1].trim();
          nextDecls["color"] = styleChangedVal;
        } else if (fontSizeMatch && fontSizeMatch[1]) {
          styleChangedProp = "font-size";
          styleChangedVal = fontSizeMatch[1].trim();
          nextDecls["font-size"] = styleChangedVal;
        } else if (alignMatch && alignMatch[1]) {
          styleChangedProp = "text-align";
          styleChangedVal = alignMatch[1].trim().toLowerCase();
          nextDecls["text-align"] = styleChangedVal;
        } else if (radiusMatch && radiusMatch[1]) {
          styleChangedProp = "border-radius";
          styleChangedVal = radiusMatch[1].trim();
          nextDecls["border-radius"] = styleChangedVal;
        } else if (paddingMatch && paddingMatch[1]) {
          styleChangedProp = "padding";
          styleChangedVal = paddingMatch[1].trim();
          nextDecls["padding"] = styleChangedVal;
        }

        if (styleChangedProp && styleChangedVal) {
          const serialized = serializeCssDeclarations(nextDecls);
          const sanitizedStyle = safeStyle(serialized, styleTarget.style);
          if (sanitizedStyle) {
            return enrichPlanWithApprovalMetadata({
              explanation: `Set ${styleChangedProp} to "${styleChangedVal}" on "${styleTarget.label}" (${currentPage.title}).`,
              actionKind: "instruction",
              summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
              pages: [{
                pageId: currentPage.id,
                pageTitle: currentPage.title,
                pagePath: currentPage.path,
                draftRevision: currentPage.draftRevision,
                changes: [{
                  fieldId: styleTarget.id,
                  label: styleTarget.label,
                  property: styleChangedProp,
                  before: currentDecls[styleChangedProp] || "Default",
                  after: styleChangedVal,
                }],
                edits: {
                  [styleTarget.id]: {
                    ...(existingDraft[styleTarget.id] ? editableValues(existingDraft[styleTarget.id]) : {}),
                    style: sanitizedStyle,
                  },
                },
              }],
              requiresApproval: false,
            });
          }
        }
      }
    } catch {
      // Fall through to AI model planner
    }
  }

  // --------------------------------------------------------------------------
  // E. AI Model Call for Arbitrary Complex Single-Page or Multi-Page Requests
  // --------------------------------------------------------------------------
  forgetBudgets();
  const budget = await check(scopesForAgent(currentRun()?.agentKey));
  if (budget.action === "pause" || budget.action === "approve") {
    const state = budget.states.find(item => item.action === budget.action)!;
    throw new BudgetExceeded(state, budget.note ?? "The AI spending limit needs reviewing in Costs before new builder suggestions can run.");
  }

  const overview = await scanSiteOverview(site, pages);

  // Include active page fields so the AI model can target any element on the open canvas
  let currentPageFieldsSummary: Array<{ id: string; label: string; kind: string; tag: string; value: string; href?: string; style?: string; canRemove?: boolean; canDuplicate?: boolean }> = [];
  if (currentPage) {
    try {
      const source = await pageSource(site, currentPage);
      const existingDraft = {
        ...((currentPage.draft ?? {}) as Record<string, FieldValue>),
        ...(options?.edits ?? {}),
      };
      const html = editingSource(source.html, existingDraft);
      const { fields } = discoverFields(html);
      const controls = structureControls(html);
      currentPageFieldsSummary = fields.slice(0, 80).map(f => ({
        id: f.id,
        label: f.label,
        kind: f.kind,
        tag: f.tag,
        value: (f.value ?? "").slice(0, 140),
        ...(f.href !== undefined ? { href: f.href } : {}),
        ...(f.style ? { style: f.style } : {}),
        ...(controls[f.id]?.remove ? { canRemove: true } : {}),
        ...(controls[f.id]?.duplicate ? { canDuplicate: true } : {}),
      }));
    } catch {
      // Ignore if unreadable
    }
  }

  const contextData = {
    siteName: site.name,
    publicUrl: site.publicUrl,
    brandVoice: options?.brandVoice?.slice(0, 1_500) ?? "",
    currentPageId: currentPage?.id ?? null,
    currentPageTitle: currentPage?.title ?? null,
    selectedFieldId: options?.selectedFieldId ?? null,
    recentConversation: history.slice(-6),
    attachments: attachments.map(a => ({ filename: a.filename, url: a.url, kind: a.kind, contentType: a.contentType })),
    currentPageFields: currentPageFieldsSummary,
    detectedFonts: overview.fonts.slice(0, 5),
    detectedColors: overview.colors.slice(0, 10),
    detectedPhones: overview.phoneNumbers.slice(0, 3),
    detectedEmails: overview.emails.slice(0, 3),
    pages: livePages.map(p => ({ id: p.id, title: p.title, path: p.path })),
  };

  try {
    const result = await callModel<z.infer<typeof aiPlanSchema>>({
      purpose: "website.assistant",
      job: "html",
      system: await writerSystem("website.editor", AI_AGENT_SYSTEM_DOCTRINE, {
        contract: "Return only the JSON plan conforming strictly to the requested schema. Never output markdown fences or commentary.",
      }),
      prompt: () => `User request:\n${trimmed}\n\nWorkspace context:\n${JSON.stringify(contextData)}`,
      schema: zodToJsonSchema(aiPlanSchema, { target: "openAi" }) as Record<string, unknown>,
      effort: budget.action === "downgrade" ? "low" : "medium",
      maxTokens: 4_000,
      messages: {
        noKey: "Connect an AI model in Settings to use open-ended conversational requests. Direct builder commands (fonts, colors, phones, emails, background images, file links, delete/duplicate blocks, and undo/redo) work automatically.",
      },
    });

    const aiData = result.data;

    if (aiData.editorCommand) {
      return enrichPlanWithApprovalMetadata({
        explanation: aiData.explanation || `Executed ${aiData.editorCommand}.`,
        actionKind: "command",
        editorCommand: aiData.editorCommand,
        summary: { totalPages: livePages.length, affectedPages: 1, totalChanges: 1 },
        pages: [],
        costUsd: result.costUsd,
        model: result.model,
      });
    }

    if (aiData.parsedOperation?.to) {
      if (aiData.intent === "font") {
        return {
          ...(await planGlobalFontChange(site, pages, { fromFont: aiData.parsedOperation.from, toFont: aiData.parsedOperation.to })),
          costUsd: result.costUsd,
          model: result.model,
        };
      }
      if (aiData.intent === "color") {
        return {
          ...(await planGlobalColorChange(site, pages, { fromColor: aiData.parsedOperation.from, toColor: aiData.parsedOperation.to })),
          costUsd: result.costUsd,
          model: result.model,
        };
      }
      if (aiData.intent === "phone") {
        const fromP = aiData.parsedOperation.from || overview.phoneNumbers[0]?.number || "";
        return {
          ...(await planCrossPageContentChange(site, pages, { findText: fromP, replaceText: aiData.parsedOperation.to, kind: "phone" })),
          costUsd: result.costUsd,
          model: result.model,
        };
      }
      if (aiData.intent === "email") {
        const fromE = aiData.parsedOperation.from || overview.emails[0]?.email || "";
        return {
          ...(await planCrossPageContentChange(site, pages, { findText: fromE, replaceText: aiData.parsedOperation.to, kind: "email" })),
          costUsd: result.costUsd,
          model: result.model,
        };
      }
      if (aiData.intent === "content" && aiData.parsedOperation.from) {
        return {
          ...(await planCrossPageContentChange(site, pages, { findText: aiData.parsedOperation.from, replaceText: aiData.parsedOperation.to, kind: "text" })),
          costUsd: result.costUsd,
          model: result.model,
        };
      }
    }

    // Process AI page-level changes & structural actions
    const pageMap = new Map(pages.map(p => [p.id, p]));
    const builtPagePlans: SiteAgentPagePlan[] = [];
    let totalChanges = 0;

    for (const aiPage of aiData.pages ?? []) {
      const page = pageMap.get(aiPage.pageId) ?? currentPage;
      if (!page) continue;
      try {
        const source = await pageSource(site, page);
        const existingDraft = {
          ...((page.draft ?? {}) as Record<string, FieldValue>),
          ...(page.id === currentPage?.id ? (options?.edits ?? {}) : {}),
        };
        const html = editingSource(source.html, existingDraft);
        const { fields } = discoverFields(html);
        const byId = new Map(fields.map(f => [f.id, f]));

        const pageChanges: SiteAgentPagePlan["changes"] = [];
        const pageEdits: Record<string, AgentFieldEdit> = {};

        for (const ch of aiPage.changes) {
          const field = byId.get(ch.fieldId);
          if (!field) continue;
          const prevEdit = pageEdits[field.id] ?? (existingDraft[field.id] ? editableValues(existingDraft[field.id]) : {});
          const nextEdit: AgentFieldEdit = { ...prevEdit };

          if (ch.operation === "replace_text") {
            nextEdit.value = ch.value;
            pageChanges.push({ fieldId: field.id, label: field.label, property: "value", before: field.value, after: ch.value });
          } else if (ch.operation === "set_link") {
            nextEdit.href = ch.value;
            pageChanges.push({ fieldId: field.id, label: field.label, property: "href", before: field.href ?? "", after: ch.value });
          } else if (ch.operation === "set_alt") {
            nextEdit.alt = ch.value;
            pageChanges.push({ fieldId: field.id, label: field.label, property: "alt", before: field.alt ?? "", after: ch.value });
          } else if (ch.operation === "set_variant") {
            nextEdit.variant = ch.value || null;
            pageChanges.push({ fieldId: field.id, label: field.label, property: "variant", before: field.variant ?? "None", after: ch.value || "None" });
          } else if (ch.operation === "set_new_tab") {
            nextEdit.newTab = ch.value === "true";
            pageChanges.push({ fieldId: field.id, label: field.label, property: "newTab", before: String(Boolean(field.newTab)), after: String(nextEdit.newTab) });
          } else if (ch.operation === "set_style" && ch.property) {
            const decls = parseCssDeclarations(nextEdit.style ?? field.style);
            const beforeVal = decls[ch.property.toLowerCase()] ?? "Default";
            decls[ch.property.toLowerCase()] = ch.value;
            const sanitized = safeStyle(serializeCssDeclarations(decls), field.style);
            if (sanitized) {
              nextEdit.style = sanitized;
              pageChanges.push({ fieldId: field.id, label: field.label, property: ch.property, before: beforeVal, after: ch.value });
            }
          }

          pageEdits[field.id] = nextEdit;
        }

        if (pageChanges.length > 0) {
          totalChanges += pageChanges.length;
          builtPagePlans.push({
            pageId: page.id,
            pageTitle: page.title,
            pagePath: page.path,
            draftRevision: page.draftRevision,
            changes: pageChanges,
            edits: pageEdits,
          });
        }
      } catch {
        // Ignore unreadable page
      }
    }

    const builtStructuralActions: SiteAgentStructuralAction[] = (aiData.structuralActions ?? []).map(sa => {
      const p = pageMap.get(sa.pageId) ?? currentPage;
      return {
        pageId: p?.id ?? sa.pageId,
        pageTitle: p?.title ?? "Page",
        kind: sa.kind,
        fieldId: sa.fieldId,
        ...(sa.targetId ? { targetId: sa.targetId } : {}),
        label: sa.label,
      };
    });

    totalChanges += builtStructuralActions.length;

    return enrichPlanWithApprovalMetadata({
      explanation: aiData.explanation || "Prepared change plan for your website.",
      actionKind: builtStructuralActions.length > 0 ? "structure" : "instruction",
      summary: {
        totalPages: livePages.length,
        affectedPages: Math.max(builtPagePlans.length, builtStructuralActions.length > 0 ? 1 : 0),
        totalChanges,
      },
      pages: builtPagePlans,
      ...(builtStructuralActions.length > 0 ? { structuralActions: builtStructuralActions } : {}),
      costUsd: result.costUsd,
      model: result.model,
    });
  } finally {
    forgetBudgets();
  }
}

// ============================================================================
// Applying the Site Agent Plan Safely to Page Drafts
// ============================================================================

export async function applyAgentSitePlan(
  site: Site,
  pages: SitePage[],
  input: SiteAgentApplyInput,
  userId?: string | null
): Promise<{
  appliedPages: number;
  totalChanges: number;
  results: Array<{ pageId: string; pageTitle: string; success: boolean; message: string; newRevision?: number }>;
}> {
  const pageMap = new Map(pages.map(p => [p.id, p]));
  const results: Array<{ pageId: string; pageTitle: string; success: boolean; message: string; newRevision?: number }> = [];
  let appliedPages = 0;
  let totalChanges = 0;

  for (const pagePlan of input.plan.pages) {
    const page = pageMap.get(pagePlan.pageId);
    if (!page) {
      results.push({ pageId: pagePlan.pageId, pageTitle: pagePlan.pageTitle, success: false, message: "Page no longer exists." });
      continue;
    }

    const ifRevision = input.pageRevisions[page.id] ?? pagePlan.draftRevision;
    try {
      const source = await pageSource(site, page);
      const existingDraft = (page.draft ?? {}) as Record<string, FieldValue>;
      const baseHtml = editingSource(source.html, existingDraft);
      const { fields } = discoverFields(baseHtml);
      const byId = new Map(fields.map(f => [f.id, f]));

      const nextDraftValues: Record<string, FieldValue> = { ...existingDraft };
      let pageChangeCount = 0;

      for (const [fieldId, edit] of Object.entries(pagePlan.edits)) {
        const field = byId.get(fieldId);
        if (!field) continue;

        const sanitized = sanitizeValue(field, { ...existingDraft[fieldId], ...edit });
        if (Object.keys(sanitized).length > 0) {
          nextDraftValues[fieldId] = sanitized;
          pageChangeCount += 1;
        }
      }

      if (pageChangeCount === 0) {
        results.push({ pageId: page.id, pageTitle: page.title, success: true, message: "No draft changes needed for this page." });
        continue;
      }

      const written = await prisma.sitePage.updateMany({
        where: { id: page.id, draftRevision: ifRevision },
        data: {
          draft: nextDraftValues as unknown as Prisma.InputJsonValue,
          draftSavedAt: new Date(),
          draftSavedById: userId ?? null,
          draftRevision: { increment: 1 },
        },
      });

      if (written.count === 0) {
        results.push({
          pageId: page.id,
          pageTitle: page.title,
          success: false,
          message: "Conflict: This page was modified in another session. Please reload and review.",
        });
      } else {
        appliedPages += 1;
        totalChanges += pageChangeCount;
        results.push({
          pageId: page.id,
          pageTitle: page.title,
          success: true,
          message: `Saved ${pageChangeCount} change${pageChangeCount === 1 ? "" : "s"} to draft.`,
          newRevision: ifRevision + 1,
        });
      }
    } catch (err) {
      results.push({
        pageId: page.id,
        pageTitle: page.title,
        success: false,
        message: err instanceof Error ? err.message : "Failed to apply changes.",
      });
    }
  }

  return {
    appliedPages,
    totalChanges,
    results,
  };
}

function editableValues(value: FieldValue): AgentFieldEdit {
  const result: AgentFieldEdit = {};
  for (const key of ["value", "href", "alt", "style", "variant", "newTab", "responsive"] as const) {
    if (value[key] !== undefined) {
      Object.assign(result, { [key]: value[key] });
    }
  }
  return result;
}

// ============================================================================
// Safe File & Image Upload for Agent Attachments
// ============================================================================

const ALLOWED_DOC_EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  zip: "application/zip",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

const uploadAttachmentSchema = z
  .object({
    filename: z.string().min(1).max(200),
    data: z.string().max(14_000_000).optional(), // up to ~10 MB binary
    dataUrl: z.string().max(14_000_000).optional(),
    alt: z.string().max(500).optional().default(""),
  })
  .refine((val) => Boolean(val.data || val.dataUrl), {
    message: "Provide base64 file data or dataUrl.",
  });

const batchPublishAgentSchema = z.object({
  pageIds: z.array(z.string().max(120)).max(100).optional(),
  message: z.string().max(300).optional(),
});

const escalateDeveloperSchema = z.object({
  prompt: z.string().min(2).max(2_000),
  pageId: z.string().max(120).optional(),
  reason: z.string().max(1_000).optional(),
});

// ============================================================================
// Router Registration
// ============================================================================

export function registerWebsiteBuilderAgent(
  router: Router,
  access: {
    loadSite: (req: Request, siteId: string) => Promise<Site>;
    loadPage: (req: Request, pageId: string) => Promise<{ page: SitePage; site: Site }>;
  }
) {
  // 1. Get site overview (detected fonts, colors, phone numbers)
  router.get("/sites/:siteId/agent/overview", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const pages = await prisma.sitePage.findMany({
        where: { siteId: site.id },
        orderBy: [{ sortOrder: "asc" }, { path: "asc" }],
      });
      const overview = await scanSiteOverview(site, pages);
      res.json(overview);
    } catch (err) {
      next(err);
    }
  });

  // 2. Upload an attachment (Image or Document/File) from the Agent Chat
  router.post("/sites/:siteId/agent/upload", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const input = uploadAttachmentSchema.parse(req.body);
      const rawBase64 = (input.data || input.dataUrl || "")
        .replace(/^data:[^;]+;base64,/i, "")
        .replace(/\s+/g, "");
      if (!rawBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(rawBase64)) {
        throw new WebsiteError(400, "The uploaded file data is not valid base64.");
      }
      const content = Buffer.from(rawBase64, "base64");
      if (!content.length || content.length > 10_000_000) {
        throw new WebsiteError(400, "Choose a file smaller than 10 MB.");
      }
      await assertMediaStorageAllowance(req, content.length, site.id);

      const sniffedMime = sniff(content);
      const imageFormats: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
      };

      if (sniffedMime && imageFormats[sniffedMime]) {
        const optimized = await optimizeImageBuffer(content);
        await assertMediaStorageAllowance(req, optimized.content.length, site.id);
        const repoPath = `assets/dw/${randomUUID()}.${optimized.extension}`;
        const uploaded = await prisma.siteAsset.create({
          data: {
            siteId: site.id,
            filename: input.filename,
            repoPath,
            contentType: optimized.contentType,
            content: optimized.content,
            size: optimized.content.length,
            alt: input.alt || input.filename.replace(/\.[^.]+$/, ""),
          },
        });
        res.status(201).json({
          id: uploaded.id,
          filename: uploaded.filename,
          url: assetUrl(site, uploaded.repoPath),
          previewUrl: `/api/website/sites/${site.id}/assets/${uploaded.id}/content`,
          contentType: uploaded.contentType,
          kind: "image",
          size: uploaded.size,
          alt: uploaded.alt,
        });
        return;
      }

      // Check allowed document/file extensions
      const extMatch = /\.([a-zA-Z0-9]{1,8})$/.exec(input.filename);
      const ext = extMatch ? extMatch[1]!.toLowerCase() : "";
      const docContentType = ALLOWED_DOC_EXTENSIONS[ext];
      if (!docContentType) {
        throw new WebsiteError(
          400,
          "Supported attachments: PNG, JPEG, WebP, GIF images, or PDF, DOCX, XLSX, PPTX, CSV, TXT, ZIP, MP4, MP3 files."
        );
      }

      const safeBase = input.filename
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "file";
      const repoPath = `assets/dw/${randomUUID()}-${safeBase}.${ext}`;

      const uploaded = await prisma.siteAsset.create({
        data: {
          siteId: site.id,
          filename: input.filename,
          repoPath,
          contentType: docContentType,
          content,
          size: content.length,
          alt: input.alt || input.filename,
        },
      });

      res.status(201).json({
        id: uploaded.id,
        filename: uploaded.filename,
        url: assetUrl(site, uploaded.repoPath),
        previewUrl: `/api/website/sites/${site.id}/assets/${uploaded.id}/content`,
        contentType: uploaded.contentType,
        kind: "file",
        size: uploaded.size,
        alt: uploaded.alt,
      });
    } catch (err) {
      next(err);
    }
  });

  // 3. Generate a site-wide or single-page plan from user command or instruction
  router.post("/sites/:siteId/agent/plan", async (req: Request, res: Response, next) => {
    try {
      const body = siteAgentCommandSchema.parse(req.body);
      const site = await access.loadSite(req, req.params.siteId);
      const pages = await prisma.sitePage.findMany({
        where: { siteId: site.id },
        orderBy: [{ sortOrder: "asc" }, { path: "asc" }],
      });

      let plan: SiteAgentPlan;
      switch (body.action) {
        case "replace_font":
          plan = await planGlobalFontChange(site, pages, {
            fromFont: body.fromFont,
            toFont: body.toFont,
            targetKinds: body.targetKinds,
          });
          break;
        case "replace_color":
          plan = await planGlobalColorChange(site, pages, {
            fromColor: body.fromColor,
            toColor: body.toColor,
            properties: body.properties,
          });
          break;
        case "replace_content":
          plan = await planCrossPageContentChange(site, pages, {
            findText: body.findText,
            replaceText: body.replaceText,
            kind: body.kind,
          });
          break;
        default:
        case "instruction":
          plan = await planAgentInstruction(site, pages, body.prompt, {
            pageId: body.pageId,
            selectedFieldId: body.selectedFieldId,
            edits: body.edits,
            attachments: body.attachments,
            history: body.history,
          });
          break;
      }

      res.json(plan);
    } catch (err) {
      next(err);
    }
  });

  // 4. Apply the approved plan to page drafts
  router.post("/sites/:siteId/agent/apply", async (req: Request, res: Response, next) => {
    try {
      const body = siteAgentApplyInputSchema.parse(req.body);
      const site = await access.loadSite(req, req.params.siteId);
      const pages = await prisma.sitePage.findMany({
        where: { siteId: site.id },
      });

      const outcome = await applyAgentSitePlan(site, pages, body, req.dbUser?.id);
      res.json(outcome);
    } catch (err) {
      next(err);
    }
  });

  // 5. Atomic 1-Click Batch Publish of Agent-Edited Pages
  router.post("/sites/:siteId/agent/publish-batch", async (req: Request, res: Response, next) => {
    try {
      const body = batchPublishAgentSchema.parse(req.body ?? {});
      const site = await access.loadSite(req, req.params.siteId);
      await assertWebsiteSiteAccess(req, site.id, "publish");
      const pages = await prisma.sitePage.findMany({
        where: { siteId: site.id },
        orderBy: [{ sortOrder: "asc" }, { path: "asc" }],
      });

      const requestedIds = body.pageIds?.length ? new Set(body.pageIds) : null;
      if (requestedIds && requestedIds.size !== body.pageIds?.length) throw new WebsiteError(400, "Choose each page only once.");
      if (requestedIds && [...requestedIds].some(id => !pages.some(page => page.id === id))) throw new WebsiteError(404, "One selected page is not on this website.");
      const candidates = pages.filter((p) => {
        if (p.status === "HIDDEN") return false;
        if (requestedIds && !requestedIds.has(p.id)) return false;
        const draft = (p.draft ?? {}) as Record<string, FieldValue>;
        return Object.keys(draft).length > 0;
      });

      if (!candidates.length) {
        throw new WebsiteError(400, "All selected pages are already published with no pending draft changes.");
      }

      const result = await withWebsitePublishLocks(candidates.map(page => page.id), async tx => {
        const pagesToCommit: Array<{ page: SitePage; html: string; expectedSource: string; values: Record<string, FieldValue> }> = [];
        for (const selected of candidates) {
          const page = await tx.sitePage.findUniqueOrThrow({ where: { id: selected.id } });
          const values = (page.draft ?? {}) as Record<string, FieldValue>;
          if (!Object.keys(values).length) throw new WebsiteError(409, `${page.title} changed while publishing. Review its draft again.`);
          const source = await pageSource(site, page, { fresh: true });
          if (source.sourceFile) throw new WebsiteError(409, `${page.title} uses framework source. Publish it through the page review, which preserves its components.`);
          const plan = buildPublishPlan({ source: source.html, values });
          if (!plan.publishable || !plan.html) throw Object.assign(new WebsiteError(409, `${page.title} cannot be published. Review its draft again.`), { problems: plan.problems, conflicts: plan.conflicts, missing: plan.missing });
          pagesToCommit.push({ page, html: plan.html, expectedSource: source.html, values });
        }

        const author = req.dbUser?.name ?? req.dbUser?.email ?? "Website Agent";
        const commit = await publishPages({
          site,
          message: body.message?.trim() || `Website Agent: published ${pagesToCommit.length} page${pagesToCommit.length === 1 ? "" : "s"} (${author})`,
          pages: pagesToCommit,
        });
        const publishedAt = new Date();
        for (const { page, html, values } of pagesToCommit) {
          const last = await tx.sitePageVersion.findFirst({ where: { pageId: page.id }, orderBy: { number: "desc" }, select: { number: true } });
          await tx.sitePageVersion.create({ data: {
            pageId: page.id, number: (last?.number ?? 0) + 1, html,
            values: versionValues(values) as unknown as Prisma.InputJsonValue,
            commitSha: commit.sha, commitUrl: commit.url, publishedById: req.dbUser?.id ?? null,
          } });
          await tx.sitePage.update({ where: { id: page.id }, data: {
            publishedHtml: html, sourceHtml: page.sourceHtml === null ? undefined : html,
            lastPublishedAt: publishedAt, status: "LIVE",
          } });
          // Preserve a draft saved while the network commit was in flight.
          await tx.sitePage.updateMany({ where: { id: page.id, draftRevision: page.draftRevision }, data: {
            draft: Prisma.DbNull, draftSavedAt: null, draftSavedById: null, draftRevision: { increment: 1 },
          } });
        }
        await ensureHostedAddress(site.id);
        await tx.siteAuditEvent.create({ data: {
          siteId: site.id, kind: "PUBLISH",
          summary: `Agent published ${pagesToCommit.length} page${pagesToCommit.length === 1 ? "" : "s"} in one commit`,
          actorName: author, actorId: req.dbUser?.id,
          detail: { sha: commit.sha, url: commit.url, pages: pagesToCommit.map(({ page }) => ({ id: page.id, title: page.title, path: page.path })) },
        } });
        return { publishedPages: pagesToCommit.length, commitSha: commit.sha, commitUrl: commit.url, pages: pagesToCommit.map(({ page }) => ({ id: page.id, title: page.title, path: page.path })) };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // 6. Escalate a code-managed or structural request to a Dakyworld developer
  router.post("/sites/:siteId/agent/escalate", async (req: Request, res: Response, next) => {
    try {
      const body = escalateDeveloperSchema.parse(req.body ?? {});
      const site = await access.loadSite(req, req.params.siteId);
      const author = req.dbUser?.name ?? req.dbUser?.email ?? "Website Owner";
      const event = await prisma.siteAuditEvent.create({
        data: {
          siteId: site.id,
          kind: "DEVELOPER_ESCALATION",
          summary: `Developer assistance requested: "${body.prompt.slice(0, 80)}"`,
          actorName: author,
          actorId: req.dbUser?.id,
          detail: {
            prompt: body.prompt,
            pageId: body.pageId ?? null,
            reason: body.reason ?? "User escalated from Website Builder Agent",
            status: "QUEUED_FOR_DEVELOPER",
          },
        },
      });
      res.status(201).json({
        ticketId: event.id,
        message: "Request sent to your Dakyworld developer team. We have full context of the page and element you were working on.",
      });
    } catch (err) {
      next(err);
    }
  });

  // 7. Register SEO & Repository Metadata routes (/sites/:siteId/seo, /seo/page, /seo/repo, /seo/auto-generate)
  registerWebsiteSeoRoutes(router, access);
}
