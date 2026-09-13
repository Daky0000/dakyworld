import type { SiteFieldRow, SitePageDetail } from "./types";

export type BrandPreset = { id: string; name: string; target: "heading" | "button" | "spacing"; styles: Record<string, string> };
export const PRESET_PROPERTIES = ["font-family", "font-size", "font-weight", "line-height", "color", "background-color", "border-radius", "padding", "margin", "gap"] as const;
export function matchesPreset(preset: BrandPreset, field: Pick<SiteFieldRow, "tag" | "kind">) {
  return preset.target === "heading" ? /^h[1-6]$/i.test(field.tag) : preset.target === "button" ? field.kind === "button" : field.kind === "container";
}
export function mergePreset(style: string | undefined, preset: BrandPreset) {
  const values: Record<string, string> = {};
  for (const declaration of (style ?? "").split(";")) { const i = declaration.indexOf(":"); if (i > 0) values[declaration.slice(0, i).trim()] = declaration.slice(i + 1).trim(); }
  Object.assign(values, preset.styles);
  return Object.entries(values).map(([property, value]) => `${property}: ${value}`).join("; ");
}
export function presetPagePlan(page: SitePageDetail, preset: BrandPreset) {
  const values = { ...page.draft.values };
  const fields = [...new Map(page.sections.flatMap(section => section.fields).map(field => [field.id, field])).values()];
  const changes: Array<{ id: string; label: string; before: string; after: string }> = [];
  let shared = 0;
  for (const field of fields.filter(field => matchesPreset(preset, field))) {
    if (page.shared?.scope[field.id]?.state === "LINKED") { shared++; continue; }
    const before = values[field.id]?.style ?? field.style ?? "";
    const after = mergePreset(before, preset);
    if (after !== before) { changes.push({ id: field.id, label: field.label, before, after }); values[field.id] = { ...values[field.id], style: after }; }
  }
  return { values, changes, shared };
}
