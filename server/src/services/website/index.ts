/**
 * website-editor-core — the whole editable-website engine behind one door.
 *
 * Everything outside `services/website/` imports from here and from nowhere
 * else inside it. That is the only rule this file exists to enforce, and the
 * reason is that this module is now a **product** rather than one screen's
 * helper: a second site, a client's site, an AI proposing a change and an agent
 * publishing one all have to go through the same parse, the same sanitiser and
 * the same conflict check, or they are four editors that agree until the day
 * they do not.
 *
 * The surface is deliberately small and named after what a caller wants:
 *
 * | Function                | Answers                                            |
 * |-------------------------|----------------------------------------------------|
 * | `parse`                 | what is in this page, structurally                 |
 * | `discoverFields`        | what may be edited, grouped as a person sees it    |
 * | `validateFieldChange`   | would these values be publishable                  |
 * | `sanitizeValue`         | what is this value once it is safe to store        |
 * | `detectConflicts`       | has the page moved under this draft                |
 * | `applyValues`           | the page with the draft written into it            |
 * | `buildPreview`          | that page, safe to put in a frame                  |
 * | `buildPublishPlan`      | everything a publish needs decided, before it acts |
 *
 * Two of them are new here rather than moved. `sanitizeValue` and
 * `validateFieldChange` were written inline in `routes/website.ts`, which meant
 * every future caller — the AI layer, an agent tool, a second route — either
 * imported a route or wrote the rules again. `buildPublishPlan` is the publish
 * route's own body with the commit taken out of it, so that what a publish
 * *would* do can be shown to somebody before they authorise it.
 *
 * Nothing here touches the database, GitHub or the network. That is what makes
 * every one of these testable with a string and no credential, and
 * `checks/website.ts` runs them against every real page in this repository.
 */

import { decodeEntities, parseHtml } from "./parse.js";
import {
  applyValues,
  readPage,
  safeStyle,
  type ApplyResult,
  type FieldKind,
  type FieldValue,
  type PageContent,
  type SiteField,
  type SiteSection,
} from "./regions.js";
import { checkLink, sanitizePlain, sanitizeRich } from "./sanitize.js";
import { previewDocument, type PreviewDocument } from "./site.js";

/**
 * Bumped when the shape of a *stored* draft or version changes.
 *
 * Not a package version — there is no registry to publish to. It is what a
 * stored draft can be compared against when the field model changes underneath
 * it, which is the one migration this module cannot do by re-reading the page.
 */
export const EDITOR_CORE_VERSION = 1;

// --- The parts that were already here -------------------------------------

export { applyValues, readPage, safeStyle, checkLink, sanitizePlain, sanitizeRich };
export type { ApplyResult, FieldKind, FieldValue, PageContent, PreviewDocument, SiteField, SiteSection };

/** The document's structure. Rarely wanted directly — `discoverFields` is the usual way in. */
export const parse = parseHtml;

/** Every editable field on a page, grouped into the sections a person sees. */
export const discoverFields = readPage;

/** A page prepared for the editor's frame: based, re-policied, optionally clickable. */
export const buildPreview = previewDocument;

// --- Lifted out of routes/website.ts --------------------------------------

/**
 * One value, cleaned to what may be stored for its kind.
 *
 * Cleaning happens on the way **in** rather than on the way out, and the reason
 * is worth keeping: a draft is stored JSON that outlives the session that wrote
 * it and is spliced into a public page weeks later. Anything that could not be
 * published must never have been saved.
 *
 * Returns only the keys the caller actually supplied, and only where the value
 * differs from what the page already says — an edit identical to the page is
 * not an edit, and storing one leaves a page looking modified for ever.
 */
export function sanitizeValue(
  field: SiteField,
  raw: { value?: string; href?: string; alt?: string; style?: string },
): FieldValue {
  const next: FieldValue = {};

  if (raw.value !== undefined) {
    const cleaned =
      field.kind === "richtext" ? sanitizeRich(raw.value) : field.kind === "image" ? raw.value.trim() : sanitizePlain(raw.value);
    if (cleaned !== field.value) next.value = cleaned;
  }
  if (raw.href !== undefined && raw.href.trim() !== (field.href ?? "")) next.href = raw.href.trim();
  if (raw.alt !== undefined && raw.alt !== (field.alt ?? "")) next.alt = raw.alt;
  if (raw.style !== undefined && safeStyle(raw.style) !== (field.style ?? "")) next.style = safeStyle(raw.style);

  if (Object.keys(next).length === 0) return next;

  // What the page said when the edit was made. This is the whole reason a draft
  // can be trusted an hour later: ids are positional, so without it a month-old
  // edit would write itself into whatever now sits at that position.
  next.original = field.value;
  if (field.style !== undefined) next.originalStyle = field.style;
  if (field.href !== undefined) next.originalHref = field.href;
  if (field.alt !== undefined) next.originalAlt = field.alt;
  return next;
}

export type FieldProblem = { id: string; label: string; reason: string };

/**
 * Everything about a set of values that would stop them going live.
 *
 * Run on save so the editor can mark the field, and again on publish so a
 * problem saved before a rule existed cannot slip out. Blank required text and
 * a link pointing nowhere are the two that actually happen.
 */
export function validateFieldChange(fields: SiteField[], values: Record<string, FieldValue>): FieldProblem[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const problems: FieldProblem[] = [];

  for (const [id, edit] of Object.entries(values)) {
    const field = byId.get(id);
    if (!field) {
      problems.push({
        id,
        label: "A field that has moved",
        reason: "This edit no longer matches anything on the page. Discard it, or reopen the page.",
      });
      continue;
    }
    if (edit.value !== undefined && field.kind !== "image" && edit.value.replace(/<[^>]*>/g, "").trim() === "") {
      problems.push({
        id,
        label: field.label,
        reason: "This cannot be left empty — a heading or a button with no words disappears from the page.",
      });
    }
    if (edit.href !== undefined) {
      const checked = checkLink(edit.href);
      if (!checked.ok) problems.push({ id, label: field.label, reason: checked.reason });
    }
    if (edit.value !== undefined && field.kind === "image" && !edit.value.trim()) {
      problems.push({ id, label: field.label, reason: "An image needs a file to point at." });
    }
    // The plan's rule, and an accessibility one: a picture either describes
    // itself or is explicitly marked as decoration.
    if (field.kind === "image" && edit.alt !== undefined && edit.alt.trim() === "" && !field.decorative) {
      problems.push({ id, label: field.label, reason: "Describe the image, or mark it decorative if it carries no meaning." });
    }
  }
  return problems;
}

// --- New: asking without acting -------------------------------------------

export type ConflictReport = {
  conflicts: ApplyResult["conflicts"];
  missing: string[];
};

/**
 * Has the page moved under this draft?
 *
 * `applyValues` has always answered this, but only as a side effect of writing
 * the whole document — so anything that wanted the answer alone had to splice a
 * page it was going to throw away. The AI layer wants it before proposing, the
 * editor wants it while somebody is still typing, and a publish confirmation
 * wants it before it offers a button.
 */
export function detectConflicts(source: string, values: Record<string, FieldValue>): ConflictReport {
  const { conflicts, missing } = applyValues(source, values);
  return { conflicts, missing };
}

export type PublishPlan = {
  /** The page as it would be committed. Absent when the plan cannot proceed. */
  html: string | null;
  /** Ids that would actually be written. */
  changed: string[];
  conflicts: ApplyResult["conflicts"];
  missing: string[];
  problems: FieldProblem[];
  /**
   * Whether this plan can be committed as it stands. False for every reason a
   * publish refuses, which the caller then reports individually — the point of
   * a plan is that all of the reasons are known before any of them is acted on.
   */
  publishable: boolean;
};

/**
 * Everything a publish needs decided, decided — and nothing done.
 *
 * The order is the publish route's own and it is deliberate: validate, then
 * apply, then let the caller commit. Splitting it out this way is what lets a
 * confirmation screen show precisely what will happen, and what stops the AI
 * layer from ever needing its own copy of the rules.
 */
export function buildPublishPlan(input: { source: string; values: Record<string, FieldValue> }): PublishPlan {
  const content = readPage(input.source);
  const problems = validateFieldChange(content.fields, input.values);

  // A value that cannot be published is not spliced in even provisionally: the
  // preview a person approves has to be the page that would be committed.
  if (problems.length) {
    return { html: null, changed: [], conflicts: [], missing: [], problems, publishable: false };
  }

  const applied = applyValues(input.source, input.values);
  const blocked = applied.conflicts.length > 0 || applied.missing.length > 0 || applied.changed.length === 0;

  return {
    html: blocked ? null : applied.html,
    changed: applied.changed,
    conflicts: applied.conflicts,
    missing: applied.missing,
    problems,
    publishable: !blocked,
  };
}

// --- New: saying what changed, in words --------------------------------------

/** Which part of a field moved. A picture and its description are two changes. */
export type ChangedPart = "words" | "destination" | "picture" | "description" | "styling";

export type FieldChangeSummary = {
  id: string;
  /** The field's own label — "Main heading", "Button". */
  label: string;
  kind: FieldKind;
  part: ChangedPart;
  from: string;
  to: string;
};

/** What a set of changes touched, for the one-line version of the same story. */
export type ChangeCategories = {
  text: boolean;
  links: boolean;
  images: boolean;
  styles: boolean;
  /** The page title or its search-result description — the two that move a listing. */
  seo: boolean;
};

const MAX_SHOWN = 140;

/**
 * A stored value as a person reads it: no tags, no entities, no runs of space.
 *
 * Deliberately lossy. The point of a summary is that somebody can check it at a
 * glance before publishing, and `Build once` is checkable where
 * `Build <em>once</em>&nbsp;` is a thing they have to decode first.
 */
function readable(value: string): string {
  const plain = decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return plain.length > MAX_SHOWN ? `${plain.slice(0, MAX_SHOWN - 1)}…` : plain;
}

/** An empty value has to read as something, or a summary line loses half its meaning. */
function shown(value: string | undefined): string {
  const text = readable(value ?? "");
  return text || "(nothing)";
}

/**
 * Every change in a draft, rendered as `Main heading: 'Build once' → 'Built to
 * last'`.
 *
 * This is what the version list, the publish confirmation and the audit log all
 * show, and there is one implementation of it because those three disagreeing
 * about what a publish did would be worse than none of them saying anything.
 *
 * A draft stores the change *and what the page said when it was made*, so both
 * halves of every line come out of the draft itself — no second read of the
 * page, and a version row stays readable years later whether or not the page
 * still has that field.
 *
 * One field can produce several lines. Replacing a photograph and rewriting its
 * alt text are two decisions and somebody reviewing them should see two.
 */
export function describeChanges(fields: SiteField[], values: Record<string, FieldValue>): FieldChangeSummary[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const out: FieldChangeSummary[] = [];

  for (const [id, edit] of Object.entries(values)) {
    const field = byId.get(id);
    // A field the page no longer has still gets a line. This runs over versions
    // as well as over live drafts, and "we cannot show you what that publish did
    // because the page has moved on" is not an acceptable answer about a record.
    const label = field?.label ?? "A field that has since moved";
    const kind = field?.kind ?? "text";

    if (edit.value !== undefined) {
      out.push({
        id,
        label,
        kind,
        part: kind === "image" ? "picture" : "words",
        from: shown(edit.original),
        to: shown(edit.value),
      });
    }
    if (edit.href !== undefined) {
      out.push({ id, label, kind, part: "destination", from: shown(edit.originalHref), to: shown(edit.href) });
    }
    if (edit.alt !== undefined) {
      out.push({ id, label, kind, part: "description", from: shown(edit.originalAlt), to: shown(edit.alt) });
    }
    if (edit.style !== undefined) {
      out.push({ id, label, kind, part: "styling", from: shown(edit.originalStyle), to: shown(edit.style) });
    }
  }
  return out;
}

/**
 * The same story in five booleans, for the line above the detail.
 *
 * `seo` is keyed on the meta section's ids rather than on a field kind, because
 * the page title and the search-result description are ordinary text fields in
 * every respect except the one that matters to somebody deciding whether to
 * publish: changing them changes how the page appears in a search result.
 */
export function categoriseChanges(summaries: FieldChangeSummary[]): ChangeCategories {
  return {
    text: summaries.some((entry) => entry.part === "words"),
    links: summaries.some((entry) => entry.part === "destination"),
    images: summaries.some((entry) => entry.part === "picture" || entry.part === "description"),
    styles: summaries.some((entry) => entry.part === "styling"),
    seo: summaries.some((entry) => entry.id.startsWith("meta.")),
  };
}
