export type InlineFormat = "color" | "background-color" | "font-weight" | "font-style" | "text-decoration";

/** The four buttons that switch on and off, the way they do in any word processor. */
export type TextToggle = "bold" | "italic" | "underline" | "strike";

/**
 * What a formatting control asks for.
 *
 * `set` is for a value somebody picked (a colour, a highlight). `toggle` is for
 * the buttons: pressed again over words that already have it, it takes it away.
 * Bold used to be `set` as well, which made it a one-way door — the only route
 * back to regular words was a button that wrote `font-weight: normal` over
 * everything, which in a heading made the words thinner than the heading.
 * `clear` removes formatting rather than writing more of it.
 */
export type TextFormatAction =
  | { kind: "set"; styles: Partial<Record<InlineFormat, string>> }
  | { kind: "toggle"; format: TextToggle }
  | { kind: "clear" };

/** Strong enough to read on a white or cream page; the old #fff2a8 barely did. */
export const DEFAULT_HIGHLIGHT = "#fde047";

let activeFormatter: { root: HTMLElement; apply: (action: TextFormatAction) => void } | null = null;
export function rememberTextFormatter(root: HTMLElement, apply: (action: TextFormatAction) => void) { activeFormatter = { root, apply }; }
export function clearTextFormatter(root: HTMLElement) { if (activeFormatter?.root === root) activeFormatter = null; }
export function formatActiveText(styles: Partial<Record<InlineFormat, string>>): boolean {
  if (!activeFormatter?.root.isConnected) { activeFormatter = null; return false; }
  activeFormatter.apply({ kind: "set", styles });
  return true;
}

/** Wrap only selected text nodes, preserving links and nested emphasis. */
export function formatTextRange(root: HTMLElement, range: Range, styles: Partial<Record<InlineFormat, string>>): Range | null {
  return applyTextFormat(root, range, { kind: "set", styles });
}

/**
 * Does one formatting action to the words in `range`, and returns a range over
 * the same words afterwards so the selection can be put back.
 *
 * Null when the range holds no words inside `root`.
 */
export function applyTextFormat(root: HTMLElement, range: Range, action: TextFormatAction): Range | null {
  if (range.collapsed || !root.contains(range.commonAncestorContainer)) return null;
  const parts = isolateSelectedText(root, range);
  if (!parts.length) return null;

  if (action.kind === "set") {
    for (const part of parts) {
      const span = wrapperFor(part);
      for (const [property, value] of Object.entries(action.styles)) span.style.setProperty(property, value);
    }
  } else if (action.kind === "toggle") {
    const on = everyPartIs(root, parts, action.format);
    for (const part of parts) {
      if (!on) { switchOn(root, part, action.format); continue; }
      takeAway(root, part, action.format);
      // Bold a heading is bold because of the heading, not because of anything
      // in the words. Taking our formatting away leaves it bold, so say the
      // opposite explicitly. A line under a link cannot be taken away from
      // inside it — that one stays, and the link is still a link.
      if (action.format === "bold" && isOn(root, part, "bold")) wrapperFor(part).style.setProperty("font-weight", "400");
      if (action.format === "italic" && isOn(root, part, "italic")) wrapperFor(part).style.setProperty("font-style", "normal");
    }
  } else {
    for (const part of parts) clearFormatting(root, part);
  }

  const next = root.ownerDocument.createRange();
  next.setStart(parts[0], 0);
  next.setEnd(parts[parts.length - 1], parts[parts.length - 1].length);
  return next;
}

/** Which of the four toggles the words in `range` all already have — for pressed buttons. */
export function textFormatState(root: HTMLElement, range: Range | null): Record<TextToggle, boolean> {
  const none = { bold: false, italic: false, underline: false, strike: false };
  if (!range || range.collapsed || !root.isConnected || !root.contains(range.commonAncestorContainer)) return none;
  const parts = selectedTextNodes(root, range).map(entry => entry.node).filter(node => (node.data ?? "").trim());
  if (!parts.length) return none;
  return {
    bold: everyPartIs(root, parts, "bold"),
    italic: everyPartIs(root, parts, "italic"),
    underline: everyPartIs(root, parts, "underline"),
    strike: everyPartIs(root, parts, "strike"),
  };
}

export function editableInnerHtml(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const element of clone.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith("data-dw-") || attribute.name === "contenteditable") element.removeAttribute(attribute.name);
    }
  }
  return clone.innerHTML;
}

/* ------------------------------------------------------------- internals */

function selectedTextNodes(root: HTMLElement, range: Range): Array<{ node: Text; start: number; end: number }> {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const selected: Array<{ node: Text; start: number; end: number }> = [];
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (!range.intersectsNode(current)) continue;
    const node = current as Text;
    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : node.length;
    if (end > start) selected.push({ node, start, end });
  }
  return selected;
}

/** Splits the text nodes at the edges of the selection so each selected run is a node of its own. */
function isolateSelectedText(root: HTMLElement, range: Range): Text[] {
  const parts: Text[] = [];
  for (const { node, start, end } of selectedTextNodes(root, range).reverse()) {
    if (end < node.length) node.splitText(end);
    parts.unshift(start ? node.splitText(start) : node);
  }
  return parts;
}

/** A span holding exactly this text and nothing else: the parent when it already is one. */
function wrapperFor(part: Text): HTMLElement {
  const parent = part.parentElement;
  if (parent?.tagName === "SPAN" && parent.childNodes.length === 1) return parent;
  const span = part.ownerDocument.createElement("span");
  part.parentNode!.insertBefore(span, part);
  span.appendChild(part);
  return span;
}

const LINE: Record<"underline" | "strike", string> = { underline: "underline", strike: "line-through" };

function lines(element: HTMLElement): string[] {
  const value = element.style.getPropertyValue("text-decoration-line") || element.style.getPropertyValue("text-decoration");
  return value.split(/\s+/).filter(word => word === "underline" || word === "line-through" || word === "overline");
}

function setLines(element: HTMLElement, next: string[]) {
  element.style.removeProperty("text-decoration");
  element.style.removeProperty("text-decoration-line");
  if (next.length) element.style.setProperty("text-decoration-line", next.join(" "));
}

function isOn(root: HTMLElement, part: Text, format: TextToggle): boolean {
  const view = root.ownerDocument.defaultView;
  const parent = part.parentElement;
  if (!view || !parent) return false;
  if (format === "bold") return (parseInt(view.getComputedStyle(parent).fontWeight, 10) || 400) >= 600;
  if (format === "italic") return view.getComputedStyle(parent).fontStyle !== "normal";
  // A line under the words is drawn by whichever ancestor asked for it; it is
  // not inherited, so every element up to and including the field is asked.
  const stop = root.parentElement;
  for (let el: HTMLElement | null = parent; el && el !== stop; el = el.parentElement) {
    if (view.getComputedStyle(el).textDecorationLine.includes(LINE[format])) return true;
  }
  return false;
}

function everyPartIs(root: HTMLElement, parts: Text[], format: TextToggle): boolean {
  const words = parts.filter(part => part.data.trim());
  return words.length > 0 && words.every(part => isOn(root, part, format));
}

/**
 * On again. An earlier "off" written over a bold heading is taken back out
 * first, so bold-off-then-on returns the words to exactly what they were
 * rather than stacking a 700 over a 400.
 */
function switchOn(root: HTMLElement, part: Text, format: TextToggle) {
  if (format === "bold" || format === "italic") {
    const property = format === "bold" ? "font-weight" : "font-style";
    for (const el of ancestorsWithin(root, part)) {
      const value = el.style.getPropertyValue(property);
      const off = format === "bold" ? Boolean(value) && (parseInt(value, 10) || (/bold/.test(value) ? 700 : 400)) < 600 : value === "normal";
      if (!off) continue;
      isolate(part, el);
      el.style.removeProperty(property);
      tidy(el);
    }
  }
  if (isOn(root, part, format)) return;
  const span = wrapperFor(part);
  if (format === "bold") span.style.setProperty("font-weight", "700");
  else if (format === "italic") span.style.setProperty("font-style", "italic");
  else setLines(span, [...new Set([...lines(span), LINE[format]])]);
}

const TAGS: Record<TextToggle, string[]> = {
  bold: ["B", "STRONG"],
  italic: ["I", "EM"],
  underline: ["U", "INS"],
  strike: ["S", "STRIKE", "DEL"],
};

/** Removes one kind of formatting from the ancestors of `part`, splitting any that also hold other words. */
function takeAway(root: HTMLElement, part: Text, format: TextToggle) {
  for (const el of ancestorsWithin(root, part)) {
    const tagged = TAGS[format].includes(el.tagName);
    const styled =
      format === "bold" ? Boolean(el.style.getPropertyValue("font-weight"))
      : format === "italic" ? Boolean(el.style.getPropertyValue("font-style"))
      : lines(el).includes(LINE[format]);
    if (!tagged && !styled) continue;
    isolate(part, el);
    if (styled) {
      if (format === "bold") el.style.removeProperty("font-weight");
      else if (format === "italic") el.style.removeProperty("font-style");
      else setLines(el, lines(el).filter(line => line !== LINE[format]));
    }
    if (tagged && el.attributes.length === 0) unwrap(el);
    else if (tagged && (format === "bold" || format === "italic")) el.style.setProperty(format === "bold" ? "font-weight" : "font-style", format === "bold" ? "400" : "normal");
    else tidy(el);
  }
}

const CLEARED = ["color", "background-color", "background", "font-weight", "font-style", "text-decoration", "text-decoration-line", "text-decoration-color", "text-decoration-style"];
const CLEARED_TAGS = ["B", "STRONG", "I", "EM", "U", "INS", "S", "STRIKE", "DEL", "MARK", "FONT"];

/** Back to the element's own look: inline formatting off, the page's own CSS untouched. */
function clearFormatting(root: HTMLElement, part: Text) {
  for (const el of ancestorsWithin(root, part)) {
    const styled = CLEARED.some(property => el.style.getPropertyValue(property));
    const tagged = CLEARED_TAGS.includes(el.tagName) && el.attributes.length === 0;
    if (!styled && !tagged) continue;
    isolate(part, el);
    if (tagged) { unwrap(el); continue; }
    for (const property of CLEARED) el.style.removeProperty(property);
    tidy(el);
  }
}

/** From the outermost element inside `root` down to the one holding the text. */
function ancestorsWithin(root: HTMLElement, part: Text): HTMLElement[] {
  const list: HTMLElement[] = [];
  for (let el = part.parentElement; el && el !== root && root.contains(el); el = el.parentElement) list.unshift(el);
  return list;
}

/**
 * Leaves `element` wrapping only `part`, by moving whatever came before and
 * after it into copies of `element` either side. The text node itself is never
 * copied, so a range built on it afterwards still points at the page.
 */
function isolate(part: Text, element: HTMLElement) {
  const document = element.ownerDocument;
  const before = document.createRange();
  before.setStart(element, 0);
  before.setEndBefore(part);
  const leading = before.extractContents();
  const after = document.createRange();
  after.setStartAfter(part);
  after.setEnd(element, element.childNodes.length);
  const trailing = after.extractContents();
  if (hasContent(leading)) { const copy = element.cloneNode(false) as HTMLElement; copy.appendChild(leading); element.before(copy); }
  if (hasContent(trailing)) { const copy = element.cloneNode(false) as HTMLElement; copy.appendChild(trailing); element.after(copy); }
}

function hasContent(fragment: DocumentFragment): boolean {
  return Boolean(fragment.textContent) || Boolean(fragment.querySelector("img,br,svg,picture,video,iframe,input"));
}

function unwrap(element: HTMLElement) {
  element.replaceWith(...Array.from(element.childNodes));
}

/** A span left with no style and nothing else to say is removed; its words stay. */
function tidy(element: HTMLElement) {
  if (!element.getAttribute("style")?.trim()) element.removeAttribute("style");
  if (element.tagName === "SPAN" && element.attributes.length === 0) unwrap(element);
}
