import { decodeEntities, parseHtml, type ElementNode } from "./parse.js";

/**
 * Has a whole-page rewrite added anything that runs?
 *
 * The assistant can hand back a page's entire HTML — inserting a section is a
 * new document, not a field value — and nothing in `sanitize.ts` sees a
 * document. The plan it travels in is signed, which proves the server made it;
 * it does not prove the HTML is harmless, because what a model writes can be
 * steered by the words already on the page. So the question is asked of the
 * HTML itself, against the page as it stands: whatever could run code, or pull
 * another document in, must already be there. A site's own analytics script or
 * a button's `onclick` is the site's business and passes untouched; a new one
 * is refused, never cleaned, because a page with half of a change in it is not
 * what anybody approved.
 *
 * It compares rather than forbids, so a page that already carries scripts keeps
 * working, and it counts: a second copy of an existing script is a script that
 * runs twice. A script whose text changed is a different script.
 */

/** Elements that load another document, or move where every relative address points. */
const EMBEDDING = new Set(["iframe", "frame", "object", "embed", "base"]);

/**
 * Attributes a browser follows or loads as an address. `to`, `from` and
 * `values` belong to SVG animation, which can write an address into a link
 * after the page has loaded.
 */
const ADDRESS_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "poster", "background", "to", "from", "values"]);

/**
 * The elements `parse.ts` does not read into, by its own rule for a tag name.
 *
 * The parser was built to find editable words, so it skips the inside of a
 * `<style>`, a `<textarea>`, a `<title>` and an `<svg>`. A browser does not
 * always agree: inside an `<svg>` or a `<math>`, a `<style>` is an ordinary
 * element and an `<img onerror>` within it runs, and a `<textarea>` the browser
 * never opened (one inside an `<xmp>`) hides nothing from it. Comments differ
 * too — a browser ends `<!-->` at once and also stops at `--!>`, so text this
 * parser reads as a comment can be live markup. Every one of those would be a
 * place to put a handler this check cannot see.
 *
 * So the check reads a transparent copy: those tag names are renamed, closing
 * tags included so the tree still nests, and their contents are walked; `<!`
 * and `<?` are broken so no comment or declaration hides anything. That reads
 * more as markup than any browser would, which can only make the check
 * stricter — and the same copy is made of both pages, so the site's own content
 * compares equal to itself. `<script>` keeps its meaning, because its full text
 * is what is compared.
 */
const OPAQUE_TO_PARSER = /<(\/?)(style|textarea|title|svg)(?![a-zA-Z0-9:-])/gi;

function transparent(html: string): string {
  return html.replace(/<([!?])/g, "< $1").replace(OPAQUE_TO_PARSER, "<$1dw-transparent-$2");
}

function character(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/**
 * An attribute value as a browser would act on it. Numeric references are
 * decoded with or without their semicolon, as browsers do inside attributes,
 * and the named ones that can spell a scheme (`&colon;`, `&Tab;`,
 * `&NewLine;`) are handled here because `decodeEntities` was written for words
 * on a page and does not know them. Whitespace and control characters go
 * everywhere, not only at the ends: a browser ignores a tab or a newline
 * inside an address, and `java script:` running nowhere is a smaller loss than
 * `java&#9;script:` running everywhere.
 */
function browserValue(raw: string): string {
  return decodeEntities(
    raw
      .replace(/&#x([0-9a-f]+);?/gi, (_whole, hex: string) => character(parseInt(hex, 16)))
      .replace(/&#(\d+);?/g, (_whole, decimal: string) => character(parseInt(decimal, 10))),
  )
    .replace(/&colon;?/gi, ":")
    .replace(/&(?:tab|newline);?/gi, "")
    .replace(/[\u0000-\u0020\u007f-\u009f]+/g, "")
    .toLowerCase();
}

/** The scheme that makes this address run code, or null. A picture as `data:image/…` is only a picture. */
function runnableScheme(name: string, raw: string): string | null {
  // An animation's `values` is a `;` list, split after decoding — `&#59` is a
  // separator too.
  const decoded = browserValue(raw);
  const candidates = name === "values" ? decoded.split(";") : [decoded];
  for (const value of candidates) {
    const scheme = /^(javascript|vbscript|data):/.exec(value)?.[1];
    if (!scheme) continue;
    if (scheme === "data" && value.startsWith("data:image/")) continue;
    return `${scheme}:`;
  }
  return null;
}

type ActiveItem = {
  /** What makes two items the same item: compared as a multiset across the two pages. */
  key: string;
  /** How it is named to the person whose change was refused. */
  what: string;
};

/**
 * Every element, in document order, without recursion: an unclosed tag nests
 * everything after it, so a malformed page can be thousands of levels deep,
 * and a check that overflowed the stack on one would fail the apply for a
 * reason nobody could act on.
 */
function everyElement(root: ElementNode): ElementNode[] {
  const out: ElementNode[] = [];
  const pending = [root];
  while (pending.length) {
    const element = pending.pop()!;
    out.push(element);
    for (let index = element.children.length - 1; index >= 0; index -= 1) pending.push(element.children[index]!);
  }
  return out;
}

function activeItems(html: string): ActiveItem[] {
  const source = transparent(html);
  const items: ActiveItem[] = [];
  for (const element of everyElement(parseHtml(source))) {
    if (element.tag === "#root") continue;
    const tag = element.tag;
    const openingTag = source.slice(element.start, element.innerStart);
    if (tag === "script") {
      items.push({ key: `script\u0000${source.slice(element.start, element.end)}`, what: "a script" });
    }
    if (EMBEDDING.has(tag)) {
      items.push({ key: `element\u0000${openingTag}`, what: `${/^[aeiou]/.test(tag) ? "an" : "a"} <${tag}> element` });
    }
    if (tag === "meta") {
      const equiv = element.attrs.find((attribute) => attribute.name === "http-equiv");
      if (equiv && browserValue(equiv.value) === "refresh") {
        items.push({ key: `refresh\u0000${openingTag}`, what: "an automatic redirect (meta refresh)" });
      }
    }
    for (const attribute of element.attrs) {
      const id = `${tag}\u0000${attribute.name}\u0000${attribute.value}`;
      if (attribute.name.startsWith("on")) {
        items.push({ key: `handler\u0000${id}`, what: `an ${attribute.name} handler` });
      } else if (attribute.name === "srcdoc") {
        items.push({ key: `srcdoc\u0000${id}`, what: "a frame's inline document (srcdoc)" });
      } else if (ADDRESS_ATTRIBUTES.has(attribute.name)) {
        const scheme = runnableScheme(attribute.name, attribute.value);
        if (scheme) items.push({ key: `address\u0000${id}`, what: `a ${scheme} address` });
      }
    }
  }
  return items;
}

/**
 * What `after` has that runs or embeds and `before` does not, each named once
 * in words a person can read ("a script", "an onclick handler", "a
 * javascript: address"). Empty when the rewrite adds nothing of the kind.
 */
export function introducedActiveContent(before: string, after: string): string[] {
  const remaining = new Map<string, number>();
  for (const item of activeItems(before)) remaining.set(item.key, (remaining.get(item.key) ?? 0) + 1);
  const added: string[] = [];
  for (const item of activeItems(after)) {
    const left = remaining.get(item.key) ?? 0;
    if (left > 0) {
      remaining.set(item.key, left - 1);
      continue;
    }
    if (!added.includes(item.what)) added.push(item.what);
  }
  return added;
}
