/** Styling a block of a framework page: what is written into JSX and into a
 * template, what is read back, and what is refused to the code.
 * Run: npx tsx checks/websiteSourceStyle.ts
 */
import assert from "node:assert/strict";
import { applySourceStyles, jsxStructureNodes, sourceStyleState, templateStructureNodes, JsxStructureError } from "../src/services/website/index.js";

let passed = 0;
function check(name: string, run: () => void) {
  try { run(); passed++; }
  catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
const JSX = "src/Page.tsx";
const VUE = "src/pages/Index.vue";
function blockId(source: string, filePath: string, tag: string, index = 0) {
  const nodes = filePath.endsWith(".vue") ? templateStructureNodes(source, filePath) : jsxStructureNodes(source, filePath);
  const found = nodes.filter((node) => node.tag === tag)[index];
  assert.ok(found, `Expected <${tag}>[${index}]`);
  return found.id;
}
const style = (source: string, filePath: string, tag: string, value: string, index = 0) =>
  applySourceStyles(source, filePath, [{ nodeId: blockId(source, filePath, tag, index), style: value }]);
const stateOf = (source: string, filePath: string, tag: string, index = 0) => {
  const id = blockId(source, filePath, tag, index);
  return sourceStyleState(source, filePath).find((entry) => entry.nodeId === id)!;
};
function refuses(run: () => unknown, match: RegExp) {
  assert.throws(run, (error: unknown) => error instanceof JsxStructureError && match.test(error.message), `Expected a refusal matching ${match}`);
}

const jsxPage = 'const Page = () => (<main><section><h2>Title</h2></section></main>);';
const vuePage = "<template><main><section><h2>Title</h2></section></main></template>";

check("a JSX element gains a style object React can read", () => {
  const result = style(jsxPage, JSX, "section", "font-size: 20px; background-color: #fff");
  assert.ok(result.source.includes('style={{ fontSize: "20px", backgroundColor: "#fff" }}'));
  assert.equal(result.changed.length, 1);
  assert.deepEqual(result.summary, ["Restyled <section>"]);
});
check("a template element gains a plain HTML style attribute", () => {
  const result = style(vuePage, VUE, "section", "font-size: 20px");
  assert.ok(result.source.includes('<section style="font-size: 20px">'));
  assert.ok(result.source.startsWith("<template><main>"));
});
check("existing declarations are read back in CSS spelling", () => {
  const source = 'const Page = () => (<section style={{ fontSize: "20px", "--brand": "red" }}>A</section>);';
  assert.equal(stateOf(source, JSX, "section").style, "font-size: 20px; --brand: red");
  assert.equal(stateOf('<template><section style="color: red">A</section></template>', VUE, "section").style, "color: red");
});
check("a second edit replaces the whole declaration list, not the element", () => {
  const once = style(jsxPage, JSX, "section", "color: red");
  const twice = style(once.source, JSX, "section", "color: blue; margin-top: 8px");
  assert.ok(twice.source.includes('style={{ color: "blue", marginTop: "8px" }}'));
  assert.equal(twice.source.match(/style=/g)?.length, 1);
  assert.ok(twice.source.includes("<h2>Title</h2>"));
});
check("clearing every declaration removes the attribute rather than emptying it", () => {
  const once = style(jsxPage, JSX, "section", "color: red");
  const cleared = style(once.source, JSX, "section", "");
  assert.equal(cleared.source, jsxPage);
  const vueOnce = style(vuePage, VUE, "section", "color: red");
  assert.equal(style(vueOnce.source, VUE, "section", "").source, vuePage);
});
check("a numeric JSX value reads back as pixels, the way React renders it", () => {
  assert.equal(stateOf('const Page = () => (<section style={{ marginTop: 8 }}>A</section>);', JSX, "section").style, "margin-top: 8px");
});
check("the same sanitiser as the HTML editor decides what is allowed", () => {
  const result = style(jsxPage, JSX, "section", "color: red; position: fixed; behavior: url(x.htc)");
  assert.ok(result.source.includes('color: "red"'));
  assert.ok(!result.source.includes("behavior"));
  refuses(() => style(jsxPage, JSX, "section", "behavior: url(x.htc)"), /None of those style declarations are allowed/);
});
check("a style the code computes is never overwritten", () => {
  const jsx = 'const Page = ({ s }: any) => (<section style={s}><h2>A</h2></section>);';
  assert.match(stateOf(jsx, JSX, "section").reason!, /comes from code/);
  refuses(() => style(jsx, JSX, "section", "color: red"), /comes from code/);
  const bound = '<template><section :style="s"><h2>A</h2></section></template>';
  assert.match(stateOf(bound, VUE, "section").reason!, /bound to code/);
  refuses(() => style(bound, VUE, "section", "color: red"), /bound to code/);
});
check("spread props make an element's appearance the code's too", () => {
  const source = 'const Page = (props: any) => (<section {...props}><h2>A</h2></section>);';
  assert.match(stateOf(source, JSX, "section").reason!, /spread from code/);
});
check("a block the layout engine will not touch cannot be restyled either", () => {
  const source = "const Page = ({ items }: any) => (<main>{items.map((i: any) => (<article key={i}>A</article>))}</main>);";
  assert.match(stateOf(source, JSX, "article").reason!, /produced by the page's code/);
  refuses(() => style(source, JSX, "article", "color: red"), /produced by the page's code/);
  const form = '<template><main><form action="/x"><label>A</label></form></main></template>';
  assert.match(stateOf(form, VUE, "form").reason!, /controlled by the page source/);
});
check("a Markdown page says it has nothing to style", () => {
  assert.deepEqual(sourceStyleState("# About\n", "content/about.md"), []);
  refuses(() => applySourceStyles("# About\n", "content/about.md", [{ nodeId: "mdnode_x", style: "color: red" }]), /no elements to style/);
});
check("an invented block ID is refused rather than guessed at", () => {
  refuses(() => applySourceStyles(jsxPage, JSX, [{ nodeId: "jsxnode_gone", style: "color: red" }]), /no longer in this file/);
});
check("a broken file is one refusal, not a half-styled page", () => {
  refuses(() => sourceStyleState("const Page = () => (<main><h2>A</h2>);", JSX), /syntax error/);
});
check("styling one block leaves every other byte alone", () => {
  const source = '// header\nconst Page = () => (<main>\n  <section id="a"><h2>Title</h2></section>\n  <section id="b"><h2>Other</h2></section>\n</main>);\n';
  const result = style(source, JSX, "section", "color: red", 1);
  // A new attribute lands where the HTML engine puts one: straight after the tag
  // name, leaving the developer's own attributes in the order they wrote them.
  assert.equal(result.source, source.replace('<section id="b">', '<section style={{ color: "red" }} id="b">'));
});
check("a self-closing component can be styled like any other block", () => {
  const source = 'const Page = () => (<main><Hero title="A" /></main>);';
  const result = style(source, JSX, "Hero", "margin-top: 8px");
  assert.ok(result.source.includes('<Hero style={{ marginTop: "8px" }} title="A" />'));
});

console.log(`websiteSourceStyle: ${passed} focused checks passed`);
