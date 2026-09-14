/** Sections of a Markdown page: what a block is, what moving one does to the
 * bytes around it, and the copy that is refused on purpose.
 * Run: npx tsx checks/websiteMarkdownStructure.ts
 */
import assert from "node:assert/strict";
import { changeMarkdownStructure, markdownStructureNodes, replayMarkdownStructure, JsxStructureError, type JsxStructureNode } from "../src/services/website/index.js";

let passed = 0;
function check(name: string, run: () => void) {
  try { run(); passed++; }
  catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
const PATH = "content/docs/pricing.md";
const nodes = (source: string) => markdownStructureNodes(source, PATH);
function node(source: string, title: string): JsxStructureNode {
  const found = nodes(source).find((candidate) => candidate.label.includes(title));
  assert.ok(found, `Expected a section titled ${title}`);
  return found;
}
const act = (source: string, kind: "remove" | "duplicate" | "before" | "after", nodeId: string, targetId?: string) =>
  changeMarkdownStructure(source, PATH, { kind, nodeId, ...(targetId && { targetId }) });
function refuses(run: () => unknown, match: RegExp) {
  assert.throws(run, (error: unknown) => error instanceof JsxStructureError && match.test(error.message), `Expected a refusal matching ${match}`);
}

const page = [
  "---",
  "title: Pricing",
  "---",
  "",
  "Intro paragraph.",
  "",
  "## Plans",
  "",
  "Words about plans.",
  "",
  "### Starter",
  "",
  "Cheap.",
  "",
  "## Support",
  "",
  "Words about support.",
  "",
].join("\n");

check("sections are the blocks, nested by heading level", () => {
  const listed = nodes(page);
  assert.deepEqual(listed.map((item) => item.label), ["## Plans", "### Starter", "## Support"]);
  assert.equal(node(page, "Starter").parentId, node(page, "Plans").id);
  assert.equal(node(page, "Plans").depth, 1);
  assert.equal(node(page, "Plans").nextId, node(page, "Support").id);
  // A subsection is not a sibling of the section above it.
  assert.equal(node(page, "Starter").previousId, undefined);
});
check("front matter and the text above the first heading are not blocks", () => {
  assert.ok(!nodes(page).some((item) => item.label.includes("Pricing") || item.label.includes("Intro")));
});
check("a section moves with everything under it", () => {
  const moved = act(page, "after", node(page, "Plans").id, node(page, "Support").id);
  assert.equal(moved.summary, "Moved ## Plans");
  assert.ok(moved.source.indexOf("## Support") < moved.source.indexOf("## Plans"));
  // The subsection travelled with its parent rather than being left behind.
  assert.ok(moved.source.indexOf("## Plans") < moved.source.indexOf("### Starter"));
  assert.ok(moved.source.startsWith("---\ntitle: Pricing\n---\n\nIntro paragraph."));
});
check("removing a section takes its subsections too", () => {
  const removed = act(page, "remove", node(page, "Plans").id);
  assert.ok(!removed.source.includes("### Starter") && !removed.source.includes("Cheap."));
  assert.ok(removed.source.includes("## Support"));
  assert.ok(removed.source.includes("Intro paragraph."));
});
check("a heading inside fenced code is not a section", () => {
  const source = ["# Guide", "", "```sh", "# not a heading", "```", "", "## Real", "", "Words.", ""].join("\n");
  assert.deepEqual(nodes(source).map((item) => item.label), ["# Guide", "## Real"]);
  const removed = act(source, "remove", node(source, "Real").id);
  assert.ok(removed.source.includes("# not a heading"));
});
check("copying a section is refused, because its heading is a link target", () => {
  assert.equal(node(page, "Plans").duplicate, false);
  assert.match(node(page, "Plans").duplicateReason!, /link target/);
  refuses(() => act(page, "duplicate", node(page, "Plans").id), /link target/);
});
check("a section cannot move beside one at another level", () => {
  refuses(() => act(page, "before", node(page, "Plans").id, node(page, "Starter").id), /same level/);
});
check("a stale or invented section ID is refused rather than guessed", () => {
  refuses(() => act(page, "remove", "mdnode_missing"), /no longer in this file/);
});
check("a section above an edit keeps its ID, and a moved pair swap theirs", () => {
  // Sections of one level are identified by their order, so a move renames both
  // ends of it. An earlier section is unaffected by a later one being removed.
  const removed = act(page, "remove", node(page, "Support").id).source;
  assert.equal(node(removed, "Plans").id, node(page, "Plans").id);
  const moved = act(page, "after", node(page, "Plans").id, node(page, "Support").id).source;
  assert.equal(node(moved, "Support").id, node(page, "Plans").id);
});
check("a replayed list applies in order, each action naming the state it acts on", () => {
  const result = replayMarkdownStructure(page, PATH, [
    { kind: "remove", nodeId: node(page, "Support").id },
    { kind: "remove", nodeId: node(page, "Starter").id },
  ]);
  assert.deepEqual(result.summary, ["Removed ## Support", "Removed ### Starter"]);
  assert.ok(!result.source.includes("Words about support.") && !result.source.includes("Cheap."));
  assert.ok(result.source.includes("Words about plans."));
});
check("a file with no headings offers nothing rather than failing", () => {
  assert.deepEqual(nodes("Just words.\n"), []);
});
check("a file this adapter does not own is refused", () => {
  assert.throws(() => markdownStructureNodes(page, "src/Page.tsx"), /\.md, \.mdx and \.markdown/);
  assert.throws(() => markdownStructureNodes(page, "../secret.md"), /relative to the connected repository/);
});

console.log(`websiteMarkdownStructure: ${passed} focused checks passed`);
