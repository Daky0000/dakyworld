/** Layout actions over the real source HTTP routes: what the browser is shown,
 * what a review binds, and what reaches a commit. No credentials or network.
 * Run: npx tsx checks/websiteSourceStructure.ts
 */
import assert from "node:assert/strict";
import express from "express";
import { type AddressInfo } from "node:net";
import type { Site } from "@prisma/client";
import { registerWebsiteSource, reviewWebsiteSource } from "../src/services/websiteSource.js";
import { discoverJsxFields, jsxStructureNodes, jsxSourceHash } from "../src/services/website/index.js";
import { WebsiteError } from "../src/services/website/site.js";

let passed = 0;
const filePath = "src/Page.tsx";
const source = [
  "export default function Page() {",
  "  return (",
  "    <main>",
  '      <section data-dw-field="one"><h2>First</h2></section>',
  '      <section data-dw-field="two"><h2>Second</h2></section>',
  "    </main>",
  "  );",
  "}",
  "",
].join("\n");
const sourceHash = jsxSourceHash(source);
const blocks = jsxStructureNodes(source, filePath);
const block = (tag: string, index = 0) => blocks.filter(node => node.tag === tag)[index]!;
const site = { id: "site-a", repoOwner: "fixture", repoName: "website", repoPath: "web", repoBranch: "preview" } as Site;

const moveLast = { filePath, sourceHash, structure: [{ kind: "after" as const, nodeId: block("section", 0).id, targetId: block("section", 1).id }] };
const reviewed = reviewWebsiteSource(source, moveLast);
assert.deepEqual(reviewed.layout, ["Moved <section>"]);
assert.ok(reviewed.source.indexOf("Second") < reviewed.source.indexOf("First"));
assert.deepEqual(discoverJsxFields(reviewed.source, filePath).issues, []); passed++;

// A layout action and the words changed in the same pass. The field IDs belong
// to the file the browser read, not to the rearranged one: removing a block
// renumbers its neighbour into its ID, so values are written before anything
// moves and an edit can never land on the block that took the other's place.
const combined = { ...moveLast, changes: [{ fieldId: discoverJsxFields(source, filePath).fields.find(field => field.value === "First")!.id, value: "Third" }] };
const both = reviewWebsiteSource(source, combined);
assert.deepEqual(both.layout, ["Moved <section>"]);
assert.equal(both.changes.length, 1);
assert.ok(both.source.includes("Third") && !both.source.includes("First")); passed++;
assert.notEqual(both.reviewHash, reviewed.reviewHash); passed++;
// The same field values with a different layout must not pass an old review.
const other = reviewWebsiteSource(source, { ...combined, structure: [{ kind: "duplicate", nodeId: block("section", 0).id }] });
assert.notEqual(other.reviewHash, both.reviewHash); passed++;
assert.throws(() => reviewWebsiteSource(source, { filePath, sourceHash, structure: [{ kind: "remove", nodeId: block("main").id }] }),
  (error: unknown) => error instanceof WebsiteError && error.status === 409 && /outermost/.test(error.message)); passed++;
assert.throws(() => reviewWebsiteSource(`${source}// moved`, moveLast),
  (error: unknown) => error instanceof WebsiteError && error.status === 409); passed++;

let current = source;
let writes = 0;
/** The file the fixture repository is serving, so a commit is checked against
 * the file actually being published rather than the first one. */
let editing = filePath;
const app = express();
app.use(express.json({ limit: "8mb" }));
const router = express.Router();
registerWebsiteSource(router, { loadSite: async (_req, id) => { if (id !== site.id) throw new WebsiteError(404, "Website unavailable"); return site; } }, {
  read: async () => current,
  list: async () => [{ path: "web/src", type: "dir", size: 0 }],
  commit: async request => {
    writes++;
    assert.deepEqual(request.expectedFiles, [{ path: `web/${editing}`, content: current }]);
    current = request.files[0]!.content;
    return { sha: "abc123def456", url: "https://github.com/fixture/website/commit/abc123def456" };
  },
  authorize: async () => undefined,
  audit: async audit => { assert.equal(audit.filePath, editing); },
});
app.use("/website", router);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error instanceof WebsiteError ? error.status : 400).json({ error: error instanceof Error ? error.message : "Unexpected error" });
});
const listener = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => listener.once("listening", resolve));
const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/website/sites/site-a/source`;
const post = (path: string, body: unknown) => fetch(`${origin}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
try {
  const document = await (await fetch(`${origin}?filePath=${encodeURIComponent(filePath)}`)).json() as { blocks: { id: string; tag: string; remove: boolean; reason?: string; start?: number }[]; structureAdapter: string };
  assert.equal(document.structureAdapter, "jsx-structure-v1");
  assert.deepEqual(document.blocks.map(node => node.tag), ["main", "section", "h2", "section", "h2"]);
  assert.equal(document.blocks.find(node => node.tag === "main")!.remove, false);
  // Offsets are the server's business; the browser never receives or sends them.
  assert.ok(document.blocks.every(node => node.start === undefined)); passed++;

  assert.equal((await post("review", { filePath, sourceHash })).status, 400); passed++;
  const refused = await post("review", { filePath, sourceHash, structure: [{ kind: "remove", nodeId: "jsxnode_missing" }] });
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /no longer in this file/); passed++;
  const rejected = await post("review", { filePath, sourceHash, structure: [{ kind: "remove", nodeId: block("section", 0).id, extra: true }] });
  assert.equal(rejected.status, 400); passed++;

  const prepared = await post("review", moveLast);
  assert.equal(prepared.status, 200);
  const body = await prepared.json() as { reviewHash: string; layout: string[]; changes: unknown[] };
  assert.deepEqual(body.layout, ["Moved <section>"]);
  assert.deepEqual(body.changes, []);
  assert.equal(body.reviewHash, reviewed.reviewHash);
  assert.equal(writes, 0); passed++;

  const download = await post("export", moveLast);
  assert.equal(await download.text(), reviewed.source);
  assert.equal(writes, 0); passed++;

  const swapped = await post("publish", { ...moveLast, structure: [{ kind: "duplicate", nodeId: block("section", 0).id }], reviewHash: body.reviewHash });
  assert.equal(swapped.status, 409);
  assert.equal(writes, 0); passed++;

  const published = await post("publish", { ...moveLast, reviewHash: body.reviewHash });
  assert.equal(published.status, 200);
  assert.equal(writes, 1);
  assert.equal(current, reviewed.source);
  assert.ok(current.indexOf("Second") < current.indexOf("First")); passed++;
  // Replaying the same action against the published file is refused as stale.
  assert.equal((await post("publish", { ...moveLast, reviewHash: body.reviewHash })).status, 409);
  assert.equal(writes, 1); passed++;
  // Every language with a layout engine reaches the same routes. A .vue file is
  // reviewed, bound and committed down the path a .tsx is.
  const vuePath = "src/pages/Index.vue";
  const vueSource = ["<template>", "  <main>", "    <section><h2>First</h2></section>", "    <section><h2>Second</h2></section>", "  </main>", "</template>", ""].join("\n");
  current = vueSource; editing = vuePath;
  const vueDocument = await (await fetch(`${origin}?filePath=${encodeURIComponent(vuePath)}`)).json() as { blocks: { id: string; tag: string }[]; structureAdapter: string };
  assert.equal(vueDocument.structureAdapter, "template-structure-v1");
  assert.deepEqual(vueDocument.blocks.map(item => item.tag), ["main", "section", "h2", "section", "h2"]); passed++;
  const vueSections = vueDocument.blocks.filter(item => item.tag === "section");
  const vueEdit = { filePath: vuePath, sourceHash: jsxSourceHash(vueSource), structure: [{ kind: "after" as const, nodeId: vueSections[0]!.id, targetId: vueSections[1]!.id }] };
  const vueReview = await post("review", vueEdit);
  assert.equal(vueReview.status, 200);
  const vueBody = await vueReview.json() as { reviewHash: string; layout: string[] };
  assert.deepEqual(vueBody.layout, ["Moved <section>"]); passed++;
  const vuePublished = await post("publish", { ...vueEdit, reviewHash: vueBody.reviewHash });
  assert.equal(vuePublished.status, 200);
  assert.ok(current.indexOf("Second") < current.indexOf("First"));
  assert.ok(current.startsWith("<template>")); passed++;
  // Markdown rearranges its sections rather than elements, down the same routes.
  const markdownPath = "content/about.md";
  current = ["# About", "", "Words.", ""].join("\n");
  const markdownDocument = await (await fetch(`${origin}?filePath=${encodeURIComponent(markdownPath)}`)).json() as { blocks: { id: string; label: string; duplicate: boolean }[]; structureAdapter: string | null };
  assert.equal(markdownDocument.structureAdapter, "markdown-sections-v1");
  assert.deepEqual(markdownDocument.blocks.map(item => item.label), ["# About"]);
  assert.equal(markdownDocument.blocks[0]!.duplicate, false); passed++;
  const refusedLayout = await post("review", { filePath: markdownPath, sourceHash: jsxSourceHash(current), structure: [{ kind: "remove", nodeId: "mdnode_gone" }] });
  assert.equal(refusedLayout.status, 409);
  assert.match((await refusedLayout.json() as { error: string }).error, /no longer in this file/); passed++;
  // The browser asks what the file looks like with its queued actions applied,
  // because after one its own list of IDs describes a file that is gone.
  current = source; editing = filePath;
  const writesBeforePreview = writes;
  const untouched = await post("preview", { filePath, sourceHash });
  assert.equal(untouched.status, 200);
  const plain = await untouched.json() as { blocks: { tag: string }[]; fields: { value: string }[]; layout: string[] };
  assert.deepEqual(plain.layout, []);
  assert.deepEqual(plain.blocks.map(item => item.tag), ["main", "section", "h2", "section", "h2"]);
  assert.equal(writes, writesBeforePreview); passed++;

  const secondText = discoverJsxFields(source, filePath).fields.find(field => field.value === "Second")!.id;
  const afterRemove = await post("preview", { filePath, sourceHash, structure: [{ kind: "remove", nodeId: block("section", 0).id }], changes: [{ fieldId: secondText, value: "Kept" }] });
  const previewed = await afterRemove.json() as { blocks: { tag: string }[]; fields: { value: string }[]; layout: string[]; droppedChanges: string[]; sourceHash: string };
  assert.deepEqual(previewed.layout, ["Removed <section>"]);
  // Blocks describe the rearranged file, because that is what the next action
  // acts on; fields describe the file itself, because that is what the values
  // are written against.
  assert.deepEqual(previewed.blocks.map(item => item.tag), ["main", "section", "h2"]);
  assert.deepEqual(previewed.fields.map(item => item.value), ["First", "Second"]);
  assert.deepEqual(previewed.droppedChanges, []);
  // The hash returned is the file's own, so the next action still refers to it.
  assert.equal(previewed.sourceHash, sourceHash); passed++;

  // The defect this ordering exists to prevent: removing the first section
  // renumbers the second into its ID, so an edit prepared for the surviving
  // block must still reach that block and not the one that took its place.
  const keepSecond = await post("review", { filePath, sourceHash, structure: [{ kind: "remove", nodeId: block("section", 0).id }], changes: [{ fieldId: secondText, value: "Kept" }] });
  assert.equal(keepSecond.status, 200);
  const keptReview = await keepSecond.json() as { changes: { before: string; after: string }[]; layout: string[] };
  assert.deepEqual(keptReview.changes.map(change => [change.before, change.after]), [["Second", "Kept"]]);
  assert.deepEqual(keptReview.layout, ["Removed <section>"]); passed++;
  const keptFile = await (await post("export", { filePath, sourceHash, structure: [{ kind: "remove", nodeId: block("section", 0).id }], changes: [{ fieldId: secondText, value: "Kept" }] })).text();
  assert.ok(keptFile.includes("Kept") && !keptFile.includes("First") && !keptFile.includes("Second")); passed++;

  // A field a developer has since taken out of the file is named rather than
  // failing the whole review.
  const orphaned = await post("preview", { filePath, sourceHash, changes: [{ fieldId: "jsx_gone", value: "Gone" }] });
  assert.deepEqual((await orphaned.json() as { droppedChanges: string[] }).droppedChanges, ["jsx_gone"]); passed++;

  assert.equal((await post("preview", { filePath, sourceHash: "0".repeat(64) })).status, 409);
  assert.equal(writes, writesBeforePreview); passed++;
  // Styling rides the same routes, and a block carries its current style in the
  // same row as its layout controls, because the panel needs one row per block.
  current = source; editing = filePath;
  const styled = await (await fetch(`${origin}?filePath=${encodeURIComponent(filePath)}`)).json() as { styleAdapter: string; blocks: { id: string; tag: string; style: string; styleable: boolean; styleReason?: string }[] };
  assert.equal(styled.styleAdapter, "source-inline-style-v1");
  const firstSection = styled.blocks.filter(item => item.tag === "section")[0]!;
  assert.equal(firstSection.style, "");
  assert.equal(firstSection.styleable, true);
  // The outermost block cannot move and can still be restyled.
  const main = styled.blocks.find(item => item.tag === "main")!;
  assert.equal(main.styleable, true); passed++;

  const styleEdit = { filePath, sourceHash, styles: [{ nodeId: firstSection.id, style: "background-color: #eef; padding: 24px" }] };
  const styleReview = await post("review", styleEdit);
  assert.equal(styleReview.status, 200);
  const styleBody = await styleReview.json() as { reviewHash: string; layout: string[]; changes: unknown[] };
  assert.deepEqual(styleBody.layout, ["Restyled <section>"]);
  assert.deepEqual(styleBody.changes, []); passed++;

  const styleFile = await (await post("export", styleEdit)).text();
  assert.ok(styleFile.includes('style={{ backgroundColor: "#eef", padding: "24px" }}'));
  assert.ok(styleFile.includes('data-dw-field="one"')); passed++;

  const stylePublished = await post("publish", { ...styleEdit, reviewHash: styleBody.reviewHash });
  assert.equal(stylePublished.status, 200);
  assert.ok(current.includes('style={{ backgroundColor: "#eef", padding: "24px" }}')); passed++;

  // Words, style and layout in one pass, in the order that keeps every ID true.
  current = source;
  const together = {
    filePath, sourceHash,
    changes: [{ fieldId: discoverJsxFields(source, filePath).fields.find(field => field.value === "First")!.id, value: "Opening" }],
    styles: [{ nodeId: block("section", 0).id, style: "color: #123456" }],
    structure: [{ kind: "after" as const, nodeId: block("section", 0).id, targetId: block("section", 1).id }],
  };
  const combinedFile = await (await post("export", together)).text();
  assert.ok(combinedFile.includes("Opening") && !combinedFile.includes("First"));
  assert.ok(combinedFile.indexOf("Second") < combinedFile.indexOf("Opening"));
  assert.ok(combinedFile.includes('style={{ color: "#123456" }}'));
  // The style landed on the block the words did, not on the one it moved past.
  assert.ok(/style=\{\{ color: "#123456" \}\}[^]*Opening/.test(combinedFile)); passed++;

  // A style the code computes is refused at the route, with the reason intact.
  current = 'const Page = ({ s }: any) => (<main><section style={s}><h2>A</h2></section></main>);';
  const computed = await (await fetch(`${origin}?filePath=${encodeURIComponent(filePath)}`)).json() as { blocks: { tag: string; id: string; styleable: boolean; styleReason?: string }[] };
  const computedSection = computed.blocks.find(item => item.tag === "section")!;
  assert.equal(computedSection.styleable, false);
  assert.match(computedSection.styleReason!, /comes from code/);
  const refusedStyle = await post("review", { filePath, sourceHash: jsxSourceHash(current), styles: [{ nodeId: computedSection.id, style: "color: red" }] });
  assert.equal(refusedStyle.status, 409);
  assert.match((await refusedStyle.json() as { error: string }).error, /comes from code/); passed++;
  console.log(`websiteSourceStructure: ${passed} layout, style, review, binding and publish checks passed`);
} finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
