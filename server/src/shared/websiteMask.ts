/**
 * Masks: a shape cut out of an element, and an edge that fades away.
 *
 * Shared by the Style tab, which draws the presets and reads a value back as
 * one of them, and by the checks, which hold every value written here to the
 * server's own sanitisers. Two CSS properties, and nothing else:
 *
 *  - **Shape** is `clip-path` with a basic shape — `circle()`, `ellipse()` or
 *    `polygon()` in percentages. It scales with the element, needs no file,
 *    and is in the language a tablet or phone rule may carry, so a photograph
 *    can be a circle on desktop and a square on a phone.
 *  - **Fade** is `mask-image` with a gradient: black where the element shows,
 *    transparent where it is gone. It is how a hero picture melts into the
 *    section below it, or a long list fades out at the bottom.
 *
 * **A picture used as a mask is deliberately not offered.** `mask-image:
 * url(…)` fetches in CORS mode, and the media library's files are served from
 * cloud storage on another origin that sends no CORS headers — and a hosted
 * site answers an R2-backed picture with a redirect to that origin. The mask
 * would load on nobody's screen and say nothing about why: the element would
 * simply vanish. A gradient and a basic shape fetch nothing, so they cannot
 * fail that way. `safeStyle` refuses a `url()` here anyway.
 *
 * Both properties are written unprefixed. Every browser in use reads them —
 * Safari since 15.4, Chromium since 120, Firefox long before — and a
 * `-webkit-` property cannot be written at tablet or phone width at all, so a
 * prefixed copy would make a mask that changes by screen size impossible.
 *
 * Reading follows the panel's rule for list values: a value is recognised only
 * when it is exactly what a preset writes, and anything else is reported as
 * unreadable so the panel shows it as written with a Clear, never as the
 * nearest preset. A developer's own `polygon()` rewritten as a star is a
 * different design.
 */

export type MaskShape = { id: string; label: string; clip: string };

/** The shapes, in the order the panel draws them. Percentages, so each scales with its element. */
export const MASK_SHAPES: readonly MaskShape[] = [
  { id: "circle", label: "Circle", clip: "circle(50% at 50% 50%)" },
  { id: "oval", label: "Oval", clip: "ellipse(50% 50% at 50% 50%)" },
  { id: "triangle", label: "Triangle", clip: "polygon(50% 0%, 100% 100%, 0% 100%)" },
  { id: "diamond", label: "Diamond", clip: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)" },
  { id: "pentagon", label: "Pentagon", clip: "polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)" },
  { id: "hexagon", label: "Hexagon", clip: "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)" },
  { id: "octagon", label: "Octagon", clip: "polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)" },
  { id: "star", label: "Star", clip: "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)" },
  { id: "arrow", label: "Arrow", clip: "polygon(0% 20%, 60% 20%, 60% 0%, 100% 50%, 60% 100%, 60% 80%, 0% 80%)" },
  { id: "chevron", label: "Chevron", clip: "polygon(75% 0%, 100% 50%, 75% 100%, 0% 100%, 25% 50%, 0% 0%)" },
  { id: "slanted", label: "Slanted", clip: "polygon(25% 0%, 100% 0%, 75% 100%, 0% 100%)" },
  { id: "angled-bottom", label: "Angled bottom", clip: "polygon(0% 0%, 100% 0%, 100% 85%, 0% 100%)" },
  { id: "angled-top", label: "Angled top", clip: "polygon(0% 15%, 100% 0%, 100% 100%, 0% 100%)" },
  { id: "speech", label: "Speech bubble", clip: "polygon(0% 0%, 100% 0%, 100% 75%, 75% 75%, 75% 100%, 50% 75%, 0% 75%)" },
];

/** Whitespace and case, so `polygon(50% 0%,100% 100%, 0% 100%)` reads as the triangle it is. */
function normal(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").trim();
}

/**
 * Which preset a `clip-path` is: its id, `""` when there is none, or `null`
 * when there is one this panel did not write and cannot express.
 */
export function readMaskShape(value: string | undefined): string | null {
  const clean = normal(value ?? "");
  if (!clean || clean === "none") return "";
  return MASK_SHAPES.find((shape) => normal(shape.clip) === clean)?.id ?? null;
}

export function maskShapeClip(id: string): string | null {
  return MASK_SHAPES.find((shape) => shape.id === id)?.clip ?? null;
}

/** Which edge fades: one side, both sides of an axis, or all of it from the middle out. */
export type FadeEdge = "bottom" | "top" | "left" | "right" | "vertical" | "horizontal" | "vignette";

export const FADE_EDGES: readonly { id: FadeEdge; label: string }[] = [
  { id: "bottom", label: "Bottom" },
  { id: "top", label: "Top" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "vertical", label: "Top and bottom" },
  { id: "horizontal", label: "Both sides" },
  { id: "vignette", label: "Vignette" },
];

/** How much of the element the fade takes up, in percent. Outside this a fade is either nothing or everything. */
export const FADE_MIN = 5;
export const FADE_MAX = 90;
export const FADE_DEFAULT = 35;

const clampFade = (length: number) => Math.round(Math.min(FADE_MAX, Math.max(FADE_MIN, Number.isFinite(length) ? length : FADE_DEFAULT)));

/**
 * The `mask-image` for a fade. `length` is the part of the element, in
 * percent, that goes from showing to gone — the rest is fully visible. On an
 * axis that fades at both ends, each end takes half.
 */
export function writeFade(edge: FadeEdge, length: number): string {
  const fade = clampFade(length);
  const solid = 100 - fade;
  const half = Math.round(fade / 2);
  switch (edge) {
    case "bottom":
    case "top":
    case "left":
    case "right":
      return `linear-gradient(to ${edge}, black ${solid}%, transparent 100%)`;
    case "vertical":
      return `linear-gradient(to bottom, transparent 0%, black ${half}%, black ${100 - half}%, transparent 100%)`;
    case "horizontal":
      return `linear-gradient(to right, transparent 0%, black ${half}%, black ${100 - half}%, transparent 100%)`;
    case "vignette":
      return `radial-gradient(closest-side, black ${solid}%, transparent 100%)`;
  }
}

/**
 * A `mask-image` read back as a fade: the edge and its length, `""` for no
 * mask, or `null` for a mask this panel did not write.
 */
export function readFade(value: string | undefined): { edge: FadeEdge; length: number } | "" | null {
  const clean = normal(value ?? "");
  if (!clean || clean === "none") return "";
  const side = /^linear-gradient\(to (bottom|top|left|right),black (\d{1,3})%,transparent 100%\)$/.exec(clean);
  if (side) return verified(side[1] as FadeEdge, 100 - Number(side[2]), clean);
  const axis = /^linear-gradient\(to (bottom|right),transparent 0%,black (\d{1,3})%,black (\d{1,3})%,transparent 100%\)$/.exec(clean);
  if (axis) return verified(axis[1] === "bottom" ? "vertical" : "horizontal", Number(axis[2]) * 2, clean);
  const vignette = /^radial-gradient\(closest-side,black (\d{1,3})%,transparent 100%\)$/.exec(clean);
  if (vignette) return verified("vignette", 100 - Number(vignette[1]), clean);
  return null;
}

/** Recognised only when writing it back gives the same value: `black 2%` is not a fade this panel makes. */
function verified(edge: FadeEdge, length: number, clean: string): { edge: FadeEdge; length: number } | null {
  return normal(writeFade(edge, length)) === clean ? { edge, length: clampFade(length) } : null;
}
