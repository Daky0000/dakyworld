/**
 * Reading and writing one attribute of a block, in either language.
 *
 * `sourceStyle.ts` and `sourceLinks.ts` each grew their own copy of "find the
 * opening tag, find this attribute, splice it" — which was tolerable at two and
 * is not at three. This is that job, once, with the block identities the layout
 * engines already issue so every editor here names a block the same way.
 *
 * It deals in plain quoted values only. A value the code computes — `{expr}`,
 * `:bound`, a spread — is reported, never rewritten, because the whole point of
 * this editor is that what it does not understand it leaves alone.
 */
import ts from "typescript";
import { isTemplatePath } from "./template.js";
import { JsxStructureError, jsxStructureNodes, OUTERMOST_REASON, type JsxStructureNode } from "./jsxStructure.js";
import { templateStructureNodes } from "./templateStructure.js";

/** One attribute as it sits in the file. `value` is null when it is dynamic. */
export type BlockAttribute = { name: string; value: string | null; start: number; end: number };
export type BlockTarget = {
  id: string;
  label: string;
  tag: string;
  /** Where a new attribute goes: just past the tag name. */
  insert: number;
  attributes: BlockAttribute[];
  spread: boolean;
  /** Why this block is not editable at all, from the layout engine. */
  reason?: string;
};
/** `null` removes the attribute; a string writes it. */
export type AttributeEdit = { nodeId: string; set: Record<string, string | null> };

/** A block's layout reason, minus the one that only forbids moving it. */
export function editableReason(block: JsxStructureNode): string | undefined {
  return block.reason === OUTERMOST_REASON ? undefined : block.reason;
}

function jsxSourceFile(source: string, filePath: string): ts.SourceFile {
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, /\.tsx$/i.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
}

function jsxBlocks(source: string, filePath: string): BlockTarget[] {
  const file = jsxSourceFile(source, filePath);
  const blocks = new Map(jsxStructureNodes(source, filePath).map((node) => [node.start, node]));
  const targets: BlockTarget[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const block = blocks.get(node.getStart(file));
      if (block) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const attributes: BlockAttribute[] = [];
        for (const attribute of opening.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          const initializer = attribute.initializer;
          const literal = !initializer ? ""
            : ts.isStringLiteral(initializer) ? initializer.text
            : ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteral(initializer.expression) ? initializer.expression.text
            : null;
          attributes.push({ name: attribute.name.getText(file), value: literal, start: attribute.getStart(file), end: attribute.end });
        }
        targets.push({
          id: block.id, label: block.label, tag: block.tag, insert: opening.tagName.end, attributes,
          spread: opening.attributes.properties.some(ts.isJsxSpreadAttribute),
          ...(editableReason(block) && { reason: editableReason(block) }),
        });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return targets;
}

/** The opening tag at this offset: where attributes begin, end, and what is in it. */
function templateTag(source: string, start: number): { insert: number; attributes: BlockAttribute[] } {
  const name = /^<([A-Za-z][A-Za-z0-9.:_-]*)/.exec(source.slice(start, start + 200));
  if (!name) throw new JsxStructureError("That block could not be read. Reload the file first.");
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
  const attributes: BlockAttribute[] = [];
  const pattern = /([^\s=/>]+)(\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+))?/g;
  const slice = source.slice(insert, index);
  for (let match = pattern.exec(slice); match; match = pattern.exec(slice)) {
    const quoted = match[4] !== undefined || match[5] !== undefined;
    const raw = match[4] ?? match[5] ?? (match[2] ? match[3]! : "");
    const name = match[1]!;
    // An unquoted or brace-carrying value is the template language's, not a
    // literal, and is reported as dynamic rather than parsed further. The
    // editor's own annotations are the exception: they hold JSON, whose braces
    // are data rather than a Svelte expression or a Vue mustache.
    const ours = name.toLowerCase().startsWith("data-dw-");
    attributes.push({
      name,
      value: match[2] && (!quoted || (raw.includes("{") && !ours)) ? null : raw,
      start: insert + match.index, end: insert + match.index + match[0].length,
    });
  }
  return { insert, attributes };
}

function templateBlocks(source: string, filePath: string): BlockTarget[] {
  return templateStructureNodes(source, filePath).map((block) => {
    const reason = editableReason(block);
    if (reason) return { id: block.id, label: block.label, tag: block.tag, insert: block.start, attributes: [], spread: false, reason };
    const { insert, attributes } = templateTag(source, block.start);
    return { id: block.id, label: block.label, tag: block.tag, insert, attributes, spread: attributes.some((attribute) => attribute.name.startsWith("v-bind=") || attribute.name === "{...props}") };
  });
}

/** Every block of this file, with its attributes and where they sit. */
export function readBlocks(source: string, filePath: string): BlockTarget[] {
  return isTemplatePath(filePath) ? templateBlocks(source, filePath) : jsxBlocks(source, filePath);
}

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A JSX attribute value: single-quoted where the value carries double quotes,
 * which is what JSON in an attribute always does. */
function jsxAttributeText(name: string, value: string): string {
  return value.includes('"') ? `${name}='${escapeAttribute(value).replace(/'/g, "&#39;")}'` : `${name}="${escapeAttribute(value)}"`;
}

type Splice = { start: number; end: number; text: string };
function withLeadingSpace(source: string, start: number): number {
  let at = start;
  while (at > 0 && /[ \t]/.test(source[at - 1]!)) at -= 1;
  return at;
}

/**
 * Write and remove attributes on blocks, in one pass over one file.
 *
 * Additions to the same tag are merged into a single insertion, so two new
 * attributes land in the order they were asked for rather than in whichever
 * order the splices happened to run.
 */
export function writeAttributes(source: string, filePath: string, edits: readonly AttributeEdit[]): string {
  if (!edits.length) return source;
  const blocks = new Map(readBlocks(source, filePath).map((block) => [block.id, block]));
  const splices: Splice[] = [];
  for (const edit of edits) {
    const block = blocks.get(edit.nodeId);
    if (!block) throw new JsxStructureError("That block is no longer in this file. Reload it before editing.");
    if (block.reason) throw new JsxStructureError(block.reason);
    const additions: string[] = [];
    for (const [name, value] of Object.entries(edit.set)) {
      const existing = block.attributes.find((attribute) => attribute.name.toLowerCase() === name.toLowerCase());
      if (existing && existing.value === null) throw new JsxStructureError(`${block.label} sets ${name} from code, so this editor cannot change it.`);
      if (value === null) {
        if (existing) splices.push({ start: withLeadingSpace(source, existing.start), end: existing.end, text: "" });
        continue;
      }
      const text = jsxAttributeText(name, value);
      if (existing) splices.push({ start: existing.start, end: existing.end, text });
      else additions.push(text);
    }
    if (additions.length) splices.push({ start: block.insert, end: block.insert, text: ` ${additions.join(" ")}` });
  }
  let result = source;
  for (const splice of splices.sort((a, b) => b.start - a.start)) result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  return result;
}
