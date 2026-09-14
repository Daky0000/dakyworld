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

// A layout action and the words changed in the same pass: the field IDs belong
// to the page as the actions left it, which is what the browser was shown.
const afterMove = discoverJsxFields(reviewed.source, filePath);
const combined = { ...moveLast, changes: [{ fieldId: afterMove.fields.find(field => field.value === "First")!.id, value: "Third" }] };
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
const app = express();
app.use(express.json({ limit: "8mb" }));
const router = express.Router();
registerWebsiteSource(router, { loadSite: async (_req, id) => { if (id !== site.id) throw new WebsiteError(404, "Website unavailable"); return site; } }, {
  read: async () => current,
  list: async () => [{ path: "web/src", type: "dir", size: 0 }],
  commit: async request => {
    writes++;
    assert.deepEqual(request.expectedFiles, [{ path: "web/src/Page.tsx", content: current }]);
    current = request.files[0]!.content;
    return { sha: "abc123def456", url: "https://github.com/fixture/website/commit/abc123def456" };
  },
  authorize: async () => undefined,
  audit: async audit => { assert.equal(audit.filePath, filePath); },
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
  console.log(`websiteSourceStructure: ${passed} layout review, binding and publish checks passed`);
} finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
