/**
 * What a website is made of, read from every page at once.
 *
 * The editor already knows how to find the same block on two pages
 * (`sharedCandidates`), but it cannot say *what* that block is, and it looks at
 * one page at a time for everything else. Somebody taking on a website they did
 * not build needs the other half: which regions are global, what the site keeps
 * asking visitors to do, which pages are really the same template wearing
 * different words, and what the site's colours and type actually are — not what
 * a brand document claims they are.
 *
 * **Nothing here calls a model.** Every answer is derived from the markup, so a
 * survey costs nothing, cannot invent a page that is not there, and reads the
 * same twice. Where the evidence is thin the answer says so rather than being
 * dropped or guessed: an unclassified region is still reported, because "there
 * is a repeated block here and I cannot name it" is useful and a silent gap is
 * not.
 */
import { attr, parseHtml, textOf, walk, type ElementNode } from "./parse.js";
import { readPage } from "./regions.js";
import { sharedCandidates, type SharedConfidence } from "./shared.js";

export type SurveyStylesheet = { href: string; css: string };

export type SurveyPage = {
  pageId: string;
  title: string;
  path: string;
  html: string;
  /**
   * The stylesheets this page links to, already fetched.
   *
   * Most websites keep their design in a file rather than in the page, so a
   * palette read from `<style>` blocks and `style` attributes alone is a palette
   * of whatever happened to be inlined — usually nothing. Passed in rather than
   * fetched here so this module stays free of the network and a check can hand
   * it CSS without one.
   */
  stylesheets?: SurveyStylesheet[];
};

/* ------------------------------------------------------------------ regions */

export type SurveyRole =
  | "header"
  | "footer"
  | "primary-navigation"
  | "breadcrumbs"
  | "sidebar"
  | "call-to-action"
  | "newsletter"
  | "cookie-notice"
  | "unclassified";

export type SurveyElement = {
  key: string;
  name: string;
  role: SurveyRole;
  /** Why it was called that, in the words somebody reads on the screen. */
  roleReason: string;
  confidence: SharedConfidence;
  reason: string;
  instances: Array<{ pageId: string; fieldId: string }>;
  pageIds: string[];
  /** On every page that was read, not merely on more than one. */
  everywhere: boolean;
};

const ROLE_LABELS: Record<SurveyRole, string> = {
  header: "Header",
  footer: "Footer",
  "primary-navigation": "Primary navigation",
  breadcrumbs: "Breadcrumbs",
  sidebar: "Sidebar",
  "call-to-action": "Call to action",
  newsletter: "Newsletter signup",
  "cookie-notice": "Cookie notice",
  unclassified: "Repeated block",
};

export function roleLabel(role: SurveyRole): string {
  return ROLE_LABELS[role];
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();
const lower = (text: string) => normalise(text).toLowerCase();

/** Tag, role, aria-label, id and class as one lowercase string to match against. */
function signature(element: ElementNode): string {
  const parts = [element.tag, attr(element, "role") ?? "", attr(element, "aria-label") ?? "", attr(element, "id") ?? "", attr(element, "class") ?? ""];
  return lower(parts.join(" "));
}

/**
 * What a repeated region is, from the page's own words for it.
 *
 * Ordered most specific first: a `<nav aria-label="Breadcrumb">` is
 * breadcrumbs, not navigation, and a footer containing a newsletter form is
 * still the footer. The landmark tags are trusted above class names because a
 * class is a developer's shorthand and a landmark is a statement.
 */
function classifyRole(html: string, element: ElementNode, position: { first: boolean; last: boolean }): { role: SurveyRole; reason: string } {
  const signals = signature(element);
  const words = lower(textOf(html, element)).slice(0, 400);
  const has = (pattern: RegExp) => pattern.test(signals);

  if (has(/\bbreadcrumbs?\b|\bcrumb/)) return { role: "breadcrumbs", reason: "It is marked as breadcrumbs." };
  if (has(/cookie|consent/) && /cookie|consent/.test(words)) return { role: "cookie-notice", reason: "It names cookies or consent." };
  if (element.tag === "header" || has(/\bmasthead\b|\bsite-?header\b|\btop-?bar\b/)) return { role: "header", reason: element.tag === "header" ? "It is a <header> landmark." : "Its own name says header." };
  if (element.tag === "footer" || has(/\bsite-?footer\b|\bfooter\b/)) return { role: "footer", reason: element.tag === "footer" ? "It is a <footer> landmark." : "Its own name says footer." };
  if (has(/newsletter|subscribe|mailing-?list/)) return { role: "newsletter", reason: "It offers a newsletter or a subscription." };
  if (element.tag === "aside" || has(/\bsidebar\b|\bside-?nav\b/)) return { role: "sidebar", reason: element.tag === "aside" ? "It is an <aside> landmark." : "Its own name says sidebar." };
  if (element.tag === "nav" || has(/\bnavbar\b|\bnavigation\b|\bmenu\b/)) return { role: "primary-navigation", reason: element.tag === "nav" ? "It is a <nav> landmark." : "Its own name says navigation." };
  if (has(/\bcta\b|call-to-action/)) return { role: "call-to-action", reason: "Its own name says call to action." };
  if (position.first) return { role: "header", reason: "It is the first block on every page it appears on." };
  if (position.last) return { role: "footer", reason: "It is the last block on every page it appears on." };
  return { role: "unclassified", reason: "It repeats across pages, but nothing in it says what it is." };
}

/* ---------------------------------------------------------------------- CTAs */

export type SurveyCta = {
  words: string;
  href: string | null;
  kind: "button" | "link";
  /** Every page it appears on, so "throughout" is a count rather than a feeling. */
  pageIds: string[];
  occurrences: number;
};

const BUTTONISH = /\bbtn\b|\bbutton\b|\bcta\b/;

/** An action somebody is being asked to take, as opposed to a sentence with a link in it. */
function actionsOn(page: SurveyPage): Array<{ words: string; href: string | null; kind: "button" | "link" }> {
  const found: Array<{ words: string; href: string | null; kind: "button" | "link" }> = [];
  for (const element of walk(parseHtml(page.html))) {
    if (element.tag !== "a" && element.tag !== "button") continue;
    const words = normalise(textOf(page.html, element));
    // Long text is prose that happens to link; empty text is an icon, which has
    // no words to match across pages.
    if (!words || words.length > 60 || words.split(" ").length > 8) continue;
    const classes = lower(attr(element, "class") ?? "");
    const kind = element.tag === "button" || attr(element, "role") === "button" || BUTTONISH.test(classes) ? "button" : "link";
    const href = attr(element, "href") ?? null;
    found.push({ words, href: href ? normalise(href) : null, kind });
  }
  return found;
}

/* ------------------------------------------------------------------ templates */

export type SurveyPageKind = "home" | "catalogue" | "product" | "event" | "article" | "contact" | "other";

export type SurveyTemplate = {
  kind: SurveyPageKind;
  pages: Array<{ pageId: string; title: string; path: string }>;
  /** What the pages had in common, so a wrong grouping can be argued with. */
  signals: string[];
};

const KIND_LABELS: Record<SurveyPageKind, string> = {
  home: "Home",
  catalogue: "Catalogue or listing",
  product: "Product page",
  event: "Event page",
  article: "Article",
  contact: "Contact",
  other: "Other",
};

export function kindLabel(kind: SurveyPageKind): string {
  return KIND_LABELS[kind];
}

const MONEY = /(?:[$£€₵]|GHS|USD|EUR|GBP|NGN)\s?\d[\d,.]*/i;
const BUY = /\badd to (?:cart|basket|bag)\b|\bbuy now\b|\bcheckout\b|\border now\b|\badd to trolley\b/i;
const DATE = /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/i;
const EVENTISH = /\bdoors open\b|\bvenue\b|\brsvp\b|\bregister\b|\btickets?\b|\bagenda\b|\bspeakers?\b/i;

const CHROME = new Set(["header", "footer", "nav", "aside"]);

/** Inside the site's furniture rather than inside the page's own content. */
function inChrome(element: ElementNode): boolean {
  let walker: ElementNode | null = element;
  while (walker) {
    if (CHROME.has(walker.tag)) return true;
    if (/\b(nav|menu|header|footer|breadcrumb)\b/.test(lower(attr(walker, "class") ?? ""))) return true;
    walker = walker.parent;
  }
  return false;
}

/** A card: something you can click that also shows you a picture or a title. */
function cardLike(element: ElementNode): boolean {
  const inside = [...walk(element)];
  const links = inside.some((node) => node.tag === "a" || node.tag === "button");
  const substance = inside.some((node) => node.tag === "img" || /^h[1-6]$/.test(node.tag));
  return links && substance;
}

/** Where each item in a run of siblings sends you, with duplicates kept. */
function destinationsOf(html: string, element: ElementNode): string[] {
  const out: string[] = [];
  for (const node of walk(element)) {
    const href = node.tag === "a" ? attr(node, "href") : undefined;
    if (href) out.push(lower(href));
  }
  return out;
}

/**
 * A run of repeated siblings that is actually a listing.
 *
 * Three sibling blocks that look alike is not enough, and tightening the
 * threshold would not help — the things that trip it are structural, not a
 * matter of degree. Three rules, each about a different way a run can look like
 * a listing without being one, and none of them about any particular website:
 *
 *   - **It must go somewhere, in more than one direction.** A listing offers a
 *     choice; five prose sections that all carry the same "email us" link are a
 *     document. So the run needs at least three *distinct* destinations.
 *   - **Its items must be teasers, not essays.** A card summarises something
 *     found elsewhere. A run whose typical item runs to paragraphs is a page
 *     with headings, which is most long documents ever written.
 *   - **It must not be the site's own menu.** A row of links to the pages in the
 *     header is navigation wherever it appears — in a footer, on a 404 page, in
 *     a "where next" block. The survey already knows which destinations repeat
 *     across the whole site, so it can tell the two apart instead of guessing.
 */
function listingRuns(html: string, root: ElementNode, siteWideLinks: Set<string>): number {
  let most = 0;
  for (const element of walk(root)) {
    if (inChrome(element)) continue;
    const runs = new Map<string, ElementNode[]>();
    for (const child of element.children) {
      if (!cardLike(child)) continue;
      const classes = lower(attr(child, "class") ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      const key = `${child.tag}.${classes}|${child.children.map((grandchild) => grandchild.tag).join(",")}`;
      runs.set(key, [...(runs.get(key) ?? []), child]);
    }

    for (const items of runs.values()) {
      if (items.length < 3) continue;

      const destinations = items.map((item) => destinationsOf(html, item));
      const distinct = new Set(destinations.flat().filter((href) => href && !href.startsWith("#")));
      if (distinct.size < 3) continue;

      const lengths = items.map((item) => normalise(textOf(html, item)).length).sort((left, right) => left - right);
      const typical = lengths[Math.floor(lengths.length / 2)] ?? 0;
      if (typical > 300) continue;

      const navigational = [...distinct].filter((href) => siteWideLinks.has(href)).length;
      if (navigational > distinct.size / 2) continue;

      most = Math.max(most, items.length);
    }
  }
  return most;
}

function classifyPage(page: SurveyPage, siteWideLinks: Set<string>): { kind: SurveyPageKind; signals: string[] } {
  const root = parseHtml(page.html);
  const text = normalise(textOf(page.html, root));
  const path = lower(page.path);
  const signals: string[] = [];

  if (path === "/" || /^\/?(index(\.html?)?)?$/.test(path.replace(/^\//, ""))) return { kind: "home", signals: ["It is the site's front page."] };

  // A page is a contact page when contacting is its purpose, not when it has a
  // form on it: a newsletter box in a footer and the word "contact" in a menu
  // appear on almost every page, and an earlier version of this called an
  // articles index a contact page for exactly that reason.
  const hasForm = [...walk(root)].some((element) => element.tag === "form");
  const hasEmailField = [...walk(root)].some((element) => element.tag === "input" && /email/i.test(`${attr(element, "type") ?? ""} ${attr(element, "name") ?? ""}`));
  const headings = [...walk(root)]
    .filter((element) => /^h[1-2]$/.test(element.tag))
    .map((element) => lower(textOf(page.html, element)))
    .join(" ");
  const saysContact = /\bcontact\b|\bget in touch\b/.test(headings);
  if (/(^|\/)contact(\/|$|\.)/.test(path) || (hasForm && hasEmailField && saysContact)) {
    if (/(^|\/)contact(\/|$|\.)/.test(path)) signals.push("Its address says contact.");
    if (hasForm && hasEmailField) signals.push("It has a form asking for an email address.");
    if (saysContact) signals.push("Its heading is about getting in touch.");
    return { kind: "contact", signals };
  }

  const money = MONEY.test(text);
  const buy = BUY.test(text);
  if (money && buy) {
    signals.push("It shows a price and a way to buy.");
    return { kind: "product", signals };
  }

  if (DATE.test(text) && EVENTISH.test(text)) {
    signals.push("It carries a date alongside event words such as venue, tickets or speakers.");
    return { kind: "event", signals };
  }

  const repeats = listingRuns(page.html, root, siteWideLinks);
  if (repeats >= 3) {
    signals.push(`It repeats one card ${repeats} times, each going somewhere different.`);
    if (money) signals.push("The cards carry prices.");
    return { kind: "catalogue", signals };
  }

  const article = [...walk(root)].some((element) => element.tag === "article");
  const paragraphs = [...walk(root)].filter((element) => element.tag === "p").length;
  if (article || paragraphs >= 6) {
    signals.push(article ? "It has an <article> landmark." : `It is ${paragraphs} paragraphs of prose.`);
    return { kind: "article", signals };
  }

  return { kind: "other", signals: ["Nothing in it matched a known kind of page."] };
}

/* -------------------------------------------------------------------- palette */

export type SurveyColour = {
  value: string;
  uses: number;
  pageIds: string[];
  /** text, background, border — what the colour is actually doing. */
  roles: string[];
};

export type SurveyTypeface = { family: string; uses: number; pageIds: string[] };
export type SurveySizing = { value: string; uses: number };

/** A design token: `--brand-ink: #08101f`, declared once and used by name. */
export type SurveyToken = { name: string; value: string; uses: number; isColour: boolean };

export type SurveyPalette = {
  colours: SurveyColour[];
  typefaces: SurveyTypeface[];
  sizes: SurveySizing[];
  weights: SurveySizing[];
  tokens: SurveyToken[];
  /** How the palette was read, so a thin one can be told from a plain one. */
  readFrom: { stylesheets: number; inline: boolean };
};

const COLOUR_VALUE = /#[0-9a-f]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/gi;
/** The same question without `/g`, whose `lastIndex` makes repeated `test` calls alternate. */
const LOOKS_LIKE_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
const DECLARATION = /([-a-z]+)\s*:\s*([^;{}]+)/gi;

/** `#abc` and `#AABBCC` are one colour, and a survey that lists both is noise. */
function normaliseColour(value: string): string {
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]!}${short[1]!}${short[2]!}${short[2]!}${short[3]!}${short[3]!}`;
  return text.replace(/\s+/g, " ");
}

function colourRole(property: string): string | null {
  if (/^color$/.test(property)) return "text";
  if (/background/.test(property)) return "background";
  if (/border|outline/.test(property)) return "border";
  if (/shadow/.test(property)) return "shadow";
  if (/fill|stroke/.test(property)) return "graphics";
  return null;
}

/** Every CSS declaration the page carries, from `<style>` blocks and `style` attributes alike. */
function declarationsOf(page: SurveyPage): Array<{ property: string; value: string }> {
  const out: Array<{ property: string; value: string }> = [];
  const collect = (css: string) => {
    DECLARATION.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DECLARATION.exec(css))) out.push({ property: match[1]!.toLowerCase(), value: match[2]!.trim() });
  };
  // The site's own stylesheets first: on most websites this is the whole
  // design, and the page carries only what somebody typed into a style
  // attribute afterwards.
  for (const sheet of page.stylesheets ?? []) collect(sheet.css);
  for (const element of walk(parseHtml(page.html))) {
    if (element.tag === "style") collect(page.html.slice(element.innerStart, element.innerEnd));
    const inline = attr(element, "style");
    if (inline) collect(inline);
  }
  return out;
}

/**
 * What a `var(--name)` resolves to, so a token is not a dead end.
 *
 * A site that declares `--brand: #b8ff3d` and then writes
 * `background: var(--brand)` everywhere has one colour and a hundred uses of
 * it. Reading only the literal values would find the colour once, in the
 * declaration, and report the site as almost colourless. One pass of
 * substitution is enough for the way stylesheets are actually written; tokens
 * defined in terms of other tokens resolve on the second pass, and anything
 * deeper stays a token rather than becoming a wrong colour.
 */
function resolveTokens(declarations: Array<{ property: string; value: string }>): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const { property, value } of declarations) if (property.startsWith("--")) tokens.set(property, value);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [name, value] of tokens) {
      const resolved = value.replace(/var\(\s*(--[-\w]+)\s*(?:,[^)]*)?\)/g, (whole, reference: string) => tokens.get(reference) ?? whole);
      if (resolved !== value) tokens.set(name, resolved);
    }
  }
  return tokens;
}

function buildPalette(pages: SurveyPage[]): SurveyPalette {
  const colours = new Map<string, { uses: number; pageIds: Set<string>; roles: Set<string> }>();
  const typefaces = new Map<string, { uses: number; pageIds: Set<string> }>();
  const sizes = new Map<string, number>();
  const weights = new Map<string, number>();

  const tokenUses = new Map<string, number>();
  let sheetsRead = 0;
  let inlineSeen = false;

  for (const page of pages) {
    sheetsRead += page.stylesheets?.length ?? 0;
    if (/<style[\s>]/i.test(page.html) || /\sstyle\s*=/i.test(page.html)) inlineSeen = true;
    const declarations = declarationsOf(page);
    const tokens = resolveTokens(declarations);
    for (const { property, value } of declarations) {
      if (property.startsWith("--")) continue;
      if (/^\s*var\(/.test(value)) {
        const reference = /var\(\s*(--[-\w]+)/.exec(value)?.[1];
        if (reference) tokenUses.set(reference, (tokenUses.get(reference) ?? 0) + 1);
      }
      // A value written as var(--brand) is the colour the token holds. Without
      // this the palette finds each colour once, in its own declaration, and
      // calls a site that uses tokens everywhere almost colourless.
      const resolved = value.replace(/var\(\s*(--[-\w]+)\s*(?:,[^)]*)?\)/g, (whole, reference: string) => tokens.get(reference) ?? whole);
      const role = colourRole(property);
      if (role) {
        COLOUR_VALUE.lastIndex = 0;
        for (const raw of resolved.match(COLOUR_VALUE) ?? []) {
          const key = normaliseColour(raw);
          const entry = colours.get(key) ?? { uses: 0, pageIds: new Set<string>(), roles: new Set<string>() };
          entry.uses += 1;
          entry.pageIds.add(page.pageId);
          entry.roles.add(role);
          colours.set(key, entry);
        }
      }
      if (property === "font-family") {
        // The first family is the one the site means; the rest are what it
        // falls back to when that one is missing.
        const family = resolved.split(",")[0]!.replace(/["']/g, "").trim().toLowerCase();
        if (family && !/^(inherit|initial|unset|var\()/.test(family)) {
          const entry = typefaces.get(family) ?? { uses: 0, pageIds: new Set<string>() };
          entry.uses += 1;
          entry.pageIds.add(page.pageId);
          typefaces.set(family, entry);
        }
      }
      if (property === "font-size") sizes.set(resolved.toLowerCase(), (sizes.get(resolved.toLowerCase()) ?? 0) + 1);
      if (property === "font-weight") weights.set(resolved.toLowerCase(), (weights.get(resolved.toLowerCase()) ?? 0) + 1);
    }
  }

  // One list of tokens for the whole site: a token is declared once and meant
  // to be the same everywhere, so reporting it per page would be reporting the
  // stylesheet's line count.
  const allTokens = [...new Map(pages.flatMap((page) => [...resolveTokens(declarationsOf(page))])).entries()];

  const byUse = <T extends { uses: number }>(left: T, right: T) => right.uses - left.uses;
  return {
    colours: [...colours.entries()]
      .map(([value, entry]) => ({ value, uses: entry.uses, pageIds: [...entry.pageIds], roles: [...entry.roles].sort() }))
      .sort((left, right) => byUse(left, right) || left.value.localeCompare(right.value)),
    typefaces: [...typefaces.entries()]
      .map(([family, entry]) => ({ family, uses: entry.uses, pageIds: [...entry.pageIds] }))
      .sort((left, right) => byUse(left, right) || left.family.localeCompare(right.family)),
    sizes: [...sizes.entries()].map(([value, uses]) => ({ value, uses })).sort((left, right) => byUse(left, right) || left.value.localeCompare(right.value)),
    weights: [...weights.entries()].map(([value, uses]) => ({ value, uses })).sort((left, right) => byUse(left, right) || left.value.localeCompare(right.value)),
    tokens: allTokens
      .map(([name, value]) => ({ name, value, uses: tokenUses.get(name) ?? 0, isColour: LOOKS_LIKE_COLOUR.test(value) }))
      .sort((left, right) => byUse(left, right) || left.name.localeCompare(right.name)),
    readFrom: { stylesheets: sheetsRead, inline: inlineSeen },
  };
}

/* --------------------------------------------------------------------- survey */

export type SiteSurvey = {
  pagesRead: number;
  elements: SurveyElement[];
  callsToAction: SurveyCta[];
  templates: SurveyTemplate[];
  palette: SurveyPalette;
};

/** Where a candidate's instances sit in their pages, so position can name a region. */
function positionOf(pages: SurveyPage[], instances: Array<{ pageId: string; fieldId: string }>): { first: boolean; last: boolean } {
  let first = instances.length > 0;
  let last = instances.length > 0;
  for (const instance of instances) {
    const page = pages.find((candidate) => candidate.pageId === instance.pageId);
    if (!page) continue;
    const blocks = indexOf(page).blocks;
    if (!blocks.length) continue;
    const element = elementForInstance(page, instance.fieldId);
    if (!element) continue;
    const top = topBlockOf(element, blocks);
    if (top !== blocks[0]) first = false;
    if (top !== blocks[blocks.length - 1]) last = false;
  }
  return { first, last };
}

function findBody(root: ElementNode): ElementNode | null {
  for (const element of walk(root)) if (element.tag === "body") return element;
  return root.children.length ? root : null;
}

function topBlockOf(element: ElementNode, blocks: ElementNode[]): ElementNode | null {
  let walker: ElementNode | null = element;
  while (walker) {
    if (blocks.includes(walker)) return walker;
    walker = walker.parent;
  }
  return null;
}

/**
 * The element a candidate instance points at.
 *
 * `sharedCandidates` returns field ids, which are positional names like
 * `layout.3` and say nothing about where the element is in the document. The
 * field's `attrInsert` does: it is the offset just past the tag name, which is
 * one arithmetic step from the `<` that opens the element. That is the same
 * step the shared module takes, so this stays a lookup rather than a second
 * opinion about what a field is.
 */
/**
 * Each page parsed once, however many times it is asked about.
 *
 * Every instance of every candidate region asks which element it is, and the
 * first version answered by re-reading the whole page each time. On a large
 * real page — 3,837 elements — that was thirty-four seconds for two pages,
 * against one second for the detection feeding it. Keyed on the page object
 * rather than its id, so nothing leaks between surveys and nothing has to be
 * threaded through every function that wants it.
 */
type PageIndex = { root: ElementNode; byField: Map<string, ElementNode>; blocks: ElementNode[] };

const pageIndexes = new WeakMap<SurveyPage, PageIndex>();

/**
 * One parse per page, and everything about it derived from that same tree.
 *
 * Sharing the tree is not only about speed. `topBlockOf` asks whether an
 * element *is* one of the page's outermost blocks, which is an identity
 * comparison — so an element from one parse and a block list from another can
 * never match, and the position rules that name an unlabelled first block a
 * header silently never fired. They were two parses before this.
 */
function indexOf(page: SurveyPage): PageIndex {
  const held = pageIndexes.get(page);
  if (held) return held;

  const root = parseHtml(page.html);
  const byOffset = new Map<number, ElementNode>();
  for (const element of walk(root)) byOffset.set(element.start + 1 + element.tag.length, element);

  const byField = new Map<string, ElementNode>();
  for (const field of readPage(page.html).fields) {
    if (field.attrInsert === undefined) continue;
    const element = byOffset.get(field.attrInsert);
    if (element) byField.set(field.id, element);
  }

  const body = findBody(root);
  const blocks = body ? body.children.filter((child) => !["script", "style", "template"].includes(child.tag)) : [];

  const index = { root, byField, blocks };
  pageIndexes.set(page, index);
  return index;
}

function elementsByField(page: SurveyPage): Map<string, ElementNode> {
  return indexOf(page).byField;
}

function elementForInstance(page: SurveyPage, fieldId: string): ElementNode | null {
  return elementsByField(page).get(fieldId) ?? null;
}

/**
 * Read a whole website and say what it is made of.
 *
 * Pages are given rather than fetched, so this is pure: the caller decides
 * whether the source is the repository, the live site or an import, and a check
 * can hand it fixtures without a network or a database.
 */
export function surveySite(pages: SurveyPage[]): SiteSurvey {
  const elements: SurveyElement[] = [];
  for (const candidate of sharedCandidates(pages.map((page) => ({ pageId: page.pageId, title: page.title, html: page.html })))) {
    const pageIds = [...new Set(candidate.instances.map((instance) => instance.pageId))];
    const first = candidate.instances[0];
    const page = first ? pages.find((entry) => entry.pageId === first.pageId) : undefined;
    const element = page && first ? elementForInstance(page, first.fieldId) : null;
    const classified = element && page
      ? classifyRole(page.html, element, positionOf(pages, candidate.instances))
      : { role: "unclassified" as SurveyRole, reason: "It repeats across pages, but nothing in it says what it is." };
    elements.push({
      key: candidate.key,
      name: candidate.name,
      role: classified.role,
      roleReason: classified.reason,
      confidence: candidate.confidence,
      reason: candidate.reason,
      instances: candidate.instances,
      pageIds,
      everywhere: pages.length > 1 && pageIds.length === pages.length,
    });
  }

  // Named regions first, then whatever reaches the most pages. A website of any
  // size has dozens of blocks that repeat somewhere; the ones worth a reader's
  // attention are the ones that were identifiable and the ones that are on
  // everything. An unnamed block on two pages out of seventeen is true, and it
  // is not what somebody opened this to find out.
  const ROLE_ORDER: SurveyRole[] = ["header", "primary-navigation", "breadcrumbs", "footer", "sidebar", "call-to-action", "newsletter", "cookie-notice", "unclassified"];
  elements.sort(
    (left, right) =>
      ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role) ||
      Number(right.everywhere) - Number(left.everywhere) ||
      right.pageIds.length - left.pageIds.length ||
      left.name.localeCompare(right.name),
  );

  const actions = new Map<string, { words: string; href: string | null; kind: "button" | "link"; pageIds: Set<string>; occurrences: number }>();
  for (const page of pages) {
    for (const action of actionsOn(page)) {
      const key = `${lower(action.words)}|${action.href ?? ""}`;
      const entry = actions.get(key) ?? { words: action.words, href: action.href, kind: action.kind, pageIds: new Set<string>(), occurrences: 0 };
      // A button anywhere makes the group a button: the same words styled as a
      // button on one page and a plain link on another is still the same ask.
      if (action.kind === "button") entry.kind = "button";
      entry.pageIds.add(page.pageId);
      entry.occurrences += 1;
      actions.set(key, entry);
    }
  }

  const callsToAction = [...actions.values()]
    .filter((entry) => entry.pageIds.size >= 2)
    .map((entry) => ({ words: entry.words, href: entry.href, kind: entry.kind, pageIds: [...entry.pageIds], occurrences: entry.occurrences }))
    .sort((left, right) => right.pageIds.length - left.pageIds.length || right.occurrences - left.occurrences || left.words.localeCompare(right.words));

  // Where the site's own navigation goes. A destination reached from most of the
  // pages is part of the furniture wherever it turns up, which is what lets a
  // "where next" block of site links be told from a listing of things.
  const siteWideLinks = new Set(
    [...actions.values()]
      .filter((entry) => entry.href && entry.kind === "link" && entry.pageIds.size > pages.length / 2)
      .map((entry) => entry.href!.toLowerCase()),
  );

  const byKind = new Map<SurveyPageKind, SurveyTemplate>();
  for (const page of pages) {
    const { kind, signals } = classifyPage(page, siteWideLinks);
    const template = byKind.get(kind) ?? { kind, pages: [], signals: [] };
    template.pages.push({ pageId: page.pageId, title: page.title, path: page.path });
    for (const signal of signals) if (!template.signals.includes(signal)) template.signals.push(signal);
    byKind.set(kind, template);
  }

  const order: SurveyPageKind[] = ["home", "catalogue", "product", "event", "article", "contact", "other"];
  const templates = [...byKind.values()].sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind));

  return { pagesRead: pages.length, elements, callsToAction, templates, palette: buildPalette(pages) };
}
