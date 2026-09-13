/**
 * Editing a Markdown page — front matter and body — without breaking the build.
 *
 * Docusaurus, Eleventy, Hugo, Jekyll and Astro's content collections all keep
 * pages this way, so listing those sites without being able to change a word in
 * them would be a page list attached to nothing.
 *
 * Markdown is the one format here where the words are the file rather than
 * something inside it, and the ways that goes wrong are its own:
 *
 *  - a front matter value rewritten so it is no longer valid YAML — a colon, a
 *    quote, a newline, a word YAML reads as `true`;
 *  - structure treated as content: a tag list, a date, a nested map, a block
 *    scalar, all of which a theme reads and none of which are a sentence;
 *  - the fence itself eaten, so the front matter becomes body text and the page
 *    loses its title, its date and its layout at once.
 */
import assert from "node:assert/strict";
import { applyMarkdownValues, discoverMarkdownFields } from "../src/services/website/index.js";

let passed = 0;
const page = [
  "---",
  "title: Our pricing",
  'description: "What it costs, and why"',
  "layout: page",
  "date: 2026-09-13",
  "tags: [pricing, plans]",
  "author: Dan",
  "draft: false",
  "---",
  "",
  "# Our pricing",
  "",
  "Every plan includes hosting, updates and a person who answers.",
  "",
  "- Starter, GHS 450 a month",
  "- Growth, GHS 1,200 a month",
  "",
].join("\n");
const found = discoverMarkdownFields(page, "content/pricing.md");
const labels = found.fields.map((field) => field.label).sort();

// ── What is offered ─────────────────────────────────────────────────────────
assert.deepEqual(labels, ["Page body", "author", "description", "title"]); passed++;
assert.equal(found.fields.find((field) => field.label === "title")?.value, "Our pricing"); passed++;
// A quoted value comes back without its quotes; they are syntax, not content.
assert.equal(found.fields.find((field) => field.label === "description")?.value, "What it costs, and why"); passed++;
// The body is one field, because Markdown's meaning is in its layout and
// handing somebody half of it invites them to destroy the other half.
const body = found.fields.find((field) => field.label === "Page body")!;
assert.ok(body.value.startsWith("# Our pricing") && body.value.includes("GHS 1,200")); passed++;

// ── What is not ─────────────────────────────────────────────────────────────
// `layout`, `date`, `tags` and `draft` are structure a theme reads.
assert.ok(!labels.includes("layout") && !labels.includes("date") && !labels.includes("tags") && !labels.includes("draft")); passed++;

// ── Editing, and the file still being the same file ─────────────────────────
const title = found.fields.find((field) => field.label === "title")!;
const edited = applyMarkdownValues(page, {
  filePath: "content/pricing.md",
  sourceHash: found.sourceHash,
  changes: [
    { fieldId: title.id, value: "Pricing and plans" },
    { fieldId: body.id, value: "# Pricing and plans\n\nEvery plan includes hosting and a person who answers." },
  ],
});
assert.deepEqual(edited.problems, []); passed++;
assert.ok(edited.source.startsWith("---\ntitle: Pricing and plans\n")); passed++;
assert.ok(edited.source.includes("date: 2026-09-13") && edited.source.includes("tags: [pricing, plans]")); passed++;
assert.ok(edited.source.includes("# Pricing and plans\n\nEvery plan includes hosting and a person who answers.")); passed++;
assert.ok(!edited.source.includes("GHS 1,200")); passed++;
const again = discoverMarkdownFields(edited.source, "content/pricing.md");
assert.equal(again.fields.length, found.fields.length); passed++;
assert.equal(again.fields.find((field) => field.id === title.id)?.value, "Pricing and plans"); passed++;

// A value YAML would misread is quoted on the way back, and reads the same on
// the way in — this is the whole reason the round trip is checked.
for (const risky of ["Pricing: the details", "true", "  leading space", '"Quoted"', "#hashtag", "12"]) {
  const result = applyMarkdownValues(page, { filePath: "content/pricing.md", sourceHash: found.sourceHash, changes: [{ fieldId: title.id, value: risky }] });
  assert.deepEqual(result.problems, [], `${risky} should be writable`);
  assert.equal(discoverMarkdownFields(result.source, "content/pricing.md").fields.find((field) => field.id === title.id)?.value, risky); passed++;
}

// A newline in a front matter value would end the value and turn the rest into
// a key, so it is refused rather than written.
assert.equal(applyMarkdownValues(page, { filePath: "content/pricing.md", sourceHash: found.sourceHash, changes: [{ fieldId: title.id, value: "Two\nlines" }] }).problems[0]?.code, "invalid"); passed++;
// A body that starts with a fence would swallow the front matter.
assert.equal(applyMarkdownValues(page, { filePath: "content/pricing.md", sourceHash: found.sourceHash, changes: [{ fieldId: body.id, value: "---\ntitle: Nope\n---" }] }).problems[0]?.code, "invalid"); passed++;
// Stale and unknown behave as they do everywhere else.
assert.equal(applyMarkdownValues(page, { filePath: "content/pricing.md", sourceHash: "0".repeat(64), changes: [{ fieldId: title.id, value: "x" }] }).problems[0]?.code, "stale"); passed++;
assert.equal(applyMarkdownValues(page, { filePath: "content/pricing.md", sourceHash: found.sourceHash, changes: [{ fieldId: "md_nope", value: "x" }] }).problems[0]?.code, "unknown"); passed++;

// ── A page with no front matter at all ──────────────────────────────────────
const plain = discoverMarkdownFields("# Just words\n\nAnd a paragraph.\n", "docs/intro.md");
assert.deepEqual(plain.fields.map((field) => field.label), ["Page body"]); passed++;
assert.equal(plain.fields[0]!.value, "# Just words\n\nAnd a paragraph."); passed++;

// ── MDX says what it is carrying ────────────────────────────────────────────
const mdx = discoverMarkdownFields("---\ntitle: Guide\n---\n\n<Callout type=\"info\">Read this</Callout>\n\nWords.\n", "docs/guide.mdx");
assert.ok(mdx.issues.some((issue) => issue.code === "dynamic")); passed++;
assert.ok(mdx.fields.some((field) => field.label === "title")); passed++;

// A file this adapter does not own is refused rather than half-read.
assert.throws(() => discoverMarkdownFields("# x", "src/Page.tsx")); passed++;

console.log(`websiteMarkdown: ${passed} front matter and body checks passed`);
