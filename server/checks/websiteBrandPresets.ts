import assert from "node:assert/strict";
import { websiteDesignOptions } from "../src/services/websiteManagement.js";
import { matchesPreset, mergePreset, presetPagePlan, type BrandPreset } from "../client/src/lib/websiteBrandPresets.js";
import { safeResponsiveStyle } from "../src/shared/websiteResponsive.js";
import type { SitePageDetail } from "../client/src/lib/types.js";

const preset: BrandPreset = { id: "primary", name: "Primary button", target: "button", styles: { "background-color": "#3157ff", padding: "12px 24px" } };
assert.deepEqual(websiteDesignOptions.parse({}).presets, []);
assert.equal(websiteDesignOptions.safeParse({ presets: [preset] }).success, true);
for (const styles of [{ color: "red; display: none" }, { color: "url(https://example.com)" }, { position: "fixed" }, { color: "expression(alert(1))" }, { color: "var(--remote)" }]) {
  assert.equal(websiteDesignOptions.safeParse({ presets: [{ ...preset, styles }] }).success, false);
}
assert.equal(websiteDesignOptions.safeParse({ presets: [preset, preset] }).success, false);
assert.equal(matchesPreset(preset, { kind: "link", tag: "a" }), false);
assert.equal(matchesPreset(preset, { kind: "button", tag: "a" }), true);
assert.equal(matchesPreset({ ...preset, target: "heading" }, { kind: "text", tag: "h2" }), true);
assert.equal(mergePreset("border: 1px solid red; padding: 2px", preset), "border: 1px solid red; padding: 12px 24px; background-color: #3157ff");
const page = { sections: [{ fields: [{ id: "cta", kind: "button", tag: "a", label: "CTA", style: "color: white" }, { id: "shared", kind: "button", tag: "a", label: "Shared CTA" }] }], draft: { values: { cta: { value: "Existing unsaved words", responsive: { mobile: "padding: 4px" } } } }, shared: { scope: { shared: { state: "LINKED" } } } } as unknown as SitePageDetail;
const plan = presetPagePlan(page, preset);
assert.equal(plan.changes.length, 1);
assert.equal(plan.shared, 1);
assert.equal(plan.values.cta.value, "Existing unsaved words");
assert.equal(plan.values.cta.responsive?.mobile, "padding: 4px");
assert.equal(plan.values.shared, undefined);
assert.equal(page.draft.values.cta.style, undefined);
assert.match(safeResponsiveStyle("object-fit: cover; object-position: 20% 70%; aspect-ratio: 4 / 3; width: 100%; height: auto"), /aspect-ratio: 4 \/ 3/);
console.log("websiteBrandPresets: 18 assertions passed");
