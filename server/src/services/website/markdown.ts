/**
 * Source editing for Markdown pages: `.md`, `.mdx` and `.markdown`.
 *
 * Docusaurus, Eleventy, Hugo, Jekyll and every Astro content collection keep
 * their pages as Markdown with a YAML front matter block on top. Listing those
 * pages and then having no way to change a word in them would be the worst of
 * both: a page list that is right and an editor that cannot open anything on it.
 *
 * A Markdown file is unusual among the things this editor touches, because the
 * words are not inside a structure — they *are* the file. So it offers two
 * kinds of field and nothing else:
 *
 *  - **front matter values** whose key reads as content (`title`, `description`,
 *    `author`…), each a scalar on one line. A list, a nested map, an anchor or a
 *    multi-line block scalar is left alone: those are structure a theme reads,
 *    and rewriting one by hand is how a build starts failing.
 *  - **the body**, as one field. Not split into paragraphs, because Markdown's
 *    meaning is in its layout — a blank line is a paragraph break, two spaces
 *    are a line break — and handing somebody half of it to edit in isolation
 *    invites them to destroy the other half.
 *
 * Nothing is rendered, and no Markdown is parsed into HTML. The file is split,
 * the pieces are handed over, and the pieces are put back exactly where they
 * came from.
 */
import { createHash } from "node:crypto";
import { contentKind, validateFieldValue } from "./jsx.js";

export const MARKDOWN_ADAPTER_VERSION = "markdown-frontmatter-v1" as const;
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_EDITS = 500;
export const MARKDOWN_EXTENSIONS = [".md", ".mdx", ".markdown"] as const;

export type MarkdownFieldKind = "text" | "href" | "src" | "alt";
export type MarkdownField = {
  id: string;
  kind: MarkdownFieldKind;
  tag: string;
  label: string;
  value: string;
  confidence: "explicit" | "structural";
  reference: {
    adapter: typeof MARKDOWN_ADAPTER_VERSION;
    filePath: string;
    sourceHash: string;
    locator: string;
    start: number;
    end: number;
    original: string;
    encoding: "yaml-scalar" | "markdown-body";
  };
};
export type MarkdownIssue = { code: "syntax" | "unsupported" | "dynamic" | "ambiguous" | "limit"; message: string; line?: number; column?: number };
export type MarkdownDiscovery = { adapter: typeof MARKDOWN_ADAPTER_VERSION; filePath: string; sourceHash: string; fields: MarkdownField[]; issues: MarkdownIssue[] };
export type MarkdownEditProblem = { code: "stale" | "unknown" | "duplicate" | "invalid" | "source"; fieldId?: string; message: string };
export type MarkdownApplyResult = { source: string; changed: string[]; problems: MarkdownEditProblem[] };

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function isMarkdownPath(filePath: string): boolean {
  const lower = filePath.replace(/\\/g, "/").toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function checkedPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /[:\x00-\x1f\x7f]/.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Choose a file path relative to the connected repository.");
  }
  if (!isMarkdownPath(normalized)) throw new Error("This adapter accepts .md, .mdx and .markdown files.");
  return normalized;
}

/** Where the front matter block ends, or null when the file has none. */
function frontMatter(source: string): { start: number; end: number } | null {
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (!open) return null;
  const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(source.slice(open[0].length));
  return close ? { start: open[0].length, end: open[0].length + close.index + 1 } : null;
}

/**
 * Discover the front matter values and the body of a Markdown page.
 *
 * Offsets are into the whole file, so an edit is spliced at exactly the place it
 * was read from and nothing around it moves.
 */
export function discoverMarkdownFields(source: string, rawFilePath: string): MarkdownDiscovery {
  const filePath = checkedPath(rawFilePath);
  const sourceHash = hash(source);
  const result: MarkdownDiscovery = { adapter: MARKDOWN_ADAPTER_VERSION, filePath, sourceHash, fields: [], issues: [] };
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    result.issues.push({ code: "limit", message: "This source file exceeds the 2 MB editing limit." });
    return result;
  }

  const add = (input: { start: number; end: number; kind: MarkdownFieldKind; label: string; locator: string; encoding: MarkdownField["reference"]["encoding"]; value: string; tag: string }) => {
    result.fields.push({
      id: `md_${hash(`${filePath}\0${input.locator}`).slice(0, 32)}`,
      kind: input.kind,
      tag: input.tag,
      label: input.label,
      value: input.value,
      confidence: "explicit",
      reference: { adapter: MARKDOWN_ADAPTER_VERSION, filePath, sourceHash, locator: input.locator, start: input.start, end: input.end, original: source.slice(input.start, input.end), encoding: input.encoding },
    });
  };

  const block = frontMatter(source);
  if (block) {
    let offset = block.start;
    for (const line of source.slice(block.start, block.end).split("\n")) {
      const length = line.length + 1;
      const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)[ \t]*\r?$/.exec(`${line}\r`);
      if (match) {
        const key = match[1]!;
        const raw = match[2]!;
        const kind = contentKind(key);
        // A scalar on its own line and nothing else. `tags: [a, b]`, a `|`
        // block, an anchor and a date are structure a theme reads, and this
        // adapter does not rewrite structure. A quoted value may contain any of
        // those characters, because inside quotes they are just letters.
        const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(raw) ?? /^'((?:[^']|'')*)'$/.exec(raw);
        const plain = !quoted && /^[^[{|>&*#!%@`"']/.test(raw) && !/^\d{4}-\d{2}-\d{2}/.test(raw) ? raw : null;
        if (kind && raw && (quoted || plain !== null)) {
          const valueStart = offset + line.indexOf(raw, key.length);
          add({
            start: valueStart, end: valueStart + raw.length, kind,
            label: key, locator: `frontmatter:${key}`, encoding: "yaml-scalar", tag: "front matter",
            value: quoted ? unquote(quoted[1]!, raw[0]!) : plain!,
          });
        } else if (kind && raw) {
          result.issues.push({ code: "unsupported", message: `Front matter "${key}" is a list, a date or a block, and stays with the code.` });
        }
      }
      offset += length;
    }
  }

  // The body: everything after the front matter, trimmed of the blank lines that
  // separate it from the block so that editing it cannot eat the separator.
  const bodyStart = block ? Math.min(source.length, source.indexOf("\n", block.end) + 1 || source.length) : 0;
  const body = source.slice(bodyStart);
  const lead = body.length - body.trimStart().length;
  const trail = body.length - body.trimEnd().length;
  if (body.trim()) {
    if (/\{|\}|<[A-Z]/.test(body) && /\.mdx$/i.test(filePath)) {
      // MDX bodies carry components and expressions. The words are still the
      // words, but a person editing them can break a component by accident, so
      // it is said out loud rather than discovered later.
      result.issues.push({ code: "dynamic", message: "This MDX page contains components or expressions. Keep them exactly as they are while editing the words around them." });
    }
    add({
      start: bodyStart + lead, end: bodyStart + body.length - trail,
      kind: "text", label: "Page body", locator: "body", encoding: "markdown-body", tag: "body",
      value: body.trim(),
    });
  }
  return result;
}

/**
 * A quoted YAML scalar, as its text.
 *
 * The two quoting styles escape differently — a double-quoted scalar uses a
 * backslash, a single-quoted one doubles the quote — and reading both back the
 * way YAML would is what makes the round trip honest for a title that has a
 * quotation mark in it.
 */
function unquote(value: string, quote: string): string {
  return quote === '"'
    ? value.replace(/\\(["\\])/g, "$1")
    : value.replace(/''/g, "'");
}

function encode(field: MarkdownField, value: string): string {
  if (field.reference.encoding === "markdown-body") return value;
  // A YAML scalar is quoted when it has to be, and quoted the way it already
  // was when it already is — a title that was written in quotes stays that way,
  // so the diff a developer reads is one line and not two.
  const needsQuote = /^[\s>|&*#!%@`[{]|[:#]\s|["']|\s$|^$|^(true|false|null|yes|no|on|off|~|-?\d+(\.\d+)?)$/i.test(value);
  const wasQuoted = /^["']/.test(field.reference.original);
  if (!needsQuote && !wasQuoted) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Atomic, and identical in contract to the other two adapters. */
export function applyMarkdownValues(source: string, request: { filePath: string; sourceHash: string; changes: readonly { fieldId: string; value: string }[] }): MarkdownApplyResult {
  const unchanged = (problems: MarkdownEditProblem[]): MarkdownApplyResult => ({ source, changed: [], problems });
  if (request.sourceHash !== hash(source)) return unchanged([{ code: "stale", message: "The source file changed after these edits were prepared. Reload it and review the edits again." }]);
  if (!Array.isArray(request.changes) || request.changes.length > MAX_EDITS) return unchanged([{ code: "invalid", message: "Submit at most 500 field changes at once." }]);
  let discovery: MarkdownDiscovery;
  try { discovery = discoverMarkdownFields(source, request.filePath); }
  catch (error) { return unchanged([{ code: "source", message: error instanceof Error ? error.message : "Invalid source file." }]); }
  if (discovery.issues.some((issue) => issue.code === "limit")) return unchanged([{ code: "source", message: discovery.issues.map((issue) => issue.message).join(" ") }]);
  const byId = new Map(discovery.fields.map((field) => [field.id, field]));
  const seen = new Set<string>();
  const problems: MarkdownEditProblem[] = [];
  const edits: { field: MarkdownField; value: string; replacement: string }[] = [];
  for (const change of request.changes) {
    if (!change || typeof change.fieldId !== "string" || typeof change.value !== "string") { problems.push({ code: "invalid", message: "Each edit must contain a field ID and a string value." }); continue; }
    if (seen.has(change.fieldId)) { problems.push({ code: "duplicate", fieldId: change.fieldId, message: "A field may occur only once in a change set." }); continue; }
    seen.add(change.fieldId);
    const field = byId.get(change.fieldId);
    if (!field) { problems.push({ code: "unknown", fieldId: change.fieldId, message: "This field is absent in the current source file." }); continue; }
    const invalid = validateFieldValue(field.kind, change.value);
    if (invalid) { problems.push({ code: "invalid", fieldId: change.fieldId, message: invalid }); continue; }
    // A front matter value is one line by definition. A newline pasted into one
    // would end the value and turn the rest into a key, which is how a page
    // stops building.
    if (field.reference.encoding === "yaml-scalar" && /[\r\n]/.test(change.value)) { problems.push({ code: "invalid", fieldId: change.fieldId, message: "A front matter value has to stay on one line." }); continue; }
    if (field.reference.encoding === "markdown-body" && /^---[ \t]*$/m.test(change.value.split("\n")[0] ?? "")) { problems.push({ code: "invalid", fieldId: change.fieldId, message: "A page body cannot begin with a front matter fence." }); continue; }
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
  const after = discoverMarkdownFields(output, discovery.filePath);
  const afterFields = new Map(after.fields.map((field) => [field.id, field]));
  const wanted = new Map(edits.map((edit) => [edit.field.id, edit.value]));
  if (after.fields.length !== discovery.fields.length || discovery.fields.some((field) => afterFields.get(field.id)?.value !== (wanted.get(field.id) ?? field.value))) {
    return unchanged([{ code: "invalid", message: "These values cannot be written back without changing the file's structure. Keep the body and each front matter value in the shape they are in." }]);
  }
  return { source: output, changed: edits.map((edit) => edit.field.id).reverse(), problems: [] };
}
