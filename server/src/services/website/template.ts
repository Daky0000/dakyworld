/**
 * Source editing for HTML-shaped templates: `.astro`, `.vue` and `.svelte`.
 *
 * The JSX adapter next door can lean on the TypeScript compiler because a
 * `.tsx` file *is* TypeScript. None of these three are. A `.vue` file is three
 * blocks in a trench coat, a `.svelte` file is HTML with its own control flow,
 * and an `.astro` file is frontmatter followed by markup. What they share is the
 * part this editor cares about: the visible bit is written as HTML elements
 * with quoted attributes and literal text.
 *
 * So this scans, it does not compile. Nothing here executes, imports or renders
 * anything; it reads the bytes, finds the literal segments, splices a
 * replacement back at exactly the offsets it found — and then re-scans the
 * result and refuses the edit if anything but the edited values moved.
 *
 * What it deliberately declines to edit, because a wrong guess here silently
 * breaks somebody's site:
 *
 *  - anything containing `{` or `}` — a Svelte block, an Astro expression, a
 *    Vue mustache. It is code, and it stays the code's.
 *  - bound and directive attributes (`:href`, `v-bind:src`, `bind:value`,
 *    `@click`, `client:load`), for the same reason.
 *  - `<script>`, `<style>` and the other opaque tags, whole.
 *  - Astro frontmatter; component props stay code-managed.
 *  - a custom component's own attributes, because a component decides what a
 *    prop means and this adapter cannot know.
 */
import { createHash } from "node:crypto";
import { validateFieldValue } from "./jsx.js";

export const TEMPLATE_ADAPTER_VERSION = "template-literal-v1" as const;
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_FIELDS = 5_000;
const MAX_EDITS = 500;
const OPAQUE_TAGS = new Set(["script", "style", "svg", "math", "iframe", "object", "embed", "textarea", "pre", "code"]);
const ATTRIBUTES: Record<string, readonly string[]> = { href: ["a", "area"], src: ["img", "source", "video", "audio"], alt: ["img", "area"] };
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
export const TEMPLATE_EXTENSIONS = [".astro", ".vue", ".svelte"] as const;

export type TemplateFieldKind = "text" | "href" | "src" | "alt";
export type TemplateField = {
  id: string;
  kind: TemplateFieldKind;
  tag: string;
  label: string;
  value: string;
  marker?: string;
  confidence: "explicit" | "structural";
  reference: {
    adapter: typeof TEMPLATE_ADAPTER_VERSION;
    filePath: string;
    sourceHash: string;
    locator: string;
    /** UTF-16 offsets into the whole file, suitable for String.slice. */
    start: number;
    end: number;
    original: string;
    encoding: "template-text" | "template-attribute";
  };
};
export type TemplateIssue = { code: "syntax" | "unsupported" | "dynamic" | "ambiguous" | "limit"; message: string; line?: number; column?: number };
export type TemplateDiscovery = { adapter: typeof TEMPLATE_ADAPTER_VERSION; filePath: string; sourceHash: string; fields: TemplateField[]; issues: TemplateIssue[] };
export type TemplateEditProblem = { code: "stale" | "unknown" | "duplicate" | "invalid" | "source"; fieldId?: string; message: string };
export type TemplateApplyResult = { source: string; changed: string[]; problems: TemplateEditProblem[] };

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function isTemplatePath(filePath: string): boolean {
  const lower = filePath.replace(/\\/g, "/").toLowerCase();
  return TEMPLATE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function checkedPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /[:\x00-\x1f\x7f]/.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Choose a file path relative to the connected repository.");
  }
  if (!isTemplatePath(normalized)) throw new Error("This adapter accepts .astro, .vue and .svelte source files.");
  return normalized;
}

/**
 * The ranges of a file this adapter is allowed to look at.
 *
 * An `.astro` file's frontmatter and a `.vue` file's `<script>` are not markup
 * and are not scanned at all — not "scanned and skipped", not reachable. A
 * `.svelte` file is markup all the way down, so the whole file is offered and
 * the scanner's own opaque-tag handling takes `<script>` and `<style>` out.
 */
export function templateRegions(source: string, filePath: string): { regions: Array<{ start: number; end: number }>; issues: TemplateIssue[] } {
  const lower = filePath.toLowerCase();
  const issues: TemplateIssue[] = [];
  if (lower.endsWith(".astro")) {
    const fence = /^---\r?\n/.exec(source);
    if (!fence) return { regions: [{ start: 0, end: source.length }], issues };
    const close = source.indexOf("\n---", fence[0].length);
    if (close === -1) return { regions: [], issues: [{ code: "syntax", message: "This .astro file opens a frontmatter fence that is never closed." }] };
    const lineEnd = source.indexOf("\n", close + 1);
    issues.push({ code: "unsupported", message: "Astro frontmatter is code and stays with the developer; only the markup below it is editable here." });
    return { regions: [{ start: lineEnd === -1 ? source.length : lineEnd + 1, end: source.length }], issues };
  }
  if (lower.endsWith(".vue")) {
    const regions: Array<{ start: number; end: number }> = [];
    const opening = /<template(\s[^>]*)?>/gi;
    const lowerSource = source.toLowerCase();
    for (let match = opening.exec(source); match; match = opening.exec(source)) {
      const start = match.index + match[0].length;
      const close = lowerSource.indexOf("</template>", start);
      if (close === -1) { issues.push({ code: "syntax", message: "This .vue file has a <template> block that is never closed." }); break; }
      regions.push({ start, end: close });
      opening.lastIndex = close;
    }
    if (!regions.length && !issues.length) issues.push({ code: "unsupported", message: "This .vue file has no <template> block to edit." });
    return { regions, issues };
  }
  return { regions: [{ start: 0, end: source.length }], issues };
}

/** Anything a template language treats as an expression is not a literal. */
function dynamic(value: string): boolean { return value.includes("{") || value.includes("}"); }
/** Excludes `:href`, `v-bind:src`, `bind:value`, `@click`, `client:load`. */
function plainAttribute(name: string): boolean { return /^[a-z][a-z0-9-]*$/.test(name); }
/** A native HTML element, not a component and not a custom element. */
function nativeTag(tag: string): boolean { return /^[a-z][a-z0-9]*$/.test(tag); }

type Frame = { tag: string; location: string; counts: Map<string, number>; textOrdinal: number; marker?: string };
type ParsedAttribute = { name: string; value: string | null; valueStart: number; valueEnd: number; quoted: boolean };

/**
 * Discover the literal, independently editable segments of a template file.
 *
 * IDs come from the element's position in the tag tree — the same idea as the
 * JSX adapter's AST path — so comments, reformatting and unrelated markup
 * elsewhere do not renumber a field. Where an element carries a `data-dw-field`
 * marker the ID is pinned to the marker instead, so the field survives the
 * element being moved.
 */
export function discoverTemplateFields(source: string, rawFilePath: string): TemplateDiscovery {
  const filePath = checkedPath(rawFilePath);
  const sourceHash = hash(source);
  const result: TemplateDiscovery = { adapter: TEMPLATE_ADAPTER_VERSION, filePath, sourceHash, fields: [], issues: [] };
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    result.issues.push({ code: "limit", message: "This source file exceeds the 2 MB editing limit." });
    return result;
  }
  const markerCounts = new Map<string, number>();
  const fieldMarkers = new Map<TemplateField, string>();
  const lineAt = (offset: number) => {
    const before = source.slice(0, offset);
    return { line: before.split("\n").length, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
  };
  const issue = (offset: number, code: TemplateIssue["code"], message: string) => {
    if (result.issues.length >= 100) return;
    result.issues.push({ code, message, ...lineAt(offset) });
  };

  function add(input: { start: number; end: number; kind: TemplateFieldKind; tag: string; location: string; marker?: string; encoding: TemplateField["reference"]["encoding"]; value: string }) {
    if (result.fields.length >= MAX_FIELDS) throw new Error("This file has too many literal fields to edit safely.");
    const locator = `${input.marker ? `marker:${input.marker}` : `path:${input.location}`}/${input.kind}`;
    const field: TemplateField = {
      id: `tpl_${hash(`${filePath}\0${locator}`).slice(0, 32)}`,
      kind: input.kind,
      tag: input.tag,
      label: `${input.tag} ${input.kind}`,
      value: input.value,
      ...(input.marker && { marker: input.marker.split("/text:")[0] }),
      confidence: input.marker ? "explicit" : "structural",
      reference: { adapter: TEMPLATE_ADAPTER_VERSION, filePath, sourceHash, locator, start: input.start, end: input.end, original: source.slice(input.start, input.end), encoding: input.encoding },
    };
    result.fields.push(field);
    if (input.marker) fieldMarkers.set(field, input.marker.split("/text:")[0]!);
  }

  /**
   * Parses one tag's attributes, returning null when the tag never closes.
   *
   * Quoted values only. An unquoted or brace-delimited value is reported as
   * dynamic by the caller rather than guessed at.
   */
  function parseAttributes(from: number, to: number): { attributes: ParsedAttribute[]; end: number; selfClosing: boolean } | null {
    const attributes: ParsedAttribute[] = [];
    let index = from;
    while (index < to) {
      while (index < to && /\s/.test(source[index]!)) index += 1;
      if (index >= to) return null;
      if (source.startsWith("/>", index)) return { attributes, end: index + 2, selfClosing: true };
      if (source[index] === ">") return { attributes, end: index + 1, selfClosing: false };
      const name = /^[^\s=/>]+/.exec(source.slice(index, to));
      if (!name) return null;
      const attributeName = name[0]!;
      index += attributeName.length;
      let cursor = index;
      while (cursor < to && /\s/.test(source[cursor]!)) cursor += 1;
      if (source[cursor] !== "=") { attributes.push({ name: attributeName, value: null, valueStart: index, valueEnd: index, quoted: false }); continue; }
      index = cursor + 1;
      while (index < to && /\s/.test(source[index]!)) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, index + 1);
        if (close === -1 || close >= to) return null;
        attributes.push({ name: attributeName, value: source.slice(index + 1, close), valueStart: index, valueEnd: close + 1, quoted: true });
        index = close + 1;
        continue;
      }
      if (quote === "{") {
        // `href={url}`: an expression, and it may contain a `>` of its own, so
        // step over the whole brace pair rather than letting the tag appear to
        // end inside it.
        let depth = 0;
        let cursorBrace = index;
        for (; cursorBrace < to; cursorBrace += 1) {
          if (source[cursorBrace] === "{") depth += 1;
          else if (source[cursorBrace] === "}") { depth -= 1; if (depth === 0) break; }
        }
        if (cursorBrace >= to) return null;
        attributes.push({ name: attributeName, value: source.slice(index, cursorBrace + 1), valueStart: index, valueEnd: cursorBrace + 1, quoted: false });
        index = cursorBrace + 1;
        continue;
      }
      const unquoted = /^[^\s>]*/.exec(source.slice(index, to))![0];
      attributes.push({ name: attributeName, value: unquoted, valueStart: index, valueEnd: index + unquoted.length, quoted: false });
      index += unquoted.length;
    }
    return null;
  }

  function scan(from: number, to: number) {
    const root: Frame = { tag: "#root", location: "root", counts: new Map(), textOrdinal: 0 };
    const stack: Frame[] = [root];
    let index = from;
    let textStart = from;

    const attributeField = (attribute: ParsedAttribute, tag: string, location: string, marker?: string) => {
      if (!ATTRIBUTES[attribute.name]?.includes(tag)) return;
      if (attribute.value === null || !attribute.quoted) { issue(attribute.valueStart, "dynamic", `${tag}.${attribute.name} has no editable static value.`); return; }
      if (dynamic(attribute.value)) { issue(attribute.valueStart, "dynamic", `${tag}.${attribute.name} comes from code; this editor can change only an existing static string.`); return; }
      add({ start: attribute.valueStart, end: attribute.valueEnd, kind: attribute.name as TemplateFieldKind, tag, location, marker, encoding: "template-attribute", value: decodeText(attribute.value) });
    };

    const flushText = (end: number) => {
      const frame = stack[stack.length - 1]!;
      const raw = source.slice(textStart, end);
      if (!raw.trim() || frame.tag === "#root" || !nativeTag(frame.tag)) return;
      if (dynamic(raw)) { issue(textStart, "dynamic", `An expression inside <${frame.tag}> stays controlled by its source code.`); return; }
      // Only the text moves; the whitespace around it is formatting and belongs
      // to whoever wrote the file.
      const lead = raw.length - raw.trimStart().length;
      const trail = raw.length - raw.trimEnd().length;
      const suffix = `/text:${frame.textOrdinal++}`;
      add({
        start: textStart + lead,
        end: end - trail,
        kind: "text",
        tag: frame.tag,
        location: `${frame.location}${suffix}`,
        marker: frame.marker ? `${frame.marker}${suffix}` : undefined,
        encoding: "template-text",
        value: decodeText(raw.trim()),
      });
    };

    while (index < to) {
      const next = source.indexOf("<", index);
      if (next === -1 || next >= to) { flushText(to); break; }
      if (source.startsWith("<!--", next)) {
        flushText(next);
        const close = source.indexOf("-->", next + 4);
        index = close === -1 ? to : close + 3;
        textStart = index;
        continue;
      }
      const closing = /^<\/([A-Za-z][A-Za-z0-9.:_-]*)\s*>/.exec(source.slice(next, Math.min(to, next + 200)));
      if (closing) {
        flushText(next);
        const tag = closing[1]!.toLowerCase();
        for (let level = stack.length - 1; level > 0; level -= 1) {
          if (stack[level]!.tag.toLowerCase() === tag) { stack.length = level; break; }
        }
        index = next + closing[0].length;
        textStart = index;
        continue;
      }
      const opening = /^<([A-Za-z][A-Za-z0-9.:_-]*)/.exec(source.slice(next, Math.min(to, next + 200)));
      if (!opening) { index = next + 1; continue; }
      flushText(next);
      const tag = opening[1]!;
      const parsed = parseAttributes(next + opening[0].length, to);
      if (parsed === null) { issue(next, "syntax", `The tag <${tag}> is never closed.`); break; }
      if (stack.length > 250) throw new Error("The source nesting is too deep for visual editing.");

      const parent = stack[stack.length - 1]!;
      const ordinal = parent.counts.get(tag) ?? 0;
      parent.counts.set(tag, ordinal + 1);
      const location = `${parent.location}/${tag}[${ordinal}]`;

      let marker: string | undefined;
      const markerAttribute = parsed.attributes.find((attribute) => attribute.name === "data-dw-field");
      if (markerAttribute) {
        if (markerAttribute.quoted && markerAttribute.value !== null && /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(markerAttribute.value)) {
          marker = markerAttribute.value;
          markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1);
        } else issue(next, "ambiguous", "Use a plain unique data-dw-field marker containing letters, numbers, dots, dashes or colons.");
      }

      const lower = tag.toLowerCase();
      if (OPAQUE_TAGS.has(lower)) {
        issue(next, "unsupported", `Content inside <${tag}> is not editable with this adapter.`);
        const close = source.toLowerCase().indexOf(`</${lower}`, parsed.end);
        index = parsed.selfClosing ? parsed.end : close === -1 ? to : close;
        textStart = index;
        continue;
      }
      if (!nativeTag(lower) || lower !== tag) {
        issue(next, "unsupported", `Props and direct text of <${tag}> need a component-specific adapter.`);
      } else {
        const names = parsed.attributes.map((attribute) => attribute.name);
        if (new Set(names).size !== names.length) issue(next, "ambiguous", `Duplicate attributes on <${tag}> must be fixed before editing.`);
        else {
          for (const attribute of parsed.attributes) {
            if (plainAttribute(attribute.name)) { attributeField(attribute, lower, location, marker); continue; }
            if (/(^|:|-)(href|src|alt)$/i.test(attribute.name)) issue(attribute.valueStart, "dynamic", `A bound attribute on <${tag}> comes from code; this editor can change only an existing static value.`);
          }
        }
      }

      index = parsed.end;
      textStart = index;
      if (!parsed.selfClosing && !VOID_TAGS.has(lower)) stack.push({ tag, location, counts: new Map(), textOrdinal: 0, marker });
    }
  }

  try {
    const { regions, issues } = templateRegions(source, filePath);
    result.issues.push(...issues);
    for (const region of regions) scan(region.start, region.end);
    const duplicates = new Set([...markerCounts].filter(([, count]) => count > 1).map(([marker]) => marker));
    if (duplicates.size) {
      for (const marker of duplicates) result.issues.push({ code: "ambiguous", message: `The marker "${marker}" occurs more than once. All fields using it are read-only.` });
      result.fields = result.fields.filter((field) => !duplicates.has(fieldMarkers.get(field) ?? ""));
    }
    return result;
  } catch (error) {
    result.fields = [];
    result.issues.push({ code: "syntax", message: error instanceof Error ? error.message : "This source file cannot be parsed safely." });
    return result;
  }
}

/** The five named entities HTML guarantees, and numeric ones. Nothing else, so
 * that what is decoded here is exactly what `encode` can put back. */
function decodeText(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    if (named[key]) return named[key]!;
    const code = key.startsWith("#x") ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
  });
}

function encode(field: TemplateField, value: string): string {
  // `{` and `}` are escaped everywhere: in all three languages an unescaped
  // brace opens an expression, and somebody typing "{free}" into a text box
  // means the word, not a template hole.
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
  if (field.reference.encoding === "template-text") return escaped;
  const quote = field.reference.original[0] === "'" ? "'" : '"';
  return `${quote}${escaped.replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\r/g, "&#13;").replace(/\n/g, "&#10;")}${quote}`;
}

/** Atomic, and identical in contract to `applyJsxValues`: any stale, unknown,
 * duplicate, unsafe or non-round-tripping edit returns the original source and
 * no changed IDs. Always rediscover after an accepted edit; the resulting file
 * has a different source hash and different offsets. */
export function applyTemplateValues(source: string, request: { filePath: string; sourceHash: string; changes: readonly { fieldId: string; value: string }[] }): TemplateApplyResult {
  const unchanged = (problems: TemplateEditProblem[]): TemplateApplyResult => ({ source, changed: [], problems });
  if (request.sourceHash !== hash(source)) return unchanged([{ code: "stale", message: "The source file changed after these edits were prepared. Reload it and review the edits again." }]);
  if (!Array.isArray(request.changes) || request.changes.length > MAX_EDITS) return unchanged([{ code: "invalid", message: "Submit at most 500 field changes at once." }]);
  let discovery: TemplateDiscovery;
  try { discovery = discoverTemplateFields(source, request.filePath); }
  catch (error) { return unchanged([{ code: "source", message: error instanceof Error ? error.message : "Invalid source file." }]); }
  const fatal = discovery.issues.filter((issue) => issue.code === "syntax" || issue.code === "limit");
  if (fatal.length) return unchanged([{ code: "source", message: fatal.map((issue) => issue.message).join(" ") }]);
  const byId = new Map(discovery.fields.map((field) => [field.id, field]));
  const seen = new Set<string>();
  const problems: TemplateEditProblem[] = [];
  const edits: { field: TemplateField; value: string; replacement: string }[] = [];
  for (const change of request.changes) {
    if (!change || typeof change.fieldId !== "string" || typeof change.value !== "string") { problems.push({ code: "invalid", message: "Each edit must contain a field ID and a string value." }); continue; }
    if (seen.has(change.fieldId)) { problems.push({ code: "duplicate", fieldId: change.fieldId, message: "A field may occur only once in a change set." }); continue; }
    seen.add(change.fieldId);
    const field = byId.get(change.fieldId);
    if (!field) { problems.push({ code: "unknown", fieldId: change.fieldId, message: "This field is absent, dynamic or ambiguous in the current source file." }); continue; }
    const invalid = validateFieldValue(field.kind, change.value);
    if (invalid) { problems.push({ code: "invalid", fieldId: change.fieldId, message: invalid }); continue; }
    if (change.value !== field.value) edits.push({ field, value: change.value, replacement: encode(field, change.value) });
  }
  if (problems.length) return unchanged(problems);
  if (!edits.length) return unchanged([]);
  edits.sort((a, b) => b.field.reference.start - a.field.reference.start);
  let output = source;
  let boundary = source.length;
  for (const edit of edits) {
    const { start, end } = edit.field.reference;
    if (end > boundary) return unchanged([{ code: "source", message: "Two field ranges overlap. Reload the file before editing." }]);
    output = output.slice(0, start) + edit.replacement + output.slice(end);
    boundary = start;
  }
  const after = discoverTemplateFields(output, discovery.filePath);
  const afterFields = new Map(after.fields.map((field) => [field.id, field]));
  const wanted = new Map(edits.map((edit) => [edit.field.id, edit.value]));
  if (after.issues.some((issue) => issue.code === "syntax" || issue.code === "limit") || after.fields.length !== discovery.fields.length || discovery.fields.some((field) => afterFields.get(field.id)?.value !== (wanted.get(field.id) ?? field.value))) {
    return unchanged([{ code: "invalid", message: "These values cannot be represented without changing the source structure. Keep a text field nonempty, or ask a developer to change its structure." }]);
  }
  return { source: output, changed: edits.map((edit) => edit.field.id).reverse(), problems: [] };
}
