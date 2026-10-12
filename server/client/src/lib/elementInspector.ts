/**
 * What the editor measures about the selected element in the frame.
 *
 * This file used to model a contextual inspector: which sections each element
 * was offered, and which section owned each property. On 11 Oct 2026 that was
 * replaced by one Style tab that is the same for every element
 * (`components/WebsiteStyleTab.tsx`), at Dan's request and on the model of the
 * page builder customers already know. What remains is what the editor still
 * asks the frame: the facts that decide the few controls that do depend on the
 * element — flex controls once it is a flex container, the flex-child section
 * once its parent is one, offsets once it is positioned — and the properties
 * whose rendered values become the panel's placeholders.
 *
 * Deliberately free of React and of the DOM, so `checks/websiteInspector.ts`
 * can hold it without a browser.
 */

export type FieldKind = "text" | "richtext" | "link" | "button" | "image" | "container" | "icon" | "background" | "unsupported";

/** The three widths the canvas offers. `mobile` is the draft's own key. */
export type Device = "desktop" | "tablet" | "mobile";

/**
 * What the preview frame can say about the selected element.
 *
 * `kind` alone is not enough: a `div` may be a wrapper, a card, a flex row or a
 * grid, and only the rendered element knows which.
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
  /** Whether the element has words of its own. */
  hasText: boolean;
  /** Element children. */
  childCount: number;
};

const SIDES = ["top", "right", "bottom", "left"];
const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"];

/**
 * Every property whose rendered value a Style control shows when the element
 * sets nothing of its own. A control reading a property missing from here would
 * show a blank box for a value the site really sets, so `checks/websiteInspector.ts`
 * holds the Style tab's own list against this one.
 */
export const INSPECTED_PROPERTIES: string[] = [
  // Layout
  "display", "flex-direction", "flex-wrap", "justify-content", "align-items", "align-content", "row-gap", "column-gap", "gap",
  "grid-template-columns", "grid-template-rows", "grid-auto-flow", "justify-items", "align-self", "justify-self", "order",
  "flex-grow", "flex-shrink", "flex-basis", "grid-column", "grid-row",
  // Spacing
  ...SIDES.flatMap((side) => [`margin-${side}`, `padding-${side}`]),
  // Size
  "width", "height", "min-width", "min-height", "max-width", "max-height", "overflow", "aspect-ratio", "object-fit", "object-position", "box-sizing",
  // Position
  "position", ...SIDES, "z-index", "scroll-margin-top",
  // Typography
  "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "word-spacing", "text-align", "text-transform",
  "text-decoration", "text-decoration-line", "color", "direction", "column-count", "text-shadow",
  // Background
  "background-color", "background-image", "background-size", "background-position", "background-repeat", "background-attachment", "background-clip",
  // Border
  "border", "border-color", "border-style", "border-radius", ...SIDES.flatMap((side) => [`border-${side}-width`, `border-${side}-style`]), ...CORNERS.map((corner) => `border-${corner}-radius`),
  // Effects
  "mix-blend-mode", "opacity", "box-shadow", "filter", "backdrop-filter", "transform", "transform-origin", "perspective", "perspective-origin", "transition",
];

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
