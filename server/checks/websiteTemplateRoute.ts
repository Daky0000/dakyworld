/**
 * A `.vue` file down the same HTTP path a `.tsx` goes down.
 *
 * `checks/websiteTemplate.ts` proves the adapter reads and writes the file.
 * This proves the thing that actually ships: that adding a framework changed
 * nothing about the contract around it. Same browse, same review, same
 * review-hash guard, same expected-file guard on the commit, same audit row —
 * only the parser behind them is different, and the route never asks which.
 *
 * Real HTTP, injected repository bytes, no credentials and no network.
 */
import assert from "node:assert/strict";
import express from "express";
import { type AddressInfo } from "node:net";
import type { Site } from "@prisma/client";
import { registerWebsiteSource, websiteSourcePath } from "../src/services/websiteSource.js";
import { discoverTemplateFields } from "../src/services/website/index.js";
import { WebsiteError } from "../src/services/website/site.js";

let passed = 0;
const filePath = "pages/index.vue";
const source = [
  "<template>",
  '  <section><h1>Welcome</h1><a href="/contact">Contact us</a></section>',
  "</template>",
  "",
  "<script setup>",
  'const internal = "untouched";',
  "</script>",
  "",
].join("\r\n");
const discovery = discoverTemplateFields(source, filePath);
assert.equal(discovery.adapter, "template-literal-v1"); passed++;
const change = { fieldId: discovery.fields.find((field) => field.value === "Welcome")!.id, value: "Welcome to Dakyworld" };
const input = { filePath, sourceHash: discovery.sourceHash, changes: [change] };
const expected = source.replace("<h1>Welcome</h1>", "<h1>Welcome to Dakyworld</h1>");

// Every framework extension is accepted by the path guard, and everything else
// is refused exactly as before.
for (const good of ["pages/index.vue", "src/pages/index.astro", "src/routes/+page.svelte", "src/Page.tsx", "src/Page.jsx", "content/pricing.md", "docs/guide.mdx", "src/data/site.ts"]) {
  assert.equal(websiteSourcePath("", good, true).relative, good); passed++;
}
// `.html` belongs to the visual editor, and the rest belong to nobody here.
for (const bad of ["pages/index.html", "pages/index.css", "pages/index.vue.bak", "pages/logo.png"]) {
  assert.throws(() => websiteSourcePath("", bad, true)); passed++;
}

const site = { id: "site-v", repoOwner: "fixture", repoName: "storefront", repoPath: "", repoBranch: "main" } as Site;
let current = source;
let writes = 0;
let audited = 0;
const app = express();
app.use(express.json({ limit: "8mb" }));
const router = express.Router();
registerWebsiteSource(router, { loadSite: async (_req, id) => {
  if (id !== site.id) throw new WebsiteError(404, "Website unavailable");
  return site;
} }, {
  read: async () => current,
  list: async () => [
    { path: "pages", type: "dir", size: 0 },
    { path: "pages/index.vue", type: "file", size: 200 },
    { path: "nuxt.config.ts", type: "file", size: 80 },
  ],
  authorize: async () => undefined,
  commit: async (request) => {
    writes += 1;
    assert.deepEqual(request.expectedFiles, [{ path: filePath, content: current }]);
    assert.deepEqual(request.files, [{ path: filePath, content: expected }]);
    current = request.files[0]!.content;
    return { sha: "vue123vue456", url: "https://github.com/fixture/storefront/commit/vue123vue456" };
  },
  audit: async (record) => { audited += 1; assert.equal(record.filePath, filePath); assert.equal(record.fields, 1); },
});
app.use("/website", router);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error instanceof WebsiteError ? error.status : 400).json({ error: error instanceof Error ? error.message : "Unexpected error" });
});
const listener = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => listener.once("listening", resolve));
const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/website/sites/site-v/source`;
const post = (path: string, body: unknown) => fetch(`${origin}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

try {
  // Every file an adapter owns is browsable, and since content files live in
  // `.ts` now, `nuxt.config.ts` is in the list too. That is not a hazard: a file
  // with no content-named strings in it simply offers no fields, which is a
  // sentence the editor says rather than a door that is locked.
  const files = await (await fetch(`${origin}/files`)).json() as { files: { path: string; editable: boolean }[] };
  assert.deepEqual(files.files.map((file) => file.path), ["pages", "pages/index.vue", "nuxt.config.ts"]); passed++;

  const document = await (await fetch(`${origin}?filePath=${encodeURIComponent(filePath)}`)).json() as { adapter: string; fields: { value: string }[]; sourceHash: string };
  assert.equal(document.adapter, "template-literal-v1");
  assert.equal(document.sourceHash, discovery.sourceHash);
  assert.ok(document.fields.some((field) => field.value === "Welcome")); passed++;
  // The script block's string is not a field, at the route as well as in the
  // adapter — nothing between here and the browser re-widens what is offered.
  assert.ok(!document.fields.some((field) => field.value === "untouched")); passed++;

  const reviewed = await post("review", input);
  assert.equal(reviewed.status, 200);
  const review = await reviewed.json() as { reviewHash: string; changes: { before: string; after: string }[] };
  assert.deepEqual(review.changes, [{ fieldId: change.fieldId, label: "h1 text", kind: "text", before: "Welcome", after: "Welcome to Dakyworld" }].map((entry) => ({ ...entry })));
  assert.equal(writes, 0); passed++;

  // A publish whose values differ from the reviewed ones is refused, and the
  // refusal is the same 409 the JSX path gives.
  assert.equal((await post("publish", { ...input, changes: [{ ...change, value: "Never reviewed" }], reviewHash: review.reviewHash })).status, 409);
  assert.equal(writes, 0); passed++;

  const published = await post("publish", { ...input, reviewHash: review.reviewHash });
  assert.equal(published.status, 200);
  assert.equal((await published.json() as { auditRecorded: boolean }).auditRecorded, true);
  assert.equal(current, expected);
  assert.equal(audited, 1); passed++;
  // The script block came through the commit untouched, which is the whole
  // promise made to the developer whose project this is.
  assert.ok(current.includes('const internal = "untouched";')); passed++;

  // The same edit again is stale, because the file it was prepared against is
  // gone — the commit that just landed replaced it.
  assert.equal((await post("publish", { ...input, reviewHash: review.reviewHash })).status, 409);
  assert.equal(writes, 1); passed++;

  console.log(`websiteTemplateRoute: ${passed} framework source HTTP checks passed`);
} finally {
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
}
