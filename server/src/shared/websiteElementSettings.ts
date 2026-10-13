/**
 * What the inspector's General tab may write onto an element as markup rather
 * than as style: which tag it renders as, its HTML id, a short allowlist of
 * other attributes, and the playback attributes of a video or an audio player.
 *
 * Shared by the editor, which uses it to offer only what will be accepted and to
 * say why anything else is refused, and by the server, which applies exactly the
 * same rules again before it splices anything into a page. A draft is stored
 * JSON that is published weeks later, so the server never trusts that the panel
 * asked first.
 *
 * The allowlist is the security story, and it is deliberately narrower than a
 * page builder that owns its own runtime would need. Three things are never
 * reachable from here:
 *
 * - **Script.** No `on*` handler, and no `data-*` name that a common library
 *   (htmx, Alpine-style binders) treats as code. A customer may invite somebody
 *   to edit their words; that must not let them run script on the visitors.
 * - **Addresses.** `href`, `src`, `action` and friends are set by the link,
 *   image and video controls, which validate what they write. A video's `src`
 *   and `poster` are allowed here only through the typed video settings, and
 *   only as https or site paths.
 * - **The design system.** `class` stays the developer's — see the button style
 *   rule in `regions.ts` for why free-text class editing is the wrong control —
 *   and `style` has its own tab.
 */

export const CONTAINER_TAGS = ["div", "section", "header", "footer", "article", "aside", "nav", "main"] as const;
export const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
export const TEXT_TAGS = ["p", "span", "div"] as const;

export const TAG_LABEL: Record<string, string> = {
  div: "Div",
  section: "Section",
  header: "Header",
  footer: "Footer",
  article: "Article",
  aside: "Aside",
  nav: "Nav",
  main: "Main",
  h1: "H1",
  h2: "H2",
  h3: "H3",
  h4: "H4",
  h5: "H5",
  h6: "H6",
  p: "Paragraph (p)",
  span: "Inline text (span)",
};

/**
 * The tags an element may be switched to, current tag included, or nothing when
 * its tag is fixed.
 *
 * Families, never a free choice, because a tag carries meaning the page relies
 * on: a list item outside a list, a table cell outside a row and a `<p>` wrapped
 * around a block are all broken HTML that a browser silently repairs into a
 * different page. Within a family the swap is safe by construction — a text
 * field holds only inline content (a block child would have made it a
 * container), and every container tag here holds flow content. `main` is never
 * offered as a target, since a page has one main region; an element that
 * already is one keeps it in its list.
 */
export function tagOptions(kind: string, tag: string): string[] {
  const current = tag.toLowerCase();
  if ((kind === "container" || kind === "background") && (CONTAINER_TAGS as readonly string[]).includes(current)) {
    return CONTAINER_TAGS.filter((option) => option !== "main" || current === "main");
  }
  if (kind === "text" || kind === "richtext") {
    if ((HEADING_TAGS as readonly string[]).includes(current)) return [...HEADING_TAGS];
    if ((TEXT_TAGS as readonly string[]).includes(current)) return [...TEXT_TAGS];
  }
  return [];
}

export type MediaKind = "video" | "audio";

export function mediaKind(tag: string): MediaKind | null {
  const lower = tag.toLowerCase();
  return lower === "video" || lower === "audio" ? lower : null;
}

/** Attributes a player understands, in the order the panel shows them. */
export const MEDIA_ATTRIBUTES: Record<MediaKind, string[]> = {
  video: ["src", "poster", "autoplay", "muted", "loop", "controls", "playsinline", "preload", "controlslist"],
  audio: ["src", "autoplay", "muted", "loop", "controls", "preload", "controlslist"],
};

/** Written bare (`<video muted>`), present or absent, never with a value. */
export const BOOLEAN_ATTRIBUTES = new Set(["autoplay", "muted", "loop", "controls", "playsinline", "hidden", "itemscope"]);

const PLAIN_ATTRIBUTES = new Set(["id", "title", "lang", "dir", "role", "tabindex", "hidden", "translate", "itemprop", "itemscope", "itemtype", "itemid"]);

const ADDRESS_ATTRIBUTES = new Set([
  "src", "srcset", "sizes", "poster", "action", "formaction", "srcdoc", "data", "codebase", "background", "manifest", "ping",
  "cite", "longdesc", "usemap", "xlink:href", "xmlns", "archive", "classid", "lowsrc", "dynsrc", "profile", "icon",
]);

/**
 * `data-` names that some libraries read as code. Not a complete list of every
 * framework there is — it does not need to be, because values are restricted as
 * well (no brackets, no semicolons, no script addresses) — but the names that
 * are code by design are refused by name, so the refusal says why.
 *
 * Two alternations, because the shapes differ. The first is prefixes that are
 * always a dash away from an expression (`data-hx-*` htmx, `data-on*` inline
 * and Datastar's `data-on-*`, `data-x-*`/`data-v-*`/`data-ng-*`/`data-wire:*`
 * Alpine/Vue/Angular/Livewire): matched loosely because what follows is open.
 * The second is whole names a library runs as code — `data-bind` (Knockout),
 * `data-script` (_hyperscript's alias of `_`) and Datastar's reactive set
 * (`data-text`, `data-show`, `data-effect`, `data-computed`, `data-attr[-*]`,
 * `data-signals[-*]`, `data-class[-*]`, `data-indicator`, `data-init`) — held
 * to the name itself or a dashed suffix, so an ordinary `data-attribution` or
 * `data-classname` is not swept up and `data-target` (the count-up figures)
 * still passes.
 */
const SCRIPT_DATA =
  /^data-(?:(?:hx-|on|x-|v-|ng-|wire:|alpine)|(?:bind|script|text|show|effect|computed|attr|signals|class|indicator|init)(?:$|[^a-z0-9]))/;

/**
 * Whether a library would run this `data-` attribute as code. The one rule for
 * it: the Settings panel refuses these names, and `sanitize.ts` drops them from
 * rich text, because a `data-bind` typed into a paragraph runs on a Knockout
 * site exactly as one set from this panel would.
 */
export function isScriptDataAttribute(rawName: string): boolean {
  return SCRIPT_DATA.test(rawName.trim().toLowerCase());
}

export const ATTRIBUTE_NAME = /^[a-z][a-z0-9_.-]{0,59}$/;

/** At most this many attributes may be changed in one go, and an element may carry this many of ours. */
export const MAX_ATTRIBUTE_CHANGES = 30;

/**
 * Why an attribute of this name may not be edited here, or `null` when it may.
 *
 * Every refusal is a sentence the person can act on, because "invalid
 * attribute" says nothing about where the thing they wanted actually lives.
 */
export function attributeNameProblem(rawName: string, tag: string): string | null {
  const name = rawName.trim().toLowerCase();
  const media = mediaKind(tag);
  if (!name) return "Give the attribute a name.";
  if (/^on/.test(name)) return "Event handlers run script, and this editor never writes script into a page.";
  if (name === "style") return "Styling is set in the Style tab.";
  if (name === "class") return "Classes belong to the site's design system. Style this element in the Style tab instead.";
  if (name === "href" || name === "target" || name === "rel") return "Where it goes is set under Link.";
  if (media && MEDIA_ATTRIBUTES[media].includes(name)) return null;
  if (ADDRESS_ATTRIBUTES.has(name)) return "Addresses are set by the image, video and link controls, never typed in as an attribute.";
  if (name.startsWith("data-dw-")) return "Attributes starting data-dw- belong to the editor.";
  if (isScriptDataAttribute(name)) return "Some libraries run that attribute as code, so it can't be set here.";
  if (!ATTRIBUTE_NAME.test(name)) return "An attribute name uses lowercase letters, digits and dashes, and starts with a letter.";
  if (PLAIN_ATTRIBUTES.has(name)) return null;
  if (/^aria-[a-z]{2,40}$/.test(name)) return null;
  if (/^data-[a-z0-9][a-z0-9_.-]{0,50}$/.test(name)) return null;
  return "Only id, title, lang, dir, role, tabindex, hidden, translate, aria-*, data-* and microdata (itemprop…) can be set here.";
}

const ADDRESS = /^(?:https:\/\/[^\s"'<>`]+|\/(?!\/)[^\s"'<>`]*|\.{1,2}\/[^\s"'<>`]*|[a-z0-9_][a-z0-9_./%-]*(?:[?#][^\s"'<>`]*)?)$/i;

/**
 * Why this value may not be written to that attribute, or `null` when it may.
 * `null` as the value means "take the attribute away", which any editable name
 * allows.
 */
export function attributeProblem(rawName: string, value: string | null, tag: string): string | null {
  const name = rawName.trim().toLowerCase();
  const nameProblem = attributeNameProblem(name, tag);
  if (nameProblem) return nameProblem;
  if (value === null) return null;
  if (value.length > 400) return "Keep an attribute's value under 400 characters.";
  if (/[\u0000-\u001f\u007f<>`]/.test(value)) return "That value contains a character an attribute can't hold safely (< > ` or a control character).";
  if (/(?:java|vb)script\s*:|data\s*:/i.test(value.replace(/\s+/g, ""))) return "Script and data: addresses can't be written into a page.";
  if (BOOLEAN_ATTRIBUTES.has(name)) return value === "" ? null : `${name} is either on or off, so it takes no value.`;
  switch (name) {
    case "id":
      return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? null : "An ID starts with a letter and uses only letters, digits, - and _ (no spaces).";
    case "tabindex":
      return /^-?\d{1,4}$/.test(value) ? null : "tabindex is a whole number, usually 0 or -1.";
    case "dir":
      return ["ltr", "rtl", "auto"].includes(value) ? null : "dir is ltr, rtl or auto.";
    case "lang":
      return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(value) ? null : "lang is a language code such as en, fr or en-GB.";
    case "role":
      return /^[a-z]+(?: [a-z]+)*$/.test(value) ? null : "role is one or more lowercase words, such as button or navigation.";
    case "translate":
      return value === "yes" || value === "no" ? null : "translate is yes or no.";
    case "itemtype":
    case "itemid":
      return /^https:\/\/[^\s"'<>`]+$/.test(value) ? null : `${name} is an https address.`;
    case "preload":
      return ["auto", "metadata", "none"].includes(value) ? null : "preload is auto, metadata or none.";
    case "controlslist":
      return value.split(/\s+/).filter(Boolean).every((token) => ["nodownload", "nofullscreen", "noremoteplayback"].includes(token))
        ? null
        : "controlslist takes nodownload, nofullscreen or noremoteplayback.";
    case "src":
    case "poster":
      return ADDRESS.test(value.trim()) ? null : "Use an https address or a path on this website.";
  }
  if (name.startsWith("data-") && /[(){};]/.test(value)) return "A data- value can't contain brackets or semicolons.";
  return null;
}

export type ElementAttribute = { name: string; value: string };

/** The attributes on an element the panel may show and change: id, the allowlist and a player's own. */
export function editableAttributes(attrs: ElementAttribute[], tag: string): ElementAttribute[] {
  return attrs.filter((attr) => attributeNameProblem(attr.name, tag) === null);
}

export type ElementSettingsChange = {
  /** A tag from `tagOptions` for this element. */
  tag?: string;
  /** Attribute writes by name: a string sets it (`""` writes it bare), `null` removes it. */
  attributes?: Record<string, string | null>;
};

/** A video or audio address's start and end, written as a media fragment (`#t=5,20`). */
export function readMediaTime(src: string): { base: string; start: number | null; end: number | null } {
  const match = /#t=(\d+(?:\.\d+)?)?(?:,(\d+(?:\.\d+)?))?$/.exec(src);
  if (!match) return { base: src, start: null, end: null };
  return {
    base: src.slice(0, match.index),
    start: match[1] !== undefined ? Number(match[1]) : null,
    end: match[2] !== undefined ? Number(match[2]) : null,
  };
}

export function writeMediaTime(base: string, start: number | null, end: number | null): string {
  const clean = base.replace(/#t=[^#]*$/, "");
  if (start === null && end === null) return clean;
  return `${clean}#t=${start ?? 0}${end !== null ? `,${end}` : ""}`;
}
