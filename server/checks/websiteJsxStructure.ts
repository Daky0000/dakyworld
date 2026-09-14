/** Layout editing for JSX source: what may move, what may not, and that every
 * result is still a file the adapter can read. No database, network or build.
 * Run: npx tsx checks/websiteJsxStructure.ts
 */
import assert from "node:assert/strict";
import { changeJsxStructure, discoverJsxFields, jsxStructureNodes, replayJsxStructure, JsxStructureError, type JsxStructureNode } from "../src/services/website/index.js";

let passed = 0;
function check(name: string, run: () => void) {
  try { run(); passed++; }
  catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
const PATH = "src/Page.tsx";
const nodes = (source: string) => jsxStructureNodes(source, PATH);
function node(source: string, tag: string, index = 0): JsxStructureNode {
  const found = nodes(source).filter((candidate) => candidate.tag === tag)[index];
  assert.ok(found, `Expected <${tag}>[${index}] in ${source}`);
  return found;
}
const act = (source: string, kind: "remove" | "duplicate" | "before" | "after", nodeId: string, targetId?: string) =>
  changeJsxStructure(source, PATH, { kind, nodeId, ...(targetId && { targetId }) });
function refuses(run: () => unknown, match: RegExp) {
  assert.throws(run, (error: unknown) => error instanceof JsxStructureError && match.test(error.message), `Expected a refusal matching ${match}`);
}

const page = [
  "const Page = () => (",
  "  <main>",
  '    <section data-dw-field="one"><h2>First</h2></section>',
  '    <section data-dw-field="two"><h2>Second</h2></section>',
  "    <footer>End</footer>",
  "  </main>",
  ");",
].join("\n");

check("every block is listed with its nesting, parent and siblings", () => {
  const listed = nodes(page);
  assert.deepEqual(listed.map((item) => item.tag), ["main", "section", "h2", "section", "h2", "footer"]);
  const first = node(page, "section", 0);
  assert.equal(first.depth, 1);
  assert.equal(first.parentId, node(page, "main").id);
  assert.equal(first.previousId, undefined);
  assert.equal(first.nextId, node(page, "section", 1).id);
  assert.equal(first.marker, "one");
  assert.equal(first.group, node(page, "section", 1).group);
});
check("the outermost returned block is not movable", () => {
  const main = node(page, "main");
  assert.equal(main.remove, false);
  assert.match(main.reason!, /outermost/);
  refuses(() => act(page, "remove", main.id), /outermost/);
});
check("removing a block takes only that block", () => {
  const result = act(page, "remove", node(page, "section", 0).id);
  assert.ok(!result.source.includes("First"));
  assert.ok(result.source.includes("Second"));
  assert.equal(result.summary, "Removed <section>");
  assert.equal(result.selectedId, node(page, "main").id);
  assert.deepEqual(discoverJsxFields(result.source, PATH).issues, []);
});
check("duplicating copies the block, drops its marker and selects the copy", () => {
  const result = act(page, "duplicate", node(page, "section", 0).id);
  assert.equal(result.source.match(/First/g)?.length, 2);
  assert.equal(result.source.match(/data-dw-field="one"/g)?.length, 1);
  assert.equal(result.summary, "Duplicated <section>");
  const after = nodes(result.source);
  assert.equal(after.filter((item) => item.tag === "section").length, 3);
  assert.ok(after.some((item) => item.id === result.selectedId));
  assert.deepEqual(discoverJsxFields(result.source, PATH).issues, []);
});
check("a clone gets its own style key rather than sharing one", () => {
  const source = 'const Page = () => (<main><section data-dw-style="dw-band"><h2>A</h2></section><p>B</p></main>);';
  const result = act(source, "duplicate", node(source, "section").id);
  const keys = [...result.source.matchAll(/data-dw-style="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});
check("a block moves before and after a sibling, keeping its own text", () => {
  const first = node(page, "section", 0);
  const moved = act(page, "after", first.id, node(page, "footer").id);
  assert.ok(moved.source.indexOf("First") > moved.source.indexOf("End"));
  assert.equal(moved.summary, "Moved <section>");
  const back = act(moved.source, "before", node(moved.source, "section", 1).id, node(moved.source, "section", 0).id);
  assert.ok(back.source.indexOf("First") < back.source.indexOf("Second"));
  assert.deepEqual(discoverJsxFields(back.source, PATH).issues, []);
});
check("a move keeps the file parseable and the fields readable", () => {
  const result = act(page, "after", node(page, "section", 0).id, node(page, "section", 1).id);
  const discovery = discoverJsxFields(result.source, PATH);
  assert.deepEqual(discovery.issues, []);
  assert.deepEqual(discovery.fields.map((item) => item.value), ["Second", "First", "End"]);
});
check("a block cannot move beside a block in another container", () => {
  refuses(() => act(page, "before", node(page, "section", 0).id, node(page, "h2", 1).id), /same container/);
});
check("a block inside a map or a branch is refused by name", () => {
  const source = "const Page = ({ items, ready }: any) => (<main>{items.map((item: any) => (<article key={item.id}><h3>{item.title}</h3></article>))}{ready && <aside>Hi</aside>}</main>);";
  const article = node(source, "article");
  assert.equal(article.remove, false);
  assert.match(article.reason!, /produced by the page's code/);
  assert.equal(node(source, "aside").remove, false);
  refuses(() => act(source, "remove", article.id), /produced by the page's code/);
});
check("an element inside a render prop inherits the same refusal", () => {
  const source = "const Page = () => (<main><List render={() => <li>One</li>} /></main>);";
  assert.match(node(source, "li").reason!, /code editor/);
});
check("forms and scripts are not rearranged by the visual editor", () => {
  const source = 'const Page = () => (<main><form action="/x"><label>Email</label><input name="a" /></form><section><h2>A</h2></section></main>);';
  assert.match(node(source, "form").reason!, /controlled by the page source/);
  assert.match(node(source, "input").reason!, /controlled by the page source/);
  assert.match(node(source, "label").reason!, /interactive or source-controlled/);
});
check("a block wrapping interactive code is refused, with the reason said once", () => {
  const source = 'const Page = () => (<main><section><form action="/x" /></section><p>B</p></main>);';
  assert.match(node(source, "section").reason!, /interactive code or forms/);
});
check("fixed IDs block duplication but not removal or moving", () => {
  const source = 'const Page = () => (<main><section id="pricing"><h2>A</h2></section><p>B</p></main>);';
  const section = node(source, "section");
  assert.equal(section.remove, true);
  assert.equal(section.duplicate, false);
  assert.match(section.duplicateReason!, /fixed IDs/);
  refuses(() => act(source, "duplicate", section.id), /fixed IDs/);
  assert.ok(act(source, "remove", section.id).source.includes("B"));
});
check("main is never duplicated even without an ID", () => {
  const source = "const Page = () => (<div><main><h2>A</h2></main><p>B</p></div>);";
  assert.match(node(source, "main").duplicateReason!, /one main region/);
});
check("custom components are first-class blocks, not code", () => {
  const source = 'const Page = () => (<main><Hero data-dw-field="hero" title="A" /><Pricing /></main>);';
  const hero = node(source, "Hero");
  assert.equal(hero.remove, true);
  assert.equal(hero.duplicate, true);
  assert.equal(hero.marker, "hero");
  const moved = act(source, "after", hero.id, node(source, "Pricing").id);
  assert.ok(moved.source.indexOf("Hero") > moved.source.indexOf("Pricing"));
});
check("a fragment is a container like any other", () => {
  const source = "const Page = () => (<><section><h2>A</h2></section><p>B</p></>);";
  assert.equal(node(source, "<>").label, "fragment");
  assert.equal(node(source, "section").remove, true);
});
check("a stale or invented node ID is refused rather than guessed", () => {
  refuses(() => act(page, "remove", "jsxnode_0000"), /no longer in this file/);
  refuses(() => act(page, "after", node(page, "section", 0).id, "jsxnode_0000"), /same container/);
});
check("a replayed action list applies in order and reports each step", () => {
  const result = replayJsxStructure(page, PATH, [
    { kind: "duplicate", nodeId: node(page, "section", 0).id },
    { kind: "remove", nodeId: node(page, "footer").id },
  ]);
  assert.deepEqual(result.summary, ["Duplicated <section>", "Removed <footer>"]);
  assert.equal(result.source.match(/First/g)?.length, 2);
  assert.ok(!result.source.includes("End"));
  assert.deepEqual(discoverJsxFields(result.source, PATH).issues, []);
});
check("an untouched sibling keeps its ID after a neighbour is duplicated", () => {
  const after = changeJsxStructure(page, PATH, { kind: "duplicate", nodeId: node(page, "section", 0).id }).source;
  assert.equal(node(after, "footer").id, node(page, "footer").id);
});
check("a replay that hits a refusal changes nothing at all", () => {
  refuses(() => replayJsxStructure(page, PATH, [
    { kind: "remove", nodeId: node(page, "footer").id },
    { kind: "remove", nodeId: node(page, "main").id },
  ]), /outermost/);
});
check("a syntax error is reported before any layout is offered", () => {
  refuses(() => nodes("const Page = () => (<main><h2>A</h2>);"), /syntax error/);
});
check("a path outside the repository is refused", () => {
  assert.throws(() => jsxStructureNodes(page, "../secrets.tsx"), /relative to the connected repository/);
  assert.throws(() => jsxStructureNodes(page, "notes.md"), /source files/);
});

console.log(`websiteJsxStructure: ${passed} focused checks passed`);
