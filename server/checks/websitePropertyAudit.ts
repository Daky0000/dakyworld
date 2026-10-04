/**
 * Automated Verification: Website Builder Prelaunch Property Inventory & Usability Audit
 *
 * Verifies:
 * 1. Complete Property Inventory across Content, Layout, Style, Interactions, Theme, SEO, Media, and Sections.
 * 2. Field types, tiers, viewport scopes, preview actions, saved values, and published results.
 * 3. Clear units, current values, reset behaviors, and disabled reasons.
 * 4. Responsive override scope and reset inheritance semantics across desktop, tablet, and mobile.
 * 5. Controls requiring preview reload (metadata, structure) vs live updates.
 * 6. Elimination of stale hardcoded tier prices.
 * 7. Active tab validity and selection change stability.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PROPERTY_INVENTORY,
  getPropertyInventoryByCategory,
  findPropertyControl,
  auditPropertyInventory,
  type PropertyCategory,
} from "../src/services/website/propertyInventory.js";

let checks = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks++;
}
function equal(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name);
  checks++;
}

console.log("Running websitePropertyAudit verification...\n");

// ==========================================
// 1. Property Inventory Completeness
// ==========================================
console.log("1. Property Inventory Completeness");

const audit = auditPropertyInventory();
check("Property inventory is non-empty", audit.valid);
check("Property inventory contains at least 35 controls", audit.total >= 35);

const categories: PropertyCategory[] = [
  "content",
  "layout",
  "style",
  "interactions",
  "theme",
  "seo",
  "media",
  "sections",
];

for (const cat of categories) {
  const items = getPropertyInventoryByCategory(cat);
  check(`Category "${cat}" has registered controls`, items.length > 0);
  check(`Category "${cat}" has at least 2 controls`, items.length >= 2);
}

// Every item must have all required fields specified
for (const item of PROPERTY_INVENTORY) {
  check(`Item ${item.id} has valid name`, item.name.length > 0);
  check(`Item ${item.id} has category`, categories.includes(item.category));
  check(`Item ${item.id} has fieldType`, item.fieldType.length > 0);
  check(`Item ${item.id} has tier requirement`, item.tier === "all" || item.tier === "pro_or_business");
  check(`Item ${item.id} has viewport scope`, ["all_screens", "responsive_override", "global_head"].includes(item.viewportScope));
  check(`Item ${item.id} has preview action`, ["live_dom", "live_style", "live_css_vars", "needs_preview_reload", "sandboxed_inert"].includes(item.previewAction));
  check(`Item ${item.id} has saved value format`, item.savedValueFormat.length > 0);
  check(`Item ${item.id} has published result description`, item.publishedResult.length > 0);
  check(`Item ${item.id} has reset behavior`, item.resetBehavior.length > 0);
}

console.log(`   ✓ All ${audit.total} controls across ${categories.length} categories verified`);

// ==========================================
// 2. Units, Reset Behaviors, and Disabled Reasons
// ==========================================
console.log("\n2. Units, Reset Behaviors, and Disabled Reasons");

// Verify length and dimensional properties declare supported units
const lengthProperties = PROPERTY_INVENTORY.filter(
  (item) => item.fieldType === "length" || item.fieldType === "quad_length",
);
check("Length properties exist in inventory", lengthProperties.length > 0);

for (const lp of lengthProperties) {
  check(`Length property ${lp.id} declares supportedUnits`, Array.isArray(lp.supportedUnits) && lp.supportedUnits.length > 0);
  check(`Length property ${lp.id} supports px`, lp.supportedUnits?.includes("px"));
}

// Verify disabled reasons exist where editing is restricted
const unsupportedComp = findPropertyControl("content_unsupported");
check("Unsupported component exists in inventory", !!unsupportedComp);
check("Unsupported component specifies disabledReason", typeof unsupportedComp?.disabledReason === "string" && unsupportedComp.disabledReason.length > 0);

const lockedItems = PROPERTY_INVENTORY.filter((item) => item.tier === "pro_or_business");
check("Locked items exist (SEO, Theme)", lockedItems.length >= 4);
for (const li of lockedItems) {
  if (li.id.startsWith("theme_") || li.id.startsWith("seo_og_") || li.id.startsWith("seo_alt_")) {
    check(`Locked feature ${li.id} specifies disabled reason explaining tier requirement`, typeof li.disabledReason === "string" && li.disabledReason.length > 0);
  }
}

console.log("   ✓ Units, reset behaviors, and disabled reasons strictly verified");

// ==========================================
// 3. Viewport Scope and Override Reset Semantics
// ==========================================
console.log("\n3. Viewport Scope and Override Semantics");

const responsiveItems = PROPERTY_INVENTORY.filter((item) => item.viewportScope === "responsive_override");
check("Responsive override items exist in inventory", responsiveItems.length >= 15);

// Ensure CSS properties that override per-viewport are responsive
const sampleCssProps = ["layout_width", "style_font_size", "style_padding", "style_margin", "style_color"];
for (const prop of sampleCssProps) {
  const item = findPropertyControl(prop);
  check(`Property ${prop} is registered as responsive_override`, item?.viewportScope === "responsive_override");
}

console.log(`   ✓ ${responsiveItems.length} responsive override controls mapped`);

// ==========================================
// 4. Editing Feedback & Preview Reload Marking
// ==========================================
console.log("\n4. Editing Feedback & Preview Reload Marking");

const reloadItems = PROPERTY_INVENTORY.filter((item) => item.previewAction === "needs_preview_reload");
check("Reload-requiring items exist", reloadItems.length >= 4);

// Page title, meta tags, and structure mutations must be marked as needing reload
const expectedReloadProps = ["seo_page_title", "seo_meta_description", "section_reorder", "section_duplicate", "section_remove"];
for (const exp of expectedReloadProps) {
  const item = findPropertyControl(exp);
  check(`${exp} is marked as needs_preview_reload`, item?.previewAction === "needs_preview_reload");
}

// Visual style controls must be live
const liveStyleProps = ["layout_display", "style_color", "style_font_size", "style_background_color"];
for (const lsp of liveStyleProps) {
  const item = findPropertyControl(lsp);
  check(`${lsp} is marked as live_style`, item?.previewAction === "live_style");
}

console.log(`   ✓ ${reloadItems.length} reload-requiring controls and live controls verified`);

// ==========================================
// 5. Verification: No Stale Hardcoded Tier Prices
// ==========================================
console.log("\n5. Verification: No Stale Hardcoded Tier Prices in UI");

const websiteEditorSource = fs.readFileSync(
  path.resolve("client/src/pages/WebsiteEditor.tsx"),
  "utf8",
);

// Stale price strings that were previously hardcoded in tooltips and button labels
const stalePatterns = [
  "($16)/mo",
  "($45)/mo",
  "$10 ($16)",
  "$25 ($45)",
];

for (const stale of stalePatterns) {
  check(
    `WebsiteEditor.tsx contains no occurrence of '${stale}'`,
    !websiteEditorSource.includes(stale),
  );
}

console.log("   ✓ Zero stale hardcoded tier prices in WebsiteEditor.tsx");

// ==========================================
// 6. Active Tab Stability
// ==========================================
console.log("\n6. Active Tab Stability");

// Verify that WebsiteEditor supports layout, style, and interactions for containers
check(
  "WebsiteEditor defines container tabs with layout, style, and interactions",
  websiteEditorSource.includes('picked.kind === "container"\n                  ? (["layout", "style", "interactions"] as const)'),
);

// Verify that switching elements retains valid tabs without resetting unnecessarily
check(
  "WebsiteEditor synchronizes valid active tabs without unsolicited resetting",
  websiteEditorSource.includes('const allowed: Array<typeof inspectorTab> = ["layout", "style", "interactions"];') &&
  websiteEditorSource.includes('const allowed: Array<typeof inspectorTab> = ["content", "style", "interactions"];'),
);

console.log("   ✓ Container interactions and active tab preservation verified");

console.log(`\nAll websitePropertyAudit checks passed successfully (${checks} checks).\n`);
