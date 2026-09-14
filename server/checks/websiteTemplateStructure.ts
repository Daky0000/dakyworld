/** Layout editing for .astro, .vue and .svelte: what may move, what the
 * language's own control flow keeps, and that every result still reads.
 * Run: npx tsx checks/websiteTemplateStructure.ts
 */
import assert from "node:assert/strict";
import { changeTemplateStructure, discoverTemplateFields, replayTemplateStructure, templateStructureNodes, JsxStructureError, type JsxStructureNode } from "../src/services/website/index.js";

let passed = 0;
function check(name: string, run: () => void) {
  try { run(); passed++; }
  catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
const nodes = (source: string, filePath: string) => templateStructureNodes(source, filePath);
function node(source: string, filePath: string, tag: string, index = 0): JsxStructureNode {
  const found = nodes(source, filePath).filter((candidate) => candidate.tag === tag)[index];
  assert.ok(found, `Expected <${tag}>[${index}] in ${filePath}`);
  return found;
}
const act = (source: string, filePath: string, kind: "remove" | "duplicate" | "before" | "after", nodeId: string, targetId?: string) =>
  changeTemplateStructure(source, filePath, { kind, nodeId, ...(targetId && { targetId }) });
function refuses(run: () => unknown, match: RegExp) {
  assert.throws(run, (error: unknown) => error instanceof JsxStructureError && match.test(error.message), `Expected a refusal matching ${match}`);
}

const astro = [
  "---",
  "const title = 'Pricing';",
  "---",
  "<main>",
  '  <section data-dw-field="one"><h2>First</h2></section>',
  '  <section data-dw-field="two"><h2>Second</h2></section>',
  "  <footer>End</footer>",
  "</main>",
  "",
].join("\n");
const vue = [
  "<template>",
  "  <main>",
  "    <section><h2>First</h2></section>",
  "    <section><h2>Second</h2></section>",
  "  </main>",
  "</template>",
  "",
  "<script setup>",
  "const total = 2;",
  "</script>",
  "",
].join("\n");
const svelte = [
  "<script>",
  "  export let items = [];",
  "</script>",
  "",
  "<main>",
  "  <section><h2>First</h2></section>",
  "  {#each items as item}",
  "    <article><h3>Row</h3></article>",
  "  {/each}",
  "  <footer>End</footer>",
  "</main>",
  "",
].join("\n");

check("an Astro page lists its blocks and never its frontmatter", () => {
  const listed = nodes(astro, "src/pages/index.astro");
  assert.deepEqual(listed.map((item) => item.tag), ["main", "section", "h2", "section", "h2", "footer"]);
  const first = node(astro, "src/pages/index.astro", "section", 0);
  assert.equal(first.marker, "one");
  assert.equal(first.nextId, node(astro, "src/pages/index.astro", "section", 1).id);
  assert.equal(first.remove, true);
});
check("an Astro block is removed, copied and moved, and the file still reads", () => {
  const path = "src/pages/index.astro";
  const removed = act(astro, path, "remove", node(astro, path, "section", 0).id);
  assert.ok(!removed.source.includes("First") && removed.source.includes("Second"));
  assert.deepEqual(discoverTemplateFields(removed.source, path).issues.filter((issue) => issue.code === "syntax"), []);
  const copied = act(astro, path, "duplicate", node(astro, path, "section", 0).id);
  assert.equal(copied.source.match(/First/g)?.length, 2);
  assert.equal(copied.source.match(/data-dw-field="one"/g)?.length, 1);
  const moved = act(astro, path, "after", node(astro, path, "section", 0).id, node(astro, path, "footer").id);
  assert.ok(moved.source.indexOf("First") > moved.source.indexOf("End"));
  assert.equal(moved.summary, "Moved <section>");
  // The frontmatter is untouched by all three.
  for (const result of [removed, copied, moved]) assert.ok(result.source.startsWith("---\nconst title = 'Pricing';\n---"));
});
check("a Vue template rearranges inside its own block only", () => {
  const path = "src/pages/Index.vue";
  const listed = nodes(vue, path);
  assert.deepEqual(listed.map((item) => item.tag), ["main", "section", "h2", "section", "h2"]);
  const moved = act(vue, path, "after", node(vue, path, "section", 0).id, node(vue, path, "section", 1).id);
  assert.ok(moved.source.indexOf("Second") < moved.source.indexOf("First"));
  assert.ok(moved.source.includes("<script setup>\nconst total = 2;\n</script>"));
});
check("a Svelte block inside {#each} is refused by name", () => {
  const path = "src/routes/+page.svelte";
  const article = node(svelte, path, "article");
  assert.equal(article.remove, false);
  assert.match(article.reason!, /produced by the page's code/);
  refuses(() => act(svelte, path, "remove", article.id), /produced by the page's code/);
  // The blocks either side of the loop are still ordinary blocks.
  assert.equal(node(svelte, path, "section").remove, true);
  assert.equal(node(svelte, path, "footer").remove, true);
});
check("a Svelte page keeps its script and moves only its markup", () => {
  const path = "src/routes/+page.svelte";
  const moved = act(svelte, path, "after", node(svelte, path, "section").id, node(svelte, path, "footer").id);
  assert.ok(moved.source.indexOf("First") > moved.source.indexOf("End"));
  assert.ok(moved.source.includes("export let items = [];"));
  assert.ok(moved.source.includes("{#each items as item}"));
});
check("an element carrying v-if or v-for stays where its author put it", () => {
  const path = "src/pages/Index.vue";
  const source = '<template><main><section v-if="ready"><h2>A</h2></section><section v-else><h2>B</h2></section><p v-for="row in rows">{{ row }}</p><aside>C</aside></main></template>';
  for (const tag of ["section", "p"]) assert.match(node(source, path, tag).reason!, /condition or a loop/);
  assert.equal(node(source, path, "aside").remove, true);
});
check("an Astro expression's contents belong to the code", () => {
  const path = "src/pages/index.astro";
  const source = "<main>{items.map((item) => (<article><h3>Row</h3></article>))}<section>A</section></main>";
  assert.match(node(source, path, "article").reason!, /produced by the page's code/);
  assert.equal(node(source, path, "section").remove, true);
});
check("forms, scripts and styles keep the rules the HTML engine gives them", () => {
  const path = "src/pages/index.astro";
  const source = '<main><form action="/x"><label>Email</label></form><section><h2>A</h2></section></main>';
  assert.match(node(source, path, "form").reason!, /controlled by the page source/);
  assert.match(node(source, path, "label").reason!, /interactive or source-controlled/);
  assert.equal(node(source, path, "section").remove, true);
  const wrapping = '<main><section><form action="/x" /></section><p>B</p></main>';
  assert.match(node(wrapping, path, "section").reason!, /interactive code or forms/);
});
check("fixed IDs block duplication but not removal", () => {
  const path = "src/pages/index.astro";
  const source = '<main><section id="pricing"><h2>A</h2></section><p>B</p></main>';
  const section = node(source, path, "section");
  assert.equal(section.remove, true);
  assert.equal(section.duplicate, false);
  refuses(() => act(source, path, "duplicate", section.id), /fixed IDs/);
});
check("a component is a block like any other", () => {
  const path = "src/pages/index.astro";
  const source = '<main><Hero title="A" /><Pricing /></main>';
  assert.equal(node(source, path, "Hero").remove, true);
  const moved = act(source, path, "after", node(source, path, "Hero").id, node(source, path, "Pricing").id);
  assert.ok(moved.source.indexOf("Hero") > moved.source.indexOf("Pricing"));
});
check("a clone gets its own style key rather than sharing one", () => {
  const path = "src/pages/index.astro";
  const source = '<main><section data-dw-style="dw-band"><h2>A</h2></section><p>B</p></main>';
  const keys = [...act(source, path, "duplicate", node(source, path, "section").id).source.matchAll(/data-dw-style="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});
check("a block cannot move beside a block in another container", () => {
  const path = "src/pages/index.astro";
  refuses(() => act(astro, path, "before", node(astro, path, "section", 0).id, node(astro, path, "h2", 1).id), /same container/);
});
check("the outermost block of a region has nowhere to go", () => {
  const path = "src/pages/index.astro";
  const main = node(astro, path, "main");
  assert.equal(main.remove, true);
  assert.equal(main.previousId, undefined);
  assert.equal(main.nextId, undefined);
});
check("an untouched sibling keeps its ID after a neighbour is duplicated", () => {
  const path = "src/pages/index.astro";
  const after = act(astro, path, "duplicate", node(astro, path, "section", 0).id).source;
  assert.equal(node(after, path, "footer").id, node(astro, path, "footer").id);
});
check("a replayed action list applies in order and reports each step", () => {
  const path = "src/pages/index.astro";
  const result = replayTemplateStructure(astro, path, [
    { kind: "duplicate", nodeId: node(astro, path, "section", 0).id },
    { kind: "remove", nodeId: node(astro, path, "footer").id },
  ]);
  assert.deepEqual(result.summary, ["Duplicated <section>", "Removed <footer>"]);
  assert.equal(result.source.match(/First/g)?.length, 2);
  assert.ok(!result.source.includes("End"));
});
check("an unclosed tag is refused before any layout is offered", () => {
  refuses(() => nodes("<main><section><h2>A</h2></main>", "src/pages/index.astro"), /never closed/);
  refuses(() => nodes("<template><main><section></main></template>", "src/pages/Index.vue"), /never closed/);
});
check("a file this adapter does not own is refused", () => {
  assert.throws(() => templateStructureNodes(astro, "src/Page.tsx"), /\.astro, \.vue and \.svelte/);
  assert.throws(() => templateStructureNodes(astro, "../secret.astro"), /relative to the connected repository/);
});
check("a void element is a sibling, not a container", () => {
  const path = "src/pages/index.astro";
  const source = '<main><img src="/a.png" alt="A" /><br><section><h2>B</h2></section></main>';
  assert.equal(node(source, path, "section").parentId, node(source, path, "main").id);
  assert.equal(node(source, path, "img").remove, true);
});

console.log(`websiteTemplateStructure: ${passed} focused checks passed`);
