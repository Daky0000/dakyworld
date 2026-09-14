/**
 * A prop on a custom component, edited through the rendered page.
 *
 * The case this is really about: an AI-built Next page whose words live on
 * custom components — `<Hero title="..." />` — rendered as native elements
 * (`<h1>`). The source field's tag is `Hero`, the preview's is `h1`, so a tag
 * check would refuse the match. A `data-dw-field` marker makes the identity
 * faithful across that difference, and these checks pin the three safety rules:
 *
 *  - a marker on a component marks exactly one content prop, and maps it;
 *  - a marker on a component with two content props is ambiguous and is ignored;
 *  - an unmarked content prop is never mapped (its tag disagrees with the render).
 */
import assert from "node:assert/strict";
import { applyHtmlEditsAsJsx, discoverFields, discoverJsxFields, mapJsxFieldsToHtml } from "../src/services/website/index.js";

let passed = 0;
const filePath = "app/pricing/page.tsx";

// One content prop, marked — the editable surface an AI generator can opt in to.
const marked = [
  'import { Hero } from "./components";',
  "export default function Pricing() {",
  "  return (",
  '    <main className="wrap">',
  '      <Hero data-dw-field="hero.title" title="Plans that fit" />',
  "    </main>",
  "  );",
  "}",
].join("\n");

const built = [
  "<!doctype html><html><head><title>Plans</title></head><body>",
  '<main class="wrap">',
  '<h1 data-dw-field="hero.title" class="text-5xl">Plans that fit</h1>',
  "</main></body></html>",
].join("");

const sourceFields = discoverJsxFields(marked, filePath).fields;
const titleField = sourceFields.find((field) => field.marker === "hero.title");
assert.ok(titleField, "the marked content prop is discovered as a field"); passed++;
assert.equal(titleField!.kind, "text"); passed++;
assert.equal(titleField!.tag, "Hero"); passed++;
assert.equal(titleField!.value, "Plans that fit"); passed++;
assert.equal(titleField!.confidence, "explicit"); passed++;

const htmlFields = discoverFields(built).fields;
const report = mapJsxFieldsToHtml(sourceFields, htmlFields);
const mapping = report.mappings.find((entry) => entry.sourceFieldId === titleField!.id);
assert.ok(mapping, "a marked component field maps despite the Hero→h1 tag difference"); passed++;
assert.equal(mapping!.htmlFieldId, "hero.title"); passed++;
assert.equal(mapping!.confidence, "marker"); passed++;

const heading = htmlFields.find((entry) => entry.value === "Plans that fit")!;
const written = applyHtmlEditsAsJsx({ source: marked, filePath, html: built, edits: { [heading.id]: { value: "Plans that fit your business" } } });
assert.deepEqual(written.unmappable, []); passed++;
assert.deepEqual(written.problems, []); passed++;
const reparsed = discoverJsxFields(written.source, filePath);
assert.equal(reparsed.issues.filter((issue) => issue.code === "syntax").length, 0, "the rewritten file still parses"); passed++;
assert.equal(reparsed.fields.find((field) => field.marker === "hero.title")?.value, "Plans that fit your business"); passed++;

// Two content props under one marker: ambiguous, so the marker is ignored and
// nothing becomes writable by accident.
const twoProp = marked.replace('<Hero data-dw-field="hero.title" title="Plans that fit" />', '<Hero data-dw-field="hero.title" title="Plans that fit" subtitle="Hosting, updates" />');
const twoIssues = discoverJsxFields(twoProp, filePath).issues;
assert.ok(twoIssues.some((issue) => issue.code === "ambiguous" && /data-dw-field/.test(issue.message)), "two content props behind one marker are flagged ambiguous"); passed++;
assert.equal(discoverJsxFields(twoProp, filePath).fields.filter((field) => field.marker).length, 0, "the ignored marker attaches to no field"); passed++;

// Unmarked content prop: never mapped, because the source tag cannot agree with
// the rendered native tag — value-matching would be unsafe here.
const unmarked = marked.replace(/ data-dw-field="hero\.title"/, "");
assert.equal(mapJsxFieldsToHtml(discoverJsxFields(unmarked, filePath).fields, htmlFields).mappings.length, 0, "an unmarked component prop is not mappable and stays read-only"); passed++;

// The whole point of a marker: identical words in identical elements cannot be
// told apart by value, but a name can. Here both source and render carry markers
// "a" and "b", so the two identical <h1>s map onto their own literals — the tag
// check is skipped for marked fields and the marker wins.
const dupPage = [
  "export default function Dup() {",
  "  return (",
  '    <main>',
  '      <h1 data-dw-field="a">Same offer</h1>',
  '      <h1 data-dw-field="b">Same offer</h1>',
  "    </main>",
  "  );",
  "}",
].join("\n");
const dupHtml = '<!doctype html><html><head></head><body><main><h1 data-dw-field="a">Same offer</h1><h1 data-dw-field="b">Same offer</h1></main></body></html>';
const dupFields = discoverJsxFields(dupPage, filePath).fields;
const dupHtmlFields = discoverFields(dupHtml).fields;
assert.ok(dupFields.some((field) => field.marker), "the disambiguating case has markers"); passed++;
assert.equal(mapJsxFieldsToHtml(dupFields, dupHtmlFields).mappings.length, 2, "markers separate identical text onto its own literal"); passed++;
// The same words with no markers cannot be resolved and stay read-only rather
// than guessing.
const unmarkedDup = dupPage.replace(/ data-dw-field="[ab]"/g, "");
const unmarkedDupHtml = dupHtml.replace(/ data-dw-field="[ab]"/g, "");
assert.equal(mapJsxFieldsToHtml(discoverJsxFields(unmarkedDup, filePath).fields, discoverFields(unmarkedDupHtml).fields).mappings.length, 0, "unmarked identical text is ambiguous and stays read-only"); passed++;

console.log(`websiteComponentProps: ${passed} component-prop marker round-trip checks passed`);
