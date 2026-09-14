/** Tablet and phone overrides on a framework page: the annotations written into
 * the file, the CSS derived from them, and the region kept in one stylesheet.
 * Run: npx tsx checks/websiteSourceResponsive.ts
 */
import assert from "node:assert/strict";
import {
  applySourceResponsive, jsxStructureNodes, needsStylesheet, pageEditorCss, readEditorRegion,
  sourceResponsiveState, templateStructureNodes, writeEditorRegion, JsxStructureError,
} from "../src/services/website/index.js";

let passed = 0;
function check(name: string, run: () => void) {
  try { run(); passed++; }
  catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
const JSX = "src/Page.tsx";
const VUE = "src/pages/Index.vue";
function blockId(source: string, filePath: string, tag: string, index = 0) {
  const nodes = filePath.endsWith(".vue") ? templateStructureNodes(source, filePath) : jsxStructureNodes(source, filePath);
  const found = nodes.filter(node => node.tag === tag)[index];
  assert.ok(found, `Expected <${tag}>[${index}]`);
  return found.id;
}
const setDevice = (source: string, filePath: string, tag: string, responsive: { tablet?: string; mobile?: string }, index = 0) =>
  applySourceResponsive(source, filePath, [{ nodeId: blockId(source, filePath, tag, index), responsive }]);
const stateOf = (source: string, filePath: string, tag: string, index = 0) =>
  sourceResponsiveState(source, filePath).find(entry => entry.nodeId === blockId(source, filePath, tag, index))!;
function refuses(run: () => unknown, match: RegExp) {
  assert.throws(run, (error: unknown) => error instanceof JsxStructureError && match.test(error.message), `Expected a refusal matching ${match}`);
}

const jsxPage = 'const Page = () => (<main><section><h2>Title</h2></section></main>);';
const vuePage = "<template><main><section><h2>Title</h2></section></main></template>";

check("a block starts with no overrides and no token", () => {
  const state = stateOf(jsxPage, JSX, "section");
  assert.deepEqual(state.responsive, {});
  assert.equal(state.token, undefined);
  assert.equal(state.reason, undefined);
});
check("setting a phone override writes the answer into the file", () => {
  const result = setDevice(jsxPage, JSX, "section", { mobile: "font-size: 14px" });
  assert.match(result.source, /data-dw-style="dw-[a-f0-9]{24}"/);
  assert.ok(result.source.includes("data-dw-responsive='{\"mobile\":\"font-size: 14px\"}'"));
  assert.deepEqual(result.summary, ["Restyled <section> for phone"]);
  assert.deepEqual(stateOf(result.source, JSX, "section").responsive, { mobile: "font-size: 14px" });
});
check("a template element takes the same two attributes", () => {
  const result = setDevice(vuePage, VUE, "section", { tablet: "padding: 8px" });
  assert.ok(result.source.includes('data-dw-responsive=\'{"tablet":"padding: 8px"}\''));
  assert.ok(result.source.startsWith("<template><main>"));
  assert.deepEqual(stateOf(result.source, VUE, "section").responsive, { tablet: "padding: 8px" });
});
check("the media rules are derived from the file, not stored beside it", () => {
  const source = setDevice(jsxPage, JSX, "section", { tablet: "padding: 8px", mobile: "padding: 4px" }).source;
  const css = pageEditorCss(source, JSX);
  assert.match(css, /@media \(max-width: 1024px\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /padding: 8px !important/);
  // The selector is the token the file carries, repeated for specificity.
  const token = /data-dw-style="(dw-[a-f0-9]{24})"/.exec(source)![1]!;
  assert.ok(css.includes(`[data-dw-style="${token}"]`.repeat(3)));
});
check("changing an override rewrites one attribute and keeps the token", () => {
  const once = setDevice(jsxPage, JSX, "section", { mobile: "font-size: 14px" }).source;
  const token = stateOf(once, JSX, "section").token;
  const twice = setDevice(once, JSX, "section", { mobile: "font-size: 12px" }).source;
  assert.equal(stateOf(twice, JSX, "section").token, token);
  assert.equal(twice.match(/data-dw-responsive/g)?.length, 1);
  assert.deepEqual(stateOf(twice, JSX, "section").responsive, { mobile: "font-size: 12px" });
});
check("clearing every override takes both annotations away again", () => {
  const once = setDevice(jsxPage, JSX, "section", { mobile: "font-size: 14px" }).source;
  const cleared = setDevice(once, JSX, "section", { mobile: "" });
  assert.equal(cleared.source, jsxPage);
  assert.deepEqual(cleared.summary, ["Cleared screen-size styling on <section>"]);
  assert.equal(pageEditorCss(cleared.source, JSX), "");
});
check("a value the generator will not render is refused, not silently dropped", () => {
  refuses(() => setDevice(jsxPage, JSX, "section", { mobile: "background: url(https://example.com/a.png)" }), /cannot save/);
});
check("a component cannot be given screen-size styling", () => {
  const source = 'const Page = () => (<main><Hero title="A" /></main>);';
  assert.match(stateOf(source, JSX, "Hero").reason!, /A component decides/);
  refuses(() => setDevice(source, JSX, "Hero", { mobile: "font-size: 14px" }), /A component decides/);
});
check("a block the layout engine will not touch is refused here too", () => {
  const source = "const Page = ({ rows }: any) => (<main>{rows.map((r: any) => (<article key={r}>A</article>))}</main>);";
  assert.match(stateOf(source, JSX, "article").reason!, /produced by the page's code/);
});
check("an annotation the code computes is never overwritten", () => {
  const source = 'const Page = ({ t }: any) => (<main><section data-dw-style={t}>A</section></main>);';
  assert.match(stateOf(source, JSX, "section").reason!, /come from code/);
  refuses(() => setDevice(source, JSX, "section", { mobile: "font-size: 14px" }), /come from code/);
});
check("hover values need no attribute of their own, only the fixed block", () => {
  const plain = 'const Page = () => (<section style={{ color: "red" }}>A</section>);';
  assert.equal(needsStylesheet(plain, JSX), false);
  assert.equal(pageEditorCss(plain, JSX), "");
  const hovered = 'const Page = () => (<section style={{ "--dw-hover-color": "blue" }}>A</section>);';
  assert.equal(needsStylesheet(hovered, JSX), true);
  assert.match(pageEditorCss(hovered, JSX), /--dw-hover-color/);
  assert.match(pageEditorCss(hovered, JSX), /:hover/);
});
check("a page's region is fenced by its own path and replaced in place", () => {
  const sheet = "body { margin: 0; }\n";
  const written = writeEditorRegion(sheet, "app/page.tsx", "@media (max-width: 640px){a{color:red;}}");
  assert.ok(written.startsWith("body { margin: 0; }"));
  assert.match(written, /dakyworld-editor:start app\/page\.tsx/);
  assert.equal(readEditorRegion(written, "app/page.tsx"), "@media (max-width: 640px){a{color:red;}}");
  const again = writeEditorRegion(written, "app/page.tsx", "@media (max-width: 640px){a{color:blue;}}");
  assert.equal(again.match(/dakyworld-editor:start/g)?.length, 1);
  assert.ok(again.includes("color:blue"));
  assert.ok(!again.includes("color:red"));
});
check("two pages keep their own regions in one stylesheet", () => {
  const one = writeEditorRegion("body{}\n", "app/page.tsx", "a{color:red;}");
  const two = writeEditorRegion(one, "app/pricing/page.tsx", "b{color:blue;}");
  assert.equal(readEditorRegion(two, "app/page.tsx"), "a{color:red;}");
  assert.equal(readEditorRegion(two, "app/pricing/page.tsx"), "b{color:blue;}");
  const removed = writeEditorRegion(two, "app/page.tsx", "");
  assert.equal(readEditorRegion(removed, "app/page.tsx"), "");
  assert.equal(readEditorRegion(removed, "app/pricing/page.tsx"), "b{color:blue;}");
  assert.ok(removed.startsWith("body{}"));
});
check("an empty region is never left behind as a fence", () => {
  const written = writeEditorRegion("body{}\n", "app/page.tsx", "a{color:red;}");
  assert.equal(writeEditorRegion(written, "app/page.tsx", ""), "body{}\n");
  assert.equal(writeEditorRegion("body{}\n", "app/page.tsx", ""), "body{}\n");
});
check("a page path cannot close another page's fence", () => {
  const written = writeEditorRegion("", "app/page.tsx", "a{color:red;}");
  assert.equal(readEditorRegion(written, "app/page.tsx*/ /*"), "");
  assert.equal(readEditorRegion(written, "app/page.tsx"), "a{color:red;}");
});
check("Markdown has no screen-size styling to give", () => {
  assert.deepEqual(sourceResponsiveState("# A\n", "content/a.md"), []);
  refuses(() => applySourceResponsive("# A\n", "content/a.md", [{ nodeId: "x", responsive: { mobile: "font-size: 14px" } }]), /no elements/);
  assert.equal(pageEditorCss("# A\n", "content/a.md"), "");
});

console.log(`websiteSourceResponsive: ${passed} focused checks passed`);
