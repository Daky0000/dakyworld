/**
 * Styling a block of a framework page — the source half of the HTML editor's
 * style controls.
 *
 * It writes the same thing the HTML engine writes, for the same reason: an
 * inline style on the element somebody selected. A rule added to the project's
 * stylesheet would apply to every page at once and to elements nobody was
 * editing, which is not what "make this heading bigger" means. The declarations
 * go through `safeStyle`, the sanitiser the HTML editor already uses, so both
 * halves of the product allow exactly the same CSS.
 *
 * Two languages, one idea, spelled differently:
 *
 *  - a template (`.astro`, `.vue`, `.svelte`) takes `style="font-size: 20px"`,
 *    which is HTML and needs no translation;
 *  - JSX takes `style={{ fontSize: "20px" }}`, because React reads an object.
 *    The property names are converted, and only string literals are written or
 *    read back — a value assembled in code is somebody's logic.
 *
 * What it refuses, rather than guessing:
 *
 *  - `:style`, `v-bind:style`, `style={styles.hero}`, a spread — the style is
 *    computed, and overwriting it would delete the computation.
 *  - a block the layout engine will not touch either: code-placed, blocked, or
 *    inside a form. If its shape is the code's, so is its appearance.
 *  - Markdown, which has no elements to style at all.
 *
 * Nothing here executes a project. TypeScript parses JSX; the template side
 * scans. Both splice at offsets they found themselves.
 */
import ts from "typescript";
import { isMarkdownPath } from "./markdown.js";
import { isTemplatePath } from "./template.js";
import { safeStyle } from "./regions.js";
import { checkedJsxPath, jsxCompilerOptions } from "./jsx.js";
import { JsxStructureError, jsxStructureNodes, OUTERMOST_REASON } from "./jsxStructure.js";
import { templateStructureNodes } from "./templateStructure.js";

export const SOURCE_STYLE_VERSION = "source-inline-style-v1" as const;
const MAX_DECLARATIONS = 4_000;

export type SourceStyleEdit = { nodeId: string; style: string };
export type SourceStyleResult = { source: string; changed: string[]; summary: string[] };

/** Which blocks can be styled, and the current declarations on each. */
export type SourceStyleState = { nodeId: string; label: string; style: string; reason?: string };

/**
 * Why this block cannot be styled — which is not the same list as why it cannot
 * be moved. The outermost block a page returns has nowhere to move to, and that
 * says nothing about whether its background may be changed.
 */
function styleReason(reason: string | undefined): string | undefined {
  return reason === OUTERMOST_REASON ? undefined : reason;
}

const camel = (property: string) => property.replace(/^-+/, "").replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase());
const kebab = (name: string) => name.replace(/([A-Z])/g, (letter) => `-${letter.toLowerCase()}`);

/** `font-size: 20px; color: red` → the JSX object literal React expects. */
function declarationsToObject(style: string): string {
  const entries = style.split(";").map((part) => part.trim()).filter(Boolean).map((declaration) => {
    const colon = declaration.indexOf(":");
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    // A custom property keeps its exact name and so has to stay quoted.
    const key = property.startsWith("--") ? JSON.stringify(property) : camel(property);
    return `${key}: ${JSON.stringify(value)}`;
  });
  return `{{ ${entries.join(", ")} }}`;
}

/** The reverse, for showing somebody what is already on the element. */
function objectToDeclarations(node: ts.ObjectLiteralExpression, file: ts.SourceFile): string | null {
  const parts: string[] = [];
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) return null;
    const name = ts.isIdentifier(property.name) ? property.name.text : ts.isStringLiteral(property.name) ? property.name.text : null;
    if (name === null) return null;
    const value = property.initializer;
    if (ts.isStringLiteral(value)) parts.push(`${name.startsWith("--") ? name : kebab(name)}: ${value.text}`);
    else if (ts.isNumericLiteral(value)) parts.push(`${name.startsWith("--") ? name : kebab(name)}: ${value.text}px`);
    else return null;
  }
  return parts.join("; ");
}

function checkStyle(style: string, original: string): string {
  if (style.length > MAX_DECLARATIONS) throw new JsxStructureError("That is more styling than one element can carry. Remove some of it.");
  const safe = safeStyle(style, original);
  if (style.trim() && !safe.trim()) throw new JsxStructureError("None of those style declarations are allowed here. Use the editor's controls, or change this in the code.");
  return safe;
}

type Splice = { start: number; end: number; text: string };
function splice(source: string, edits: Splice[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/** Removing an attribute takes the whitespace that introduced it, so clearing a
 * style leaves `<section>` rather than `<section >`. */
function withLeadingSpace(source: string, start: number): number {
  let at = start;
  while (at > 0 && /[ 	]/.test(source[at - 1]!)) at -= 1;
  return at;
}

function jsxFile(source: string, filePath: string): ts.SourceFile {
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, /\.tsx$/i.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
}

/**
 * Find each styleable JSX element, paired with the block ID the layout engine
 * gave it, so the browser has one identity for "this block" across both.
 *
 * The pairing is by source offset rather than by walking the tree twice: the
 * layout engine already recorded where every block starts, and an offset is the
 * one thing two parsers of the same file cannot disagree about.
 */
function jsxTargets(source: string, filePath: string) {
  const file = jsxFile(source, filePath);
  const blocks = new Map(jsxStructureNodes(source, filePath).map((node) => [node.start, node]));
  const found: Array<{ node: ts.JsxElement | ts.JsxSelfClosingElement; block: ReturnType<typeof jsxStructureNodes>[number] }> = [];
  const walk = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const block = blocks.get(node.getStart(file));
      if (block) found.push({ node, block });
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return { file, found };
}

function jsxStyleAttribute(node: ts.JsxElement | ts.JsxSelfClosingElement, file: ts.SourceFile) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const attributes = opening.attributes.properties;
  const spread = attributes.some(ts.isJsxSpreadAttribute);
  const attribute = attributes.find((candidate): candidate is ts.JsxAttribute => ts.isJsxAttribute(candidate) && candidate.name.getText(file) === "style");
  return { opening, spread, attribute };
}

function jsxStyleState(source: string, filePath: string): SourceStyleState[] {
  const { file, found } = jsxTargets(source, filePath);
  return found.map(({ node, block }) => {
    const base: SourceStyleState = { nodeId: block.id, label: block.label, style: "" };
    const blocked = styleReason(block.reason);
    const { spread, attribute } = jsxStyleAttribute(node, file);
    const initializer = attribute?.initializer;
    const object = initializer && ts.isJsxExpression(initializer) && initializer.expression && ts.isObjectLiteralExpression(initializer.expression) ? initializer.expression : null;
    // Read first, then judge: somebody refused permission to restyle a block
    // still deserves to be shown what it is wearing.
    const declarations = attribute ? (object ? objectToDeclarations(object, file) : null) : "";
    const reason = blocked
      ?? (spread ? "This element's props are spread from code, so its style is the code's." : undefined)
      ?? (declarations === null ? "This element's style comes from code, not from a plain list of declarations." : undefined);
    return { ...base, style: declarations ?? "", ...(reason && { reason }) };
  });
}

function applyJsxStyles(source: string, filePath: string, edits: readonly SourceStyleEdit[]): SourceStyleResult {
  const { file, found } = jsxTargets(source, filePath);
  const state = new Map(jsxStyleState(source, filePath).map((entry) => [entry.nodeId, entry]));
  const byId = new Map(found.map((entry) => [entry.block.id, entry]));
  const splices: Splice[] = [];
  const changed: string[] = [];
  const summary: string[] = [];
  for (const edit of edits) {
    const target = byId.get(edit.nodeId);
    const current = state.get(edit.nodeId);
    if (!target || !current) throw new JsxStructureError("That block is no longer in this file. Reload it before restyling.");
    if (current.reason) throw new JsxStructureError(current.reason);
    const safe = checkStyle(edit.style, current.style);
    if (safe === current.style) continue;
    const { opening, attribute } = jsxStyleAttribute(target.node, file);
    if (!safe) {
      // No declarations left: the attribute goes, rather than being left as an
      // empty object that reads like a deliberate "no style".
      if (attribute) splices.push({ start: withLeadingSpace(source, attribute.getStart(file)), end: attribute.end, text: "" });
    } else if (attribute) {
      splices.push({ start: attribute.getStart(file), end: attribute.end, text: `style=${declarationsToObject(safe)}` });
    } else {
      const insert = opening.tagName.end;
      splices.push({ start: insert, end: insert, text: ` style=${declarationsToObject(safe)}` });
    }
    changed.push(edit.nodeId);
    summary.push(`Restyled ${current.label}`);
  }
  return { source: splice(source, splices), changed, summary };
}

/** `<tag …>`: where its attributes begin and end, and the style it carries. */
function templateOpening(source: string, start: number): { insert: number; end: number } {
  const name = /^<([A-Za-z][A-Za-z0-9.:_-]*)/.exec(source.slice(start, start + 200));
  if (!name) throw new JsxStructureError("That block could not be read. Reload the file before restyling.");
  const insert = start + name[0].length;
  let index = insert;
  let quote: string | null = null;
  for (; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === ">") break;
  }
  if (index >= source.length) throw new JsxStructureError("That block's opening tag is never closed. Fix this file in the code editor.");
  return { insert, end: index };
}

/** The attributes of one opening tag, with the offsets of each whole attribute. */
function templateAttributes(source: string, from: number, to: number) {
  const attributes: Array<{ name: string; value: string | null; start: number; end: number; quoted: boolean }> = [];
  const pattern = /([^\s=/>]+)(\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+))?/g;
  pattern.lastIndex = 0;
  const slice = source.slice(from, to);
  for (let match = pattern.exec(slice); match; match = pattern.exec(slice)) {
    const quoted = Boolean(match[4] !== undefined || match[5] !== undefined);
    attributes.push({
      name: match[1]!, value: match[4] ?? match[5] ?? (match[2] ? match[3]! : null),
      start: from + match.index, end: from + match.index + match[0].length, quoted,
    });
  }
  return attributes;
}

function templateStyleState(source: string, filePath: string): SourceStyleState[] {
  return templateStructureNodes(source, filePath).map((block) => {
    const base: SourceStyleState = { nodeId: block.id, label: block.label, style: "" };
    const blocked = styleReason(block.reason);
    if (blocked) return { ...base, reason: blocked };
    const opening = templateOpening(source, block.start);
    const attributes = templateAttributes(source, opening.insert, opening.end);
    const bound = attributes.find((attribute) => /^(:style|v-bind:style|style:|\[style\])/i.test(attribute.name));
    if (bound) return { ...base, reason: "This element's style is bound to code, so the code decides it." };
    const attribute = attributes.find((candidate) => candidate.name.toLowerCase() === "style");
    if (!attribute) return base;
    if (!attribute.quoted || attribute.value === null) return { ...base, reason: "This element's style has no plain quoted value to edit." };
    if (attribute.value.includes("{") || attribute.value.includes("}")) return { ...base, reason: "This element's style contains an expression, so it stays with the code." };
    return { ...base, style: attribute.value.trim().replace(/;\s*$/, "") };
  });
}

function applyTemplateStyles(source: string, filePath: string, edits: readonly SourceStyleEdit[]): SourceStyleResult {
  const blocks = new Map(templateStructureNodes(source, filePath).map((block) => [block.id, block]));
  const state = new Map(templateStyleState(source, filePath).map((entry) => [entry.nodeId, entry]));
  const splices: Splice[] = [];
  const changed: string[] = [];
  const summary: string[] = [];
  for (const edit of edits) {
    const block = blocks.get(edit.nodeId);
    const current = state.get(edit.nodeId);
    if (!block || !current) throw new JsxStructureError("That block is no longer in this file. Reload it before restyling.");
    if (current.reason) throw new JsxStructureError(current.reason);
    const safe = checkStyle(edit.style, current.style);
    if (safe === current.style) continue;
    const opening = templateOpening(source, block.start);
    const attribute = templateAttributes(source, opening.insert, opening.end).find((candidate) => candidate.name.toLowerCase() === "style");
    if (!safe) {
      if (attribute) splices.push({ start: withLeadingSpace(source, attribute.start), end: attribute.end, text: "" });
    } else if (attribute) {
      splices.push({ start: attribute.start, end: attribute.end, text: `style="${safe.replace(/"/g, "&quot;")}"` });
    } else {
      splices.push({ start: opening.insert, end: opening.insert, text: ` style="${safe.replace(/"/g, "&quot;")}"` });
    }
    changed.push(edit.nodeId);
    summary.push(`Restyled ${current.label}`);
  }
  return { source: splice(source, splices), changed, summary };
}

/** Whether this language can be styled at all, and what each block carries. */
export function sourceStyleState(source: string, filePath: string): SourceStyleState[] {
  if (isMarkdownPath(filePath)) return [];
  if (isTemplatePath(filePath)) return templateStyleState(source, filePath);
  checkedJsxPath(filePath);
  // Parsed once here so a syntax error is one refusal rather than a surprise
  // halfway through a list of blocks.
  const syntax = ts.transpileModule(source, { compilerOptions: { ...jsxCompilerOptions(), jsx: ts.JsxEmit.Preserve }, fileName: filePath, reportDiagnostics: true });
  if ((syntax.diagnostics ?? []).some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) throw new JsxStructureError("This source file has a syntax error. Fix it in the code editor before restyling it.");
  return jsxStyleState(source, filePath);
}

/** Apply style edits to the blocks they name. Never partially applied. */
export function applySourceStyles(source: string, filePath: string, edits: readonly SourceStyleEdit[]): SourceStyleResult {
  if (!edits.length) return { source, changed: [], summary: [] };
  if (isMarkdownPath(filePath)) throw new JsxStructureError("A Markdown page has no elements to style. Its appearance comes from the site's theme.");
  return isTemplatePath(filePath) ? applyTemplateStyles(source, filePath, edits) : applyJsxStyles(source, filePath, edits);
}
