/** A screen-size override over the real routes: the stylesheet it is written
 * into, the one commit both files travel in, and the refusal when there is no
 * stylesheet to write to. No credentials or network.
 * Run: npx tsx checks/websiteSourceStylesheet.ts
 */
import assert from "node:assert/strict";
import express from "express";
import { type AddressInfo } from "node:net";
import type { Site } from "@prisma/client";
import { registerWebsiteSource } from "../src/services/websiteSource.js";
import { jsxSourceHash, jsxStructureNodes } from "../src/services/website/index.js";
import { WebsiteError } from "../src/services/website/site.js";

let passed = 0;
const filePath = "src/Page.tsx";
const page = [
  "export default function Page() {",
  "  return (",
  "    <main>",
  "      <section><h2>First</h2></section>",
  "    </main>",
  "  );",
  "}",
  "",
].join("\n");
const site = { id: "site-a", repoOwner: "fixture", repoName: "website", repoPath: "web", repoBranch: "preview" } as Site;
const sectionId = jsxStructureNodes(page, filePath).find(node => node.tag === "section")!.id;

/** The fixture repository: the page, and whichever CSS file it is given. */
const files = new Map<string, string>();
let commits: Array<{ files: Array<{ path: string; content: string }>; expected: Array<{ path: string; content: string }> }> = [];
const app = express();
app.use(express.json({ limit: "8mb" }));
const router = express.Router();
registerWebsiteSource(router, { loadSite: async (_req, id) => { if (id !== site.id) throw new WebsiteError(404, "Website unavailable"); return site; } }, {
  read: async (_repo, path) => files.get(path) ?? null,
  list: async () => [],
  commit: async request => {
    commits.push({ files: request.files.map(file => ({ path: file.path, content: file.content })), expected: (request.expectedFiles ?? []).map(file => ({ path: file.path, content: file.content })) });
    for (const file of request.files) files.set(file.path, file.content);
    return { sha: "abc123def456", url: "https://github.com/fixture/website/commit/abc123def456" };
  },
  authorize: async () => undefined,
  audit: async () => undefined,
});
app.use("/website", router);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error instanceof WebsiteError ? error.status : 400).json({ error: error instanceof Error ? error.message : "Unexpected error" });
});
const listener = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => listener.once("listening", resolve));
const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/website/sites/site-a/source`;
const post = (path: string, body: unknown) => fetch(`${origin}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const phone = { filePath, sourceHash: jsxSourceHash(page), devices: [{ nodeId: sectionId, responsive: { mobile: "font-size: 14px" } }] };

try {
  // No stylesheet in the repository: refused, by name, before anything is written.
  files.set("web/src/Page.tsx", page);
  const refused = await post("review", phone);
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /stylesheet this site loads on every page/);
  assert.equal(commits.length, 0); passed++;

  // With one, the review names it and the rules are derived from the page.
  files.set("web/src/app/globals.css", "body { margin: 0; }\n");
  const review = await post("review", phone);
  assert.equal(review.status, 200, JSON.stringify(await review.clone().json()));
  const body = await review.json() as { reviewHash: string; layout: string[]; stylesheet: string | null };
  assert.deepEqual(body.layout, ["Restyled <section> for phone"]);
  assert.equal(body.stylesheet, "src/app/globals.css"); passed++;

  // The page and its stylesheet reach the branch in one commit, both guarded.
  const published = await post("publish", { ...phone, reviewHash: body.reviewHash });
  assert.equal(published.status, 200);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0]!.files.map(file => file.path).sort(), ["web/src/Page.tsx", "web/src/app/globals.css"]);
  assert.deepEqual(commits[0]!.expected.map(file => file.path).sort(), ["web/src/Page.tsx", "web/src/app/globals.css"]); passed++;

  const written = files.get("web/src/Page.tsx")!;
  assert.match(written, /data-dw-style="dw-[a-f0-9]{24}"/);
  assert.ok(written.includes('data-dw-responsive=\'{"mobile":"font-size: 14px"}\''));
  const sheet = files.get("web/src/app/globals.css")!;
  assert.ok(sheet.startsWith("body { margin: 0; }"));
  assert.match(sheet, /dakyworld-editor:start src\/Page\.tsx/);
  assert.match(sheet, /@media \(max-width: 640px\)/);
  assert.match(sheet, /font-size: 14px !important/); passed++;

  // Publishing again from the same review is stale, because the page moved.
  assert.equal((await post("publish", { ...phone, reviewHash: body.reviewHash })).status, 409);
  assert.equal(commits.length, 1); passed++;

  // Clearing the override takes the rules and the annotations away together.
  const cleared = { filePath, sourceHash: jsxSourceHash(written), devices: [{ nodeId: jsxStructureNodes(written, filePath).find(node => node.tag === "section")!.id, responsive: { mobile: "" } }] };
  const clearReview = await (await post("review", cleared)).json() as { reviewHash: string; layout: string[] };
  assert.deepEqual(clearReview.layout, ["Cleared screen-size styling on <section>"]);
  assert.equal((await post("publish", { ...cleared, reviewHash: clearReview.reviewHash })).status, 200);
  assert.equal(files.get("web/src/Page.tsx"), page);
  assert.equal(files.get("web/src/app/globals.css"), "body { margin: 0; }\n"); passed++;

  // A hover value needs the fixed block and no annotation of its own.
  const hovered = { filePath, sourceHash: jsxSourceHash(page), styles: [{ nodeId: sectionId, style: "--dw-hover-color: #0a7" }] };
  const hoverReview = await (await post("review", hovered)).json() as { reviewHash: string; stylesheet: string | null };
  assert.equal(hoverReview.stylesheet, "src/app/globals.css");
  assert.equal((await post("publish", { ...hovered, reviewHash: hoverReview.reviewHash })).status, 200);
  assert.ok(files.get("web/src/Page.tsx")!.includes('"--dw-hover-color": "#0a7"'));
  const hoverSheet = files.get("web/src/app/globals.css")!;
  assert.match(hoverSheet, /:hover\{color:var\(--dw-hover-color\)/);
  assert.ok(!hoverSheet.includes("@media (max-width: 640px)")); passed++;

  // A second page keeps its own region rather than overwriting the first's.
  files.set("web/src/Other.tsx", page);
  // A block's identity includes the file it is in, so the same markup at another
  // path is a different block.
  const otherSection = jsxStructureNodes(page, "src/Other.tsx").find(node => node.tag === "section")!.id;
  const other = { filePath: "src/Other.tsx", sourceHash: jsxSourceHash(page), devices: [{ nodeId: otherSection, responsive: { tablet: "padding: 8px" } }] };
  const otherReview = await (await post("review", other)).json() as { reviewHash: string };
  assert.equal((await post("publish", { ...other, reviewHash: otherReview.reviewHash })).status, 200);
  const shared = files.get("web/src/app/globals.css")!;
  assert.match(shared, /dakyworld-editor:start src\/Other\.tsx/);
  assert.match(shared, /dakyworld-editor:start src\/Page\.tsx/);
  assert.match(shared, /padding: 8px !important/); passed++;

  // A developer editing the stylesheet between review and publish is a conflict,
  // not a silent overwrite of their work.
  const again = { filePath, sourceHash: jsxSourceHash(files.get("web/src/Page.tsx")!), devices: [{ nodeId: jsxStructureNodes(files.get("web/src/Page.tsx")!, filePath).find(node => node.tag === "section")!.id, responsive: { mobile: "font-size: 12px" } }] };
  const againReview = await (await post("review", again)).json() as { reviewHash: string };
  files.set("web/src/app/globals.css", `${files.get("web/src/app/globals.css")!}\n/* a developer's own line */\n`);
  assert.equal((await post("publish", { ...again, reviewHash: againReview.reviewHash })).status, 409); passed++;

  console.log(`websiteSourceStylesheet: ${passed} stylesheet region, commit and refusal checks passed`);
} finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
