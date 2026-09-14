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
import { readPage } from "./regions.js";
import type { SiteField } from "./regions.js";

export const JSX_ADAPTER_VERSION = "jsx-literal-v1" as const;
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_FIELDS = 5_000;
const MAX_EDITS = 500;
const MAX_VALUE_LENGTH = 100_000;
const OPAQUE_TAGS = new Set(["script", "style", "svg", "math", "iframe", "object", "embed", "template", "textarea"]);
const ATTRIBUTES: Record<string, readonly string[]> = { href: ["a", "area"], src: ["img", "source", "video", "audio"], alt: ["img", "area"] };

/**
 * Names that mean "words a visitor reads", on a component prop or in a data
 * object.
 *
 * An allowlist rather than "every string literal", and the difference matters:
 * `className`, `variant`, `id`, `icon` and `type` are all strings too, and all
 * of them are structure. Editing one because it happened to be a string is how
 * an editor silently breaks a design that nobody asked it to touch.
 *
 * So a name has to be recognisably content before its value is offered. A
 * component whose copy is behind a prop this does not know keeps that copy in
 * the code, which is the safe way round: the field is missing, not wrong.
 */
const CONTENT_NAMES = /^(title|titles|subtitle|subTitle|heading|subheading|subHeading|eyebrow|kicker|label|labelText|text|copy|description|desc|body|caption|quote|testimonial|author|role|company|name|cta|ctaText|ctaLabel|buttonText|buttonLabel|linkText|price|priceLabel|period|tagline|summary|message|placeholder|content|question|answer|badge|highlight|footnote|disclaimer|blurb|headline|subheadline|prefix|suffix|unit)$/;
const CONTENT_LINKS = /^(href|url|link|to|ctaHref|ctaLink|buttonHref|linkHref|action)$/;
const CONTENT_IMAGES = /^(src|image|imageUrl|imageSrc|img|logo|avatar|icon?Url|photo|picture|thumbnail|poster)$/;
const CONTENT_ALTS = /^(alt|altText|imageAlt|ariaLabel|aria-label)$/;

/** Which kind of field a content-ish name is, or null when the name is structure.
 * Exported so the template adapter judges an `.astro` or `.vue` component prop
 * by the same list — one answer to "is this content?", not two. */
export function contentKind(name: string): JsxFieldKind | null {
  if (CONTENT_ALTS.test(name)) return "alt";
  if (CONTENT_LINKS.test(name)) return "href";
  if (CONTENT_IMAGES.test(name)) return "src";
  if (CONTENT_NAMES.test(name)) return "text";
  return null;
}

export type JsxFieldKind = "text" | "href" | "src" | "alt";
/**
 * `javascript-template` is a backtick literal with no `${}` in it. It is a
 * static string like any other, and it used to be refused only because writing
 * it back as `"…"` would have changed how the file reads. It is written back
 * between backticks instead, so the file keeps the shape its author gave it.
 */
type Encoding = "jsx-text" | "jsx-attribute" | "javascript-string" | "javascript-template";
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
  /**
   * Where the literal sits: in markup, or in a data object.
   *
   * It decides what the field's `tag` is worth. A literal in markup has a real
   * tag — the element that will render it — and the mapper uses it to tell two
   * identical strings apart. A literal in a data array has no tag at all: the
   * element it ends up in is chosen by whichever component maps over the array,
   * which may be in another file entirely, and the `tag` recorded for it is the
   * name of the variable it was declared in. Comparing that to `h3` would refuse
   * every match, which is exactly what used to happen to a page whose cards live
   * in `data/cards.ts`.
   *
   * So a data field is matched on value alone. That is not a weaker rule than it
   * looks: the mapper already requires a match to be unique in both directions,
   * and uniqueness, not the tag, is what makes a match safe.
   */
  origin: "markup" | "data";
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

export function jsxSourceHash(value: string): string { return hash(value); }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function checkedJsxPath(filePath: string): string { return checkedPath(filePath); }
function checkedPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /[:\x00-\x1f\x7f]/.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Choose a file path relative to the connected repository.");
  }
  // `.ts` and `.js` are here for the content files half of these projects keep
  // their words in — `src/data/site.ts` has no markup in it and used to be a
  // file with nothing to edit. Nothing is executed either way; the compiler only
  // ever parses.
  if (!/\.(jsx|tsx|ts|js|mjs|cjs)$/i.test(normalized)) throw new Error("This adapter accepts .jsx, .tsx, .ts and .js source files.");
  return normalized;
}

export function jsxCompilerOptions(): ts.CompilerOptions { return compilerOptions(); }
function compilerOptions(): ts.CompilerOptions {
  return { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, newLine: ts.NewLineKind.LineFeed };
}

/** Decode with the same JSX rules as the compiler, including named entities and
 * multiline whitespace. The generated JavaScript is parsed, NEVER executed. */
function decodeLiterals(fields: JsxField[]): void {
  const literals = fields.filter((field) => field.reference.encoding !== "javascript-string" && field.reference.encoding !== "javascript-template");
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
    const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, /\.tsx$/i.test(filePath) ? ts.ScriptKind.TSX : /\.ts$/i.test(filePath) ? ts.ScriptKind.TS : ts.ScriptKind.JSX);
    const markerCounts = new Map<string, number>();
    const fieldMarkers = new Map<JsxField, string>();
    /**
     * Static strings declared once and used in the markup by name.
     *
     * `<Hero title={hero.title} />` and `<h1>{TAGLINE}</h1>` are the same words
     * a visitor reads as `<h1>Welcome</h1>` is, written the way a generator
     * writes them. Refusing them left a customer looking at "this is built by
     * its code" over their own sentence, so the value is followed back to the
     * literal it was declared as and that literal is the field.
     *
     * Only what can be followed with certainty: a `const` in this file holding
     * a plain string, or a plain string at a fixed key path inside a `const`
     * object. Nothing is executed, nothing is imported, and a name declared
     * twice in the file is dropped rather than guessed at — a shadowed name is
     * exactly the case where following it would edit the wrong sentence.
     */
    type StaticLiteral = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
    const constants = new Map<string, StaticLiteral>();
    const shadowed = new Set<string>();
    const unwrap = (node: ts.Expression): ts.Expression => {
      let current = node;
      while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
      return current;
    };
    const isStatic = (node: ts.Node): node is StaticLiteral => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
    const remember = (path: string, literal: StaticLiteral) => {
      if (constants.has(path) || shadowed.has(path)) { shadowed.add(path); constants.delete(path); return; }
      constants.set(path, literal);
    };
    const collectObject = (object: ts.ObjectLiteralExpression, path: string, depth: number): void => {
      if (depth > 8) return;
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
        if (key === null) continue;
        const value = unwrap(property.initializer);
        if (isStatic(value)) remember(`${path}.${key}`, value);
        else if (ts.isObjectLiteralExpression(value)) collectObject(value, `${path}.${key}`, depth + 1);
      }
    };
    const collectConstants = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = unwrap(node.initializer);
        if (isStatic(value)) remember(node.name.text, value);
        else if (ts.isObjectLiteralExpression(value)) collectObject(value, node.name.text, 0);
      }
      ts.forEachChild(node, collectConstants);
    };
    collectConstants(file);

    /** The dotted path an expression names, or null when it names nothing fixed. */
    const pathOf = (node: ts.Expression): string | null => {
      const expression = unwrap(node);
      if (ts.isIdentifier(expression)) return expression.text;
      if (ts.isPropertyAccessExpression(expression)) {
        const base = pathOf(expression.expression);
        return base === null ? null : `${base}.${expression.name.text}`;
      }
      if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
        const base = pathOf(expression.expression);
        return base === null ? null : `${base}.${expression.argumentExpression.text}`;
      }
      return null;
    };
    /** The literal an expression stands for: itself, or the constant it names. */
    const resolveLiteral = (node: ts.Expression): { literal: StaticLiteral; path?: string } | null => {
      const expression = unwrap(node);
      if (isStatic(expression)) return { literal: expression };
      const path = pathOf(expression);
      const literal = path === null ? undefined : constants.get(path);
      return literal ? { literal, path: path! } : null;
    };
    /** One literal is one field however many places name it, so two references
     * to the same `const` are one thing to type into rather than two that fight. */
    const fieldsByLiteral = new Map<number, JsxField>();
    const issue = (node: ts.Node, code: JsxIssue["code"], message: string) => {
      if (result.issues.length >= 100) return;
      const point = file.getLineAndCharacterOfPosition(node.getStart(file));
      result.issues.push({ code, message, line: point.line + 1, column: point.character + 1 });
    };

    function add(node: ts.Node, kind: JsxFieldKind, tag: string, location: string, marker: string | undefined, encoding: Encoding, value = "", label?: string, origin: JsxField["origin"] = "markup") {
      if (result.fields.length >= MAX_FIELDS) throw new Error("This file has too many literal fields to edit safely.");
      const start = ts.isJsxText(node) ? node.pos : node.getStart(file);
      // A literal already offered under another name is that same literal, and
      // offering it twice would put two fields over one span — which the write
      // path refuses as overlapping ranges.
      if (fieldsByLiteral.has(start)) return;
      const locator = `${marker ? `marker:${marker}` : `ast:${location}`}/${kind}`;
      const field: JsxField = {
        id: `jsx_${hash(`${filePath}\0${locator}`).slice(0, 32)}`,
        kind, tag, label: label ?? `${tag} ${kind}`, value, ...(marker && { marker: marker.split("/text:")[0]!.split("/prop:")[0] }), confidence: marker ? "explicit" : "structural", origin,
        reference: { adapter: JSX_ADAPTER_VERSION, filePath, sourceHash, locator, start, end: node.end, original: source.slice(start, node.end), encoding },
      };
      result.fields.push(field);
      fieldsByLiteral.set(start, field);
      if (marker) fieldMarkers.set(field, marker.split("/text:")[0]!.split("/prop:")[0]!);
    }

    /**
     * Offer a value wherever it was written: as a literal in place, or as the
     * constant it names. Returns false when nothing static could be followed,
     * which is the only case that is still reported as coming from the code.
     *
     * A followed literal is identified by where it is *declared*, not by where
     * it is used — two usages of one `const` must be one field, and a locator
     * naming the usage would have made two.
     */
    function addValue(expression: ts.Expression, kind: JsxFieldKind, tag: string, location: string, marker: string | undefined, label?: string): boolean {
      const resolved = resolveLiteral(expression);
      if (!resolved) {
        // Fold only self-contained string expressions. References, calls and
        // runtime values must retain their behavior and are never replaced.
        const staticText = (node: ts.Expression, depth = 0): string | null => {
          if (depth > 32) return null;
          const value = unwrap(node);
          if (isStatic(value)) return value.text;
          if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const left = staticText(value.left, depth + 1);
            const right = staticText(value.right, depth + 1);
            return left === null || right === null ? null : left + right;
          }
          if (ts.isTemplateExpression(value)) {
            let text = value.head.text;
            for (const span of value.templateSpans) {
              const part = staticText(span.expression, depth + 1);
              if (part === null) return null;
              text += part + span.literal.text;
            }
            return text;
          }
          return null;
        };
        const value = staticText(expression);
        if (value === null) return false;
        add(expression, kind, tag, location, marker, "javascript-string", value, label);
        return true;
      }
      const { literal, path } = resolved;
      const encoding: Encoding = ts.isNoSubstitutionTemplateLiteral(literal) ? "javascript-template" : "javascript-string";
      if (path) {
        const existing = fieldsByLiteral.get(literal.getStart(file));
        if (existing) return true;
        add(literal, kind, tag, `const:${path}`, undefined, encoding, literal.text, label ?? path, "data");
        return true;
      }
      add(literal, kind, tag, location, marker, encoding, literal.text, label);
      return true;
    }

    /** The element's own data-dw-field, counted like any other marker so a
     * duplicate one makes every field that uses it read-only rather than wrong. */
    function componentMarkerOf(properties: readonly ts.JsxAttributeLike[]): string | undefined {
      const attribute = properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(file) === "data-dw-field");
      const initializer = attribute?.initializer;
      if (!initializer || !ts.isStringLiteral(initializer) || !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(initializer.text)) return undefined;
      markerCounts.set(initializer.text, (markerCounts.get(initializer.text) ?? 0) + 1);
      return initializer.text;
    }

    function inspect(node: ts.JsxElement | ts.JsxSelfClosingElement, location: string): boolean {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(file);
      if (OPAQUE_TAGS.has(tag)) { issue(node, "unsupported", `Content inside <${tag}> is not editable with this adapter.`); return false; }
      // Custom components can interpret props/children arbitrarily. Their native
      // descendants may still be independently editable source elements.
      if (!/^[a-z][a-z0-9]*$/.test(tag)) {
        // A component decides what its props mean, so most of them stay code.
        // The exception earns itself: a prop whose NAME says it is words a
        // visitor reads, holding a plain string literal. That is where an
        // AI-built site keeps most of its copy — `<Hero title="…" />` — and
        // refusing all of it leaves a customer looking at an empty field list
        // beside a page full of their own writing.
        const properties = opening.attributes.properties;
        if (properties.some(ts.isJsxSpreadAttribute)) { issue(opening, "ambiguous", `Spread props on <${tag}> require code review.`); return true; }
        // A marker on the component is what lets its prop be found again on the
        // rendered page: the component decides its own tag, so nothing else
        // about `<Hero title="…" />` predicts the <h1> a visitor sees.
        const componentMarker = componentMarkerOf(properties);
        let offered = 0;
        for (const attribute of properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          const name = attribute.name.getText(file);
          const kind = contentKind(name);
          if (!kind) continue;
          const marked = componentMarker ? `${componentMarker}/prop:${name}` : undefined;
          const initializer = attribute.initializer;
          if (initializer && ts.isStringLiteral(initializer)) { add(initializer, kind, tag, `${location}/prop:${name}`, marked, "jsx-attribute", "", `${tag} ${name}`); offered += 1; }
          else if (initializer && ts.isJsxExpression(initializer) && initializer.expression && addValue(initializer.expression, kind, tag, `${location}/prop:${name}`, marked, `${tag} ${name}`)) offered += 1;
          else issue(attribute, "dynamic", `${tag}.${name} comes from code; this editor can change only an existing static string.`);
        }
        if (!offered) issue(opening, "unsupported", `Props and direct text of <${tag}> need a component-specific adapter.`);
        return true;
      }
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
        else if (initializer && ts.isJsxExpression(initializer) && initializer.expression && addValue(initializer.expression, name as JsxFieldKind, tag, location, marker)) continue;
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
            const suffix = `/text:${textOrdinal}`;
            if (addValue(child.expression, "text", tag, `${location}${suffix}`, marker ? `${marker}${suffix}` : undefined)) textOrdinal += 1;
            else issue(child, "dynamic", `An expression inside <${tag}> stays controlled by its source code.`);
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
    /**
     * Content held in a data object rather than in markup.
     *
     * The other place an AI-built site keeps its words: a list hoisted out of
     * the markup and mapped over.
     *
     *     const features = [{ title: "Fast", description: "Very fast" }];
     *
     * None of that is a JSX literal, so none of it was editable, and on a
     * Lovable or Bolt export that can be most of the page. The same allowlist
     * decides — a key has to read as content — and the same round-trip check
     * afterwards refuses anything that did not go back cleanly.
     *
     * The key is in the locator, so reordering an object's keys does not
     * renumber anybody's fields; the entry's position in its array is not, so
     * reordering the array does. That is the honest trade: a moved entry
     * becomes a different field rather than silently inheriting another's edit.
     */
    function inspectData(node: ts.PropertyAssignment, location: string, scope: string): void {
      const rawName = node.name.getText(file).replace(/^['"`]|['"`]$/g, "");
      const kind = contentKind(rawName);
      if (!kind) return;
      const initializer = node.initializer;
      if (!ts.isStringLiteral(initializer) && !ts.isNoSubstitutionTemplateLiteral(initializer)) return;
      // A backtick literal is written back as one, so the file keeps the shape
      // its author gave it rather than being quietly requoted.
      const encoding: Encoding = ts.isNoSubstitutionTemplateLiteral(initializer) ? "javascript-template" : "javascript-string";
      add(initializer, kind, scope || "data", `${location}/key:${rawName}`, undefined, encoding, initializer.text, scope ? `${scope} ${rawName}` : rawName, "data");
    }

    function walk(node: ts.Node, location: string, depth: number, scope = ""): void {
      if (depth > 250) throw new Error("The source nesting is too deep for visual editing.");
      if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && !inspect(node, location)) return;
      if (ts.isPropertyAssignment(node)) inspectData(node, location, scope);
      // `const tagline = "…"` — content held in a plain variable rather than in
      // an object. Same allowlist decides, so `const className = "…"` is still
      // structure and stays out.
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const kind = contentKind(node.name.text);
        const value = unwrap(node.initializer);
        if (kind && isStatic(value)) {
          add(value, kind, node.name.text, `const:${node.name.text}`, undefined, ts.isNoSubstitutionTemplateLiteral(value) ? "javascript-template" : "javascript-string", value.text, node.name.text, "data");
        }
      }
      const counts = new Map<string, number>();
      ts.forEachChild(node, (child) => {
        const key = segment(child);
        const ordinal = counts.get(key) ?? 0;
        counts.set(key, ordinal + 1);
        // The name of the nearest declaration a data object sits in, which is
        // what a person reads on the field: "features title", not "title".
        const inner = (ts.isVariableDeclaration(child) || ts.isFunctionDeclaration(child)) && child.name && ts.isIdentifier(child.name) ? child.name.text : scope;
        walk(child, `${location}/${key}[${ordinal}]`, depth + 1, inner);
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
  // A backtick literal stays one. Backslash first, then the two sequences that
  // would otherwise end the literal or open a substitution in it.
  if (field.reference.encoding === "javascript-template") return `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
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

/**
 * An edit made against a rendered page, written into the source it came from.
 *
 * This is the bridge the visual editor crosses on a framework site. It is given
 * the file, the HTML that was built from it, and the draft as the editor keeps
 * it — values keyed by the *rendered* page's field ids — and it turns those into
 * changes to literals in the file.
 *
 * It refuses rather than approximates. An edit with nowhere to go — a style, a
 * reordered section, a heading the mapper could not trace — fails the whole
 * publish with a sentence naming the part, because the alternative is a publish
 * that silently drops half of what somebody did and reports success.
 *
 * Markup cannot cross either. A literal in a source file is plain text, so a
 * heading somebody made half-bold in the editor is a change to the code, not to
 * a string, and it is refused as one.
 */
export type HtmlFieldEdit = { value?: string; href?: string; alt?: string; style?: string; variant?: string | null; newTab?: boolean; responsive?: unknown; structure?: unknown };
export type UnmappableEdit = { htmlFieldId: string; part: string; message: string };

/** The parts of an edit that are markup rather than content, and why each one
 * cannot be written into a `.tsx`. Listed by name so the message can say which. */
const CODE_MANAGED: Record<string, string> = {
  style: "Styling on this page is written by its code — a class, a stylesheet or a design token — so there is no value here to change.",
  variant: "This button’s style comes from its component, not from this page.",
  newTab: "Whether a link opens in a new tab is set in the code for this page.",
  responsive: "Responsive styling is written by the project’s own stylesheets.",
  structure: "Adding, moving or removing a section changes the code that builds this page.",
};

export function applyHtmlEditsAsJsx(input: {
  source: string;
  filePath: string;
  /** The rendered page the edits were made against. */
  html: string;
  edits: Record<string, HtmlFieldEdit>;
  requireMarker?: boolean;
}): JsxApplyResult & { unmappable: UnmappableEdit[]; changes: JsxChange[] } {
  const refuse = (problems: JsxEditProblem[], unmappable: UnmappableEdit[] = []): JsxApplyResult & { unmappable: UnmappableEdit[]; changes: JsxChange[] } =>
    ({ source: input.source, changed: [], problems, unmappable, changes: [] });

  let discovery: JsxDiscovery;
  try { discovery = discoverJsxFields(input.source, input.filePath); }
  catch (error) { return refuse([{ code: "source", message: error instanceof Error ? error.message : "Invalid source file." }]); }
  if (discovery.issues.some((issue) => issue.code === "syntax" || issue.code === "limit")) {
    return refuse([{ code: "source", message: discovery.issues.filter((issue) => issue.code === "syntax" || issue.code === "limit").map((issue) => issue.message).join(" ") }]);
  }

  const htmlFields = readPage(input.html).fields;
   const report = mapJsxFieldsToHtml(discovery.fields, htmlFields, { requireMarker: input.requireMarker });
  const byTarget = new Map(report.mappings.map((mapping) => [`${mapping.htmlFieldId}\\u0000${mapping.property}`, mapping]));
  const labels = new Map(htmlFields.map((field) => [field.id, field.label]));

  const changes: JsxChange[] = [];
  const unmappable: UnmappableEdit[] = [];
  for (const [htmlFieldId, edit] of Object.entries(input.edits)) {
    const where = labels.get(htmlFieldId) ?? "a field on this page";
    for (const [part, raw] of Object.entries(edit)) {
      if (raw === undefined) continue;
      if (CODE_MANAGED[part]) { unmappable.push({ htmlFieldId, part, message: `${where}: ${CODE_MANAGED[part]}` }); continue; }
      if (part !== "value" && part !== "href" && part !== "alt") { unmappable.push({ htmlFieldId, part, message: `${where}: this kind of change is written by the code for this page.` }); continue; }
      const mapping = byTarget.get(`${htmlFieldId}\\u0000${part}`);
      if (!mapping) {
        unmappable.push({ htmlFieldId, part, message: `${where}: this came from the code rather than from a piece of text in ${input.filePath}, so it cannot be changed here.` });
        continue;
      }
      const value = String(raw);
      if (part === "value" && /<[a-z!/][^>]*>/i.test(value)) {
        unmappable.push({ htmlFieldId, part, message: `${where}: formatting inside these words would change the page’s code. Keep it as plain text, or ask a developer.` });
        continue;
      }
      changes.push({ fieldId: mapping.sourceFieldId, value: part === "value" ? decodeEntities(value) : value });
    }
  }

  // All or nothing. A publish that wrote the three changes it understood and
  // dropped the fourth would be a page that is half of what somebody approved.
  if (unmappable.length) return refuse([], unmappable);
  if (!changes.length) return refuse([{ code: "invalid", message: "None of these edits change anything in the source file." }]);
  const applied = applyJsxValues(input.source, { filePath: discovery.filePath, sourceHash: discovery.sourceHash, changes });
  return { ...applied, unmappable: [], changes };
}

export type JsxHtmlMapping = {
  sourceFieldId: string;
  htmlFieldId: string;
  property: "value" | "href" | "alt";
  /**
   * How the rendered element was identified.
   *
   *  - `marker` — the author's (or the editor's) `data-dw-field`, carried into
   *    the HTML. The only identity that survives the words themselves changing.
   *  - `exact-value` — one literal, one element, same tag and same full value,
   *    unique in both directions.
   *  - `positional` — several elements share the words exactly, and exactly as
   *    many literals in one file produce them, so the nth is the nth. Used only
   *    when the counts agree exactly and only one file is in the running.
   */
  confidence: "marker" | "exact-value" | "positional";
  /**
   * The bytes in the source file this rendered value came from.
   *
   * Carried so that an edit made against the HTML knows what it is about to
   * replace without re-deriving it — the mapping and the write then cannot come
   * to disagree about which literal a change belongs to.
   */
  span: { start: number; end: number };
};
export type JsxHtmlMappingReport = {
  mappings: JsxHtmlMapping[];
  diagnostics: { sourceFieldId: string; code: "unmatched" | "ambiguous"; candidateHtmlFieldIds: string[]; message: string }[];
};

/** Conservative preview hints, NOT a compiler source map or proof of provenance.
 * A source marker matches by id alone — its tags may differ, because a marked
 * component (`<Hero data-dw-field="x">`) renders a native element (`<h1 ...>`) —
 * while an unmarked literal still has to agree on tag and decoded value. Matches
 * must be unique in both directions for the given HTML property. No fuzzy
 * text/URL matching, whitespace normalization, partial-rich-text matches or
 * positional guesses. A source marker must also survive as the same unique
 * annotated HTML marker. Pass fields from every participating source file
 * together to catch collisions.
 */
export function mapJsxFieldsToHtml(sourceFields: readonly JsxField[], htmlFields: readonly SiteField[], options: { requireMarker?: boolean } = {}): JsxHtmlMappingReport {
  const report: JsxHtmlMappingReport = { mappings: [], diagnostics: [] };
  const namedTargets = new Set(sourceFields.filter(field => field.marker).map(field => JSON.stringify([
    field.marker, field.kind === "href" ? "href" : field.kind === "alt" ? "alt" : "value",
  ])));
  const proposed: JsxHtmlMapping[] = [];
  /** Source fields whose value matches none or several elements, kept for the
   * counting pass rather than refused where they were found. */
  const deferred: { sourceField: JsxField; property: JsxHtmlMapping["property"]; candidates: SiteField[] }[] = [];
  for (const sourceField of sourceFields) {
    // Marker discipline, when the caller asks for it: only a literal the author
    // has named with `data-dw-field` may be written through a rendered page.
    // Value matching is good enough to *show* somebody where their words came
    // from; it is not good enough to commit a change on, once a generator can be
    // told to name them instead.
    if (options.requireMarker && !sourceField.marker) {
      report.diagnostics.push({ sourceFieldId: sourceField.id, code: "unmatched", candidateHtmlFieldIds: [], message: "This literal has no data-dw-field marker, so a change made on the rendered page cannot be traced back to it." });
      continue;
    }
    const property = sourceField.kind === "href" ? "href" : sourceField.kind === "alt" ? "alt" : "value";
    const candidates = htmlFields.filter((field) => {
      // An explicit identity outranks another file's coincidentally equal
      // words, including strings discovered in imported content objects.
      if (!sourceField.marker && field.confidence === "annotated" && namedTargets.has(JSON.stringify([field.id, property]))) return false;
      // A marker is the faithful identity. A component marked `<Hero data-dw-field="x">`
      // renders a native element carrying the same marker, so the tags differ and
      // only the marker is trusted — without it, an identical string in a different
      // element would be matched to the wrong literal.
      if (sourceField.marker) { if (field.confidence !== "annotated" || field.id !== sourceField.marker) return false; }
      // A literal declared in a data object has no tag to compare — the element
      // it renders into is chosen by whichever component maps over the array.
      // Its value has to be unique in both directions, which it does below, and
      // that is the property that makes the match safe.
      else if (sourceField.origin !== "data" && field.tag !== sourceField.tag) return false;
      if (sourceField.kind === "src") return field.kind === "image" && field.value === sourceField.value;
      if (sourceField.kind === "href" || sourceField.kind === "alt") return field[property] === sourceField.value;
      if (!["text", "link", "button"].includes(field.kind) || /<[^>]*>/.test(field.value)) return false;
      try { return decodeEntities(field.value) === sourceField.value; } catch { return false; }
    });
    if (candidates.length !== 1) {
      // Held back rather than refused outright: several elements saying exactly
      // the same words may still be resolved by counting, below.
      deferred.push({ sourceField, property, candidates });
      continue;
    }
    proposed.push({ sourceFieldId: sourceField.id, htmlFieldId: candidates[0]!.id, property, confidence: sourceField.marker ? "marker" : "exact-value", span: { start: sourceField.reference.start, end: sourceField.reference.end } });
  }
  const claims = new Map<string, number>();
  for (const mapping of proposed) {
    const key = JSON.stringify([mapping.htmlFieldId, mapping.property]);
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }
  const byId = new Map(sourceFields.map((field) => [field.id, field]));
  for (const mapping of proposed) {
    if (claims.get(JSON.stringify([mapping.htmlFieldId, mapping.property])) !== 1) {
      // Two literals, one element, same words. Also a counting problem, so it
      // joins the same pass rather than ending here.
      const sourceField = byId.get(mapping.sourceFieldId)!;
      const candidate = htmlFields.find((field) => field.id === mapping.htmlFieldId);
      deferred.push({ sourceField, property: mapping.property, candidates: candidate ? [candidate] : [] });
    } else report.mappings.push(mapping);
  }
  resolveByCounting(deferred, report, htmlFields);
  return report;
}

/** The file a field came from, when the page-shaped layer added one. One file
 * at a time is the whole safety of the counting rule, so a field with no file
 * recorded is treated as its own file and never grouped with another. */
function fileOf(field: JsxField): string {
  const named = (field as JsxField & { filePath?: unknown }).filePath;
  return typeof named === "string" ? named : field.reference.filePath;
}

/**
 * The nth of several identical strings.
 *
 * Three "Get started" buttons rendered from three literals in one file is not
 * genuinely ambiguous — it only looks that way to a matcher comparing values.
 * The page has three, the file has three, and they were written in the order
 * they render in, so the nth is the nth.
 *
 * What makes that safe rather than a guess is the three conditions it refuses
 * on, every one of which is a case where the count is not the answer:
 *
 *  - **the counts must agree exactly.** Four elements from three literals means
 *    one of them came from somewhere this does not know about — a loop, a
 *    component used twice — and the pairing would be off by one from that point
 *    down the page.
 *  - **one file only.** Two files each holding "Get started" cannot be told
 *    apart by position on a page that interleaves them.
 *  - **no element already claimed.** An element matched by marker or by a value
 *    unique in both directions keeps that match; counting never overrides an
 *    identity that was actually established.
 *
 * A pairing made this way is recorded as `positional`, so a caller that wants
 * only named identities can still tell the difference.
 */
function resolveByCounting(
  deferred: readonly { sourceField: JsxField; property: JsxHtmlMapping["property"]; candidates: SiteField[] }[],
  report: JsxHtmlMappingReport,
  htmlFields: readonly SiteField[],
): void {
  const claimed = new Set(report.mappings.map((mapping) => JSON.stringify([mapping.htmlFieldId, mapping.property])));
  const groups = new Map<string, typeof deferred[number][]>();
  for (const entry of deferred) {
    const key = JSON.stringify([entry.property, entry.sourceField.kind, entry.sourceField.value]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const order = new Map(htmlFields.map((field, index) => [field.id, index]));
  for (const entries of groups.values()) {
    const files = new Set(entries.map((entry) => fileOf(entry.sourceField)));
    // Every element any member of the group could have produced, in the order
    // they appear on the page, minus any already spoken for.
    const targets = [...new Map(entries.flatMap((entry) => entry.candidates).map((field) => [field.id, field])).values()]
      .filter((field) => !claimed.has(JSON.stringify([field.id, entries[0]!.property])))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    if (files.size !== 1 || targets.length !== entries.length || !entries.length) {
      for (const entry of entries) {
        report.diagnostics.push({
          sourceFieldId: entry.sourceField.id,
          code: entry.candidates.length ? "ambiguous" : "unmatched",
          candidateHtmlFieldIds: entry.candidates.map((field) => field.id),
          message: entry.candidates.length
            ? "These words appear more than once on this page and the copies could not be counted off one for one against the code, so this one cannot be traced."
            : "No preview field has the same tag, full value and required marker.",
        });
      }
      continue;
    }
    // Source order is the file's own order; `sourceFields` arrives in it.
    const inOrder = [...entries].sort((a, b) => a.sourceField.reference.start - b.sourceField.reference.start);
    inOrder.forEach((entry, index) => {
      const target = targets[index]!;
      claimed.add(JSON.stringify([target.id, entry.property]));
      report.mappings.push({
        sourceFieldId: entry.sourceField.id,
        htmlFieldId: target.id,
        property: entry.property,
        confidence: "positional",
        span: { start: entry.sourceField.reference.start, end: entry.sourceField.reference.end },
      });
    });
  }
}
