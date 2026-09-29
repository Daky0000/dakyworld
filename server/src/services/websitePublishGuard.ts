/**
 * websitePublishGuard.ts — Automated pre-flight guard checks for website publishing.
 *
 * Guarantees that clients and freelancers can safely publish edits without breaking
 * the website, layout, accessibility, mobile responsiveness, or brand identity.
 */

import { parseHtml, walk, attr, textOf, type ElementNode } from "./website/parse.js";
import type { FieldValue } from "./website/index.js";

export type GuardSeverity = "blocker" | "warning" | "info";
export type GuardCategory = "safe_publish" | "mobile_safety" | "accessibility" | "brand_guard";

export type GuardIssue = {
  id: string;
  category: GuardCategory;
  severity: GuardSeverity;
  title: string;
  description: string;
  fieldId?: string;
  selector?: string;
  suggestion?: string;
};

export type BrandGuardConfig = {
  enabled?: boolean;
  approvedColors?: string[];
  approvedFonts?: string[];
  allowedHeadingSizes?: string[];
  buttonStyles?: string[];
  enforcePalette?: boolean;
};

export type PublishGuardResult = {
  canPublish: boolean;
  safeToPublish: boolean;
  passedCount: number;
  totalChecks: number;
  summary: string;
  blockers: GuardIssue[];
  warnings: GuardIssue[];
  infos: GuardIssue[];
  checks: {
    brokenImages: boolean;
    brokenLinks: boolean;
    missingAssets: boolean;
    accidentalEmptyHeadings: boolean;
    malformedUrls: boolean;
    hugeImages: boolean;
    overflowingElements: boolean;
    horizontalMobileScrolling: boolean;
    textContrast: boolean;
    elementsPushedOutside: boolean;
    accidentalHiddenSections: boolean;
    missingAltText: boolean;
    duplicateIds: boolean;
    majorLayoutChanges: boolean;
    mobileSafety: boolean;
    accessibilityH1: boolean;
    brandGuard: boolean;
  };
};

/**
 * Calculates relative luminance for an sRGB color.
 * Reference: WCAG 2.1 specification.
 */
function srgbLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r / 255, g / 255, b / 255].map(c => {
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculates WCAG contrast ratio between two hex/rgb colors.
 */
function contrastRatio(hex1: string, hex2: string): number {
  const c1 = parseHexColor(hex1);
  const c2 = parseHexColor(hex2);
  if (!c1 || !c2) return 21; // fallback when color cannot be parsed
  const l1 = srgbLuminance(c1.r, c1.g, c1.b);
  const l2 = srgbLuminance(c2.r, c2.g, c2.b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseHexColor(color: string): { r: number; g: number; b: number } | null {
  const clean = color.trim().toLowerCase();
  if (clean.startsWith("#")) {
    const raw = clean.slice(1);
    if (raw.length === 3) {
      return {
        r: parseInt(raw[0] + raw[0], 16),
        g: parseInt(raw[1] + raw[1], 16),
        b: parseInt(raw[2] + raw[2], 16),
      };
    }
    if (raw.length === 6) {
      return {
        r: parseInt(raw.slice(0, 2), 16),
        g: parseInt(raw.slice(2, 4), 16),
        b: parseInt(raw.slice(4, 6), 16),
      };
    }
  }
  if (clean.startsWith("rgb")) {
    const match = clean.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (match) {
      return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
    }
  }
  // Named common colors
  if (clean === "white") return { r: 255, g: 255, b: 255 };
  if (clean === "black") return { r: 0, g: 0, b: 0 };
  return null;
}

/**
 * Executes all 17 pre-flight publish guard checks against candidate HTML.
 */
export function runPublishGuardChecks(input: {
  candidateHtml: string;
  sourceHtml: string;
  draftValues?: Record<string, FieldValue>;
  knownAssetPaths?: Set<string>;
  brandGuard?: BrandGuardConfig | null;
}): PublishGuardResult {
  const blockers: GuardIssue[] = [];
  const warnings: GuardIssue[] = [];
  const infos: GuardIssue[] = [];

  const checks = {
    brokenImages: true,
    brokenLinks: true,
    missingAssets: true,
    accidentalEmptyHeadings: true,
    malformedUrls: true,
    hugeImages: true,
    overflowingElements: true,
    horizontalMobileScrolling: true,
    textContrast: true,
    elementsPushedOutside: true,
    accidentalHiddenSections: true,
    missingAltText: true,
    duplicateIds: true,
    majorLayoutChanges: true,
    mobileSafety: true,
    accessibilityH1: true,
    brandGuard: true,
  };

  const candHtml = input.candidateHtml || (input as any).html || "";
  const srcHtml = input.sourceHtml || candHtml;

  const candidateRoot = parseHtml(candHtml);
  const sourceRoot = parseHtml(srcHtml);

  // Collect all elements and IDs
  const allElements: ElementNode[] = [];
  const idCounts = new Map<string, number>();
  for (const node of walk(candidateRoot)) {
    if (node === candidateRoot) continue;
    allElements.push(node);
    const idVal = attr(node, "id")?.trim();
    if (idVal) {
      idCounts.set(idVal, (idCounts.get(idVal) ?? 0) + 1);
    }
  }

  // 1. Broken Images
  for (const node of allElements) {
    if (node.tag === "img") {
      const src = attr(node, "src")?.trim();
      const alt = attr(node, "alt");
      if (!src || src === "#" || src === "about:blank") {
        checks.brokenImages = false;
        blockers.push({
          id: `broken-img-${node.start}`,
          category: "safe_publish",
          severity: "blocker",
          title: "Broken Image Source",
          description: "An image tag has an empty or invalid 'src' attribute.",
          suggestion: "Upload or specify a valid image URL.",
        });
      } else if (src.includes(" ") || src.startsWith("htp://") || src.startsWith("htps://")) {
        checks.malformedUrls = false;
        blockers.push({
          id: `malformed-img-url-${node.start}`,
          category: "safe_publish",
          severity: "blocker",
          title: "Malformed Image URL",
          description: `Image URL '${src.slice(0, 60)}' contains invalid characters or protocol.`,
          suggestion: "Check the image link for typos or spaces.",
        });
      } else if (input.knownAssetPaths && src.startsWith("/assets/dw/")) {
        const localPath = src.split("?")[0];
        if (!input.knownAssetPaths.has(localPath)) {
          checks.missingAssets = false;
          warnings.push({
            id: `missing-dw-asset-${node.start}`,
            category: "safe_publish",
            severity: "warning",
            title: "Missing Local Asset",
            description: `Referenced image '${src}' was not found in site assets.`,
            suggestion: "Re-upload the asset in your Asset Library.",
          });
        }
      }

      // Check Missing Alt Text
      if (alt === undefined || (alt.trim() === "" && !attr(node, "aria-hidden"))) {
        checks.missingAltText = false;
        warnings.push({
          id: `missing-alt-${node.start}`,
          category: "accessibility",
          severity: "warning",
          title: "Missing Image Alt Description",
          description: `Image '${(src || "").split("/").pop() || "image"}' has no alt text description for screen readers and SEO.`,
          suggestion: "Add descriptive alt text describing the image content.",
        });
      }

      // Check Huge inlined images
      if (src && src.startsWith("data:image/") && src.length > 1.5 * 1024 * 1024) {
        checks.hugeImages = false;
        const sizeMb = (src.length * 0.75 / (1024 * 1024)).toFixed(1);
        warnings.push({
          id: `huge-image-${node.start}`,
          category: "safe_publish",
          severity: "warning",
          title: "Huge Embedded Image",
          description: `Inlined image is ${sizeMb} MB. Large images cause severe mobile load delay.`,
          suggestion: "Compress with Asset Optimizer or upload as an external WebP/AVIF asset.",
        });
      }
    }
  }

  // 2. Broken Links & Button Destinations
  for (const node of allElements) {
    if (node.tag === "a") {
      const href = attr(node, "href");
      const linkText = textOf(candHtml, node).trim();
      const isButtonLook = (attr(node, "class") || "").includes("btn") || (attr(node, "class") || "").includes("button") || (attr(node, "class") || "").includes("rounded-");
      
      if (href === undefined || href.trim() === "") {
        checks.brokenLinks = false;
        blockers.push({
          id: `empty-href-${node.start}`,
          category: "safe_publish",
          severity: "blocker",
          title: isButtonLook ? "Button Has No Destination" : "Empty Link Destination",
          description: isButtonLook
            ? `Your '${linkText || "Action"}' button no longer has a destination.`
            : `Link text '${linkText || "link"}' has an empty href attribute.`,
          suggestion: "Set a destination URL or anchor (e.g. '/contact' or '#section').",
        });
      } else if (href.trim() === "#" && isButtonLook) {
        checks.brokenLinks = false;
        blockers.push({
          id: `placeholder-btn-${node.start}`,
          category: "safe_publish",
          severity: "blocker",
          title: "Button Destination Incomplete",
          description: `Your '${linkText || "Action"}' button has a placeholder '#' destination.`,
          suggestion: "Add the real page link, email, or section target.",
        });
      } else if (href.startsWith("#") && href.length > 1) {
        // Internal anchor check: does target ID exist?
        const targetId = href.slice(1).split("?")[0];
        if (!idCounts.has(targetId)) {
          checks.brokenLinks = false;
          warnings.push({
            id: `anchor-missing-${node.start}`,
            category: "safe_publish",
            severity: "warning",
            title: "Internal Anchor Target Not Found",
            description: `Link '${linkText || href}' points to '#${targetId}', but no element with id='${targetId}' exists on this page.`,
            suggestion: `Ensure an element has id="${targetId}".`,
          });
        }
      } else if (href.startsWith("javascript:")) {
        checks.brokenLinks = false;
        warnings.push({
          id: `js-href-${node.start}`,
          category: "safe_publish",
          severity: "warning",
          title: "Inline JavaScript in Link",
          description: `Link '${linkText || "action"}' uses javascript: pseudoprotocol.`,
          suggestion: "Use standard URLs or interaction buttons instead.",
        });
      }
    }
  }

  // 3. Accidental Empty Headings
  const headingTags = ["h1", "h2", "h3", "h4", "h5", "h6"];
  let h1Count = 0;
  for (const node of allElements) {
    if (headingTags.includes(node.tag)) {
      const headingText = textOf(candHtml, node).trim();
      if (node.tag === "h1") h1Count++;

      if (!headingText) {
        checks.accidentalEmptyHeadings = false;
        blockers.push({
          id: `empty-heading-${node.start}`,
          category: "safe_publish",
          severity: "blocker",
          title: `Accidental Empty Heading <${node.tag}>`,
          description: `A <${node.tag}> element has no text content. Empty headings hurt SEO and screen readers.`,
          suggestion: "Add text to this heading or delete the empty element.",
        });
      } else if (headingText.length > 90 && node.tag === "h1") {
        checks.mobileSafety = false;
        warnings.push({
          id: `long-h1-${node.start}`,
          category: "mobile_safety",
          severity: "warning",
          title: "Heading Wraps to 5+ Lines on Small Screens",
          description: `Main heading is very long (${headingText.length} characters) and may cause awkward line wrapping on mobile.`,
          suggestion: "Shorten the heading or apply responsive typography.",
        });
      }
    }
  }

  // 4. Accessibility: Main H1 Heading Check
  if (h1Count === 0) {
    checks.accessibilityH1 = false;
    blockers.push({
      id: "missing-h1-heading",
      category: "accessibility",
      severity: "blocker",
      title: "Missing Main Heading (H1)",
      description: "This page no longer has a main <h1> heading. Every webpage requires exactly one H1 for accessibility and SEO.",
      suggestion: "Add a main <h1> heading to the top hero section.",
    });
  } else if (h1Count > 1) {
    checks.accessibilityH1 = false;
    warnings.push({
      id: "multiple-h1-headings",
      category: "accessibility",
      severity: "warning",
      title: "Multiple <h1> Headings Detected",
      description: `Page contains ${h1Count} <h1> headings. Single H1 heading hierarchy is recommended.`,
      suggestion: "Change secondary headings to <h2>.",
    });
  }

  // 5. Duplicate IDs
  for (const [id, count] of idCounts.entries()) {
    if (count > 1) {
      checks.duplicateIds = false;
      blockers.push({
        id: `dup-id-${id}`,
        category: "safe_publish",
        severity: "blocker",
        title: `Duplicate HTML ID '#${id}'`,
        description: `The ID '#${id}' is used ${count} times on this page. HTML IDs must be strictly unique.`,
        suggestion: `Rename duplicate instances of id="${id}".`,
      });
    }
  }

  // 6. Overflowing Elements & Horizontal Mobile Scrolling
  for (const node of allElements) {
    const style = attr(node, "style") || "";
    const cls = attr(node, "class") || "";

    // Width checks
    const widthMatch = style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i);
    const minWidthMatch = style.match(/(?:^|;)\s*min-width\s*:\s*([^;]+)/i);

    if (widthMatch) {
      const val = widthMatch[1].trim();
      const num = parseInt(val, 10);
      if (val.endsWith("px") && num > 1280) {
        checks.overflowingElements = false;
        warnings.push({
          id: `overflow-width-${node.start}`,
          category: "safe_publish",
          severity: "warning",
          title: "Fixed Width Exceeds Container",
          description: `Element has fixed width of ${val}, risking viewport overflow.`,
          suggestion: "Use max-width: 100% or percentage widths.",
        });
      }
      if (val.endsWith("px") && num > 390 && !cls.includes("overflow") && !cls.includes("w-") && !cls.includes("hidden")) {
        checks.horizontalMobileScrolling = false;
        warnings.push({
          id: `mobile-scroll-${node.start}`,
          category: "mobile_safety",
          severity: "warning",
          title: "Horizontal Mobile Scrolling Risk",
          description: `Element has fixed width ${val} exceeding phone width (390px).`,
          suggestion: "Add 'max-w-full' or responsive container class.",
        });
      }
    }

    if (minWidthMatch) {
      const val = minWidthMatch[1].trim();
      const num = parseInt(val, 10);
      if (val.endsWith("px") && num > 390) {
        checks.horizontalMobileScrolling = false;
        warnings.push({
          id: `mobile-minwidth-${node.start}`,
          category: "mobile_safety",
          severity: "warning",
          title: "Horizontal Mobile Scrolling Risk",
          description: `Element has min-width of ${val}, which forces horizontal scrolling on mobile phones.`,
          suggestion: "Ensure min-width is only applied on tablet/desktop breakpoints (e.g. md:min-w-...).",
        });
      }
    }

    // Negative margin checks
    const marginMatch = style.match(/(?:^|;)\s*margin-(?:left|right|top)\s*:\s*(-?\d+)px/i);
    if (marginMatch && parseInt(marginMatch[1], 10) < -120) {
      checks.elementsPushedOutside = false;
      warnings.push({
        id: `negative-margin-${node.start}`,
        category: "safe_publish",
        severity: "warning",
        title: "Element Pushed Outside Container",
        description: `Extreme negative margin (${marginMatch[1]}px) may push content off-screen.`,
        suggestion: "Adjust positioning or flex/grid alignment instead of large negative margins.",
      });
    }

    // Accidental hidden sections
    if (["section", "header", "footer", "main"].includes(node.tag)) {
      const isHidden = style.includes("display: none") || style.includes("opacity: 0") || style.includes("visibility: hidden");
      if (isHidden) {
        checks.accidentalHiddenSections = false;
        warnings.push({
          id: `hidden-section-${node.start}`,
          category: "safe_publish",
          severity: "warning",
          title: `Accidental Hidden <${node.tag}> Section`,
          description: `A primary <${node.tag}> section has display:none or opacity:0.`,
          suggestion: "Confirm whether this section was meant to remain hidden on the live website.",
        });
      }
    }

    // Unreadable text contrast check
    const colorMatch = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
    const bgMatch = style.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i);
    if (colorMatch && bgMatch) {
      const fg = colorMatch[1].trim();
      const bg = bgMatch[1].trim();
      const ratio = contrastRatio(fg, bg);
      if (ratio < 4.5 && !style.includes("transparent")) {
        checks.textContrast = false;
        warnings.push({
          id: `contrast-issue-${node.start}`,
          category: "accessibility",
          severity: "warning",
          title: "Unreadable Text Contrast",
          description: `Text contrast ratio is ${ratio.toFixed(1)}:1 between text (${fg}) and background (${bg}). WCAG AA requires at least 4.5:1.`,
          suggestion: "Darken the text or lighten the background to improve readability.",
        });
      }
    }
  }

  // 7. Brand Guard Checks
  if (input.brandGuard && input.brandGuard.enabled !== false) {
    const approved = new Set((input.brandGuard.approvedColors || []).map(c => c.toLowerCase().trim()));
    if (approved.size > 0) {
      // Check candidate HTML styles for unauthorized hex codes
      const hexMatches = candHtml.match(/#(?:[0-9a-fA-F]{3}){1,2}\b/g) || [];
      const unapprovedFound = new Set<string>();
      for (const hex of hexMatches) {
        const clean = hex.toLowerCase();
        if (!approved.has(clean)) {
          unapprovedFound.add(hex);
        }
      }
      if (unapprovedFound.size > 0) {
        checks.brandGuard = false;
        const list = Array.from(unapprovedFound).slice(0, 3).join(", ");
        warnings.push({
          id: "brand-guard-palette-violation",
          category: "brand_guard",
          severity: input.brandGuard.enforcePalette ? "blocker" : "warning",
          title: "Brand Guard: Unapproved Colors Detected",
          description: `${list} ${unapprovedFound.size > 1 ? "are" : "is"} not in your approved brand palette.`,
          suggestion: "Choose from your defined brand colors.",
        });
      }
    }
  }

  // 8. Major Layout Shift / Volatility
  const sourceElementsCount = Array.from(walk(sourceRoot)).length;
  const candidateElementsCount = allElements.length;
  if (sourceElementsCount > 10) {
    const diffRatio = Math.abs(candidateElementsCount - sourceElementsCount) / sourceElementsCount;
    if (diffRatio > 0.45) {
      checks.majorLayoutChanges = false;
      warnings.push({
        id: "major-layout-change",
        category: "safe_publish",
        severity: "warning",
        title: "Major Layout Changes Detected",
        description: `Page structure changed by ${(diffRatio * 100).toFixed(0)}% (element count shifted from ${sourceElementsCount} to ${candidateElementsCount}).`,
        suggestion: "Review the Visual Regression diff to confirm layout integrity before publishing.",
      });
    }
  }

  // Check counts
  const checkKeys = Object.keys(checks) as (keyof typeof checks)[];
  const passedCount = checkKeys.filter(k => checks[k]).length;
  const totalChecks = checkKeys.length;
  const canPublish = blockers.length === 0;

  let summary = "";
  if (!canPublish) {
    summary = `Publishing blocked: ${blockers[0].description}`;
  } else if (warnings.length > 0) {
    summary = `Ready to publish: ${passedCount} checks passed, ${warnings.length} warning: ${warnings[0].description}`;
  } else {
    summary = `Ready to publish: ${passedCount} checks passed. No broken links or mobile overflow detected.`;
  }

  return {
    canPublish,
    safeToPublish: canPublish,
    passedCount,
    totalChecks,
    summary,
    blockers,
    warnings,
    infos,
    checks,
  };
}
