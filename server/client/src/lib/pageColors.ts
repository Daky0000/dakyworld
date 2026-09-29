/**
 * Client-side color extractor for imported HTML documents and editor fields.
 * Extracts, normalises, and ranks all colours directly in the browser.
 */

const HEX_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const RGB_COLOR = /\brgba?\(\s*(\d{1,3}%?)\s*,\s*(\d{1,3}%?)\s*,\s*(\d{1,3}%?)(?:\s*[,/]\s*([\d.]+))?\s*\)/gi;
const HSL_COLOR = /\bhsla?\(\s*(\d{1,3}(?:deg)?)\s*,\s*(\d{1,3}%)\s*,\s*(\d{1,3}%)(?:\s*[,/]\s*([\d.]+))?\s*\)/gi;
const CSS_VARIABLE_DECL = /(--[-\w]+)\s*:\s*([^;}{]+)/g;
const STYLE_ATTR = /\bstyle\s*=\s*["']([^"']+)["']/gi;
const STYLE_TAG = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const SVG_FILL_STROKE = /\b(fill|stroke|bgcolor|color)\s*=\s*["']([^"']+)["']/gi;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function parseChannel(raw: string, maxVal = 255): number {
  const trimmed = raw.trim();
  if (trimmed.endsWith("%")) {
    return Math.round((parseFloat(trimmed) / 100) * maxVal);
  }
  return Math.round(parseFloat(trimmed));
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 0, 100) / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r1 = 0, g1 = 0, b1 = 0;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];

  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

export function normaliseToHex6(raw: string): string | null {
  const text = raw.trim();
  if (!text || text === "transparent" || text === "inherit" || text === "initial" || text === "currentColor") {
    return null;
  }

  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (hex.length === 3) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toUpperCase();
    }
    if (hex.length === 4) {
      const alpha = parseInt(hex[3]! + hex[3]!, 16) / 255;
      if (alpha < 0.05) return null;
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toUpperCase();
    }
    if (hex.length === 6) {
      return `#${hex.toUpperCase()}`;
    }
    if (hex.length === 8) {
      const alpha = parseInt(hex.slice(6, 8), 16) / 255;
      if (alpha < 0.05) return null;
      return `#${hex.slice(0, 6).toUpperCase()}`;
    }
    return null;
  }

  if (/^rgba?\(/i.test(text)) {
    const match = /^rgba?\(\s*(\d{1,3}%?)\s*,\s*(\d{1,3}%?)\s*,\s*(\d{1,3}%?)(?:\s*[,/]\s*([\d.]+))?\s*\)/i.exec(text);
    if (!match) return null;
    const r = parseChannel(match[1]!, 255);
    const g = parseChannel(match[2]!, 255);
    const b = parseChannel(match[3]!, 255);
    const a = match[4] !== undefined ? parseFloat(match[4]) : 1;
    if (a < 0.05) return null;
    return rgbToHex(r, g, b);
  }

  if (/^hsla?\(/i.test(text)) {
    const match = /^hsla?\(\s*(\d{1,3}(?:deg)?)\s*,\s*(\d{1,3}%)\s*,\s*(\d{1,3}%)(?:\s*[,/]\s*([\d.]+))?\s*\)/i.exec(text);
    if (!match) return null;
    const h = parseFloat(match[1]!.replace("deg", ""));
    const s = parseFloat(match[2]!.replace("%", ""));
    const l = parseFloat(match[3]!.replace("%", ""));
    const a = match[4] !== undefined ? parseFloat(match[4]) : 1;
    if (a < 0.05) return null;
    const [r, g, b] = hslToRgb(h, s, l);
    return rgbToHex(r, g, b);
  }

  const NAMED: Record<string, string> = {
    black: "#000000",
    white: "#FFFFFF",
    red: "#FF0000",
    blue: "#0000FF",
    green: "#008000",
    yellow: "#FFFF00",
    purple: "#800080",
    gray: "#808080",
    grey: "#808080",
    navy: "#000080",
    teal: "#008080",
    orange: "#FFA500",
  };
  const lower = text.toLowerCase();
  if (NAMED[lower]) return NAMED[lower];

  return null;
}

function isChromatic(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  if (max === 0) return false;
  const saturation = delta / max;
  const brightness = max / 255;

  return saturation > 0.12 && brightness > 0.08 && (saturation > 0.18 || brightness < 0.95);
}

/**
 * Extracts and returns up to `maxColors` (default 16) hex colours found in `html`
 * and optional editor fields.
 */
export function extractColorsFromMarkup(
  html: string,
  fields?: Array<{ style?: string; value?: string }>,
  options: { maxColors?: number } = {},
): string[] {
  const maxColors = options.maxColors ?? 16;
  const counts = new Map<string, number>();

  const record = (raw: string, weight = 1) => {
    const hex = normaliseToHex6(raw);
    if (!hex) return;
    counts.set(hex, (counts.get(hex) ?? 0) + weight);
  };

  if (html && typeof html === "string") {
    // 1. CSS Custom Properties
    const tokens = new Map<string, string>();
    let varMatch: RegExpExecArray | null;
    CSS_VARIABLE_DECL.lastIndex = 0;
    while ((varMatch = CSS_VARIABLE_DECL.exec(html))) {
      const varName = varMatch[1]!.trim();
      const varValue = varMatch[2]!.trim();
      tokens.set(varName, varValue);
      const hex = normaliseToHex6(varValue);
      if (hex) record(hex, 3);
    }

    // 2. <style> blocks
    STYLE_TAG.lastIndex = 0;
    let styleMatch: RegExpExecArray | null;
    while ((styleMatch = STYLE_TAG.exec(html))) {
      let css = styleMatch[1] ?? "";
      css = css.replace(/var\(\s*(--[-\w]+)\s*(?:,[^)]*)?\)/g, (_, name) => tokens.get(name) ?? "");

      HEX_COLOR.lastIndex = 0;
      for (const h of css.match(HEX_COLOR) ?? []) record(h, 2);

      RGB_COLOR.lastIndex = 0;
      for (const rgb of css.match(RGB_COLOR) ?? []) record(rgb, 2);

      HSL_COLOR.lastIndex = 0;
      for (const hsl of css.match(HSL_COLOR) ?? []) record(hsl, 2);
    }

    // 3. Inline style attributes
    STYLE_ATTR.lastIndex = 0;
    let inlineMatch: RegExpExecArray | null;
    while ((inlineMatch = STYLE_ATTR.exec(html))) {
      let inline = inlineMatch[1] ?? "";
      inline = inline.replace(/var\(\s*(--[-\w]+)\s*(?:,[^)]*)?\)/g, (_, name) => tokens.get(name) ?? "");

      HEX_COLOR.lastIndex = 0;
      for (const h of inline.match(HEX_COLOR) ?? []) record(h, 3);

      RGB_COLOR.lastIndex = 0;
      for (const rgb of inline.match(RGB_COLOR) ?? []) record(rgb, 3);

      HSL_COLOR.lastIndex = 0;
      for (const hsl of inline.match(HSL_COLOR) ?? []) record(hsl, 3);
    }

    // 4. SVG fill/stroke & HTML bgcolor/color
    SVG_FILL_STROKE.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = SVG_FILL_STROKE.exec(html))) {
      const val = attrMatch[2]?.trim();
      if (val) record(val, 2);
    }

    // 5. Standalone hex fallback
    HEX_COLOR.lastIndex = 0;
    for (const h of html.match(HEX_COLOR) ?? []) {
      record(h, 1);
    }
  }

  // 6. Inspect fields from discoverFields (fields have .style and .value)
  if (fields && Array.isArray(fields)) {
    for (const field of fields) {
      if (field.style) {
        HEX_COLOR.lastIndex = 0;
        for (const h of field.style.match(HEX_COLOR) ?? []) record(h, 3);

        RGB_COLOR.lastIndex = 0;
        for (const rgb of field.style.match(RGB_COLOR) ?? []) record(rgb, 3);

        HSL_COLOR.lastIndex = 0;
        for (const hsl of field.style.match(HSL_COLOR) ?? []) record(hsl, 3);
      }
    }
  }

  if (counts.size === 0) return [];

  const chromatics: Array<{ hex: string; count: number }> = [];
  const neutrals: Array<{ hex: string; count: number }> = [];

  for (const [hex, count] of counts.entries()) {
    if (isChromatic(hex)) {
      chromatics.push({ hex, count });
    } else {
      neutrals.push({ hex, count });
    }
  }

  chromatics.sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
  neutrals.sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));

  const result: string[] = [];
  for (const item of chromatics) {
    if (result.length < maxColors) result.push(item.hex);
  }
  for (const item of neutrals) {
    if (result.length < maxColors && !result.includes(item.hex)) result.push(item.hex);
  }

  return result.slice(0, maxColors);
}
