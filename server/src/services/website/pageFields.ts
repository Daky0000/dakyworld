/**
 * A framework page's fields, gathered from every file they actually live in.
 *
 * `jsx.ts` reads one file and writes one file, which is the right shape for the
 * source editor — somebody opened `Hero.tsx` and is editing `Hero.tsx`. It is
 * the wrong shape for the visual editor, where somebody opened *a page*: the
 * heading they clicked is in a component, the six cards below it are an array
 * in a data file, and the footer is in a layout. One file was never going to
 * hold them.
 *
 * So this is the page-shaped layer over the file-shaped one:
 *
 *  - **discover** every field in every file of the page's manifest, at once;
 *  - **map** all of them against the rendered HTML *together*, because that is
 *    the only way a collision between two files is visible. Two components that
 *    both say "Get started" are ambiguous, and a mapper shown one file at a time
 *    would confidently map each of them;
 *  - **apply** an edit set by splitting it per file, writing each file
 *    atomically against its own hash, and refusing the whole set if any file
 *    refuses its part.
 *
 * The all-or-nothing rule is the same one `jsx.ts` keeps, raised a level: a
 * publish that wrote the heading into `Hero.tsx` and then found the price in
 * `plans.ts` had moved would leave the customer's site saying two different
 * things, and reporting success.
 *
 * Only the JSX family comes through here. An `.astro` or `.vue` page keeps the
 * single-file path it already had, because a manifest is built by parsing
 * JavaScript imports and those files are not JavaScript.
 */
import { createHash } from "node:crypto";
import { decodeEntities } from "./parse.js";
import { readPage } from "./regions.js";
import type { SiteField } from "./regions.js";
import {
  applyJsxValues,
  discoverJsxFields,
  mapJsxFieldsToHtml,
  type JsxApplyResult,
  type JsxChange,
  type JsxEditProblem,
  type JsxField,
  type JsxIssue,
  type HtmlFieldEdit,
  type UnmappableEdit,
} from "./jsx.js";
import type { ManifestRole, SourceManifest } from "./manifest.js";

export const PAGE_FIELDS_VERSION = "page-fields-v1" as const;

/** How many files' worth of fields one page may offer before it stops. The
 * per-file ceiling in `jsx.ts` is 5,000; a page reaching a hundred files should
 * not be allowed to multiply that out. */
const MAX_PAGE_FIELDS = 20_000;

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

/** A field, plus which file of the page it came from and what that file is. */
export type PageField = JsxField & {
  filePath: string;
  role: ManifestRole;
  /** True when the field's file is rendered in more than one place on this
   * page, so an edit to it is an edit to every one of them. The editor says so
   * before it writes — see `scope` on the capability report. */
  shared: boolean;
};

export type PageFieldIssue = JsxIssue & { filePath: string };

export type PageDiscovery = {
  version: typeof PAGE_FIELDS_VERSION;
  entry: string;
  manifestHash: string;
  fields: PageField[];
  issues: PageFieldIssue[];
  /** Which files were read, and the hash each was read at. A write is checked
   * against these, per file. */
  sources: Array<{ filePath: string; sourceHash: string; role: ManifestRole }>;
  truncated: boolean;
};

type Reader = (path: string) => Promise<string | null>;

/**
 * How many times a file is rendered on this page.
 *
 * Counted over the manifest's import edges rather than guessed: a component
 * imported by the route and by a layout appears twice, and an edit to a literal
 * inside it changes both. Saying so before the write is the whole difference
 * between "you changed the heading" and "you changed every heading".
 */
function importCounts(manifest: SourceManifest): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of manifest.files) for (const target of file.imports) counts.set(target, (counts.get(target) ?? 0) + 1);
  return counts;
}

/** Every editable field on the page, across every file of its manifest. */
export async function discoverPageFields(input: { manifest: SourceManifest; read: Reader }): Promise<PageDiscovery> {
  const counts = importCounts(input.manifest);
  const fields: PageField[] = [];
  const issues: PageFieldIssue[] = [];
  const sources: PageDiscovery["sources"] = [];
  let truncated = input.manifest.truncated;

  for (const file of input.manifest.files) {
    const source = await input.read(file.path);
    if (source === null) {
      issues.push({ filePath: file.path, code: "unsupported", message: `${file.path} could not be read, so nothing in it is editable.` });
      continue;
    }
    if (hash(source) !== file.sourceHash) {
      // The manifest was built a moment ago from these same bytes. A mismatch
      // means the branch moved underneath us, and every offset in this file is
      // now a guess.
      issues.push({ filePath: file.path, code: "unsupported", message: `${file.path} changed while this page was being opened. Reload the page to edit it.` });
      continue;
    }
    const discovery = discoverJsxFields(source, file.path);
    for (const issue of discovery.issues) issues.push({ ...issue, filePath: file.path });
    sources.push({ filePath: file.path, sourceHash: discovery.sourceHash, role: file.role });
    const shared = (counts.get(file.path) ?? 0) > 1;
    for (const field of discovery.fields) {
      if (fields.length >= MAX_PAGE_FIELDS) { truncated = true; break; }
      fields.push({ ...field, filePath: file.path, role: file.role, shared });
    }
    if (truncated) break;
  }

  return {
    version: PAGE_FIELDS_VERSION,
    entry: input.manifest.entry,
    manifestHash: input.manifest.manifestHash,
    fields,
    issues,
    sources,
    truncated,
  };
}

/**
 * What may be done to one rendered element, and why not, when not.
 *
 * The spec's distinction, made concrete: **selectable** is everything on the
 * page, and **editable** is the subset that traces back to a literal somebody
 * can write. A visitor's eye does not know the difference, so the editor has to
 * say it — and it has to say it on the element, at the moment it is clicked,
 * rather than at the publish when the work is already done.
 */
export type ElementCapabilities = {
  htmlFieldId: string;
  label: string;
  selectable: true;
  content: boolean;
  formatting: boolean;
  image: boolean;
  link: boolean;
  /** Styling is answered by the generated stylesheet, not by the source, so it
   * is available for any element with a stable rendered target. */
  styles: boolean;
  structure: boolean;
  /** "instance" when a write lands on this one rendering; "shared" when the
   * file it lives in is rendered more than once on this page. */
  scope: "instance" | "shared";
  /** Present when something is not editable: the reason, in a sentence meant
   * for the person reading it. */
  reason?: string;
  /** The file a write would land in, when there is one. */
  filePath?: string;
};

export type PageMapping = {
  sourceFieldId: string;
  htmlFieldId: string;
  property: "value" | "href" | "alt";
  filePath: string;
  confidence: "marker" | "exact-value";
  scope: "instance" | "shared";
};

export type PageView = {
  mappings: PageMapping[];
  capabilities: ElementCapabilities[];
  /** Fields in the source that no element on the page could be matched to, and
   * the reason for each. Shown as mapping diagnostics rather than hidden. */
  diagnostics: Array<{ sourceFieldId: string; filePath: string; code: string; message: string; candidateHtmlFieldIds: string[] }>;
};

/**
 * Match the page's fields to the rendered page, all files at once.
 *
 * `requireMarker` is the publish-time discipline: value matching is good enough
 * to show somebody where their words came from, and not good enough to commit
 * a change on. The editor shows with it off and writes with it on.
 */
export function matchPageToHtml(input: { discovery: PageDiscovery; html: string; requireMarker?: boolean }): PageView & { htmlFields: SiteField[] } {
  const htmlFields = readPage(input.html).fields;
  const byId = new Map(input.discovery.fields.map((field) => [field.id, field]));
  // Every file's fields go into one call, which is what makes a collision
  // between two files visible at all.
  const report = mapJsxFieldsToHtml(input.discovery.fields, htmlFields, { requireMarker: input.requireMarker });

  const mappings: PageMapping[] = report.mappings.map((mapping) => {
    const field = byId.get(mapping.sourceFieldId)!;
    return {
      sourceFieldId: mapping.sourceFieldId,
      htmlFieldId: mapping.htmlFieldId,
      property: mapping.property,
      filePath: field.filePath,
      confidence: mapping.confidence,
      scope: field.shared ? "shared" : "instance",
    };
  });

  const byHtmlField = new Map<string, PageMapping[]>();
  for (const mapping of mappings) {
    const list = byHtmlField.get(mapping.htmlFieldId) ?? [];
    list.push(mapping);
    byHtmlField.set(mapping.htmlFieldId, list);
  }

  const capabilities: ElementCapabilities[] = htmlFields.map((field) => {
    const matched = byHtmlField.get(field.id) ?? [];
    const writable = matched.length > 0;
    const scope: "instance" | "shared" = matched.some((mapping) => mapping.scope === "shared") ? "shared" : "instance";
    const kinds = new Set(matched.map((mapping) => mapping.property));
    return {
      htmlFieldId: field.id,
      label: field.label,
      selectable: true,
      content: kinds.has("value"),
      // Rich text needs a registered rich-text field; a plain string literal
      // cannot hold `<strong>` without becoming code. Said plainly rather than
      // offered and refused at the publish.
      formatting: false,
      image: field.kind === "image" && writable,
      link: kinds.has("href"),
      styles: true,
      structure: false,
      scope,
      ...(writable ? { filePath: matched[0]!.filePath } : {}),
      ...(writable ? {} : { reason: reasonFor(field, report.diagnostics, input.discovery) }),
    };
  });

  return {
    htmlFields,
    mappings,
    capabilities,
    diagnostics: report.diagnostics.map((diagnostic) => ({
      sourceFieldId: diagnostic.sourceFieldId,
      filePath: byId.get(diagnostic.sourceFieldId)?.filePath ?? input.discovery.entry,
      code: diagnostic.code,
      message: diagnostic.message,
      // Which elements on the page this diagnostic is about, so a caller can
      // tell somebody which files their words were found in without matching
      // on the sentence.
      candidateHtmlFieldIds: diagnostic.candidateHtmlFieldIds,
    })),
  };
}

/** Why one rendered element cannot be written, in a sentence for the person who
 * just clicked it. Specific where the mapper knows, honest where it does not. */
function reasonFor(field: SiteField, diagnostics: ReadonlyArray<{ code: string; candidateHtmlFieldIds: string[] }>, discovery: PageDiscovery): string {
  if (diagnostics.some((diagnostic) => diagnostic.code === "ambiguous" && diagnostic.candidateHtmlFieldIds.includes(field.id))) {
    return "These exact words appear more than once on this page, so an edit here could not be traced to the right piece of code. A developer can name this one with a data-dw-field marker.";
  }
  if (discovery.truncated) return "This page reaches more source files than the editor reads, so this part was not traced back to its code.";
  return "This part of the page is built by its code rather than stored as text, so there is nothing here to type into.";
}

export type PageWrite = { filePath: string; source: string; sourceHash: string; changed: string[] };
export type PageApplyResult = {
  writes: PageWrite[];
  problems: JsxEditProblem[];
  unmappable: UnmappableEdit[];
};

/** The parts of an edit that are markup rather than content. Shared with
 * `jsx.ts`'s single-file path by intent, not by import, because the sentences
 * differ: here the editor knows which file would have taken the change. */
const CODE_MANAGED: Record<string, string> = {
  style: "Inline styling must be changed in this component's source editor.",
  responsive: "Responsive styling must be changed in this component's source editor.",
  variant: "This button's style comes from its component, not from this page.",
  newTab: "Whether a link opens in a new tab is set in the code for this page.",
  structure: "Adding, moving or removing a section changes the code that builds this page.",
};

/**
 * Write an editor's draft back across every file it touches.
 *
 * All or nothing, twice over: each file is spliced atomically by
 * `applyJsxValues` against its own hash, and if any file refuses its part, no
 * file's result is returned at all.
 *
 * Styling deliberately does not appear in `CODE_MANAGED` here. It is not
 * refused any more — it is written to the generated stylesheet instead, which
 * is a different destination rather than a different answer, and is handled by
 * the caller. What reaches this function is content only.
 */
export async function applyPageEdits(input: {
  discovery: PageDiscovery;
  read: Reader;
  html: string;
  edits: Record<string, HtmlFieldEdit>;
  requireMarker?: boolean;
}): Promise<PageApplyResult> {
  const view = matchPageToHtml({ discovery: input.discovery, html: input.html, requireMarker: input.requireMarker });
  const byId = new Map(input.discovery.fields.map((field) => [field.id, field]));
  const labels = new Map(view.htmlFields.map((field) => [field.id, field.label]));
  const byTarget = new Map(view.mappings.map((mapping) => [`${mapping.htmlFieldId} ${mapping.property}`, mapping]));

  const perFile = new Map<string, JsxChange[]>();
  const unmappable: UnmappableEdit[] = [];

  for (const [htmlFieldId, edit] of Object.entries(input.edits)) {
    const where = labels.get(htmlFieldId) ?? "a field on this page";
    for (const [part, raw] of Object.entries(edit)) {
      if (raw === undefined) continue;
      if (["original", "originalHref", "originalAlt", "originalStyle", "originalResponsive", "originalStructure", "originalVariant", "originalNewTab"].includes(part)) continue;
      if (CODE_MANAGED[part]) { unmappable.push({ htmlFieldId, part, message: `${where}: ${CODE_MANAGED[part]}` }); continue; }
      if (part !== "value" && part !== "href" && part !== "alt") {
        unmappable.push({ htmlFieldId, part, message: `${where}: this kind of change is written by the code for this page.` });
        continue;
      }
      const mapping = byTarget.get(`${htmlFieldId} ${part}`);
      if (!mapping) {
        const capability = view.capabilities.find((entry) => entry.htmlFieldId === htmlFieldId);
        unmappable.push({ htmlFieldId, part, message: `${where}: ${capability?.reason ?? "this came from the code rather than from a piece of text, so it cannot be changed here."}` });
        continue;
      }
      const value = String(raw);
      if (part === "value" && /<[a-z!/][^>]*>/i.test(value)) {
        unmappable.push({ htmlFieldId, part, message: `${where}: formatting inside these words would change the page's code. Keep it as plain text, or ask a developer to make this a rich-text field.` });
        continue;
      }
      const field = byId.get(mapping.sourceFieldId);
      if (!field) { unmappable.push({ htmlFieldId, part, message: `${where}: this field is no longer in the page's source.` }); continue; }
      const list = perFile.get(field.filePath) ?? [];
      list.push({ fieldId: mapping.sourceFieldId, value: part === "value" ? decodeEntities(value) : value });
      perFile.set(field.filePath, list);
    }
  }

  if (unmappable.length) return { writes: [], problems: [], unmappable };
  if (!perFile.size) return { writes: [], problems: [{ code: "invalid", message: "None of these edits change anything in this page's source files." }], unmappable: [] };

  const writes: PageWrite[] = [];
  const problems: JsxEditProblem[] = [];
  for (const [filePath, changes] of perFile) {
    const source = await input.read(filePath);
    if (source === null) { problems.push({ code: "source", message: `${filePath} could not be read to write these changes.` }); continue; }
    const expected = input.discovery.sources.find((entry) => entry.filePath === filePath)?.sourceHash;
    if (!expected) { problems.push({ code: "source", message: `${filePath} is not part of this page, so nothing may be written to it.` }); continue; }
    const applied: JsxApplyResult = applyJsxValues(source, { filePath, sourceHash: expected, changes });
    if (applied.problems.length) { problems.push(...applied.problems); continue; }
    if (!applied.changed.length) continue;
    writes.push({ filePath, source: applied.source, sourceHash: expected, changed: applied.changed });
  }

  // One file refusing its part fails the set. Half a page published is worse
  // than none, because nobody is told which half.
  if (problems.length) return { writes: [], problems, unmappable: [] };
  return { writes, problems: [], unmappable: [] };
}
