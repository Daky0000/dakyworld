/**
 * Source editing for native JSX elements with static literal content.
 *
 * The compiler only parses/transforms strings; it never loads dependencies or
 * executes the site's code. Every write is an atomic splice against the exact
 * source hash that was reviewed. Client-supplied offsets are never accepted.
 */
import { createHash } from "node:crypto";
import ts from "typescript";
import { decodeEntities } from "./parse.js";
import type { SiteField } from "./regions.js";

export const JSX_ADAPTER_VERSION = "jsx-literal-v1" as const;
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_FIELDS = 5_000;
const MAX_EDITS = 500;
const MAX_VALUE_LENGTH = 100_000;
const OPAQUE_TAGS = new Set(["script", "style", "svg", "math", "iframe", "object", "embed", "template", "textarea"]);
const ATTRIBUTES: Record<string, readonly string[]> = { href: ["a", "area"], src: ["img", "source", "video", "audio"], alt: ["img", "area"] };

export type JsxFieldKind = "text" | "href" | "src" | "alt";
type Encoding = "jsx-text" | "jsx-attribute" | "javascript-string";
export type JsxSourceReference = {
  adapter: typeof JSX_ADAPTER_VERSION;
  filePath: string;
  sourceHash: string;
  /** Stable marker where present; otherwise an AST location, not a DOM selector. */
  locator: string;
  /** UTF-16 offsets, suitable for String.slice; never byte offsets. */
  start: number;
  end: number;
  original: string;
  encoding: Encoding;
};
export type JsxField = {
  id: string;
  kind: JsxFieldKind;
  tag: string;
  label: string;
  value: string;
  marker?: string;
  confidence: "explicit" | "structural";
  reference: JsxSourceReference;
};
export type JsxIssue = {
  code: "syntax" | "unsupported" | "dynamic" | "ambiguous" | "limit";
  message: string;
  line?: number;
  column?: number;
};
export type JsxDiscovery = {
  adapter: typeof JSX_ADAPTER_VERSION;
  filePath: string;
  sourceHash: string;
  fields: JsxField[];
  issues: JsxIssue[];
};
export type JsxChange = { fieldId: string; value: string };
export type JsxEditProblem = { code: "stale" | "unknown" | "duplicate" | "invalid" | "source"; fieldId?: string; message: string };
export type JsxApplyResult = { source: string; changed: string[]; problems: JsxEditProblem[] };

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function checkedPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /[:\x00-\x1f\x7f]/.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Choose a file path relative to the connected repository.");
  }
  if (!/\.(jsx|tsx)$/i.test(normalized)) throw new Error("This adapter accepts .jsx and .tsx source files.");
  return normalized;
}

function compilerOptions(): ts.CompilerOptions {
  return { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, newLine: ts.NewLineKind.LineFeed };
}

/** Decode with the same JSX rules as the compiler, including named entities and
 * multiline whitespace. The generated JavaScript is parsed, NEVER executed. */
function decodeLiterals(fields: JsxField[]): void {
  const literals = fields.filter((field) => field.reference.encoding !== "javascript-string");
  if (!literals.length) return;
  const snippets = literals.map((field) => field.reference.encoding === "jsx-text"
    ? `<span>${field.reference.original}</span>`
    : `<span title=${field.reference.original} />`);
  const output = ts.transpileModule(`const __dw = [${snippets.join(",")}];`, { compilerOptions: compilerOptions(), fileName: "literals.tsx" });
  const decoded = ts.createSourceFile("literals.js", output.outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statement = decoded.statements.find(ts.isVariableStatement);
  const array = statement?.declarationList.declarations[0]?.initializer;
  if (!array || !ts.isArrayLiteralExpression(array) || array.elements.length !== literals.length) throw new Error("The compiler could not read this file's literal fields.");
  array.elements.forEach((element, index) => {
    if (!ts.isCallExpression(element)) throw new Error("The compiler returned an unexpected literal.");
    const field = literals[index]!;
    let value: ts.Node | undefined = element.arguments[2];
    if (field.reference.encoding === "jsx-attribute") {
      const props = element.arguments[1];
      const property = props && ts.isObjectLiteralExpression(props) ? props.properties[0] : undefined;
      value = property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
    }
    if (!value) { field.value = ""; return; }
    if (!ts.isStringLiteral(value)) throw new Error("Only static string literals may be edited.");
    field.value = value.text;
  });
}

/** Discover independently editable literal segments, not entire rich-text nodes.
 * Whitespace/comments and unrelated JavaScript do not change structural IDs.
 * Explicit data-dw-field markers survive moves within the same source file. */
export function discoverJsxFields(source: string, rawFilePath: string): JsxDiscovery {
  const filePath = checkedPath(rawFilePath);
  const sourceHash = hash(source);
  const result: JsxDiscovery = { adapter: JSX_ADAPTER_VERSION, filePath, sourceHash, fields: [], issues: [] };
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    result.issues.push({ code: "limit", message: "This source file exceeds the 2 MB editing limit." });
    return result;
  }
  try {
    const syntax = ts.transpileModule(source, { compilerOptions: { ...compilerOptions(), jsx: ts.JsxEmit.Preserve }, fileName: filePath, reportDiagnostics: true });
    const errors = (syntax.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length) {
      result.issues = errors.slice(0, 20).map((diagnostic) => {
        const point = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
        return { code: "syntax", message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), ...(point && { line: point.line + 1, column: point.character + 1 }) };
      });
      return result;
    }
    const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, /\.tsx$/i.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
    const markerCounts = new Map<string, number>();
    const fieldMarkers = new Map<JsxField, string>();
    const issue = (node: ts.Node, code: JsxIssue["code"], message: string) => {
      if (result.issues.length >= 100) return;
      const point = file.getLineAndCharacterOfPosition(node.getStart(file));
      result.issues.push({ code, message, line: point.line + 1, column: point.character + 1 });
    };

    function add(node: ts.Node, kind: JsxFieldKind, tag: string, location: string, marker: string | undefined, encoding: Encoding, value = "") {
      if (result.fields.length >= MAX_FIELDS) throw new Error("This file has too many literal fields to edit safely.");
      const start = ts.isJsxText(node) ? node.pos : node.getStart(file);
      const locator = `${marker ? `marker:${marker}` : `ast:${location}`}/${kind}`;
      const field: JsxField = {
        id: `jsx_${hash(`${filePath}\0${locator}`).slice(0, 32)}`,
        kind, tag, label: `${tag} ${kind}`, value, ...(marker && { marker: marker.split("/text:")[0] }), confidence: marker ? "explicit" : "structural",
        reference: { adapter: JSX_ADAPTER_VERSION, filePath, sourceHash, locator, start, end: node.end, original: source.slice(start, node.end), encoding },
      };
      result.fields.push(field);
      if (marker) fieldMarkers.set(field, marker.split("/text:")[0]!);
    }

    function inspect(node: ts.JsxElement | ts.JsxSelfClosingElement, location: string): boolean {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(file);
      if (OPAQUE_TAGS.has(tag)) { issue(node, "unsupported", `Content inside <${tag}> is not editable with this adapter.`); return false; }
      // Custom components can interpret props/children arbitrarily. Their native
      // descendants may still be independently editable source elements.
      if (!/^[a-z][a-z0-9]*$/.test(tag)) { issue(opening, "unsupported", `Props and direct text of <${tag}> need a component-specific adapter.`); return true; }
      const attributes = opening.attributes.properties;
      const hasSpread = attributes.some(ts.isJsxSpreadAttribute);
      const unsafeProps = attributes.some((attribute) => ts.isJsxAttribute(attribute) && ["dangerouslySetInnerHTML", "is"].includes(attribute.name.getText(file)));
      if (hasSpread || unsafeProps) { issue(opening, "ambiguous", `Spread props, custom elements and raw HTML on <${tag}> require code review.`); return true; }
      const counts = new Map<string, number>();
      for (const attribute of attributes) if (ts.isJsxAttribute(attribute)) {
        const name = attribute.name.getText(file);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      if ([...counts.values()].some((count) => count > 1)) { issue(opening, "ambiguous", `Duplicate attributes on <${tag}> must be fixed before editing.`); return true; }
      const markerAttribute = attributes.find((attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === "data-dw-field");
      const markerValue = markerAttribute?.initializer;
      let marker: string | undefined;
      if (markerValue) {
        if (ts.isStringLiteral(markerValue) && /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(markerValue.text)) {
          marker = markerValue.text;
          markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1);
        } else { issue(markerAttribute!, "ambiguous", "Use a plain unique data-dw-field marker containing letters, numbers, dots, dashes or colons."); return true; }
      }
      for (const attribute of attributes) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const name = attribute.name.getText(file);
        if (!ATTRIBUTES[name]?.includes(tag)) continue;
        const initializer = attribute.initializer;
        if (initializer && ts.isStringLiteral(initializer)) add(initializer, name as JsxFieldKind, tag, location, marker, "jsx-attribute");
        else if (initializer && ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteral(initializer.expression)) add(initializer.expression, name as JsxFieldKind, tag, location, marker, "javascript-string", initializer.expression.text);
        else issue(attribute, "dynamic", `${tag}.${name} comes from code; this editor can change only an existing static string.`);
      }
      if (ts.isJsxElement(node)) {
        let textOrdinal = 0;
        for (const child of node.children) {
          if (ts.isJsxText(child)) {
            if (!child.text.trim()) continue;
            const suffix = `/text:${textOrdinal++}`;
            add(child, "text", tag, `${location}${suffix}`, marker ? `${marker}${suffix}` : undefined, "jsx-text");
          } else if (ts.isJsxExpression(child) && child.expression) {
            if (ts.isStringLiteral(child.expression)) {
              const suffix = `/text:${textOrdinal++}`;
              add(child.expression, "text", tag, `${location}${suffix}`, marker ? `${marker}${suffix}` : undefined, "javascript-string", child.expression.text);
            } else issue(child, "dynamic", `An expression inside <${tag}> stays controlled by its source code.`);
          }
        }
      }
      return true;
    }

    function segment(node: ts.Node): string {
      if (ts.isVariableStatement(node)) return `VariableStatement(${node.declarationList.declarations.map(declaration => declaration.name.getText(file)).join(",")})`;
      if (ts.isJsxElement(node)) return `Element(${node.openingElement.tagName.getText(file)})`;
      if (ts.isJsxSelfClosingElement(node)) return `Element(${node.tagName.getText(file)})`;
      if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return `${ts.SyntaxKind[node.kind]}(${node.name.getText(file)})`;
      return ts.SyntaxKind[node.kind];
    }
    function walk(node: ts.Node, location: string, depth: number): void {
      if (depth > 250) throw new Error("The source nesting is too deep for visual editing.");
      if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && !inspect(node, location)) return;
      const counts = new Map<string, number>();
      ts.forEachChild(node, (child) => {
        const key = segment(child);
        const ordinal = counts.get(key) ?? 0;
        counts.set(key, ordinal + 1);
        walk(child, `${location}/${key}[${ordinal}]`, depth + 1);
      });
    }
    walk(file, "file", 0);
    const duplicateMarkers = new Set([...markerCounts].filter(([, count]) => count > 1).map(([marker]) => marker));
    if (duplicateMarkers.size) {
      for (const marker of duplicateMarkers) result.issues.push({ code: "ambiguous", message: `The marker "${marker}" occurs more than once. All fields using it are read-only.` });
      result.fields = result.fields.filter((field) => !duplicateMarkers.has(fieldMarkers.get(field) ?? ""));
    }
    decodeLiterals(result.fields);
    result.fields = result.fields.filter((field) => field.kind !== "text" || field.value.length > 0);
    return result;
  } catch (error) {
    result.fields = [];
    result.issues.push({ code: "syntax", message: error instanceof Error ? error.message : "This source file cannot be parsed safely." });
    return result;
  }
}

/**
 * The one place a field value is judged publishable.
 *
 * Exported by kind rather than by field so that the template adapter next door
 * (`.astro`, `.vue`, `.svelte`) judges a link by exactly the same rules. Two
 * adapters with two opinions about what an `href` may contain would be two
 * editors that agree until the day they do not.
 */
export function validateFieldValue(kind: JsxFieldKind, value: string): string | undefined {
  if (value.length > MAX_VALUE_LENGTH) return "This value exceeds the 100,000 character limit.";
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return "Remove control characters from this value.";
  if (kind === "text" || kind === "alt") return undefined;
  if (!value || value.trim() !== value || /[\s\\]/.test(value)) return "Use a destination without spaces, control characters or backslashes.";
  if (value.startsWith("//")) return "Use a full https:// URL instead of a protocol-relative destination.";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (!scheme) return undefined;
  if (kind === "href" && ["mailto", "tel"].includes(scheme)) return value.length > scheme.length + 1 ? undefined : "Add an address or phone number.";
  if (scheme !== "http" && scheme !== "https") return "Only website URLs and relative paths are allowed here.";
  try {
    if (!/^https?:\/\//i.test(value) || !new URL(value).hostname) return "Use a complete website URL.";
  } catch { return "Use a valid website URL."; }
  return undefined;
}

function encode(field: JsxField, value: string): string {
  if (field.reference.encoding === "javascript-string") return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;").replace(/\}/g, "&#125;")
    .replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
  if (field.reference.encoding === "jsx-text") return escaped;
  const quote = field.reference.original[0] === "'" ? "'" : '"';
  return `${quote}${escaped.replace(/"/g, "&quot;").replace(/'/g, "&#39;")}${quote}`;
}

/** Atomic: any stale, unknown, duplicate, unsafe or non-round-tripping edit
 * returns the original source and no changed IDs. Always rediscover after an
 * accepted edit; the resulting file has a different source hash and offsets. */
export function applyJsxValues(source: string, request: { filePath: string; sourceHash: string; changes: readonly JsxChange[] }): JsxApplyResult {
  const unchanged = (problems: JsxEditProblem[]): JsxApplyResult => ({ source, changed: [], problems });
  if (request.sourceHash !== hash(source)) return unchanged([{ code: "stale", message: "The source file changed after these edits were prepared. Reload it and review the edits again." }]);
  if (!Array.isArray(request.changes) || request.changes.length > MAX_EDITS) return unchanged([{ code: "invalid", message: "Submit at most 500 field changes at once." }]);
  let discovery: JsxDiscovery;
  try { discovery = discoverJsxFields(source, request.filePath); }
  catch (error) { return unchanged([{ code: "source", message: error instanceof Error ? error.message : "Invalid source file." }]); }
  if (discovery.issues.some((issue) => issue.code === "syntax" || issue.code === "limit")) return unchanged([{ code: "source", message: discovery.issues.map((issue) => issue.message).join(" ") }]);
  const byId = new Map(discovery.fields.map((field) => [field.id, field]));
  const seen = new Set<string>();
  const problems: JsxEditProblem[] = [];
  const edits: { field: JsxField; value: string; replacement: string }[] = [];
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
  const after = discoverJsxFields(output, discovery.filePath);
  const afterFields = new Map(after.fields.map((field) => [field.id, field]));
  const wanted = new Map(edits.map((edit) => [edit.field.id, edit.value]));
  if (after.issues.some((issue) => issue.code === "syntax" || issue.code === "limit") || after.fields.length !== discovery.fields.length || discovery.fields.some((field) => afterFields.get(field.id)?.value !== (wanted.get(field.id) ?? field.value))) {
    return unchanged([{ code: "invalid", message: "These values cannot be represented without changing the source structure. Keep a text field nonempty, or ask a developer to change its structure." }]);
  }
  return { source: output, changed: edits.map((edit) => edit.field.id).reverse(), problems: [] };
}

export type JsxHtmlMapping = {
  sourceFieldId: string;
  htmlFieldId: string;
  property: "value" | "href" | "alt";
  confidence: "marker" | "exact-value";
};
export type JsxHtmlMappingReport = {
  mappings: JsxHtmlMapping[];
  diagnostics: { sourceFieldId: string; code: "unmatched" | "ambiguous"; candidateHtmlFieldIds: string[]; message: string }[];
};

/** Conservative preview hints, NOT a compiler source map or proof of provenance.
 * Both sides must have identical tags and decoded values. Matches must be unique
 * in both directions for the given HTML property. No fuzzy text/URL matching,
 * whitespace normalization, partial-rich-text matches or positional guesses.
 * A source marker must also survive as the same unique annotated HTML marker.
 * Pass fields from every participating source file together to catch collisions.
 */
export function mapJsxFieldsToHtml(sourceFields: readonly JsxField[], htmlFields: readonly SiteField[]): JsxHtmlMappingReport {
  const report: JsxHtmlMappingReport = { mappings: [], diagnostics: [] };
  const proposed: JsxHtmlMapping[] = [];
  for (const sourceField of sourceFields) {
    const property = sourceField.kind === "href" ? "href" : sourceField.kind === "alt" ? "alt" : "value";
    const candidates = htmlFields.filter((field) => {
      if (field.tag !== sourceField.tag || (sourceField.marker && (field.confidence !== "annotated" || field.id !== sourceField.marker))) return false;
      if (sourceField.kind === "src") return field.kind === "image" && field.value === sourceField.value;
      if (sourceField.kind === "href" || sourceField.kind === "alt") return field[property] === sourceField.value;
      if (!["text", "link", "button"].includes(field.kind) || /<[^>]*>/.test(field.value)) return false;
      try { return decodeEntities(field.value) === sourceField.value; } catch { return false; }
    });
    if (candidates.length !== 1) {
      report.diagnostics.push({ sourceFieldId: sourceField.id, code: candidates.length ? "ambiguous" : "unmatched", candidateHtmlFieldIds: candidates.map((field) => field.id), message: candidates.length ? "More than one preview element has this exact value." : "No preview field has the same tag, full value and required marker." });
      continue;
    }
    proposed.push({ sourceFieldId: sourceField.id, htmlFieldId: candidates[0]!.id, property, confidence: sourceField.marker ? "marker" : "exact-value" });
  }
  const claims = new Map<string, number>();
  for (const mapping of proposed) {
    const key = JSON.stringify([mapping.htmlFieldId, mapping.property]);
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }
  for (const mapping of proposed) {
    if (claims.get(JSON.stringify([mapping.htmlFieldId, mapping.property])) !== 1) report.diagnostics.push({ sourceFieldId: mapping.sourceFieldId, code: "ambiguous", candidateHtmlFieldIds: [mapping.htmlFieldId], message: "More than one source field could have produced this preview value." });
    else report.mappings.push(mapping);
  }
  return report;
}
