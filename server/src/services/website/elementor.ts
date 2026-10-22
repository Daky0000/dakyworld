/**
 * Elementor pages, edited through the editor that already exists.
 *
 * Nothing here adds a control. The editor works on the page a visitor sees — a
 * heading is an `<h2>`, a button is an `<a>` — and its text box, link box,
 * picture picker, Style tab, Hover view and layout buttons already produce the
 * edits. What Elementor needs is the other half: where in its saved data
 * (`_elementor_data`, one JSON tree per page or template) each edit belongs.
 *
 * Three rules make that generic rather than a table per widget:
 *
 * - **Every element is found by its own id.** Elementor writes `data-id` (and,
 *   for V4 widgets, `data-interaction-id`) on the live page, and the same id is
 *   in the tree. A clicked heading is tied to its element by markup, never by
 *   guessing from its words.
 * - **Words, links and pictures are found inside that element's settings.** The
 *   original value the draft carries is looked for, as a whole, in the
 *   element's own settings — `title`, `editor`, `text`, a repeater item's field,
 *   a third-party widget's field — and replaced where it is. It must be there
 *   exactly once. A value that is not there (a dynamic tag, words a widget
 *   computes) is locked with the reason, never guessed at.
 * - **Styling goes where Elementor keeps it.** V4 elements keep it as typed
 *   props named after the CSS property, per screen size and state, so the
 *   Style tab's declarations, its Tablet and Phone overrides and its Hover view
 *   map across one value format at a time. Classic (V3) elements keep styling
 *   in named settings, translated through one small table. A property with no
 *   place in Elementor is refused with a sentence.
 *
 * Layout changes (delete, duplicate, move) are read off the editor's own
 * layout snapshot — the page with the change made — and replayed on the tree
 * by element id.
 */
import { attr, parseHtml, walk, type ElementNode } from "./parse.js";
import { readPage, type FieldValue, type SiteField } from "./regions.js";
import { DOCUMENT_KEY, draftDocument } from "./document.js";
import { meaningful, needle, normalise, normaliseUrl, plainText, wholeOccurrences } from "./wordpress.js";

export const ELEMENTOR_ADAPTER_VERSION = "elementor-v1" as const;

/** One element of Elementor's saved tree. Settings are `[]` when empty (PHP's empty array). */
export type ElementorNode = {
  id: string;
  elType: string;
  widgetType?: string;
  settings?: Record<string, unknown> | unknown[];
  elements?: ElementorNode[];
  styles?: Record<string, ElementorStyle> | unknown[];
  templateID?: number | string;
  [key: string]: unknown;
};
type ElementorStyle = { id: string; label?: string; type?: string; variants: ElementorVariant[] };
type ElementorVariant = { meta: { breakpoint: string | null; state: string | null }; props: Record<string, unknown> | unknown[]; custom_css?: { raw: string } | null };

/** A page or template's saved tree, as it was read. */
export type ElementorDocument = { postId: number; kind: "page" | "template"; title: string; data: ElementorNode[] };
export type ElementorDocuments = Map<number, ElementorDocument>;

// ---------------------------------------------------------------- the live page

type Owner = {
  /** The page or template the element lives in, from `data-elementor-id`. */
  documentId: number | null;
  elementId: string | null;
  /** The field is the element's own wrapper rather than something inside it. */
  wrapper: boolean;
  /** A classic global widget: the element is a pointer to this template. */
  globalTemplate: number | null;
};

const ELEMENT_ID = (node: ElementNode) => attr(node, "data-id") ?? attr(node, "data-interaction-id");

/** Every page and template id the live page renders, and every global widget's template. */
export function elementorDocumentIds(html: string): { documents: number[]; globals: number[] } {
  const documents = new Set<number>();
  const globals = new Set<number>();
  for (const match of html.matchAll(/data-elementor-id=["'](\d{1,12})["']/g)) documents.add(Number(match[1]));
  for (const match of html.matchAll(/\belementor-global-(\d{1,12})\b/g)) globals.add(Number(match[1]));
  return { documents: [...documents], globals: [...globals] };
}

/** Where in the HTML a field's element starts, for finding what holds it. */
function fieldPosition(field: SiteField): number | null {
  return field.attrInsert ?? field.content?.start ?? field.srcSpan?.start ?? null;
}

function locator(html: string) {
  const nodes = [...walk(parseHtml(html))];
  return (position: number): ElementNode | null => {
    let best: ElementNode | null = null;
    for (const node of nodes) {
      if (node.start <= position && position < node.end && (!best || node.end - node.start < best.end - best.start)) best = node;
    }
    return best;
  };
}

function ownerOf(node: ElementNode | null): Owner {
  const owner: Owner = { documentId: null, elementId: null, wrapper: false, globalTemplate: null };
  for (let current = node, depth = 0; current; current = current.parent, depth += 1) {
    if (owner.elementId === null) {
      const id = ELEMENT_ID(current);
      if (id) {
        owner.elementId = id;
        owner.wrapper = depth === 0;
        const global = /\belementor-global-(\d{1,12})\b/.exec(attr(current, "class") ?? "");
        if (global) owner.globalTemplate = Number(global[1]);
      }
    }
    const documentId = attr(current, "data-elementor-id");
    if (documentId) {
      owner.documentId = Number(documentId);
      break;
    }
  }
  return owner;
}

// ---------------------------------------------------------------- the tree

function findNode(nodes: ElementorNode[], id: string): { node: ElementorNode; siblings: ElementorNode[]; parent: ElementorNode | null } | null {
  const visit = (list: ElementorNode[], parent: ElementorNode | null): ReturnType<typeof findNode> => {
    for (const node of list) {
      if (node.id === id) return { node, siblings: list, parent };
      const inner = visit(node.elements ?? [], node);
      if (inner) return inner;
    }
    return null;
  };
  return visit(nodes, null);
}

function settingsOf(node: ElementorNode): Record<string, unknown> {
  if (!node.settings || Array.isArray(node.settings)) node.settings = {};
  return node.settings as Record<string, unknown>;
}

const isV4 = (node: ElementorNode) => /^e-/.test(node.widgetType ?? "") || /^e-/.test(node.elType);

type Resolved = { document: ElementorDocument; node: ElementorNode; v4: boolean };

/** The element a field belongs to, in the document that holds it — following a global widget to its template. */
function resolve(owner: Owner, documents: ElementorDocuments): Resolved | { reason: string } {
  if (!owner.elementId || owner.documentId === null) {
    return { reason: "This is part of the theme, not of an Elementor page or template. Change it in WordPress (Appearance)." };
  }
  if (owner.globalTemplate !== null) {
    const template = documents.get(owner.globalTemplate);
    const node = template?.data[0];
    if (!template || !node) return { reason: "This is a global widget, and its template could not be read. Connect WordPress with an Administrator account to change templates." };
    return { document: template, node, v4: isV4(node) };
  }
  const document = documents.get(owner.documentId);
  if (!document) {
    return { reason: "This is part of an Elementor template (a header, footer or saved section) that could not be read. Connect WordPress with an Administrator account to change templates." };
  }
  const found = findNode(document.data, owner.elementId);
  if (!found) return { reason: "This element is not in the page's saved Elementor data — it may come from a plugin or a newer save. Reopen the page." };
  return { document, node: found.node, v4: isV4(found.node) };
}

// ---------------------------------------------------------------- settings leaves

type Leaf = { holder: Record<string, unknown> | unknown[]; key: string | number; value: string; topKey: string };

/** Keys whose strings are configuration, never words a visitor reads. */
const NOT_WORDS = /^(_|__)|(^|_)(color|size|align|tag|html_tag|classes|attributes|css|id|unit|position|animation|icon|view|shape|type|target|link)$|^(typography|border|background|box_shadow|text_shadow|padding|margin|width|height|hover)_/;

function leaves(settings: unknown, topKey = "", out: Leaf[] = [], holder?: Record<string, unknown> | unknown[], key?: string | number): Leaf[] {
  if (typeof settings === "string") {
    if (holder !== undefined && key !== undefined) out.push({ holder, key, value: settings, topKey });
    return out;
  }
  if (Array.isArray(settings)) {
    settings.forEach((item, index) => leaves(item, topKey, out, settings, index));
    return out;
  }
  if (settings && typeof settings === "object") {
    for (const [childKey, child] of Object.entries(settings as Record<string, unknown>)) {
      leaves(child, topKey || childKey, out, settings as Record<string, unknown>, childKey);
    }
  }
  return out;
}

function dynamicKeys(node: ElementorNode): Set<string> {
  const dynamic = settingsOf(node).__dynamic__;
  return new Set(dynamic && typeof dynamic === "object" ? Object.keys(dynamic as object) : []);
}

/** Inline tags a widget wraps its stored words in on the way out: a button's spans, a heading's link. */
function peel(text: string): string | null {
  const match = /^<([a-z0-9-]+)>([\s\S]*)<\/\1>$/.exec(text);
  if (!match) return null;
  // The first tag must close at the very end: `<b>a</b> and <b>b</b>` is two
  // tags side by side, not one wrapped around everything.
  const tag = match[1]!;
  let depth = 0;
  for (const token of text.matchAll(new RegExp(`<(/?)${tag}>`, "g"))) {
    depth += token[1] ? -1 : 1;
    if (depth === 0 && token.index! + token[0].length !== text.length) return null;
  }
  return match[2]!.trim();
}
function stripOuter(html: string, times: number): string {
  let out = html.trim();
  for (let index = 0; index < times; index += 1) {
    const match = /^<([a-z0-9-]+)\b[^>]*>([\s\S]*)<\/\1>$/i.exec(out);
    if (!match) break;
    out = match[2]!.trim();
  }
  return out;
}

type WordsAt = { leaf: Leaf; start: number; end: number; peeled: number } | { reason: string };

/** Where an element keeps these words, exactly once, or why not. */
function wordsAt(node: ElementorNode, value: string): WordsAt {
  let text = needle(value);
  if (!meaningful(text)) return { reason: "There are no words here to change." };
  const dynamic = dynamicKeys(node);
  const candidates = leaves(settingsOf(node)).filter((leaf) => !NOT_WORDS.test(String(leaf.topKey)) && !/^https?:\/\//.test(leaf.value));
  for (let peeled = 0; peeled < 4; peeled += 1) {
    const hits: Array<{ leaf: Leaf; at: number; normalised: ReturnType<typeof normalise> }> = [];
    for (const leaf of candidates) {
      const normalised = normalise(leaf.value, { stored: false });
      for (const at of wholeOccurrences(normalised.text, text)) hits.push({ leaf, at, normalised });
    }
    if (hits.length === 1) {
      const hit = hits[0]!;
      if (dynamic.has(hit.leaf.topKey)) return { reason: "These words come from a dynamic tag (the page title, a custom field, the site name) rather than being typed in. Change them where they come from." };
      return { leaf: hit.leaf, start: hit.normalised.starts[hit.at]!, end: hit.normalised.ends[hit.at + text.length - 1]!, peeled };
    }
    if (hits.length > 1) return { reason: "These exact words appear more than once in this element, so a change here could land on the wrong one. Change it in Elementor." };
    const inner = peel(text);
    if (inner === null) break;
    text = inner;
  }
  if ([...dynamic].length) return { reason: "This element's content comes from a dynamic tag rather than being typed in. Change it where it comes from." };
  return { reason: "This widget builds these words itself rather than storing them, so they cannot be changed from here. Change it in Elementor." };
}

function urlLeaf(node: ElementorNode, url: string): Leaf | null {
  const wanted = normaliseUrl(url).replace(/-\d+x\d+(?=\.\w+$)/, "");
  const hits = leaves(settingsOf(node)).filter((leaf) => /^(https?:)?\/\/|^\//.test(leaf.value) && normaliseUrl(leaf.value).replace(/-\d+x\d+(?=\.\w+$)/, "") === wanted);
  return hits.length === 1 ? hits[0]! : null;
}

// ---------------------------------------------------------------- what is writable

export type ElementorFieldMap = { writable: Set<string>; notes: Map<string, string>; failure?: string };

/**
 * Which of the live page's fields a publish can write. A container is writable
 * when its element is found — its words are its children's, but its styling
 * and its place in the layout are its own.
 */
export function elementorFieldMap(input: { html: string; documents: ElementorDocuments; fields?: SiteField[] }): ElementorFieldMap {
  const fields = input.fields ?? readPage(input.html).fields;
  const at = locator(input.html);
  const writable = new Set<string>();
  const notes = new Map<string, string>();
  for (const field of fields) {
    if (field.id.startsWith("meta.")) {
      notes.set(field.id, "WordPress, or your SEO plugin, writes this page's browser title and description. Change them in WordPress.");
      continue;
    }
    const position = fieldPosition(field);
    const resolved = position === null ? { reason: "This part of the page could not be placed." } : resolve(ownerOf(at(position)), input.documents);
    if ("reason" in resolved) {
      notes.set(field.id, resolved.reason);
      continue;
    }
    if (field.kind === "text" || field.kind === "richtext" || field.kind === "link" || field.kind === "button") {
      const found = wordsAt(resolved.node, field.value);
      if ("reason" in found) notes.set(field.id, found.reason);
      else writable.add(field.id);
      continue;
    }
    if (field.kind === "image") {
      if (urlLeaf(resolved.node, field.value)) writable.add(field.id);
      else notes.set(field.id, "This picture is not stored on this element — it may come from the media library's sizes or a dynamic tag. Change it in Elementor.");
      continue;
    }
    // Containers, backgrounds, icons: styling and layout are the element's own.
    writable.add(field.id);
  }
  return { writable, notes, ...(writable.size === 0 && fields.length ? { failure: "Nothing on this page could be traced to its Elementor data. Change it in Elementor." } : {}) };
}

// ---------------------------------------------------------------- styles

type Declarations = Map<string, string>;

function parseStyle(style: string | undefined | null): Declarations {
  const out: Declarations = new Map();
  for (const part of (style ?? "").split(";")) {
    const at = part.indexOf(":");
    if (at === -1) continue;
    const property = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (property && value) out.set(property, value);
  }
  return out;
}

const DEVICE_V4: Record<string, string> = { desktop: "desktop", tablet: "tablet", mobile: "mobile" };
const SUFFIX_V3: Record<string, string> = { desktop: "", tablet: "_tablet", mobile: "_mobile" };

/** One style change to make: a property's new value (or removal) on one screen size and state. */
type StyleChange = { device: "desktop" | "tablet" | "mobile"; state: "hover" | null; property: string; value: string | null };

/** What the Style tab, its screen-size overrides and its Hover view changed, as plain CSS. */
function styleChanges(edit: FieldValue, field: SiteField | undefined): { changes: StyleChange[]; refused: string[] } {
  const changes: StyleChange[] = [];
  const refused: string[] = [];
  const compare = (device: StyleChange["device"], before: string | undefined, after: string | undefined) => {
    if (after === undefined) return;
    const was = parseStyle(before);
    const now = parseStyle(after);
    for (const property of new Set([...was.keys(), ...now.keys()])) {
      const value = now.get(property) ?? null;
      if (value === (was.get(property) ?? null)) continue;
      if (property.startsWith("--dw-hover-")) changes.push({ device, state: "hover", property: property.slice("--dw-hover-".length), value });
      else if (property.startsWith("--dw-")) refused.push("Animations and interactions made in this editor cannot be stored in Elementor yet. Set them in Elementor's Motion Effects or Interactions.");
      else changes.push({ device, state: null, property, value });
    }
  };
  compare("desktop", edit.originalStyle ?? field?.style ?? "", edit.style);
  const responsive = edit.responsive as { tablet?: string; mobile?: string } | undefined;
  const before = (edit.originalResponsive ?? field?.responsive ?? {}) as { tablet?: string; mobile?: string };
  if (responsive) {
    compare("tablet", before.tablet, responsive.tablet ?? "");
    compare("mobile", before.mobile, responsive.mobile ?? "");
  }
  return { changes, refused };
}

// V4: typed props on the element's own style variant ------------------------------

/**
 * A CSS declaration as a V4 style prop. V4 keys its props by the CSS property
 * name, so this is one value format per kind of value rather than a table per
 * widget. (V4 also takes raw CSS per variant, but Elementor strips that unless
 * the site runs Elementor Pro, so it is not relied on.)
 */
function v4Prop(property: string, value: string, existing: unknown): unknown | null {
  const size = (text: string, unitless = "px") => {
    const parsed = sizeOf(text, unitless);
    return parsed ? { $$type: "size", value: { size: parsed.size, unit: parsed.unit } } : null;
  };
  const sides = (text: string, key: string, names: [string, string, string, string]) => {
    const parts = text.trim().split(/\s+/);
    if (parts.length === 1) return size(parts[0]!);
    const sized = parts.map((part) => size(part));
    if (parts.length > 4 || sized.some((part) => !part)) return null;
    const [a, b = a, c = a, d = b] = sized;
    return { $$type: key, value: { [names[0]]: a, [names[1]]: b, [names[2]]: c, [names[3]]: d } };
  };
  const string = (text: string) => ({ $$type: "string", value: text });
  if (/(^|-)color$/.test(property) && property !== "background-color") return { $$type: "color", value };
  switch (property) {
    case "background-color":
    case "background-image": {
      const current = existing && typeof existing === "object" ? ((existing as { value?: Record<string, unknown> }).value ?? {}) : {};
      if (property === "background-color") return { $$type: "background", value: { ...current, color: { $$type: "color", value } } };
      const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(value)?.[1];
      if (!url) return value === "none" ? { $$type: "background", value: { ...current, "background-overlay": { $$type: "background-overlay", value: [] } } } : null;
      const overlay = { $$type: "background-image-overlay", value: { image: { $$type: "image", value: { src: { $$type: "image-src", value: { id: null, url: { $$type: "url", value: url } } } } } } };
      return { $$type: "background", value: { ...current, "background-overlay": { $$type: "background-overlay", value: [overlay] } } };
    }
    case "padding": case "margin":
      return sides(value, "dimensions", ["block-start", "inline-end", "block-end", "inline-start"]);
    case "border-width":
      return sides(value, "border-width-v2", ["block-start", "inline-end", "block-end", "inline-start"]);
    case "border-radius":
      return sides(value, "border-radius-v2", ["start-start", "start-end", "end-end", "end-start"]);
    case "line-height": return size(value, "em");
    case "opacity": {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 && number <= 1 ? { $$type: "size", value: { size: Math.round(number * 100), unit: "%" } } : size(value, "%");
    }
    case "z-index": case "column-count":
      return /^-?\d+$/.test(value) ? { $$type: "number", value: Number(value) } : null;
    case "font-family":
      return { $$type: "font-family", value: value.split(",")[0]!.trim().replace(/^["']|["']$/g, "") };
    case "font-size": case "width": case "height": case "min-width": case "min-height": case "max-width": case "max-height":
    case "letter-spacing": case "word-spacing": case "gap": case "column-gap": case "row-gap": case "outline-width": case "outline-offset":
    case "inset-block-start": case "inset-block-end": case "inset-inline-start": case "inset-inline-end":
      return size(value);
    case "font-weight": case "text-align": case "font-style": case "text-transform": case "text-decoration": case "display":
    case "flex-direction": case "justify-content": case "align-items": case "align-self": case "flex-wrap": case "border-style":
    case "outline-style": case "position": case "overflow": case "cursor": case "object-fit": case "aspect-ratio": case "direction":
      return string(value);
    default:
      return null;
  }
}

function applyV4Style(node: ElementorNode, changes: StyleChange[]): string[] {
  const settings = settingsOf(node);
  if (!node.styles || Array.isArray(node.styles)) node.styles = {};
  const styles = node.styles as Record<string, ElementorStyle>;
  const classes = (settings.classes && typeof settings.classes === "object" ? settings.classes : { $$type: "classes", value: [] }) as { $$type: string; value: string[] };
  settings.classes = classes;
  let local = classes.value.find((id) => styles[id] && (styles[id]!.label === "local" || id.startsWith(`e-${node.id}`)));
  if (!local) {
    local = `e-${node.id}-${Math.random().toString(16).slice(2, 9)}`;
    styles[local] = { id: local, label: "local", type: "class", variants: [] };
    classes.value.push(local);
  }
  const style = styles[local]!;
  const refused: string[] = [];
  for (const change of changes) {
    let variant = style.variants.find((entry) => (entry.meta.breakpoint ?? "desktop") === DEVICE_V4[change.device] && (entry.meta.state ?? null) === change.state);
    if (!variant) {
      variant = { meta: { breakpoint: DEVICE_V4[change.device]!, state: change.state }, props: {}, custom_css: null };
      style.variants.push(variant);
    }
    if (!variant.props || Array.isArray(variant.props)) variant.props = {};
    const props = variant.props as Record<string, unknown>;
    const key = change.property === "background-color" || change.property === "background-image" ? "background" : change.property;
    if (change.value === null) {
      if (key === "background" && props.background && typeof props.background === "object") {
        const value = { ...((props.background as { value?: Record<string, unknown> }).value ?? {}) };
        delete value[change.property === "background-color" ? "color" : "background-overlay"];
        props.background = { $$type: "background", value };
      } else {
        delete props[key];
      }
      continue;
    }
    const prop = v4Prop(change.property, change.value, props[key]);
    if (prop === null) {
      refused.push(`Elementor V4 has no setting for ${change.property}: ${change.value}${change.state ? " on hover" : ""}, so that change was not published. Change it in Elementor.`);
      continue;
    }
    props[key] = prop;
  }
  return refused;
}

// V3: one table onto Elementor's named settings ----------------------------------

type Shape = "raw" | "size" | "dims" | "image" | "font" | "number";
type Slot = { key: string; shape: Shape; responsive: boolean; also?: Record<string, string> };

const TYPOGRAPHY: Record<string, Slot> = {
  "font-size": { key: "typography_font_size", shape: "size", responsive: true },
  "font-weight": { key: "typography_font_weight", shape: "raw", responsive: false },
  "line-height": { key: "typography_line_height", shape: "size", responsive: true },
  "letter-spacing": { key: "typography_letter_spacing", shape: "size", responsive: true },
  "text-transform": { key: "typography_text_transform", shape: "raw", responsive: false },
  "font-style": { key: "typography_font_style", shape: "raw", responsive: false },
  "text-decoration": { key: "typography_text_decoration", shape: "raw", responsive: false },
  "font-family": { key: "typography_font_family", shape: "font", responsive: false },
};

function boxSlots(prefix: string, state: "hover" | null): Record<string, Slot> {
  if (state === "hover") {
    return {
      "background-color": { key: `${prefix}background_hover_color`, shape: "raw", responsive: false, also: { [`${prefix}background_hover_background`]: "classic" } },
      "border-color": { key: `${prefix}border_hover_color`, shape: "raw", responsive: false },
    };
  }
  return {
    margin: { key: `${prefix}margin`, shape: "dims", responsive: true },
    padding: { key: `${prefix}padding`, shape: "dims", responsive: true },
    "background-color": { key: `${prefix}background_color`, shape: "raw", responsive: false, also: { [`${prefix}background_background`]: "classic" } },
    "background-image": { key: `${prefix}background_image`, shape: "image", responsive: true, also: { [`${prefix}background_background`]: "classic" } },
    "border-style": { key: `${prefix}border_border`, shape: "raw", responsive: false },
    "border-width": { key: `${prefix}border_width`, shape: "dims", responsive: true },
    "border-color": { key: `${prefix}border_color`, shape: "raw", responsive: false },
    "border-radius": { key: `${prefix}border_radius`, shape: "dims", responsive: true },
    "z-index": { key: `${prefix}z_index`, shape: "number", responsive: true },
  };
}

/** Where a classic element keeps one CSS property, for the part of it that was styled. */
function v3Slots(node: ElementorNode, wrapper: boolean, state: "hover" | null): Record<string, Slot> {
  const container = ["container", "section", "column"].includes(node.elType);
  if (container) {
    return {
      ...boxSlots("", state),
      ...(state ? {} : {
        "min-height": { key: "min_height", shape: "size", responsive: true },
        "flex-direction": { key: "flex_direction", shape: "raw", responsive: true },
        "justify-content": { key: "flex_justify_content", shape: "raw", responsive: true },
        "align-items": { key: "flex_align_items", shape: "raw", responsive: true },
      }),
    };
  }
  if (wrapper) return boxSlots("_", state);
  const widget = node.widgetType ?? "";
  if (state === "hover") {
    if (widget === "button") {
      return {
        color: { key: "hover_color", shape: "raw", responsive: false },
        "background-color": { key: "button_background_hover_color", shape: "raw", responsive: false },
        "border-color": { key: "button_hover_border_color", shape: "raw", responsive: false },
      };
    }
    if (widget === "heading") return { color: { key: "title_hover_color", shape: "raw", responsive: false } };
    return {};
  }
  const text = (color: string): Record<string, Slot> => ({
    color: { key: color, shape: "raw", responsive: false },
    "text-align": { key: "align", shape: "raw", responsive: true },
    ...TYPOGRAPHY,
  });
  if (widget === "heading") return text("title_color");
  if (widget === "text-editor") return text("text_color");
  if (widget === "button") {
    return {
      ...text("button_text_color"),
      "background-color": { key: "background_color", shape: "raw", responsive: false, also: { background_background: "classic" } },
      "border-style": { key: "border_border", shape: "raw", responsive: false },
      "border-width": { key: "border_width", shape: "dims", responsive: true },
      "border-color": { key: "border_color", shape: "raw", responsive: false },
      "border-radius": { key: "border_radius", shape: "dims", responsive: true },
      padding: { key: "text_padding", shape: "dims", responsive: true },
    };
  }
  if (widget === "image") {
    return {
      width: { key: "width", shape: "size", responsive: true },
      opacity: { key: "opacity", shape: "size", responsive: false },
      "border-radius": { key: "image_border_radius", shape: "dims", responsive: true },
      "border-style": { key: "image_border_border", shape: "raw", responsive: false },
      "border-width": { key: "image_border_width", shape: "dims", responsive: true },
      "border-color": { key: "image_border_color", shape: "raw", responsive: false },
    };
  }
  // Any other widget's inner parts have names only it knows; its box is still
  // styled on the wrapper.
  return boxSlots("_", null);
}

function sizeOf(value: string, unitless = "px"): { unit: string; size: number; sizes: [] } | null {
  const match = /^(-?\d*\.?\d+)(px|em|rem|%|vw|vh|deg)?$/.exec(value.trim());
  return match ? { unit: match[2] ?? unitless, size: Number(match[1]), sizes: [] } : null;
}
function dimsOf(value: string) {
  const parts = value.trim().split(/\s+/).map((part) => sizeOf(part));
  if (!parts.length || parts.length > 4 || parts.some((part) => !part)) return null;
  const [top, right = top, bottom = top, left = right] = parts as Array<{ unit: string; size: number }>;
  const unit = top!.unit;
  if ([right, bottom, left].some((part) => part!.unit !== unit && part!.size !== 0)) return null;
  return { unit, top: String(top!.size), right: String(right!.size), bottom: String(bottom!.size), left: String(left!.size), isLinked: parts.length === 1 };
}

function shaped(slot: Slot, property: string, value: string): unknown | null {
  switch (slot.shape) {
    case "raw": return value;
    case "number": return /^-?\d+$/.test(value) ? Number(value) : null;
    case "size": return property === "line-height" ? sizeOf(value, "em") : property === "opacity" ? sizeOf(value, "") : sizeOf(value);
    case "dims": return dimsOf(value);
    case "font": return value.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
    case "image": {
      const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(value)?.[1];
      return url ? { url, id: "", size: "", alt: "", source: "library" } : value === "none" ? { url: "", id: "" } : null;
    }
  }
}

function applyV3Style(node: ElementorNode, wrapper: boolean, changes: StyleChange[]): string[] {
  const settings = settingsOf(node);
  const refused: string[] = [];
  for (const change of changes) {
    const slot = v3Slots(node, wrapper, change.state)[change.property];
    if (!slot || (change.device !== "desktop" && !slot.responsive)) {
      refused.push(`Elementor has no ${change.state === "hover" ? "hover " : ""}${change.device === "desktop" ? "" : `${change.device} `}setting for ${change.property} on this element, so that change was not published. Change it in Elementor.`);
      continue;
    }
    const key = `${slot.key}${SUFFIX_V3[change.device]}`;
    const globals = settings.__globals__ as Record<string, unknown> | undefined;
    if (globals && typeof globals === "object") delete globals[key];
    if (change.value === null) {
      delete settings[key];
      continue;
    }
    const value = shaped(slot, change.property, change.value);
    if (value === null) {
      refused.push(`Elementor cannot store ${change.property}: ${change.value} on this element. Use a plain value such as 16px.`);
      continue;
    }
    settings[key] = value;
    if (TYPOGRAPHY[change.property]) settings.typography_typography = "custom";
    for (const [alsoKey, alsoValue] of Object.entries(slot.also ?? {})) settings[alsoKey] = alsoValue;
  }
  return refused;
}

// ---------------------------------------------------------------- layout

/** Each parent's children in order. A document's top level is keyed `@<post id>` — a page and its header both have one. */
function elementOrder(html: string): Map<string | null, string[]> {
  const order = new Map<string | null, string[]>();
  for (const node of walk(parseHtml(html))) {
    const id = ELEMENT_ID(node);
    if (!id) continue;
    let parent: string | null = null;
    for (let current = node.parent; current; current = current.parent) {
      const found = ELEMENT_ID(current);
      if (found) { parent = found; break; }
      const documentId = attr(current, "data-elementor-id");
      if (documentId) { parent = `@${documentId}`; break; }
    }
    order.set(parent, [...(order.get(parent) ?? []), id]);
  }
  return order;
}

function freshId(): string {
  return Math.random().toString(16).slice(2, 9).padEnd(7, "0");
}

/** A copy of an element with new ids throughout, its V4 local styles renamed to match. */
function cloneNode(node: ElementorNode): ElementorNode {
  const copy = JSON.parse(JSON.stringify(node)) as ElementorNode;
  const renumber = (current: ElementorNode) => {
    const old = current.id;
    current.id = freshId();
    if (current.styles && !Array.isArray(current.styles)) {
      const styles = current.styles as Record<string, ElementorStyle>;
      const settings = settingsOf(current);
      const classes = settings.classes as { value?: string[] } | undefined;
      for (const key of Object.keys(styles)) {
        if (!key.includes(old)) continue;
        const renamed = key.replace(old, current.id);
        styles[renamed] = { ...styles[key]!, id: renamed };
        delete styles[key];
        if (classes?.value) classes.value = classes.value.map((value) => (value === key ? renamed : value));
      }
    }
    for (const child of current.elements ?? []) renumber(child);
  };
  renumber(copy);
  return copy;
}

/**
 * The layout snapshot's deletes, duplicates and moves, replayed on the trees by
 * element id. Returns the documents it changed, or why it could not.
 */
function applyLayout(original: string, edited: string, documents: ElementorDocuments): { changed: Set<number>; refused: string[] } {
  const before = elementOrder(original);
  const after = elementOrder(edited);
  const changed = new Set<number>();
  const refused: string[] = [];
  const all = (map: Map<string | null, string[]>) => new Set([...map.values()].flat());
  const had = all(before);
  const has = all(after);
  const documentOf = (id: string) => [...documents.values()].find((document) => findNode(document.data, id));

  for (const id of had) {
    if (has.has(id)) continue;
    const document = documentOf(id);
    const found = document && findNode(document.data, id);
    if (!document || !found) continue;
    found.siblings.splice(found.siblings.indexOf(found.node), 1);
    changed.add(document.postId);
  }

  for (const [parentId, sequence] of after) {
    const previous = before.get(parentId) ?? [];
    if (sequence.length === previous.length && sequence.every((id, index) => id === previous[index])) continue;
    const top = parentId?.startsWith("@") ?? true;
    const parentDocument = !top ? documentOf(parentId!) : parentId ? documents.get(Number(parentId.slice(1))) : documentOf(sequence[0]!);
    if (!parentDocument) continue;
    const list = !top ? findNode(parentDocument.data, parentId!)?.node.elements : parentDocument.data;
    if (!list) continue;
    const seen = new Set<string>();
    const wanted: ElementorNode[] = [];
    for (const id of sequence) {
      const found = findNode(parentDocument.data, id);
      if (!found) {
        refused.push("A layout change moves an element between a template and the page, which Elementor cannot do from here. Undo it and make it in Elementor.");
        continue;
      }
      if (seen.has(id)) {
        wanted.push(cloneNode(found.node));
        continue;
      }
      seen.add(id);
      if (found.siblings !== list) found.siblings.splice(found.siblings.indexOf(found.node), 1);
      wanted.push(found.node);
    }
    const mentioned = new Set(wanted.map((node) => node.id));
    const rebuilt: ElementorNode[] = [];
    let next = 0;
    for (const child of list) {
      if (mentioned.has(child.id) || seen.has(child.id)) {
        if (next < wanted.length) rebuilt.push(wanted[next++]!);
      } else {
        rebuilt.push(child);
      }
    }
    while (next < wanted.length) rebuilt.push(wanted[next++]!);
    list.splice(0, list.length, ...rebuilt);
    changed.add(parentDocument.postId);
  }
  return { changed, refused };
}

// ---------------------------------------------------------------- a layout draft's edits

/**
 * Every change a layout draft holds, as edits against the original page.
 *
 * A layout change folds the edits made before it into its snapshot of the page
 * and keeps no separate record of them, and edits made after it are recorded
 * against the snapshot. Neither says what Elementor stores now. So the snapshot
 * is compared with the original page element by element — by Elementor's own
 * ids — and whatever differs in a field's words, link, picture or styling is
 * an edit, whichever side of the layout change it was made on.
 */
function foldEdits(original: string, layout: string, explicit: Record<string, FieldValue>): { values: Record<string, FieldValue>; refused: Array<{ htmlFieldId: string; part: string; message: string }> } {
  const group = (kind: string) => (kind === "text" || kind === "richtext" ? "words" : kind === "link" || kind === "button" ? "link" : kind);
  const keyed = (html: string) => {
    const at = locator(html);
    const nodes = [...walk(parseHtml(html))];
    // By where the element starts: `at` parses the page separately, so its nodes are not these.
    const occurrence = new Map<number, number>();
    const seen = new Map<string, number>();
    for (const node of nodes) {
      const id = ELEMENT_ID(node);
      if (!id) continue;
      occurrence.set(node.start, seen.get(id) ?? 0);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    const out = new Map<string, SiteField>();
    const ordinal = new Map<string, number>();
    for (const field of readPage(html).fields) {
      const position = fieldPosition(field);
      if (position === null) continue;
      let element: ElementNode | null = at(position);
      while (element && !ELEMENT_ID(element)) element = element.parent;
      // Outside every Elementor element: the theme, keyed by order alone.
      const base = element ? `${ELEMENT_ID(element)}#${occurrence.get(element.start) ?? 0}:${group(field.kind)}` : `theme:${group(field.kind)}`;
      const index = ordinal.get(base) ?? 0;
      ordinal.set(base, index + 1);
      out.set(`${base}:${index}`, field);
    }
    return out;
  };
  const before = keyed(original);
  const after = keyed(layout);
  const values: Record<string, FieldValue> = {};
  const refused: Array<{ htmlFieldId: string; part: string; message: string }> = [];
  for (const [key, field] of after) {
    const mine = explicit[field.id];
    const was = before.get(key);
    const value = mine?.value ?? field.value;
    const href = mine?.href ?? field.href;
    const alt = mine?.alt ?? field.alt;
    const style = mine?.style ?? field.style ?? "";
    const responsive = (mine?.responsive ?? field.responsive ?? {}) as Record<string, string | undefined>;
    if (!was) {
      // A copy made with Duplicate carries its original's id a second time
      // (`#1`), and becomes a new element when the layout is replayed. Anything
      // else that was not on the page — a section added from the library — has
      // no Elementor element to become, and would vanish on publish in silence.
      if (/#[1-9]\d*:/.test(key)) {
        if (mine && Object.keys(mine).length) refused.push({ htmlFieldId: field.id, part: "copy", message: "This is a copy made with Duplicate. Publish the duplicate first, then change the copy." });
      } else if (!refused.some((entry) => entry.part === "added")) {
        refused.push({ htmlFieldId: field.id, part: "added", message: "New sections and blocks cannot be written into Elementor's data from here. Delete, duplicate and move what is already on the page, or add new content in Elementor." });
      }
      continue;
    }
    const edit: FieldValue = {};
    if (value !== was.value) Object.assign(edit, { value, original: was.value });
    if (href !== undefined && href !== was.href) Object.assign(edit, { href, originalHref: was.href });
    if (alt !== undefined && alt !== was.alt) Object.assign(edit, { alt, originalAlt: was.alt ?? "" });
    if (style !== (was.style ?? "")) Object.assign(edit, { style, originalStyle: was.style ?? "" });
    const wasResponsive = (was.responsive ?? {}) as Record<string, string | undefined>;
    if ((responsive.tablet ?? "") !== (wasResponsive.tablet ?? "") || (responsive.mobile ?? "") !== (wasResponsive.mobile ?? "")) {
      Object.assign(edit, { responsive, originalResponsive: wasResponsive });
    }
    for (const part of ["variant", "newTab", "icon", "originalNewTab"] as const) if (mine?.[part] !== undefined) (edit as Record<string, unknown>)[part] = mine[part];
    if (Object.keys(edit).length) values[field.id] = edit;
  }
  return { values, refused };
}

// ---------------------------------------------------------------- writing

export type ElementorMedia = Map<string, { id: number; url: string }>;
export type ElementorApplyResult = {
  documents: ElementorDocuments;
  /** Post ids whose tree changed and must be saved. */
  changedDocuments: number[];
  changed: string[];
  changes: Array<{ before: string; after: string }>;
  unmappable: Array<{ htmlFieldId: string; part: string; message: string }>;
  problems: Array<{ fieldId: string; code: "stale" | "invalid"; message: string }>;
};

/**
 * Writes an editor's draft into Elementor's trees, or refuses all of it.
 * Works on copies; the caller saves `changedDocuments`.
 */
/** A background picked from the site's assets, pointed at its copy in the WordPress media library. */
function withUploadedBackgrounds(edit: FieldValue, media: ElementorMedia | undefined): FieldValue {
  if (!media?.size) return edit;
  const swap = (style: string | undefined) => style?.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi, (token, url: string) => (media.has(url) ? `url(${media.get(url)!.url})` : token));
  const responsive = edit.responsive ? Object.fromEntries(Object.entries(edit.responsive).map(([size, style]) => [size, swap(style)])) : undefined;
  return { ...edit, ...(edit.style !== undefined ? { style: swap(edit.style) } : {}), ...(responsive ? { responsive } : {}) };
}

export function applyElementorEdits(input: { html: string; documents: ElementorDocuments; values: Record<string, FieldValue>; media?: ElementorMedia }): ElementorApplyResult {
  const documents: ElementorDocuments = new Map([...input.documents].map(([id, document]) => [id, { ...document, data: JSON.parse(JSON.stringify(document.data)) as ElementorNode[] }]));
  // With a layout draft, every field id names an element of the page as it
  // will be — the snapshot — so that is what fields are read from.
  const layout = draftDocument(input.values);
  const working = layout?.html ?? input.html;
  const folded = layout ? foldEdits(input.html, working, input.values) : null;
  const edits = folded?.values ?? input.values;
  const fields = new Map(readPage(working).fields.map((field) => [field.id, field]));
  const at = locator(working);
  const result: ElementorApplyResult = { documents, changedDocuments: [], changed: [], changes: [], unmappable: [], problems: [] };
  const touched = new Set<number>();

  for (const refusal of folded?.refused ?? []) result.unmappable.push(refusal);
  for (const [fieldId, asSent] of Object.entries(edits)) {
    if (fieldId === DOCUMENT_KEY) continue;
    const edit = withUploadedBackgrounds(asSent, input.media);
    if (fieldId.startsWith("meta.")) {
      if (edit.value !== undefined && edit.value !== edit.original) result.unmappable.push({ htmlFieldId: fieldId, part: "words", message: "This page's browser title and description are written by WordPress or your SEO plugin, so change them there." });
      continue;
    }
    const field = fields.get(fieldId);
    const position = field ? fieldPosition(field) : null;
    if (!field || position === null) {
      result.problems.push({ fieldId, code: "stale", message: "This part of the page has moved since the change was made. Reopen the page and make it again." });
      continue;
    }
    const owner = ownerOf(at(position));
    const resolved = resolve(owner, documents);
    if ("reason" in resolved) {
      result.problems.push({ fieldId, code: "invalid", message: resolved.reason });
      continue;
    }
    const { node, document, v4 } = resolved;
    let did = false;

    // Words.
    const original = edit.original ?? field.value;
    if (field.kind !== "image" && edit.value !== undefined && edit.value !== original) {
      const found = wordsAt(node, original);
      if ("reason" in found) {
        result.problems.push({ fieldId, code: "stale", message: found.reason });
        continue;
      }
      const text = stripOuter(edit.value, found.peeled);
      const leaf = found.leaf;
      const replaced = leaf.value.slice(0, found.start) + text + leaf.value.slice(found.end);
      if (typeof leaf.key === "number") (leaf.holder as unknown[])[leaf.key] = replaced;
      else (leaf.holder as Record<string, unknown>)[leaf.key] = replaced;
      result.changes.push({ before: plainText(original), after: plainText(edit.value) });
      did = true;
    }

    // A link's destination.
    const originalHref = edit.originalHref ?? field.href;
    if (edit.href !== undefined && originalHref !== undefined && edit.href !== originalHref) {
      const leaf = urlLeaf(node, originalHref);
      if (!leaf) {
        result.unmappable.push({ htmlFieldId: fieldId, part: "link", message: "This link's destination is not stored on this element (it may be a dynamic link). Change it in Elementor." });
        continue;
      }
      (leaf.holder as Record<string, unknown>)[leaf.key as string] = edit.href;
      did = true;
    }
    if (edit.newTab !== undefined && edit.newTab !== edit.originalNewTab) {
      const link = settingsOf(node).link as Record<string, unknown> | undefined;
      if (link && typeof link === "object" && "url" in link) {
        link.is_external = edit.newTab ? "on" : "";
        did = true;
      } else {
        result.unmappable.push({ htmlFieldId: fieldId, part: "newTab", message: "Whether this link opens a new tab is set in Elementor." });
      }
    }

    // A picture.
    if (field.kind === "image" && edit.value !== undefined && edit.value !== original) {
      const leaf = urlLeaf(node, original);
      if (!leaf) {
        result.problems.push({ fieldId, code: "stale", message: "This picture is no longer stored on this element. Reopen the page." });
        continue;
      }
      const uploaded = input.media?.get(edit.value);
      const url = uploaded?.url ?? edit.value;
      if (!/^https?:\/\//i.test(url)) {
        result.problems.push({ fieldId, code: "invalid", message: "This picture could not be added to the WordPress media library." });
        continue;
      }
      const holder = leaf.holder as Record<string, unknown>;
      holder[leaf.key as string] = url;
      if ("id" in holder) holder.id = uploaded?.id ?? "";
      did = true;
    }
    if (field.kind === "image" && edit.alt !== undefined && edit.alt !== (edit.originalAlt ?? field.alt ?? "")) {
      const leaf = leaves(settingsOf(node)).find((entry) => entry.value === (edit.originalAlt ?? field.alt ?? "") && entry.value !== "");
      if (leaf) {
        (leaf.holder as Record<string, unknown>)[leaf.key as string] = edit.alt;
        did = true;
      } else {
        result.unmappable.push({ htmlFieldId: fieldId, part: "alt", message: "This picture's description comes from the WordPress media library. Change it there (Media → the picture → Alternative Text)." });
      }
    }

    // Styling, screen sizes and hover.
    const style = styleChanges(edit, field);
    for (const message of style.refused) result.unmappable.push({ htmlFieldId: fieldId, part: "style", message });
    if (style.changes.length) {
      for (const message of v4 ? applyV4Style(node, style.changes) : applyV3Style(node, owner.wrapper, style.changes)) result.unmappable.push({ htmlFieldId: fieldId, part: "style", message });
      did = true;
    }
    for (const part of ["variant", "icon"] as const) {
      if (edit[part] !== undefined) result.unmappable.push({ htmlFieldId: fieldId, part, message: part === "icon" ? "Icons on an Elementor page are chosen in Elementor." : "A button's style on an Elementor page is set by its settings, which the Style tab changes." });
    }

    if (did) {
      result.changed.push(fieldId);
      touched.add(document.postId);
    }
  }

  // Layout: deletes, duplicates and moves made with the layout buttons.
  if (layout) {
    const replayed = applyLayout(input.html, layout.html, documents);
    for (const message of replayed.refused) result.unmappable.push({ htmlFieldId: DOCUMENT_KEY, part: "structure", message });
    for (const id of replayed.changed) touched.add(id);
    if (replayed.changed.size) result.changed.push(DOCUMENT_KEY);
  }

  result.changedDocuments = [...touched];
  return result;
}
