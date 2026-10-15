import type { ResponsiveStyles } from "./types.js";
import { isTextElement, responsiveStyleCss, TEXT_TAGS } from "../../../src/shared/websiteResponsive.js";
export { safeResponsiveStyle } from "../../../src/shared/websiteResponsive.js";

/**
 * Preview rules only; the server validates and serializes published rules.
 *
 * `base` is the element's Desktop style and `text` whether it is a run of words
 * — the same two facts the published stylesheet is built from, so a font size
 * reaches the words inside on the canvas exactly where it will on the site.
 */
export function responsivePreviewCss(id: string, responsive: ResponsiveStyles, base?: string, text?: boolean): string {
  return responsiveStyleCss([{ token: id, responsive, base, text }], "data-dw-field");
}

/**
 * Whether the published page will push this element's sizes to the words
 * inside it, decided the way the server decides it: by its children on an
 * HTML page, by its tag on a page built from source files.
 */
export function previewTextElement(element: Element, sourcePage: boolean): boolean {
  if (sourcePage) return TEXT_TAGS.has(element.tagName.toLowerCase());
  return isTextElement(Array.from(element.children ?? [], (child) => child.tagName));
}

/**
 * A complete override map replaces saved media rules for this one element.
 *
 * The element's saved token comes off, so the server's rules for it stop
 * applying and this sheet speaks for it alone. On a source page a Desktop size
 * is written into the block's own style and reaches nothing, so `base` is not
 * passed on there.
 */
export function writeResponsivePreview(doc: Document, element: Element, id: string, responsive: ResponsiveStyles, base: string, sourcePage = false): void {
  const css = responsivePreviewCss(id, responsive, sourcePage ? undefined : base, previewTextElement(element, sourcePage));
  element.removeAttribute("data-dw-style");
  const sheet = Array.from(doc.querySelectorAll<HTMLStyleElement>("style[data-dw-responsive-preview]")).find((node) => node.getAttribute("data-dw-responsive-preview") === id);
  if (!css) {
    sheet?.remove();
    return;
  }
  const target = sheet ?? doc.createElement("style");
  if (!sheet) {
    target.setAttribute("data-dw-responsive-preview", id);
    (doc.head ?? doc.body).appendChild(target);
  }
  target.textContent = css;
}
