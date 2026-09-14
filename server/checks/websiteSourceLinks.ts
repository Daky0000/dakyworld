/** Opening a framework page's link in a new tab: the rel that must travel with
 * it, the removal that takes the attribute away, and what stays the code's.
 * Run: npx tsx checks/websiteSourceLinks.ts
 */
import assert from "node:assert/strict";
import { applySourceLinks, sourceLinkState, jsxStructureNodes, templateStructureNodes, JsxStructureError } from "../src/services/website/index.js";

let passed = 0;
function check(name: string, run: () => void) {
  try { run(); passed++; }
  catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
const JSX = "src/Page.tsx";
const VUE = "src/pages/Index.vue";
function linkId(source: string, filePath: string, index = 0) {
  const nodes = filePath.endsWith(".vue") ? templateStructureNodes(source, filePath) : jsxStructureNodes(source, filePath);
  const found = nodes.filter(node => node.tag.toLowerCase() === "a")[index];
  assert.ok(found, "Expected a link");
  return found.id;
}
const setTab = (source: string, filePath: string, newTab: boolean, index = 0) =>
  applySourceLinks(source, filePath, [{ nodeId: linkId(source, filePath, index), newTab }]);
const stateOf = (source: string, filePath: string, index = 0) => sourceLinkState(source, filePath).find(entry => entry.nodeId === linkId(source, filePath, index))!;
function refuses(run: () => unknown, match: RegExp) {
  assert.throws(run, (error: unknown) => error instanceof JsxStructureError && match.test(error.message), `Expected a refusal matching ${match}`);
}

const jsxPage = 'const Page = () => (<main><a href="/about">About</a></main>);';
const vuePage = '<template><main><a href="/about">About</a></main></template>';

check("a link starts in the same tab and says so", () => {
  assert.equal(stateOf(jsxPage, JSX).newTab, false);
  assert.equal(stateOf(vuePage, VUE).newTab, false);
  assert.equal(stateOf(jsxPage, JSX).reason, undefined);
});
check("opening in a new tab always brings its rel with it", () => {
  const jsx = setTab(jsxPage, JSX, true);
  assert.ok(jsx.source.includes('<a target="_blank" rel="noopener noreferrer" href="/about">'));
  assert.deepEqual(jsx.summary, ["Set <a> to open in a new tab"]);
  const vue = setTab(vuePage, VUE, true);
  assert.ok(vue.source.includes('<a target="_blank" rel="noopener noreferrer" href="/about">'));
});
check("turning it off removes both attributes rather than emptying them", () => {
  const opened = setTab(jsxPage, JSX, true).source;
  assert.equal(setTab(opened, JSX, false).source, jsxPage);
  const vueOpened = setTab(vuePage, VUE, true).source;
  assert.equal(setTab(vueOpened, VUE, false).source, vuePage);
});
check("a developer's own rel tokens survive both directions", () => {
  const source = 'const Page = () => (<a href="/a" rel="nofollow">A</a>);';
  const opened = setTab(source, JSX, true);
  assert.ok(opened.source.includes('rel="nofollow noopener noreferrer"'));
  const closed = setTab(opened.source, JSX, false);
  assert.ok(closed.source.includes('rel="nofollow"'));
  assert.ok(!closed.source.includes("target"));
});
check("an already-open link reads as open and changing nothing writes nothing", () => {
  const source = 'const Page = () => (<a href="/a" target="_blank" rel="noopener noreferrer">A</a>);';
  assert.equal(stateOf(source, JSX).newTab, true);
  const result = setTab(source, JSX, true);
  assert.equal(result.source, source);
  assert.deepEqual(result.changed, []);
});
check("a target the code decides is never overwritten", () => {
  const jsx = 'const Page = ({ t }: any) => (<a href="/a" target={t}>A</a>);';
  assert.match(stateOf(jsx, JSX).reason!, /comes from code/);
  refuses(() => setTab(jsx, JSX, true), /comes from code/);
  const bound = '<template><a href="/a" :target="t">A</a></template>';
  assert.match(stateOf(bound, VUE).reason!, /bound to code/);
  refuses(() => setTab(bound, VUE, true), /bound to code/);
});
check("spread props make a link's behaviour the code's too", () => {
  assert.match(stateOf('const Page = (props: any) => (<a href="/a" {...props}>A</a>);', JSX).reason!, /spread from code/);
});
check("a link inside a list is refused like everything else in one", () => {
  const source = 'const Page = ({ rows }: any) => (<main>{rows.map((r: any) => (<a key={r} href="/a">A</a>))}</main>);';
  assert.match(stateOf(source, JSX).reason!, /produced by the page's code/);
});
check("only a native link is offered, because a component decides its own props", () => {
  const source = 'const Page = () => (<main><Link href="/about">About</Link><a href="/b">B</a></main>);';
  const links = sourceLinkState(source, JSX);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.label, "<a>");
});
check("two links on one page are told apart", () => {
  const source = 'const Page = () => (<main><a href="/a">A</a><a href="/b">B</a></main>);';
  const result = setTab(source, JSX, true, 1);
  assert.ok(result.source.includes('<a target="_blank" rel="noopener noreferrer" href="/b">'));
  assert.ok(result.source.includes('<a href="/a">A</a>'));
});
check("Markdown says where a link's target belongs instead", () => {
  assert.deepEqual(sourceLinkState("[A](/a)\n", "content/about.md"), []);
  refuses(() => applySourceLinks("[A](/a)\n", "content/about.md", [{ nodeId: "x", newTab: true }]), /written in the link itself/);
});
check("an invented link ID is refused rather than guessed at", () => {
  refuses(() => applySourceLinks(jsxPage, JSX, [{ nodeId: "jsxnode_gone", newTab: true }]), /no longer in this file/);
});

console.log(`websiteSourceLinks: ${passed} focused checks passed`);
