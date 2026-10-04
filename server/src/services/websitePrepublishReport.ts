/**
 * websitePrepublishReport.ts — Prepublish verification, editable counts, missing assets,
 * unsupported component limits, and publish risk reporting for imported sites.
 */

import type { Site, SitePage } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { parseHtml, walk, attr, textOf, type ElementNode } from "./website/parse.js";
import { discoverFields, type SiteField, type FieldValue } from "./website/index.js";
import { runPublishGuardChecks, type PublishGuardResult, type GuardIssue } from "./websitePublishGuard.js";
import { assetUrl } from "./websiteAssets.js";
import { pageSource } from "./website/site.js";

export type EditableCounts = {
  total: number;
  text: number;
  links: number;
  buttons: number;
  images: number;
  backgrounds: number;
  metadata: number;
  icons: number;
  unsupported: number;
};

export type MissingAssetItem = {
  url: string;
  tag: string;
  attribute: string;
  resolvedPath: string;
  reason: string;
};

export type UnsupportedElementItem = {
  id: string;
  tag: string;
  label: string;
  reason: string;
  previewReadOnly: boolean;
};

export type ScriptDrivenItem = {
  tag: string;
  type: "script_tag" | "event_handler" | "custom_element";
  detail: string;
  safetyNote: string;
};

export type PublishRisk = {
  id: string;
  severity: "blocker" | "warning" | "info";
  category: string;
  title: string;
  description: string;
  acknowledged?: boolean;
};

export type PagePrepublishReport = {
  pageId: string;
  pagePath: string;
  title: string;
  filePath: string;
  editableCounts: EditableCounts;
  missingAssets: MissingAssetItem[];
  unsupportedElements: UnsupportedElementItem[];
  scriptDrivenElements: ScriptDrivenItem[];
  publishRisks: PublishRisk[];
  guardResult: PublishGuardResult;
  canPublish: boolean;
  requiresAcknowledgment: boolean;
  recoverySnapshotAvailable: boolean;
  latestVersionNumber: number;
};

export type SitePrepublishReport = {
  siteId: string;
  siteName: string;
  pages: PagePrepublishReport[];
  totalEditableFields: number;
  totalMissingAssets: number;
  totalUnsupportedElements: number;
  totalScriptDrivenElements: number;
  blockersCount: number;
  warningsCount: number;
  canPublish: boolean;
  acknowledgedLimits: string[];
};

/**
 * Counts editable fields by category.
 */
export function countEditableFields(fields: SiteField[]): EditableCounts {
  const counts: EditableCounts = {
    total: 0,
    text: 0,
    links: 0,
    buttons: 0,
    images: 0,
    backgrounds: 0,
    metadata: 0,
    icons: 0,
    unsupported: 0,
  };

  for (const field of fields) {
    if (field.tag === "title" || field.tag === "meta") {
      counts.metadata += 1;
      counts.total += 1;
    } else if (field.kind === "text" || field.kind === "richtext") {
      counts.text += 1;
      counts.total += 1;
    } else if (field.kind === "link") {
      counts.links += 1;
      counts.total += 1;
    } else if (field.kind === "button") {
      counts.buttons += 1;
      counts.total += 1;
    } else if (field.kind === "image") {
      counts.images += 1;
      counts.total += 1;
    } else if (field.kind === "background") {
      counts.backgrounds += 1;
      counts.total += 1;
    } else if (field.kind === "icon") {
      counts.icons += 1;
      counts.total += 1;
    } else if (field.kind === "unsupported") {
      counts.unsupported += 1;
    }
  }

  return counts;
}

/**
 * Finds missing local asset references in HTML against known site assets.
 */
export function detectMissingAssets(
  html: string,
  knownAssetPaths: Set<string>,
  site: Pick<Site, "publicUrl">,
): MissingAssetItem[] {
  const root = parseHtml(html);
  const missing: MissingAssetItem[] = [];

  for (const node of walk(root)) {
    // Check images
    if (node.tag === "img" || node.tag === "source") {
      const src = attr(node, "src");
      if (src && !isExternalOrData(src)) {
        const clean = cleanAssetPath(src, site);
        if (!knownAssetPaths.has(clean)) {
          missing.push({
            url: src,
            tag: node.tag,
            attribute: "src",
            resolvedPath: clean,
            reason: `Local image asset '${src}' was not found in site assets.`,
          });
        }
      }
      const srcset = attr(node, "srcset");
      if (srcset) {
        const candidates = srcset.split(",").map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
        for (const cand of candidates) {
          if (!isExternalOrData(cand)) {
            const clean = cleanAssetPath(cand, site);
            if (!knownAssetPaths.has(clean)) {
              missing.push({
                url: cand,
                tag: `${node.tag} srcset`,
                attribute: "srcset",
                resolvedPath: clean,
                reason: `Responsive image candidate '${cand}' was not found in site assets.`,
              });
            }
          }
        }
      }
    }

    // Check stylesheets
    if (node.tag === "link") {
      const rel = attr(node, "rel")?.toLowerCase() || "";
      const href = attr(node, "href");
      if (rel.includes("stylesheet") && href && !isExternalOrData(href)) {
        const clean = cleanAssetPath(href, site);
        if (!knownAssetPaths.has(clean)) {
          missing.push({
            url: href,
            tag: "link",
            attribute: "href",
            resolvedPath: clean,
            reason: `Linked stylesheet '${href}' was not found in site assets.`,
          });
        }
      }
    }

    // Check background images in styles
    const style = attr(node, "style");
    if (style && /background(?:-image)?\s*:[^;}"']*url\(/i.test(style)) {
      const matches = style.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi);
      for (const m of matches) {
        const url = m[1]?.trim();
        if (url && !isExternalOrData(url)) {
          const clean = cleanAssetPath(url, site);
          if (!knownAssetPaths.has(clean)) {
            missing.push({
              url,
              tag: node.tag,
              attribute: "style",
              resolvedPath: clean,
              reason: `Inline CSS background image '${url}' was not found in site assets.`,
            });
          }
        }
      }
    }
  }

  return missing;
}

function isExternalOrData(url: string): boolean {
  return /^(?:https?:|\/\/|data:|mailto:|tel:|#|javascript:)/i.test(url.trim());
}

function cleanAssetPath(rawUrl: string, site: Pick<Site, "publicUrl">): string {
  let cleaned = rawUrl.split(/[?#]/)[0].trim().replace(/^\/+/, "");
  const publicPath = new URL(site.publicUrl || "https://example.com").pathname.replace(/^\/+|\/+$/g, "");
  if (publicPath && cleaned.startsWith(publicPath)) {
    cleaned = cleaned.slice(publicPath.length).replace(/^\/+/, "");
  }
  return cleaned;
}

/**
 * Discovers script-driven parts and evaluates their safety.
 */
export function detectScriptDrivenElements(html: string): ScriptDrivenItem[] {
  const root = parseHtml(html);
  const items: ScriptDrivenItem[] = [];

  for (const node of walk(root)) {
    if (node.tag === "script") {
      const src = attr(node, "src");
      items.push({
        tag: "script",
        type: "script_tag",
        detail: src ? `External script: ${src}` : "Inline executable script",
        safetyNote: "Scripts are executed when published but sandboxed in editor preview to prevent state corruption.",
      });
    }

    const eventAttrs = node.attrs.filter((a) => /^on[a-z]+/i.test(a.name));
    for (const ea of eventAttrs) {
      items.push({
        tag: node.tag,
        type: "event_handler",
        detail: `Inline event ${ea.name}="${ea.value.slice(0, 40)}"`,
        safetyNote: "Inline event handler: active on live site, neutralized during visual editing.",
      });
    }

    if (node.tag.includes("-") && !["svg", "math"].includes(node.tag)) {
      items.push({
        tag: node.tag,
        type: "custom_element",
        detail: `Custom Web Component: <${node.tag}>`,
        safetyNote: "Custom element: behavior depends on client-side script runtime.",
      });
    }
  }

  return items;
}

/**
 * Builds a comprehensive prepublish report for one page.
 */
export async function generatePagePrepublishReport(input: {
  site: Site;
  page: SitePage;
  candidateHtml?: string;
  draftValues?: Record<string, FieldValue>;
  acknowledgedLimits?: Set<string> | string[];
  knownAssetPaths?: Set<string>;
  latestVersionNumber?: number;
  recoverySnapshotAvailable?: boolean;
}): Promise<PagePrepublishReport> {
  const { site, page, candidateHtml, draftValues } = input;
  const acknowledgedLimits = new Set(
    input.acknowledgedLimits instanceof Set
      ? input.acknowledgedLimits
      : Array.isArray(input.acknowledgedLimits)
      ? input.acknowledgedLimits
      : []
  );
  const htmlToAnalyze = candidateHtml || page.sourceHtml || "";

  // 1. Discover all fields and count categories
  const discovery = discoverFields(htmlToAnalyze);
  const editableCounts = countEditableFields(discovery.fields);

  // 2. Load site assets
  let knownAssetPaths = input.knownAssetPaths;
  if (!knownAssetPaths) {
    try {
      const assets = await prisma.siteAsset.findMany({
        where: { siteId: site.id },
        select: { repoPath: true },
      });
      knownAssetPaths = new Set(assets.map((a) => a.repoPath));
    } catch {
      knownAssetPaths = new Set();
    }
  }

  // 3. Detect missing assets
  const missingAssets = detectMissingAssets(htmlToAnalyze, knownAssetPaths, site);

  // 4. Unsupported elements
  const unsupportedElements: UnsupportedElementItem[] = discovery.fields
    .filter((f) => f.kind === "unsupported")
    .map((f) => ({
      id: f.id,
      tag: f.tag,
      label: f.label,
      reason: f.unsupportedReason || "Component is read-only to preserve code stability",
      previewReadOnly: true,
    }));

  // 5. Script driven parts
  const scriptDrivenElements = detectScriptDrivenElements(htmlToAnalyze);

  // 6. Publish Guard checks
  const guardResult = runPublishGuardChecks({
    candidateHtml: htmlToAnalyze,
    sourceHtml: page.sourceHtml || htmlToAnalyze,
    draftValues,
    knownAssetPaths,
  });

  // 7. Aggregate publish risks
  const publishRisks: PublishRisk[] = [];

  // Guard blockers are hard blockers
  for (const b of guardResult.blockers) {
    publishRisks.push({
      id: b.id,
      severity: "blocker",
      category: b.category,
      title: b.title,
      description: b.description,
    });
  }

  // Guard warnings
  for (const w of guardResult.warnings) {
    publishRisks.push({
      id: w.id,
      severity: "warning",
      category: w.category,
      title: w.title,
      description: w.description,
      acknowledged: acknowledgedLimits.has(w.id),
    });
  }

  // Add missing assets as warnings
  for (const ma of missingAssets) {
    const riskId = `missing-asset:${ma.resolvedPath}`;
    publishRisks.push({
      id: riskId,
      severity: "warning",
      category: "safe_publish",
      title: `Missing asset: ${ma.resolvedPath}`,
      description: ma.reason,
      acknowledged: acknowledgedLimits.has(riskId),
    });
  }

  // Add script-driven parts as info/warnings
  if (scriptDrivenElements.length > 0) {
    const riskId = `script-driven:${page.id}`;
    publishRisks.push({
      id: riskId,
      severity: "info",
      category: "safe_publish",
      title: `${scriptDrivenElements.length} script-driven component${scriptDrivenElements.length === 1 ? "" : "s"} present`,
      description: "Custom scripts and event handlers operate on the live page but remain sandboxed during visual editing.",
      acknowledged: true,
    });
  }

  // Version recovery availability
  let versionsCount = input.latestVersionNumber;
  let hasRecovery = input.recoverySnapshotAvailable;
  if (versionsCount === undefined || hasRecovery === undefined) {
    try {
      const dbCount = await prisma.sitePageVersion.count({ where: { pageId: page.id } });
      versionsCount = dbCount > 0 ? dbCount : 1;
      hasRecovery = dbCount > 0;
    } catch {
      versionsCount = 1;
      hasRecovery = true;
    }
  }

  const unacknowledgedWarnings = publishRisks.filter((r) => r.severity === "warning" && !r.acknowledged);
  const hasBlockers = publishRisks.some((r) => r.severity === "blocker");
  const canPublish = !hasBlockers && unacknowledgedWarnings.length === 0;

  return {
    pageId: page.id,
    pagePath: page.path,
    title: page.title,
    filePath: page.filePath,
    editableCounts,
    missingAssets,
    unsupportedElements,
    scriptDrivenElements,
    publishRisks,
    guardResult,
    canPublish,
    requiresAcknowledgment: !hasBlockers && unacknowledgedWarnings.length > 0,
    recoverySnapshotAvailable: hasRecovery,
    latestVersionNumber: versionsCount,
  };
}

/**
 * Builds site-wide prepublish report.
 */
export async function generateSitePrepublishReport(
  siteId: string,
  acknowledgedLimits: string[] = [],
): Promise<SitePrepublishReport> {
  const site = await prisma.site.findUniqueOrThrow({
    where: { id: siteId },
  });

  const pages = await prisma.sitePage.findMany({
    where: { siteId },
    orderBy: { path: "asc" },
  });

  const ackSet = new Set(acknowledgedLimits);
  const pageReports: PagePrepublishReport[] = [];

  for (const page of pages) {
    const rep = await generatePagePrepublishReport({
      site,
      page,
      acknowledgedLimits: ackSet,
    });
    pageReports.push(rep);
  }

  const totalEditable = pageReports.reduce((sum, p) => sum + p.editableCounts.total, 0);
  const totalMissing = pageReports.reduce((sum, p) => sum + p.missingAssets.length, 0);
  const totalUnsupported = pageReports.reduce((sum, p) => sum + p.unsupportedElements.length, 0);
  const totalScriptDriven = pageReports.reduce((sum, p) => sum + p.scriptDrivenElements.length, 0);
  const blockersCount = pageReports.reduce((sum, p) => sum + p.publishRisks.filter((r) => r.severity === "blocker").length, 0);
  const warningsCount = pageReports.reduce((sum, p) => sum + p.publishRisks.filter((r) => r.severity === "warning").length, 0);
  const canPublish = pageReports.every((p) => p.canPublish);

  return {
    siteId: site.id,
    siteName: site.name,
    pages: pageReports,
    totalEditableFields: totalEditable,
    totalMissingAssets: totalMissing,
    totalUnsupportedElements: totalUnsupported,
    totalScriptDrivenElements: totalScriptDriven,
    blockersCount,
    warningsCount,
    canPublish,
    acknowledgedLimits,
  };
}
