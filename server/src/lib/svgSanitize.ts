/**
 * SVG, rebuilt from an allowlist rather than checked against a denylist.
 *
 * An SVG is a document that can run script. The Website Builder serves an
 * uploaded file from the editor's own origin and publishes it into a
 * customer's site, so one that carried a script would run with either
 * origin's authority the first time somebody opened it directly. The upload
 * check in fileType.ts refuses the obvious spellings; this goes further and
 * never lets anything through that it did not recognise. Every element and
 * attribute is named below, and the output is written from the parsed tokens,
 * not copied from the input. So a construct the tokenizer did not understand
 * cannot survive into the file.
 *
 * What is dropped silently: comments, the XML declaration, `<style>` blocks,
 * metadata, and unknown elements with everything inside them. What is refused
 * outright: input that is not SVG, input the tokenizer cannot follow, and
 * anything left with no drawing in it.
 */

export class SvgRejected extends Error {}

const ELEMENTS = new Set([
  "svg", "g", "a", "switch", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect",
  "text", "tspan", "textpath", "title", "desc", "defs", "symbol", "use",
  "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "marker",
  "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "femerge",
  "femergenode", "feflood", "fecomposite", "femorphology", "fedropshadow", "image",
]);

/** Written with their SVG casing: the output is XML, and viewBox is not viewbox. */
const CASED: Record<string, string> = {
  lineargradient: "linearGradient", radialgradient: "radialGradient", clippath: "clipPath",
  textpath: "textPath", fegaussianblur: "feGaussianBlur", feoffset: "feOffset", feblend: "feBlend",
  fecolormatrix: "feColorMatrix", femerge: "feMerge", femergenode: "feMergeNode", feflood: "feFlood",
  fecomposite: "feComposite", femorphology: "feMorphology", fedropshadow: "feDropShadow",
  viewbox: "viewBox", preserveaspectratio: "preserveAspectRatio", gradientunits: "gradientUnits",
  gradienttransform: "gradientTransform", patternunits: "patternUnits", patterncontentunits: "patternContentUnits",
  patterntransform: "patternTransform", clippathunits: "clipPathUnits", maskunits: "maskUnits",
  maskcontentunits: "maskContentUnits", markerwidth: "markerWidth", markerheight: "markerHeight",
  markerunits: "markerUnits", refx: "refX", refy: "refY", stddeviation: "stdDeviation",
  filterunits: "filterUnits", primitiveunits: "primitiveUnits", textlength: "textLength",
  lengthadjust: "lengthAdjust", startoffset: "startOffset",
};

const ATTRIBUTES = new Set([
  "xmlns", "xmlns:xlink", "version", "id", "class", "viewbox", "preserveaspectratio",
  "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "d", "points", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
  "stroke-dashoffset", "stroke-opacity", "opacity", "color", "clip-path", "clip-rule",
  "mask", "filter", "display", "visibility", "overflow", "vector-effect", "shape-rendering",
  "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "fx", "fy", "fr",
  "spreadmethod", "patternunits", "patterncontentunits", "patterntransform", "clippathunits",
  "maskunits", "maskcontentunits", "markerwidth", "markerheight", "markerunits", "orient",
  "refx", "refy", "marker-start", "marker-mid", "marker-end", "stddeviation", "in", "in2",
  "result", "mode", "type", "values", "operator", "k1", "k2", "k3", "k4", "radius",
  "flood-color", "flood-opacity", "dx", "dy", "filterunits", "primitiveunits",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor",
  "dominant-baseline", "alignment-baseline", "letter-spacing", "textlength", "lengthadjust",
  "startoffset", "href", "xlink:href", "role", "aria-hidden", "aria-label", "focusable",
  "xml:space", "style",
]);

/** Elements whose whole subtree goes, not just the tag. */
const DROP_WITH_CONTENT = new Set(["script", "style", "foreignobject", "metadata", "iframe", "object", "embed", "handler", "listener", "set", "animate", "animatetransform", "animatemotion"]);

/** Only rasters, inline, for `<image>`. An SVG pulling in another SVG is the same problem again. */
const SAFE_IMAGE_DATA = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

const MAX_BYTES = 2_000_000;

function decodeRefs(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Math.min(Number(dec), 0x10ffff)))
    .replace(/&(quot|apos|amp|lt|gt|colon|tab|newline);/gi, (whole, name: string) => (
      ({ quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", colon: ":", tab: "\t", newline: "\n" } as Record<string, string>)[name.toLowerCase()] ?? whole
    ));
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A value is judged by what it means once decoded, not by how it is spelled. */
function safeValue(name: string, element: string, raw: string): string | null {
  const value = decodeRefs(raw).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const compact = value.replace(/\s+/g, "").toLowerCase();
  if (/javascript:|vbscript:|data:text|expression\(|@import|-moz-binding|behavior:/.test(compact)) return null;
  if (name === "href" || name === "xlink:href") {
    if (value.startsWith("#") && /^#[A-Za-z_][\w.:-]*$/.test(value)) return value;
    if (element === "image" && SAFE_IMAGE_DATA.test(value)) return value.replace(/\s+/g, "");
    return null;
  }
  // `url(#gradient)` is how fills and clips point inside the file. A url() to
  // anywhere else is a request made by whoever opens the image.
  for (const match of compact.matchAll(/url\(([^)]*)\)/g)) {
    if (!/^['"]?#[\w.:-]+['"]?$/.test(match[1] ?? "")) return null;
  }
  if (name === "style" && /[<>\\]/.test(value)) return null;
  return value;
}

type Token =
  | { type: "open"; name: string; attrs: Array<[string, string]>; selfClosing: boolean }
  | { type: "close"; name: string }
  | { type: "text"; text: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) { tokens.push({ type: "text", text: input.slice(i) }); break; }
    if (lt > i) tokens.push({ type: "text", text: input.slice(i, lt) });
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      if (end === -1) throw new SvgRejected("The SVG has a comment that never ends.");
      i = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt);
      if (end === -1) throw new SvgRejected("The SVG has a CDATA section that never ends.");
      tokens.push({ type: "text", text: input.slice(lt + 9, end) });
      i = end + 3;
      continue;
    }
    if (input[lt + 1] === "?" || input[lt + 1] === "!") {
      // The XML declaration and a DOCTYPE. A DOCTYPE can declare entities, and
      // nothing an icon needs lives in one, so both are dropped whole.
      const end = input.indexOf(">", lt);
      if (end === -1) throw new SvgRejected("The SVG has a declaration that never ends.");
      if (input[lt + 1] === "!" && input.slice(lt, end).includes("[")) {
        const close = input.indexOf("]>", lt);
        if (close === -1) throw new SvgRejected("The SVG declares entities it never closes.");
        i = close + 2;
        continue;
      }
      i = end + 1;
      continue;
    }
    const close = input[lt + 1] === "/";
    const nameMatch = /^[A-Za-z][\w:.-]*/.exec(input.slice(lt + (close ? 2 : 1)));
    if (!nameMatch) { tokens.push({ type: "text", text: "<" }); i = lt + 1; continue; }
    const name = nameMatch[0].toLowerCase();
    let j = lt + (close ? 2 : 1) + nameMatch[0].length;
    const attrs: Array<[string, string]> = [];
    let selfClosing = false;
    for (;;) {
      while (j < input.length && /\s/.test(input[j]!)) j += 1;
      if (j >= input.length) throw new SvgRejected("The SVG has a tag that never closes.");
      if (input[j] === ">") { j += 1; break; }
      if (input.startsWith("/>", j)) { selfClosing = true; j += 2; break; }
      const attr = /^([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/.exec(input.slice(j));
      if (!attr) throw new SvgRejected("The SVG has an attribute this editor cannot read.");
      attrs.push([attr[1]!.toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? ""]);
      j += attr[0].length;
    }
    tokens.push(close ? { type: "close", name } : { type: "open", name, attrs, selfClosing });
    i = j;
  }
  return tokens;
}

/**
 * The same SVG, holding only what is on the lists above.
 *
 * Throws `SvgRejected` with a sentence a customer can act on.
 */
export function sanitizeSvg(input: string): string {
  if (input.length > MAX_BYTES) throw new SvgRejected("That SVG is larger than 2 MB. Simplify it or export a PNG.");
  const tokens = tokenize(input.replace(/^﻿/, ""));
  const out: string[] = [];
  const stack: string[] = [];
  /** Depth inside something being dropped whole; nothing is written while it is above zero. */
  let dropping = 0;
  let sawRoot = false;
  let drawn = 0;

  for (const token of tokens) {
    if (token.type === "text") {
      if (dropping || !stack.length) continue;
      const parent = stack[stack.length - 1]!;
      // Words only where SVG shows words. Whitespace elsewhere is formatting.
      if (["text", "tspan", "textpath", "title", "desc"].includes(parent)) out.push(escapeText(decodeRefs(token.text)));
      continue;
    }
    if (token.type === "open") {
      if (dropping) { if (!token.selfClosing) dropping += 1; continue; }
      if (!sawRoot && token.name !== "svg") throw new SvgRejected("That file is not an SVG image.");
      if (token.name === "svg" && !stack.length) {
        if (sawRoot) throw new SvgRejected("That file holds more than one SVG image.");
        sawRoot = true;
      }
      if (!ELEMENTS.has(token.name) || DROP_WITH_CONTENT.has(token.name)) {
        // Unknown or dangerous: the element and everything inside it go.
        if (!token.selfClosing) dropping = 1;
        continue;
      }
      const attrs: string[] = [];
      for (const [name, raw] of token.attrs) {
        if (name.startsWith("on") || !ATTRIBUTES.has(name)) continue;
        const value = safeValue(name, token.name, raw);
        if (value === null) continue;
        attrs.push(` ${CASED[name] ?? name}="${escapeAttr(value)}"`);
      }
      if (token.name === "svg" && stack.length === 0 && !token.attrs.some(([name]) => name === "xmlns")) {
        attrs.unshift(' xmlns="http://www.w3.org/2000/svg"');
      }
      if (token.name === "image" && !token.attrs.some(([name, raw]) => (name === "href" || name === "xlink:href") && safeValue(name, "image", raw) !== null)) {
        // An <image> with no permitted source draws nothing and only invites a request.
        if (!token.selfClosing) dropping = 1;
        continue;
      }
      if (!["svg", "g", "defs", "title", "desc", "symbol", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "marker", "filter"].includes(token.name) && !token.name.startsWith("fe")) drawn += 1;
      const tag = CASED[token.name] ?? token.name;
      if (token.selfClosing) out.push(`<${tag}${attrs.join("")}/>`);
      else { out.push(`<${tag}${attrs.join("")}>`); stack.push(token.name); }
      continue;
    }
    // close
    if (dropping) { dropping -= 1; continue; }
    if (!stack.length) continue;
    const at = stack.lastIndexOf(token.name);
    if (at === -1) continue;
    while (stack.length > at) {
      const name = stack.pop()!;
      out.push(`</${CASED[name] ?? name}>`);
    }
  }
  if (!sawRoot) throw new SvgRejected("That file is not an SVG image.");
  while (stack.length) {
    const name = stack.pop()!;
    out.push(`</${CASED[name] ?? name}>`);
  }
  if (drawn === 0) throw new SvgRejected("That SVG has nothing left to draw once unsafe parts are removed.");
  return out.join("");
}

/**
 * The headers an SVG is served with from the editor's own origin.
 *
 * Belt and braces: the file has already been rebuilt by `sanitizeSvg`, but a
 * sandboxed, script-less policy means that even a construct nobody foresaw
 * could not run if somebody opened the image directly in a tab.
 */
export const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

/** True when the bytes look like SVG markup rather than a raster image. */
export function looksLikeSvg(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 4096).toString("utf8").replace(/^﻿/, "").trimStart();
  return /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head);
}
