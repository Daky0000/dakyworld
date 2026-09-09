import { attrNode, decodeEntities, findTag, parseHtml, walk, type ElementNode } from "./parse.js";
import { normalizeResponsive, responsiveStyleCss, RESPONSIVE_TOKEN, type ResponsiveStyles } from "../../shared/websiteResponsive.js";
export { normalizeResponsive, responsiveEqual, safeResponsiveStyle, renderResponsiveCss, responsiveStyleCss, RESPONSIVE_BREAKPOINTS, RESPONSIVE_TOKEN } from "../../shared/websiteResponsive.js";
export type { ResponsiveStyles, ResponsiveStyleEntry } from "../../shared/websiteResponsive.js";

/** The parser preserves raw attribute bytes; JSON must see decoded quotes. */
export function responsiveOf(node: ElementNode): ResponsiveStyles {
  const raw = attrNode(node, "data-dw-responsive")?.value;
  if (!raw) return {};
  try { return normalizeResponsive(JSON.parse(decodeEntities(raw))); } catch { return {}; }
}

/** Regenerate only the editor-owned block; include nodes the editor cannot edit. */
export function regenerateResponsiveStyles(source: string): string {
  const root = parseHtml(source);
  const nodes = [...walk(root)];
  const entries = nodes.flatMap((node) => {
    const token = attrNode(node, "data-dw-style")?.value;
    return token && RESPONSIVE_TOKEN.test(token) ? [{ token, responsive: responsiveOf(node) }] : [];
  });
  const css = responsiveStyleCss(entries);
  const block = css ? `<style data-dw-responsive-styles>\n${css}\n</style>` : "";
  const previous = nodes.filter((node) => node.tag === "style" && attrNode(node, "data-dw-responsive-styles"));
  const edits = previous.map((node, index) => ({ start: node.start, end: node.end, text: index === 0 ? block : "" }));
  if (!previous.length && block) {
    const head = findTag(root, ["head"]);
    const body = findTag(root, ["body"]);
    const at = head?.innerEnd ?? body?.innerEnd ?? source.length;
    edits.push({ start: at, end: at, text: block });
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}
