import { attrNode, findTag, parseHtml, walk } from "./parse.js";
import { interactionCss } from "../../shared/websiteInteraction.js";

export function regenerateInteractionStyles(source: string): string {
  const root = parseHtml(source);
  const nodes = [...walk(root)];
  const used = nodes.some(node => /--dw-(?:hover|focus)-/.test(attrNode(node, "style")?.value ?? ""));
  const previous = nodes.filter(node => node.tag === "style" && attrNode(node, "data-dw-interaction-styles"));
  const block = used ? `<style data-dw-interaction-styles>\n${interactionCss()}\n</style>` : "";
  const edits = previous.map((node, index) => ({ start: node.start, end: node.end, text: index ? "" : block }));
  if (!previous.length && block) { const at = findTag(root, ["head"])?.innerEnd ?? findTag(root, ["body"])?.innerEnd ?? source.length; edits.push({ start: at, end: at, text: block }); }
  let html = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
  return html;
}
