import type { SiteFieldRow, SitePageDetail } from "./types.js";

export type BrandPreset = { id: string; name: string; target: "heading" | "button" | "spacing"; styles: Record<string, string> };
export const PRESET_PROPERTIES = ["font-family", "font-size", "font-weight", "line-height", "color", "background-color", "border-radius", "padding", "margin", "gap"] as const;

export function matchesPreset(preset: BrandPreset, field: Pick<SiteFieldRow, "tag" | "kind">) {
  return preset.target === "heading" ? /^h[1-6]$/i.test(field.tag) : preset.target === "button" ? field.kind === "button" : field.kind === "container";
}

export function mergePreset(style: string | undefined, preset: BrandPreset) {
  const values: Record<string, string> = {};
  for (const declaration of (style ?? "").split(";")) {
    const i = declaration.indexOf(":");
    if (i > 0) values[declaration.slice(0, i).trim()] = declaration.slice(i + 1).trim();
  }
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
    if (after !== before) {
      changes.push({ id: field.id, label: field.label, before, after });
      values[field.id] = { ...values[field.id], style: after };
    }
  }
  return { values, changes, shared };
}

export function createPresetsFromSurvey(survey: {
  palette: {
    colours: Array<{ value: string; uses: number; roles: string[] }>;
    typefaces: Array<{ family: string; uses: number }>;
    tokens: Array<{ name: string; value: string; isColour: boolean }>;
  };
}): BrandPreset[] {
  const presets: BrandPreset[] = [];

  const primaryToken = survey.palette.tokens.find(t => t.isColour && /brand|primary|accent|theme/i.test(t.name));
  const primaryColour = primaryToken ? `var(${primaryToken.name})` : survey.palette.colours[0]?.value || "#3157ff";
  const textColour = survey.palette.colours.find(c => c.roles.includes("text"))?.value || "#08101f";

  const headingFont = survey.palette.typefaces[0]?.family || "Space Grotesk, sans-serif";
  const bodyFont = survey.palette.typefaces[1]?.family || survey.palette.typefaces[0]?.family || "DM Sans, sans-serif";

  presets.push({
    id: "survey-heading",
    name: "Site Headings",
    target: "heading",
    styles: {
      "font-family": headingFont,
      "font-weight": "600",
      "letter-spacing": "-0.02em",
      "color": textColour,
    },
  });

  presets.push({
    id: "survey-button",
    name: "Primary Button",
    target: "button",
    styles: {
      "font-family": bodyFont,
      "background-color": primaryColour,
      "color": "#ffffff",
      "border-radius": "12px",
      "font-weight": "500",
      "padding": "10px 20px",
    },
  });

  presets.push({
    id: "survey-card",
    name: "Card Container",
    target: "spacing",
    styles: {
      "padding": "24px",
      "border-radius": "16px",
      "gap": "16px",
    },
  });

  return presets;
}
