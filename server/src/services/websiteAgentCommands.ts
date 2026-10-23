/**
 * The Builder agent's exact commands: the few requests a rule answers without
 * asking a model.
 *
 * Until 23 Oct 2026 the rules matched on single words and ran before the
 * model, so they took requests they could not do. Run against the DakyX
 * homepage, eight ordinary sentences all went to a rule and none to the model:
 * "remove the word 'external' from this heading" deleted the heading, "remove
 * the underline from the links" deleted a link, "clear the background colour"
 * deleted the selected heading, "delete the testimonials section" deleted the
 * logo, "make the background blue and the text white" did half of it, "copy
 * this text into the footer" duplicated the heading in place, "move the
 * booking button below the pricing cards" moved the first button one place,
 * and "change font to Inter" with one heading selected changed 180 elements,
 * the browser title among them.
 *
 * So a rule now takes a message only when the **whole** message is one exact
 * command, and when it acts on the selected element, only when the words name
 * that element: "delete this", "delete the hero heading" with the hero
 * heading selected, "move this section up". Anything else — a second clause,
 * a target named only in words, a preposition saying where — is the model's,
 * which sees the whole page. A rule is free and instant; a wrong rule costs a
 * person more than a credit. `checks/websiteAgentRouting.ts` holds the eight
 * sentences, and the commands that must still be rules.
 */
import type { SiteField, SiteSection } from "./website/index.js";

export type TargetWords = {
  /** "this", "it", "that", "the selected one". */
  pronoun: boolean;
  /** The kind of thing named: heading, button, section… */
  noun: string | null;
  /** The words before the noun: "hero" in "the hero heading". Each must describe the element. */
  qualifiers: string[];
};

export type ExactCommand =
  | { kind: "delete"; target: TargetWords; textOnly: boolean }
  | { kind: "duplicate"; target: TargetWords }
  | { kind: "move"; target: TargetWords; direction: "up" | "down" }
  | { kind: "clear-all-text" }
  | { kind: "style"; property: string; value: string }
  | { kind: "font"; from: string; to: string; siteWide: boolean }
  | { kind: "text"; target: TargetWords; value: string }
  | { kind: "replace"; find: string; replace: string }
  | { kind: "color"; from: string; to: string }
  | { kind: "phone"; from: string | null; to: string }
  | { kind: "email"; from: string | null; to: string };

const POLITE = String.raw`(?:(?:please|pls|kindly|now|ok|okay)[,\s]+)?(?:(?:can|could|would)\s+you\s+)?`;
const END = String.raw`(?:\s+(?:please|for me|now|thanks|thank you))?\s*[.!]*\s*$`;

const NOUNS = [
  "element", "block", "section", "heading", "headline", "title", "subtitle", "subheading", "text", "paragraph",
  "image", "picture", "photo", "logo", "button", "link", "card", "row", "column", "item", "container", "box",
  "banner", "hero", "icon", "line", "sentence", "part", "bit", "thing", "one", "area", "panel", "list", "div",
];
const NOUN = `(?:${NOUNS.map((noun) => `${noun}s?`).join("|")})`;
/** Words that mean the qualifiers have become a phrase about something else. */
const NOT_A_QUALIFIER = /^(?:from|in|on|of|to|with|into|onto|at|and|or|but|then|by|for|under|below|above|after|before|between|inside|within|across|over|near|next|so|that|which|who|where|word|words|letter|letters|underline|colour|color|background|border|shadow|font|style|spacing|padding|margin)$/;
const QUALIFIER = String.raw`[a-z0-9][a-z0-9&'-]*`;

/**
 * "this", "it", "the selected element", "this section", "the hero heading" —
 * whole, and nothing after it. Returns null for anything that says more.
 */
function targetWords(object: string): TargetWords | null {
  const text = object.trim().toLowerCase();
  if (/^(?:this|that|it|them|these|those)$/.test(text)) return { pronoun: true, noun: null, qualifiers: [] };
  if (/^(?:the\s+)?selected(?:\s+(?:one|element|block|item))?$/.test(text)) return { pronoun: true, noun: null, qualifiers: [] };
  const named = new RegExp(`^(?:(this|that|the|these|those)\\s+)(?:selected\\s+)?((?:${QUALIFIER}\\s+){0,3})(${NOUN})$`).exec(text);
  if (!named) return null;
  const qualifiers = (named[2] ?? "").trim().split(/\s+/).filter(Boolean);
  if (qualifiers.some((word) => NOT_A_QUALIFIER.test(word))) return null;
  const noun = named[3]!.replace(/s$/, "");
  const pointing = named[1] === "this" || named[1] === "that" || named[1] === "these" || named[1] === "those";
  return { pronoun: pointing && qualifiers.length === 0, noun, qualifiers };
}

const NAMED_COLOURS = new Set([
  "black", "white", "red", "green", "blue", "yellow", "orange", "purple", "pink", "gray", "grey", "brown", "navy",
  "teal", "maroon", "olive", "lime", "aqua", "cyan", "magenta", "silver", "gold", "beige", "indigo", "violet",
  "coral", "salmon", "crimson", "turquoise", "lavender", "transparent",
]);
const COLOUR = String.raw`(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([^)]{3,40}\)|[a-z]{3,12})`;
const isColour = (value: string) => /^#[0-9a-f]{3,8}$/i.test(value) || /^(?:rgb|rgba|hsl|hsla)\(/i.test(value) || NAMED_COLOURS.has(value.toLowerCase());

/** The one exact command this message is, or null when it is anything more. */
export function parseExactCommand(message: string): ExactCommand | null {
  // Matched without regard to case, read back as written: "#1E293B" and "Inter" stay as typed.
  const raw = message.trim().replace(/\s+/g, " ");
  const re = (source: string) => new RegExp(source, "i");

  if (re(`^${POLITE}(?:delete|clear|remove|erase|wipe)\\s+(?:all|every|the\\s+whole|the\\s+entire)\\s+(?:of\\s+the\\s+)?text(?:\\s+on\\s+(?:this|the)\\s+page)?${END}`).test(raw)) return { kind: "clear-all-text" };

  // Delete: the verb, an optional "the text in", and a target — nothing more.
  const del = re(`^${POLITE}(?:delete|remove|erase|get\\s+rid\\s+of|take\\s+out|drop)\\s+(?:(the\\s+(?:text|words)\\s+(?:in|of|from)\\s+))?(.+?)${END}`).exec(raw);
  if (del) {
    const target = targetWords(del[2]!);
    if (target) return { kind: "delete", target, textOnly: Boolean(del[1]) };
  }

  const dup = re(`^${POLITE}(?:duplicate|clone|copy)\\s+(.+?)${END}`).exec(raw);
  if (dup) {
    const target = targetWords(dup[1]!);
    if (target) return { kind: "duplicate", target };
  }

  const move = re(`^${POLITE}(?:move|shift|bring)\\s+(.+?)\\s+(up|down)(?:\\s+(?:one|a)\\s+(?:place|step|spot|position|bit))?${END}`).exec(raw);
  if (move) {
    const target = targetWords(move[1]!);
    if (target) return { kind: "move", target, direction: move[2]!.toLowerCase() as "up" | "down" };
  }

  // Style, on the selection, one property at a time.
  const colour = re(`^${POLITE}(?:make|set|change|turn|paint)\\s+(?:the\\s+)?(background|bg|text|font|text\\s+colou?r|font\\s+colou?r|colou?r|background\\s+colou?r)\\s+(?:colou?r\\s+)?(?:to\\s+|into\\s+)?${COLOUR}${END}`).exec(raw);
  if (colour && isColour(colour[2]!)) {
    return { kind: "style", property: /^(?:background|bg)/i.test(colour[1]!) ? "background-color" : "color", value: colour[2]! };
  }
  const size = re(`^${POLITE}(?:set|change|make)\\s+(?:the\\s+)?(?:font|text)[\\s-]*size\\s+(?:to\\s+)?(\\d+(?:\\.\\d+)?(?:px|rem|em|%))${END}`).exec(raw);
  if (size) return { kind: "style", property: "font-size", value: size[1]!.toLowerCase() };
  const align = re(`^${POLITE}(?:(?:align|justify)\\s+(?:(?:it|this|the\\s+(?:text|heading|title|words))\\s+)?(?:to\\s+(?:the\\s+)?)?(left|center|centre|right)|(cent(?:er|re))\\s+(?:it|this|the\\s+(?:text|heading|title|words)))${END}`).exec(raw);
  if (align) return { kind: "style", property: "text-align", value: (align[1] ?? "center").toLowerCase().replace("centre", "center") };
  const radius = re(`^${POLITE}(?:set|change|make)\\s+(?:the\\s+)?(?:border[\\s-]*|corner[\\s-]*)?radius\\s+(?:to\\s+)?(\\d+(?:px|rem|%))${END}`).exec(raw);
  if (radius) return { kind: "style", property: "border-radius", value: radius[1]!.toLowerCase() };
  const padding = re(`^${POLITE}(?:set|change|make)\\s+(?:the\\s+)?padding\\s+(?:to\\s+)?(\\d+(?:px|rem))${END}`).exec(raw);
  if (padding) return { kind: "style", property: "padding", value: padding[1]!.toLowerCase() };

  // A font, for the selection or for the whole site.
  const font = re(`^${POLITE}(?:change|set|make|switch|use)\\s+((?:every\\s+|all\\s+|the\\s+)?)(?:fonts?|typeface)(?:\\s+family)?\\s+(?:from\\s+(.+?)\\s+)?(?:to|into)\\s+([a-z0-9 ,'"-]{2,60}?)(\\s+(?:everywhere|across\\s+(?:the\\s+)?(?:whole\\s+)?(?:site|website)|on\\s+(?:every|all)\\s+pages?|site[-\\s]?wide))?${END}`).exec(raw);
  if (font) return { kind: "font", from: font[2]?.trim() ?? "", to: font[3]!.trim(), siteWide: Boolean(font[4]) || /every|all/i.test(font[1] ?? "") };

  // New words for the selected element: quoted, so what goes in is unmistakable.
  // "Change the heading to sound friendlier" and "change the heading to red"
  // are not words to write, and only the quotes tell them apart.
  const words = re(`^${POLITE}(?:change|set|update|replace|rename)\\s+(.+?)\\s+(?:text\\s+)?(?:to|with|into)\\s+["“'‘](.+)["”'’]${END}`).exec(raw);
  if (words) {
    const target = targetWords(words[1]!.replace(/\s+(?:text|words|label|copy)$/i, ""));
    if (target && words[2]!.trim()) return { kind: "text", target, value: words[2]!.trim() };
  }

  const replace = re(`^${POLITE}(?:replace|change|swap)\\s+["“'‘](.+?)["”'’]\\s+(?:with|to|for|by)\\s+["“'‘](.*?)["”'’](?:\\s+(?:everywhere|on\\s+every\\s+page|across\\s+the\\s+site|on\\s+all\\s+pages))?${END}`).exec(raw);
  if (replace && replace[1]) return { kind: "replace", find: replace[1], replace: replace[2] ?? "" };

  const hex = String.raw`(#[0-9a-f]{3,8})`;
  const swap = re(`^${POLITE}(?:change|replace|swap)\\s+(?:every\\s+|all\\s+)?(?:the\\s+)?(?:colou?r\\s+)?(?:of\\s+)?${hex}\\s+(?:to|with|for|into)\\s+${hex}(?:\\s+(?:everywhere|across\\s+the\\s+site|on\\s+every\\s+page))?${END}`).exec(raw);
  if (swap) return { kind: "color", from: swap[1]!, to: swap[2]! };

  const phone = re(`^${POLITE}(?:change|update|replace)\\s+(?:the\\s+|our\\s+|my\\s+)?(?:phone|telephone|contact)\\s*(?:number)?\\s+(?:from\\s+([+\\d][\\d\\s().-]{6,22}?)\\s+)?(?:to|with)\\s+([+\\d][\\d\\s().-]{6,22})(?:\\s+(?:everywhere|on\\s+every\\s+page|across\\s+the\\s+site))?${END}`).exec(raw);
  if (phone) return { kind: "phone", from: phone[1]?.trim() ?? null, to: phone[2]!.trim() };

  const mail = String.raw`([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})`;
  const email = re(`^${POLITE}(?:change|update|replace)\\s+(?:the\\s+|our\\s+|my\\s+)?(?:email|e-mail)(?:\\s+address)?\\s+(?:from\\s+${mail}\\s+)?(?:to|with)\\s+${mail}(?:\\s+(?:everywhere|on\\s+every\\s+page|across\\s+the\\s+site))?${END}`).exec(raw);
  if (email) return { kind: "email", from: email[1] ?? null, to: email[2]! };

  return null;
}

const HEADING_NOUNS = new Set(["heading", "headline", "title", "subtitle", "subheading"]);
const TEXT_NOUNS = new Set(["text", "paragraph", "line", "sentence"]);
const PICTURE_NOUNS = new Set(["image", "picture", "photo", "logo"]);
const CONTAINER_NOUNS = new Set(["section", "block", "card", "row", "column", "container", "box", "banner", "hero", "area", "panel", "list", "div"]);
const ANY_NOUNS = new Set(["element", "item", "part", "bit", "thing", "one"]);

/** Does this kind of thing describe that element? */
function fits(field: SiteField, noun: string): boolean {
  if (ANY_NOUNS.has(noun)) return true;
  if (HEADING_NOUNS.has(noun)) return /^h[1-6]$/.test(field.tag) || /heading/i.test(field.label);
  if (TEXT_NOUNS.has(noun)) return field.kind === "text" || field.kind === "richtext";
  if (PICTURE_NOUNS.has(noun)) return field.kind === "image" || field.kind === "background" || (noun === "logo" && (field.kind === "icon" || /logo|brand/i.test(field.label)));
  if (noun === "button") return field.kind === "button";
  if (noun === "link") return field.kind === "link" || field.kind === "button";
  if (noun === "icon") return field.kind === "icon";
  if (CONTAINER_NOUNS.has(noun)) return field.kind === "container";
  return false;
}

/** The words that describe an element: its id, name, words, picture, classes and the section it is in. */
function identity(field: SiteField, sectionLabel: string | undefined): Set<string> {
  const text = [field.id, field.label, field.tag, (field.preview || field.value).slice(0, 240), field.alt ?? "", field.classes ?? "", sectionLabel ?? ""].join(" ").toLowerCase();
  const tokens = new Set<string>();
  for (const token of text.split(/[^a-z0-9&]+/)) {
    if (!token) continue;
    tokens.add(token);
    tokens.add(token.replace(/s$/, ""));
  }
  return tokens;
}

/**
 * The element a command's words point at, from the selection — or null, when
 * nothing is selected or the words name something else. "This section" with a
 * heading selected is the section around the heading; "the pricing section"
 * with the hero selected is not the hero, and goes to the model.
 */
export function commandTarget(words: TargetWords, input: { selected: SiteField | null; fields: SiteField[]; sections?: SiteSection[] }): SiteField | null {
  const { selected } = input;
  if (!selected) return null;
  const byId = new Map(input.fields.map((field) => [field.id, field]));
  let target: SiteField = selected;
  if (words.noun && CONTAINER_NOUNS.has(words.noun) && selected.kind !== "container") {
    // The block around the selection: the nearest section-like container for
    // "section", the nearest container for a card, a row or a box.
    const sectionish = words.noun === "section" || words.noun === "hero" || words.noun === "banner";
    let walker = selected.parentId ? byId.get(selected.parentId) : undefined;
    let found: SiteField | undefined;
    let outermost: SiteField | undefined;
    while (walker) {
      if (walker.kind === "container") {
        if (!sectionish) { found = walker; break; }
        if (["section", "article", "header", "footer"].includes(walker.tag)) { found = walker; break; }
        if (!["main", "body"].includes(walker.tag)) outermost = walker;
      }
      walker = walker.parentId ? byId.get(walker.parentId) : undefined;
    }
    const chosen = found ?? outermost;
    if (!chosen) return null;
    target = chosen;
  } else if (words.noun && !fits(selected, words.noun)) {
    return null;
  }
  if (words.qualifiers.length) {
    const section = /^(s\d+)\./.exec(selected.id)?.[1];
    const label = input.sections?.find((entry) => entry.id === section)?.label;
    const known = new Set([...identity(target, label), ...identity(selected, label)]);
    if (!words.qualifiers.every((word) => known.has(word) || known.has(word.replace(/s$/, "")))) return null;
  }
  return target;
}

/** Whether a font command is for the whole site: said so, or nothing is selected to give it to. */
export function fontIsSiteWide(command: Extract<ExactCommand, { kind: "font" }>, selected: SiteField | null): boolean {
  return command.siteWide || !selected || selected.id.startsWith("meta.");
}

export { isColour };
