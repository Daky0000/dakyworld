/** Real HTTP route checks, injected repository bytes. No credentials or network. */
import assert from "node:assert/strict";
import express from "express";
import { type AddressInfo } from "node:net";
import type { Site } from "@prisma/client";
import { registerWebsiteSource, reviewWebsiteSource, websiteSourcePath } from "../src/services/websiteSource.js";
import { discoverJsxFields } from "../src/services/website/index.js";
import { WebsiteError } from "../src/services/website/site.js";

let passed = 0;
const source = '// kept\r\nexport default function Page() { return <main><h1 data-dw-field="hero.title">Hello</h1><a href="/about">About</a></main>; }\r\n';
const filePath = "src/Page.tsx";
const discovery = discoverJsxFields(source, filePath);
const change = { fieldId: discovery.fields.find(field => field.value === "Hello")!.id, value: "Design your website" };
const input = { filePath, sourceHash: discovery.sourceHash, changes: [change] };
const site = { id: "site-a", repoOwner: "fixture", repoName: "website", repoPath: "web", repoBranch: "preview" } as Site;
for (const bad of ["../Page.tsx", "/Page.tsx", "C:/Page.tsx", "src/../Page.tsx", "src//Page.tsx", "node_modules/Page.tsx", "src/Page.tsx?ref=other", "src/Page.tsx#hash", "src/Page.html"]) {
  assert.throws(() => websiteSourcePath("web", bad, true)); passed++;
}
for (const bad of ["../web", "/web", "web/../private", "web//src"]) { assert.throws(() => websiteSourcePath(bad, filePath, true)); passed++; }
assert.deepEqual(websiteSourcePath("web/", "src\\Page.tsx", true), { relative: filePath, repository: `web/${filePath}` }); passed++;
const review = reviewWebsiteSource(source, input);
assert.equal(review.source, source.replace("Hello", change.value));
assert.equal(review.changes.length, 1);
assert.equal(review.changes[0]?.before, "Hello");
assert.notEqual(review.reviewHash, reviewWebsiteSource(source, { ...input, changes: [{ ...change, value: "Different" }] }).reviewHash); passed++;
assert.throws(() => reviewWebsiteSource(source + "// moved", input), (error: unknown) => error instanceof WebsiteError && error.status === 409); passed++;

let current = source;
let sourceAllowed = true;
let publishAllowed = true;
let writeAttempts = 0;
let auditAttempts = 0;
let simulatedRace = false;
let auditFailure = false;
const authorizations: string[] = [];
const reads: { repo: string; path: string; ref?: string }[] = [];
const app = express();
app.use(express.json({ limit: "8mb" }));
const router = express.Router();
registerWebsiteSource(router, { loadSite: async (_req, id) => {
  if (id !== site.id) throw new WebsiteError(404, "Website unavailable");
  return site;
} }, {
  read: async (repo, path, ref) => { reads.push({ repo, path, ref }); return current; },
  list: async (repo, path, ref) => {
    assert.equal(repo, "fixture/website"); assert.equal(path, "web"); assert.equal(ref, "preview");
    return [{ path: "web/src", type: "dir", size: 0 }, { path: "web/README.md", type: "file", size: 50 }, { path: "web/Page.tsx", type: "file", size: 300 }, { path: "web/Huge.tsx", type: "file", size: 2_000_001 }, { path: "web/node_modules", type: "dir", size: 0 }, { path: "private/Secret.tsx", type: "file", size: 10 }, { path: "web/link.tsx", type: "symlink", size: 10 }, { path: "web/../private.tsx", type: "file", size: 10 }];
  },
  authorize: async (_req, id, action) => {
    assert.equal(id, "site-a"); authorizations.push(action);
    if (action === "source" && !sourceAllowed || action === "publish" && !publishAllowed) throw new WebsiteError(403, `Missing ${action} capability`);
  },
  commit: async request => {
    writeAttempts++;
    assert.equal(request.repo, "fixture/website"); assert.equal(request.branch, "preview");
    assert.deepEqual(request.expectedFiles, [{ path: "web/src/Page.tsx", content: current }]);
    assert.deepEqual(request.files, [{ path: "web/src/Page.tsx", content: source.replace("Hello", change.value) }]);
    if (simulatedRace) throw new WebsiteError(409, "The branch moved during publishing");
    current = request.files[0]!.content;
    return { sha: "abc123def456", url: "https://github.com/fixture/website/commit/abc123def456" };
  },
  audit: async audit => { auditAttempts++; assert.equal(audit.filePath, filePath); assert.equal(audit.fields, 1); if (auditFailure) throw new Error("Fixture audit unavailable"); },
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
  const files = await (await fetch(`${origin}/files`)).json() as { files: { path: string; editable: boolean }[] };
  assert.deepEqual(files.files.map(file => file.path), ["src", "Huge.tsx", "Page.tsx"]);
  assert.equal(files.files.find(file => file.path === "Huge.tsx")?.editable, false); passed++;
  const get = await fetch(`${origin}?filePath=${encodeURIComponent(filePath)}`);
  assert.equal(get.status, 200);
  const document = await get.json() as { fields: object[]; sourceHash: string };
  assert.equal(document.sourceHash, discovery.sourceHash);
  assert.ok(document.fields.length > 0);
  assert.ok(document.fields.every(field => !("reference" in field)));
  assert.deepEqual(reads.at(-1), { repo: "fixture/website", path: "web/src/Page.tsx", ref: "preview" }); passed++;
  const prepared = await post("review", input);
  assert.equal(prepared.status, 200);
  const reviewed = await prepared.json() as { reviewHash: string };
  assert.equal(reviewed.reviewHash, review.reviewHash); passed++;
  const download = await post("export", input);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition")!, /^attachment; filename="Page.tsx"$/);
  assert.equal(await download.text(), review.source);
  assert.equal(writeAttempts, 0); passed++;
  const tampered = await post("publish", { ...input, reviewHash: "0".repeat(64) });
  assert.equal(tampered.status, 409); assert.equal(writeAttempts, 0); passed++;
  const altered = await post("publish", { ...input, changes: [{ ...change, value: "Unreviewed" }], reviewHash: reviewed.reviewHash });
  assert.equal(altered.status, 409); assert.equal(writeAttempts, 0); passed++;
  publishAllowed = false;
  const deniedPublish = await post("publish", { ...input, reviewHash: reviewed.reviewHash });
  assert.equal(deniedPublish.status, 403); assert.equal(writeAttempts, 0); passed++;
  publishAllowed = true; sourceAllowed = false;
  for (const path of ["review", "export", "publish"]) {
    assert.equal((await post(path, path === "publish" ? { ...input, reviewHash: reviewed.reviewHash } : input)).status, 403); passed++;
  }
  assert.equal((await fetch(`${origin}?filePath=${filePath}`)).status, 403);
  assert.equal((await fetch(`${origin}/files`)).status, 403);
  assert.equal(writeAttempts, 0); passed++;
  sourceAllowed = true;
  const readCount = reads.length;
  assert.equal((await fetch(`${origin}?filePath=../private.tsx`)).status, 400);
  assert.equal(reads.length, readCount); passed++;
  current = source + "// developer update";
  assert.equal((await post("publish", { ...input, reviewHash: reviewed.reviewHash })).status, 409);
  assert.equal(writeAttempts, 0); passed++;
  current = source; simulatedRace = true;
  assert.equal((await post("publish", { ...input, reviewHash: reviewed.reviewHash })).status, 409);
  assert.equal(current, source); assert.equal(auditAttempts, 0); passed++;
  simulatedRace = false;
  const published = await post("publish", { ...input, reviewHash: reviewed.reviewHash });
  assert.equal(published.status, 200);
  assert.equal((await published.json() as { auditRecorded: boolean }).auditRecorded, true);
  assert.equal(current, review.source); assert.equal(auditAttempts, 1);
  assert.ok(authorizations.includes("source") && authorizations.includes("publish")); passed++;
  assert.equal((await post("publish", { ...input, reviewHash: reviewed.reviewHash })).status, 409); passed++;
  current = source; auditFailure = true;
  const oldError = console.error; console.error = () => undefined;
  try {
    const auditRefused = await post("publish", { ...input, reviewHash: reviewed.reviewHash });
    assert.equal(auditRefused.status, 200); assert.equal((await auditRefused.json() as { auditRecorded: boolean }).auditRecorded, false); passed++;
  } finally { console.error = oldError; }
  console.log(`websiteSource: ${passed} path, review, guarded source publishing and HTTP checks passed`);
} finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
