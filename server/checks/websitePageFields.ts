/**
 * A page's fields, across every file they live in.
 *
 * The defect these are really about: a Next route file that renders three
 * imported components came back with almost nothing editable, because the only
 * file anybody read was the route file — and on that kind of project the route
 * file holds the layout and none of the words.
 *
 * What is pinned:
 *
 *  - a heading inside an imported component is editable, and a write lands in
 *    the component's file rather than the route's;
 *  - a card whose words live in a data file is editable, and two cards in the
 *    same array are independently editable;
 *  - two files that happen to say the same thing are ambiguous and both stay
 *    read-only — the collision is only visible because every file is mapped in
 *    one pass;
 *  - an element with nothing behind it is still selectable, and carries a
 *    reason;
 *  - one file refusing its part of a write fails the whole set.
 */
import assert from "node:assert/strict";
import { buildSourceManifest } from "../src/services/website/manifest.js";
import { applyPageEdits, discoverPageFields, matchPageToHtml } from "../src/services/website/pageFields.js";

let passed = 0;

// ── A page whose words are anywhere but the route file ──────────────────────
const project: Record<string, string> = {
  "app/page.tsx": [
    'import { Hero } from "../components/Hero";',
    'import { Cards } from "../components/Cards";',
    "export default function Home() {",
    "  return (<main><Hero /><Cards /></main>);",
    "}",
  ].join("\n"),
  "components/Hero.tsx": [
    "export function Hero() {",
    '  return (<section><h1 data-dw-field="hero.title">Websites that work</h1>',
    '    <a data-dw-field="hero.cta" href="/start">Get started</a></section>);',
    "}",
  ].join("\n"),
  "components/Cards.tsx": [
    'import { cards } from "../data/cards";',
    "export function Cards() {",
    "  return (<div>{cards.map((card) => (<article key={card.title}><h3>{card.title}</h3><p>{card.description}</p></article>))}</div>);",
    "}",
  ].join("\n"),
  "data/cards.ts": [
    "export const cards = [",
    '  { title: "Fast to build", description: "Live in two weeks" },',
    '  { title: "Yours to keep", description: "The code is yours" },',
    "];",
  ].join("\n"),
};

const html = [
  "<!doctype html><html><head><title>Home</title></head><body><main>",
  '<section><h1 data-dw-field="hero.title">Websites that work</h1>',
  '<a data-dw-field="hero.cta" href="/start">Get started</a></section>',
  "<div>",
  "<article><h3>Fast to build</h3><p>Live in two weeks</p></article>",
  "<article><h3>Yours to keep</h3><p>The code is yours</p></article>",
  "</div></main></body></html>",
].join("");

const read = async (path: string) => project[path] ?? null;
const manifest = await buildSourceManifest({ entry: "app/page.tsx", files: Object.keys(project), read });
const discovery = await discoverPageFields({ manifest, read });

assert.ok(discovery.fields.length > 0, "the page has editable fields at all"); passed++;
const filesWithFields = new Set(discovery.fields.map((field) => field.filePath));
assert.ok(filesWithFields.has("components/Hero.tsx"), "a component's own literals are the page's fields"); passed++;
assert.ok(filesWithFields.has("data/cards.ts"), "a data file's entries are the page's fields"); passed++;
assert.equal(discovery.manifestHash, manifest.manifestHash, "the discovery pins the manifest it was built from"); passed++;
assert.ok(discovery.sources.some((source) => source.filePath === "data/cards.ts" && source.role === "content"), "a data file is recorded as content"); passed++;

// ── Matching: the heading in the component reaches the rendered page ────────
const view = matchPageToHtml({ discovery, html });
const mappedFiles = new Set(view.mappings.map((mapping) => mapping.filePath));
assert.ok(mappedFiles.has("components/Hero.tsx"), "the component's heading matches the rendered page"); passed++;
assert.ok(mappedFiles.has("data/cards.ts"), "the data file's card text matches the rendered page"); passed++;

const cardMappings = view.mappings.filter((mapping) => mapping.filePath === "data/cards.ts");
assert.ok(cardMappings.length >= 4, "both cards' title and description map, not just the first card's"); passed++;
const targets = new Set(cardMappings.map((mapping) => mapping.htmlFieldId));
assert.equal(targets.size, cardMappings.length, "each card maps to its own element, so editing one cannot change the other"); passed++;

// ── Capabilities: selectable is not editable ────────────────────────────────
assert.ok(view.capabilities.every((capability) => capability.selectable), "every element on the page is selectable"); passed++;
const editable = view.capabilities.filter((capability) => capability.content || capability.link || capability.image);
assert.ok(editable.length > 0, "some of them are editable"); passed++;
const locked = view.capabilities.filter((capability) => !capability.content && !capability.link && !capability.image);
assert.ok(locked.every((capability) => typeof capability.reason === "string" && capability.reason.length > 0), "and every one that is not says why"); passed++;
assert.ok(view.capabilities.every((capability) => capability.styles), "styling is offered on every element, because it does not come from the source"); passed++;
assert.ok(view.capabilities.every((capability) => !capability.formatting), "rich-text formatting is not offered on a plain string literal"); passed++;
const heroCapability = view.capabilities.find((capability) => view.mappings.some((mapping) => mapping.htmlFieldId === capability.htmlFieldId && mapping.filePath === "components/Hero.tsx"))!;
assert.equal(heroCapability.filePath, "components/Hero.tsx", "a capability names the file a write would land in"); passed++;
assert.equal(heroCapability.scope, "instance", "a component rendered once is an instance edit"); passed++;

// ── Writing: the edit lands in the component, not the route ─────────────────
const titleTarget = view.mappings.find((mapping) => mapping.filePath === "components/Hero.tsx" && mapping.property === "value")!;
const written = await applyPageEdits({ discovery, read, html, edits: { [titleTarget.htmlFieldId]: { value: "Websites that convert" } } });
assert.equal(written.problems.length, 0, "the write is accepted"); passed++;
assert.equal(written.unmappable.length, 0, "with nothing unmappable"); passed++;
assert.equal(written.writes.length, 1, "exactly one file is written"); passed++;
assert.equal(written.writes[0]!.filePath, "components/Hero.tsx", "and it is the component, not the route file"); passed++;
assert.ok(written.writes[0]!.source.includes("Websites that convert"), "the new words are in the new source"); passed++;
assert.ok(!written.writes[0]!.source.includes("Websites that work"), "and the old ones are not"); passed++;
assert.ok(!project["app/page.tsx"]!.includes("convert"), "the route file is untouched"); passed++;

// ── One card, not both ──────────────────────────────────────────────────────
const firstCard = cardMappings.find((mapping) => mapping.property === "value")!;
const cardEdit = await applyPageEdits({ discovery, read, html, edits: { [firstCard.htmlFieldId]: { value: "Quick to build" } } });
assert.equal(cardEdit.problems.length, 0, "a card edit is accepted"); passed++;
assert.equal(cardEdit.writes.length, 1, "one file is written"); passed++;
assert.equal(cardEdit.writes[0]!.filePath, "data/cards.ts", "and it is the data file"); passed++;
const cardSource = cardEdit.writes[0]!.source;
assert.equal(cardEdit.writes[0]!.changed.length, 1, "exactly one literal changed"); passed++;
assert.ok(cardSource.includes("Yours to keep"), "the other card is untouched"); passed++;
assert.ok(cardSource.includes("The code is yours"), "including its description"); passed++;

// ── Two files saying the same thing: ambiguous, both read-only ──────────────
const twins: Record<string, string> = {
  "app/page.tsx": [
    'import { A } from "../components/A";',
    'import { B } from "../components/B";',
    "export default function Home() { return (<main><A /><B /></main>); }",
  ].join("\n"),
  "components/A.tsx": "export function A() { return <h2>Get started</h2>; }",
  "components/B.tsx": "export function B() { return <h2>Get started</h2>; }",
};
const twinRead = async (path: string) => twins[path] ?? null;
const twinManifest = await buildSourceManifest({ entry: "app/page.tsx", files: Object.keys(twins), read: twinRead });
const twinDiscovery = await discoverPageFields({ manifest: twinManifest, read: twinRead });
const twinHtml = "<!doctype html><html><head></head><body><main><h2>Get started</h2><h2>Get started</h2></main></body></html>";
const twinView = matchPageToHtml({ discovery: twinDiscovery, html: twinHtml });
assert.equal(twinDiscovery.fields.filter((field) => field.value === "Get started").length, 2, "both files' literals are discovered"); passed++;
assert.equal(twinView.mappings.length, 0, "neither is mapped, because a collision across two files is visible in one pass"); passed++;
assert.ok(twinView.diagnostics.some((diagnostic) => diagnostic.code === "ambiguous"), "and the collision is reported as ambiguous"); passed++;
const collided = new Set(twinView.diagnostics.flatMap(() => twinView.htmlFields.filter((field) => field.value === "Get started").map((field) => field.id)));
assert.equal(collided.size, 2, "both rendered headings are the collision"); passed++;
assert.ok(
  [...collided].every((id) => twinView.capabilities.find((capability) => capability.htmlFieldId === id)?.reason?.includes("more than one place in the code")),
  "the reason on each colliding element says the words are in more than one place in the code",
); passed++;
const twinFiles = new Set(twinView.diagnostics.map((diagnostic) => diagnostic.filePath));
assert.equal(twinFiles.size, 2, "the diagnostics name both files rather than blaming the route"); passed++;
// And the diagnostic says which elements it is about, so the editor can tell
// somebody which files their words are in rather than naming the route file,
// which is where they are not.
for (const id of collided) {
  assert.ok(
    twinView.diagnostics.some((diagnostic) => diagnostic.code === "ambiguous" && diagnostic.candidateHtmlFieldIds.includes(id)),
    "each colliding element is named by an ambiguous diagnostic",
  );
}
passed++;

// ── A refusal fails the whole set ───────────────────────────────────────────
const anyTarget = view.mappings.find((mapping) => mapping.property === "value")!;
const styled = await applyPageEdits({
  discovery,
  read,
  html,
  edits: { [anyTarget.htmlFieldId]: { value: "Fine", newTab: true } },
});
assert.equal(styled.writes.length, 0, "a change the source cannot hold writes nothing at all"); passed++;
assert.ok(styled.unmappable.some((entry) => entry.part === "newTab"), "and names the part that could not be written"); passed++;

const markup = await applyPageEdits({ discovery, read, html, edits: { [anyTarget.htmlFieldId]: { value: "Half <strong>bold</strong>" } } });
assert.equal(markup.writes.length, 0, "formatting inside a plain literal is refused"); passed++;
assert.ok(markup.unmappable[0]!.message.includes("rich-text"), "and points at the way to make it possible"); passed++;

// Unsupported styling cannot silently disappear from a content publish.
const styleOnly = await applyPageEdits({ discovery, read, html, edits: { [anyTarget.htmlFieldId]: { style: "color: red" } } });
assert.equal(styleOnly.unmappable.length, 1, "unsupported styling is reported"); passed++;
assert.equal(styleOnly.writes.length, 0, "unsupported styling writes nothing"); passed++;

// ── A stale file is caught per file, not per page ───────────────────────────
const moved: Record<string, string> = { ...project, "components/Hero.tsx": project["components/Hero.tsx"]!.replace("Websites that work", "Something else") };
const staleWrite = await applyPageEdits({ discovery, read: async (path) => moved[path] ?? null, html, edits: { [titleTarget.htmlFieldId]: { value: "Third thing" } } });
assert.equal(staleWrite.writes.length, 0, "a file that moved under the draft writes nothing"); passed++;
assert.ok(staleWrite.problems.some((problem) => problem.code === "stale"), "and says the source is stale"); passed++;

// ── A file that moved before discovery is reported, not silently skipped ────
const shifted = await discoverPageFields({ manifest, read: async (path) => (path === "data/cards.ts" ? "export const cards = [];" : project[path] ?? null) });
assert.ok(shifted.issues.some((issue) => issue.filePath === "data/cards.ts" && issue.message.includes("changed")), "a file whose bytes moved since the manifest is named"); passed++;
assert.ok(!shifted.sources.some((source) => source.filePath === "data/cards.ts"), "and is not offered as writable"); passed++;

console.log(`websitePageFields: ${passed} page-wide field checks passed`);
