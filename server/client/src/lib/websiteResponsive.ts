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

export const TEXT_PROPERTIES = [
  "font-size",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "font-family",
  "font-weight",
  "color",
  "text-align",
  "text-transform",
  "font-style",
  "text-decoration",
];

export function applyEffectiveWithCascade(
  element: HTMLElement,
  effectiveStyle: string,
  isDesktop: boolean
): void {
  if (effectiveStyle) {
    element.setAttribute("style", effectiveStyle);
  } else {
    const base = element.getAttribute("data-dw-base-style");
    if (base) element.setAttribute("style", base);
    else element.removeAttribute("style");
  }

  const children = element.querySelectorAll<HTMLElement>("*");
  if (isDesktop) {
    children.forEach((child) => {
      if (child.getAttribute("data-dw-responsive-child") === "true") {
        TEXT_PROPERTIES.forEach((prop) => child.style.removeProperty(prop));
        child.removeAttribute("data-dw-responsive-child");
      }
    });
  } else {
    const parsed = parseStyle(effectiveStyle);
    children.forEach((child) => {
      child.setAttribute("data-dw-responsive-child", "true");
      for (const prop of TEXT_PROPERTIES) {
        if (parsed[prop]) {
          child.style.setProperty(prop, parsed[prop], "important");
        } else {
          child.style.removeProperty(prop);
        }
      }
    });
  }
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
    const rawBase = (baseStyle || element.getAttribute("data-dw-base-style") || element.getAttribute("style")) ?? "";
    if (!element.hasAttribute("data-dw-base-style") && rawBase) {
      element.setAttribute("data-dw-base-style", rawBase);
    }
    const effective = effectiveDeviceStyle(activeDevice, rawBase, responsive);
    applyEffectiveWithCascade(element, effective, activeDevice === "desktop");
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
    const baseStyle = edit?.style ?? field?.style ?? el.getAttribute("data-dw-base-style") ?? "";
    const responsive = edit?.responsive ?? field?.responsive ?? {};
    if (!el.hasAttribute("data-dw-base-style") && baseStyle) {
      el.setAttribute("data-dw-base-style", baseStyle);
    }
    let effective = effectiveDeviceStyle(device, baseStyle, responsive);
    if (previewStyle && effective) effective = previewStyle(effective);
    applyEffectiveWithCascade(el, effective, device === "desktop");
  }
}
