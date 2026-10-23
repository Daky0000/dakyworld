/**
 * What the Builder agent's model is shown of a page: every element on it,
 * once, as an indented outline.
 *
 * It was the first 220 fields as JSON. The DakyX homepage has 343, so the
 * bottom third of it — the footer among it — did not exist as far as the model
 * knew, and each of the 220 carried its keys spelled out (`"label":`,
 * `"kind":`, `"tag":`, `"value":`) at about 160 characters apiece: 34,700
 * characters of page data on every request, "make this bold" included. Nothing
 * said which heading sat in which section, either — 94 of the fields were
 * containers named only "Container 12".
 *
 * An outline answers all three. A line is the id, what the element is and a
 * few words of what it says; nesting is indentation, so a heading is plainly
 * inside the pricing section; a section's line carries its own heading's words;
 * and the style of an element goes only where it is likely to matter — the
 * selected element and the containers around it — with short inline styles
 * elsewhere while there is room. The whole homepage fits in less than the old
 * list of two thirds of it.
 *
 * Pure, so `checks/websiteAgentOutline.ts` holds it without a database.
 */
import type { SiteField, SiteSection } from "./website/index.js";
import type { SitePage } from "@prisma/client";

export type OutlineLocks = { writable: Set<string>; notes: Map<string, string>; failure?: string } | null;
export type OutlineControls = Record<string, { remove?: boolean; duplicate?: boolean; move?: boolean } | undefined>;

export type PageOutline = {
  /** The outline itself, one element a line. */
  text: string;
  /** Elements written out, and on the page. Equal unless the page ran past `maxLines`. */
  shown: number;
  total: number;
  /** Lock notes, numbered once and referred to as [L1], [L2] on the lines they apply to. */
  legend: string[];
};

const TEXT_CHARS = 60;
const HEADING_CHARS = 90;
const HREF_CHARS = 60;
const STYLE_CHARS = 90;
/** Inline styles shown on lines other than the selected element and its containers, in characters. */
const STYLE_BUDGET = 4_000;
const MAX_DEPTH = 14;

/** "Your Technology Team. Without the…" — plain words, one line, quoted. */
function words(text: string | undefined, max: number): string {
  const plain = (text ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&reg;/gi, "®")
    .replace(/&#?[a-z0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  return JSON.stringify(plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain);
}

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What the element is, in the fewest characters that still say it. */
function what(field: SiteField): string {
  switch (field.kind) {
    case "button": return "button";
    case "link": return "link";
    case "image": return "img";
    case "icon": return "icon";
    case "background": return "bg";
    case "unsupported": return `embed:${field.tag}`;
    case "container": return field.tag;
    default: return field.tag === "title" ? "title" : field.tag === "meta" ? "meta" : field.tag;
  }
}

/** The file a picture is, without the address around it: "team-meeting.webp". */
function fileOf(source: string): string {
  const clean = source.split(/[?#]/)[0] ?? "";
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  return short(name || clean, 48);
}

/**
 * The outline of one page.
 *
 * `selectedId` is drawn with `◀ selected` and gets its whole style; so do the
 * containers above it, because "make this section's background darker" is
 * about one of them. Past `maxLines` the deepest lines go first, and the
 * container they were in says how many it holds — its id stays, so the model
 * can still delete, move or restyle it whole.
 */
export function pageOutline(input: {
  fields: SiteField[];
  sections?: SiteSection[];
  controls?: OutlineControls;
  locks?: OutlineLocks;
  selectedId?: string | null;
  maxLines?: number;
  /** Leave styles out entirely — for a second page shown alongside the open one. */
  styles?: boolean;
}): PageOutline {
  const { fields } = input;
  const maxLines = input.maxLines ?? 700;
  const byId = new Map(fields.map((field) => [field.id, field]));
  const children = new Map<string, SiteField[]>();
  const roots: SiteField[] = [];
  for (const field of fields) {
    const parent = field.parentId && byId.has(field.parentId) && field.parentId !== field.id ? field.parentId : null;
    if (parent) {
      const list = children.get(parent) ?? [];
      list.push(field);
      children.set(parent, list);
    } else roots.push(field);
  }
  const order = (a: SiteField, b: SiteField) => (a.order ?? 0) - (b.order ?? 0);
  roots.sort(order);
  for (const list of children.values()) list.sort(order);

  // A section's container carries the section's own heading, as the editor's
  // section list names it: `s6` "What changed for our clients". The container
  // is the outermost one whose descendants are mostly that section's fields.
  const sectionLabel = new Map((input.sections ?? []).filter((section) => /^s\d+$/.test(section.id)).map((section) => [section.id, section.label]));
  const sectionOf = (id: string) => /^(s\d+)\./.exec(id)?.[1] ?? null;
  const labels = new Map<string, string>();
  const claimed = new Set<string>();
  const descend = (field: SiteField, into: SiteField[]) => {
    for (const child of children.get(field.id) ?? []) {
      into.push(child);
      descend(child, into);
    }
    return into;
  };
  const visitForLabels = (field: SiteField) => {
    if (field.kind === "container" && ["header", "footer", "section", "article", "aside"].includes(field.tag)) {
      const inside = descend(field, []);
      const counts = new Map<string, number>();
      for (const child of inside) {
        const section = sectionOf(child.id);
        if (section) counts.set(section, (counts.get(section) ?? 0) + 1);
      }
      const [best, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
      // The section's own element: the editor makes sections of exactly these
      // tags. A `main` or `div` around one section is not that section, and
      // labelled as it, it is the line a model picks to change the heading.
      if (best && count && counts.size === 1 && !claimed.has(best) && sectionLabel.has(best)) {
        labels.set(field.id, sectionLabel.get(best)!);
        claimed.add(best);
        return;
      }
    }
    for (const child of children.get(field.id) ?? []) visitForLabels(child);
  };
  for (const root of roots) visitForLabels(root);

  // The selected element's containers, which get their styles in full.
  const ancestors = new Set<string>();
  let walker = input.selectedId ? byId.get(input.selectedId) : undefined;
  while (walker?.parentId && byId.has(walker.parentId) && !ancestors.has(walker.parentId)) {
    ancestors.add(walker.parentId);
    walker = byId.get(walker.parentId);
  }

  const legend: string[] = [];
  const lockRef = (field: SiteField): string => {
    if (!input.locks || input.locks.writable.has(field.id)) return "";
    const note = input.locks.notes.get(field.id) ?? input.locks.failure ?? "This comes from the site's code, not from text it holds.";
    let index = legend.indexOf(note);
    if (index < 0) { legend.push(note); index = legend.length - 1; }
    return ` [locked L${index + 1}]`;
  };

  let styleLeft = STYLE_BUDGET;
  const line = (field: SiteField, depth: number, hidden: number): string => {
    const selected = field.id === input.selectedId;
    const parts: string[] = [`${" ".repeat(Math.min(depth, MAX_DEPTH))}${field.id} ${what(field)}`];
    const label = labels.get(field.id);
    if (label) parts.push(`§${words(label, HEADING_CHARS)}`);
    if (field.kind === "image") {
      if (field.alt) parts.push(`alt=${words(field.alt, TEXT_CHARS)}`);
      else if (field.alt === undefined && !field.decorative) parts.push("alt=missing");
      parts.push(`src=${fileOf(field.value)}`);
    } else if (field.kind === "icon" || field.kind === "container" || field.kind === "unsupported") {
      // Their words are their children's.
    } else if (field.kind === "background") {
      parts.push(short(field.value, 70));
    } else {
      // A link around a picture has no words of its own, and its preview is its address.
      const said = field.preview && field.preview === field.href ? field.value : field.preview || field.value;
      const text = words(said, selected ? 600 : /^h[1-6]$|^title$/.test(field.tag) ? HEADING_CHARS : TEXT_CHARS);
      parts.push(text || '""');
    }
    // Words that could become a link carry an empty `href`; only a link says where it goes.
    if (field.kind === "link" || field.kind === "button") parts.push(`→${short(field.href || "(nowhere)", HREF_CHARS)}`);
    else if (field.href) parts.push(`→${short(field.href, HREF_CHARS)}`);
    if (field.variant) parts.push(`variant=${field.variant}`);
    if (field.newTab) parts.push("newtab");
    const control = input.controls?.[field.id];
    if (control && field.kind === "container") {
      const cannot = [!control.remove && "delete", !control.duplicate && "duplicate", control.move === false && "move"].filter(Boolean);
      if (cannot.length === 3) parts.push("[fixed]");
      else if (cannot.length) parts.push(`[no ${cannot.join("/")}]`);
    }
    parts.push(lockRef(field).trim());
    if (input.styles !== false && field.style) {
      if (selected || ancestors.has(field.id)) parts.push(`{${field.style}}`);
      else if (field.style.length <= STYLE_CHARS && styleLeft >= field.style.length) {
        styleLeft -= field.style.length;
        parts.push(`{${field.style}}`);
      }
    }
    if (hidden) parts.push(`(+${hidden} more inside)`);
    if (selected) parts.push("◀ selected");
    return parts.filter(Boolean).join(" ");
  };

  // Depth at which lines stop being written, lowered until the page fits.
  const total = fields.length;
  const depthOf = new Map<string, number>();
  const measure = (field: SiteField, depth: number) => {
    depthOf.set(field.id, depth);
    for (const child of children.get(field.id) ?? []) measure(child, depth + 1);
  };
  for (const root of roots) measure(root, 0);
  let cutoff = Infinity;
  if (total > maxLines) {
    const depths = [...depthOf.values()].sort((a, b) => a - b);
    cutoff = depths[maxLines - 1] ?? Infinity;
    // Everything at the cutoff depth fits only if the count allows; one shallower otherwise.
    if (depths.filter((depth) => depth <= cutoff).length > maxLines) cutoff -= 1;
  }
  const keep = (field: SiteField) => (depthOf.get(field.id) ?? 0) <= cutoff || field.id === input.selectedId || ancestors.has(field.id);
  const countInside = (field: SiteField): number => (children.get(field.id) ?? []).reduce((sum, child) => sum + 1 + countInside(child), 0);

  const lines: string[] = [];
  let shown = 0;
  const write = (field: SiteField, depth: number) => {
    const kids = children.get(field.id) ?? [];
    const visible = kids.filter(keep);
    const hidden = kids.filter((kid) => !keep(kid)).reduce((sum, kid) => sum + 1 + countInside(kid), 0);
    lines.push(line(field, depth, hidden));
    shown += 1;
    for (const kid of visible) write(kid, depth + 1);
  };
  for (const root of roots) if (keep(root)) write(root, 0);

  return { text: lines.join("\n"), shown, total, legend };
}

/** The selected element in full: what the outline only abbreviates. */
export function selectedDetails(field: SiteField | undefined): Record<string, unknown> | null {
  if (!field) return null;
  return {
    id: field.id,
    kind: field.kind,
    tag: field.tag,
    label: field.label,
    value: field.value.slice(0, 1_200),
    ...(field.href !== undefined ? { href: field.href } : {}),
    ...(field.alt !== undefined ? { alt: field.alt } : {}),
    ...(field.style ? { style: field.style } : {}),
    ...(field.responsive?.tablet || field.responsive?.mobile ? { responsive: field.responsive } : {}),
    ...(field.variant !== undefined ? { variant: field.variant, variantsOnPage: field.variantsOnPage ?? [] } : {}),
    ...(field.newTab !== undefined ? { newTab: field.newTab } : {}),
    ...(field.classes ? { classes: field.classes } : {}),
  };
}

/**
 * Facts about the page a review would otherwise have to find by reading it:
 * a picture with no description, a page with no main heading or three, a link
 * to nowhere, a title Google will cut off, words still in [square brackets]
 * from a ready-made section. Counted here because a model asked to count them
 * gets the count wrong; it is good at saying what to do about them.
 */
export function pageFacts(fields: SiteField[]): string[] {
  const facts: string[] = [];
  const ids = (list: SiteField[]) => `${list.slice(0, 8).map((field) => field.id).join(", ")}${list.length > 8 ? ` and ${list.length - 8} more` : ""}`;
  const noAlt = fields.filter((field) => field.kind === "image" && field.alt === undefined && !field.decorative && field.tag === "img");
  if (noAlt.length) facts.push(`${noAlt.length} picture${noAlt.length === 1 ? " has" : "s have"} no description (alt text): ${ids(noAlt)}.`);
  const h1 = fields.filter((field) => field.tag === "h1");
  if (h1.length === 0) facts.push("The page has no main heading (h1).");
  else if (h1.length > 1) facts.push(`The page has ${h1.length} main headings (h1): ${ids(h1)}. One is usual.`);
  const nowhere = fields.filter((field) => (field.kind === "link" || field.kind === "button") && field.href !== undefined && /^(?:#?|javascript:.*)$/i.test(field.href.trim()));
  if (nowhere.length) facts.push(`${nowhere.length} link${nowhere.length === 1 ? " goes" : "s go"} nowhere (empty or #): ${ids(nowhere)}.`);
  const vague = fields.filter((field) => (field.kind === "link" || field.kind === "button") && /^(?:click here|here|read more|learn more|more|find out more)$/i.test((field.preview || field.value).trim()));
  if (vague.length >= 3) facts.push(`${vague.length} links say only "learn more", "read more" or "click here": ${ids(vague)}. Saying where they go helps people and search engines.`);
  const title = fields.find((field) => field.id === "meta.0");
  const titleText = (title?.preview || title?.value || "").trim();
  if (!titleText) facts.push("The page has no browser title (meta.0).");
  else if (titleText.length > 60) facts.push(`The browser title (meta.0) is ${titleText.length} characters; search results cut it off near 60.`);
  const description = fields.find((field) => field.id === "meta.1");
  const descriptionText = (description?.preview || description?.value || "").trim();
  if (!description || !descriptionText) facts.push("The page has no search description (meta.1).");
  else if (descriptionText.length > 160) facts.push(`The search description (meta.1) is ${descriptionText.length} characters; search results cut it off near 160.`);
  else if (descriptionText.length < 50) facts.push(`The search description (meta.1) is only ${descriptionText.length} characters.`);
  const placeholders = fields.filter((field) => field.kind !== "container" && /\[[A-Z][^\]]{1,40}\]|lorem ipsum/i.test(field.preview || field.value));
  if (placeholders.length) facts.push(`${placeholders.length} element${placeholders.length === 1 ? " still holds" : "s still hold"} placeholder words such as [Customer name]: ${ids(placeholders)}. Only the business can fill these; never invent them.`);
  return facts;
}

/**
 * Pages the request names besides the open one: "on the About page", "the
 * contact page", "/services". At most two, because each one sent is a whole
 * outline; a request about more pages than that is a site-wide change, which
 * the site-wide operations do without being shown every page.
 */
export function mentionedPages(prompt: string, pages: SitePage[], currentPageId: string | null): SitePage[] {
  const lower = ` ${prompt.toLowerCase().replace(/[“”"']/g, " ")} `;
  const found: SitePage[] = [];
  for (const page of pages) {
    if (page.id === currentPageId || page.status === "HIDDEN") continue;
    const title = page.title.trim().toLowerCase();
    const path = page.path.trim().toLowerCase();
    const named =
      (title.length >= 3 && new RegExp(`\\b(?:the\\s+|our\\s+|my\\s+)?${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+page\\b`).test(lower)) ||
      // "on the Contact section" is about this page's contact section, not the Contact page.
      (title.length >= 3 && new RegExp(`\\bon\\s+(?:the\\s+)?${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?!\\s+(?:section|block|button|form|link|heading|card|part|area|bit|box))`).test(lower)) ||
      (path.length > 1 && new RegExp(`(?:^|\\s)${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|[.,!?]|$)`).test(lower));
    if (named) found.push(page);
    if (found.length === 2) break;
  }
  return found;
}

/** The site's pages as the model is shown them: the open one, the named ones, then the nearest by path, at most `limit`. */
export function pageList(pages: SitePage[], first: SitePage[], limit = 30): { list: Array<{ id: string; title: string; path: string }>; more: number } {
  const live = pages.filter((page) => page.status !== "HIDDEN");
  const firstIds = new Set(first.map((page) => page.id));
  const rest = live.filter((page) => !firstIds.has(page.id)).sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  const chosen = [...first, ...rest].slice(0, limit);
  return { list: chosen.map((page) => ({ id: page.id, title: page.title, path: page.path })), more: Math.max(0, live.length - chosen.length) };
}
