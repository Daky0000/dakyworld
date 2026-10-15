import { validFramingDeclaration } from "./websiteImageFraming.js";
/** A complete set of element overrides. Missing properties inherit the base. */
export type ResponsiveStyles = { tablet?: string; mobile?: string };

export const RESPONSIVE_BREAKPOINTS = { tablet: 1024, mobile: 640 } as const;
export const RESPONSIVE_TOKEN = /^dw-[a-f0-9]{24}$/;

// Generated media rules have a narrower input language than existing inline
// styles: no escapes, comments, rule delimiters, fetching functions or script.
// Unknown functions are rejected too, so newly introduced CSS fetch APIs cannot
// turn an old stored draft into a network request after a browser update.
const SAFE_FUNCTIONS = new Set([
  "calc", "min", "max", "clamp", "var", "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix",
  "linear-gradient", "radial-gradient", "conic-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient",
  "translate", "translatex", "translatey", "translatez", "translate3d", "scale", "scalex", "scaley", "scalez", "scale3d", "rotate", "rotatex", "rotatey", "rotatez", "rotate3d", "skew", "skewx", "skewy", "matrix", "matrix3d", "perspective",
  "blur", "brightness", "contrast", "drop-shadow", "grayscale", "hue-rotate", "invert", "opacity", "saturate", "sepia", "cubic-bezier", "steps", "repeat", "minmax", "fit-content", "inset", "circle", "ellipse", "polygon",
]);
const FETCH_PROPERTIES = /^(?:background(?:-image)?|border-image(?:-source)?|list-style(?:-image)?|(?:-webkit-)?mask(?:-image)?|cursor|content|filter|clip-path)$/;

export function safeResponsiveStyle(style: string): string {
  if (typeof style !== "string") return "";
  return style.split(";").flatMap((raw) => {
    const colon = raw.indexOf(":");
    if (colon < 1) return [];
    const property = raw.slice(0, colon).trim().toLowerCase();
    const value = raw.slice(colon + 1).trim().replace(/\s*!\s*important\s*$/i, "").trim();
    if (!validFramingDeclaration(property, value)) return [];
    if (!/^[a-z][a-z-]{1,39}$/.test(property) || !value || value.length > 240) return [];
    if (/[<>{}@`\\\u0000-\u001f]/.test(value) || /\/\*|\*\/|javascript\s*:|expression\s*\(|!/.test(value.toLowerCase())) return [];
    if (/["']/.test(value) && !(property === "font-family" && /^[a-zA-Z0-9 ,"'-]+$/.test(value))) return [];
    const functions = [...value.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*\(/g)].map((match) => match[1]!.toLowerCase());
    if (functions.some((name) => !SAFE_FUNCTIONS.has(name))) return [];
    // Variables in image-bearing properties can resolve to an existing url().
    if (FETCH_PROPERTIES.test(property) && functions.includes("var")) return [];
    return [`${property}: ${value}`];
  }).join("; ");
}

export function normalizeResponsive(input: unknown): ResponsiveStyles {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const result: ResponsiveStyles = {};
  for (const device of ["tablet", "mobile"] as const) {
    if (typeof value[device] !== "string") continue;
    const style = safeResponsiveStyle(value[device]);
    if (style) result[device] = style;
  }
  return result;
}

export function responsiveEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeResponsive(left)) === JSON.stringify(normalizeResponsive(right));
}

/**
 * `base` is the element's own inline style and `text` says whether it is a run
 * of words (see `isTextElement`); both only matter for `TEXT_METRICS`.
 */
export type ResponsiveStyleEntry = { token: string; responsive: ResponsiveStyles; base?: string; text?: boolean };

/**
 * The sizes a text element hands to every word inside it.
 *
 * Pages from AI builders often size a heading through an inner wrapper —
 * `<h1><span class="text-4xl">…</span></h1>` — and the span's class beats
 * anything inherited, so a font size set on the heading changed nothing that
 * could be seen. These four are pushed down to the words inside a text element
 * at every width where the element sets them.
 *
 * Nothing else is. Weight, style, colour, decoration, family and transform on a
 * word inside a paragraph are its emphasis (a bold phrase, a link, a stressed
 * word), and forcing the paragraph's value onto them deleted that emphasis on
 * tablets and phones only (14 Oct 2026, reversed 15 Oct). And a container never
 * pushes anything: a section's font size reaching its heading with `!important`
 * flattened the page's hierarchy and could beat the heading's own setting.
 */
export const TEXT_METRICS = ["font-size", "line-height", "letter-spacing", "word-spacing"] as const;

/** Phrasing content: what a run of words is made of. */
const PHRASING = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em", "font", "i", "img", "ins", "kbd", "mark",
  "nobr", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "svg", "time", "u", "var", "wbr",
]);

/**
 * Whether an element is a run of words with something inside it to reach:
 * it has child elements, and every one of them is phrasing content. A heading
 * with a span is; a section holding a heading and a paragraph is not.
 */
export function isTextElement(childTags: readonly string[]): boolean {
  return childTags.length > 0 && childTags.every((tag) => PHRASING.has(tag.toLowerCase()));
}

/** Tags that hold words, for source blocks whose children are not read (framework pages). */
export const TEXT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "button", "li", "label", "blockquote", "figcaption", "td", "th", "dt", "dd", "span", "small", "strong", "em", "b", "i", "caption", "legend", "summary", "q", "cite"]);

const declares = (style: string | undefined, property: string) =>
  (style ?? "").split(";").some((declaration) => declaration.slice(0, declaration.indexOf(":")).trim().toLowerCase() === property);

/**
 * Words inside inherit the metric. Specificity (0,1,0): enough with
 * `!important` to beat a class on the span, never enough to beat a field's own
 * rule (0,3,0). A word with its own inline value for it, a superscript or a
 * subscript keeps its own.
 */
const reachRule = (attribute: string, token: string, property: string) =>
  `:where([${attribute}="${token}"]) :not(sub, sup, [style*="${property}"]){${property}: inherit !important;}`;

/** All tablet rules precede all phone rules, so phones inherit tablet values. */
export function responsiveStyleCss(entries: ResponsiveStyleEntry[], attribute: "data-dw-style" | "data-dw-field" = "data-dw-style"): string {
  if (attribute !== "data-dw-style" && attribute !== "data-dw-field") return "";
  const identifier = attribute === "data-dw-style" ? RESPONSIVE_TOKEN : /^[a-zA-Z0-9_.:-]{1,200}$/;
  const clean = entries.filter((entry) => identifier.test(entry.token)).map((entry) => ({ ...entry, responsive: normalizeResponsive(entry.responsive) }));
  // A metric reaches the words from the widest screen that sets it: set on
  // Desktop it applies everywhere, set on Tablet from 1024px down.
  const reach = { all: [] as string[], tablet: [] as string[], mobile: [] as string[] };
  for (const { token, responsive, base, text } of clean) {
    if (!text) continue;
    for (const property of TEXT_METRICS) {
      const from = declares(base, property) ? "all" : declares(responsive.tablet, property) ? "tablet" : declares(responsive.mobile, property) ? "mobile" : null;
      if (from) reach[from].push(reachRule(attribute, token, property));
    }
  }
  const media = (["tablet", "mobile"] as const).map((device) => {
    const rules = clean.flatMap(({ token, responsive }) => {
      const style = responsive[device];
      if (!style) return [];
      const selector = `[${attribute}="${token}"]`.repeat(3);
      const declarations = style.split(";").map((s) => s.trim()).filter(Boolean).map((d) => `${d.replace(/\s*!\s*important\s*$/i, "")} !important`);
      return [`${selector}{${declarations.join("; ")};}`];
    }).concat(reach[device]);
    return rules.length ? `@media (max-width: ${RESPONSIVE_BREAKPOINTS[device]}px){\n${rules.join("\n")}\n}` : "";
  });
  return [reach.all.join("\n"), ...media].filter(Boolean).join("\n");
}

export function renderResponsiveCss(token: string, responsive: ResponsiveStyles): string {
  return responsiveStyleCss([{ token, responsive }]);
}
