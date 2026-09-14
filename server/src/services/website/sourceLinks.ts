/**
 * "Open in a new tab" for a link on a framework page.
 *
 * Appearance lives in `sourceStyle.ts`; this is behaviour, and it has one rule
 * the style side does not: `target="_blank"` is never written without
 * `rel="noopener noreferrer"`. A new tab opened without them hands the page it
 * came from to whatever it opened, and nobody choosing "open in a new tab" is
 * choosing that — so there is no path through here that produces one without
 * the other. The HTML engine says the same thing in `regions.ts`; this is that
 * rule, for source files.
 *
 * Turning it off removes the attributes rather than emptying them: `target=""`
 * is not "no target" to a browser. A `rel` holding only the two tokens we put
 * there is ours to take away; anything else on it is the developer's and stays.
 *
 * Only a native `<a>` is offered. A component decides for itself what `target`
 * means — some forward it, some ignore it, some render no anchor at all — and a
 * toggle that silently does nothing is worse than one that is not there.
 */
import ts from "typescript";
import { isMarkdownPath } from "./markdown.js";
import { isTemplatePath } from "./template.js";
import { JsxStructureError, jsxStructureNodes, OUTERMOST_REASON } from "./jsxStructure.js";
import { templateStructureNodes } from "./templateStructure.js";

export const SOURCE_LINK_VERSION = "source-link-target-v1" as const;
const NEW_TAB_REL = ["noopener", "noreferrer"] as const;

export type SourceLinkEdit = { nodeId: string; newTab: boolean };
export type SourceLinkState = { nodeId: string; label: string; newTab: boolean; reason?: string };
export type SourceLinkResult = { source: string; changed: string[]; summary: string[] };

type Splice = { start: number; end: number; text: string };
function splice(source: string, edits: Splice[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}
function withLeadingSpace(source: string, start: number): number {
  let at = start;
  while (at > 0 && /[ \t]/.test(source[at - 1]!)) at -= 1;
  return at;
}
/** The developer's own rel tokens, with ours taken out. */
function keptRel(rel: string | undefined): string[] {
  return (rel ?? "").split(/\s+/).map((token) => token.trim().toLowerCase()).filter(Boolean).filter((token) => !NEW_TAB_REL.includes(token as (typeof NEW_TAB_REL)[number]));
}
const blockedReason = (reason: string | undefined) => (reason === OUTERMOST_REASON ? undefined : reason);

/* ----------------------------------------------------------------- JSX ---- */

function jsxAnchors(source: string, filePath: string) {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, /\.tsx$/i.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
  const blocks = new Map(jsxStructureNodes(source, filePath).map((node) => [node.start, node]));
  const found: Array<{ opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement; block: ReturnType<typeof jsxStructureNodes>[number] }> = [];
  const walk = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const block = blocks.get(node.getStart(file));
      if (block) found.push({ opening: ts.isJsxElement(node) ? node.openingElement : node, block });
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return { file, found };
}
function jsxAttribute(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string, file: ts.SourceFile) {
  return opening.attributes.properties.find((candidate): candidate is ts.JsxAttribute => ts.isJsxAttribute(candidate) && candidate.name.getText(file) === name);
}
function jsxStringOf(attribute: ts.JsxAttribute | undefined): string | null | undefined {
  const initializer = attribute?.initializer;
  if (!attribute) return undefined;
  if (initializer && ts.isStringLiteral(initializer)) return initializer.text;
  if (initializer && ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteral(initializer.expression)) return initializer.expression.text;
  return null;
}

function jsxLinkState(source: string, filePath: string): SourceLinkState[] {
  const { file, found } = jsxAnchors(source, filePath);
  return found.flatMap(({ opening, block }) => {
    if (block.tag !== "a") return [];
    const base: SourceLinkState = { nodeId: block.id, label: block.label, newTab: false };
    const blocked = blockedReason(block.reason);
    if (blocked) return [{ ...base, reason: blocked }];
    if (opening.attributes.properties.some(ts.isJsxSpreadAttribute)) return [{ ...base, reason: "This link's props are spread from code, so where it opens is the code's." }];
    const target = jsxStringOf(jsxAttribute(opening, "target", file));
    const rel = jsxStringOf(jsxAttribute(opening, "rel", file));
    if (target === null || rel === null) return [{ ...base, reason: "This link's target comes from code; this editor can change only a plain value." }];
    return [{ ...base, newTab: target?.trim().toLowerCase() === "_blank" }];
  });
}

function applyJsxLinks(source: string, filePath: string, edits: readonly SourceLinkEdit[]): SourceLinkResult {
  const { file, found } = jsxAnchors(source, filePath);
  const state = new Map(jsxLinkState(source, filePath).map((entry) => [entry.nodeId, entry]));
  const byId = new Map(found.map((entry) => [entry.block.id, entry]));
  const splices: Splice[] = [];
  const changed: string[] = [];
  const summary: string[] = [];
  for (const edit of edits) {
    const target = byId.get(edit.nodeId);
    const current = state.get(edit.nodeId);
    if (!target || !current) throw new JsxStructureError("That link is no longer in this file. Reload it before changing where it opens.");
    if (current.reason) throw new JsxStructureError(current.reason);
    if (current.newTab === edit.newTab) continue;
    const targetAttribute = jsxAttribute(target.opening, "target", file);
    const relAttribute = jsxAttribute(target.opening, "rel", file);
    const insert = target.opening.tagName.end;
    if (edit.newTab) {
      const rel = [...keptRel(jsxStringOf(relAttribute) ?? ""), ...NEW_TAB_REL].join(" ");
      // Written as one splice when both are new, so they land in the order a
      // person would write them rather than in whichever order the splices ran.
      if (targetAttribute) splices.push({ start: targetAttribute.getStart(file), end: targetAttribute.end, text: 'target="_blank"' });
      if (relAttribute) splices.push({ start: relAttribute.getStart(file), end: relAttribute.end, text: `rel="${rel}"` });
      if (!targetAttribute || !relAttribute) splices.push({ start: insert, end: insert, text: `${targetAttribute ? "" : ' target="_blank"'}${relAttribute ? "" : ` rel="${rel}"`}` });
    } else {
      if (targetAttribute) splices.push({ start: withLeadingSpace(source, targetAttribute.getStart(file)), end: targetAttribute.end, text: "" });
      const rel = keptRel(jsxStringOf(relAttribute) ?? "");
      if (relAttribute) splices.push(rel.length ? { start: relAttribute.getStart(file), end: relAttribute.end, text: `rel="${rel.join(" ")}"` } : { start: withLeadingSpace(source, relAttribute.getStart(file)), end: relAttribute.end, text: "" });
    }
    changed.push(edit.nodeId);
    summary.push(edit.newTab ? `Set ${current.label} to open in a new tab` : `Set ${current.label} to open in the same tab`);
  }
  return { source: splice(source, splices), changed, summary };
}

/* ------------------------------------------------------------ templates --- */

function templateTag(source: string, start: number) {
  const name = /^<([A-Za-z][A-Za-z0-9.:_-]*)/.exec(source.slice(start, start + 200));
  if (!name) throw new JsxStructureError("That link could not be read. Reload the file first.");
  const insert = start + name[0].length;
  let index = insert;
  let quote: string | null = null;
  for (; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === ">") break;
  }
  if (index >= source.length) throw new JsxStructureError("That link's opening tag is never closed. Fix this file in the code editor.");
  const attributes: Array<{ name: string; value: string | null; start: number; end: number; quoted: boolean }> = [];
  const pattern = /([^\s=/>]+)(\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+))?/g;
  const slice = source.slice(insert, index);
  for (let match = pattern.exec(slice); match; match = pattern.exec(slice)) {
    attributes.push({
      name: match[1]!, value: match[4] ?? match[5] ?? (match[2] ? match[3]! : null),
      start: insert + match.index, end: insert + match.index + match[0].length,
      quoted: match[4] !== undefined || match[5] !== undefined,
    });
  }
  return { insert, attributes };
}

function templateLinkState(source: string, filePath: string): SourceLinkState[] {
  return templateStructureNodes(source, filePath).flatMap((block) => {
    if (block.tag.toLowerCase() !== "a") return [];
    const base: SourceLinkState = { nodeId: block.id, label: block.label, newTab: false };
    const blocked = blockedReason(block.reason);
    if (blocked) return [{ ...base, reason: blocked }];
    const { attributes } = templateTag(source, block.start);
    if (attributes.some((attribute) => /^(:target|v-bind:target|:rel|v-bind:rel)$/i.test(attribute.name))) return [{ ...base, reason: "This link's target is bound to code, so the code decides it." }];
    const target = attributes.find((attribute) => attribute.name.toLowerCase() === "target");
    if (target && (!target.quoted || (target.value ?? "").includes("{"))) return [{ ...base, reason: "This link's target comes from code; this editor can change only a plain value." }];
    return [{ ...base, newTab: (target?.value ?? "").trim().toLowerCase() === "_blank" }];
  });
}

function applyTemplateLinks(source: string, filePath: string, edits: readonly SourceLinkEdit[]): SourceLinkResult {
  const blocks = new Map(templateStructureNodes(source, filePath).map((block) => [block.id, block]));
  const state = new Map(templateLinkState(source, filePath).map((entry) => [entry.nodeId, entry]));
  const splices: Splice[] = [];
  const changed: string[] = [];
  const summary: string[] = [];
  for (const edit of edits) {
    const block = blocks.get(edit.nodeId);
    const current = state.get(edit.nodeId);
    if (!block || !current) throw new JsxStructureError("That link is no longer in this file. Reload it before changing where it opens.");
    if (current.reason) throw new JsxStructureError(current.reason);
    if (current.newTab === edit.newTab) continue;
    const { insert, attributes } = templateTag(source, block.start);
    const targetAttribute = attributes.find((attribute) => attribute.name.toLowerCase() === "target");
    const relAttribute = attributes.find((attribute) => attribute.name.toLowerCase() === "rel");
    if (edit.newTab) {
      const rel = [...keptRel(relAttribute?.value ?? ""), ...NEW_TAB_REL].join(" ");
      if (targetAttribute) splices.push({ start: targetAttribute.start, end: targetAttribute.end, text: 'target="_blank"' });
      if (relAttribute) splices.push({ start: relAttribute.start, end: relAttribute.end, text: `rel="${rel}"` });
      if (!targetAttribute || !relAttribute) splices.push({ start: insert, end: insert, text: `${targetAttribute ? "" : ' target="_blank"'}${relAttribute ? "" : ` rel="${rel}"`}` });
    } else {
      if (targetAttribute) splices.push({ start: withLeadingSpace(source, targetAttribute.start), end: targetAttribute.end, text: "" });
      const rel = keptRel(relAttribute?.value ?? "");
      if (relAttribute) splices.push(rel.length ? { start: relAttribute.start, end: relAttribute.end, text: `rel="${rel.join(" ")}"` } : { start: withLeadingSpace(source, relAttribute.start), end: relAttribute.end, text: "" });
    }
    changed.push(edit.nodeId);
    summary.push(edit.newTab ? `Set ${current.label} to open in a new tab` : `Set ${current.label} to open in the same tab`);
  }
  return { source: splice(source, splices), changed, summary };
}

/* ------------------------------------------------------------------ api --- */

/** Which links this file has, and where each one opens. */
export function sourceLinkState(source: string, filePath: string): SourceLinkState[] {
  if (isMarkdownPath(filePath)) return [];
  return isTemplatePath(filePath) ? templateLinkState(source, filePath) : jsxLinkState(source, filePath);
}

/** Apply new-tab changes to the links they name. Never partially applied. */
export function applySourceLinks(source: string, filePath: string, edits: readonly SourceLinkEdit[]): SourceLinkResult {
  if (!edits.length) return { source, changed: [], summary: [] };
  if (isMarkdownPath(filePath)) throw new JsxStructureError("A Markdown link's target is written in the link itself. Change it in the text.");
  return isTemplatePath(filePath) ? applyTemplateLinks(source, filePath, edits) : applyJsxLinks(source, filePath, edits);
}
