import { validFramingDeclaration } from "../../shared/websiteImageFraming.js";
import { regenerateInteractionStyles } from "./interaction.js";
import { createHash } from "node:crypto";
import { iconChoiceMarkup, type IconChoice, type IconFrame } from "../../shared/websiteIcons.js";
import { DOCUMENT_KEY, draftDocument, fieldValues, sourceHash, type DraftDocument } from "./document.js";
import { attrNode, decodeEntities, findTag, parseHtml, textOf, walk, type ElementNode } from "./parse.js";
import { normalizeResponsive, regenerateResponsiveStyles, responsiveEqual, responsiveOf, RESPONSIVE_TOKEN, type ResponsiveStyles } from "./responsive.js";

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
  /** A link inside a sentence: the words on it, and where it goes. */
  | "link"
  /**
   * A call to action styled as a button.
   *
   * The same two things a link has — words and a destination — plus the two a
   * button has and a link does not: which of the site's button styles it wears,
   * and whether it opens in a new tab. Those were unreachable before, so the
   * only way to turn the lime button on a page into the dark one was to edit
   * HTML, which is the thing this editor exists to avoid.
   */
  | "button"
  /** An image: which file, and the description read out to somebody who cannot see it. */
  | "image"
  /**
   * An inline `<svg>` drawn on the page by itself: a logo mark, a feature icon,
   * a social link's glyph. It used to be skipped entirely, because its children
   * are drawing instructions rather than words. It can be swapped for a library
   * icon or an image file, or removed, but its paths are never edited here.
   */
  | "icon"
  | "container";

type Span = { start: number; end: number };

export type SiteField = {
  id: string;
  /** Preview-only: selection remains available when source content is read-only. */
  previewReadOnly?: boolean;
  confidence?: "annotated" | "discovered";
  parentId?: string;
  /** Document order, without exposing source byte offsets. */
  order?: number;
  /** True when the element or its parent carries data-dw-repeatable. */
  repeatable?: boolean;
  srcsetSpan?: Span;
  markerSpan?: Span;
  structure?: string;
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
  /** Element overrides at tablet and phone widths, separate from base styles. */
  responsive?: ResponsiveStyles;
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

  // --- Buttons only --------------------------------------------------------

  /**
   * The style class this button wears — `btn-primary`, `btn-dark`.
   *
   * Recognised structurally rather than from a list of names: a button has a
   * variant when it carries both `X` and `X-something`, so `class="btn
   * btn-primary"` has stem `btn` and variant `btn-primary`, and
   * `class="category-btn"` has neither because nothing on it carries `category`.
   *
   * That rule is what makes changing one safe without this module holding a
   * vocabulary of somebody else's design system. A variant can only ever be
   * swapped for another token under the same stem, so the worst a client can do
   * is name a style their own stylesheet does not define — visible, reversible,
   * and in their own namespace. Free-text class editing, which is what a naive
   * version of this feature is, could reach `hidden` or any utility class on
   * the page.
   */
  variant?: string;
  /** The stem the variant hangs off, and the only prefix a new one may use. */
  variantStem?: string;
  /** Every variant of this stem worn by a button anywhere on this page. */
  variantsOnPage?: string[];
  /**
   * The button's class attribute, as written.
   *
   * Carried so that the style menu can be widened from the site's stylesheet
   * without re-parsing the page: a button wearing only `btn` has no variant to
   * read a stem off, and it is exactly the button somebody wants to *give* a
   * style to. Public information — the page is on the internet.
   */
  classes?: string;
  classSpan?: Span;
  /** True when `target` is `_blank`. */
  newTab?: boolean;
  /** Whole-attribute spans, because turning a new tab off has to remove them. */
  targetAttr?: Span;
  relAttr?: Span;
  /** What `rel` says now, so tokens that are nothing to do with us survive. */
  rel?: string;

  // --- Icons: an icon field, or a button that has (or could have) one -------

  /** The icon as the page writes it, for the editor to draw a preview of. */
  icon?: string;
  /** The whole icon element: what a swap replaces. */
  iconSpan?: Span;
  /** Which side of a button's words the icon sits on. */
  iconPosition?: "start" | "end";
  /** How the page draws it, which decides what the editor can say about it. */
  iconType?: "svg" | "img" | "font";
  /** Class and size carried from the icon being replaced onto its replacement. */
  iconFrame?: IconFrame;
  /** A button with words and no icon, which may be given one. */
  iconAddable?: boolean;
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
  /** Server-owned document checkpoint; never accepted from draft request JSON. */
  document?: DraftDocument;
  originalStructure?: string;
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
  /** Complete override map when supplied; an empty map clears every override. */
  responsive?: ResponsiveStyles;
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
  originalResponsive?: ResponsiveStyles;

  /**
   * A button's style class. `null` takes the variant off without adding one,
   * which is the only way back to a plain unstyled button.
   */
  variant?: string | null;
  /** Whether this button opens in a new tab. Writes `rel` with it, always. */
  newTab?: boolean;
  originalVariant?: string;
  originalNewTab?: boolean;

  /**
   * A new icon, by library name or image address, or `null` to take the icon
   * away. Never markup: the server turns the choice into markup itself.
   */
  icon?: IconChoice | null;
  /** Which side a newly added icon goes on. Ignored when one is being replaced. */
  iconPosition?: "start" | "end";
  originalIcon?: string;
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

const BUTTONISH_WORD = /\b(btn|button|cta|primary|secondary|action)\b/i;
/**
 * A utility class that names a colour, not a component: `text-primary`,
 * `hover:bg-secondary`. Tailwind sites put "primary" on every nav link, and
 * reading that as "this is a button" made the whole menu into buttons.
 */
const COLOUR_UTILITY = /^(?:text|bg|border|ring|from|via|to|fill|stroke|outline|decoration|shadow|placeholder|divide|accent|caret)-/;
const BUTTONISH = {
  test(cls: string): boolean {
    return cls.split(/\s+/).some((token) => {
      const base = token.slice(token.lastIndexOf(":") + 1);
      return !COLOUR_UTILITY.test(base) && BUTTONISH_WORD.test(base);
    });
  },
};

function classOf(element: ElementNode): string {
  return element.attrs.find((candidate) => candidate.name === "class")?.value ?? "";
}

function classTokens(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

/**
 * Which of a button's classes is its style, and what prefix a new one may use.
 *
 * Structural, and that is the whole safety argument. A button carries `btn` and
 * `btn-primary`; the first is the stem it shares with every other button on the
 * site and the second is the one that decides how it looks. Recognising the
 * pair this way means changing a style can only ever produce another token
 * under the same stem — the editor never sends a class list, and there is no
 * vocabulary of somebody else's design system to keep in step.
 *
 * `class="category-btn"` gets nothing, correctly: nothing on that element
 * carries `category`, so `category-btn` is a name, not a modifier of anything.
 *
 * The longest matching stem wins, so `card` and `card-title` on one element
 * pick `card-title-*` over `card-*` rather than whichever came first.
 */
export function variantOf(classValue: string): { stem: string; variant: string } | null {
  const tokens = classTokens(classValue);
  const carried = new Set(tokens);
  let best: { stem: string; variant: string } | null = null;
  for (const token of tokens) {
    const cut = token.lastIndexOf("-");
    if (cut <= 0) continue;
    for (let at = token.length - 1; at > 0; at -= 1) {
      if (token[at] !== "-") continue;
      const stem = token.slice(0, at);
      if (!carried.has(stem)) continue;
      if (!best || stem.length > best.stem.length) best = { stem, variant: token };
      break;
    }
  }
  return best;
}

/** Only `btn-something`, and only characters a class may contain. */
export function isVariantOfStem(stem: string, candidate: string): boolean {
  return candidate.startsWith(`${stem}-`) && candidate.length > stem.length + 1 && /^[A-Za-z0-9_-]+$/.test(candidate);
}

/**
 * The one rule for what a style change may do to a class list.
 *
 * The stem is taken from the **requested** style rather than from whatever the
 * button already wears, and that is what lets a button carrying only `btn` be
 * given `btn-primary`. The safety property is unchanged and is the whole point:
 * a style is only accepted when the element already carries the class it hangs
 * off, so from `class="btn"` you can reach `btn-anything` and nothing else —
 * never `hidden`, never a utility class from elsewhere on the page.
 *
 * Returns null when the request is not allowed, and the caller writes nothing.
 * Refusing is deliberately not the same as writing a fallback: a style that
 * silently became a different style is worse than one that did not change.
 */
export function resolveVariantChange(classValue: string, requested: string | null): { from: string | null; to: string | null } | null {
  const tokens = classTokens(classValue);
  const carried = new Set(tokens);

  if (requested === null) {
    const found = variantOf(classValue);
    return found ? { from: found.variant, to: null } : null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(requested)) return null;

  // The longest carried class the request extends. Longest so that `card` and
  // `card-title` on one element resolve `card-title-wide` against the specific
  // one rather than the general one.
  let stem: string | null = null;
  for (let at = requested.length - 1; at > 0; at -= 1) {
    if (requested[at] !== "-") continue;
    const candidate = requested.slice(0, at);
    if (carried.has(candidate) && (!stem || candidate.length > stem.length)) stem = candidate;
  }
  if (!stem) return null;
  if (carried.has(requested)) return null; // already wearing it

  // Anything else under the same stem comes off, so a button cannot end up
  // wearing two colours at once.
  const from = tokens.find((token) => token !== stem && isVariantOfStem(stem!, token)) ?? null;
  return { from, to: requested };
}

/**
 * A class list with one variant swapped for another, and everything else kept.
 *
 * `mt-9` on a button is a developer's spacing decision and has nothing to do
 * with which colour somebody picked, so it survives. The order of the remaining
 * tokens survives too — a diff on a publish should show the one word that
 * changed.
 */
export function withVariant(classValue: string, change: { from: string | null; to: string | null }): string {
  const tokens = classTokens(classValue);
  const without = change.from ? tokens.filter((token) => token !== change.from) : tokens;
  if (change.to === null) return without.join(" ");
  // Put it back where the old one was, so a diff reads as one word replaced
  // rather than as a reordered attribute.
  const at = change.from ? tokens.indexOf(change.from) : -1;
  if (at === -1) return [...without, change.to].join(" ");
  return [...without.slice(0, at), change.to, ...without.slice(at)].join(" ");
}

/** `btn-primary` under stem `btn` reads as "Primary". */
export function variantLabel(stem: string, variant: string): string {
  const word = variant.slice(stem.length + 1).replace(/[-_]+/g, " ").trim();
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : variant;
}

const NEW_TAB_REL = ["noopener", "noreferrer"];

/**
 * The two attributes that open a link in a new tab, read as one fact.
 *
 * They are written as one fact too — see `applyValues`. `target="_blank"`
 * without `rel="noopener"` hands the page it opens a live handle on the one it
 * came from, and nobody choosing "open in a new tab" is choosing that. There is
 * no control anywhere in this editor that can produce one without the other.
 */
function newTabOf(element: ElementNode): Pick<SiteField, "newTab" | "targetAttr" | "relAttr" | "rel"> {
  const target = attrNode(element, "target");
  const rel = attrNode(element, "rel");
  return {
    newTab: target?.value.trim().toLowerCase() === "_blank",
    targetAttr: target ? { start: target.start, end: target.end } : undefined,
    relAttr: rel ? { start: rel.start, end: rel.end } : undefined,
    rel: rel?.value,
  };
}

/** Everything a button field carries beyond what a link does. */
/** An element that is a picture rather than words: what a button's icon is. */
function iconType(source: string, element: ElementNode): SiteField["iconType"] | null {
  if (element.tag === "svg") return "svg";
  if (isLigatureIcon(source, element)) return "font";
  if (element.tag === "img") return "img";
  // `<i class="fa fa-phone"></i>`, `<span class="icon-arrow"></span>`: an icon
  // font or a CSS-drawn glyph. Empty is the test, not the class name, because
  // there is no vocabulary of icon classes to trust.
  if ((element.tag === "i" || element.tag === "span") && textOf(source, element) === "" && element.children.every((child) => child.tag === "svg" || child.tag === "img")) {
    return element.children.length ? iconType(source, element.children[0]!) : "font";
  }
  return null;
}

function iconFrameOf(element: ElementNode): IconFrame {
  const cls = attrNode(element, "class")?.value.trim();
  let width = attrNode(element, "width")?.value.trim();
  let height = attrNode(element, "height")?.value.trim();
  const style = attrNode(element, "style")?.value ?? "";
  if (!width) {
    const wm = /width\s*:\s*([^;]+)/i.exec(style);
    if (wm) width = wm[1]!.trim();
  }
  if (!height) {
    const hm = /height\s*:\s*([^;]+)/i.exec(style);
    if (hm) height = hm[1]!.trim();
  }
  if (!width && cls && /\bbrand-face\b/i.test(cls)) width = "47px";
  if (!height && cls && /\bbrand-face\b/i.test(cls)) height = "35px";

  // Elements that are CSS drawings or icon fonts (brand-face, fa-*, etc.) carry pseudo-element
  // drawings (::before, ::after) and glyph font families. Do not pass drawing class names onto
  // replacement <img> or <svg> icons, otherwise their custom borders and pseudo-elements collide.
  const isDrawingClass = cls && /\b(?:brand-face|brand-logo|logo-drawing|fa-|bi-|ti-|ri-|mdi-|las-|lab-|glyphicon-)\b/i.test(cls);
  const safeClass = isDrawingClass ? undefined : cls;
  return { ...(safeClass ? { className: safeClass } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

/**
 * The icon at either edge of a button's words, if it has one.
 *
 * Only a child *outside* the words is an icon. `contentSpan` already steps
 * over an empty element at either end, so an arrow drawn after "Book a call"
 * is not part of what somebody types in, and it is exactly the thing they may
 * want to change. A picture in the middle of the words stays part of them.
 */
function buttonIcon(source: string, element: ElementNode, content: Span | null): Partial<SiteField> {
  const leading = element.children.filter((child) => !content || child.end <= content.start);
  const trailing = element.children.filter((child) => content && child.start >= content.end);
  for (const [candidates, position] of [[leading, "start"], [trailing, "end"]] as const) {
    for (const child of position === "start" ? candidates : [...candidates].reverse()) {
      const type = iconType(source, child);
      if (!type) continue;
      return {
        icon: source.slice(child.start, child.end),
        iconSpan: { start: child.start, end: child.end },
        iconPosition: content ? position : "start",
        iconType: type,
        iconFrame: iconFrameOf(child),
      };
    }
  }
  return content ? { iconAddable: true } : {};
}

function buttonBits(element: ElementNode): Partial<SiteField> {
  const classAttr = element.attrs.find((candidate) => candidate.name === "class");
  const found = classAttr ? variantOf(classAttr.value) : null;
  return {
    ...(found ? { variant: found.variant, variantStem: found.stem } : {}),
    ...(classAttr ? { classes: classAttr.value, classSpan: { start: classAttr.valueStart, end: classAttr.valueEnd } } : {}),
    ...newTabOf(element),
  };
}

/**
 * A ligature icon: `<span class="material-symbols-outlined">arrow_forward</span>`.
 * Its text is the icon's *name*, which a font draws as a picture. A reader sees
 * an arrow, not the word, so it is an icon and not part of anybody's words.
 */
const LIGATURE_ICON = /\bmaterial-(?:symbols|icons)(?:-[a-z]+)?\b/i;
function isLigatureIcon(source: string, element: ElementNode): boolean {
  return (element.tag === "span" || element.tag === "i") && LIGATURE_ICON.test(classOf(element)) && /^[a-z0-9_]{1,60}$/.test(textOf(source, element)) && element.children.length === 0;
}

/** True when nothing inside this element renders any words. */
function isEmpty(source: string, element: ElementNode): boolean {
  if (isLigatureIcon(source, element)) return true;
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
  // When a non-prose container (such as <div class="brand-type"> or a pill list)
  // wraps 2+ element children with no bare text outside those children, descend
  // so each child (e.g. <strong>NEVERMIND</strong> and <span>awesome bar & eatery</span>)
  // is individually selectable and editable, while the wrapper becomes a layout container.
  if (element.tag === "div" && element.children.length >= 2) {
    let cursor = element.innerStart;
    let hasBareWords = false;
    for (const child of element.children) {
      if (source.slice(cursor, child.start).replace(/<!--[\s\S]*?-->/g, "").trim() !== "") {
        hasBareWords = true;
        break;
      }
      cursor = child.end;
    }
    if (!hasBareWords && source.slice(cursor, element.innerEnd).replace(/<!--[\s\S]*?-->/g, "").trim() === "") {
      return false;
    }
  }
  // A <button> inside is its own field, like a link: otherwise the wrapper's
  // words would be the button's markup, and typing over them would erase it.
  return !hasDescendant(element, (child) => BLOCK.has(child.tag) || child.tag === "a" || child.tag === "button");
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
  const cls = `${classOf(element)} ${element.parent ? classOf(element.parent) : ""}`;
  const isCarousel = /\b(?:ticker|carousel|marquee|slider|slides)\b/i.test(cls);
  const label = isCarousel
    ? "Carousel / Ticker"
    : (LABELS[element.tag] ?? (BUTTONISH.test(classOf(element)) ? "Button label" : "Text"));
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
  const isButton = BUTTONISH.test(classOf(element));
  return {
    id,
    kind: isButton ? "button" : "link",
    label: isButton ? "Button" : "Link",
    tag: "a",
    value,
    preview: firstLine(plain(value)) || href?.value || "Link",
    href: href?.value ?? "",
    content: span ?? undefined,
    hrefSpan: href ? { start: href.valueStart, end: href.valueEnd } : undefined,
    ...styleOf(element),
    ...(isButton ? buttonBits(element) : {}),
    ...(isButton ? buttonIcon(source, element, span) : {}),
  };
}

/**
 * A `<button>`, which is a button with nowhere to go.
 *
 * It was already editable — its words came through as an ordinary text field —
 * and that is most of what anybody needs from one, because where a `<button>`
 * leads is decided by script rather than by an address. What it did not have
 * was the style switch, which is the same decision on the same kind of thing:
 * the filter chips on the insights page are `<button>` and the calls to action
 * beside them are `<a>`, and it would be strange for one to be restylable and
 * the other not.
 */
function buttonElementField(source: string, element: ElementNode, id: string): SiteField | null {
  const span = contentSpan(source, element);
  if (!span) return null;
  const value = source.slice(span.start, span.end);
  return {
    id,
    kind: "button",
    label: "Button",
    tag: "button",
    value,
    preview: firstLine(plain(value)),
    content: span,
    ...styleOf(element),
    ...buttonBits(element),
    ...buttonIcon(source, element, span),
    // A `<button>` has no destination and no tab to open, so neither is offered.
    newTab: undefined,
    targetAttr: undefined,
    relAttr: undefined,
  };
}

function imageField(element: ElementNode, id: string): SiteField | null {
  const src = attrNode(element, "src");
  if (!src) return null;
  const alt = attrNode(element, "alt");
  const srcset = attrNode(element, "srcset");
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
    ...(srcset ? { srcsetSpan: { start: srcset.valueStart, end: srcset.valueEnd }, structure: createHash("sha256").update(srcset.value).digest("hex"), note: "Replacing this image also replaces its responsive image candidates." } : {}),
    altSpan: alt ? { start: alt.valueStart, end: alt.valueEnd } : undefined,
    altInsertAt: alt ? undefined : element.attrInsert,
    ...styleOf(element),
  };
}

/**
 * A font icon standing by itself: `<span class="material-symbols-outlined">
 * local_shipping</span>`, or a box holding only that. It used to be offered as
 * its name, to be typed over. It is an icon, in the same id slot it had.
 */
function fontIconField(source: string, element: ElementNode, id: string): SiteField | null {
  const only = element.children.length === 1 ? element.children[0]! : null;
  const ligature = isLigatureIcon(source, element)
    ? element
    : only && isLigatureIcon(source, only) && source.slice(element.innerStart, element.innerEnd).trim() === source.slice(only.start, only.end)
      ? only
      : null;
  if (!ligature) return null;
  return {
    id,
    kind: "icon",
    label: "Icon",
    tag: ligature.tag,
    value: "",
    preview: textOf(source, ligature).replace(/_/g, " "),
    icon: source.slice(ligature.start, ligature.end),
    iconSpan: { start: ligature.start, end: ligature.end },
    iconType: "font",
    iconFrame: iconFrameOf(ligature),
    ...styleOf(ligature),
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
    if (child.attrs.some((candidate) => candidate.name === "hidden")) continue;
    // Only skip aria-hidden on empty scroll-progress indicators; visible carousels,
    // tickers (`<div class="ticker" aria-hidden="true">`), and logo icons
    // (`<div class="brand-face" aria-hidden="true">`) must remain selectable and editable.
    if (
      child.attrs.some((candidate) => candidate.name === "aria-hidden" && candidate.value === "true") &&
      /\bpage-progress\b/i.test(classOf(child))
    ) {
      continue;
    }

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
          const cls = classOf(child);
          const isBrand = /\b(?:brand|logo)\b/i.test(cls);
          out.push({
            id,
            kind: "link",
            label: isBrand ? "Brand Link" : "Link",
            tag: "a",
            value: "",
            preview: firstLine(textOf(source, child), 36) || href.value || "Link",
            href: href.value,
            hrefSpan: { start: href.valueStart, end: href.valueEnd },
            ...styleOf(child),
          });
        }
        collect(source, child, out, sectionId);
        continue;
      }
      const field = linkField(source, child, id);
      if (field) out.push(field);
      continue;
    }
    if (child.tag === "button" && textOf(source, child) !== "" && !hasDescendant(child, (node) => node.tag === "img")) {
      const field = buttonElementField(source, child, id);
      if (field) out.push(field);
      continue;
    }
    const fontIcon = fontIconField(source, child, id);
    if (fontIcon) {
      out.push(fontIcon);
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
      // A link around a whole card: its destination is a field, and what is in
      // it is fields of their own. As one field, its words were the card's markup.
      if (child.tag === "a" && hasDescendant(child, (node) => BLOCK.has(node.tag))) {
        const href = attrNode(child, "href");
        if (href) {
          loose.push({
            id,
            kind: "link",
            label: "Link",
            tag: "a",
            value: "",
            preview: firstLine(textOf(source, child), 36) || href.value || "Link",
            href: href.value,
            hrefSpan: { start: href.valueStart, end: href.valueEnd },
            ...styleOf(child),
          });
        }
        collectLoose(child);
        continue;
      }
      if (child.tag === "a" && !hasDescendant(child, (node) => node.tag === "img")) {
        const field = linkField(source, child, id);
        if (field) loose.push(field);
        continue;
      }
      // The same two cases the section walk has: a <button> is a button, and a
      // font icon is an icon rather than a word to type over.
      if (child.tag === "button" && textOf(source, child) !== "" && !hasDescendant(child, (node) => node.tag === "img")) {
        const field = buttonElementField(source, child, id);
        if (field) loose.push(field);
        continue;
      }
      const fontIcon = fontIconField(source, child, id);
      if (fontIcon) {
        loose.push(fontIcon);
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
  const nodes = [...walk(body)];
  const byOffset = new Map(nodes.map((node) => [node.attrInsert, node]));
  const hiddenNode = (node: ElementNode | undefined): boolean => {
    for (let at = node; at; at = at.parent ?? undefined) {
      if (SKIP.has(at.tag) || at.attrs.some(a => a.name === "hidden")) return true;
      if (at.attrs.some(a => a.name === "aria-hidden" && a.value.trim().toLowerCase() === "true") && /\bpage-progress\b/i.test(classOf(at))) {
        return true;
      }
    }
    return false;
  };
  const kept = sections
    .map((section) => ({ ...section, fields: section.fields.filter((field) => !withinGenerated(field, generated) && !hiddenNode(field.attrInsert === undefined ? undefined : byOffset.get(field.attrInsert))) }))
    .filter((section) => section.fields.length > 0);

  const all = kept.flatMap((section) => section.fields);

  // Inline SVG drawn by itself. Its own namespace (`icon.N`), for the same
  // reason as the layout fields below: slotting new fields into the content
  // numbering would move every id after them and retarget older drafts.
  // An SVG inside somebody's words is part of those words, and one at the edge
  // of a button belongs to that button, so neither is offered twice.
  const iconClaims = all.flatMap((field) => [field.content, field.iconSpan].filter((span): span is Span => Boolean(span)));
  const icons: SiteField[] = [];
  for (const node of nodes) {
    const cls = classOf(node);
    const isSvg = node.tag === "svg";
    const isFontIcon = (node.tag === "i" || node.tag === "span") && /\b(?:fa|bi|icon|ti|ri|mdi|las|lab|glyphicon)-/i.test(cls);
    const isLogoOrIconElement = /\b(?:brand-face|brand-logo|logo|brand-icon|icon|badge|avatar|mark|emblem|icon-wrap|logo-wrap)\b/i.test(cls) || attrNode(node, "role")?.value === "img" || attrNode(node, "data-dw-icon") !== undefined;
    const hasBgImg = /background-image\s*:\s*url\(/i.test(attrNode(node, "style")?.value ?? "");

    const isCandidate = isSvg || isFontIcon || ((isLogoOrIconElement || hasBgImg) && plain(textOf(source, node)) === "");
    if (!isCandidate) continue;
    if (hiddenNode(node.parent ?? undefined)) continue;
    if (generated.some((range) => node.start >= range.start && node.end <= range.end)) continue;
    if (iconClaims.some((span) => node.start >= span.start && node.end <= span.end)) continue;

    const isBrand = /\b(?:brand|logo)\b/i.test(cls);
    const named = attrNode(node, "aria-label")?.value.trim() || (isSvg ? textOf(source, node).slice(0, 60) : "");
    const defaultLabel = isBrand
      ? `Logo / Icon (${cls.split(/\s+/)[0] || node.tag})`
      : `${isSvg ? "Icon" : "Graphic / Icon"} (${cls.split(/\s+/)[0] || node.tag})`;
    const label = named || defaultLabel;

    const iconType = isSvg ? "svg" : node.tag === "img" || hasBgImg ? "img" : isFontIcon ? "font" : "svg";
    const span = { start: node.start, end: node.end };

    icons.push({
      id: `icon.${icons.length}`,
      kind: "icon",
      label,
      tag: node.tag,
      value: source.slice(node.start, node.end),
      preview: named || label,
      structure: createHash("sha256").update(source.slice(node.start, node.end)).digest("hex"),
      icon: source.slice(node.start, node.end),
      iconSpan: span,
      iconType,
      iconFrame: iconFrameOf(node),
      ...styleOf(node),
    });
    iconClaims.push(span);
  }
  if (icons.length) {
    kept.push({ id: "icons", label: "Icons", kind: "section", fields: icons });
    all.push(...icons);
  }

  // Keep the old content numbering intact: layout fields use a separate
  // namespace, so opening an older saved draft cannot retarget its edits.
  const represented = new Set(all.map((field) => field.attrInsert));
  const layout: SiteField[] = [];
  const layoutTags = new Set(["main", "header", "footer", "section", "article", "div", "nav", "aside", "ul", "ol", "figure", "svg"]);
  for (const node of nodes) {
    const cls = classOf(node);
    const isIconElement = (node.tag === "i" || node.tag === "span") && /\b(?:brand-face|logo|icon|badge|avatar|mark|emblem)\b/i.test(cls);
    if (!layoutTags.has(node.tag) && !isIconElement) continue;
    if (represented.has(node.attrInsert)) continue;
    if (hiddenNode(node) || generated.some((range) => node.start >= range.start && node.end <= range.end)) continue;
    const isCarousel = /\b(?:ticker|carousel|marquee|slider|slides)\b/i.test(cls);
    const isLogoIcon = node.tag === "svg" || /\b(?:brand-face|logo|brand-icon|icon|avatar|emblem)\b/i.test(cls);
    if (isLogoIcon && plain(textOf(source, node)) === "") continue;
    const isStickyHeader = node.tag === "header" || /\b(?:sticky|navbar|site-header|announcement)\b/i.test(cls);
    const defaultLabel = isCarousel
      ? `Carousel / Ticker`
      : isLogoIcon
        ? `Logo / Icon (${cls.split(/\s+/)[0] || node.tag})`
        : isStickyHeader
          ? `Header (${attrNode(node, "id")?.value || cls.split(/\s+/)[0] || node.tag})`
          : `${node.tag === "div" ? "Container" : node.tag} ${layout.length + 1}`;
    const label = attrNode(node, "aria-label")?.value || attrNode(node, "id")?.value || defaultLabel;
    layout.push({ id: `layout.${layout.length}`, kind: "container", tag: node.tag, label, value: "", structure: createHash("sha256").update(source.slice(node.start, node.end)).digest("hex"), preview: label, ...styleOf(node) });
  }
  if (body !== root && body.tag === "body" && !represented.has(body.attrInsert)) {
    layout.push({
      id: `layout.${layout.length}`,
      kind: "container",
      tag: "body",
      label: "Page Body & Theme",
      value: "",
      structure: createHash("sha256").update(source.slice(body.start, body.end)).digest("hex"),
      preview: "Page Body & Theme",
      ...styleOf(body),
    });
  }
  if (layout.length) {
    kept.push({ id: "layout", label: "Layout and containers", kind: "section", fields: layout });
    all.push(...layout);
  }
  const markers = new Map<string, number>();
  const nodeMarkers = new Map<string, number>();
  for (const node of nodes) {
    const key = attrNode(node, "data-dw-field")?.value;
    if (key) markers.set(key, (markers.get(key) ?? 0) + 1);
    const nodeKey = attrNode(node, "data-dw-node")?.value;
    if (nodeKey) nodeMarkers.set(nodeKey, (nodeMarkers.get(nodeKey) ?? 0) + 1);
  }
  const positional = new Set(all.map((field) => field.id));
  const fieldAt = new Map<number, SiteField>();
  for (const field of all) {
    const node = field.attrInsert === undefined ? undefined : byOffset.get(field.attrInsert);
    const marker = node && attrNode(node, "data-dw-field");
    if (node && attrNode(node, "data-dw-responsive")) field.responsive = responsiveOf(node);
    if (node && (attrNode(node, "data-dw-repeatable") || (node.parent && attrNode(node.parent, "data-dw-repeatable")))) field.repeatable = true;
    field.confidence = "discovered";
    if (marker) {
      field.markerSpan = { start: marker.start, end: marker.end };
      if (/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(marker.value) && markers.get(marker.value) === 1 && !positional.has(marker.value)) {
        field.id = marker.value;
        field.confidence = "annotated";
      } else {
        field.note = "This element's marker is duplicated or reserved. Its position will be checked before publishing.";
      }
    }
    const nodeKey = node && attrNode(node, "data-dw-node")?.value;
    if (nodeKey && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(nodeKey) && nodeMarkers.get(nodeKey) === 1) {
      field.id = nodeKey;
      field.confidence = "annotated";
    }
    if (node && field.tag !== "body") fieldAt.set(node.attrInsert, field);
  }
  for (const field of all) {
    let parent = field.attrInsert === undefined ? undefined : byOffset.get(field.attrInsert)?.parent;
    while (parent) {
      const parentField = fieldAt.get(parent.attrInsert);
      if (parentField) { field.parentId = parentField.id; break; }
      parent = parent.parent;
    }
  }
  offerVariants(all);
  [...all].sort((a, b) => (a.attrInsert ?? a.content?.start ?? 0) - (b.attrInsert ?? b.content?.start ?? 0)).forEach((field, order) => { field.order = order; });
  return { sections: kept, fields: all };
}

/**
 * Tells every button which other styles its own page already uses.
 *
 * Read off the page rather than out of a stylesheet, and that is a real limit
 * worth stating: a variant defined in CSS and used nowhere on this page is not
 * offered here. The alternative is fetching and parsing somebody's stylesheet
 * to build a menu, which makes the field list depend on a second network read
 * and on guessing which of a site's classes are meant to be interchangeable.
 *
 * What is offered is therefore always true — every one of these is a style this
 * page is already wearing somewhere, so picking it cannot produce a button the
 * stylesheet has no rule for. Typing a style the page does not use is still
 * possible and still safe (see `variantOf`); it is just not a menu item.
 */
function offerVariants(fields: SiteField[]): void {
  const byStem = new Map<string, Set<string>>();
  for (const field of fields) {
    if (!field.variantStem || !field.variant) continue;
    const seen = byStem.get(field.variantStem) ?? new Set<string>();
    seen.add(field.variant);
    byStem.set(field.variantStem, seen);
  }
  for (const field of fields) {
    if (!field.variantStem) continue;
    const seen = byStem.get(field.variantStem);
    if (seen) field.variantsOnPage = [...seen].sort();
  }
}

function relTokens(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/).map((token) => token.toLowerCase()).filter(Boolean);
}

/**
 * An attribute's span, widened to swallow the space in front of it.
 *
 * Removing `target="_blank"` on its own leaves `<a  href=…>` — harmless, and
 * the kind of thing that turns a one-line diff into a line somebody has to look
 * twice at. Only one space is taken, so an attribute a developer put on its own
 * line keeps its indentation.
 */
function withLeadingSpace(source: string, span: Span): Span {
  return span.start > 0 && source[span.start - 1] === " " ? { start: span.start - 1, end: span.end } : span;
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
const STYLE_PROPERTY = /^(?:--[a-z0-9_-]{1,48}|[a-z-]{2,40})$/i;
const STYLE_FORBIDDEN = /url\s*\(|expression\s*\(|javascript:|[<>"'`\\]/i;
const SAFE_SITE_ASSET_BG = /^url\(\s*['"]?(?:\/[a-zA-Z0-9/._%-]+|data:image\/(?:png|jpeg|jpg|webp|gif|avif|svg\+xml);base64,[a-zA-Z0-9+/=]+|https?:\/\/(?:images\.unsplash\.com\/[a-zA-Z0-9/._?=&%-]+|[a-zA-Z0-9/._:-]+\.(?:jpg|jpeg|png|webp|gif|avif|svg)(?:\?[a-zA-Z0-9=&_%-]*)?))['"]?\s*\)$/i;

export function safeStyle(style: string, originalStyle = ""): string {
  const original = new Set(originalStyle.split(";").map(part => part.trim()).filter(Boolean));
  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon < 1) return false;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      const isSafeAssetBg = (property === "background-image" || property === "background") && SAFE_SITE_ASSET_BG.test(value);
      // Preserve a developer's existing background URL or quoted CSS exactly
      // while editing other controls. Newly supplied fetching CSS stays forbidden
      // except for safe image assets (/assets/dw/, local / paths, data:image, or image extensions).
      return original.has(declaration) || (validFramingDeclaration(property, value) && STYLE_PROPERTY.test(property) && value.length > 0 && value.length <= (isSafeAssetBg ? 2048 : 120) && (!STYLE_FORBIDDEN.test(declaration) || (property === "font-family" && /^[a-zA-Z0-9 ,\x22\x27-]+$/.test(value)) || isSafeAssetBg));
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
  const document = draftDocument(values);
  if (document) {
    if (document.baseHash !== sourceHash(source)) return { html: source, changed: [], missing: [], conflicts: [{ id: DOCUMENT_KEY, expected: "The original page used for these layout changes", found: "The source changed. Discard the layout draft or restore it against the latest page before publishing." }] };
    const applied = applyValues(document.html, fieldValues(values));
    return { ...applied, changed: document.html !== source ? [DOCUMENT_KEY, ...applied.changed] : applied.changed };
  }
  const page = readPage(source);
  const byId = new Map(page.fields.map((field) => [field.id, field]));
  const edits: Array<{ span: Span; text: string } | { insertAt: number; text: string }> = [];
  const changed: string[] = [];
  const conflicts: ApplyResult["conflicts"] = [];
  const missing: string[] = [];
  const responsiveNodes = Object.values(values).some((edit) => edit.responsive !== undefined)
    ? [...walk(parseHtml(source))] : [];
  const responsiveNodeAt = new Map(responsiveNodes.map((node) => [node.attrInsert, node]));
  const tokenCounts = new Map<string, number>();
  for (const node of responsiveNodes) {
    for (const attr of node.attrs.filter((candidate) => candidate.name === "data-dw-style")) {
      tokenCounts.set(attr.value, (tokenCounts.get(attr.value) ?? 0) + 1);
    }
  }
  let responsiveChanged = false;

  for (const [id, edit] of Object.entries(values)) {
    const field = byId.get(id);
    if (!field) {
      missing.push(id);
      continue;
    }
    const moved =
      (edit.originalStructure !== undefined && edit.originalStructure !== field.structure) ||
      (edit.original !== undefined && edit.original !== field.value) ||
      (edit.originalHref !== undefined && edit.originalHref !== (field.href ?? "")) ||
      (edit.originalAlt !== undefined && edit.originalAlt !== (field.alt ?? "")) ||
      (edit.originalStyle !== undefined && edit.originalStyle !== (field.style ?? "")) ||
      (edit.originalResponsive !== undefined && !responsiveEqual(edit.originalResponsive, field.responsive)) ||
      (edit.originalNewTab !== undefined && edit.originalNewTab !== Boolean(field.newTab)) ||
      // A button restyled by a developer since the draft was written is the
      // same class of surprise as a heading they rewrote: the draft still
      // remembers a variant that is no longer there, and writing over it would
      // undo their change without saying so.
      (edit.originalVariant !== undefined && edit.originalVariant !== (field.variant ?? "")) ||
      (edit.originalIcon !== undefined && edit.originalIcon !== (field.icon ?? ""));
    if (moved) {
      conflicts.push({ id, expected: edit.original ?? edit.originalHref ?? edit.originalAlt ?? "", found: field.value });
      continue;
    }

    let touched = false;
    if (edit.value !== undefined && edit.value !== field.value) {
      if (field.kind === "image") {
        if (field.srcSpan) {
          edits.push({ span: field.srcSpan, text: attrEscape(edit.value) });
          if (field.srcsetSpan) edits.push({ span: field.srcsetSpan, text: "" });
          touched = true;
        } else if (field.styleSpan || field.attrInsert !== undefined) {
          const baseStyle = edit.style !== undefined ? edit.style : (field.style ?? "");
          const bgRe = /background-image\s*:\s*url\([^)]*\)/i;
          const newBg = edit.value ? `background-image: url('${edit.value.replace(/['"\\]/g, "")}')` : "";
          let nextStyle = baseStyle;
          if (bgRe.test(nextStyle)) {
            nextStyle = nextStyle.replace(bgRe, newBg);
          } else if (newBg) {
            nextStyle = nextStyle ? `${nextStyle.replace(/;?\s*$/, "; ")}${newBg}` : newBg;
          }
          const declarations = safeStyle(nextStyle, field.style);
          if (field.styleSpan) {
            edits.push({ span: field.styleSpan, text: attrEscape(declarations) });
            touched = true;
          } else if (declarations && field.attrInsert !== undefined) {
            edits.push({ insertAt: field.attrInsert, text: ` style="${attrEscape(declarations)}"` });
            touched = true;
          }
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
      const declarations = safeStyle(edit.style, field.style);
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
    if (edit.responsive !== undefined && field.attrInsert !== undefined && !responsiveEqual(edit.responsive, field.responsive)) {
      const node = responsiveNodeAt.get(field.attrInsert);
      if (node) {
        const responsive = normalizeResponsive(edit.responsive);
        let token = attrNode(node, "data-dw-style")?.value;
        if (!token || !RESPONSIVE_TOKEN.test(token) || tokenCounts.get(token) !== 1) {
          let attempt = 0;
          do {
            token = `dw-${createHash("sha256").update(`${id}:${node.start}:${attempt++}:${source}`).digest("hex").slice(0, 24)}`;
          } while (tokenCounts.has(token));
          tokenCounts.set(token, 1);
        }
        // Whole attributes also handle malformed duplicate markers safely.
        for (const attr of node.attrs.filter((candidate) => candidate.name === "data-dw-responsive" || candidate.name === "data-dw-style")) {
          edits.push({ span: withLeadingSpace(source, attr), text: "" });
        }
        const data = Object.keys(responsive).length ? ` data-dw-responsive="${attrEscape(JSON.stringify(responsive))}"` : "";
        edits.push({ insertAt: field.attrInsert, text: ` data-dw-style="${token}"${data}` });
        responsiveChanged = true;
        touched = true;
      }
    }
    // A button's style, swapped one token for another inside its own class
    // attribute. Every other class on the element survives — `mt-9` is a
    // developer's spacing decision and has nothing to do with which colour
    // somebody picked.
    if (edit.variant !== undefined && field.classSpan) {
      const current = source.slice(field.classSpan.start, field.classSpan.end);
      const change = resolveVariantChange(current, edit.variant);
      const next = change ? withVariant(current, change) : current;
      if (next !== current) {
        edits.push({ span: field.classSpan, text: attrEscape(next) });
        touched = true;
      }
    }

    // `target` and `rel`, written and removed as one thing. A `target="_blank"`
    // with no `rel="noopener"` hands the page it opens a live handle on the one
    // it came from, and nobody choosing "open in a new tab" is choosing that —
    // so there is no path through here that produces one without the other.
    if (edit.newTab !== undefined && field.kind === "button" && field.hrefSpan && edit.newTab !== Boolean(field.newTab)) {
      const rel = relTokens(field.rel);
      if (edit.newTab) {
        const wanted = [...rel.filter((token) => !NEW_TAB_REL.includes(token)), ...NEW_TAB_REL].join(" ");
        if (field.targetAttr) edits.push({ span: field.targetAttr, text: 'target="_blank"' });
        else if (field.attrInsert !== undefined) edits.push({ insertAt: field.attrInsert, text: ' target="_blank"' });
        if (field.relAttr) edits.push({ span: field.relAttr, text: `rel="${attrEscape(wanted)}"` });
        else if (field.attrInsert !== undefined) edits.push({ insertAt: field.attrInsert, text: ` rel="${attrEscape(wanted)}"` });
        touched = true;
      } else {
        // Removed rather than emptied. `target=""` is not "no target" to a
        // browser, and a `rel` left holding only the two tokens we put there is
        // ours to take away — anything else on it is the developer's and stays.
        if (field.targetAttr) edits.push({ span: withLeadingSpace(source, field.targetAttr), text: "" });
        const kept = rel.filter((token) => !NEW_TAB_REL.includes(token));
        if (field.relAttr) {
          if (kept.length === 0) edits.push({ span: withLeadingSpace(source, field.relAttr), text: "" });
          else edits.push({ span: field.relAttr, text: `rel="${attrEscape(kept.join(" "))}"` });
        }
        touched = true;
      }
    }

    // An icon, swapped, added or taken away. The choice is a library name or
    // an image address; the markup is written here, never taken from a draft.
    if (edit.icon !== undefined) {
      const markup = edit.icon === null ? "" : iconChoiceMarkup(edit.icon, field.iconFrame);
      if (markup !== null) {
        if (field.iconSpan) {
          edits.push({ span: field.iconSpan, text: markup });
          touched = true;
        } else if (markup && field.iconAddable && field.content) {
          // Added to a button that had none. Written as part of the words'
          // own span, together with any new words, because an insertion at
          // the same offset as that span would overlap it.
          const pending = edits.findIndex((candidate) => "span" in candidate && candidate.span === field.content);
          const words = pending === -1 ? source.slice(field.content.start, field.content.end) : edits[pending]!.text;
          const text = edit.iconPosition === "end" ? `${words} ${markup}` : `${markup} ${words}`;
          if (pending === -1) edits.push({ span: field.content, text });
          else edits[pending] = { span: field.content, text };
          touched = true;
        }
      }
    } else if (field.kind === "icon" && field.iconSpan && edit.value !== undefined && edit.value !== field.value) {
      const val = edit.value.trim();
      const choice: IconChoice | null = !val ? null : { src: val };
      const markup = choice === null ? "" : iconChoiceMarkup(choice, field.iconFrame);
      if (markup !== null) {
        edits.push({ span: field.iconSpan, text: markup });
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

  if (responsiveChanged) html = regenerateResponsiveStyles(html);
  if (/--dw-(?:hover|focus|active)-|data-dw-interaction-styles/.test(html)) html = regenerateInteractionStyles(html);
  return { html, changed, conflicts, missing };
}
