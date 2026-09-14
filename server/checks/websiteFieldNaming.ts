/**
 * Can somebody edit the words on their own page?
 *
 * Two sentences used to come back from the editor on a framework site, both of
 * them true and neither of them any use to the person reading it: these words
 * appear more than once, ask a developer to name this element; and this part is
 * built by its code, there is nothing to type into. Between them they locked the
 * headings on pages whose every word was sitting in a string literal somebody
 * could have typed into.
 *
 * Three answers, asserted here:
 *
 *  1. **Follow the value.** `<Hero title={hero.title} />` is the words a visitor
 *     reads, written the way a generator writes them. The literal behind the
 *     name is the field. A backtick literal with nothing substituted into it is
 *     a static string and is written back as a backtick literal.
 *  2. **Count the copies.** Identical words in one file, and exactly as many of
 *     them on the page, are counted off one for one. Counts that disagree, or
 *     two files in the running, still refuse.
 *  3. **Name it rather than asking somebody else to.** The editor writes the
 *     `data-dw-field` itself, and takes back out any of its own that the build
 *     ignored.
 *
 * And the negatives, which are the half worth reading: structure is never
 * offered because it happens to be a string, a shadowed name is never followed,
 * a marker is never added where it would name the wrong thing, and no file is
 * ever written that does not come back saying exactly what it said.
 *
 * No database, no network, no key.
 *   npx tsx checks/websiteFieldNaming.ts
 */
import assert from "node:assert";
import { applyJsxValues, discoverJsxFields, mapJsxFieldsToHtml } from "../src/services/website/jsx.js";
import { proposeMarkers, staleMarkers } from "../src/services/website/sourceMarkers.js";
import { readPage } from "../src/services/website/regions.js";

let passed = 0;
let failures = 0;
function check(name: string, run: () => void): void {
  try { run(); passed += 1; }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

const PATH = "src/app/page.tsx";
const valuesOf = (source: string, path = PATH) => discoverJsxFields(source, path).fields.map((field) => field.value).sort();

// ── 1. Following a value back to the literal it was written as ──────────────

check("a prop holding a named constant is the constant's literal", () => {
  const source = 'const tagline = "Systems that answer";\nconst Page = () => <Hero title={tagline} />;';
  const discovery = discoverJsxFields(source, PATH);
  assert.deepEqual(discovery.fields.map((field) => field.value), ["Systems that answer"]);
  assert.ok(!discovery.issues.some((issue) => issue.code === "dynamic"), "and it is not reported as coming from the code");
});

check("a key path into a constant object is followed", () => {
  const source = 'const copy = { hero: { title: "Welcome" } };\nconst Page = () => <h1>{copy.hero.title}</h1>;';
  assert.deepEqual(valuesOf(source), ["Welcome"]);
});

check("a backtick literal is offered and written back as one", () => {
  const source = 'const copy = { title: `Welcome` };\nconst Page = () => <h1>{copy.title}</h1>;';
  const discovery = discoverJsxFields(source, PATH);
  assert.equal(discovery.fields[0]!.reference.encoding, "javascript-template");
  const result = applyJsxValues(source, { filePath: PATH, sourceHash: discovery.sourceHash, changes: [{ fieldId: discovery.fields[0]!.id, value: "Hello `there` ${now}" }] });
  assert.deepEqual(result.problems, []);
  assert.ok(result.source.includes("`Hello \\`there\\` \\${now}`"), result.source);
});

check("one literal named in two places is one field, and an edit reaches both", () => {
  const source = 'const cta = "Get started";\nconst Page = () => <div><a href="/a">{cta}</a><Button label={cta} /></div>;';
  const discovery = discoverJsxFields(source, PATH);
  assert.equal(discovery.fields.filter((field) => field.value === "Get started").length, 1, "one literal, one field");
  const result = applyJsxValues(source, { filePath: PATH, sourceHash: discovery.sourceHash, changes: [{ fieldId: discovery.fields.find((field) => field.value === "Get started")!.id, value: "Start here" }] });
  assert.deepEqual(result.problems, []);
  assert.ok(result.source.includes('const cta = "Start here"') && !result.source.includes("Get started"));
});

check("structure is never offered just because it is a string", () => {
  const source = 'const className = "grid gap-4";\nconst variant = "primary";\nconst Page = () => <div className={className}><button variant={variant}>Go</button></div>;';
  // "Go" is words in a native element; the class and the variant are structure
  // that happens to be spelled with letters, and neither is followed.
  assert.deepEqual(valuesOf(source), ["Go"]);
});

check("a name declared twice is not followed", () => {
  const source = 'const title = "One";\nfunction other() { const title = "Two"; return title; }\nconst Page = () => <Hero title={title} />;';
  const discovery = discoverJsxFields(source, PATH);
  // Both declarations are content-named, so both are offered as themselves —
  // but neither is followed from the markup, where choosing between them would
  // be a guess about scope this parser does not make.
  // Both declarations are offered as themselves — each is a content-named
  // constant holding a string. What does not happen is the markup being pointed
  // at either: choosing between them is a question about scope, and a wrong
  // answer edits a sentence somebody did not click on.
  assert.deepEqual(discovery.fields.map((field) => field.value).sort(), ["One", "Two"]);
  assert.ok(discovery.issues.some((issue) => issue.code === "dynamic"), "and the prop says its value comes from code");
});

check("a value the code genuinely works out is still refused", () => {
  const source = "const Page = ({ count }) => <Card label={`Item ${count}`} title={count > 1 ? 'Many' : 'One'} />;";
  const discovery = discoverJsxFields(source, PATH);
  assert.deepEqual(discovery.fields.map((field) => field.value), []);
  assert.ok(discovery.issues.every((issue) => issue.code === "dynamic" || issue.code === "unsupported"));
});

// ── 2. Counting identical copies ────────────────────────────────────────────

const twice = 'const Page = () => <main><p>Get started</p><p>Get started</p></main>;';
const htmlWith = (copies: number) => readPage(`<html><body><main>${"<p>Get started</p>".repeat(copies)}</main></body></html>`).fields;

check("identical words in one file are counted off against the page", () => {
  const report = mapJsxFieldsToHtml(discoverJsxFields(twice, PATH).fields, htmlWith(2));
  assert.equal(report.mappings.length, 2);
  assert.ok(report.mappings.every((mapping) => mapping.confidence === "positional"));
  assert.deepEqual(report.diagnostics, []);
});

check("a count that does not agree refuses instead of pairing off the top", () => {
  const report = mapJsxFieldsToHtml(discoverJsxFields(twice, PATH).fields, htmlWith(3));
  assert.equal(report.mappings.length, 0);
  assert.ok(report.diagnostics.every((diagnostic) => diagnostic.code === "ambiguous"));
});

check("two files with the same words are never told apart by position", () => {
  const one = discoverJsxFields(twice, PATH).fields.map((field) => ({ ...field, filePath: PATH }));
  const two = discoverJsxFields('const F = () => <main><p>Get started</p><p>Get started</p></main>;', "src/components/footer.tsx").fields
    .map((field) => ({ ...field, filePath: "src/components/footer.tsx" }));
  const report = mapJsxFieldsToHtml([...one, ...two] as never, htmlWith(4));
  assert.equal(report.mappings.length, 0);
});

// ── 3. Naming an element rather than asking a developer to ──────────────────

const mixed = 'const Page = () => <div><p>Get started</p><Hero title="Get started" /></div>;';

check("markers are added to the elements holding the shared words", () => {
  const discovery = discoverJsxFields(mixed, PATH);
  const proposal = proposeMarkers(mixed, PATH, discovery.fields.map((field) => field.id));
  assert.equal(proposal.added.length, 2);
  assert.deepEqual(valuesOf(proposal.source), valuesOf(mixed), "and the file still says exactly what it said");
  const named = discoverJsxFields(proposal.source, PATH);
  assert.ok(named.fields.every((field) => field.marker), "every named field carries its marker");
  assert.equal(new Set(named.fields.map((field) => field.marker)).size, 2, "and the markers are unique");
});

check("naming twice names nothing the second time", () => {
  const once = proposeMarkers(mixed, PATH, discoverJsxFields(mixed, PATH).fields.map((field) => field.id));
  const twiceOver = proposeMarkers(once.source, PATH, discoverJsxFields(once.source, PATH).fields.map((field) => field.id));
  assert.equal(twiceOver.added.length, 0);
  assert.equal(twiceOver.source, once.source);
});

check("a string in a data file is refused rather than named in the wrong place", () => {
  const data = 'export const cards = [{ title: "Fast" }, { title: "Fast" }];';
  const discovery = discoverJsxFields(data, "src/data/cards.ts");
  const proposal = proposeMarkers(data, "src/data/cards.ts", discovery.fields.map((field) => field.id));
  assert.equal(proposal.added.length, 0);
  assert.equal(proposal.source, data);
  assert.equal(proposal.refused.length, discovery.fields.length);
});

check("a named element maps by its name, and a name that never rendered is removed", () => {
  const proposal = proposeMarkers(mixed, PATH, discoverJsxFields(mixed, PATH).fields.map((field) => field.id));
  const survivor = proposal.added.find((entry) => entry.tag === "p")!.marker;
  // The component ignores the prop it was given, so only the <p>'s name is on
  // the built page. That is the case the sweep exists for.
  const html = `<html><body><p data-dw-field="${survivor}">Get started</p><h1>Get started</h1></body></html>`;
  const mapped = mapJsxFieldsToHtml(discoverJsxFields(proposal.source, PATH).fields, readPage(html).fields);
  assert.ok(mapped.mappings.some((mapping) => mapping.confidence === "marker"), "the surviving name is what the match is made on");
  const swept = staleMarkers(proposal.source, PATH, html);
  assert.equal(swept.removed.length, 1, "the name that bought nothing is taken back out");
  assert.ok(swept.source.includes(survivor), "and the one that works is left alone");
  assert.deepEqual(valuesOf(swept.source), valuesOf(mixed));
});

check("an author's own marker is never removed, whatever the build did with it", () => {
  const source = 'const Page = () => <Hero data-dw-field="hero.title" title="Welcome" />;';
  const swept = staleMarkers(source, PATH, "<html><body><h1>Welcome</h1></body></html>");
  assert.deepEqual(swept.removed, []);
  assert.equal(swept.source, source);
});

if (failures) { console.error(`websiteFieldNaming: ${failures} failed`); process.exit(1); }
console.log(`websiteFieldNaming: ${passed} field-following, counting and naming checks passed`);
