import type { ResponsiveStyles } from "./types.js";
import { responsiveStyleCss } from "../../../src/shared/websiteResponsive.js";
export { safeResponsiveStyle } from "../../../src/shared/websiteResponsive.js";

/** Preview rules only; the server validates and serializes published rules. */
export function responsivePreviewCss(id: string, responsive: ResponsiveStyles): string {
  return responsiveStyleCss([{ token: id, responsive }], "data-dw-field");
}

/** A complete override map replaces saved media rules for this one element. */
export function writeResponsivePreview(doc: Document, element: Element, id: string, responsive: ResponsiveStyles): void {
  const css = responsivePreviewCss(id, responsive);
  element.removeAttribute("data-dw-style");
  let sheet = Array.from(doc.querySelectorAll<HTMLStyleElement>("style[data-dw-responsive-preview]")).find(node => node.getAttribute("data-dw-responsive-preview") === id);
  if (!css) { sheet?.remove(); return; }
  if (!sheet) {
    sheet = doc.createElement("style");
    sheet.setAttribute("data-dw-responsive-preview", id);
    (doc.head ?? doc.body).appendChild(sheet);
  }
  sheet.textContent = css;
}
