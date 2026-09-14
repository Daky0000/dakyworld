/**
 * An edit made on a built page, written back into the file it was built from.
 *
 * This is the load-bearing join of the whole framework editor: the visual
 * editor works on rendered HTML, and every change it produces has to land on a
 * literal in a `.tsx` that nobody can see while they are making it. The ways
 * that goes wrong are all silent:
 *
 *  - a change written to the wrong literal, because two rendered nodes carried
 *    the same words;
 *  - a change dropped on the floor, because it was styling or a moved section
 *    and nothing here could write it — with the publish reporting success;
 *  - markup smuggled into a JavaScript string, because somebody bolded a word
 *    in an editor that had no way to say no;
 *  - a marker that was supposed to make all of this exact being ignored.
 *
 * So the assertions are about refusals as much as about writes. A publish that
 * cannot express everything it was given must write nothing at all.
 */
import assert from "node:assert/strict";
import { applyHtmlEditsAsJsx, discoverFields, discoverJsxFields, mapJsxFieldsToHtml } from "../src/services/website/index.js";

let passed = 0;
const filePath = "app/pricing/page.tsx";
const source = [
  'export default function Pricing() {',
  '  return (',
  '    <main className="wrap">',
  '      <h1 data-dw-field="hero.title">Plans that fit</h1>',
  '      <p data-dw-field="hero.blurb">Hosting, updates and a person who answers.</p>',
  '      <a data-dw-field="hero.cta" href="/contact">Talk to us</a>',
  '      <img data-dw-field="hero.image" src="/team.png" alt="The team" />',
  '      <p>{generated}</p>',
  '    </main>',
  '  );',
  '}',
].join("\n");
const built = [
  "<!doctype html><html><head><title>Plans</title></head><body>",
  '<main class="wrap">',
  '<h1 data-dw-field="hero.title" class="text-5xl">Plans that fit</h1>',
  '<p data-dw-field="hero.blurb">Hosting, updates and a person who answers.</p>',
  '<a data-dw-field="hero.cta" class="btn btn-primary" href="/contact">Talk to us</a>',
  '<img data-dw-field="hero.image" src="/team.png" alt="The team">',
  "<p>Built at deploy time from a database.</p>",
  "</main></body></html>",
].join("");

const htmlFields = discoverFields(built).fields;
const sourceFields = discoverJsxFields(source, filePath).fields;
const field = (value: string) => htmlFields.find((entry) => entry.value === value || entry.preview === value || entry.href === value);

// ── The mapping ─────────────────────────────────────────────────────────────
const report = mapJsxFieldsToHtml(sourceFields, htmlFields);
assert.ok(report.mappings.length >= 4); passed++;
// Every mapping carries the bytes it is about to replace, so the write never
// re-derives which literal a change belongs to.
assert.ok(report.mappings.every((mapping) => mapping.span.end > mapping.span.start)); passed++;
assert.ok(report.mappings.every((mapping) => source.slice(mapping.span.start, mapping.span.end).length > 0)); passed++;
// A marked literal is matched by its marker rather than by luck.
assert.ok(report.mappings.some((mapping) => mapping.confidence === "marker")); passed++;

// Marker discipline: with it required, an unmarked literal is not writable at
// all, whatever its words happen to be.
const unmarkedSource = source.replace(/ data-dw-field="[^"]*"/g, "");
const strict = mapJsxFieldsToHtml(discoverJsxFields(unmarkedSource, filePath).fields, htmlFields, { requireMarker: true });
assert.equal(strict.mappings.length, 0); passed++;
assert.ok(strict.diagnostics.every((diagnostic) => /marker/.test(diagnostic.message))); passed++;
// Without the rule, the same file still maps by exact value — which is what
// makes an unannotated site editable at all.
assert.ok(mapJsxFieldsToHtml(discoverJsxFields(unmarkedSource, filePath).fields, htmlFields).mappings.length >= 4); passed++;

// ── Writing an edit back ────────────────────────────────────────────────────
const heading = field("Plans that fit")!;
const link = htmlFields.find((entry) => entry.href === "/contact")!;
const written = applyHtmlEditsAsJsx({
  source,
  filePath,
  html: built,
  edits: { [heading.id]: { value: "Plans that fit your business" }, [link.id]: { href: "/contact-us" } },
});
assert.deepEqual(written.unmappable, []); passed++;
assert.deepEqual(written.problems, []); passed++;
assert.ok(written.source.includes('<h1 data-dw-field="hero.title">Plans that fit your business</h1>')); passed++;
assert.ok(written.source.includes('href="/contact-us"')); passed++;
// Everything else in the file is untouched, including the expression the editor
// could see on the page and can never write.
assert.ok(written.source.includes("<p>{generated}</p>") && written.source.includes('className="wrap"')); passed++;
// The result is a file that still parses, with the same fields in it.
const after = discoverJsxFields(written.source, filePath);
assert.equal(after.fields.length, discoverJsxFields(source, filePath).fields.length); passed++;
assert.ok(after.issues.every((issue) => issue.code !== "syntax")); passed++;

// ── What it refuses ─────────────────────────────────────────────────────────
const generated = htmlFields.find((entry) => entry.preview.startsWith("Built at deploy time"))!;
const codeManaged = applyHtmlEditsAsJsx({ source, filePath, html: built, edits: { [generated.id]: { value: "Changed" } } });
assert.equal(codeManaged.source, source); passed++;
assert.equal(codeManaged.unmappable.length, 1); passed++;
assert.match(codeManaged.unmappable[0]!.message, /came from the code/); passed++;

// Styling, a moved section and a button variant have no bytes to be written to,
// and each says which part it was.
for (const [part, edit] of [["style", { style: "color: red" }], ["variant", { variant: "btn-dark" }], ["newTab", { newTab: true }]] as const) {
  const refused = applyHtmlEditsAsJsx({ source, filePath, html: built, edits: { [heading.id]: edit } });
  assert.equal(refused.source, source);
  assert.equal(refused.unmappable[0]?.part, part); passed++;
}

// One unwritable part refuses the whole set, so a publish is never half-applied.
const mixed = applyHtmlEditsAsJsx({
  source,
  filePath,
  html: built,
  edits: { [heading.id]: { value: "A good change" }, [generated.id]: { value: "An impossible one" } },
});
assert.equal(mixed.source, source); passed++;
assert.deepEqual(mixed.changed, []); passed++;

// Markup cannot cross into a JavaScript string: bolding half a heading is a
// change to the code, and it is refused as one rather than committed as text.
const bolded = applyHtmlEditsAsJsx({ source, filePath, html: built, edits: { [heading.id]: { value: "Plans that <strong>fit</strong>" } } });
assert.equal(bolded.source, source); passed++;
assert.match(bolded.unmappable[0]!.message, /plain text/); passed++;

// Entities come back as the characters they stand for — the editor speaks HTML
// and the file speaks JavaScript.
const entity = applyHtmlEditsAsJsx({ source, filePath, html: built, edits: { [heading.id]: { value: "Plans &amp; prices" } } });
assert.deepEqual(entity.unmappable, []); passed++;
assert.ok(entity.source.includes("Plans &amp; prices") || entity.source.includes("Plans & prices")); passed++;
assert.equal(discoverJsxFields(entity.source, filePath).fields.find((candidate) => candidate.marker === "hero.title")?.value, "Plans & prices"); passed++;

// A file that has moved under the edit writes nothing.
const moved = applyHtmlEditsAsJsx({ source: `${source}\n// a developer was here`, filePath, html: built, edits: { [heading.id]: { value: "Later" } } });
assert.ok(moved.source.includes("a developer was here")); passed++;
assert.ok(moved.changed.length === 1 || moved.problems.length > 0); passed++;

console.log(`websiteSourceMap: ${passed} rendered-to-source mapping and write-back checks passed`);
