import { createHash } from "node:crypto";
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
 * ways that let a hostile rewrite hide a handler past the end of an element
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
 *   or an address *on it* (`<iframe src>`) still counts. `<style/>` opens one
 *   too: HTML ignores the slash on anything but a void element.
 * - **Comments and CDATA end where the browser ends them.** `<!-->` and
 *   `<!--->` are empty comments, `--!>` also closes one, and inside foreign
 *   content `<![CDATA[ … ]]>` is text to `]]>`. The parser's own comment rule
 *   (`indexOf('-->')`) misses the first two, so comments are resolved here and
 *   collapsed to a space, and declarations, processing instructions and
 *   `</3>`-shaped bogus comments end at their `>`.
 * - **A tag ends where the browser's tokenizer ends it**: a quote opens a
 *   value only straight after `=`, and a name runs to whitespace, `/` or `>`,
 *   so `<svg.x>` is an unknown HTML element and not an SVG.
 *
 * **Inside `<svg>` or `<math>`, those elements are not raw text** — an
 * `<img onerror>` within an SVG `<style>` runs — so there they are renamed to
 * a plain tag the parser walks into, which matches the browser (a quoted value
 * in that context really does span, as it does in the DOM). Whether a given
 * `<style>` is in SVG is the whole question, and one counter of open
 * `<svg>`/`<math>` answered it wrongly in both directions until 13 Oct 2026.
 * A browser leaves foreign content by an HTML integration point
 * (`<foreignObject>`, `<desc>` or `<title>` in SVG; `<mi>`, `<mo>`, `<mn>`,
 * `<ms>`, `<mtext>` and `<annotation-xml encoding="text/html">` in MathML),
 * by one of the spec's breakout start tags (`<p>`, `<div>`, `<img>`,
 * `<font color>` and the rest of `BREAKOUT`), by `</p>` or `</br>`, or by an
 * HTML end tag that closes an element the `<svg>` sits inside; and it does not
 * leave by `<foreignObject>` inside `<math>`, which is a MathML element there.
 * So the open foreign elements are kept as a stack, by the tree-construction
 * rules for foreign content (`ForeignElement`).
 *
 * The one thing that stack cannot know is the HTML around it — whether a
 * `</div>` closes a `<div>` the `<svg>` is inside depends on implied end tags,
 * table modes and misnesting this file does not model. At each such point the
 * page is read **both ways** (`readings`), and anything either reading finds
 * counts. A page that is well nested has no such point and is read once.
 *
 * `<script>` is copied through its real `</script>` (escapes included), so its
 * full text is what gets compared and a `</style>` sitting inside a script
 * string is not mistaken for structure; an SVG `<script>` is ordinary markup
 * to the tokenizer, so it is walked like the rest of the SVG and counted as a
 * script all the same.
 *
 * The same copy is made of both pages, so a site's own content always compares
 * equal to itself.
 */

/** Raw-text and RCDATA elements: a browser ends them at `</name>`, not at a quote. */
const TEXT_ELEMENTS = new Set(["style", "textarea", "title", "xmp", "noscript", "noembed", "noframes", "iframe", "plaintext"]);
/** What `parse.ts` skips without reading; renamed wherever the browser does read into them. */
const PARSER_OPAQUE = new Set(["script", "style", "textarea", "title", "svg"]);
const RENAMED = "dw-transparent-";
/** Start tags that pop every open SVG and MathML element back to HTML (the spec's "in foreign content"). */
const BREAKOUT = new Set([
  "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt", "em", "embed", "h1", "h2", "h3", "h4", "h5", "h6",
  "head", "hr", "i", "img", "li", "listing", "menu", "meta", "nobr", "ol", "p", "pre", "ruby", "s", "small", "span", "strong", "strike",
  "sub", "sup", "table", "tt", "u", "ul", "var",
]);
/** Elements the HTML rules never leave open (`<image>` is read as `<img>`). */
const VOID = new Set(["area", "base", "basefont", "bgsound", "br", "col", "embed", "hr", "image", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
/** Table and template tags, whose rules pop through an integration point when a table or template is open. */
const TABLE_STARTS = new Set(["caption", "col", "colgroup", "tbody", "tfoot", "thead", "td", "th", "tr", "table"]);
const TABLE_ENDS = new Set(["table", "tbody", "thead", "tfoot", "tr", "td", "th", "caption", "template"]);
/**
 * HTML elements whose start or end tag can close something other than
 * themselves — implied end tags, a `<p>` or `<li>` closed by its successor, the
 * adoption agency's `<a>` and `<nobr>`, forms, buttons, headings, tables.
 * Opened inside an integration point, they leave the current node unknowable
 * here; every other element ends at its own end tag, and is followed exactly.
 */
const NOT_ORDINARY = new Set([
  "a", "nobr", "button", "form", "select", "option", "optgroup", "datalist", "li", "dd", "dt", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ruby", "rb", "rp", "rt", "rtc", "applet", "marquee", "object", "template", "frameset", "frame",
  ...TABLE_STARTS,
]);
/** Past this many readings a page's foreign markup is too tangled to read, and what follows is refused rather than guessed. */
const MAX_READINGS = 32;

type ForeignElement = {
  tag: string;
  ns: "svg" | "math";
  /** `htmlIp`/`textIp`: HTML rules apply to start tags inside it. `annotation`: a scope boundary that is not one. */
  kind: "plain" | "htmlIp" | "textIp" | "annotation";
  /** Whether an HTML element (rather than the foreign element below) is its parent — "maybe" where the stack cannot tell. */
  below: boolean | "maybe";
  /**
   * On an integration point, the HTML elements open inside it, while they are
   * ones that end only at their own end tag (not in `NOT_ORDINARY`): the
   * current node is the last of them, or the point itself when there are none.
   */
  html: string[];
  /** On an integration point: HTML the list above cannot follow was opened inside it, so the current node may be either. */
  tainted: boolean;
};

const isSpace = (char: string | undefined) => char === " " || char === "\t" || char === "\n" || char === "\f" || char === "\r";
const isLetter = (char: string | undefined) => char !== undefined && /[a-zA-Z]/.test(char);
const isIntegrationPoint = (element: ForeignElement) => element.kind === "htmlIp" || element.kind === "textIp";
/** Whether the current node is HTML inside this integration point rather than the point itself: "maybe" when that cannot be told. */
const htmlInside = (element: ForeignElement): boolean | "maybe" =>
  !isIntegrationPoint(element) ? false : element.tainted ? "maybe" : element.html.length > 0;

type Tag = { name: string; end: number; selfClosing: boolean; attributes: Map<string, string> };

/**
 * A start or end tag at `lt`, tokenized as a browser does: the name runs to
 * whitespace, `/` or `>`; a quote opens a value only straight after `=`; and
 * a tag the document ends inside runs to its end.
 */
function readTag(html: string, lt: number): Tag {
  let i = lt + (html[lt + 1] === "/" ? 2 : 1);
  const nameStart = i;
  while (i < html.length && !isSpace(html[i]) && html[i] !== "/" && html[i] !== ">") i += 1;
  const name = html.slice(nameStart, i).toLowerCase();
  const attributes = new Map<string, string>();
  while (i < html.length) {
    const char = html[i];
    if (isSpace(char)) { i += 1; continue; }
    if (char === ">") return { name, end: i + 1, selfClosing: false, attributes };
    if (char === "/") {
      if (html[i + 1] === ">") return { name, end: i + 2, selfClosing: true, attributes };
      i += 1;
      continue;
    }
    let j = i + 1; // a name may begin with `=`
    while (j < html.length && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">" && html[j] !== "=") j += 1;
    const attribute = html.slice(i, j).toLowerCase();
    let k = j;
    while (isSpace(html[k])) k += 1;
    let value = "";
    if (html[k] === "=") {
      k += 1;
      while (isSpace(html[k])) k += 1;
      const quote = html[k];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, k + 1);
        if (close < 0) return { name, end: html.length, selfClosing: false, attributes };
        value = html.slice(k + 1, close);
        i = close + 1;
      } else {
        let m = k;
        while (m < html.length && !isSpace(html[m]) && html[m] !== ">") m += 1;
        value = html.slice(k, m);
        i = m;
      }
    } else {
      i = k;
    }
    if (!attributes.has(attribute)) attributes.set(attribute, value);
  }
  return { name, end: html.length, selfClosing: false, attributes };
}

/** `</name` as a browser accepts it as the end of a raw-text element: followed by whitespace, `/` or `>`. */
function closerPattern(name: string): RegExp {
  return new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
}

/** Index of the `<` of the real `</name>` from `from`, or -1 when it never closes. */
function rawTextCloser(html: string, name: string, from: number): number {
  const pattern = closerPattern(name);
  pattern.lastIndex = from;
  return pattern.exec(html)?.index ?? -1;
}

/**
 * Index of the `<` of the `</script>` that really ends an HTML script, from
 * `from`, or -1. Inside `<!--` a nested `<script>` makes the next
 * `</script>` part of the text — the escape states a browser keeps — so the
 * first `</script>` in the source is not always the end.
 */
function scriptCloser(html: string, from: number): number {
  const token = /<!--|-->|<\/script(?=[\t\n\f\r />])|<script(?=[\t\n\f\r />])/gi;
  token.lastIndex = from;
  let state: "data" | "escaped" | "double" = "data";
  for (let match = token.exec(html); match; match = token.exec(html)) {
    const text = match[0].toLowerCase();
    if (text === "<!--") {
      if (state !== "data") continue;
      let after = match.index + 4;
      while (html[after] === "-") after += 1;
      if (html[after] !== ">") state = "escaped";
      // `<!-->` and `<!--->` are over as soon as they start.
      token.lastIndex = after;
    } else if (text === "-->") {
      if (state !== "data") state = "data";
    } else if (text === "</script") {
      if (state === "double") state = "escaped";
      else return match.index;
    } else if (state === "escaped") {
      state = "double";
    }
  }
  return -1;
}

/** Where the closing tag starting at `lt` ends — tokenized, so a `>` in a quoted value on it is not its end. */
const closerEnd = (html: string, lt: number) => (lt < 0 ? html.length : readTag(html, lt).end);

/**
 * One reading of the page: the copy the parser walks, given an answer at each
 * point where the HTML around a foreign element decides what happens next.
 * `choices` holds those answers in order (0 when it runs out); `arities`,
 * `positions` and `states` say how many answers each point had, where it was,
 * and what was open there.
 */
function transparent(html: string, choices: number[]): { source: string; arities: number[]; positions: number[]; states: string[] } {
  const out: string[] = [];
  const arities: number[] = [];
  const positions: number[] = [];
  const states: string[] = [];
  const decide = (count: number, at: number): number => {
    if (count <= 1) return 0;
    const index = arities.length;
    arities.push(count);
    positions.push(at);
    states.push(JSON.stringify([open, tableSeen]));
    return Math.min(choices[index] ?? 0, count - 1);
  };
  const open: ForeignElement[] = [];
  let tableSeen = false;
  const top = () => open[open.length - 1];
  const rename = (raw: string, name: string, end: boolean) => {
    const parserName = /^[a-z][a-z0-9:-]*/.exec(name)?.[0] ?? "";
    if (!PARSER_OPAQUE.has(parserName)) return raw;
    return end ? `</${RENAMED}${raw.slice(2)}` : `<${RENAMED}${raw.slice(1)}`;
  };
  /** Pops the foreign elements above the nearest integration point or HTML element. */
  const popToIntegrationPoint = () => {
    while (open.length && !isIntegrationPoint(top()!)) open.pop();
  };
  /**
   * The stack lengths an HTML end tag handled by the HTML rules could leave:
   * ignored (always possible here), or having closed an HTML element under
   * one of the open foreign elements. Scope stops at an integration point,
   * except for the table and template rules, which do not.
   */
  const htmlEndOutcomes = (name: string, outcomes: number[], viaHtml: Set<number>) => {
    outcomes.push(open.length);
    const pierces = tableSeen && TABLE_ENDS.has(name);
    for (let index = open.length - 1; index >= 0; index -= 1) {
      const element = open[index]!;
      // A boundary between the current node and the HTML below: out of scope.
      if (element.kind !== "plain" && !pierces) break;
      if (element.below !== false) {
        outcomes.push(index);
        viaHtml.add(index);
      }
    }
  };
  /**
   * Takes one outcome. Closing an HTML element under foreign content also
   * closes HTML this file did not follow, so an integration point left on top
   * can no longer say which node is current.
   */
  const settle = (outcomes: number[], viaHtml: Set<number>, at: number) => {
    const distinct = [...new Set(outcomes)];
    const chosen = distinct[decide(distinct.length, at)]!;
    if (chosen >= open.length) return;
    open.length = chosen;
    const current = top();
    if (viaHtml.has(chosen) && current && isIntegrationPoint(current)) current.tainted = true;
  };

  let i = 0;
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
    if (html.startsWith("<![CDATA[", lt)) {
      // CDATA only where the current node is foreign; in HTML it is a bogus
      // comment that ends at the first `>`. On an integration point the spec
      // says CDATA and Chromium says comment, so it is read both ways.
      const current = top();
      const cdata = !current ? false
        : !isIntegrationPoint(current) ? true
        : htmlInside(current) === true ? false
        : decide(2, lt) === 1;
      if (cdata) {
        const close = html.indexOf("]]>", lt + 9);
        out.push(" ");
        i = close < 0 ? html.length : close + 3;
        continue;
      }
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt) || (html[lt + 1] === "/" && !isLetter(html[lt + 2]))) {
      // `</>` is dropped; `</3>`, a declaration and a processing instruction are comments to their `>`.
      const close = html.indexOf(">", lt);
      out.push(" ");
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    const isEnd = html[lt + 1] === "/";
    if (!isLetter(html[lt + (isEnd ? 2 : 1)])) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    const tag = readTag(html, lt);
    const name = tag.name;
    const raw = html.slice(lt, tag.end);

    if (isEnd) {
      out.push(rename(raw, name, true));
      i = tag.end;
      if (!open.length) continue;
      const current = top()!;
      const inside = htmlInside(current);
      const outcomes: number[] = [];
      const viaHtml = new Set<number>();
      if (inside === true) {
        // The HTML rules alone. An ordinary element closed in order is
        // followed; closed out of order, the point stops being readable.
        const last = current.html.lastIndexOf(name);
        if (last >= 0 && last === current.html.length - 1) current.html.pop();
        else if (last >= 0) current.tainted = true;
        htmlEndOutcomes(name, outcomes, viaHtml);
      } else if (name === "p" || name === "br") {
        // Pops back to HTML when the current node is foreign; HTML above an
        // integration point it leaves where it is.
        let index = open.length;
        while (index > 0 && !isIntegrationPoint(open[index - 1]!)) index -= 1;
        outcomes.push(index);
      } else {
        for (let index = open.length - 1; index >= 0; index -= 1) {
          const element = open[index]!;
          if (element.tag === name) {
            outcomes.push(index);
            break;
          }
          if (element.below !== false) {
            htmlEndOutcomes(name, outcomes, viaHtml);
            if (element.below === true) break;
          }
        }
        if (!outcomes.length) outcomes.push(open.length);
      }
      // When the current node may be HTML inside the integration point
      // instead, the HTML rules may apply as well.
      if (inside === "maybe") htmlEndOutcomes(name, outcomes, viaHtml);
      settle(outcomes, viaHtml, lt);
      continue;
    }

    // Which rules a start tag is handled by: the foreign ones while the current
    // node is an SVG or MathML element that is not an integration point.
    let current = top();
    let foreign = false;
    if (current) {
      if (current.kind === "plain") foreign = true;
      else if (current.kind === "annotation") foreign = name !== "svg";
      else if (current.kind === "textIp" && (name === "mglyph" || name === "malignmark")) {
        const inside = htmlInside(current);
        foreign = inside === "maybe" ? decide(2, lt) === 1 : !inside;
      }
    }
    if (foreign && (BREAKOUT.has(name) || (name === "font" && ["color", "face", "size"].some((key) => tag.attributes.has(key))))) {
      popToIntegrationPoint();
      current = top();
      foreign = false;
    }

    if (foreign) {
      const ns = current!.ns;
      const encoding = (tag.attributes.get("encoding") ?? "").toLowerCase();
      const kind: ForeignElement["kind"] =
        ns === "svg" ? (["foreignobject", "desc", "title"].includes(name) ? "htmlIp" : "plain")
        : ["mi", "mo", "mn", "ms", "mtext"].includes(name) ? "textIp"
        : name === "annotation-xml" ? (encoding === "text/html" || encoding === "application/xhtml+xml" ? "htmlIp" : "annotation")
        : "plain";
      if (!tag.selfClosing) open.push({ tag: name, ns, kind, below: false, html: [], tainted: false });
      out.push(rename(raw, name, false)); // walked, like the rest of the SVG — an SVG <script> included
      i = tag.end;
      continue;
    }

    // The HTML rules.
    if (name === "svg" || name === "math") {
      if (!tag.selfClosing) open.push({ tag: name, ns: name, kind: "plain", below: current ? htmlInside(current) : true, html: [], tainted: false });
      out.push(rename(raw, name, false));
      i = tag.end;
      continue;
    }
    if (name === "script") {
      // Verbatim, so its full text is what gets compared. The slash on
      // `<script/>` is ignored as it is on any HTML element that is not void.
      const closer = scriptCloser(html, tag.end);
      const end = closer < 0 ? html.length : closerEnd(html, closer);
      out.push(tag.selfClosing ? `${raw.slice(0, -2)}>` : raw, html.slice(tag.end, end));
      i = end;
      continue;
    }
    if (TEXT_ELEMENTS.has(name)) {
      const closer = name === "plaintext" ? -1 : rawTextCloser(html, name, tag.end);
      out.push(raw); // the opening tag, where a handler or address still counts
      out.push(" "); // the body is inert and dropped, so no quote in it spans the closer
      if (name !== "plaintext") out.push(`</${name}>`);
      i = closer < 0 ? html.length : closerEnd(html, closer);
      continue;
    }
    if (open.length && tableSeen && TABLE_STARTS.has(name)) {
      // A table mode clears the stack back to its table, through any SVG on it.
      const outcomes: number[] = [];
      const viaHtml = new Set<number>();
      htmlEndOutcomes("table", outcomes, viaHtml);
      settle(outcomes, viaHtml, lt);
    }
    if (name === "table" || name === "template") tableSeen = true;
    current = top();
    if (current && isIntegrationPoint(current) && !VOID.has(name) && name !== "html" && name !== "head" && name !== "body") {
      if (NOT_ORDINARY.has(name)) current.tainted = true;
      else current.html.push(name);
    }
    out.push(rename(raw, name, false));
    i = tag.end;
  }
  return { source: out.join(""), arities, positions, states };
}

/**
 * Every reading of the page that the HTML around its foreign elements allows,
 * one per combination of answers, up to `MAX_READINGS`. Past that, the rest of
 * the page from the first point left unexplored — with what was open there,
 * so an edit above it cannot change how the same words below are read — is
 * returned as `unreadable`, and a change to it is refused rather than read
 * one way and run another.
 */
function readings(html: string): { sources: string[]; unreadable: string | null } {
  const sources: string[] = [];
  const left = { at: html.length + 1, state: "" };
  const explore = (prefix: number[]) => {
    const reading = transparent(html, prefix);
    sources.push(reading.source);
    for (let point = prefix.length; point < reading.arities.length; point += 1) {
      for (let choice = 1; choice < reading.arities[point]!; choice += 1) {
        if (sources.length >= MAX_READINGS) {
          if (reading.positions[point]! < left.at) Object.assign(left, { at: reading.positions[point]!, state: reading.states[point]! });
          return;
        }
        explore([...prefix, ...new Array<number>(point - prefix.length).fill(0), choice]);
      }
    }
  };
  explore([]);
  return { sources, unreadable: left.at <= html.length ? `${left.state}\u0000${html.slice(left.at)}` : null };
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

function itemsOf(source: string): ActiveItem[] {
  const items: ActiveItem[] = [];
  for (const element of everyElement(parseHtml(source))) {
    if (element.tag === "#root") continue;
    const tag = element.tag;
    const openingTag = source.slice(element.start, element.innerStart);
    // An SVG <script> is walked, so it arrives renamed; it runs all the same.
    if (tag === "script" || tag === `${RENAMED}script`) {
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
 * What runs on the page, by every reading of it: an item counts as many times
 * as the reading that has the most of it, so whichever way the browser goes,
 * nothing it runs is missed.
 */
function activeItems(html: string): ActiveItem[] {
  const { sources, unreadable } = readings(html);
  const most = new Map<string, { item: ActiveItem; count: number }>();
  for (const source of sources) {
    const counts = new Map<string, { item: ActiveItem; count: number }>();
    for (const item of itemsOf(source)) {
      const known = counts.get(item.key);
      if (known) known.count += 1;
      else counts.set(item.key, { item, count: 1 });
    }
    for (const [key, entry] of counts) {
      if ((most.get(key)?.count ?? 0) < entry.count) most.set(key, entry);
    }
  }
  const items = [...most.values()].flatMap(({ item, count }) => new Array<ActiveItem>(count).fill(item));
  if (unreadable !== null) {
    const digest = createHash("sha256").update(unreadable).digest("hex");
    items.push({ key: `unreadable\u0000${digest}`, what: "markup this check cannot read safely" });
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
