import { parseHtml, type ElementNode } from "./parse.js";

/**
 * What a client is allowed to put into their own website.
 *
 * The editor's text fields are rich: somebody typing into a heading keeps the
 * bold word and the line break that were already there, because the control is
 * a real editing surface rather than a box of tags. That convenience is also the
 * hole — whatever the browser hands back is a string from a client, and it ends
 * up inside a file served to the public from the company's own domain.
 *
 * So nothing reaches a page that is not on these lists. Not "scripts are
 * stripped": *only these tags, only these attributes, only these link schemes*,
 * and everything else becomes the text it was pretending to be. The system plan
 * puts it plainly — never render unsanitised HTML from a client field.
 */

/** Inline formatting that can survive a round trip through a text field. */
const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "s", "small", "sup", "sub", "code", "span", "br", "a"]);

/**
 * Attributes kept on an allowed tag.
 *
 * `class` and `data-*` are here because the design already uses them inside
 * copy — the count-up figures on the homepage are a `<strong class="count-up"
 * data-target="70">`, and dropping the attributes would leave the number frozen
 * at zero. They cannot execute anything; they select styling the developer wrote.
 */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  "*": new Set(["class", "style", "title", "lang", "dir"]),
  a: new Set(["href", "target", "rel", "aria-label"]),
};

/**
 * Elements whose content is code, not words — dropped whole, contents included.
 *
 * The distinction matters and getting it wrong is easy. Every *other* unknown
 * element is unwrapped rather than deleted, because a `<div>` pasted around a
 * sentence should not take the sentence with it. Applied to `<script>` that same
 * rule is nonsense: the parser never reads into one, so "its children" is the
 * raw source, and the result was a heading that safely, uselessly, displayed the
 * words `alert(1)` to every visitor. Stripping the tag made it harmless; this is
 * what makes it absent.
 */
const CODE_ELEMENTS = new Set(["script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "textarea", "title", "canvas"]);

/** Schemes a link may use. Everything else is a way to run code. */
const LINK_SCHEME = /^(https?:|mailto:|tel:)/i;

const DOUBLE_QUOTE = String.fromCharCode(34);

/** Text to HTML, leaving existing entities alone so `&mdash;` does not become `&amp;mdash;`. */
export function escapeText(text: string): string {
  return text
    .replace(/&(?!(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(new RegExp(DOUBLE_QUOTE, "g"), "&quot;").replace(/</g, "&lt;");
}

/**
 * A style attribute with anything that can fetch or execute removed.
 *
 * CSS cannot run scripts in any browser this site supports, but `url()` can
 * reach a third-party server from a page on the company's domain, and that is a
 * request nobody asked for. Declarations are otherwise left as written: the
 * pages already carry `style="color:var(--blue)"` inside headings, and stripping
 * the attribute would silently un-colour half a dozen of them.
 */
function safeStyle(value: string): string {
  const cleaned = value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration && !/url\s*\(|expression\s*\(|javascript:|@import/i.test(declaration))
    .join("; ");
  return cleaned;
}

export type LinkCheck = { ok: true; href: string } | { ok: false; reason: string };

/**
 * Is this somewhere a link may point?
 *
 * Internal paths, anchors, and the three schemes a website legitimately uses.
 * A protocol-relative `//host` is rejected with the rest: it is an external link
 * wearing an internal link's clothes, and it is not a form anybody types on
 * purpose.
 */
export function checkLink(raw: string): LinkCheck {
  const href = raw.trim();
  if (!href) return { ok: false, reason: "Add a destination, or remove the link." };
  if (href.startsWith("//")) return { ok: false, reason: "Write the full address, starting https://" };
  if (href.startsWith("/") || href.startsWith("#") || href.startsWith("?")) return { ok: true, href };
  if (LINK_SCHEME.test(href)) return { ok: true, href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return { ok: false, reason: `Links can point to a page, an email address or a phone number. "${href.split(":")[0]}:" is not one of those.` };
  }
  // No scheme and no leading slash: a relative path like `about.html`, which is
  // how the pages already link to each other in a few places.
  return { ok: true, href };
}

function renderChildren(source: string, element: ElementNode, depth: number): string {
  let out = "";
  let cursor = element.innerStart;
  for (const child of element.children) {
    if (child.start > cursor) out += escapeText(source.slice(cursor, child.start));
    out += render(source, child, depth + 1);
    cursor = child.end;
  }
  if (element.innerEnd > cursor) out += escapeText(source.slice(cursor, element.innerEnd));
  return out;
}

function render(source: string, element: ElementNode, depth: number): string {
  if (CODE_ELEMENTS.has(element.tag)) return "";

  // Deeply nested markup out of a contenteditable is almost always the browser
  // having wrapped a paste. Past a sane depth the words are kept and the
  // scaffolding is not.
  if (depth > 8 || !ALLOWED_TAGS.has(element.tag)) {
    return element.selfClosing ? "" : renderChildren(source, element, depth);
  }

  const attrs: string[] = [];
  for (const attribute of element.attrs) {
    const permitted = ALLOWED_ATTRS["*"]!.has(attribute.name) || ALLOWED_ATTRS[element.tag]?.has(attribute.name) || attribute.name.startsWith("data-");
    if (!permitted) continue;
    if (attribute.name === "href") {
      const checked = checkLink(attribute.value);
      if (!checked.ok) continue;
      attrs.push(`href="${escapeAttr(checked.href)}"`);
      continue;
    }
    if (attribute.name === "style") {
      const style = safeStyle(attribute.value);
      if (style) attrs.push(`style="${escapeAttr(style)}"`);
      continue;
    }
    attrs.push(`${attribute.name}="${escapeAttr(attribute.value)}"`);
  }

  // A link that lost its href is no longer a link. Its words stay.
  if (element.tag === "a" && !attrs.some((entry) => entry.startsWith("href="))) {
    return renderChildren(source, element, depth);
  }

  const open = `<${element.tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`;
  if (element.tag === "br") return open;
  return `${open}${renderChildren(source, element, depth)}</${element.tag}>`;
}

/**
 * Cleans one rich field's HTML down to the allowlist.
 *
 * Unknown elements are unwrapped rather than deleted — a pasted `<div>` around a
 * sentence should not take the sentence with it — and `<script>`, `<style>` and
 * every other element whose content is not words are dropped whole by the
 * parser, which never reads into them.
 */
export function sanitizeRich(html: string): string {
  const root = parseHtml(html);
  return renderChildren(html, root, 0).replace(/\s+/g, " ").trim();
}

/** A plain-text field: no markup at all, and line breaks are not an escape hatch. */
export function sanitizePlain(text: string): string {
  return escapeText(text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ")).trim();
}
