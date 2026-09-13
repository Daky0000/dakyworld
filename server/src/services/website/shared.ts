/**
 * Shared elements — one logical component, many pages.
 *
 * A header, a call to action, a newsletter strip: the same thing on eight
 * pages, which until now was eight independent copies that a client had to edit
 * eight times and could get wrong in seven of them. This module is the part of
 * that feature with no database and no network in it — what counts as the same
 * element across pages, what the editable slots inside one are, and how a change
 * written once lands on each page's own field ids.
 *
 * Three rules run through it.
 *
 * **Identity is decided by structure, never by resemblance.** Two elements are
 * the same shared thing when the developer said so (`data-dw-shared`), or when
 * their whole subtree — tags, classes, link destinations, and for the strongest
 * grade their words too — matches after page-specific state is normalised away.
 * "Looks similar" groups a services card with a pricing card and then writes one
 * client's price into the other.
 *
 * **A slot is a position, and a position is checked before it is written.** A
 * shared edit is stored against the instance's own shape — "the second editable
 * thing inside this element" — and applying it to a page checks that the thing
 * in that position is still the same kind of thing. A page whose CTA gained a
 * paragraph does not silently receive a heading into its new one; it is reported
 * as out of shape and nothing is written to it at all.
 *
 * **Nothing here decides to write.** Every function answers a question. The
 * routes decide, and the publish path refuses on anything this reports.
 */

import { attr, parseHtml, walk, type ElementNode } from "./parse.js";
import { readPage, type FieldKind, type FieldValue, type SiteField } from "./regions.js";

/** The attribute a developer uses to say "this is the site header, everywhere". */
export const SHARED_ATTRIBUTE = "data-dw-shared";
/** And to name one editable thing inside it, so a slot survives a redesign. */
export const SHARED_FIELD_ATTRIBUTE = "data-dw-shared-field";

/**
 * Classes and attributes that differ between two copies of the same component
 * because of which page it is on, and mean nothing about whether it is the same
 * component. `aria-current="page"` on a nav link is the whole reason this list
 * exists.
 */
const PAGE_STATE_CLASSES = /^(?:is-)?(?:active|current|selected|open|here)$/i;

/**
 * Regions that are the page rather than a component in it.
 *
 * `<main>` on eight pages has the same structure on eight pages, and offering
 * to make somebody's whole content area one shared block is offering to
 * overwrite seven pages with the eighth. An explicit annotation still wins —
 * a developer who writes `data-dw-shared` on a `<main>` meant it.
 */
const PAGE_REGIONS = new Set(["main", "body", "html", "article"]);

/** One editable thing inside a shared element, by its place in it. */
export type SharedSlot = {
  /** `self` for the element itself, then `0`, `1`, … in document order. */
  key: string;
  kind: FieldKind;
  tag: string;
  label: string;
  /** A name the developer gave the slot, when they gave it one. */
  name?: string;
};

export type SharedInstanceShape = {
  rootFieldId: string;
  slots: SharedSlot[];
};

function fieldsOf(html: string): SiteField[] {
  return readPage(html).fields;
}

/** Every field inside `rootFieldId`, itself first, then descendants in order. */
function instanceFields(fields: SiteField[], rootFieldId: string): SiteField[] {
  const root = fields.find((field) => field.id === rootFieldId);
  if (!root) return [];
  const byParent = new Map<string, SiteField[]>();
  for (const field of fields) {
    if (!field.parentId) continue;
    const siblings = byParent.get(field.parentId) ?? [];
    siblings.push(field);
    byParent.set(field.parentId, siblings);
  }
  const out: SiteField[] = [root];
  const queue = [root];
  const seen = new Set([root.id]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of byParent.get(current.id) ?? []) {
      // A cycle can only come from a malformed tree, and one is not worth
      // hanging the request over.
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child);
    }
  }
  return out.sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

/**
 * What is editable inside one instance, in the order somebody reads it.
 *
 * Returns null when the root is not a field on this page at all, which is what
 * a caller needs to distinguish "this instance has drifted" from "this instance
 * is empty".
 */
export function instanceShape(html: string, rootFieldId: string): SharedInstanceShape | null {
  const fields = fieldsOf(html);
  const members = instanceFields(fields, rootFieldId);
  if (!members.length) return null;
  const named = sharedFieldNames(html);
  const slots: SharedSlot[] = [];
  let index = 0;
  for (const field of members) {
    const key = field.id === rootFieldId ? "self" : String(index++);
    slots.push({
      key,
      kind: field.kind,
      tag: field.tag,
      label: field.label,
      ...(named.get(field.id) ? { name: named.get(field.id)! } : {}),
    });
  }
  return { rootFieldId, slots };
}

/** `data-dw-shared-field="main-cta.button"` on an element that is also a field. */
function sharedFieldNames(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const index = elementIndex(html);
  for (const field of fieldsOf(html)) {
    const element = elementForField(index, field);
    const name = element ? attr(element, SHARED_FIELD_ATTRIBUTE) : undefined;
    if (name) out.set(field.id, name);
  }
  return out;
}

/** The page's own field id for each slot, or nothing when the shape has drifted. */
export function slotFieldIds(html: string, rootFieldId: string, slots: SharedSlot[]): { byKey: Map<string, string>; mismatched: string[] } {
  const shape = instanceShape(html, rootFieldId);
  const byKey = new Map<string, string>();
  const mismatched: string[] = [];
  if (!shape) return { byKey, mismatched: slots.map((slot) => slot.key) };

  const fields = fieldsOf(html);
  const members = instanceFields(fields, rootFieldId);
  const here = new Map(shape.slots.map((slot, position) => [slot.key, { slot, field: members[position]! }]));

  for (const slot of slots) {
    // A developer-given name beats a position: it is the whole point of the
    // annotation, and it survives a block being moved inside the component.
    const named = slot.name ? shape.slots.find((candidate) => candidate.name === slot.name) : undefined;
    const found = named ? here.get(named.key) : here.get(slot.key);
    if (!found || found.slot.kind !== slot.kind || found.slot.tag !== slot.tag) {
      mismatched.push(slot.key);
      continue;
    }
    byKey.set(slot.key, found.field.id);
  }
  return { byKey, mismatched };
}

/** The slot an edit on this page belongs to, so one change becomes the shared one. */
export function slotForField(html: string, rootFieldId: string, fieldId: string): string | null {
  const shape = instanceShape(html, rootFieldId);
  if (!shape) return null;
  const members = instanceFields(fieldsOf(html), rootFieldId);
  const position = members.findIndex((field) => field.id === fieldId);
  if (position < 0) return null;
  return shape.slots[position]?.key ?? null;
}

/**
 * A shared draft, written onto one page.
 *
 * The values come back keyed by *this page's* field ids, ready to be merged
 * under the page's own draft. `mismatched` is not a warning to log: a caller
 * publishing must refuse on it, because a slot that could not be placed is a
 * change somebody reviewed and this page did not receive.
 */
export function resolveSharedValues(input: {
  html: string;
  rootFieldId: string;
  slots: SharedSlot[];
  values: Record<string, FieldValue>;
}): { values: Record<string, FieldValue>; mismatched: string[] } {
  const { byKey, mismatched } = slotFieldIds(input.html, input.rootFieldId, input.slots);
  const values: Record<string, FieldValue> = {};
  const unplaced = new Set(mismatched);
  for (const [key, edit] of Object.entries(input.values)) {
    const fieldId = byKey.get(key);
    if (!fieldId) {
      unplaced.add(key);
      continue;
    }
    values[fieldId] = edit;
  }
  return { values, mismatched: [...unplaced] };
}

/**
 * What an instance is worth keeping when it stops being linked.
 *
 * Detaching must not change the page. So the local draft takes over exactly
 * what the shared element was giving it, keyed by this page's own field ids,
 * and from then on the two diverge because nothing joins them any more.
 */
export function detachSnapshot(input: {
  html: string;
  rootFieldId: string;
  slots: SharedSlot[];
  values: Record<string, FieldValue>;
}): Record<string, FieldValue> {
  return resolveSharedValues(input).values;
}

/* ------------------------------------------------------------ fingerprints */

function classesOf(element: ElementNode): string[] {
  return (attr(element, "class") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((name) => !PAGE_STATE_CLASSES.test(name))
    .sort();
}

/**
 * The element a field came from.
 *
 * Not by `data-dw-field`: most sites have never been annotated, and their field
 * ids are positional. What every field does carry is `attrInsert` — the offset
 * just past its own tag name — and that is one arithmetic step from where the
 * element starts, so the two are matched on it. Built once per page rather than
 * walked per field, because detection compares every block on every page.
 */
function elementIndex(html: string): Map<number, ElementNode> {
  const index = new Map<number, ElementNode>();
  for (const element of walk(parseHtml(html))) {
    index.set(element.start + 1 + element.tag.length, element);
  }
  return index;
}

function elementForField(index: Map<number, ElementNode>, field: SiteField): ElementNode | null {
  return field.attrInsert === undefined ? null : index.get(field.attrInsert) ?? null;
}

function elementAt(html: string, fieldId: string): ElementNode | null {
  const field = fieldsOf(html).find((candidate) => candidate.id === fieldId);
  if (!field) return null;
  return elementForField(elementIndex(html), field);
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The shape of a subtree, as one string.
 *
 * Tags, classes and nesting, with page state normalised out. Depth-capped
 * because a fingerprint of a whole page body is a fingerprint of nothing, and
 * because a runaway nesting depth in somebody's imported HTML should cost a
 * comparison rather than a stack.
 */
function structureOf(element: ElementNode, depth = 0): string {
  const classes = classesOf(element);
  const head = classes.length ? `${element.tag}.${classes.join(".")}` : element.tag;
  if (depth >= 6) return `${head}(…)`;
  const children = element.children.map((child) => structureOf(child, depth + 1));
  return children.length ? `${head}[${children.join(",")}]` : head;
}

/** The same, with the words and the link destinations in it. */
function contentOf(html: string, element: ElementNode, depth = 0): string {
  const head = structureOf(element, 6);
  const href = attr(element, "href") ?? attr(element, "src") ?? "";
  const text = element.children.length === 0 ? normalise(html.slice(element.innerStart, element.innerEnd)) : "";
  const own = `${head}${href ? `@${normalise(href)}` : ""}${text ? `#${text}` : ""}`;
  if (depth >= 6) return own;
  const children = element.children.map((child) => contentOf(html, child, depth + 1));
  return children.length ? `${own}{${children.join("|")}}` : own;
}

export type ElementFingerprint = { structure: string; content: string };

export function elementFingerprint(html: string, fieldId: string): ElementFingerprint | null {
  const element = elementAt(html, fieldId);
  if (!element) return null;
  return { structure: structureOf(element), content: contentOf(html, element) };
}

/* -------------------------------------------------------------- detection */

export type SharedConfidence = "high" | "medium";

export type SharedCandidate = {
  /** `data-dw-shared`'s value where there is one; otherwise a slug of the name. */
  key: string;
  name: string;
  confidence: SharedConfidence;
  /** Why it was grouped, in the words the editor puts in front of somebody. */
  reason: string;
  instances: Array<{ pageId: string; fieldId: string }>;
};

const slug = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shared";

/** Enough to keep two same-named candidates apart, and short enough to read. */
function shortHash(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36).slice(0, 6);
}

/**
 * What looks like the same component on more than one page.
 *
 * Three grades and only two of them are returned. An explicit annotation or an
 * exact subtree match including the words is **high**; the same structure with
 * different words is **medium** and is offered as a question, never applied.
 * Anything else is low and is not grouped at all — the spec's own rule, and the
 * reason this returns candidates rather than creating anything.
 */
export function sharedCandidates(pages: Array<{ pageId: string; title: string; html: string }>): SharedCandidate[] {
  type Seen = { pageId: string; fieldId: string; label: string; annotation?: string; structure: string; content: string; parentIds: Set<string> };
  const seen: Seen[] = [];

  for (const page of pages) {
    const fields = fieldsOf(page.html);
    const byId = new Map(fields.map((field) => [field.id, field]));
    const index = elementIndex(page.html);
    for (const field of fields) {
      // Only whole blocks. A single heading repeated on eight pages is a
      // coincidence of wording; a section repeated on eight pages is a
      // component. An annotated element is taken at its word either way.
      const element = elementForField(index, field);
      if (!element) continue;
      const annotation = attr(element, SHARED_ATTRIBUTE);
      if (!annotation && (field.kind !== "container" || PAGE_REGIONS.has(field.tag.toLowerCase()))) continue;
      const fingerprint = { structure: structureOf(element), content: contentOf(page.html, element) };
      const parentIds = new Set<string>();
      let walker = field.parentId;
      while (walker) {
        parentIds.add(walker);
        walker = byId.get(walker)?.parentId;
      }
      seen.push({ pageId: page.pageId, fieldId: field.id, label: field.label, annotation, structure: fingerprint.structure, content: fingerprint.content, parentIds });
    }
  }

  const groups = new Map<string, { members: Seen[]; confidence: SharedConfidence; annotated: boolean }>();
  const add = (key: string, member: Seen, confidence: SharedConfidence, annotated: boolean) => {
    const group = groups.get(key) ?? { members: [], confidence, annotated };
    group.members.push(member);
    // An exact match anywhere in the group does not raise the others; the
    // grade is the weakest evidence holding it together.
    if (confidence === "medium") group.confidence = "medium";
    group.annotated = group.annotated || annotated;
    groups.set(key, group);
  };

  // Which pages each fingerprint appears on, worked out once.
  //
  // This was a `seen.some(...)` inside the loop below, which is every block on
  // the site compared against every other block on the site — and the thing
  // being compared is a fingerprint string of a whole subtree, so each
  // comparison is long as well as numerous. On the fixtures it was instant. On
  // two copies of one real news page, 1068 elements, it took over eight
  // minutes, which is not a slow feature but a broken one: the request would
  // never come back. Grouping first makes the same decision in one pass.
  const pagesByContent = new Map<string, Set<string>>();
  for (const member of seen) {
    if (member.annotation) continue;
    const pages = pagesByContent.get(member.content) ?? new Set<string>();
    pages.add(member.pageId);
    pagesByContent.set(member.content, pages);
  }

  for (const member of seen) {
    if (member.annotation) add(`annotation:${member.annotation}`, member, "high", true);
    // The same words on a *different* page. Two copies on one page are a
    // repetition within it, not a component shared between pages.
    else if ((pagesByContent.get(member.content)?.size ?? 0) > 1) add(`content:${member.content}`, member, "high", false);
    else add(`structure:${member.structure}`, member, "medium", false);
  }

  const candidates: SharedCandidate[] = [];
  for (const [key, group] of groups) {
    const pagesInGroup = new Set(group.members.map((member) => member.pageId));
    if (pagesInGroup.size < 2) continue;
    // One instance per page: the outermost. A header and the nav inside it both
    // repeat, and offering both as separate shared elements is offering to
    // manage the same markup twice.
    const perPage = new Map<string, Seen>();
    for (const member of group.members) {
      const held = perPage.get(member.pageId);
      if (!held || held.parentIds.has(member.fieldId)) perPage.set(member.pageId, member);
    }
    const instances = [...perPage.values()];
    const name = group.annotated ? instances[0]!.annotation! : instances[0]!.label;
    candidates.push({
      key: group.annotated ? instances[0]!.annotation! : `${slug(name)}-${shortHash(key)}`,
      name,
      confidence: group.confidence,
      reason: group.annotated
        ? "The page's own HTML marks this as a shared element."
        : group.confidence === "high"
          ? `The same block, word for word, on ${instances.length} pages.`
          : `The same structure on ${instances.length} pages, with different words.`,
      instances: instances.map((member) => ({ pageId: member.pageId, fieldId: member.fieldId })),
    });
  }

  // Drop a candidate whose instances all sit inside another candidate's, so the
  // outermost repeated region is the one offered.
  //
  // Each page's parents are worked out once. This used to re-read the
  // whole page on every question, and it is asked one per candidate pair per
  // instance — on a real page that is tens of thousands of full parses, which
  // is where eight of the nine minutes this used to take actually went.
  const parentsByPage = new Map<string, Map<string, string | undefined>>();
  const parentsOf = (pageId: string) => {
    const held = parentsByPage.get(pageId);
    if (held) return held;
    const page = pages.find((candidate) => candidate.pageId === pageId);
    const map = new Map<string, string | undefined>();
    if (page) for (const field of fieldsOf(page.html)) map.set(field.id, field.parentId);
    parentsByPage.set(pageId, map);
    return map;
  };
  const descends = (pageId: string, fieldId: string, ancestorId: string) => {
    const parents = parentsOf(pageId);
    let walker = parents.get(fieldId);
    while (walker) {
      if (walker === ancestorId) return true;
      walker = parents.get(walker);
    }
    return false;
  };

  const inside = (child: SharedCandidate, parent: SharedCandidate) =>
    child !== parent &&
    child.instances.every((instance) =>
      parent.instances.some((other) => other.pageId === instance.pageId && other.fieldId !== instance.fieldId && descends(instance.pageId, instance.fieldId, other.fieldId)),
    );

  return candidates
    .filter((candidate) => !candidates.some((other) => inside(candidate, other)))
    .sort((left, right) => right.instances.length - left.instances.length || left.name.localeCompare(right.name));
}
