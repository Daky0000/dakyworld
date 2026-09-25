/**
 * What can reasonably be changed about the selected element.
 *
 * The inspector used to answer a different question — which CSS properties does
 * Dakyworld know how to edit — and answered it identically for a heading, a
 * photograph and a flex row. This module is the model that replaces that: the
 * element's capabilities are derived once, from what the element actually is in
 * the rendered page, and every section of the panel is drawn or not drawn from
 * that one derivation.
 *
 * Deliberately free of React and of the DOM. Everything here is a pure function
 * over facts the frame reports, which is what lets `checks/websiteInspector.ts`
 * test the rules rather than a rendering of them — the lesson from the nonce bug
 * being that asserting a control was drawn is not a test of whether the right
 * control was drawn.
 */

export type FieldKind = "text" | "richtext" | "link" | "button" | "image" | "container" | "icon";

/** The three widths the canvas offers. `mobile` is the draft's own key. */
export type Device = "desktop" | "tablet" | "mobile";

/**
 * What the preview frame can say about the selected element.
 *
 * `kind` alone is not enough and that is the point of this type: a `div` may be
 * a wrapper, a card, an overlay, a flex row or a grid, and an `a` may be inline
 * words or a button with an icon beside its label. Only the rendered element
 * knows which.
 */
export type ElementFacts = {
  kind: FieldKind;
  tag: string;
  /** Computed `display` at the active viewport. */
  display: string;
  /** Computed `display` of the parent element; "" when there is no parent. */
  parentDisplay: string;
  /** Computed `position` at the active viewport. */
  position: string;
  /** Whether the element has words of its own, so typography means something. */
  hasText: boolean;
  /** Element children, so a Display control has something to arrange. */
  childCount: number;
};

export type ElementCapabilities = {
  content: boolean;
  typography: boolean;
  dimensions: boolean;
  spacing: boolean;
  background: boolean;
  border: boolean;
  effects: boolean;

  image: boolean;

  layoutContainer: boolean;
  flexContainer: boolean;
  gridContainer: boolean;

  flexChild: boolean;
  gridChild: boolean;

  positioning: boolean;
};

/** Elements the browser draws itself, which take a size even when inline. */
const REPLACED = new Set(["img", "svg", "video", "canvas", "picture", "iframe", "object", "embed"]);

const isFlex = (display: string) => /(?:^|-)flex$/.test(display.trim());
const isGrid = (display: string) => /(?:^|-)grid$/.test(display.trim());

export function elementCapabilities(facts: ElementFacts): ElementCapabilities {
  const tag = facts.tag.toLowerCase();
  const display = (facts.display || "block").trim();
  const image = facts.kind === "image" || REPLACED.has(tag);
  // `inline` and nothing else: an inline-block, an inline-flex and a replaced
  // element all take a width, and a plain `<span>` or a text link does not.
  const inlineOnly = display === "inline" && !image;

  return {
    content: facts.kind !== "container",
    // A container with words in it is worth styling — a section's colour is a
    // normal thing to want — and one with no text of its own is not, so the
    // section is not drawn rather than drawn and inert.
    typography: !image && (facts.kind !== "container" || facts.hasText),
    dimensions: !inlineOnly,
    spacing: true,
    background: true,
    border: true,
    effects: true,

    image,

    layoutContainer: facts.childCount > 0 || facts.kind === "container",
    flexContainer: isFlex(display),
    gridContainer: isGrid(display),

    flexChild: isFlex(facts.parentDisplay),
    gridChild: isGrid(facts.parentDisplay),

    // `position: static` is the browser's default for nearly everything on a
    // page. Showing a Position section on every element is how the panel came
    // to look like DevTools; it lives in Advanced until it is doing something.
    positioning: (facts.position || "static").trim() !== "static",
  };
}

export type SectionKey =
  | "content"
  | "image"
  | "layout"
  | "flexContainer"
  | "gridContainer"
  | "flexChild"
  | "gridChild"
  | "size"
  | "spacing"
  | "typography"
  | "background"
  | "border"
  | "effects"
  | "position"
  | "advanced";

export const SECTION_TITLE: Record<SectionKey, string> = {
  content: "Content",
  image: "Image",
  layout: "Layout",
  flexContainer: "Arrangement",
  gridContainer: "Grid",
  flexChild: "Within its row",
  gridChild: "Within the grid",
  size: "Size",
  spacing: "Spacing",
  typography: "Typography",
  background: "Background",
  border: "Border",
  effects: "Effects",
  position: "Position",
  advanced: "Advanced",
};

/** The order the panel draws them in, top to bottom. */
const SECTION_ORDER: SectionKey[] = [
  "content",
  "image",
  "layout",
  "flexContainer",
  "gridContainer",
  "flexChild",
  "gridChild",
  "size",
  "spacing",
  "typography",
  "background",
  "border",
  "effects",
  "position",
  "advanced",
];

const SECTION_CAPABILITY: Record<SectionKey, keyof ElementCapabilities | null> = {
  content: "content",
  image: "image",
  layout: "layoutContainer",
  flexContainer: "flexContainer",
  gridContainer: "gridContainer",
  flexChild: "flexChild",
  gridChild: "gridChild",
  size: "dimensions",
  spacing: "spacing",
  typography: "typography",
  background: "background",
  border: "border",
  effects: "effects",
  position: "positioning",
  advanced: null,
};

export function inspectorSections(capabilities: ElementCapabilities): SectionKey[] {
  return SECTION_ORDER.filter((section) => {
    const capability = SECTION_CAPABILITY[section];
    return capability === null || capabilities[capability];
  });
}

/* --------------------------------------------------------------- ownership */

/**
 * One editing home per property.
 *
 * A property with two owners is the defect this replaces — width and height
 * were in both Layout and Appearance, and the two wrote the same declaration
 * from different controls showing different values. The pairs that appear twice
 * here are ones an element can only ever satisfy one of: nothing is both a flex
 * container and a grid container, and no parent is both.
 */
export const PROPERTY_OWNER: Record<string, SectionKey | SectionKey[]> = {
  display: "layout",

  "flex-direction": "flexContainer",
  "flex-wrap": "flexContainer",
  "justify-content": ["flexContainer", "gridContainer"],
  "align-items": ["flexContainer", "gridContainer"],
  "row-gap": ["flexContainer", "gridContainer"],
  "column-gap": ["flexContainer", "gridContainer"],

  "grid-template-columns": "gridContainer",
  "grid-template-rows": "gridContainer",

  "align-self": ["flexChild", "gridChild"],
  "justify-self": "gridChild",
  order: "flexChild",
  "flex-grow": "flexChild",
  "flex-shrink": "flexChild",
  "grid-column": "gridChild",
  "grid-row": "gridChild",

  width: "size",
  height: "size",
  "min-width": "size",
  "max-width": "size",
  "min-height": "size",
  "max-height": "size",

  "margin-top": "spacing",
  "margin-right": "spacing",
  "margin-bottom": "spacing",
  "margin-left": "spacing",
  "padding-top": "spacing",
  "padding-right": "spacing",
  "padding-bottom": "spacing",
  "padding-left": "spacing",

  "font-family": "typography",
  "font-size": "typography",
  "font-weight": "typography",
  "font-style": "typography",
  "line-height": "typography",
  "letter-spacing": "typography",
  "text-align": "typography",
  "text-transform": "typography",
  "text-decoration": "typography",
  color: "typography",

  "background-color": "background",
  "background-image": "background",

  border: "border",
  "border-radius": "border",

  opacity: "effects",
  "box-shadow": "effects",
  "text-shadow": "effects",
  filter: "effects",
  transform: "effects",

  position: "position",
  top: "position",
  right: "position",
  bottom: "position",
  left: "position",
  "z-index": "position",

  "object-fit": "image",
  "object-position": "image",

  overflow: "advanced",
  "box-sizing": "advanced",
};

/**
 * Every property the inspector can show, and therefore every property it has to
 * measure in the frame. Derived from the ownership table rather than kept
 * beside it, so a property added to a section cannot be forgotten here and
 * silently read back as blank.
 */
export const INSPECTED_PROPERTIES: string[] = [...Object.keys(PROPERTY_OWNER), "border", "gap"];

/** Sections that can never both be visible for one element. */
export const EXCLUSIVE_SECTIONS: [SectionKey, SectionKey][] = [
  ["flexContainer", "gridContainer"],
  ["flexChild", "gridChild"],
];

export function ownersOf(property: string): SectionKey[] {
  const owner = PROPERTY_OWNER[property];
  if (!owner) return [];
  return Array.isArray(owner) ? owner : [owner];
}

/**
 * Valid, but not what most people came for.
 *
 * These are drawn under Advanced rather than taken away: clutter is solved by
 * ordering, not by removing controls from the person who went looking for one.
 */
export const ADVANCED_PROPERTIES = new Set([
  "overflow",
  "box-sizing",
  "z-index",
  "transform",
  "filter",
  "text-shadow",
  "min-width",
  "min-height",
  "max-height",
  "background-image",
  "justify-self",
  "order",
]);

export function isAdvanced(property: string): boolean {
  return ADVANCED_PROPERTIES.has(property);
}

/* ------------------------------------------------------- position controls */

export type Side = "top" | "right" | "bottom" | "left";

/**
 * Which offsets mean anything under the position in force.
 *
 * A static element ignores all four and its stacking order, so drawing five
 * boxes that do nothing is worse than drawing none.
 */
export function positionControls(position: string): { offsets: Side[]; zIndex: boolean } {
  switch ((position || "static").trim()) {
    case "relative":
    case "absolute":
    case "fixed":
      return { offsets: ["top", "right", "bottom", "left"], zIndex: true };
    case "sticky":
      return { offsets: ["top", "bottom"], zIndex: true };
    default:
      return { offsets: [], zIndex: false };
  }
}

/* ------------------------------------------------------------------ values */

/**
 * Where the value in a control came from.
 *
 * `website` is the site's own stylesheet, `inline` a `style` attribute the
 * developer wrote on the element itself, and the three overrides are this
 * draft, at each viewport.
 */
export type ValueOrigin = "website" | "inline" | "desktop-override" | "tablet-override" | "phone-override";

export type InspectorValue = {
  property: string;
  /** What the element's own `style` attribute defines in the page's source. */
  source?: string;
  /** What the browser says the element renders as, at the active viewport. */
  computed: string;
  /** What this draft sets, at the active viewport. */
  override?: string;
  /** What the person sees. */
  effective: string;
  origin: ValueOrigin;
  /** True when the active viewport itself carries the change, so Reset applies. */
  overridden: boolean;
};

const DEVICE_ORIGIN: Record<Device, ValueOrigin> = {
  desktop: "desktop-override",
  tablet: "tablet-override",
  mobile: "phone-override",
};

export const ORIGIN_LABEL: Record<ValueOrigin, string> = {
  website: "Website",
  inline: "Website",
  "desktop-override": "Override",
  "tablet-override": "Tablet",
  "phone-override": "Phone",
};

export const ORIGIN_TITLE: Record<ValueOrigin, string> = {
  website: "Comes from the site's own stylesheet.",
  inline: "Written on this element in the page's HTML.",
  "desktop-override": "Changed here, at every size.",
  "tablet-override": "Changed here, for tablets and below.",
  "phone-override": "Changed here, for phones.",
};

/**
 * The real value governing the selected element, and where it came from.
 *
 * The old panel showed an empty box marked "As designed" for a heading the site
 * renders at 72px, which tells somebody nothing and invites them to type a
 * number they have nothing to compare against. `effective` is what the page is
 * doing now; `origin` is who decided it.
 *
 * Nothing here writes: opening an element must not put its computed values into
 * a draft, or every page would be rewritten by being looked at.
 */
export function inspectorValue(
  property: string,
  input: { computed?: string; source?: string; override?: string; base?: string; device: Device },
): InspectorValue {
  const computed = (input.computed ?? "").trim();
  const source = input.source?.trim() || undefined;
  const override = input.override?.trim() || undefined;
  const base = input.base?.trim() || undefined;

  // A desktop draft carries the element's whole `style` attribute, so an
  // untouched element arrives here with the developer's own declarations
  // sitting in `override`. A value identical to the one in the page's HTML was
  // not changed by anybody, and calling it an override would both mislabel it
  // and offer a Reset that deletes somebody else's work.
  const changed = override !== undefined && override !== source;

  const origin: ValueOrigin = changed
    ? DEVICE_ORIGIN[input.device]
    : input.device !== "desktop" && base && base !== source
      ? "desktop-override"
      : source
        ? "inline"
        : "website";

  return {
    property,
    source,
    computed,
    override,
    effective: override ?? computed,
    origin,
    overridden: changed,
  };
}

/**
 * Values the browser computes for everything and nobody chose.
 *
 * Shown when something has actually set them, hidden otherwise — the panel is
 * meant to describe what governs this element, and `z-index: auto` on a static
 * div governs nothing.
 */
export const BROWSER_DEFAULTS: Record<string, string[]> = {
  position: ["static"],
  overflow: ["visible"],
  opacity: ["1"],
  "z-index": ["auto"],
  "object-fit": ["fill"],
  "flex-grow": ["0"],
  "flex-shrink": ["1"],
  order: ["0"],
  "align-self": ["auto"],
  "justify-self": ["auto"],
  "text-transform": ["none"],
  "font-style": ["normal"],
  "text-decoration": ["none", "none solid", "none solid rgb(0, 0, 0)"],
  "letter-spacing": ["normal"],
  "background-color": ["rgba(0, 0, 0, 0)", "transparent"],
  "background-image": ["none"],
  "border-radius": ["0px"],
  "box-shadow": ["none"],
  "text-shadow": ["none"],
  transform: ["none"],
  filter: ["none"],
  "flex-wrap": ["nowrap"],
  "grid-template-columns": ["none"],
  "grid-template-rows": ["none"],
  "min-width": ["0px", "auto"],
  "min-height": ["0px", "auto"],
  "max-width": ["none"],
  "max-height": ["none"],
  top: ["auto"],
  right: ["auto"],
  bottom: ["auto"],
  left: ["auto"],
};

export function isBrowserDefault(property: string, value: string): boolean {
  const defaults = BROWSER_DEFAULTS[property];
  if (!defaults) return false;
  const normalised = value.trim().toLowerCase().replace(/\s+/g, " ");
  return !normalised || defaults.some((candidate) => candidate.toLowerCase() === normalised);
}

/** Whether a value is worth putting in front of somebody as the current state. */
export function meaningfulValue(value: InspectorValue): boolean {
  // Nothing measured and nothing set. An origin under an empty box would be
  // crediting the website with a decision nobody made.
  if (!value.effective.trim() && !value.overridden) return false;
  if (value.overridden || value.origin !== "website") return true;
  return !isBrowserDefault(value.property, value.effective);
}

/* ----------------------------------------------------------- readable text */

const WEIGHT_NAMES: Record<string, string> = {
  "100": "Thin",
  "200": "Extra light",
  "300": "Light",
  "400": "Normal",
  "500": "Medium",
  "600": "Semibold",
  "700": "Bold",
  "800": "Extra bold",
  "900": "Black",
};

/** `rgb(8, 16, 31)` → `#08101F`, leaving anything it cannot read alone. */
export function toHex(value: string): string | null {
  const trimmed = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (hex) {
    const body = hex[1]!;
    const full = body.length === 3 ? body[0]! + body[0] + body[1] + body[1] + body[2] + body[2] : body;
    return `#${full.toUpperCase()}`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(trimmed);
  if (!rgb) return null;
  const part = (raw: string) => Math.max(0, Math.min(255, Math.round(Number(raw)))).toString(16).padStart(2, "0");
  return `#${part(rgb[1]!)}${part(rgb[2]!)}${part(rgb[3]!)}`.toUpperCase();
}

/**
 * The value as somebody reading the panel would say it.
 *
 * `"Space Grotesk", sans-serif` is a stack; the person picked a typeface. A
 * palette entry that matches is named, because "Ink" is what they called it
 * when they chose it and `#08101F` is not.
 */
export function readableValue(property: string, value: string, palette?: { label: string; value: string }[]): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (property === "font-family") {
    const first = trimmed.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
    return first || trimmed;
  }
  if (property === "font-weight") {
    const name = WEIGHT_NAMES[trimmed];
    return name ? `${trimmed} · ${name}` : trimmed;
  }
  if (property === "color" || property.endsWith("-color")) {
    const hex = toHex(trimmed);
    if (!hex) return trimmed;
    const named = palette?.find((entry) => (toHex(entry.value) ?? entry.value.toUpperCase()) === hex);
    return named ? `${named.label} · ${hex}` : hex;
  }
  return trimmed;
}
