export type InlineFormat = "color" | "background-color" | "font-weight" | "font-style" | "text-decoration";

let activeFormatter: { root: HTMLElement; apply: (styles: Partial<Record<InlineFormat, string>>) => void } | null = null;
export function rememberTextFormatter(root: HTMLElement, apply: (styles: Partial<Record<InlineFormat, string>>) => void) { activeFormatter = { root, apply }; }
export function clearTextFormatter(root: HTMLElement) { if (activeFormatter?.root === root) activeFormatter = null; }
export function formatActiveText(styles: Partial<Record<InlineFormat, string>>): boolean {
  if (!activeFormatter?.root.isConnected) { activeFormatter = null; return false; }
  activeFormatter.apply(styles);
  return true;
}

/** Wrap only selected text nodes, preserving links and nested emphasis. */
export function formatTextRange(root: HTMLElement, range: Range, styles: Partial<Record<InlineFormat, string>>): Range | null {
  if (range.collapsed || !root.contains(range.commonAncestorContainer)) return null;
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, 4);
  const selected: Array<{ node: Text; start: number; end: number }> = [];
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (!range.intersectsNode(current)) continue;
    const node = current as Text;
    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : node.length;
    if (end > start) selected.push({ node, start, end });
  }
  if (!selected.length) return null;
  const wrapped: Text[] = [];
  for (const { node, start, end } of selected.reverse()) {
    if (end < node.length) node.splitText(end);
    const part = start ? node.splitText(start) : node;
    const parent = part.parentElement;
    const reuse = parent?.tagName === "SPAN" && parent.childNodes.length === 1;
    const span = reuse ? parent : document.createElement("span");
    for (const [property, value] of Object.entries(styles)) span.style.setProperty(property, value);
    if (!reuse) { part.parentNode!.insertBefore(span, part); span.appendChild(part); }
    wrapped.unshift(part);
  }
  const next = document.createRange();
  next.setStart(wrapped[0], 0);
  next.setEnd(wrapped[wrapped.length - 1], wrapped[wrapped.length - 1].length);
  return next;
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
