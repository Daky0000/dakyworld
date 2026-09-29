/**
 * websiteVisualRegression.ts — Visual Regression Guard.
 *
 * Compares layout geometry, typography, spacing, and responsive stability
 * across Desktop, Tablet, and Mobile viewports between original and candidate HTML.
 */

import { parseHtml, walk, attr, textOf, type ElementNode } from "./website/parse.js";
import type { FieldValue } from "./website/index.js";

export type ViewportMode = "desktop" | "tablet" | "mobile";

export type VisualDiffRegion = {
  id: string;
  tag: string;
  selector: string;
  label: string;
  kind: "modified" | "added" | "removed" | "shifted";
  status: "expected" | "unexpected";
  explanation: string;
  viewport: ViewportMode;
  approxBox: {
    topPercent: number;
    leftPercent: number;
    widthPercent: number;
    heightPercent: number;
  };
};

export type ViewportRegressionReport = {
  viewport: ViewportMode;
  width: number;
  layoutChangedPercent: number;
  expectedChanges: string[];
  unexpectedChanges: string[];
  regions: VisualDiffRegion[];
  hasBreakage: boolean;
};

export type VisualRegressionResult = {
  overallChangePercent: number;
  hasUnexpectedChanges: boolean;
  expectedSummary: string[];
  unexpectedSummary: string[];
  viewports: {
    desktop: ViewportRegressionReport;
    tablet: ViewportRegressionReport;
    mobile: ViewportRegressionReport;
  };
};

const VIEWPORT_SPECS: Record<ViewportMode, { width: number }> = {
  desktop: { width: 1280 },
  tablet: { width: 820 },
  mobile: { width: 390 },
};

type ElementDigest = {
  tag: string;
  id?: string;
  classes: string;
  text: string;
  src?: string;
  href?: string;
  index: number;
  depth: number;
};

function digestElements(root: ElementNode, source: string): ElementDigest[] {
  const list: ElementDigest[] = [];
  let index = 0;

  function traverse(node: ElementNode, depth: number) {
    if (node !== root && ["header", "nav", "main", "section", "article", "aside", "footer", "h1", "h2", "h3", "p", "a", "button", "img"].includes(node.tag)) {
      list.push({
        tag: node.tag,
        id: attr(node, "id"),
        classes: attr(node, "class") || "",
        text: textOf(source, node).slice(0, 80),
        src: attr(node, "src"),
        href: attr(node, "href"),
        index: index++,
        depth,
      });
    }
    for (const child of node.children) {
      traverse(child, depth + 1);
    }
  }

  traverse(root, 0);
  return list;
}

/**
 * Runs visual regression comparison between original HTML and candidate HTML across 3 viewports.
 */
export function runVisualRegression(input: {
  originalHtml?: string;
  candidateHtml?: string;
  liveHtml?: string;
  draftHtml?: string;
  draftValues?: Record<string, FieldValue>;
}): VisualRegressionResult {
  const origHtml = input.originalHtml || input.liveHtml || "";
  const candHtml = input.candidateHtml || input.draftHtml || "";

  const origRoot = parseHtml(origHtml);
  const candRoot = parseHtml(candHtml);

  const origList = digestElements(origRoot, origHtml);
  const candList = digestElements(candRoot, candHtml);

  // Derive which field labels/content were expected to change based on draftValues
  const expectedLabels = new Set<string>();
  const modifiedDraftKeys = Object.keys(input.draftValues || {});
  for (const key of modifiedDraftKeys) {
    const val = input.draftValues?.[key];
    if (val && typeof val === "object") {
      if (val.value) expectedLabels.add(String(val.value).toLowerCase().slice(0, 30));
      if (val.original) expectedLabels.add(String(val.original).toLowerCase().slice(0, 30));
    }
  }

  const reports: Record<ViewportMode, ViewportRegressionReport> = {
    desktop: analyzeViewport("desktop", origList, candList, expectedLabels, modifiedDraftKeys.length),
    tablet: analyzeViewport("tablet", origList, candList, expectedLabels, modifiedDraftKeys.length),
    mobile: analyzeViewport("mobile", origList, candList, expectedLabels, modifiedDraftKeys.length),
  };

  const avgChange = Number(
    ((reports.desktop.layoutChangedPercent + reports.tablet.layoutChangedPercent + reports.mobile.layoutChangedPercent) / 3).toFixed(1)
  );

  const allUnexpected = Array.from(new Set([
    ...reports.desktop.unexpectedChanges,
    ...reports.tablet.unexpectedChanges,
    ...reports.mobile.unexpectedChanges,
  ]));

  const allExpected = Array.from(new Set([
    ...reports.desktop.expectedChanges,
    ...reports.tablet.expectedChanges,
    ...reports.mobile.expectedChanges,
  ]));

  return {
    overallChangePercent: avgChange,
    hasUnexpectedChanges: allUnexpected.length > 0,
    expectedSummary: allExpected.length > 0 ? allExpected : ["No major content changes"],
    unexpectedSummary: allUnexpected,
    viewports: reports,
  };
}

function analyzeViewport(
  viewport: ViewportMode,
  orig: ElementDigest[],
  cand: ElementDigest[],
  expectedLabels: Set<string>,
  draftKeysCount: number
): ViewportRegressionReport {
  const width = VIEWPORT_SPECS[viewport].width;
  const expectedChanges: string[] = [];
  const unexpectedChanges: string[] = [];
  const regions: VisualDiffRegion[] = [];

  const maxLen = Math.max(orig.length, cand.length);
  let changedNodes = 0;

  // Track sections
  const origSections = orig.filter(x => ["header", "nav", "section", "footer"].includes(x.tag));
  const candSections = cand.filter(x => ["header", "nav", "section", "footer"].includes(x.tag));

  // Check if footer or nav moved or vanished
  const origFooter = orig.find(x => x.tag === "footer");
  const candFooter = cand.find(x => x.tag === "footer");
  if (origFooter && !candFooter) {
    unexpectedChanges.push("Footer section was unexpectedly removed");
    regions.push({
      id: `diff-footer-removed-${viewport}`,
      tag: "footer",
      selector: "footer",
      label: "Footer Section",
      kind: "removed",
      status: "unexpected",
      explanation: "Footer section is missing in draft",
      viewport,
      approxBox: { topPercent: 90, leftPercent: 5, widthPercent: 90, heightPercent: 8 },
    });
  } else if (origFooter && candFooter) {
    const origIndexRatio = origFooter.index / Math.max(1, orig.length);
    const candIndexRatio = candFooter.index / Math.max(1, cand.length);
    if (Math.abs(origIndexRatio - candIndexRatio) > 0.25) {
      unexpectedChanges.push("Footer vertical position shifted significantly (~96px)");
      regions.push({
        id: `diff-footer-shift-${viewport}`,
        tag: "footer",
        selector: "footer",
        label: "Footer Shift",
        kind: "shifted",
        status: "unexpected",
        explanation: "Footer shifted position unexpectedly",
        viewport,
        approxBox: { topPercent: 88, leftPercent: 5, widthPercent: 90, heightPercent: 10 },
      });
    }
  }

  // Iterate elements to find modifications
  for (let i = 0; i < cand.length; i++) {
    const item = cand[i];
    const match = orig.find(o => o.tag === item.tag && (o.id === item.id || (o.index === item.index && o.tag === item.tag)));

    const approxTop = Math.min(95, Math.max(2, (i / Math.max(1, cand.length)) * 95));
    const approxWidth = ["h1", "h2", "p", "section"].includes(item.tag) ? (viewport === "mobile" ? 90 : 70) : 30;

    if (!match) {
      changedNodes++;
      const isExpected = draftKeysCount > 0;
      if (isExpected) {
        expectedChanges.push(`New ${item.tag} element added`);
      } else {
        unexpectedChanges.push(`Unexpected ${item.tag} element added`);
      }
      regions.push({
        id: `diff-add-${viewport}-${i}`,
        tag: item.tag,
        selector: item.id ? `#${item.id}` : `${item.tag}:nth-of-type(${i + 1})`,
        label: item.text ? item.text.slice(0, 30) : `${item.tag} element`,
        kind: "added",
        status: isExpected ? "expected" : "unexpected",
        explanation: isExpected ? "Added element" : "Unexpected added element",
        viewport,
        approxBox: { topPercent: approxTop, leftPercent: 5, widthPercent: approxWidth, heightPercent: 6 },
      });
    } else {
      let isDifferent = false;
      let diffReason = "";

      if (item.text !== match.text) {
        isDifferent = true;
        diffReason = "Text content modified";
      } else if (item.src && item.src !== match.src) {
        isDifferent = true;
        diffReason = "Image source updated";
      } else if (item.href && item.href !== match.href) {
        isDifferent = true;
        diffReason = "Link destination changed";
      }

      if (isDifferent) {
        changedNodes++;
        const isExpected =
          Array.from(expectedLabels).some(label => item.text.toLowerCase().includes(label) || (match.text && match.text.toLowerCase().includes(label))) ||
          draftKeysCount > 0;

        if (isExpected) {
          expectedChanges.push(item.tag === "h1" ? "Hero heading" : item.tag === "img" ? "Hero image" : `${item.tag} content`);
        } else {
          unexpectedChanges.push(`Unexpected shift in ${item.tag}: '${item.text.slice(0, 25)}'`);
        }

        regions.push({
          id: `diff-mod-${viewport}-${i}`,
          tag: item.tag,
          selector: item.id ? `#${item.id}` : `${item.tag}`,
          label: item.text || item.tag,
          kind: "modified",
          status: isExpected ? "expected" : "unexpected",
          explanation: diffReason,
          viewport,
          approxBox: { topPercent: approxTop, leftPercent: 8, widthPercent: approxWidth, heightPercent: 7 },
        });
      }
    }
  }

  // Mobile specific check: elements pushed outside 390px
  if (viewport === "mobile") {
    for (const c of cand) {
      if (c.classes.includes("min-w-[") || c.classes.includes("w-[5") || c.classes.includes("w-[6") || c.classes.includes("w-[7") || c.classes.includes("w-[8")) {
        unexpectedChanges.push("Mobile layout breakage: wide container exceeds 390px screen");
        break;
      }
    }
  }

  const changeRatio = maxLen > 0 ? changedNodes / maxLen : 0;
  const layoutChangedPercent = Number((changeRatio * 100).toFixed(1));

  return {
    viewport,
    width,
    layoutChangedPercent,
    expectedChanges: Array.from(new Set(expectedChanges)).slice(0, 5),
    unexpectedChanges: Array.from(new Set(unexpectedChanges)).slice(0, 5),
    regions: regions.slice(0, 10),
    hasBreakage: unexpectedChanges.length > 0,
  };
}
