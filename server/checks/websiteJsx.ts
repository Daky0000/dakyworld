/** No database, network, repository code execution or framework build required.
 * The VM below executes only the fixed fixtures in this file to check actual
 * compiled JSX behavior. The production adapter never evaluates source code.
 * Run: npx tsx checks/websiteJsx.ts
 */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { applyJsxValues, discoverJsxFields, mapJsxFieldsToHtml, readPage, type JsxDiscovery, type JsxField } from "../src/services/website/index.js";

let passed = 0;
function check(name: string, run: () => void) {
  try { run(); passed++; }
  catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
function field(discovery: JsxDiscovery, value: string, kind?: JsxField["kind"]): JsxField {
  const found = discovery.fields.find((candidate) => candidate.value === value && (!kind || candidate.kind === kind));
  assert.ok(found, `Expected ${kind ?? "literal"} field ${JSON.stringify(value)}: ${JSON.stringify(discovery)}`);
  return found;
}
function edit(source: string, value: string, next: string, filePath = "src/Page.tsx", kind?: JsxField["kind"]) {
  const discovery = discoverJsxFields(source, filePath);
  return applyJsxValues(source, { filePath, sourceHash: discovery.sourceHash, changes: [{ fieldId: field(discovery, value, kind).id, value: next }] });
}
type Rendered = { tag: string; props: Record<string, unknown> | null; children: unknown[] };
function renderFixture(source: string): Rendered {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.None }, fileName: "fixture.tsx" }).outputText;
  const sandbox = { result: undefined as Rendered | undefined, React: { createElement: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props, children }) } };
  runInNewContext(js, sandbox, { timeout: 1000 });
  assert.ok(sandbox.result);
  return sandbox.result;
}

const fixture = '\uFEFF// retain this exact header\r\nconst answer: number = 42;\r\nconst Page = () => (<main>\r\n  <h1 data-dw-field="hero.title">Build &amp; grow</h1>\r\n  <a href=\'/about\' className="btn">Read more</a>\r\n  <img src={"/logo.png"} alt="Company logo" />\r\n</main>);\r\n';

check("discovers native literal text and existing href/src/alt, retaining exact offsets", () => {
  const discovery = discoverJsxFields(fixture, "src/Page.tsx");
  assert.deepEqual(discovery.issues, []);
  assert.equal(discovery.fields.length, 5); // heading, link words + href, image src + alt
  assert.equal(field(discovery, "Build & grow").confidence, "explicit");
  assert.equal(field(discovery, "Build & grow").marker, "hero.title");
  for (const literal of discovery.fields) assert.equal(fixture.slice(literal.reference.start, literal.reference.end), literal.reference.original);
});
check("no-op round-trips every byte, BOM, CRLF and quote choice", () => {
  const discovery = discoverJsxFields(fixture, "src/Page.tsx");
  const result = applyJsxValues(fixture, { filePath: discovery.filePath, sourceHash: discovery.sourceHash, changes: discovery.fields.map((literal) => ({ fieldId: literal.id, value: literal.value })) });
  assert.deepEqual(result, { source: fixture, changed: [], problems: [] });
});
check("one content edit changes only the owned span", () => {
  const result = edit(fixture, "Build & grow", "Design & deliver");
  assert.deepEqual(result.problems, []);
  assert.equal(result.source, fixture.replace("Build &amp; grow", "Design &amp; deliver"));
  assert.equal(result.changed.length, 1);
});
check("multiple edits use original offsets and preserve untouched attributes/code", () => {
  const discovery = discoverJsxFields(fixture, "src/Page.tsx");
  const result = applyJsxValues(fixture, { filePath: discovery.filePath, sourceHash: discovery.sourceHash, changes: [
    { fieldId: field(discovery, "/about").id, value: "/team?group=a&show=b" },
    { fieldId: field(discovery, "Build & grow").id, value: "A much longer heading" },
    { fieldId: field(discovery, "/logo.png").id, value: "/images/new.png" },
  ] });
  assert.deepEqual(result.problems, []);
  assert.equal(result.source, fixture.replace("Build &amp; grow", "A much longer heading").replace("'/about'", "'/team?group=a&amp;show=b'").replace('"/logo.png"', '"/images/new.png"'));
});
check("offsets remain correct after surrogate pairs and emoji", () => {
  const source = 'const title = "😀"; const Page = () => <h1>Hello 🌍</h1>;';
  assert.equal(edit(source, "Hello 🌍", "Hello Ghana 🇬🇭").source, source.replace("Hello 🌍", "Hello Ghana 🇬🇭"));
});
check("JSX whitespace and full named entities agree with compiled rendering", () => {
  const source = 'globalThis.result = <p>\n  First &eacute; &Omega; &nbsp; &amp;\n  second &#x1F680;\n</p>;';
  const discovery = discoverJsxFields(source, "Page.jsx");
  assert.equal(discovery.fields[0]?.value, renderFixture(source).children[0]);
});
check("static JavaScript string expressions are distinct from dynamic expressions", () => {
  const source = 'const Page = () => <main><p>{"Line\\nwith \\"quotes\\""}</p><p>{name}</p><a href={"/static"}>Static</a><a href={path}>Dynamic</a></main>;'.replace('\\"quotes\\"', '\\"quotes\\"');
  // A straightforward fixture with escaped JS literals, then true expressions.
  const clean = `const Page = () => <main><p>{'Line\\nwith "quotes"'}</p><p>{name}</p><a href={"/static"}>Static</a><a href={path}>Dynamic</a></main>;`;
  const discovery = discoverJsxFields(clean, "Page.tsx");
  assert.ok(source.length > 0);
  assert.equal(field(discovery, 'Line\nwith "quotes"').reference.encoding, "javascript-string");
  assert.equal(field(discovery, "/static").kind, "href");
  assert.equal(discovery.issues.filter((issue) => issue.code === "dynamic").length, 2);
  assert.ok(!discovery.fields.some((literal) => literal.value === "name" || literal.value === "path"));
});
check("untrusted text remains display text after JSX compilation", () => {
  const source = 'globalThis.result = <p>Hello</p>;';
  const attack = '<script>alert(1)</script>{globalThis.attack = true}&copy; "quotes"\nnext\tcell';
  const result = edit(source, "Hello", attack);
  assert.deepEqual(result.problems, []);
  assert.equal(renderFixture(result.source).children[0], attack);
  assert.ok(!result.source.includes("<script>"));
  assert.ok(!result.source.includes("{globalThis.attack"));
});
check("JS string replacement cannot escape the expression", () => {
  const source = `globalThis.result = <p>{'Hello'}</p>;`;
  const attack = `"}); throw new Error('escaped'); // { } \\ \u2028`;
  const result = edit(source, "Hello", attack);
  assert.deepEqual(result.problems, []);
  assert.equal(renderFixture(result.source).children[0], attack);
});
check("quoted attribute escaping preserves semantic value and quote style", () => {
  const source = `globalThis.result = <img src="/x.png" alt='Before'/>;`;
  const value = `A "quoted" image's <alt> &copy; {x}\nnext`;
  const result = edit(source, "Before", value);
  assert.deepEqual(result.problems, []);
  assert.equal(renderFixture(result.source).props?.alt, value);
  assert.ok(result.source.includes("alt='"));
});
check("href ampersands round-trip without double decoding", () => {
  const source = 'globalThis.result = <a href="/old">Read</a>;';
  const value = "/new?literal=&amp;value";
  const result = edit(source, "/old", value);
  assert.deepEqual(result.problems, []);
  assert.equal(renderFixture(result.source).props?.href, value);
});
for (const bad of ["javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>x</script>", "//evil.example/path", "\\\\evil.example", "/\\evil.example", "https:evil.example", " https://example.com", "vbscript:msgbox(1)", "\u0000javascript:x"]) {
  check(`rejects unsafe URL ${JSON.stringify(bad)} atomically`, () => {
    const result = edit(fixture, "/about", bad);
    assert.equal(result.source, fixture);
    assert.equal(result.changed.length, 0);
    assert.ok(result.problems.length);
  });
}
for (const good of ["/about", "../images/logo.png", "#contact", "?tab=work", "https://example.com/path?q=a&b=c", "mailto:team@example.com", "tel:+233123456789"]) {
  check(`accepts safe href ${good}`, () => assert.deepEqual(edit(fixture, "/about", good).problems, []));
}
check("image sources cannot become mailto links", () => assert.ok(edit(fixture, "/logo.png", "mailto:team@example.com").problems.length));
check("rejects a changed source even if target contents are unchanged", () => {
  const discovery = discoverJsxFields(fixture, "src/Page.tsx");
  const changedSource = fixture.replace("42", "43");
  const result = applyJsxValues(changedSource, { filePath: discovery.filePath, sourceHash: discovery.sourceHash, changes: [{ fieldId: field(discovery, "Read more").id, value: "New" }] });
  assert.equal(result.problems[0]?.code, "stale");
  assert.equal(result.source, changedSource);
});
check("unknown or duplicate changes prevent all writes", () => {
  const discovery = discoverJsxFields(fixture, "src/Page.tsx");
  const change = { fieldId: field(discovery, "Read more").id, value: "New" };
  for (const extra of [{ fieldId: "made-up-offset", value: "Code" }, change]) {
    const result = applyJsxValues(fixture, { filePath: discovery.filePath, sourceHash: discovery.sourceHash, changes: [change, extra] });
    assert.equal(result.source, fixture);
    assert.equal(result.changed.length, 0);
    assert.ok(result.problems.length);
  }
});
check("source references belong to one repository file", () => {
  const a = discoverJsxFields(fixture, "a.tsx");
  const b = discoverJsxFields(fixture, "b.tsx");
  assert.notEqual(a.fields[0]?.id, b.fields[0]?.id);
  assert.ok(applyJsxValues(fixture, { filePath: "b.tsx", sourceHash: a.sourceHash, changes: [{ fieldId: a.fields[0]!.id, value: "New" }] }).problems.length);
});
check("explicit field identity survives a developer restructuring the component", () => {
  const before = 'const A = () => <h1 data-dw-field="hero.title">Hello</h1>;';
  const after = 'const B = () => <article><aside/><div><h1 data-dw-field="hero.title">Hello</h1></div></article>;';
  assert.equal(field(discoverJsxFields(before, "a.tsx"), "Hello").id, field(discoverJsxFields(after, "a.tsx"), "Hello").id);
});
check("structural IDs survive comments and unrelated top-level declarations", () => {
  const source = 'const Page = () => <h1>Hello</h1>;';
  const revised = '// Header\nconst unrelated = 42;\nconst Page = () => (/* kept */ <h1>Hello</h1>);';
  // Parentheses are structural changes; simple formatting and comments are not.
  const formattingOnly = '// Header\nconst unrelated = 42;\nconst Page = () => /* kept */ <h1> Hello </h1>;';
  assert.ok(revised.length > 0);
  assert.equal(field(discoverJsxFields(source, "a.tsx"), "Hello").id, field(discoverJsxFields(formattingOnly, "a.tsx"), " Hello ").id);
});
check("duplicate explicit markers disable every affected field", () => {
  const discovery = discoverJsxFields('const Page = () => <main><h1 data-dw-field="same">One</h1><a data-dw-field="same" href="/two">Two</a></main>;', "Page.tsx");
  assert.equal(discovery.fields.length, 0);
  assert.ok(discovery.issues.some((issue) => issue.code === "ambiguous"));
});
check("custom components, dynamic attrs, spreads, raw HTML, SVG and templates are not offered", () => {
  const source = 'const Page = () => <main><Link href="/private">Custom</Link><a href={path}>Label</a><p {...props}>Spread</p><p dangerouslySetInnerHTML={{__html: html}}>Raw</p><svg><text>SVG</text></svg><p>{`Template`}</p><img src={image} alt="Static alt"/></main>;';
  const discovery = discoverJsxFields(source, "Page.tsx");
  assert.deepEqual(discovery.fields.map((literal) => literal.value), ["Label", "Static alt"]);
  assert.ok(discovery.issues.some((issue) => issue.code === "dynamic"));
  assert.ok(discovery.issues.some((issue) => issue.code === "unsupported"));
});
check("mixed rich content is exposed as separate literal segments", () => {
  const source = 'const Page = () => <p>Hello <strong>world</strong> and {name}!</p>;';
  const discovery = discoverJsxFields(source, "Page.tsx");
  assert.deepEqual(new Set(discovery.fields.map((literal) => literal.value)), new Set(["Hello ", "world", " and ", "!"]));
  const result = edit(source, "world", "Ghana");
  assert.equal(result.source, source.replace("world", "Ghana"));
});
check("empty text that would remove a source field is refused", () => {
  const source = 'const Page = () => <h1>Hello</h1>;';
  assert.equal(edit(source, "Hello", "").source, source);
  assert.ok(edit(source, "Hello", "").problems.length);
});
check("decorative empty alt remains editable", () => {
  const source = 'const Page = () => <img src="/x.png" alt="Description"/>;';
  const result = edit(source, "Description", "");
  assert.deepEqual(result.problems, []);
  assert.equal(field(discoverJsxFields(result.source, "src/Page.tsx"), "", "alt").value, "");
});
check("malformed syntax is read-only", () => {
  const discovery = discoverJsxFields('const Page = () => <main><h1>Broken</main>;', "Page.tsx");
  assert.equal(discovery.fields.length, 0);
  assert.ok(discovery.issues.some((issue) => issue.code === "syntax"));
});
check("traversal/absolute paths and unsupported files fail closed", () => {
  for (const path of ["../Page.tsx", "/Page.tsx", "C:/Page.tsx", "src/../Page.tsx", "Page.html", "src//Page.tsx"]) assert.throws(() => discoverJsxFields(fixture, path));
  assert.equal(discoverJsxFields(fixture, "src\\Page.tsx").filePath, "src/Page.tsx");
});
check("size caps prevent oversized values or source being accepted", () => {
  assert.ok(edit(fixture, "Read more", "a".repeat(100_001)).problems.length);
  const large = discoverJsxFields(" ".repeat(2_000_001), "Page.tsx");
  assert.equal(large.issues[0]?.code, "limit");
});
check("compiled preview mapping accepts exact unique markers and properties", () => {
  const source = 'const Page = () => <main><h1 data-dw-field="hero.title">Hello</h1><a href="/about">Read more</a><img src="/x.png" alt="Portrait"/></main>;';
  const html = '<main><h1 data-dw-field="hero.title">Hello</h1><a href="/about">Read more</a><img src="/x.png" alt="Portrait"/></main>';
  const report = mapJsxFieldsToHtml(discoverJsxFields(source, "Page.tsx").fields, readPage(html).fields);
  assert.equal(report.mappings.length, 5);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.mappings.find((mapping) => mapping.htmlFieldId === "hero.title")?.confidence, "marker");
});
check("duplicate preview values are not guessed by position", () => {
  const source = 'const Page = () => <h1>Hello</h1>;';
  const report = mapJsxFieldsToHtml(discoverJsxFields(source, "Page.tsx").fields, readPage('<main><h1>Hello</h1><h1>Hello</h1></main>').fields);
  assert.equal(report.mappings.length, 0);
  assert.equal(report.diagnostics[0]?.code, "ambiguous");
});
check("multiple source fields cannot claim the same preview property", () => {
  const source = 'const Page = () => <main><h1>Hello</h1><h1>Hello</h1></main>;';
  const report = mapJsxFieldsToHtml(discoverJsxFields(source, "Page.tsx").fields, readPage('<h1>Hello</h1>').fields);
  assert.equal(report.mappings.length, 0);
  assert.equal(report.diagnostics.filter((diagnostic) => diagnostic.code === "ambiguous").length, 2);
});
check("mapping never conflates partial rich text, normalized URLs or missing markers", () => {
  const source = 'const Page = () => <main><p>Hello <strong>world</strong></p><a href="/about">Read</a><h1 data-dw-field="title">Title</h1></main>;';
  const report = mapJsxFieldsToHtml(discoverJsxFields(source, "Page.tsx").fields, readPage('<main><p>Hello <strong>world</strong></p><a href="https://example.com/about">Read</a><h1>Title</h1></main>').fields);
  const discovered = discoverJsxFields(source, "Page.tsx");
  for (const literal of ["Hello ", "/about", "Title"]) assert.ok(!report.mappings.some((mapping) => mapping.sourceFieldId === field(discovered, literal).id));
});

console.log(`websiteJsx: ${passed} focused checks passed`);
