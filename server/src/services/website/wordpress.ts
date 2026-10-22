/**
 * A WordPress page's fields, traced back to the content WordPress stores.
 *
 * A WordPress page is not a file. What a visitor receives is built on every
 * request from a database row, a theme, and whatever page builder the site
 * uses — so the editor works the way it does for a framework page: it shows
 * the live page, and a publish writes each change back into the thing the page
 * was built from. Here that thing is the page's `content` (and its title), read
 * and written through the REST API as raw text.
 *
 * The rule is the one `pageFields.ts` keeps, applied to a different source: a
 * field is writable only when its words occur **exactly once** in the stored
 * content, as the whole of an element, and exactly once on the live page. A
 * heading that also appears in the menu, a sentence that is part of a longer
 * one, words that come from the theme, a widget or a builder's private data —
 * all locked, each with a sentence saying why and where to change it instead.
 * A missing field is the safe failure; a wrong one is not.
 *
 * WordPress rewrites text on the way out (`wptexturize`, `wpautop`), so the
 * live page says `It’s` where the content says `It's`, and puts `<p>` around
 * lines the classic editor stored as bare newlines. Matching runs over a
 * normalised copy of both, and keeps a map from every normalised character
 * back to the raw span it came from, so what is replaced is the bytes the
 * content actually holds — never a re-serialisation of them.
 *
 * Nothing here talks to WordPress. It is given the live HTML and the stored
 * content and returns a decision, which is what makes it checkable with
 * strings: see `checks/websiteWordPress.ts`.
 */
import { decodeEntities } from "./parse.js";
import { readPage, type FieldValue, type SiteField } from "./regions.js";
import { DOCUMENT_KEY } from "./document.js";

export const WORDPRESS_ADAPTER_VERSION = "wordpress-v1" as const;

/**
 * How a WordPress page was built. The first group keeps its words in the post
 * content, where the REST API can read and write them. The second keeps them in
 * private post meta the REST API does not expose without a plugin, and writing
 * the content of such a page changes nothing a visitor sees — so they are
 * recognised, and refused, rather than "edited" into a copy nobody renders.
 */
export type WordPressBuilder =
  | "blocks"
  | "classic"
  | "divi"
  | "wpbakery"
  | "avada"
  | "elementor"
  | "beaver"
  | "bricks"
  | "oxygen"
  | "brizy"
  | "thrive"
  | "siteorigin";

export const WORDPRESS_BUILDER_LABEL: Record<WordPressBuilder, string> = {
  blocks: "the WordPress block editor",
  classic: "the classic WordPress editor",
  divi: "Divi",
  wpbakery: "WPBakery",
  avada: "Avada",
  elementor: "Elementor",
  beaver: "Beaver Builder",
  bricks: "Bricks",
  oxygen: "Oxygen",
  brizy: "Brizy",
  thrive: "Thrive Architect",
  siteorigin: "SiteOrigin Page Builder",
};

/** The builders whose page content is somewhere this module cannot reach. */
const STORED_ELSEWHERE = new Set<WordPressBuilder>(["elementor", "beaver", "bricks", "oxygen", "brizy", "thrive", "siteorigin"]);

export function builderEditable(builder: WordPressBuilder): boolean {
  return !STORED_ELSEWHERE.has(builder);
}

/**
 * Which builder made this page.
 *
 * The builders that keep their data in meta are recognised by what they render,
 * and only by markers carrying **this page's own id** where the builder has
 * one: an Elementor header on a block-editor page is still a block-editor page,
 * and the header is simply locked like any other theme part.
 */
export function detectWordPressBuilder(input: { postId: number; content: string; html: string }): WordPressBuilder {
  const { postId, content, html } = input;
  const id = String(postId);
  if (new RegExp(`data-elementor-id=["']${id}["']`).test(html) && /data-elementor-type=["'](wp-page|wp-post|single)/.test(html)) return "elementor";
  if (new RegExp(`fl-builder-content-${id}\\b`).test(html)) return "beaver";
  if (/\bid=["']brx-content["']/.test(html)) return "bricks";
  if (/\bclass=["'][^"']*\bct-section\b/.test(html) || /\bid=["']ct-builder["']/.test(html)) return "oxygen";
  if (/\bclass=["'][^"']*\bbrz-root__container\b/.test(html)) return "brizy";
  if (/\bid=["']tve_editor["']/.test(html) && /\btve_flt\b|\bthrv_wrapper\b/.test(html)) return "thrive";
  if (new RegExp(`\\bid=["']pl-${id}["']`).test(html) && /\bpanel-layout\b/.test(html)) return "siteorigin";
  if (/\[et_pb_section\b/.test(content) || /<!--\s*wp:divi\//.test(content)) return "divi";
  if (/\[vc_row\b/.test(content)) return "wpbakery";
  if (/\[fusion_builder_container\b/.test(content)) return "avada";
  if (/<!--\s*wp:/.test(content)) return "blocks";
  return "classic";
}

/**
 * What a public page says about the site behind it, before anything is
 * connected: whether it is WordPress, and which builder made *this* page. Used
 * at checkout, where there is no post id and no password — only the homepage.
 */
export function wordpressSiteHint(html: string): { wordpress: boolean; builder: WordPressBuilder | null } {
  const lower = html.toLowerCase();
  const wordpress = /wp-content|wp-includes|name=["']generator["'][^>]+wordpress/.test(lower);
  if (!wordpress) return { wordpress: false, builder: null };
  const builder: WordPressBuilder | null =
    /data-elementor-type=["'](wp-page|wp-post|single)/.test(lower) ? "elementor"
      : /\bfl-builder-content\b/.test(lower) ? "beaver"
        : /\bid=["']brx-content["']/.test(lower) ? "bricks"
          : /\bclass=["'][^"']*\bct-section\b/.test(lower) ? "oxygen"
            : /\bbrz-root__container\b/.test(lower) ? "brizy"
              : /\bet_pb_section\b/.test(lower) ? "divi"
                : /\bvc_row\b/.test(lower) ? "wpbakery"
                  : /\bfusion-builder-container\b|\bfusion-fullwidth\b/.test(lower) ? "avada"
                    : /\bwp-block-/.test(lower) ? "blocks"
                      : null;
  return { wordpress, builder };
}

/** What a WordPress customer is told before paying: what will work, and what will not. */
export function wordpressPurchaseNote(builder: WordPressBuilder | null): string {
  const how = "WordPress site: after payment you connect it with a WordPress Application Password — nothing to install. Words, links and pictures in your pages' content are edited here and published straight back into WordPress; menus, footers and styling stay in WordPress.";
  if (builder && !builderEditable(builder)) {
    const name = WORDPRESS_BUILDER_LABEL[builder];
    return `${how} This page is built with ${name}, and ${name} pages open read-only for now, because ${name} keeps its words where WordPress does not let other apps edit them. Pages made with the block editor, the classic editor, Divi, WPBakery or Avada are fully editable.`;
  }
  return how;
}

/** Why a page made with a meta-storing builder cannot be edited yet, and what to do. */
export function builderRefusal(builder: WordPressBuilder): string {
  const name = WORDPRESS_BUILDER_LABEL[builder];
  return `This page is built with ${name}, which keeps its words in its own data rather than in the page content WordPress lets other apps edit. Change it in WordPress with ${name} for now — support for ${name} pages is coming.`;
}

// ---------------------------------------------------------------- normalising

/** A boundary nothing can match across: a block comment, a quote, a paragraph break. */
const BARRIER = "\u0000";

type Normalised = {
  text: string;
  /** For each character of `text`, where its raw span starts and ends. */
  starts: number[];
  ends: number[];
  /** Raw spans that are a shortcode attribute's value, so a write there is escaped for it. */
  attributeSpans: Array<{ start: number; end: number }>;
};

/** The characters `wptexturize` swaps in, folded back to what was typed. */
const FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "″": '"',
  "–": "-", "—": "-", "−": "-",
  "…": "...",
  "×": "x",
  " ": " ",
};

/**
 * A normalised copy of HTML-ish text, with a map back to the original.
 *
 * Tags keep their name and lose their attributes (WordPress adds `rel`,
 * `loading`, `decoding` and classes on the way out); a `<br>` is a space;
 * entities are decoded; whitespace and hyphen runs collapse. In stored
 * content, block comments and shortcode tags are barriers — except the quoted
 * values of a shortcode's attributes, which are text, because that is where
 * Divi and WPBakery keep a module's title and a button's label.
 */
function normalise(raw: string, options: { stored: boolean }): Normalised {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const attributeSpans: Normalised["attributeSpans"] = [];
  const emit = (chars: string, start: number, end: number) => {
    for (const char of chars) {
      out.push(char);
      starts.push(start);
      ends.push(end);
    }
  };
  // Collapsing runs is done on the emitted stream: the run's first character
  // keeps its start, and its end is stretched over the rest.
  const emitFolded = (chars: string, start: number, end: number) => {
    for (const char of chars) {
      const last = out.length - 1;
      const isSpace = char === " " || char === "\n" || char === "\t" || char === "\r";
      if (isSpace && last >= 0 && out[last] === " ") { ends[last] = end; continue; }
      if (char === "-" && last >= 0 && out[last] === "-") { ends[last] = end; continue; }
      emit(isSpace ? " " : char, start, end);
    }
  };

  let i = 0;
  while (i < raw.length) {
    const char = raw[i]!;
    if (raw.startsWith("<!--", i)) {
      const close = raw.indexOf("-->", i + 4);
      const end = close === -1 ? raw.length : close + 3;
      emit(BARRIER, i, end);
      i = end;
      continue;
    }
    if (char === "<" && /[a-zA-Z/]/.test(raw[i + 1] ?? "")) {
      const close = raw.indexOf(">", i);
      const end = close === -1 ? raw.length : close + 1;
      const tag = raw.slice(i, end);
      const name = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase() ?? "";
      if (name === "br") emitFolded(" ", i, end);
      else emit(`<${tag.startsWith("</") ? "/" : ""}${name}>`, i, end);
      i = end;
      continue;
    }
    if (options.stored && char === "[" && /[a-zA-Z_/]/.test(raw[i + 1] ?? "")) {
      const end = shortcodeEnd(raw, i);
      if (end !== -1) {
        emit(BARRIER, i, i + 1);
        // The quoted values inside, as text between barriers.
        const tag = raw.slice(i, end);
        for (const match of tag.matchAll(/([a-zA-Z_][\w-]*)=("|')(.*?)\2/gs)) {
          const valueStart = i + match.index! + match[1]!.length + 2;
          const valueEnd = valueStart + match[3]!.length;
          attributeSpans.push({ start: valueStart, end: valueEnd });
          emit(BARRIER, valueStart - 1, valueStart);
          normaliseText(raw, valueStart, valueEnd, emitFolded);
          emit(BARRIER, valueEnd, valueEnd + 1);
        }
        emit(BARRIER, end - 1, end);
        i = end;
        continue;
      }
    }
    if (options.stored && (char === "\n" || char === "\r")) {
      // A blank line is a paragraph break to `wpautop`, so it is a boundary
      // here: "A\n\nB" is two paragraphs, not the sentence "A B".
      const run = /^[\r\n\t ]+/.exec(raw.slice(i))![0];
      if ((run.match(/\n/g) ?? []).length >= 2) emit(BARRIER, i, i + run.length);
      else emitFolded(" ", i, i + run.length);
      i += run.length;
      continue;
    }
    const next = nextTextEnd(raw, i, options.stored);
    normaliseText(raw, i, next, emitFolded);
    i = next;
  }
  return { text: out.join(""), starts, ends, attributeSpans };
}

/** Where the plain text starting at `from` stops: at the next tag, comment, shortcode or newline. */
function nextTextEnd(raw: string, from: number, stored: boolean): number {
  let i = from + 1;
  while (i < raw.length) {
    const char = raw[i]!;
    if (char === "<") break;
    if (stored && (char === "[" || char === "\n" || char === "\r")) break;
    i += 1;
  }
  return i;
}

/** Entities decoded and typography folded, one raw character or entity at a time. */
function normaliseText(raw: string, from: number, to: number, emit: (chars: string, start: number, end: number) => void) {
  let i = from;
  while (i < to) {
    if (raw[i] === "&") {
      const entity = /^&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/.exec(raw.slice(i, Math.min(to, i + 12)));
      if (entity) {
        const decoded = decodeEntities(entity[0]);
        emit(fold(decoded), i, i + entity[0].length);
        i += entity[0].length;
        continue;
      }
    }
    const code = raw.codePointAt(i)!;
    const char = String.fromCodePoint(code);
    emit(fold(char), i, i + char.length);
    i += char.length;
  }
}

function fold(text: string): string {
  let out = "";
  for (const char of text) out += FOLD[char] ?? char;
  return out;
}

/** The end of a shortcode tag starting at `from`, quotes respected; -1 when it is not one. */
function shortcodeEnd(raw: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < raw.length && i < from + 20_000; i += 1) {
    const char = raw[i]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "]") return i + 1;
    else if (char === "[" || char === "<") return -1;
  }
  return -1;
}

/** A field's value as a search needle: normalised, trimmed, barriers impossible. */
function needle(value: string): string {
  return normalise(value, { stored: false }).text.trim();
}

/** Whether a needle carries any words worth matching on. */
function meaningful(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replace(/<\/?[a-z0-9-]+>/g, ""));
}

/**
 * Every place `text` occurs in `haystack` as the whole of an element: bounded
 * by a tag, a barrier, or the ends, with only spaces between.
 */
function wholeOccurrences(haystack: string, text: string): number[] {
  const found: number[] = [];
  if (!text) return found;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(text, from);
    if (at === -1) break;
    from = at + 1;
    let before = at - 1;
    while (before >= 0 && haystack[before] === " ") before -= 1;
    let after = at + text.length;
    while (after < haystack.length && haystack[after] === " ") after += 1;
    const openOk = before < 0 || haystack[before] === ">" || haystack[before] === BARRIER;
    const closeOk = after >= haystack.length || haystack[after] === "<" || haystack[after] === BARRIER;
    if (openOk && closeOk) found.push(at);
  }
  return found;
}

// ----------------------------------------------------------------- the source

/** What a WordPress page is made of, as the REST API returns it with `context=edit`. */
export type WordPressSource = {
  id: number;
  type: "page" | "post";
  /** `content.raw`. */
  content: string;
  /** `title.raw`. */
  title: string;
  builder: WordPressBuilder;
};

type Location =
  | { where: "content"; start: number; end: number; attribute: boolean; wrappers: string[] }
  | { where: "title"; wrappers: string[] };

/**
 * Inline tags a builder wraps around stored words on the way out — Divi puts a
 * module's title in a `<span>` inside its heading. Peeled off one at a time
 * when the words as shown are not in the content, never a link: a link a
 * builder added is a destination, not a decoration.
 */
const INLINE_WRAPPERS = new Set(["span", "strong", "em", "b", "i", "u", "small", "mark"]);

function unwrapNeedle(text: string): { tag: string; inner: string } | null {
  const match = /^<([a-z0-9-]+)>([\s\S]*)<\/\1>$/.exec(text);
  if (!match || !INLINE_WRAPPERS.has(match[1]!)) return null;
  const inner = match[2]!.trim();
  // `<b>one</b> and <b>two</b>` is not one wrapper around everything.
  if (inner.includes(`<${match[1]}>`) || inner.includes(`</${match[1]}>`)) return null;
  return { tag: match[1]!, inner };
}

/** The same wrappers taken off a value as the editor sends it, attributes and all. */
function stripWrappers(html: string, wrappers: string[]): string {
  let out = html;
  for (const tag of wrappers) {
    const match = new RegExp(`^\\s*<${tag}\\b[^>]*>([\\s\\S]*)<\\/${tag}>\\s*$`, "i").exec(out);
    if (match) out = match[1]!;
  }
  return out;
}

type Locate = { location?: Location; reason?: string };

/** Where one value lives in the source, or the sentence saying why it cannot be traced. */
function locate(source: WordPressSource, stored: Normalised, value: string): Locate {
  let text = needle(value);
  if (!meaningful(text)) return { reason: "There are no words here to trace back to the page's content." };
  const wrappers: string[] = [];
  for (;;) {
    const hits = wholeOccurrences(stored.text, text);
    if (hits.length === 1) {
      const at = hits[0]!;
      const start = stored.starts[at]!;
      const end = stored.ends[at + text.length - 1]!;
      const attribute = stored.attributeSpans.some((span) => start >= span.start && end <= span.end);
      return { location: { where: "content", start, end, attribute, wrappers } };
    }
    if (hits.length > 1) {
      return { reason: `These exact words appear ${hits.length} times in this page's content, so a change here could land on the wrong one. Change it in WordPress, or make the words different first.` };
    }
    if (needle(source.title) === text) return { location: { where: "title", wrappers } };
    const peeled = unwrapNeedle(text);
    if (!peeled) break;
    wrappers.push(peeled.tag);
    text = peeled.inner;
  }
  return {
    reason: "These words are not in this page's content — they come from the theme, a menu, a widget or a plugin. Change them in WordPress (Appearance → Menus, Widgets or the Site Editor).",
  };
}

/** How often `value` is the whole of an element anywhere on the live page — the menu included. */
function liveOccurrences(live: Normalised, value: string): number {
  return wholeOccurrences(live.text, needle(value)).length;
}

/** How many `<img>` on the live page show this file — a logo in the header counts. */
function liveImages(html: string, src: string): number {
  const wanted = normaliseUrl(src);
  return [...html.matchAll(/<img\b[^>]*>/gi)].filter((match) => {
    const value = attribute(match[0], "src");
    return value !== null && normaliseUrl(value) === wanted;
  }).length;
}

const REPEATED_ON_PAGE = "These exact words appear more than once on this page — in the menu, the footer or elsewhere — so a change here could land on the wrong one. Change it in WordPress.";
const REPEATED_PICTURE = "This picture appears more than once on this page, so a change here could land on the wrong one. Change it in WordPress.";

/** An `<img>` in the stored content whose `src` is `src`, when there is exactly one. */
function imageTag(content: string, src: string): { start: number; end: number; tag: string } | { reason: string } {
  const wanted = normaliseUrl(src);
  const tags = [...content.matchAll(/<img\b[^>]*>/gi)].filter((match) => {
    const value = attribute(match[0], "src");
    return value !== null && normaliseUrl(value) === wanted;
  });
  if (tags.length === 1) return { start: tags[0]!.index!, end: tags[0]!.index! + tags[0]![0].length, tag: tags[0]![0] };
  if (tags.length > 1) return { reason: "This picture appears more than once in the page's content, so a change here could land on the wrong one. Change it in WordPress." };
  return { reason: "This picture is not in the page's content — it comes from the theme, a widget or the page builder's settings. Change it in WordPress." };
}

/** Compared as WordPress serves it: entities decoded, protocol-relative and `http:` treated as one. */
function normaliseUrl(url: string): string {
  return decodeEntities(url.trim()).replace(/^https?:/i, "").replace(/\/+$/, "");
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? (match[2] ?? match[3] ?? "") : null;
}

function escapeAttribute(value: string): string {
  return value.replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A tag with one attribute set (added when missing) or removed (`null`). */
function setAttribute(tag: string, name: string, value: string | null): string {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, "i");
  if (value === null) return tag.replace(pattern, "");
  if (pattern.test(tag)) return tag.replace(pattern, ` ${name}="${escapeAttribute(value)}"`);
  return tag.replace(/\s*\/?>$/, (close) => ` ${name}="${escapeAttribute(value)}"${close.trim() === "/>" ? " />" : ">"}`);
}

/** The opening `<a>` that encloses `position` in the content, if there is one. */
function enclosingAnchor(content: string, position: number): { start: number; end: number; tag: string } | null {
  const before = content.slice(0, position);
  const open = before.lastIndexOf("<a ");
  const openBare = before.lastIndexOf("<a>");
  const at = Math.max(open, openBare);
  if (at === -1) return null;
  if (before.indexOf("</a>", at) !== -1) return null;
  const end = content.indexOf(">", at);
  if (end === -1 || end > position) return null;
  return { start: at, end: end + 1, tag: content.slice(at, end + 1) };
}

// ----------------------------------------------------------------- what is writable

export type WordPressFieldMap = {
  /** Field ids on the live page a publish can write. */
  writable: Set<string>;
  /** Why each other field cannot be, in a sentence for the person who clicked it. */
  notes: Map<string, string>;
  /** Set when nothing on the page can be written, said once instead of per field. */
  failure?: string;
};

/**
 * Which of the live page's fields trace back to the page's stored content.
 *
 * The editor asks this when it opens a page and the publish asks the same
 * question of the same strings, so a field shown as editable is a field that
 * publishes, and one shown locked is one that would have been refused.
 */
export function wordpressFieldMap(input: { html: string; source: WordPressSource; fields?: SiteField[] }): WordPressFieldMap {
  const fields = input.fields ?? readPage(input.html).fields;
  const writable = new Set<string>();
  const notes = new Map<string, string>();
  if (!builderEditable(input.source.builder)) {
    const failure = builderRefusal(input.source.builder);
    for (const field of fields) notes.set(field.id, failure);
    return { writable, notes, failure };
  }
  const stored = normalise(input.source.content, { stored: true });
  const live = normalise(input.html, { stored: false });
  for (const field of fields) {
    if (field.id.startsWith("meta.")) {
      notes.set(field.id, "WordPress, or your SEO plugin, writes this page's browser title and description. Change them in WordPress.");
      continue;
    }
    if (field.kind === "image") {
      const found = imageTag(input.source.content, field.value);
      if (liveImages(input.html, field.value) > 1) notes.set(field.id, REPEATED_PICTURE);
      else if ("reason" in found) notes.set(field.id, found.reason);
      else writable.add(field.id);
      continue;
    }
    if (field.kind === "container" || field.kind === "background" || field.kind === "icon" || field.kind === "unsupported") {
      notes.set(field.id, "WordPress pages take changes to words, links and pictures from here. Change layout and styling in WordPress.");
      continue;
    }
    if (liveOccurrences(live, field.value) > 1) {
      notes.set(field.id, REPEATED_ON_PAGE);
      continue;
    }
    const found = locate(input.source, stored, field.value);
    if (found.location) writable.add(field.id);
    else notes.set(field.id, found.reason!);
  }
  return {
    writable,
    notes,
    ...(writable.size === 0 && fields.length > 0 ? { failure: "Nothing on this page could be traced back to its WordPress content — it all comes from the theme, menus, widgets or a page builder. Change it in WordPress." } : {}),
  };
}

// ----------------------------------------------------------------- writing

export type WordPressUnmappable = { htmlFieldId: string; part: string; message: string };
export type WordPressProblem = { fieldId: string; code: "stale" | "invalid"; message: string };

/** A picture uploaded to the site's media library for a publish, keyed by the URL the draft used. */
export type WordPressMedia = Map<string, { id: number; url: string }>;

export type WordPressApplyResult = {
  content: string;
  title: string;
  /** Field ids whose edits were written. */
  changed: string[];
  /** What was written, before and after, in words — for the live check. */
  changes: Array<{ before: string; after: string }>;
  unmappable: WordPressUnmappable[];
  problems: WordPressProblem[];
};

/** The parts of an edit this route cannot carry, and why. */
const NOT_CARRIED: Record<string, string> = {
  style: "Styling a WordPress page is done in WordPress — in the block settings or the theme — so this style change was not published.",
  responsive: "Screen-size styling on a WordPress page is set in WordPress, so this change was not published.",
  variant: "A button's style on a WordPress page comes from the block or the theme, so this change was not published.",
  newTab: "Whether a link opens in a new tab is set in WordPress, so this change was not published.",
  icon: "Icons on a WordPress page come from the theme or a plugin, so this change was not published.",
};

/**
 * Writes an editor's draft into a WordPress page's stored content and title.
 *
 * All or nothing, the same rule the framework path keeps: an edit that cannot
 * be traced, or whose original words are no longer in the content, refuses the
 * whole set. A publish that wrote the parts it understood and dropped the rest
 * would be a page that is half of what somebody approved, reported as success.
 */
export function applyWordPressEdits(input: {
  html: string;
  source: WordPressSource;
  values: Record<string, FieldValue>;
  media?: WordPressMedia;
}): WordPressApplyResult {
  const refuse = (unmappable: WordPressUnmappable[], problems: WordPressProblem[]): WordPressApplyResult =>
    ({ content: input.source.content, title: input.source.title, changed: [], changes: [], unmappable, problems });

  if (!builderEditable(input.source.builder)) {
    return refuse([{ htmlFieldId: "*", part: "page", message: builderRefusal(input.source.builder) }], []);
  }
  const fields = new Map(readPage(input.html).fields.map((field) => [field.id, field]));
  const unmappable: WordPressUnmappable[] = [];
  const problems: WordPressProblem[] = [];

  type Splice = { start: number; end: number; text: string; fieldId: string };
  const splices: Splice[] = [];
  let title = input.source.title;
  const changed = new Set<string>();
  const changes: Array<{ before: string; after: string }> = [];
  const stored = normalise(input.source.content, { stored: true });
  const live = normalise(input.html, { stored: false });
  const content = input.source.content;

  for (const [fieldId, edit] of Object.entries(input.values)) {
    if (fieldId === DOCUMENT_KEY) {
      unmappable.push({ htmlFieldId: fieldId, part: "structure", message: "Adding, moving or removing sections on a WordPress page is done in WordPress, so this change was not published." });
      continue;
    }
    for (const [part, message] of Object.entries(NOT_CARRIED)) {
      const value = (edit as Record<string, unknown>)[part];
      const original = (edit as Record<string, unknown>)[`original${part[0]!.toUpperCase()}${part.slice(1)}`];
      if (value !== undefined && JSON.stringify(value) !== JSON.stringify(original ?? (part === "style" ? "" : undefined))) {
        unmappable.push({ htmlFieldId: fieldId, part, message });
      }
    }
    if (fieldId.startsWith("meta.")) {
      if (edit.value !== undefined && edit.value !== edit.original) {
        unmappable.push({ htmlFieldId: fieldId, part: "words", message: "This page's browser title and description are written by WordPress or your SEO plugin, so change them there." });
      }
      continue;
    }
    const field = fields.get(fieldId);
    const kind = field?.kind;

    if (kind === "image") {
      const originalSrc = edit.original ?? field!.value;
      const srcChanged = edit.value !== undefined && edit.value !== originalSrc;
      const altChanged = edit.alt !== undefined && edit.alt !== (edit.originalAlt ?? field?.alt ?? "");
      if (!srcChanged && !altChanged) continue;
      if (liveImages(input.html, originalSrc) > 1) {
        problems.push({ fieldId, code: "invalid", message: REPEATED_PICTURE });
        continue;
      }
      const found = imageTag(content, originalSrc);
      if ("reason" in found) {
        problems.push({ fieldId, code: "stale", message: found.reason });
        continue;
      }
      let tag = found.tag;
      let newId: number | null | undefined;
      if (srcChanged) {
        const uploaded = input.media?.get(edit.value!);
        const url = uploaded?.url ?? edit.value!;
        if (!/^https?:\/\//i.test(url)) {
          problems.push({ fieldId, code: "invalid", message: "This picture could not be added to the WordPress media library, so the page would point at a file WordPress does not have." });
          continue;
        }
        newId = uploaded?.id ?? null;
        tag = setAttribute(tag, "src", url);
        // WordPress builds `srcset` from the attachment id in the class, so a
        // stale id would serve the old picture to every phone.
        tag = setAttribute(tag, "srcset", null);
        tag = setAttribute(tag, "sizes", null);
        tag = tag.replace(/\bwp-image-\d+\b/, newId ? `wp-image-${newId}` : "").replace(/class="\s*"/, "");
      }
      if (altChanged) tag = setAttribute(tag, "alt", edit.alt!);
      splices.push({ start: found.start, end: found.end, text: tag, fieldId });
      // The image block's own settings carry the attachment id too.
      if (srcChanged) {
        const comment = blockCommentBefore(content, found.start, "image");
        if (comment) {
          const rewritten = comment.text.replace(/"id":\d+,?/, newId ? `"id":${newId},` : "").replace(/,}/, "}").replace(/\{\s*\}/, "{}");
          if (rewritten !== comment.text) splices.push({ start: comment.start, end: comment.end, text: rewritten, fieldId });
        }
      }
      changed.add(fieldId);
      continue;
    }

    if (kind === "container" || kind === "background" || kind === "icon" || kind === "unsupported") continue;

    const original = edit.original ?? field?.value;
    const wordsChanged = edit.value !== undefined && original !== undefined && edit.value !== original;
    const hrefChanged = edit.href !== undefined && edit.href !== (edit.originalHref ?? field?.href);
    if (!wordsChanged && !hrefChanged) continue;
    if (original === undefined) {
      problems.push({ fieldId, code: "stale", message: "This part of the page has moved since the change was made. Reopen the page and make it again." });
      continue;
    }
    if (liveOccurrences(live, original) > 1) {
      problems.push({ fieldId, code: "invalid", message: REPEATED_ON_PAGE });
      continue;
    }
    const found = locate(input.source, stored, original);
    if (!found.location) {
      problems.push({ fieldId, code: "stale", message: found.reason ?? "These words are no longer in the page's content." });
      continue;
    }
    const location = found.location;
    if (location.where === "title") {
      if (hrefChanged) {
        unmappable.push({ htmlFieldId: fieldId, part: "link", message: "The page title is not a link in WordPress's content, so its destination cannot be changed here." });
        continue;
      }
      title = plainText(stripWrappers(edit.value!, location.wrappers));
      changed.add(fieldId);
      changes.push({ before: plainText(original), after: title });
      continue;
    }
    if (wordsChanged) {
      let text = stripWrappers(edit.value!, location.wrappers);
      if (location.attribute) {
        // A shortcode attribute is a quoted string inside `[...]`, so markup,
        // quotes and brackets in it would end the attribute or the shortcode.
        if (/<[a-z/]/i.test(text) || /["[\]]/.test(decodeEntities(text))) {
          problems.push({ fieldId, code: "invalid", message: "This text is stored in a page builder setting that cannot hold formatting, quotes or square brackets. Remove them, or change it in WordPress." });
          continue;
        }
        text = decodeEntities(text);
      }
      splices.push({ start: location.start, end: location.end, text, fieldId });
      changes.push({ before: plainText(original), after: plainText(edit.value!) });
    }
    if (hrefChanged) {
      const anchor = enclosingAnchor(content, location.start);
      if (!anchor) {
        unmappable.push({ htmlFieldId: fieldId, part: "link", message: "This link's destination is set by the page builder or the theme rather than in the page's content, so change it in WordPress." });
        continue;
      }
      splices.push({ start: anchor.start, end: anchor.end, text: setAttribute(anchor.tag, "href", edit.href!), fieldId });
    }
    changed.add(fieldId);
  }

  if (unmappable.length || problems.length) return refuse(unmappable, problems);

  // Applied from the end so every recorded offset stays true; two edits
  // claiming overlapping bytes is a contradiction, not something to guess at.
  splices.sort((a, b) => b.start - a.start);
  for (let index = 1; index < splices.length; index += 1) {
    if (splices[index]!.end > splices[index - 1]!.start) {
      return refuse([], [{ fieldId: splices[index]!.fieldId, code: "invalid", message: "Two of these changes touch the same part of the page. Publish one of them first." }]);
    }
  }
  let written = content;
  for (const splice of splices) written = written.slice(0, splice.start) + splice.text + written.slice(splice.end);
  return { content: written, title, changed: [...changed], changes, unmappable: [], problems: [] };
}

/** The `<!-- wp:<name> {...} -->` comment that opens the block holding `position`. */
function blockCommentBefore(content: string, position: number, name: string): { start: number; end: number; text: string } | null {
  const before = content.slice(0, position);
  const at = before.lastIndexOf(`<!-- wp:${name}`);
  if (at === -1) return null;
  const end = content.indexOf("-->", at);
  if (end === -1 || end > position) return null;
  // Not if another block closed in between.
  if (before.indexOf(`<!-- /wp:${name}`, at) !== -1) return null;
  return { start: at, end: end + 3, text: content.slice(at, end + 3) };
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
