/** A marked component's content prop, and the one bridge it has to the live
 * page. No database, network or framework build.
 * Run: npx tsx checks/websiteJsxComponents.ts
 */
import assert from "node:assert/strict";
import { applyJsxValues, discoverJsxFields, mapJsxFieldsToHtml, readPage, type JsxDiscovery, type JsxField } from "../src/services/website/index.js";

let passed = 0;
function check(name: string, run: () => void) {
  try { run(); passed++; }
  catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
const PATH = "src/Page.tsx";
const discover = (source: string) => discoverJsxFields(source, PATH);
function field(discovery: JsxDiscovery, value: string): JsxField {
  const found = discovery.fields.find((candidate) => candidate.value === value);
  assert.ok(found, `Expected field ${JSON.stringify(value)}: ${JSON.stringify(discovery.issues)}`);
  return found;
}

const marked = 'const Page = () => <main><Hero data-dw-field="hero.title" title="Build &amp; grow" /></main>;';

check("a component's content prop carries its element's marker", () => {
  const discovery = discover(marked);
  const found = field(discovery, "Build & grow");
  assert.equal(found.kind, "text");
  assert.equal(found.tag, "Hero");
  assert.equal(found.marker, "hero.title");
  assert.equal(found.confidence, "explicit");
  assert.equal(found.label, "Hero title");
});
check("an unmarked component prop is still editable, without a marker", () => {
  const found = field(discover('const Page = () => <Hero title="Plain" />;'), "Plain");
  assert.equal(found.marker, undefined);
  assert.equal(found.confidence, "structural");
});
check("a marked component prop edits the literal and nothing else", () => {
  const discovery = discover(marked);
  const result = applyJsxValues(marked, { filePath: PATH, sourceHash: discovery.sourceHash, changes: [{ fieldId: field(discovery, "Build & grow").id, value: "Design & deliver" }] });
  assert.deepEqual(result.problems, []);
  assert.equal(result.source, marked.replace("Build &amp; grow", "Design &amp; deliver"));
});
check("two content props under one marker are told apart, not merged", () => {
  const discovery = discover('const Page = () => <Hero data-dw-field="hero" title="A" subtitle="B" />;');
  assert.equal(discovery.fields.length, 2);
  assert.notEqual(field(discovery, "A").id, field(discovery, "B").id);
  assert.equal(field(discovery, "A").marker, "hero");
});
check("a marker used twice makes every field under it read-only", () => {
  const discovery = discover('const Page = () => <main><Hero data-dw-field="hero" title="A" /><Hero data-dw-field="hero" title="B" /></main>;');
  assert.deepEqual(discovery.fields, []);
  assert.ok(discovery.issues.some((issue) => issue.code === "ambiguous" && issue.message.includes("more than once")));
});
check("structure props are never offered as words, marker or not", () => {
  const discovery = discover('const Page = () => <Hero data-dw-field="hero" className="big" variant="dark" id="top" title="Only me" />;');
  assert.deepEqual(discovery.fields.map((item) => item.value), ["Only me"]);
});
check("a marked component field matches its preview element by marker alone", () => {
  const report = mapJsxFieldsToHtml(discover(marked).fields, readPage('<main><h1 data-dw-field="hero.title">Build &amp; grow</h1></main>').fields);
  assert.equal(report.mappings.length, 1);
  assert.equal(report.mappings[0]!.confidence, "marker");
  assert.equal(report.mappings[0]!.property, "value");
});
check("without the marker on the page, a component field matches nothing", () => {
  const report = mapJsxFieldsToHtml(discover(marked).fields, readPage("<main><h1>Build &amp; grow</h1></main>").fields);
  assert.deepEqual(report.mappings, []);
  assert.equal(report.diagnostics[0]?.code, "unmatched");
});
check("a marker match still requires the identical value", () => {
  const report = mapJsxFieldsToHtml(discover(marked).fields, readPage('<main><h1 data-dw-field="hero.title">Something else</h1></main>').fields);
  assert.deepEqual(report.mappings, []);
});
check("an unmarked native field still has to agree on its tag", () => {
  assert.deepEqual(mapJsxFieldsToHtml(discover("const Page = () => <h1>Hello</h1>;").fields, readPage("<h2>Hello</h2>").fields).mappings, []);
  assert.equal(mapJsxFieldsToHtml(discover("const Page = () => <h1>Hello</h1>;").fields, readPage("<h1>Hello</h1>").fields).mappings.length, 1);
});
check("a native marked field is unaffected by the component bridge", () => {
  const source = 'const Page = () => <h1 data-dw-field="t">Title</h1>;';
  const report = mapJsxFieldsToHtml(discover(source).fields, readPage('<h1 data-dw-field="t">Title</h1>').fields);
  assert.equal(report.mappings.length, 1);
});

console.log(`websiteJsxComponents: ${passed} focused checks passed`);
