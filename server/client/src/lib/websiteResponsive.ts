import type { ResponsiveStyles } from "./types.js";
import { responsiveStyleCss } from "../../../src/shared/websiteResponsive.js";
import { parseStyle, writeStyle } from "../components/InspectorControls";
export { safeResponsiveStyle } from "../../../src/shared/websiteResponsive.js";

/** Preview rules only; the server validates and serializes published rules. */
export function responsivePreviewCss(id: string, responsive: ResponsiveStyles): string {
  return responsiveStyleCss([{ token: id, responsive }], "data-dw-field");
}

export function effectiveDeviceStyle(device: string, baseStyle = "", responsive: ResponsiveStyles = {}): string {
  const base = parseStyle(baseStyle);
  if (device === "desktop") return writeStyle(base);
  const tablet = parseStyle(responsive.tablet ?? "");
  if (device === "tablet") return writeStyle({ ...base, ...tablet });
  const mobile = parseStyle(responsive.mobile ?? "");
  return writeStyle({ ...base, ...tablet, ...mobile });
}

/** A complete override map replaces saved media rules for this one element. */
export function writeResponsivePreview(
  doc: Document,
  element: Element,
  id: string,
  responsive: ResponsiveStyles,
  activeDevice?: string,
  baseStyle?: string
): void {
  const css = responsivePreviewCss(id, responsive);
  element.removeAttribute("data-dw-style");
  let sheet = Array.from(doc.querySelectorAll<HTMLStyleElement>("style[data-dw-responsive-preview]")).find(node => node.getAttribute("data-dw-responsive-preview") === id);
  if (!css) {
    sheet?.remove();
  } else {
    if (!sheet) {
      sheet = doc.createElement("style");
      sheet.setAttribute("data-dw-responsive-preview", id);
      (doc.head ?? doc.body).appendChild(sheet);
    }
    sheet.textContent = css;
  }
  if (activeDevice && element instanceof HTMLElement) {
    const effective = effectiveDeviceStyle(activeDevice, baseStyle ?? element.getAttribute("style") ?? "", responsive);
    if (effective) element.setAttribute("style", effective);
    else if (baseStyle) element.setAttribute("style", baseStyle);
    else element.removeAttribute("style");
  }
}

export function syncAllResponsiveStylesToIframe(
  doc: Document,
  device: string,
  edits: Record<string, { style?: string; responsive?: ResponsiveStyles }>,
  fields: Array<{ id: string; style?: string; responsive?: ResponsiveStyles }>,
  previewStyle?: (s: string) => string
): void {
  const allIds = new Set([...Object.keys(edits), ...fields.map(f => f.id)]);
  for (const id of allIds) {
    const el = doc.querySelector(`[data-dw-field="${id.replace(/"/g, "")}"]`);
    if (!el || !(el instanceof HTMLElement)) continue;
    const field = fields.find(f => f.id === id);
    const edit = edits[id];
    if (edit?.style === undefined && edit?.responsive === undefined && !field?.responsive) continue;
    const baseStyle = edit?.style ?? field?.style ?? "";
    const responsive = edit?.responsive ?? field?.responsive ?? {};
    let effective = effectiveDeviceStyle(device, baseStyle, responsive);
    if (previewStyle && effective) effective = previewStyle(effective);
    if (effective) el.setAttribute("style", effective);
    else if (baseStyle) el.setAttribute("style", previewStyle ? previewStyle(baseStyle) : baseStyle);
    else el.removeAttribute("style");
  }
}
