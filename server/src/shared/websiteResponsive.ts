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

export type ResponsiveStyleEntry = { token: string; responsive: ResponsiveStyles };

/** All tablet rules precede all phone rules, so phones inherit tablet values. */
export function responsiveStyleCss(entries: ResponsiveStyleEntry[], attribute: "data-dw-style" | "data-dw-field" = "data-dw-style"): string {
  if (attribute !== "data-dw-style" && attribute !== "data-dw-field") return "";
  const identifier = attribute === "data-dw-style" ? RESPONSIVE_TOKEN : /^[a-zA-Z][a-zA-Z0-9_.:-]{0,199}$/;
  const clean = entries.filter((entry) => identifier.test(entry.token)).map((entry) => ({ ...entry, responsive: normalizeResponsive(entry.responsive) }));
  return (["tablet", "mobile"] as const).map((device) => {
    const rules = clean.flatMap(({ token, responsive }) => {
      const style = responsive[device];
      if (!style) return [];
      const selector = `[${attribute}="${token}"]`.repeat(3);
      const declarations = style.split("; ").map((declaration) => `${declaration} !important`).join("; ");
      return [`${selector}{${declarations};}`];
    });
    return rules.length ? `@media (max-width: ${RESPONSIVE_BREAKPOINTS[device]}px){\n${rules.join("\n")}\n}` : "";
  }).filter(Boolean).join("\n");
}

export function renderResponsiveCss(token: string, responsive: ResponsiveStyles): string {
  return responsiveStyleCss([{ token, responsive }]);
}
