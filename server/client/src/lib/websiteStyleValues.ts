/**
 * The list-valued CSS the Style tab edits as rows rather than as text: shadows,
 * transforms, filters, transitions, background layers and gradients.
 *
 * Each reader returns `null` for a value it cannot take apart, and the panel
 * then shows that value as it is rather than a list that would quietly drop
 * part of it — a developer's `transform: matrix(…)` is theirs, and rewriting it
 * as the nearest thing these rows can express would change their design.
 *
 * Pure, so `checks/websiteStyleValues.ts` holds the round trips.
 */

import { safeResponsiveStyle } from "../../../src/shared/websiteResponsive.js";

/** Splits on a separator that is not inside parentheses or quotes. */
export function splitTop(value: string, separator: "," | " " = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (separator === "," ? char === "," : /\s/.test(char))) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const LENGTH = /^(-?\d*\.?\d+)(px)?$/;
const lengthOf = (token: string): number | null => {
  if (token === "0") return 0;
  const match = LENGTH.exec(token);
  return match ? Number(match[1]) : null;
};
const round = (value: number) => Math.round(value * 100) / 100;

/* -------------------------------------------------------------- shadows */

export type Shadow = { inset: boolean; x: number; y: number; blur: number; spread: number; color: string };

export function readShadows(value: string | undefined): Shadow[] | null {
  const css = (value ?? "").trim();
  if (!css || css === "none") return [];
  const shadows: Shadow[] = [];
  for (const layer of splitTop(css)) {
    const tokens = splitTop(layer, " ");
    const shadow: Shadow = { inset: false, x: 0, y: 0, blur: 0, spread: 0, color: "rgba(0,0,0,.5)" };
    const lengths: number[] = [];
    let colour = "";
    for (const token of tokens) {
      if (token === "inset") shadow.inset = true;
      else if (lengthOf(token) !== null) lengths.push(lengthOf(token)!);
      else if (!colour) colour = token;
      else return null;
    }
    if (lengths.length < 2 || lengths.length > 4) return null;
    [shadow.x, shadow.y, shadow.blur = 0, shadow.spread = 0] = lengths as [number, number, number?, number?];
    if (colour) shadow.color = colour;
    shadows.push(shadow);
  }
  return shadows;
}

export function writeShadows(shadows: Shadow[]): string {
  return shadows
    .map((shadow) => `${shadow.inset ? "inset " : ""}${round(shadow.x)}px ${round(shadow.y)}px ${round(shadow.blur)}px ${round(shadow.spread)}px ${shadow.color}`)
    .join(", ");
}

export function shadowSummary(shadow: Shadow): string {
  return `${shadow.inset ? "Inset" : "Outset"}: ${round(shadow.x)}px ${round(shadow.y)}px ${round(shadow.blur)}px ${round(shadow.spread)}px`;
}

/* ----------------------------------------------------------- transforms */

export type TransformItem =
  | { kind: "move"; x: number; y: number; z: number }
  | { kind: "scale"; x: number; y: number; z: number }
  | { kind: "rotate"; x: number; y: number; z: number }
  | { kind: "skew"; x: number; y: number };

const FUNCTION = /([a-zA-Z0-9]+)\(([^()]*)\)/g;
const degOf = (token: string): number | null => {
  const match = /^(-?\d*\.?\d+)(deg)?$/.exec(token.trim());
  return match ? Number(match[1]) : token.trim() === "0" ? 0 : null;
};

export function readTransforms(value: string | undefined): TransformItem[] | null {
  const css = (value ?? "").trim();
  if (!css || css === "none") return [];
  const items: TransformItem[] = [];
  let consumed = "";
  for (const match of css.matchAll(FUNCTION)) {
    consumed += match[0];
    const name = match[1]!.toLowerCase();
    const args = match[2]!.split(",").map((part) => part.trim()).filter(Boolean);
    const px = args.map((arg) => lengthOf(arg));
    const deg = args.map((arg) => degOf(arg));
    const num = args.map((arg) => (/^-?\d*\.?\d+$/.test(arg) ? Number(arg) : null));
    const all = (list: (number | null)[]) => list.every((entry) => entry !== null);
    switch (name) {
      case "translate":
        if (!all(px)) return null;
        items.push({ kind: "move", x: px[0]!, y: px[1] ?? 0, z: 0 });
        break;
      case "translate3d":
        if (!all(px) || px.length !== 3) return null;
        items.push({ kind: "move", x: px[0]!, y: px[1]!, z: px[2]! });
        break;
      case "translatex": case "translatey": case "translatez":
        if (!all(px)) return null;
        items.push({ kind: "move", x: name.endsWith("x") ? px[0]! : 0, y: name.endsWith("y") ? px[0]! : 0, z: name.endsWith("z") ? px[0]! : 0 });
        break;
      case "scale":
        if (!all(num)) return null;
        items.push({ kind: "scale", x: num[0]!, y: num[1] ?? num[0]!, z: 1 });
        break;
      case "scale3d":
        if (!all(num) || num.length !== 3) return null;
        items.push({ kind: "scale", x: num[0]!, y: num[1]!, z: num[2]! });
        break;
      case "scalex": case "scaley": case "scalez":
        if (!all(num)) return null;
        items.push({ kind: "scale", x: name.endsWith("x") ? num[0]! : 1, y: name.endsWith("y") ? num[0]! : 1, z: name.endsWith("z") ? num[0]! : 1 });
        break;
      case "rotate": case "rotatez":
        if (!all(deg)) return null;
        items.push({ kind: "rotate", x: 0, y: 0, z: deg[0]! });
        break;
      case "rotatex": case "rotatey":
        if (!all(deg)) return null;
        items.push({ kind: "rotate", x: name.endsWith("x") ? deg[0]! : 0, y: name.endsWith("y") ? deg[0]! : 0, z: 0 });
        break;
      case "skew":
        if (!all(deg)) return null;
        items.push({ kind: "skew", x: deg[0]!, y: deg[1] ?? 0 });
        break;
      case "skewx": case "skewy":
        if (!all(deg)) return null;
        items.push({ kind: "skew", x: name.endsWith("x") ? deg[0]! : 0, y: name.endsWith("y") ? deg[0]! : 0 });
        break;
      default:
        return null;
    }
  }
  // Anything left over — a matrix, a nested calc — is not something the rows can hold.
  if (consumed.replace(/\s+/g, "") !== css.replace(/\s+/g, "")) return null;
  return items;
}

export function writeTransforms(items: TransformItem[]): string {
  return items
    .map((item) => {
      switch (item.kind) {
        case "move":
          return item.z ? `translate3d(${round(item.x)}px, ${round(item.y)}px, ${round(item.z)}px)` : `translate(${round(item.x)}px, ${round(item.y)}px)`;
        case "scale":
          return item.z !== 1 ? `scale3d(${round(item.x)}, ${round(item.y)}, ${round(item.z)})` : `scale(${round(item.x)}, ${round(item.y)})`;
        case "rotate": {
          const parts = [item.x ? `rotateX(${round(item.x)}deg)` : "", item.y ? `rotateY(${round(item.y)}deg)` : "", item.z || (!item.x && !item.y) ? `rotate(${round(item.z)}deg)` : ""];
          return parts.filter(Boolean).join(" ");
        }
        case "skew":
          return `skew(${round(item.x)}deg, ${round(item.y)}deg)`;
      }
    })
    .join(" ");
}

export function transformSummary(item: TransformItem): string {
  switch (item.kind) {
    case "move": return `Move: ${round(item.x)}, ${round(item.y)}, ${round(item.z)} px`;
    case "scale": return `Scale: ${round(item.x)}, ${round(item.y)}${item.z !== 1 ? `, ${round(item.z)}` : ""}`;
    case "rotate": return `Rotate: ${round(item.x)}°, ${round(item.y)}°, ${round(item.z)}°`;
    case "skew": return `Skew: ${round(item.x)}°, ${round(item.y)}°`;
  }
}

/* -------------------------------------------------------------- filters */

export type FilterFn = "blur" | "brightness" | "contrast" | "grayscale" | "invert" | "saturate" | "sepia" | "hue-rotate" | "drop-shadow";
export type FilterItem =
  | { fn: Exclude<FilterFn, "drop-shadow">; value: number }
  | { fn: "drop-shadow"; x: number; y: number; blur: number; color: string };

export const FILTERS: { fn: FilterFn; label: string; unit: string; initial: number; min: number; max: number }[] = [
  { fn: "blur", label: "Blur", unit: "px", initial: 4, min: 0, max: 50 },
  { fn: "brightness", label: "Brightness", unit: "%", initial: 100, min: 0, max: 300 },
  { fn: "contrast", label: "Contrast", unit: "%", initial: 100, min: 0, max: 300 },
  { fn: "grayscale", label: "Grayscale", unit: "%", initial: 100, min: 0, max: 100 },
  { fn: "invert", label: "Invert", unit: "%", initial: 100, min: 0, max: 100 },
  { fn: "saturate", label: "Saturate", unit: "%", initial: 150, min: 0, max: 300 },
  { fn: "sepia", label: "Sepia", unit: "%", initial: 100, min: 0, max: 100 },
  { fn: "hue-rotate", label: "Hue rotate", unit: "deg", initial: 90, min: 0, max: 360 },
  { fn: "drop-shadow", label: "Drop shadow", unit: "px", initial: 0, min: 0, max: 0 },
];

export function readFilters(value: string | undefined): FilterItem[] | null {
  const css = (value ?? "").trim();
  if (!css || css === "none") return [];
  const items: FilterItem[] = [];
  let consumed = "";
  for (const match of css.matchAll(/([a-z-]+)\(((?:[^()]|\([^()]*\))*)\)/g)) {
    consumed += match[0];
    const fn = match[1] as FilterFn;
    const arg = match[2]!.trim();
    if (fn === "drop-shadow") {
      const tokens = splitTop(arg, " ");
      const lengths = tokens.map(lengthOf).filter((length): length is number => length !== null);
      const colour = tokens.find((token) => lengthOf(token) === null) ?? "rgba(0,0,0,.5)";
      if (lengths.length < 2) return null;
      items.push({ fn, x: lengths[0]!, y: lengths[1]!, blur: lengths[2] ?? 0, color: colour });
      continue;
    }
    const known = FILTERS.find((filter) => filter.fn === fn);
    if (!known) return null;
    const number = /^(-?\d*\.?\d+)(px|%|deg)?$/.exec(arg);
    if (!number) return null;
    // A bare number on a percentage filter is a fraction: `brightness(1.2)` is 120%.
    const raw = Number(number[1]);
    items.push({ fn, value: known.unit === "%" && !number[2] ? raw * 100 : raw } as FilterItem);
  }
  if (consumed.replace(/\s+/g, "") !== css.replace(/\s+/g, "")) return null;
  return items;
}

export function writeFilters(items: FilterItem[]): string {
  return items
    .map((item) => {
      if (item.fn === "drop-shadow") return `drop-shadow(${round(item.x)}px ${round(item.y)}px ${round(item.blur)}px ${item.color})`;
      const unit = FILTERS.find((filter) => filter.fn === item.fn)!.unit;
      return `${item.fn}(${round(item.value)}${unit})`;
    })
    .join(" ");
}

export function filterSummary(item: FilterItem): string {
  const known = FILTERS.find((filter) => filter.fn === item.fn)!;
  if (item.fn === "drop-shadow") return `${known.label}: ${round(item.x)}px ${round(item.y)}px ${round(item.blur)}px`;
  return `${known.label}: ${round(item.value)}${known.unit === "deg" ? "°" : known.unit}`;
}

/* ---------------------------------------------------------- transitions */

export type TransitionItem = { property: string; duration: number; rest: string };

export const TRANSITION_GROUPS: { label: string; properties: { value: string; label: string }[] }[] = [
  { label: "Default", properties: [{ value: "all", label: "All properties" }] },
  { label: "Margin", properties: ["margin", "margin-top", "margin-right", "margin-bottom", "margin-left"].map((value) => ({ value, label: value === "margin" ? "Margin (all)" : value.replace("margin-", "Margin ") })) },
  { label: "Padding", properties: ["padding", "padding-top", "padding-right", "padding-bottom", "padding-left"].map((value) => ({ value, label: value === "padding" ? "Padding (all)" : value.replace("padding-", "Padding ") })) },
  { label: "Flex", properties: [{ value: "flex", label: "Flex (all)" }, { value: "flex-grow", label: "Flex grow" }, { value: "flex-shrink", label: "Flex shrink" }, { value: "flex-basis", label: "Flex basis" }] },
  { label: "Size", properties: ["width", "height", "min-width", "min-height", "max-width", "max-height"].map((value) => ({ value, label: value.replace("-", " ").replace(/^./, (letter) => letter.toUpperCase()) })) },
  { label: "Position", properties: ["top", "left", "right", "bottom", "z-index"].map((value) => ({ value, label: value === "z-index" ? "Z-index" : value.replace(/^./, (letter) => letter.toUpperCase()) })) },
  { label: "Typography", properties: [{ value: "color", label: "Font color" }, { value: "font-size", label: "Font size" }, { value: "line-height", label: "Line height" }, { value: "letter-spacing", label: "Letter spacing" }, { value: "word-spacing", label: "Word spacing" }, { value: "font-variation-settings", label: "Font variations" }, { value: "-webkit-text-stroke-color", label: "Text stroke color" }] },
  { label: "Background", properties: [{ value: "background-color", label: "Background color" }, { value: "background-position", label: "Background position" }, { value: "background-size", label: "Background size" }] },
  { label: "Border", properties: [{ value: "border-color", label: "Border color" }, { value: "border-width", label: "Border width" }, { value: "border-radius", label: "Border radius" }] },
  { label: "Effects", properties: [{ value: "opacity", label: "Opacity" }, { value: "box-shadow", label: "Box shadow" }, { value: "filter", label: "Filter (all)" }, { value: "transform", label: "Transform (all)" }] },
];

export function readTransitions(value: string | undefined): TransitionItem[] | null {
  const css = (value ?? "").trim();
  if (!css || css === "none") return [];
  const items: TransitionItem[] = [];
  for (const layer of splitTop(css)) {
    const tokens = splitTop(layer, " ");
    let property = "all";
    let duration: number | null = null;
    const rest: string[] = [];
    tokens.forEach((token, index) => {
      const time = /^(-?\d*\.?\d+)(ms|s)$/.exec(token);
      if (time && duration === null) duration = Math.round(Number(time[1]) * (time[2] === "s" ? 1000 : 1));
      else if (index === 0 && /^[a-z-]+$/.test(token) && !/^(?:ease|linear|step-start|step-end|ease-in|ease-out|ease-in-out)$/.test(token)) property = token;
      else rest.push(token);
    });
    items.push({ property, duration: duration ?? 0, rest: rest.join(" ") });
  }
  return items;
}

export function writeTransitions(items: TransitionItem[]): string {
  return items.map((item) => `${item.property} ${Math.max(0, Math.round(item.duration))}ms${item.rest ? ` ${item.rest}` : ""}`).join(", ");
}

/* ------------------------------------------------------------ gradients */

export type GradientStop = { color: string; at: number };
export type Gradient = { type: "linear" | "radial"; angle: number; position: string; stops: GradientStop[] };

const SIDE_ANGLE: Record<string, number> = {
  "to top": 0, "to top right": 45, "to right top": 45, "to right": 90, "to bottom right": 135, "to right bottom": 135,
  "to bottom": 180, "to bottom left": 225, "to left bottom": 225, "to left": 270, "to top left": 315, "to left top": 315,
};

export function readGradient(css: string): Gradient | null {
  const match = /^(linear|radial)-gradient\((.*)\)$/i.exec(css.trim());
  if (!match) return null;
  const type = match[1]!.toLowerCase() as Gradient["type"];
  const args = splitTop(match[2]!);
  let angle = 180;
  let position = "center";
  if (args.length && type === "linear") {
    const first = args[0]!.trim().toLowerCase();
    const deg = /^(-?\d*\.?\d+)deg$/.exec(first);
    if (deg) { angle = Number(deg[1]); args.shift(); }
    else if (SIDE_ANGLE[first] !== undefined) { angle = SIDE_ANGLE[first]!; args.shift(); }
  } else if (args.length && type === "radial") {
    const first = args[0]!.trim().toLowerCase();
    if (/^(?:circle|ellipse|closest|farthest|at\s)/.test(first)) {
      position = /at\s+(.+)$/.exec(first)?.[1]?.trim() ?? "center";
      args.shift();
    }
  }
  if (args.length < 2) return null;
  const stops: GradientStop[] = [];
  for (const [index, arg] of args.entries()) {
    const tokens = splitTop(arg, " ");
    const at = tokens.length > 1 ? /^(-?\d*\.?\d+)%$/.exec(tokens[tokens.length - 1]!) : null;
    if (tokens.length > 2 || (tokens.length === 2 && !at)) return null;
    stops.push({ color: tokens[0]!, at: at ? Number(at[1]) : Math.round((index / (args.length - 1)) * 100) });
  }
  return { type, angle, position, stops };
}

export function writeGradient(gradient: Gradient): string {
  const stops = [...gradient.stops].sort((a, b) => a.at - b.at).map((stop) => `${stop.color} ${round(stop.at)}%`).join(", ");
  return gradient.type === "linear"
    ? `linear-gradient(${round(gradient.angle)}deg, ${stops})`
    : `radial-gradient(circle at ${gradient.position || "center"}, ${stops})`;
}

/* ----------------------------------------------------- background layers */

export type LayerBase = { position: string; size: string; repeat: string; attachment: string };
export type BackgroundLayer =
  | (LayerBase & { kind: "image"; url: string })
  | (LayerBase & { kind: "gradient"; gradient: Gradient })
  | (LayerBase & { kind: "color"; color: string });

const COLOUR_TOKEN = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([^()]*(?:\([^()]*\)[^()]*)*\)|[a-z]+)$/i;
const REPEATS = new Set(["repeat", "no-repeat", "repeat-x", "repeat-y", "space", "round"]);
const ATTACHMENTS = new Set(["scroll", "fixed", "local"]);
const BOXES = new Set(["border-box", "padding-box", "content-box", "text"]);

const urlOf = (image: string) => /^url\(\s*['"]?([^'")]*)['"]?\s*\)$/i.exec(image.trim())?.[1] ?? null;

function layerOf(image: string, base: LayerBase): BackgroundLayer | null {
  const url = urlOf(image);
  if (url !== null) return { ...base, kind: "image", url };
  const solid = /^linear-gradient\(\s*([^,()]+(?:\([^()]*\))?)\s*,\s*([^,()]+(?:\([^()]*\))?)\s*\)$/i.exec(image.trim());
  if (solid && solid[1]!.trim() === solid[2]!.trim() && !/deg|to\s/.test(solid[1]!)) return { ...base, kind: "color", color: solid[1]!.trim() };
  const gradient = readGradient(image);
  return gradient ? { ...base, kind: "gradient", gradient } : null;
}

/**
 * The layers an element's own style declares, top first, plus its base colour.
 * A `background` shorthand is taken apart into the same pieces, which is the
 * only way its layers can be edited one at a time; `null` means it could not be
 * and the shorthand must be left alone.
 */
export function readBackground(map: Record<string, string>): { layers: BackgroundLayer[]; color: string } | null {
  if (map.background !== undefined) return readShorthand(map.background);
  const images = map["background-image"] && map["background-image"] !== "none" ? splitTop(map["background-image"]) : [];
  const list = (property: string) => (map[property] ? splitTop(map[property]!) : []);
  const positions = list("background-position");
  const sizes = list("background-size");
  const repeats = list("background-repeat");
  const attachments = list("background-attachment");
  const layers: BackgroundLayer[] = [];
  for (const [index, image] of images.entries()) {
    const at = (values: string[], fallback: string) => values.length ? values[index % values.length]! : fallback;
    const layer = layerOf(image, { position: at(positions, ""), size: at(sizes, ""), repeat: at(repeats, ""), attachment: at(attachments, "") });
    if (!layer) return null;
    layers.push(layer);
  }
  return { layers, color: map["background-color"] ?? "" };
}

function readShorthand(css: string): { layers: BackgroundLayer[]; color: string } | null {
  const parts = splitTop(css);
  const layers: BackgroundLayer[] = [];
  let color = "";
  for (const [index, part] of parts.entries()) {
    const tokens = splitTop(part, " ");
    let image = "";
    const position: string[] = [];
    let size = "";
    let repeat = "";
    let attachment = "";
    let afterSlash = false;
    for (const token of tokens) {
      if (/^(?:url|linear-gradient|radial-gradient|conic-gradient|repeating-[a-z]+-gradient)\(/i.test(token)) image = token;
      else if (token === "/") afterSlash = true;
      else if (token.includes("/")) {
        const [before, after] = token.split("/");
        if (before) position.push(before);
        size = after ?? "";
        afterSlash = !after;
      } else if (REPEATS.has(token)) repeat = repeat ? `${repeat} ${token}` : token;
      else if (ATTACHMENTS.has(token)) attachment = token;
      else if (BOXES.has(token)) continue;
      else if (afterSlash) size = size ? `${size} ${token}` : token;
      else if (/^(?:-?\d*\.?\d+(?:px|%|em|rem|vw|vh)?|left|right|top|bottom|center)$/.test(token)) position.push(token);
      // Only something that is certainly a colour is read as one: a function
      // this does not know (element(), image-set(), a var() that could hold a
      // picture) makes the whole shorthand unreadable instead.
      else if (index === parts.length - 1 && !color && COLOUR_TOKEN.test(token)) color = token;
      else if (token !== "none") return null;
    }
    if (image) {
      const layer = layerOf(image, { position: position.join(" "), size, repeat, attachment });
      if (!layer) return null;
      layers.push(layer);
    }
  }
  return { layers, color };
}

/** The longhands that say what `layers` say, with `null` for whatever no longer applies. */
export function writeBackground(layers: BackgroundLayer[], color: string): Record<string, string | null> {
  const images = layers.map((layer) =>
    layer.kind === "image" ? `url('${layer.url.replace(/['"\\]/g, "")}')` : layer.kind === "color" ? `linear-gradient(${layer.color}, ${layer.color})` : writeGradient(layer.gradient),
  );
  const list = (pick: (layer: BackgroundLayer) => string, fallback: string) =>
    layers.some((layer) => pick(layer)) ? layers.map((layer) => pick(layer) || fallback).join(", ") : null;
  return {
    background: null,
    "background-image": images.length ? images.join(", ") : null,
    "background-position": list((layer) => layer.position, "0% 0%"),
    "background-size": list((layer) => layer.size, "auto"),
    "background-repeat": list((layer) => layer.repeat, "repeat"),
    "background-attachment": list((layer) => layer.attachment, "scroll"),
    "background-color": color || null,
  };
}

export function layerSummary(layer: BackgroundLayer): string {
  if (layer.kind === "image") return `Image: ${layer.url.split("/").pop() || layer.url}`;
  if (layer.kind === "color") return `Color: ${layer.color}`;
  return `${layer.gradient.type === "linear" ? "Linear" : "Radial"} gradient`;
}

/* ------------------------------------------------------------ shorthands */

const SIDES = ["top", "right", "bottom", "left"] as const;
const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;

/** The longhands a shorthand stands for, so a control can read and write one side. */
export const SHORTHANDS: Record<string, string[]> = {
  margin: SIDES.map((side) => `margin-${side}`),
  padding: SIDES.map((side) => `padding-${side}`),
  inset: SIDES.map((side) => side),
  "border-width": SIDES.map((side) => `border-${side}-width`),
  "border-radius": CORNERS.map((corner) => `border-${corner}-radius`),
  gap: ["row-gap", "column-gap"],
  flex: ["flex-grow", "flex-shrink", "flex-basis"],
};

function fourWay(value: string): string[] | null {
  if (/var\(|calc\(|\//i.test(value)) return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 4) return null;
  const [a, b = a, c = a, d = b] = parts as [string, string?, string?, string?];
  return [a, b!, c!, d!];
}

/** The declarations a shorthand writes, or null when it cannot be taken apart safely. */
export function expandShorthand(property: string, value: string): Record<string, string> | null {
  const longhands = SHORTHANDS[property];
  if (property === "gap") {
    const parts = value.trim().split(/\s+/);
    if (parts.length > 2 || /var\(|calc\(/.test(value)) return null;
    return { "row-gap": parts[0]!, "column-gap": parts[1] ?? parts[0]! };
  }
  if (property === "flex") {
    const v = value.trim();
    if (v === "none") return { "flex-grow": "0", "flex-shrink": "0", "flex-basis": "auto" };
    if (v === "auto") return { "flex-grow": "1", "flex-shrink": "1", "flex-basis": "auto" };
    const parts = v.split(/\s+/);
    if (/^\d*\.?\d+$/.test(parts[0] ?? "") && parts.length <= 3) {
      return { "flex-grow": parts[0]!, "flex-shrink": parts[1] && /^\d*\.?\d+$/.test(parts[1]) ? parts[1] : "1", "flex-basis": parts.find((part, index) => index > 0 && !/^\d*\.?\d+$/.test(part)) ?? (parts.length === 1 ? "0%" : "0%") };
    }
    return null;
  }
  if (!longhands) return null;
  const four = fourWay(value);
  return four ? Object.fromEntries(longhands.map((longhand, index) => [longhand, four[index]!])) : null;
}

/** `border: 1px solid #000` as the three properties the Border section shows. */
function expandBorder(value: string): Record<string, string> | null {
  const tokens = value.trim().split(/\s+(?![^(]*\))/);
  const out: Record<string, string> = {};
  for (const token of tokens) {
    if (/^-?\d*\.?\d+(px|em|rem)?$|^(thin|medium|thick)$/.test(token)) out["border-width"] = token;
    else if (/^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(token)) out["border-style"] = token;
    else out["border-color"] = token;
  }
  return out;
}

/** Shorthands read as longhands. Writing goes through `writeProperty`, which only expands what it touches. */
export function readable(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...raw };
  if (out.border !== undefined) {
    const parts = expandBorder(out.border);
    if (parts) for (const [property, value] of Object.entries(parts)) if (out[property] === undefined) out[property] = value;
  }
  for (const property of Object.keys(SHORTHANDS)) {
    if (out[property] === undefined) continue;
    const parts = expandShorthand(property, out[property]!);
    if (parts) for (const [longhand, value] of Object.entries(parts)) if (out[longhand] === undefined) out[longhand] = value;
  }
  return out;
}

const OWNER = Object.fromEntries(Object.entries(SHORTHANDS).flatMap(([shorthand, longhands]) => longhands.map((longhand) => [longhand, shorthand])));

/**
 * One declaration written into a style map. A shorthand that covers it is taken
 * apart first — and only then — so editing the colour never turns a developer's
 * `margin: 0 auto` into four lines.
 */
export function writeProperty(raw: Record<string, string>, property: string, value: string | null): Record<string, string> {
  const next = { ...raw };
  const shorthand = OWNER[property] ?? (["border-width", "border-style", "border-color"].includes(property) && next.border !== undefined ? "border" : undefined);
  if (shorthand && next[shorthand] !== undefined) {
    const parts = shorthand === "border" ? expandBorder(next.border!) : expandShorthand(shorthand, next[shorthand]!);
    delete next[shorthand];
    if (parts) for (const [longhand, part] of Object.entries(parts)) if (next[longhand] === undefined) next[longhand] = part;
  }
  if (property === "border-width" && next["border-top-width"] !== undefined) for (const side of SIDES) delete next[`border-${side}-width`];
  if (value === null || value.trim() === "") delete next[property];
  else next[property] = value.trim();
  return next;
}

/** Whether this screen size may carry the declaration: tablet and phone rules have a narrower language. */
export function allowedAt(device: "desktop" | "tablet" | "mobile", property: string, value = "1px"): boolean {
  return device === "desktop" || safeResponsiveStyle(`${property}: ${value}`) !== "";
}
