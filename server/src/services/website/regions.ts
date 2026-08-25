import { attrNode, decodeEntities, findTag, parseHtml, textOf, walk, type ElementNode } from "./parse.js";

/**
 * Turning a hand-built page into a list of things somebody can change.
 *
 * The editable-region model, rather than the block model the system plan
 * describes. The plan is explicit that converting an existing hard-coded site
 * into blocks is a non-goal for version one, and the reason is visible the
 * moment you try it on this website: the homepage is a bespoke arrangement of
 * arches, orbs, count-up figures and a seven-item pill row, and no generic
 * "hero" component renders it back. Rebuilding it would be a redesign wearing a
 * migration's clothes.
 *
 * So the design stays the developer's and the words become the client's. This
 * file finds the words — headings, paragraphs, list items, link labels, button
 * text, image sources and alt text — groups them by the section they live in,
 * and hands back the offsets needed to put edited ones back exactly where they
 * came from.
 *
 * What it deliberately does not offer: adding, removing or reordering sections.
 * Those need a component that knows how to render a new one, which is what the
 * block model is for. A page here has exactly the sections its HTML has.
 */

/** How a field is edited, which decides the control the editor renders. */
export type FieldKind =
  /** One line or paragraph of plain words. */
  | "text"
  /** Words with inline formatting inside them — bold, a line break, a link. */
  | "richtext"
  /** A link or button: the words on it, and where it goes. */
  | "link"
  /** An image: which file, and the description read out to somebody who cannot see it. */
  | "image";

type Span = { start: number; end: number };

export type SiteField = {
  id: string;
  kind: FieldKind;
  /** How it reads in the inspector: "Main heading", "Paragraph", "Button". */
  label: string;
  /** The tag it came from, for the editor's own styling decisions. */
  tag: string;
  /** Current content. Inner HTML for text and richtext, the label for a link, the source for an image. */
  value: string;
  /** Plain text of `value`, for lists and previews. */
  preview: string;
  /** Links only. */
  href?: string;
  /** Images only. Absent when the element carries no alt attribute at all. */
  alt?: string;
  /** Something the person editing this needs to know before they change it. */
  note?: string;
  /** Whether the image is marked decorative — an alt attribute that is present and empty. */
  decorative?: boolean;
  /** The element's own inline style, when it has one. */
  style?: string;
  content?: Span;
  hrefSpan?: Span;
  srcSpan?: Span;
  altSpan?: Span;
  styleSpan?: Span;
  /** Where to insert an alt attribute on an image that has none. */
  altInsertAt?: number;
  /**
   * Just past the tag name — where a `style` or a `data-` attribute goes on an
   * element that has none. It is also what lets the visual editor mark every
   * editable element in the preview without re-parsing it in the browser.
   */
  attrInsert?: number;
};

export type SiteSection = {
  id: string;
  /** How it reads in the section list: taken from its own heading wherever there is one. */
  label: string;
  kind: "meta" | "header" | "section" | "footer";
  fields: SiteField[];
};

export type PageContent = {
  sections: SiteSection[];
  /** Every field, flattened, for lookups by id. */
  fields: SiteField[];
};

/** A value somebody has changed, as the draft stores it. */
export type FieldValue = {
  value?: string;
  href?: string;
  alt?: string;
  /**
   * The element's inline `style` attribute, as one declaration string.
   *
   * Style is written here rather than into a stylesheet on purpose. The whole
   * module is a splice at recorded offsets into somebody's hand-written page —
   * a rule added to `assets/site.css` would apply to every page at once and to
   * elements nobody was editing, which is not what "make this heading bigger"
   * means. An inline style changes exactly the element that was selected, and
   * a developer reading the diff can see precisely what happened.
   */
  style?: string;
  /**
   * What the page said when this edit was made.
   *
   * Ids are positional, so a developer who inserts a section between two edits
   * moves every id after it. Without this, a month-old draft would quietly
   * write a heading into the wrong element. With it, the edit simply refuses:
   * `applyValues` reports a conflict and leaves the page alone.
   *
   * All three are compared, not just the first. An anchor wrapping a card has no
   * words of its own, so its `original` is the empty string and would match any
   * other such anchor on the page — the destination is what identifies it.
   */
  original?: string;
  originalHref?: string;
  originalAlt?: string;
  originalStyle?: string;
};

/** Elements that never hold editable copy. */
const SKIP = new Set(["script", "style", "svg", "noscript", "template", "head", "meta", "link", "br", "hr", "iframe", "canvas", "video", "audio", "source", "picture", "path", "use"]);

/** Elements whose presence means the thing above them is a container, not a field. */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p",
  "pre", "section", "table", "tbody", "td", "th", "thead", "tr", "ul",
]);

/**
 * Elements where an inline link belongs to the sentence rather than standing on
 * its own. A link inside a paragraph is part of the paragraph and is edited with
 * it; a link inside a `<div class="actions">` is a button and gets its own row.
 */
const PROSE = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "figcaption", "dt", "dd", "td", "th", "caption"]);

const LABELS: Record<string, string> = {
  h1: "Main heading",
  h2: "Heading",
  h3: "Subheading",
  h4: "Small heading",
  h5: "Small heading",
  h6: "Small heading",
  p: "Paragraph",
  li: "List item",
  blockquote: "Quote",
  button: "Button label",
  figcaption: "Caption",
  label: "Field label",
  th: "Table heading",
  td: "Table cell",
  strong: "Text",
  span: "Text",
  div: "Text",
};

const BUTTONISH = /\b(btn|button|cta|primary|secondary|action)\b/i;

function classOf(element: ElementNode): string {
  return element.attrs.find((candidate) => candidate.name === "class")?.value ?? "";
}

/** True when nothing inside this element renders any words. */
function isEmpty(source: string, element: ElementNode): boolean {
  return textOf(source, element) === "" && !hasDescendant(element, (child) => child.tag === "img");
}

function hasDescendant(element: ElementNode, predicate: (child: ElementNode) => boolean): boolean {
  for (const candidate of walk(element)) {
    if (candidate !== element && predicate(candidate)) return true;
  }
  return false;
}

/**
 * The bytes of an element's content that are actually its words.
 *
 * Decorative children at either end are left out: the `<i></i>` that draws the
 * dot before an eyebrow renders nothing in an editor, so anybody typing over the
 * field would delete it without ever having seen it. Surrounding whitespace is
 * left out for the same reason in reverse — it is invisible in the control, and
 * writing the value back without it would close a gap the CSS relies on.
 */
function contentSpan(source: string, element: ElementNode): Span | null {
  let start = element.innerStart;
  let end = element.innerEnd;

  for (const child of element.children) {
    if (child.start >= end) break;
    if (source.slice(start, child.start).trim() !== "") break;
    if (!isEmpty(source, child)) break;
    start = child.end;
  }
  for (let i = element.children.length - 1; i >= 0; i -= 1) {
    const child = element.children[i]!;
    if (child.end <= start) break;
    if (source.slice(child.end, end).trim() !== "") break;
    if (!isEmpty(source, child)) break;
    end = child.start;
  }

  while (start < end && /\s/.test(source[start]!)) start += 1;
  while (end > start && /\s/.test(source[end - 1]!)) end -= 1;

  return end > start ? { start, end } : null;
}

/** Is this element a leaf as far as editable copy is concerned? */
function isField(source: string, element: ElementNode): boolean {
  if (textOf(source, element) === "") return false;
  // An image inside would put its attributes inside the span we are about to
  // hand somebody to type in. It gets its own field instead, so descend.
  if (hasDescendant(element, (child) => child.tag === "img")) return false;
  if (PROSE.has(element.tag)) return true;
  return !hasDescendant(element, (child) => BLOCK.has(child.tag) || child.tag === "a");
}

function firstLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function plain(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Where an element's inline style lives, and where one would go if it had none. */
function styleOf(element: ElementNode): Pick<SiteField, "style" | "styleSpan" | "attrInsert"> {
  const style = attrNode(element, "style");
  return {
    style: style?.value,
    styleSpan: style ? { start: style.valueStart, end: style.valueEnd } : undefined,
    attrInsert: element.attrInsert,
  };
}

function textField(source: string, element: ElementNode, id: string): SiteField | null {
  const span = contentSpan(source, element);
  if (!span) return null;
  const value = source.slice(span.start, span.end);
  const label = LABELS[element.tag] ?? (BUTTONISH.test(classOf(element)) ? "Button label" : "Text");
  return {
    id,
    kind: value.includes("<") ? "richtext" : "text",
    label,
    tag: element.tag,
    value,
    preview: firstLine(plain(value)),
    content: span,
    ...styleOf(element),
  };
}

function linkField(source: string, element: ElementNode, id: string): SiteField | null {
  const href = attrNode(element, "href");
  const span = contentSpan(source, element);
  if (!span && !href) return null;
  const value = span ? source.slice(span.start, span.end) : "";
  const label = BUTTONISH.test(classOf(element)) ? "Button" : "Link";
  return {
    id,
    kind: "link",
    label,
    tag: "a",
    value,
    preview: firstLine(plain(value)) || href?.value || "Link",
    href: href?.value ?? "",
    content: span ?? undefined,
    hrefSpan: href ? { start: href.valueStart, end: href.valueEnd } : undefined,
    ...styleOf(element),
  };
}

function imageField(element: ElementNode, id: string): SiteField | null {
  const src = attrNode(element, "src");
  if (!src) return null;
  const alt = attrNode(element, "alt");
  return {
    id,
    kind: "image",
    label: "Image",
    tag: "img",
    value: src.value,
    preview: alt?.value || src.value.split("/").pop() || "Image",
    alt: alt?.value,
    decorative: alt !== undefined && alt.value.trim() === "",
    srcSpan: { start: src.valueStart, end: src.valueEnd },
    altSpan: alt ? { start: alt.valueStart, end: alt.valueEnd } : undefined,
    altInsertAt: alt ? undefined : element.attrInsert,
    ...styleOf(element),
  };
}

/**
 * Walks one section and collects its fields.
 *
 * Depth-first, and a hit stops the descent: once a paragraph is a field, the
 * `<strong>` inside it is part of that paragraph and not a second field naming
 * the same words.
 */
function collect(source: string, element: ElementNode, out: SiteField[], sectionId: string): void {
  for (const child of element.children) {
    if (SKIP.has(child.tag)) continue;
    if (child.attrs.some((candidate) => candidate.name === "aria-hidden" && candidate.value === "true")) continue;
    if (child.attrs.some((candidate) => candidate.name === "hidden")) continue;

    const id = `${sectionId}.${out.length}`;
    if (child.tag === "img") {
      const field = imageField(child, id);
      if (field) out.push(field);
      continue;
    }
    if (child.tag === "a") {
      // An anchor around a whole card is a link, not a label. Its content span
      // would cover the headings and paragraphs inside it and hand somebody a
      // page of markup to type in — and on an anchor wrapping a picture it would
      // sit on top of the image's own attributes. Either way the destination
      // stays editable and the contents become fields in their own right.
      if (hasDescendant(child, (node) => node.tag === "img" || BLOCK.has(node.tag))) {
        const href = attrNode(child, "href");
        if (href) {
          out.push({
            id,
            kind: "link",
            label: "Link",
            tag: "a",
            value: "",
            preview: href.value || "Link",
            href: href.value,
            hrefSpan: { start: href.valueStart, end: href.valueEnd },
          });
        }
        collect(source, child, out, sectionId);
        continue;
      }
      const field = linkField(source, child, id);
      if (field) out.push(field);
      continue;
    }
    if (isField(source, child)) {
      const field = textField(source, child, id);
      if (field) out.push(field);
      continue;
    }
    collect(source, child, out, sectionId);
  }
}

/** A readable name for a section, preferring whatever heading it already carries. */
function sectionLabel(source: string, element: ElementNode, fields: SiteField[], index: number): string {
  if (element.tag === "header") return "Header and navigation";
  if (element.tag === "footer") return "Footer";
  const heading = findTag(element, ["h1", "h2", "h3"]);
  if (heading) {
    const text = firstLine(textOf(source, heading), 48);
    if (text) return text;
  }
  const firstWords = fields.find((field) => field.preview && field.kind !== "image");
  if (firstWords) return firstLine(firstWords.preview, 48);
  return `Section ${index + 1}`;
}

/** The title and search-result description, which live in `<head>` and have no section of their own. */
function metaSection(source: string, root: ElementNode): SiteSection | null {
  const fields: SiteField[] = [];
  const title = findTag(root, ["title"]);
  if (title && title.innerEnd > title.innerStart) {
    fields.push({
      id: "meta.0",
      kind: "text",
      label: "Browser tab and search result title",
      note: "The link-preview and social copies of this are generated. After publishing, run `npm run site` in the repository so they match.",
      tag: "title",
      value: source.slice(title.innerStart, title.innerEnd),
      preview: firstLine(decodeEntities(source.slice(title.innerStart, title.innerEnd))),
      content: { start: title.innerStart, end: title.innerEnd },
    });
  }
  for (const element of walk(root)) {
    if (element.tag !== "meta") continue;
    const name = element.attrs.find((candidate) => candidate.name === "name")?.value;
    if (name !== "description") continue;
    const content = attrNode(element, "content");
    if (!content) continue;
    fields.push({
      id: "meta.1",
      kind: "text",
      label: "Search result description",
      note: "The link-preview and social copies of this are generated. After publishing, run `npm run site` in the repository so they match.",
      tag: "meta",
      value: content.value,
      preview: firstLine(decodeEntities(content.value)),
      content: { start: content.valueStart, end: content.valueEnd },
    });
    break;
  }
  return fields.length ? { id: "meta", label: "Page details", kind: "meta", fields } : null;
}

/**
 * The parts of a page that a build script owns.
 *
 * This website generates its own `<head>` metadata and its visible breadcrumbs
 * — `scripts/build-seo.mjs` and `scripts/build-breadcrumbs.mjs` write everything
 * between a `BEGIN` and an `END` comment, and hand-editing inside them fails CI.
 * Offering those words to a client would be offering an edit that a script
 * silently reverts on the next `npm run site`, which is worse than not offering
 * it at all: the change works, goes live, and disappears a week later with
 * nothing to explain it.
 *
 * Keyed on the convention rather than on the two block names, so a third
 * generated block added later is excluded by existing.
 */
function generatedRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  // The name is greedy and stops at the first non-name character. A lazy capture
  // here matches the single letter "S" of "SEO", and the `END S` it then looks
  // for is never found — so the range runs to the end of the document and the
  // whole page reads as generated. It did exactly that.
  const opener = /<!--\s*BEGIN\s+([A-Z][A-Z0-9_-]*)[^>]*-->/g;
  for (const match of source.matchAll(opener)) {
    const name = match[1]!;
    const closer = new RegExp(`<!--\\s*END\\s+${name}(?![A-Z0-9_-])[^>]*-->`);
    const rest = source.slice(match.index! + match[0].length);
    const close = closer.exec(rest);
    ranges.push({
      start: match.index!,
      end: close ? match.index! + match[0].length + close.index + close[0].length : source.length,
    });
  }
  return ranges;
}

function withinGenerated(field: SiteField, ranges: Array<{ start: number; end: number }>): boolean {
  const spans = [field.content, field.hrefSpan, field.srcSpan, field.altSpan].filter(Boolean) as Span[];
  return spans.some((span) => ranges.some((range) => span.start >= range.start && span.end <= range.end));
}

/**
 * Reads a page into the sections and fields the editor shows.
 *
 * Sections are the outermost `<header>`, `<section>`, `<article>` and `<footer>`
 * elements — which is what the pages on this website are already built from.
 * Anything with editable words that falls outside all of them is gathered into a
 * final "Other content" section rather than being silently unreachable.
 */
export function readPage(source: string): PageContent {
  const root = parseHtml(source);
  const body = findTag(root, ["body"]) ?? root;
  const sections: SiteSection[] = [];

  const meta = metaSection(source, root);
  if (meta) sections.push(meta);

  const containers: ElementNode[] = [];
  const claimed = new Set<ElementNode>();
  for (const element of walk(body)) {
    if (!["header", "footer", "section", "article"].includes(element.tag)) continue;
    // Outermost only: a `<section>` inside a `<section>` is part of its parent.
    let ancestor = element.parent;
    let nested = false;
    while (ancestor) {
      if (claimed.has(ancestor)) {
        nested = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (nested) continue;
    claimed.add(element);
    containers.push(element);
  }

  containers.forEach((container, index) => {
    const id = `s${index}`;
    const fields: SiteField[] = [];
    collect(source, container, fields, id);
    if (!fields.length) return;
    const kind = container.tag === "header" ? "header" : container.tag === "footer" ? "footer" : "section";
    sections.push({ id, label: sectionLabel(source, container, fields, index), kind, fields });
  });

  // Editable words that sit in the body outside every section — a stray banner,
  // a page that was never wrapped. Collected so nothing on the page is invisible
  // to the person who owns it.
  const loose: SiteField[] = [];
  const collectLoose = (element: ElementNode) => {
    for (const child of element.children) {
      if (claimed.has(child) || SKIP.has(child.tag)) continue;
      if (["header", "footer", "section", "article"].includes(child.tag)) continue;
      const id = `loose.${loose.length}`;
      if (child.tag === "img") {
        const field = imageField(child, id);
        if (field) loose.push(field);
        continue;
      }
      if (child.tag === "a" && !hasDescendant(child, (node) => node.tag === "img")) {
        const field = linkField(source, child, id);
        if (field) loose.push(field);
        continue;
      }
      if (isField(source, child)) {
        const field = textField(source, child, id);
        if (field) loose.push(field);
        continue;
      }
      collectLoose(child);
    }
  };
  collectLoose(body);
  if (loose.length) sections.push({ id: "loose", label: "Other content", kind: "section", fields: loose });

  // Applied at the end rather than during the walk so that ids stay a function
  // of the document alone: the same page always yields the same id for the same
  // field, whether or not a generated block sits above it.
  const generated = generatedRanges(source);
  const kept = sections
    .map((section) => ({ ...section, fields: section.fields.filter((field) => !withinGenerated(field, generated)) }))
    .filter((section) => section.fields.length > 0);

  return { sections: kept, fields: kept.flatMap((section) => section.fields) };
}

/** Escapes a string for use inside a double-quoted attribute value. */
function attrEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(new RegExp(String.fromCharCode(34), "g"), "&quot;").replace(/</g, "&lt;");
}

/**
 * A style attribute, cut down to declarations that cannot do anything but style.
 *
 * The editor only ever sends declarations it built itself from its own
 * controls, so this is not what stops the editor misbehaving — it is what stops
 * a *draft* misbehaving. A draft is stored JSON that outlives the session that
 * wrote it, and this value is spliced into a page that is then published to the
 * public internet, so it is treated as untrusted on the way out like everything
 * else in `sanitize.ts`.
 *
 * `url(` goes because it loads a remote thing from a page with a strict CSP,
 * `expression(` because old IE ran it, and anything with a quote, angle bracket
 * or semicolon-escape in it because that is how you leave the attribute.
 */
const STYLE_PROPERTY = /^[a-z-]{2,40}$/;
const STYLE_FORBIDDEN = /url\s*\(|expression\s*\(|javascript:|[<>"'`\\]/i;

export function safeStyle(style: string): string {
  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon < 1) return false;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      return STYLE_PROPERTY.test(property) && value.length > 0 && value.length <= 120 && !STYLE_FORBIDDEN.test(declaration);
    })
    .join("; ");
}

export type ApplyResult = {
  html: string;
  /** Ids that were written. */
  changed: string[];
  /**
   * Ids whose stored `original` no longer matches the page, and which were left
   * alone. The page moved under the draft; somebody has to look.
   */
  conflicts: Array<{ id: string; expected: string; found: string }>;
  /** Ids in the draft that no longer exist on the page at all. */
  missing: string[];
};

/**
 * Writes a set of edits into a page and returns the new HTML.
 *
 * Every replacement is a splice at recorded offsets, applied from the end of the
 * document backwards so earlier offsets stay valid. Nothing else in the file is
 * touched — which is what makes a publish a readable diff instead of a
 * reformatting of somebody's whole page.
 */
export function applyValues(source: string, values: Record<string, FieldValue>): ApplyResult {
  const page = readPage(source);
  const byId = new Map(page.fields.map((field) => [field.id, field]));
  const edits: Array<{ span: Span; text: string } | { insertAt: number; text: string }> = [];
  const changed: string[] = [];
  const conflicts: ApplyResult["conflicts"] = [];
  const missing: string[] = [];

  for (const [id, edit] of Object.entries(values)) {
    const field = byId.get(id);
    if (!field) {
      missing.push(id);
      continue;
    }
    const moved =
      (edit.original !== undefined && edit.original !== field.value) ||
      (edit.originalHref !== undefined && edit.originalHref !== (field.href ?? "")) ||
      (edit.originalAlt !== undefined && edit.originalAlt !== (field.alt ?? "")) ||
      (edit.originalStyle !== undefined && edit.originalStyle !== (field.style ?? ""));
    if (moved) {
      conflicts.push({ id, expected: edit.original ?? edit.originalHref ?? edit.originalAlt ?? "", found: field.value });
      continue;
    }

    let touched = false;
    if (edit.value !== undefined && edit.value !== field.value) {
      if (field.kind === "image") {
        if (field.srcSpan) {
          edits.push({ span: field.srcSpan, text: attrEscape(edit.value) });
          touched = true;
        }
      } else if (field.content) {
        edits.push({ span: field.content, text: edit.value });
        touched = true;
      }
    }
    if (edit.href !== undefined && field.hrefSpan && edit.href !== field.href) {
      edits.push({ span: field.hrefSpan, text: attrEscape(edit.href) });
      touched = true;
    }
    if (edit.alt !== undefined && field.kind === "image" && edit.alt !== field.alt) {
      if (field.altSpan) edits.push({ span: field.altSpan, text: attrEscape(edit.alt) });
      else if (field.altInsertAt !== undefined) {
        edits.push({ insertAt: field.altInsertAt, text: ` alt="${attrEscape(edit.alt)}"` });
      }
      touched = true;
    }
    if (edit.style !== undefined && edit.style !== (field.style ?? "")) {
      const declarations = safeStyle(edit.style);
      if (field.styleSpan) {
        // An emptied style still leaves `style=""` behind rather than removing
        // the attribute: the span is what the next edit is written against, and
        // deleting it would move every offset after it.
        edits.push({ span: field.styleSpan, text: attrEscape(declarations) });
        touched = true;
      } else if (declarations && field.attrInsert !== undefined) {
        edits.push({ insertAt: field.attrInsert, text: ` style="${attrEscape(declarations)}"` });
        touched = true;
      }
    }
    if (touched) changed.push(id);
  }

  const positioned = edits
    .map((edit) => ("span" in edit ? { start: edit.span.start, end: edit.span.end, text: edit.text } : { start: edit.insertAt, end: edit.insertAt, text: edit.text }))
    .sort((a, b) => b.start - a.start);

  let html = source;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of positioned) {
    // Overlapping spans would corrupt the document. By construction they cannot
    // overlap — a field's descent stops where the next field begins — so this is
    // a guard against a future change to `collect`, not an expected case.
    if (edit.end > previousStart) throw new Error("Two edits overlap in the same page; refusing to write.");
    html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
    previousStart = edit.start;
  }

  return { html, changed, conflicts, missing };
}
