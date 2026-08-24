/**
 * A small HTML reader that remembers where everything was.
 *
 * The website is hand-built HTML and stays hand-built HTML — the editor changes
 * the words inside it, not the markup around them. That rules out every normal
 * parser: they all give you a tree and then a `serialize()` that returns *a*
 * document rather than *the* document. Attribute quoting, entity escaping,
 * whitespace between tags, the two spaces somebody left before a class — all of
 * it comes back subtly different, and the diff on a publish would be the whole
 * file instead of the one heading that changed.
 *
 * So this parser exists to answer one question: **which bytes am I allowed to
 * replace?** Every node carries the offsets of its own inner content and of each
 * attribute value, and the editor splices the original string at those offsets.
 * Anything it does not touch is byte-for-byte what the developer wrote.
 *
 * `checks/website.ts` holds it to that: parsing every page in the repository and
 * re-applying nothing must reproduce each file exactly.
 */

/** An attribute, and where its value sits in the source. */
export type Attr = {
  name: string;
  value: string;
  /** Offsets of the value itself, inside the quotes. Equal when the attribute is bare. */
  valueStart: number;
  valueEnd: number;
};

export type ElementNode = {
  tag: string;
  attrs: Attr[];
  /** Offset of the `<` that opens it. */
  start: number;
  /** Offset just past the `>` that closes it (the closing tag's, when it has one). */
  end: number;
  /** Offset just past the `>` of the opening tag — where inner content begins. */
  innerStart: number;
  /** Offset of the `<` of the closing tag — where inner content ends. */
  innerEnd: number;
  /** Offset just past the tag name in the opening tag, where a new attribute can be inserted. */
  attrInsert: number;
  children: ElementNode[];
  parent: ElementNode | null;
  /** No closing tag in the source: `<img>`, `<br>`, `<meta />`. */
  selfClosing: boolean;
};

/** Elements HTML never closes. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Elements whose content is not markup and must not be walked into.
 *
 * `svg` is here with the text ones because its children are a different
 * language — a `<title>` inside an icon is not a heading anybody wants offered
 * as editable copy, and `<text>` inside a chart is not a paragraph.
 */
const OPAQUE = new Set(["script", "style", "textarea", "title", "svg"]);

const TAG_START = /^<([a-zA-Z][a-zA-Z0-9:-]*)/;

const QUOTE_DOUBLE = String.fromCharCode(34);
const QUOTE_SINGLE = String.fromCharCode(39);

/**
 * Where an opaque element's content ends.
 *
 * `svg` counts depth because an `<svg>` inside an `<svg>` is legal, and stopping
 * at the first `</svg>` would hand the rest of the document to its parent.
 */
function opaqueEnd(source: string, tag: string, from: number): number {
  const lower = source.toLowerCase();
  if (tag !== "svg") {
    const idx = lower.indexOf(`</${tag}`, from);
    return idx < 0 ? source.length : idx;
  }
  let depth = 1;
  let i = from;
  while (i < lower.length) {
    const open = lower.indexOf("<svg", i);
    const close = lower.indexOf("</svg", i);
    if (close < 0) return lower.length;
    if (open >= 0 && open < close) {
      depth += 1;
      i = open + 4;
      continue;
    }
    depth -= 1;
    if (depth === 0) return close;
    i = close + 5;
  }
  return lower.length;
}

/** Reads the attributes of an opening tag, starting just past the tag name. */
function readAttrs(source: string, from: number): { attrs: Attr[]; tagEnd: number; selfClosing: boolean } {
  const attrs: Attr[] = [];
  let i = from;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    if (i >= source.length) break;
    if (source[i] === ">") return { attrs, tagEnd: i + 1, selfClosing: false };
    if (source.startsWith("/>", i)) return { attrs, tagEnd: i + 2, selfClosing: true };

    const nameStart = i;
    while (i < source.length && !/[\s/>=]/.test(source[i]!)) i += 1;
    const name = source.slice(nameStart, i).toLowerCase();
    if (!name) {
      // Nothing consumed — a stray character inside a tag. Step over it rather
      // than spinning on it forever.
      i += 1;
      continue;
    }

    let j = i;
    while (j < source.length && /\s/.test(source[j]!)) j += 1;
    if (source[j] !== "=") {
      attrs.push({ name, value: "", valueStart: i, valueEnd: i });
      continue;
    }

    j += 1;
    while (j < source.length && /\s/.test(source[j]!)) j += 1;
    const quote = source[j];
    if (quote === QUOTE_DOUBLE || quote === QUOTE_SINGLE) {
      const close = source.indexOf(quote, j + 1);
      const valueEnd = close < 0 ? source.length : close;
      attrs.push({ name, value: source.slice(j + 1, valueEnd), valueStart: j + 1, valueEnd });
      i = valueEnd + 1;
    } else {
      const valueStart = j;
      while (j < source.length && !/[\s>]/.test(source[j]!)) j += 1;
      attrs.push({ name, value: source.slice(valueStart, j), valueStart, valueEnd: j });
      i = j;
    }
  }
  return { attrs, tagEnd: source.length, selfClosing: false };
}

function node(tag: string, start: number, parent: ElementNode | null): ElementNode {
  return {
    tag,
    attrs: [],
    start,
    end: start,
    innerStart: start,
    innerEnd: start,
    attrInsert: start,
    children: [],
    parent,
    selfClosing: false,
  };
}

/**
 * Parses a document into a tree of elements with offsets. Text is not stored —
 * it is whatever sits between the offsets, and the source string stays the only
 * copy of it there ever is.
 *
 * Malformed markup does not throw. A closing tag with nothing to close is
 * ignored; one that matches something further down the stack closes everything
 * above it; anything still open at the end of the document is closed there. The
 * result is a best-effort tree over bytes that are still exact.
 */
export function parseHtml(source: string): ElementNode {
  const root = node("#root", 0, null);
  root.end = source.length;
  root.innerEnd = source.length;
  const stack: ElementNode[] = [root];
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;

    if (source.startsWith("<!--", lt)) {
      const close = source.indexOf("-->", lt + 4);
      i = close < 0 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      const close = source.indexOf(">", lt);
      i = close < 0 ? source.length : close + 1;
      continue;
    }

    if (source.startsWith("</", lt)) {
      const close = source.indexOf(">", lt);
      if (close < 0) break;
      const name = source.slice(lt + 2, close).trim().toLowerCase();
      for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
        if (stack[depth]!.tag !== name) continue;
        while (stack.length - 1 > depth) {
          const unclosed = stack.pop()!;
          unclosed.innerEnd = lt;
          unclosed.end = lt;
        }
        const closed = stack.pop()!;
        closed.innerEnd = lt;
        closed.end = close + 1;
        break;
      }
      i = close + 1;
      continue;
    }

    const match = TAG_START.exec(source.slice(lt, lt + 64));
    if (!match) {
      // A bare `<` in text. Not a tag; carry on from the next character.
      i = lt + 1;
      continue;
    }

    const tag = match[1]!.toLowerCase();
    const current = node(tag, lt, stack[stack.length - 1]!);
    current.attrInsert = lt + match[0].length;
    const { attrs, tagEnd, selfClosing } = readAttrs(source, current.attrInsert);
    current.attrs = attrs;
    current.innerStart = tagEnd;
    stack[stack.length - 1]!.children.push(current);

    if (selfClosing || VOID.has(tag)) {
      current.selfClosing = true;
      current.innerEnd = tagEnd;
      current.end = tagEnd;
      i = tagEnd;
      continue;
    }

    if (OPAQUE.has(tag)) {
      const contentEnd = opaqueEnd(source, tag, tagEnd);
      const close = source.indexOf(">", contentEnd);
      current.innerEnd = contentEnd;
      current.end = close < 0 ? source.length : close + 1;
      i = current.end;
      continue;
    }

    stack.push(current);
    i = tagEnd;
  }

  while (stack.length > 1) {
    const unclosed = stack.pop()!;
    unclosed.innerEnd = source.length;
    unclosed.end = source.length;
  }
  return root;
}

/** The value of an attribute, or undefined when the element does not carry it. */
export function attr(element: ElementNode, name: string): string | undefined {
  return element.attrs.find((candidate) => candidate.name === name)?.value;
}

export function attrNode(element: ElementNode, name: string): Attr | undefined {
  return element.attrs.find((candidate) => candidate.name === name);
}

/** Depth-first, the element itself first. */
export function* walk(element: ElementNode): Generator<ElementNode> {
  yield element;
  for (const child of element.children) yield* walk(child);
}

/** The first descendant matching one of the tags, in document order. */
export function findTag(element: ElementNode, tags: string[]): ElementNode | null {
  const wanted = new Set(tags);
  for (const candidate of walk(element)) {
    if (candidate !== element && wanted.has(candidate.tag)) return candidate;
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: String.fromCharCode(34), apos: String.fromCharCode(39),
  nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rarr: "→", larr: "←",
  copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", times: "×",
  middot: "·", bull: "•", deg: "°", euro: "€", pound: "£",
};

/** Entities to characters, for the places a value is shown to a person rather than written back. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** The visible text of an element, tags removed and entities decoded. */
export function textOf(source: string, element: ElementNode): string {
  const inner = source.slice(element.innerStart, element.innerEnd);
  return decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
