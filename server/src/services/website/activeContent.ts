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
 * A copy of the page the parser can walk without a browser and it disagreeing
 * about where things end.
 *
 * The parser in `parse.ts` was built to find editable words, so it treats
 * `<style>`, `<textarea>`, `<title>` and `<svg>` as opaque and reads nothing
 * else specially. A browser's rules for where an element ends are different in
 * two ways that let a hostile rewrite hide a handler past the end of an element
 * this check would otherwise read:
 *
 * - **Raw-text and RCDATA elements end at their literal closing tag, not at a
 *   quote.** A browser ends `<style>`, `<title>`, `<textarea>`, `<xmp>`,
 *   `<noscript>`, `<noembed>`, `<noframes>` and `<iframe>` at the first
 *   `</name>` regardless of any `"` opened inside, then parses what follows as
 *   markup. An earlier version renamed the opaque ones so the parser would
 *   *read* their contents as markup, on the theory that reading more can only
 *   be stricter. It is not: a `<p title="</style><img onerror=…>">` then has
 *   its quoted value swallow the real `</style>` and the live `<img>` after it,
 *   and the check sees nothing. So each of these elements is ended here by the
 *   browser's rule — its body dropped (inert, and never where a handler runs),
 *   a clean closer put in its place — and scanning continues after it, where
 *   the `<img onerror>` actually is. The opening tag is kept, because a handler
 *   or an address *on it* (`<iframe src>`) still counts.
 * - **Comments and CDATA end where the browser ends them.** `<!-->` and
 *   `<!--->` are empty comments, `--!>` also closes one, and inside foreign
 *   content `<![CDATA[ … ]]>` is text to `]]>`. The parser's own comment rule
 *   (`indexOf('-->')`) misses the first two, so comments are resolved here and
 *   collapsed to a space, and declarations and processing instructions end at
 *   their `>`.
 *
 * Inside an `<svg>` or `<math>`, `<style>`, `<title>` and `<textarea>` are
 * *not* raw-text — an `<img onerror>` within an SVG `<style>` runs — so there
 * they are renamed to a plain tag the parser walks into, which matches the
 * browser (a quoted value in that context really does span, as it would in the
 * DOM). `<script>` is copied through its real `</script>` either way, so its
 * full text is what gets compared and a `</style>` sitting inside a script
 * string is not mistaken for structure.
 *
 * The same copy is made of both pages, so a site's own content always compares
 * equal to itself.
 */

/** Raw-text and RCDATA elements: a browser ends them at `</name>`, not at a quote. */
const TEXT_ELEMENTS = new Set(["style", "textarea", "title", "xmp", "noscript", "noembed", "noframes", "iframe", "plaintext"]);
/** Those an `<svg>`/`<math>` subtree turns back into ordinary, walked markup. */
const FOREIGN_WALKABLE = new Set(["style", "title", "textarea"]);
const TAG_AT = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/;

/** Index just past the real `</tag>` from `from`, or the string's length when it never closes. */
function closingTagEnd(html: string, tag: string, from: number): number {
  const closer = new RegExp(`</${tag}(?=[\\s/>])`, "i").exec(html.slice(from));
  if (!closer) return html.length;
  const gt = html.indexOf(">", from + closer.index);
  return gt < 0 ? html.length : gt + 1;
}

/** Index just past an opening or closing tag that starts at `lt`, skipping quoted attribute values. */
function tagEndFrom(html: string, lt: number): number {
  let i = TAG_AT.exec(html.slice(lt, lt + 64))![0].length + lt;
  while (i < html.length && html[i] !== ">") {
    const char = html[i]!;
    if (char === '"' || char === "'") {
      const close = html.indexOf(char, i + 1);
      if (close < 0) return html.length;
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return i < html.length ? i + 1 : html.length;
}

function transparent(html: string): string {
  const out: string[] = [];
  let i = 0;
  let foreign = 0; // depth of open <svg>/<math>, where the text elements are walked instead
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      let resume: number;
      const body = lt + 4;
      if (html[body] === ">") resume = body + 1;
      else if (html.startsWith("->", body)) resume = body + 2;
      else {
        const dashGt = html.indexOf("-->", body);
        const dashBangGt = html.indexOf("--!>", body);
        if (dashGt >= 0 && (dashBangGt < 0 || dashGt < dashBangGt)) resume = dashGt + 3;
        else if (dashBangGt >= 0) resume = dashBangGt + 4;
        else resume = html.length;
      }
      out.push(" ");
      i = resume;
      continue;
    }
    if (foreign > 0 && html.startsWith("<![CDATA[", lt)) {
      const close = html.indexOf("]]>", lt + 9);
      out.push(" ");
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const close = html.indexOf(">", lt);
      out.push(" ");
      i = close < 0 ? html.length : close + 1;
      continue;
    }

    const match = TAG_AT.exec(html.slice(lt, lt + 64));
    if (!match) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    const isEnd = html[lt + 1] === "/";
    const tag = match[1]!.toLowerCase();
    const tagEnd = tagEndFrom(html, lt);
    const selfClosing = html[tagEnd - 2] === "/";
    const raw = html.slice(lt, tagEnd);

    if (isEnd) {
      if (tag === "svg" || (foreign > 0 && FOREIGN_WALKABLE.has(tag))) out.push(`</dw-transparent-${raw.slice(2)}`);
      else out.push(raw);
      if ((tag === "svg" || tag === "math") && foreign > 0) foreign -= 1;
      i = tagEnd;
      continue;
    }

    if (tag === "svg" || tag === "math") {
      out.push(tag === "svg" ? `<dw-transparent-${raw.slice(1)}` : raw);
      if (!selfClosing) foreign += 1;
      i = tagEnd;
      continue;
    }
    if (tag === "script") {
      const end = selfClosing ? tagEnd : closingTagEnd(html, "script", tagEnd);
      out.push(html.slice(lt, end)); // verbatim, so its full text is what gets compared
      i = end;
      continue;
    }
    if (foreign > 0 && FOREIGN_WALKABLE.has(tag)) {
      out.push(`<dw-transparent-${raw.slice(1)}`);
      i = tagEnd;
      continue;
    }
    if (foreign === 0 && TEXT_ELEMENTS.has(tag) && !selfClosing) {
      const end = tag === "plaintext" ? html.length : closingTagEnd(html, tag, tagEnd);
      out.push(raw); // the opening tag, where a handler or address still counts
      out.push(" "); // the body is inert and dropped, so no quote in it spans the closer
      if (tag !== "plaintext") out.push(`</${tag}>`);
      i = end;
      continue;
    }

    out.push(raw);
    i = tagEnd;
  }
  return out.join("");
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
