import { regenerateInteractionStyles } from "./interaction.js";
import { randomBytes } from "node:crypto";
import { describeChanges } from "./index.js";
import { attrNode, parseHtml, walk, type ElementNode } from "./parse.js";
import { applyValues, readPage, type FieldValue } from "./regions.js";
import { regenerateResponsiveStyles } from "./responsive.js";
import { DOCUMENT_KEY, boundedHistory, draftDocument, editingSource, fieldValues, sourceHash, type DraftDocument, type DocumentSnapshot } from "./document.js";

export type StructureAction = { kind: "remove" | "duplicate" | "before" | "after"; fieldId: string; targetId?: string } | { kind: "undo" | "redo" };
export type StructureControl = { remove: boolean; duplicate: boolean; previousId?: string; nextId?: string; group?: string; reason?: string; duplicateReason?: string };
export class StructureError extends Error { status = 409; }
const BLOCKED = new Set(["html", "head", "body", "script", "style", "form", "input", "select", "textarea", "iframe", "template", "canvas", "video", "audio", "object", "embed", "link", "meta"]);
const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const freshId = () => `node-${randomBytes(12).toString("hex")}`;
type Splice = { start: number; end: number; text: string };
function splice(source: string, edits: Splice[]): string {
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}
function structuralReason(node: ElementNode | undefined): string | undefined {
  if (!node || BLOCKED.has(node.tag) || !node.parent) return "This element is controlled by the page source.";
  for (let at: ElementNode | null = node.parent; at; at = at.parent) if (BLOCKED.has(at.tag) && !["body", "html"].includes(at.tag)) return "This element belongs to an interactive or source-controlled region.";
  if ([...walk(node)].some(child => BLOCKED.has(child.tag) || child.attrs.some(attr => /^on[a-z]/i.test(attr.name)))) return "This block contains interactive code or forms. Change its structure in the source editor.";
  if (!node.selfClosing && node.innerEnd === node.end) return "This element has no explicit closing tag. Fix its HTML before moving it.";
  return undefined;
}

export function structureControls(source: string): Record<string, StructureControl> {
  const fields = readPage(source).fields;
  const nodes = [...walk(parseHtml(source))];
  const at = new Map(nodes.map(node => [node.attrInsert, node]));
  const fieldAt = new Map(fields.filter(field => field.attrInsert !== undefined).map(field => [field.attrInsert!, field]));
  return Object.fromEntries(fields.map(field => {
    const node = field.attrInsert === undefined ? undefined : at.get(field.attrInsert);
    const reason = structuralReason(node);
    if (reason || !node) return [field.id, { remove: false, duplicate: false, reason }];
    const siblings = node.parent!.children.filter(child => fieldAt.has(child.attrInsert) && !structuralReason(child));
    const index = siblings.indexOf(node);
    const hasIds = node.tag === "main" || [...walk(node)].some(child => attrNode(child, "id"));
    return [field.id, { remove: true, duplicate: !hasIds, previousId: index > 0 ? fieldAt.get(siblings[index - 1]!.attrInsert)!.id : undefined, nextId: index < siblings.length - 1 ? fieldAt.get(siblings[index + 1]!.attrInsert)!.id : undefined, group: sourceHash(String(node.parent!.start)).slice(0, 16), duplicateReason: node.tag === "main" ? "A page should have one main region. Duplicate one of its inner sections instead." : hasIds ? "This block uses fixed HTML IDs. Duplicate an inner block without IDs to preserve selectors and links." : undefined } satisfies StructureControl];
  }));
}

/** Give existing fields persistent identities before any content changes or moves. */
function identifyFields(source: string): string {
  const nodes = new Map([...walk(parseHtml(source))].map(node => [node.attrInsert, node]));
  const edits: Splice[] = [];
  for (const field of readPage(source).fields) {
    if (field.attrInsert === undefined) continue;
    const node = nodes.get(field.attrInsert)!;
    const marker = attrNode(node, "data-dw-node");
    if (marker?.value === field.id) continue;
    if (marker) edits.push({ start: marker.start, end: marker.end, text: `data-dw-node="${escapeAttribute(field.id)}"` });
    else edits.push({ start: field.attrInsert, end: field.attrInsert, text: ` data-dw-node="${escapeAttribute(field.id)}"` });
  }
  return splice(source, edits);
}

function withoutAnchors(values: Record<string, FieldValue>): Record<string, FieldValue> {
  return Object.fromEntries(Object.entries(fieldValues(values)).map(([id, value]) => [id, { value: value.value, href: value.href, alt: value.alt, style: value.style, responsive: value.responsive, variant: value.variant, newTab: value.newTab }]));
}

export function changeStructure(source: string, values: Record<string, FieldValue>, action: StructureAction): { values: Record<string, FieldValue>; selectedId: string | null } {
  const previous = draftDocument(values);
  if (previous && previous.baseHash !== sourceHash(source)) throw new StructureError("The original page changed. Discard this layout draft before rearranging the latest source.");
  const current: DocumentSnapshot = { html: editingSource(source, values), values: fieldValues(values), changes: previous?.changes ?? [], summary: previous?.summary };
  if (!("fieldId" in action)) {
    const stack = previous?.[action.kind];
    const snapshot = stack?.at(-1);
    if (!snapshot || !previous) throw new StructureError(`There is no layout action to ${action.kind}.`);
    const document: DraftDocument = { ...previous, html: snapshot.html, changes: snapshot.changes, summary: snapshot.summary, [action.kind]: stack!.slice(0, -1), [action.kind === "undo" ? "redo" : "undo"]: boundedHistory([...(action.kind === "undo" ? previous.redo : previous.undo), current]) };
    return { values: { ...snapshot.values, [DOCUMENT_KEY]: { document } }, selectedId: null };
  }
  const checked = applyValues(source, values);
  if (checked.conflicts.length || checked.missing.length) throw new StructureError("Resolve the draft's source conflicts before changing its layout.");
  const identified = identifyFields(current.html);
  const rendered = applyValues(identified, withoutAnchors(values)).html;
  const controls = structureControls(rendered);
  const control = controls[action.fieldId];
  if (!control?.remove) throw new StructureError(control?.reason ?? "This element is no longer available.");
  if (action.kind === "duplicate" && !control.duplicate) throw new StructureError(control.duplicateReason!);
  const fields = readPage(rendered).fields;
  const nodes = new Map([...walk(parseHtml(rendered))].map(node => [node.attrInsert, node]));
  const field = fields.find(field => field.id === action.fieldId)!;
  const node = nodes.get(field.attrInsert!)!;
  const block = rendered.slice(node.start, node.end);
  let html: string;
  let selectedId: string | null = action.fieldId;
  if (action.kind === "remove") { html = splice(rendered, [{ start: node.start, end: node.end, text: "" }]); selectedId = field.parentId ?? null; }
  else if (action.kind === "duplicate") {
    const edits: Splice[] = [];
    const cloneId = freshId();
    for (const child of walk(node)) {
      for (const attr of child.attrs) {
        if (attr.name === "data-dw-node") edits.push({ start: attr.start - node.start, end: attr.end - node.start, text: `data-dw-node="${child === node ? cloneId : freshId()}"` });
        if (attr.name === "data-dw-field") edits.push({ start: attr.start - node.start, end: attr.end - node.start, text: "" });
        if (attr.name === "data-dw-style") edits.push({ start: attr.start - node.start, end: attr.end - node.start, text: `data-dw-style="dw-${randomBytes(12).toString("hex")}"` });
      }
    }
    html = splice(rendered, [{ start: node.end, end: node.end, text: `\n${splice(block, edits)}` }]); selectedId = cloneId;
  } else {
    const targetField = fields.find(field => field.id === action.targetId);
    const target = targetField?.attrInsert === undefined ? undefined : nodes.get(targetField.attrInsert);
    if (!target || target === node || target.parent !== node.parent || !controls[action.targetId!]?.remove) throw new StructureError("Move an element beside another editable element in the same parent container.");
    const position = action.kind === "before" ? target.start : target.end;
    html = splice(rendered, [{ start: node.start, end: node.end, text: "" }, { start: position, end: position, text: block }]);
  }
  html = regenerateResponsiveStyles(html);
  if (/--dw-(?:hover|focus)-|data-dw-interaction-styles/.test(html)) html = regenerateInteractionStyles(html);
  if (Buffer.byteLength(html) > 3 * 1024 * 1024) throw new StructureError("This page is too large to duplicate more content. Remove unused blocks first.");
  const verb = action.kind === "remove" ? "Removed" : action.kind === "duplicate" ? "Duplicated" : "Moved";
  const document: DraftDocument = { baseHash: previous?.baseHash ?? sourceHash(source), html, changes: [...current.changes, `${verb} ${field.label}`].slice(-100), summary: [...(current.summary ?? []), ...describeChanges(readPage(current.html).fields, current.values)], undo: boundedHistory([...(previous?.undo ?? []), current]), redo: [] };
  return { values: { [DOCUMENT_KEY]: { document } }, selectedId };
}
