/**
 * Editing `.astro`, `.vue` and `.svelte` files without a compiler for any of them.
 *
 * The risk this is written against is specific: the adapter scans markup rather
 * than parsing a language it understands, so the way it fails is by being too
 * confident — editing something that was an expression, escaping something that
 * was markup, or writing a value back at an offset that belonged to the file's
 * code. Every one of those produces a file that still looks fine and no longer
 * builds.
 *
 * So the assertions are:
 *
 *  - what is offered: literal text and static href/src/alt on native elements;
 *  - what is refused, with a reason: braces in any of the three languages,
 *    bound and directive attributes, `<script>`, `<style>`, Astro frontmatter,
 *    a `<script setup>` block, and a component's own props;
 *  - that an accepted edit round-trips — discover, apply, discover again, and
 *    the same fields with the same IDs and only the edited value changed;
 *  - that a rejected edit changes nothing at all, which is the whole contract
 *    the review and publish route is built on.
 */
import assert from "node:assert/strict";
import { applyTemplateValues, discoverTemplateFields } from "../src/services/website/template.js";

let passed = 0;
const field = (fields: { id: string; tag: string; kind: string; value: string }[], tag: string, kind: string) => fields.find((candidate) => candidate.tag === tag && candidate.kind === kind);
const values = (fields: { value: string }[]) => fields.map((candidate) => candidate.value).sort();

// ── Astro ───────────────────────────────────────────────────────────────────
const astro = `---
const title = "Home";
import Layout from "../layouts/Layout.astro";
---
<Layout title={title}>
  <h1>Welcome to Dakyworld</h1>
  <p>We build websites. <a href="/contact">Talk to us</a></p>
  <p>Signed in as {user.name}</p>
  <img src="/hero.png" alt="The team" />
  <style>h1 { color: red; }</style>
</Layout>
`;
const astroFound = discoverTemplateFields(astro, "src/pages/index.astro");
assert.equal(astroFound.adapter, "template-literal-v1"); passed++;
assert.deepEqual(values(astroFound.fields), ["/contact", "/hero.png", "Talk to us", "The team", "We build websites.", "Welcome to Dakyworld"]); passed++;
// The frontmatter is never scanned, so its string never appears as a field.
assert.ok(!astroFound.fields.some((entry) => entry.value === "Home")); passed++;
assert.ok(astroFound.issues.some((issue) => issue.code === "unsupported" && /frontmatter/i.test(issue.message))); passed++;
// `{user.name}` is code and says so rather than being silently dropped.
assert.ok(astroFound.issues.some((issue) => issue.code === "dynamic")); passed++;
assert.ok(astroFound.issues.some((issue) => issue.code === "unsupported" && /<style>/.test(issue.message))); passed++;
// A component's props are the component's business.
assert.ok(astroFound.issues.some((issue) => issue.code === "unsupported" && /<Layout>/.test(issue.message))); passed++;

const heading = astroFound.fields.find((entry) => entry.value === "Welcome to Dakyworld")!;
const astroEdited = applyTemplateValues(astro, { filePath: "src/pages/index.astro", sourceHash: astroFound.sourceHash, changes: [{ fieldId: heading.id, value: "Welcome to Dakyworld Ltd" }] });
assert.deepEqual(astroEdited.problems, []); passed++;
assert.ok(astroEdited.source.includes("<h1>Welcome to Dakyworld Ltd</h1>")); passed++;
assert.ok(astroEdited.source.startsWith("---\nconst title")); passed++;
const astroAgain = discoverTemplateFields(astroEdited.source, "src/pages/index.astro");
assert.equal(astroAgain.fields.length, astroFound.fields.length); passed++;
assert.equal(astroAgain.fields.find((entry) => entry.id === heading.id)?.value, "Welcome to Dakyworld Ltd"); passed++;

// A value carrying a brace is escaped rather than written as an expression.
const braced = applyTemplateValues(astro, { filePath: "src/pages/index.astro", sourceHash: astroFound.sourceHash, changes: [{ fieldId: heading.id, value: "Save {50%} today" }] });
assert.deepEqual(braced.problems, []); passed++;
assert.ok(braced.source.includes("Save &#123;50%&#125; today")); passed++;
assert.equal(discoverTemplateFields(braced.source, "src/pages/index.astro").fields.find((entry) => entry.id === heading.id)?.value, "Save {50%} today"); passed++;

// ── Vue ─────────────────────────────────────────────────────────────────────
const vue = `<template>
  <section>
    <h2>Our plans</h2>
    <p>{{ tagline }}</p>
    <a href="/pricing">See pricing</a>
    <a :href="dynamic">Dynamic</a>
    <img src="/plans.png" alt="Plans" />
  </section>
</template>

<script setup>
const tagline = "Built for growth";
</script>

<style scoped>
h2 { font-size: 2rem; }
</style>
`;
const vueFound = discoverTemplateFields(vue, "pages/plans.vue");
// "Dynamic" is in the list on purpose: the link's destination is bound and stays
// the code's, but the words between its tags are as literal as any other text,
// and refusing them would make a bound href quietly freeze a whole sentence.
assert.deepEqual(values(vueFound.fields), ["/plans.png", "/pricing", "Dynamic", "Our plans", "Plans", "See pricing"]); passed++;
// The mustache, the bound destination and the script's own string are refused.
assert.ok(!vueFound.fields.some((entry) => entry.value.includes("tagline") || entry.value === "Built for growth" || entry.value === "dynamic")); passed++;
assert.ok(vueFound.issues.some((issue) => issue.code === "dynamic")); passed++;
const link = field(vueFound.fields, "a", "href")!;
const vueEdited = applyTemplateValues(vue, { filePath: "pages/plans.vue", sourceHash: vueFound.sourceHash, changes: [{ fieldId: link.id, value: "/plans-and-pricing" }] });
assert.deepEqual(vueEdited.problems, []); passed++;
assert.ok(vueEdited.source.includes('<a href="/plans-and-pricing">See pricing</a>')); passed++;
assert.ok(vueEdited.source.includes('const tagline = "Built for growth";')); passed++;

// A destination with a space in it is refused, by the same rule the JSX adapter
// uses — one validator, so the two adapters cannot disagree about a link.
const badLink = applyTemplateValues(vue, { filePath: "pages/plans.vue", sourceHash: vueFound.sourceHash, changes: [{ fieldId: link.id, value: "/plans and pricing" }] });
assert.equal(badLink.source, vue); passed++;
assert.deepEqual(badLink.changed, []); passed++;
assert.equal(badLink.problems[0]?.code, "invalid"); passed++;
// `javascript:` is refused for the same reason it is in the HTML editor.
assert.equal(applyTemplateValues(vue, { filePath: "pages/plans.vue", sourceHash: vueFound.sourceHash, changes: [{ fieldId: link.id, value: "javascript:alert(1)" }] }).problems[0]?.code, "invalid"); passed++;

// ── Svelte ──────────────────────────────────────────────────────────────────
const svelte = `<script lang="ts">
  export let name: string;
  const url = "/go";
</script>

<h1>Hello there</h1>
{#if name}
  <p>Hello {name}</p>
{/if}
<a href="/about">About us</a>
<a href={url}>Coded</a>

<style>
  h1 { color: blue; }
</style>
`;
const svelteFound = discoverTemplateFields(svelte, "src/routes/+page.svelte");
// "Coded" for the same reason as Vue's "Dynamic": the destination is code, the
// words are not.
assert.deepEqual(values(svelteFound.fields), ["/about", "About us", "Coded", "Hello there"]); passed++;
// `{#if}`, `{name}` and the value of `href={url}` are code; script and style are
// opaque, so nothing from either is offered.
assert.ok(!svelteFound.fields.some((entry) => entry.value.includes("{") || entry.value === "/go" || entry.value.includes("export let"))); passed++;
const greeting = svelteFound.fields.find((entry) => entry.value === "Hello there")!;
const svelteEdited = applyTemplateValues(svelte, { filePath: "src/routes/+page.svelte", sourceHash: svelteFound.sourceHash, changes: [{ fieldId: greeting.id, value: "Hello from Dakyworld" }] });
assert.deepEqual(svelteEdited.problems, []); passed++;
assert.ok(svelteEdited.source.includes("<h1>Hello from Dakyworld</h1>")); passed++;
assert.ok(svelteEdited.source.includes("{#if name}") && svelteEdited.source.includes("const url = \"/go\";")); passed++;

// ── The contract every caller depends on ────────────────────────────────────
// Stale: the file moved under the edit, so nothing is written and it says so.
assert.equal(applyTemplateValues(svelte, { filePath: "src/routes/+page.svelte", sourceHash: "0".repeat(64), changes: [{ fieldId: greeting.id, value: "x" }] }).problems[0]?.code, "stale"); passed++;
// Unknown: a field ID from another file, or from a version that had one.
assert.equal(applyTemplateValues(svelte, { filePath: "src/routes/+page.svelte", sourceHash: svelteFound.sourceHash, changes: [{ fieldId: "tpl_nope", value: "x" }] }).problems[0]?.code, "unknown"); passed++;
// The same field twice is a client bug, not a last-one-wins.
assert.equal(applyTemplateValues(svelte, { filePath: "src/routes/+page.svelte", sourceHash: svelteFound.sourceHash, changes: [{ fieldId: greeting.id, value: "a" }, { fieldId: greeting.id, value: "b" }] }).problems[0]?.code, "duplicate"); passed++;
// Emptying a text field would delete the node it lives in, so it is refused
// rather than quietly restructuring somebody's markup.
assert.equal(applyTemplateValues(svelte, { filePath: "src/routes/+page.svelte", sourceHash: svelteFound.sourceHash, changes: [{ fieldId: greeting.id, value: "   " }] }).source, svelte); passed++;
// Markup typed into a text box is text, and comes back as the same text.
const tagged = applyTemplateValues(svelte, { filePath: "src/routes/+page.svelte", sourceHash: svelteFound.sourceHash, changes: [{ fieldId: greeting.id, value: "Hello <script>alert(1)</script>" }] });
assert.deepEqual(tagged.problems, []); passed++;
assert.ok(!tagged.source.includes("<script>alert(1)</script>")); passed++;
assert.equal(discoverTemplateFields(tagged.source, "src/routes/+page.svelte").fields.find((entry) => entry.id === greeting.id)?.value, "Hello <script>alert(1)</script>"); passed++;

// A file this adapter does not own is refused rather than half-parsed.
assert.throws(() => discoverTemplateFields("<h1>x</h1>", "src/pages/index.tsx")); passed++;
assert.throws(() => discoverTemplateFields("<h1>x</h1>", "../secrets/index.vue")); passed++;

// IDs are structural, so comments and reformatting elsewhere do not renumber
// them — a draft prepared before a colleague's commit still applies to the same
// field afterwards, or fails as stale, never as the wrong field.
const commented = svelte.replace("<h1>Hello there</h1>", "<!-- greeting -->\n<h1>Hello there</h1>");
assert.equal(discoverTemplateFields(commented, "src/routes/+page.svelte").fields.find((entry) => entry.value === "Hello there")?.id, greeting.id); passed++;

// A marker pins the ID to the marker instead, so the element may move.
const marked = `<h1 data-dw-field="hero.title">Hello there</h1><div><h1 data-dw-field="hero.title">Twin</h1></div>`;
const markedFound = discoverTemplateFields(marked, "src/routes/+page.svelte");
// Two elements claiming one marker is ambiguous, and both go read-only rather
// than one of them silently winning.
assert.equal(markedFound.fields.length, 0); passed++;
assert.ok(markedFound.issues.some((issue) => issue.code === "ambiguous")); passed++;
const single = discoverTemplateFields(`<section><h1 data-dw-field="hero.title">Hello there</h1></section>`, "src/routes/+page.svelte");
const moved = discoverTemplateFields(`<main><div><h1 data-dw-field="hero.title">Hello there</h1></div></main>`, "src/routes/+page.svelte");
assert.equal(single.fields[0]!.id, moved.fields[0]!.id); passed++;
assert.equal(single.fields[0]!.marker, "hero.title"); passed++;

console.log(`websiteTemplate: ${passed} template discovery, editing and refusal checks passed`);
