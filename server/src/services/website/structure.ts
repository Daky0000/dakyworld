import { regenerateInteractionStyles } from "./interaction.js";
import { USES_INTERACTION_CSS } from "../../shared/websiteInteraction.js";
import { randomBytes } from "node:crypto";
import { describeChanges } from "./index.js";
import { attrNode, parseHtml, walk, type ElementNode } from "./parse.js";
import { applyValues, isLinkWrapper, readPage, type FieldValue } from "./regions.js";
import { regenerateResponsiveStyles } from "./responsive.js";
import { WebsiteError } from "./site.js";
import { DOCUMENT_KEY, boundedHistory, draftDocument, editingSource, fieldValues, sourceHash, type DraftDocument, type DocumentSnapshot } from "./document.js";
import { BOOLEAN_ATTRIBUTES, MAX_ATTRIBUTE_CHANGES, TAG_LABEL, attributeProblem, mediaKind, tagOptions, type ElementSettingsChange } from "../../shared/websiteElementSettings.js";

export type StructureAction =
  | { kind: "remove" | "duplicate" | "before" | "after"; fieldId: string; targetId?: string; force?: boolean }
  | { kind: "settings"; fieldId: string; settings: ElementSettingsChange }
  | { kind: "undo" | "redo" };
/**
 * What may be done to one element's place on the page.
 *
 * `remove` keeps the meaning everything else was built on — this block may be
 * taken away without asking — which is what the assistant and the agent read
 * before proposing a deletion. The two flags beside it are what a person gets
 * on top: `move` for a block that can be lifted and put down beside a sibling,
 * and `forceRemove` for one that can be deleted once they have said yes to
 * `removeWarning`. `reason` is set only where nothing at all is offered.
 */
export type StructureControl = { remove: boolean; duplicate: boolean; move?: boolean; repeatable?: boolean; previousId?: string; nextId?: string; group?: string; reason?: string; duplicateReason?: string; forceRemove?: boolean; removeWarning?: string };
/** A refusal written for the person, so the error handler passes its sentence through rather than "Something went wrong." */
export class StructureError extends WebsiteError { constructor(message: string) { super(409, message); this.name = "StructureError"; } }
/** Without these there is no page left: the only elements that can never be moved or deleted. */
const SKELETON = new Set(["html", "head", "body"]);
/** Elements that are a form, an embed, a player or code — what a person is asked about before one is deleted. */
const INTERACTIVE = new Set(["script", "style", "form", "input", "select", "textarea", "iframe", "template", "canvas", "video", "audio", "object", "embed", "link", "meta"]);
/**
 * What ends an element whose closing tag was left off, for the tags HTML lets
 * an author leave off. The reader in `parse.ts` does not apply these — it nests
 * the next `<li>` inside the open one — so a removal that trusted `node.end`
 * would take every later item in the list with it.
 */
const P_CLOSERS = ["address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul"];
const IMPLIED_END: Record<string, ReadonlySet<string>> = {
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  p: new Set(P_CLOSERS),
  option: new Set(["option", "optgroup"]),
  optgroup: new Set(["optgroup"]),
  tr: new Set(["tr", "tbody", "tfoot", "thead"]),
  td: new Set(["td", "th", "tr", "tbody", "tfoot", "thead"]),
  th: new Set(["td", "th", "tr", "tbody", "tfoot", "thead"]),
  thead: new Set(["tbody", "tfoot", "thead"]),
  tbody: new Set(["tbody", "tfoot", "thead"]),
  tfoot: new Set(["tbody", "tfoot", "thead"]),
};
const unclosed = (node: ElementNode) => !node.selfClosing && node.innerEnd === node.end;
/** Where a removal of this element stops: its own end, or the sibling that closes it when it was never closed. */
function removalEnd(node: ElementNode): number {
  if (!unclosed(node)) return node.end;
  const closers = IMPLIED_END[node.tag];
  return (closers && node.children.find(child => closers.has(child.tag))?.start) ?? node.end;
}
const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const freshId = () => `node-${randomBytes(12).toString("hex")}`;
type Splice = { start: number; end: number; text: string };
// Backwards, so earlier offsets stay valid. Where a removal and an insertion
// start at the same offset — taking away the first attribute while adding
// another just past the tag name — the removal goes first; the other way round
// it would cut into the text just inserted.
function splice(source: string, edits: Splice[]): string {
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}
const WHAT_IT_IS: Record<string, string> = {
  form: "a form", input: "a form field", select: "a form field", textarea: "a form field",
  iframe: "an embedded frame, such as a map or a video from another site", object: "an embed", embed: "an embed",
  video: "a video player", audio: "an audio player", canvas: "a canvas that a script draws on",
  script: "a script", style: "a stylesheet", link: "a link to a file the page loads", meta: "page information", template: "a template that a script fills in",
};
const WHAT_IT_SITS_IN: Record<string, string> = {
  form: "a form", select: "a menu in a form", template: "a template that a script fills in",
  video: "a video player", audio: "an audio player", object: "an embed", iframe: "an embedded frame", canvas: "a canvas",
};
/** The interactive things inside a block, named the way somebody who is not a developer would. */
function heldInside(node: ElementNode): string[] {
  const tags = new Set<string>();
  let handlers = false;
  for (const child of walk(node)) {
    if (INTERACTIVE.has(child.tag)) tags.add(child.tag);
    if (child.attrs.some(attr => /^on[a-z]/i.test(attr.name))) handlers = true;
  }
  const has = (...names: string[]) => names.some(name => tags.has(name));
  const parts: string[] = [];
  if (has("form")) parts.push("a form");
  else if (has("input", "select", "textarea")) parts.push("form fields");
  if (has("iframe", "object", "embed")) parts.push("an embed");
  if (has("video")) parts.push("a video");
  if (has("audio")) parts.push("an audio player");
  if (has("canvas")) parts.push("a canvas");
  if (has("script", "template") || handlers) parts.push("scripts");
  if (has("style", "link")) parts.push("styles of its own");
  if (!parts.length && tags.size) parts.push("page code");
  return parts;
}
const listed = (parts: string[]) => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/**
 * Where one element stands.
 *
 * Almost nothing is locked: only the page's own skeleton and a field with no
 * element of its own. Everything else can be deleted, and the two softer
 * answers say what a person has to be told first —
 *
 *  - `warning`: deleting it takes a form, an embed or code with it. Deleting
 *    is their decision, so it is asked rather than refused;
 *  - `fixed`: its closing tag is missing, so its bytes cannot be lifted and
 *    put down somewhere else. It can still be deleted, where it ends being
 *    worked out by `removalEnd`.
 *
 * It used to be one sentence that refused all three alike, which read to the
 * person editing as a page they were not allowed to change: a contact section
 * could not be moved or removed because it held the contact form.
 */
type Standing = { locked?: string; warning?: string; fixed?: string; interactive?: boolean };
function standingOf(node: ElementNode | undefined): Standing {
  if (!node) return { locked: "This part of the page has no element of its own to move or delete." };
  if (SKELETON.has(node.tag) || !node.parent) return { locked: "This is the page itself. The blocks inside it can be moved and deleted; the page cannot." };
  for (let at: ElementNode | null = node.parent; at; at = at.parent) if (at.tag === "head") return { locked: "This belongs to the page's settings rather than to what a visitor sees." };
  if (unclosed(node)) {
    return {
      fixed: "This element has no closing tag in the page's HTML, so it cannot be moved or copied. It can still be deleted.",
      warning: "This element has no closing tag in the page's HTML, so the editor has to work out where it ends. Look at the page after deleting it.",
    };
  }
  if (INTERACTIVE.has(node.tag)) return { interactive: true, warning: `This is ${WHAT_IT_IS[node.tag] ?? "part of the page's code"}. Deleting it removes it for every visitor, and anything on the site that relies on it will stop working.` };
  for (let at: ElementNode | null = node.parent; at; at = at.parent) {
    if (INTERACTIVE.has(at.tag)) return { interactive: true, warning: `This is part of ${WHAT_IT_SITS_IN[at.tag] ?? "the page's code"}. Deleting it may stop that working the way it was built.` };
  }
  const held = heldInside(node);
  if (held.length) return { interactive: true, warning: `This block holds ${listed(held)}. Deleting the block deletes everything inside it, so anything on the site that depends on that may stop working.` };
  return {};
}

export function structureControls(source: string): Record<string, StructureControl> {
  const fields = readPage(source).fields;
  const nodes = [...walk(parseHtml(source))];
  const at = new Map(nodes.map(node => [node.attrInsert, node]));
  const fieldAt = new Map(fields.filter(field => field.attrInsert !== undefined).map(field => [field.attrInsert!, field]));
  // Asked once per element: every block asks about each of its siblings, and
  // the answer walks the whole subtree.
  const known = new Map<ElementNode, Standing>();
  const standing = (node: ElementNode) => known.get(node) ?? known.set(node, standingOf(node)).get(node)!;
  const movable = (node: ElementNode) => { const state = standing(node); return !state.locked && !state.fixed; };
  return Object.fromEntries(fields.map(field => {
    const node = field.attrInsert === undefined ? undefined : at.get(field.attrInsert);
    const state = node ? standing(node) : standingOf(undefined);
    if (!node || state.locked) return [field.id, { remove: false, duplicate: false, reason: state.locked } satisfies StructureControl];
    if (state.fixed) return [field.id, { remove: false, duplicate: false, reason: state.fixed, forceRemove: true, removeWarning: state.warning } satisfies StructureControl];
    const siblings = node.parent!.children.filter(child => fieldAt.has(child.attrInsert) && movable(child));
    const index = siblings.indexOf(node);
    const isRepeatable = Boolean(attrNode(node, "data-dw-repeatable") || (node.parent && attrNode(node.parent, "data-dw-repeatable")));
    const hasIds = node.tag === "main" || (!isRepeatable && [...walk(node)].some(child => attrNode(child, "id")));
    const place = { move: true, repeatable: isRepeatable, previousId: index > 0 ? fieldAt.get(siblings[index - 1]!.attrInsert)!.id : undefined, nextId: index < siblings.length - 1 ? fieldAt.get(siblings[index + 1]!.attrInsert)!.id : undefined, group: sourceHash(String(node.parent!.start)).slice(0, 16) };
    // A copy is the one thing still held back here: a second form posts twice,
    // a second script runs twice, and neither is what "duplicate" means to the
    // person pressing it.
    if (state.interactive) return [field.id, { remove: false, duplicate: false, forceRemove: true, removeWarning: state.warning, duplicateReason: "A copy of this block would repeat its form, embed or scripts. It can be moved and deleted here; make a second one in the page's code.", ...place } satisfies StructureControl];
    return [field.id, { remove: true, duplicate: !hasIds, ...place, duplicateReason: node.tag === "main" ? "A page should have one main region. Duplicate one of its inner sections instead." : hasIds ? "This block uses fixed HTML IDs. Duplicate an inner block without IDs to preserve selectors and links." : undefined } satisfies StructureControl];
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

// Icons are written into the document like every other pending value. Leaving
// them out used to drop an unpublished icon change whenever anything on the
// page was moved, duplicated or removed, because the values are folded into the
// document and only the document is kept.
function withoutAnchors(values: Record<string, FieldValue>): Record<string, FieldValue> {
  return Object.fromEntries(Object.entries(fieldValues(values)).map(([id, value]) => [id, { value: value.value, href: value.href, alt: value.alt, style: value.style, responsive: value.responsive, variant: value.variant, newTab: value.newTab, icon: value.icon, iconPosition: value.iconPosition }]));
}

/** Elements whose markup is never the panel's to change, wherever they sit. */
const SETTINGS_BLOCKED = new Set(["html", "head", "body", "script", "style", "template", "link", "meta", "base", "title", "noscript"]);

/** Why this element's tag and attributes cannot be changed here, or nothing when they can. */
export function settingsReason(node: ElementNode | undefined): string | undefined {
  if (!node) return "This part of the page has no element of its own to change.";
  if (SETTINGS_BLOCKED.has(node.tag)) return "This part of the page belongs to its code.";
  for (let at = node.parent; at; at = at.parent) if (["head", "svg", "template"].includes(at.tag)) return "This part of the page belongs to its code.";
  return undefined;
}

/** A whole attribute's span, with the whitespace before it, so taking it away leaves no gap. */
function attributeSpan(source: string, attr: { start: number; end: number }): { start: number; end: number } {
  let start = attr.start;
  while (start > 0 && /\s/.test(source[start - 1]!)) start -= 1;
  return { start, end: attr.end };
}

/**
 * The General tab's Settings, written into the document: a new tag from the
 * element's own family, and attribute writes from the shared allowlist.
 *
 * Everything is checked again here — the tag against `tagOptions`, every
 * attribute against `attributeProblem` — because the request is the only thing
 * this function can see, and a draft that would be refused at publish must
 * never be stored. Each refusal is a sentence the person can act on.
 *
 * A tag change renames both ends and nothing between them. It runs through the
 * structure path rather than the field values because the field ids are
 * positional: turning a `<div>` into a `<section>` can make it a section of its
 * own and renumber every field after it. `identifyFields` has already pinned
 * each one to its element by the time this runs.
 */
export function applyElementSettings(
  html: string,
  label: string,
  kind: string,
  node: ElementNode,
  allNodes: Iterable<ElementNode>,
  settings: ElementSettingsChange,
): { html: string; line: string } {
  const reason = settingsReason(node);
  if (reason) throw new StructureError(reason);
  const edits: Splice[] = [];
  const said: string[] = [];

  if (settings.tag !== undefined) {
    const wanted = settings.tag.trim().toLowerCase();
    if (wanted !== node.tag) {
      if (!tagOptions(kind, node.tag).includes(wanted)) {
        throw new StructureError(`This ${TAG_LABEL[node.tag] ?? `<${node.tag}>`} can't be turned into ${TAG_LABEL[wanted] ? `a ${TAG_LABEL[wanted]}` : `<${wanted}>`}. Its tag can only change within its own family.`);
      }
      const closing = node.innerEnd + 2;
      if (node.selfClosing || html.slice(node.innerEnd, closing) !== "</" || html.slice(closing, closing + node.tag.length).toLowerCase() !== node.tag) {
        throw new StructureError("This element has no closing tag in the page's HTML, so its tag can't be changed safely. Fix its HTML first.");
      }
      edits.push({ start: node.start + 1, end: node.attrInsert, text: wanted });
      edits.push({ start: closing, end: closing + node.tag.length, text: wanted });
      said.push(`tag changed to <${wanted}>`);
    }
  }

  const changes = Object.entries(settings.attributes ?? {}).map(([name, value]) => [name.trim().toLowerCase(), value] as const);
  if (changes.length > MAX_ATTRIBUTE_CHANGES) throw new StructureError(`Change at most ${MAX_ATTRIBUTE_CHANGES} attributes at a time.`);
  if (new Set(changes.map(([name]) => name)).size !== changes.length) throw new StructureError("Each attribute can be set once.");
  const media = mediaKind(node.tag);
  const touched: string[] = [];
  // New attributes on one element go in as one insertion, in the order they
  // were asked for, so the diff reads the way the panel listed them.
  const inserts = new Map<number, string>();
  for (const [name, value] of changes) {
    const problem = attributeProblem(name, value, node.tag);
    if (problem) throw new StructureError(`${name}: ${problem}`);
    if (name === "id" && value !== null) {
      for (const other of allNodes) {
        if (other !== node && attrNode(other, "id")?.value === value) {
          throw new StructureError(`Another element on this page already has the ID “${value}”. An ID has to be unique.`);
        }
      }
    }
    // A player's address can sit on one <source> inside it rather than on the
    // element. More than one means a file per browser, which is the developer's
    // decision and is left to them.
    let target = node;
    if (media && name === "src" && !attrNode(node, "src")) {
      const sources = node.children.filter((child) => child.tag === "source");
      if (sources.length > 1) throw new StructureError(`This ${media} lists ${sources.length} files for different browsers. Change them in the page's code.`);
      if (sources.length === 1) target = sources[0]!;
    }
    const present = target.attrs.filter((attr) => attr.name === name);
    const now = present[0]?.value;
    const wanted = value;
    if (wanted === null ? !present.length : now !== undefined && decodeAttr(now) === wanted && present.length === 1) continue;
    const written = wanted === null ? "" : BOOLEAN_ATTRIBUTES.has(name) && wanted === "" ? name : `${name}="${escapeAttribute(wanted)}"`;
    // Duplicates are malformed HTML; the first is rewritten and the rest go.
    present.slice(wanted === null ? 0 : 1).forEach((attr) => edits.push({ ...attributeSpan(html, attr), text: "" }));
    if (wanted !== null) {
      if (present[0]) edits.push({ start: present[0].start, end: present[0].end, text: written });
      else inserts.set(target.attrInsert, `${inserts.get(target.attrInsert) ?? ""} ${written}`);
    }
    touched.push(name);
  }
  for (const [at, text] of inserts) edits.push({ start: at, end: at, text });
  if (touched.includes("id")) {
    const id = changes.find(([name]) => name === "id")![1];
    said.push(id === null ? "ID removed" : `ID set to “${id}”`);
  }
  const others = touched.filter((name) => name !== "id");
  if (others.length) said.push(`${media && others.every((name) => [...BOOLEAN_ATTRIBUTES, "src", "poster", "preload", "controlslist"].includes(name)) ? `${media} settings` : "attributes"} changed (${others.join(", ")})`);
  if (!edits.length) throw new StructureError("Nothing about this element would change.");
  return { html: splice(html, edits), line: `Changed ${label}: ${said.join("; ")}` };
}

/** An attribute value as the page means it, for comparing with what was asked for. */
const decodeAttr = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

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
  // Settings change one element in place, so they answer to their own rule
  // rather than to the one that decides whether a block may move or go.
  if (action.kind !== "settings") {
    if (!control) throw new StructureError("This element is no longer available.");
    if (action.kind === "remove") {
      if (!control.remove && !control.forceRemove) throw new StructureError(control.reason ?? "This element cannot be deleted.");
      // Deleting something interactive is a decision, and the request has to
      // carry it. A screen that never asked — or an assistant — is answered
      // with what the deletion would take with it rather than with a deletion.
      if (!control.remove && action.force !== true) throw new StructureError(control.removeWarning ?? "Confirm that this element should be deleted.");
    } else if (action.kind === "duplicate") {
      if (!control.duplicate) throw new StructureError(control.duplicateReason ?? control.reason ?? "This element cannot be duplicated.");
    } else if (!control.move) throw new StructureError(control.reason ?? "This element cannot be moved.");
  }
  const fields = readPage(rendered).fields;
  const nodes = new Map([...walk(parseHtml(rendered))].map(node => [node.attrInsert, node]));
  const field = fields.find(field => field.id === action.fieldId);
  const node = field?.attrInsert === undefined ? undefined : nodes.get(field.attrInsert);
  if (!field || !node) throw new StructureError("This element is no longer available.");
  const block = rendered.slice(node.start, node.end);
  let html: string;
  let selectedId: string | null = action.fieldId;
  let line: string | undefined;
  if (action.kind === "settings") { ({ html, line } = applyElementSettings(rendered, field.label, field.kind, node, nodes.values(), action.settings)); }
  else if (action.kind === "remove") {
    // A link the editor wrapped around this element goes with it. Left behind,
    // it is an empty link on the published page: nothing to see, and still a
    // stop for a keyboard and a screen reader.
    const wrapper = isLinkWrapper(node.parent) && node.parent!.children.length === 1 ? node.parent! : null;
    html = splice(rendered, [wrapper ? { start: wrapper.start, end: wrapper.end, text: "" } : { start: node.start, end: removalEnd(node), text: "" }]);
    selectedId = field.parentId ?? null;
  }
  else if (action.kind === "duplicate") {
    const edits: Splice[] = [];
    const cloneId = freshId();
    for (const child of walk(node)) {
      for (const attr of child.attrs) {
        if (attr.name === "data-dw-node") edits.push({ start: attr.start - node.start, end: attr.end - node.start, text: `data-dw-node="${child === node ? cloneId : freshId()}"` });
        if (attr.name === "data-dw-field") edits.push({ start: attr.start - node.start, end: attr.end - node.start, text: "" });
        if (attr.name === "data-dw-style") edits.push({ start: attr.start - node.start, end: attr.end - node.start, text: `data-dw-style="dw-${randomBytes(12).toString("hex")}"` });
        if (attr.name === "id") edits.push({ start: attr.start - node.start, end: attr.end - node.start, text: `id="${attr.value}-${randomBytes(4).toString("hex")}"` });
      }
    }
    html = splice(rendered, [{ start: node.end, end: node.end, text: `\n${splice(block, edits)}` }]); selectedId = cloneId;
  } else {
    const targetField = fields.find(field => field.id === action.targetId);
    const target = targetField?.attrInsert === undefined ? undefined : nodes.get(targetField.attrInsert);
    if (!target || target === node || target.parent !== node.parent || !controls[action.targetId!]?.move) throw new StructureError("Move an element beside another editable element in the same parent container.");
    const position = action.kind === "before" ? target.start : target.end;
    html = splice(rendered, [{ start: node.start, end: node.end, text: "" }, { start: position, end: position, text: block }]);
  }
  html = regenerateResponsiveStyles(html);
  if (USES_INTERACTION_CSS.test(html) || html.includes("data-dw-interaction-styles")) html = regenerateInteractionStyles(html);
  // Only growth is refused. A page already over the ceiling must still be able
  // to lose a block or rearrange one, or the advice in the message cannot be followed.
  if (Buffer.byteLength(html) > 3 * 1024 * 1024 && Buffer.byteLength(html) > Buffer.byteLength(current.html)) throw new StructureError("This page is too large to duplicate more content. Remove unused blocks first.");
  const verb = action.kind === "remove" ? "Removed" : action.kind === "duplicate" ? "Duplicated" : "Moved";
  const document: DraftDocument = { baseHash: previous?.baseHash ?? sourceHash(source), html, changes: [...current.changes, line ?? `${verb} ${field.label}`].slice(-100), summary: [...(current.summary ?? []), ...describeChanges(readPage(current.html).fields, current.values)], undo: boundedHistory([...(previous?.undo ?? []), current]), redo: [] };
  return { values: { [DOCUMENT_KEY]: { document } }, selectedId };
}
