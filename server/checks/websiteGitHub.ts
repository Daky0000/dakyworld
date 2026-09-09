import assert from "node:assert/strict";
import { commitFiles, readFile } from "../src/lib/github.js";

// Exercise the real GitHub adapter with a fixed wire responder; no credential,
// database setting or request can reach an external service in this check.
process.env.GITHUB_TOKEN = "website-check-stub";
process.env.GITHUB_ALLOWED_REPOS = "fixture/site";
const originalFetch = globalThis.fetch;
let existing: string | null = "old html";
let rejectRef = false;
const requests: { path: string; method: string; body: any }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://api.github.com");
  const path = url.pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ path, method: init?.method ?? "GET", body });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  if (path.endsWith("/git/ref/heads/main")) return json({ object: { sha: "pinned-head" } });
  if (path.includes("/contents/")) {
    assert.equal(url.searchParams.get("ref"), "pinned-head");
    return existing === null ? json({ message: "Not found" }, 404) : json({ content: Buffer.from(existing).toString("base64"), encoding: "base64" });
  }
  if (path.endsWith("/git/commits/pinned-head")) return json({ tree: { sha: "old-tree" } });
  if (path.endsWith("/git/blobs")) return json({ sha: `blob-${requests.length}` });
  if (path.endsWith("/git/trees")) return json({ sha: "new-tree" });
  if (path.endsWith("/git/commits")) return json({ sha: "new-commit", html_url: "https://github.com/fixture/site/commit/new-commit" });
  if (path.endsWith("/git/refs/heads/main")) return rejectRef ? json({ message: "Not a fast forward" }, 422) : json({ object: { sha: "new-commit" } });
  throw new Error(`Unexpected GitHub request ${path}`);
}) as typeof fetch;
const input = { repo: "fixture/site", branch: "main", message: "Reviewed page", files: [{ path: "index.html", content: "new html" }, { path: "assets/photo.png", content: Buffer.from([0, 255, 128, 13, 10]).toString("base64"), encoding: "base64" as const }], expectedFiles: [{ path: "index.html", content: "old html" }] };
try {
  assert.equal((await commitFiles(input)).sha, "new-commit");
  const blobs = requests.filter(request => request.path.endsWith("/git/blobs"));
  assert.equal(Buffer.from(blobs[0].body.content, "base64").toString("utf8"), "new html");
  assert.deepEqual([...Buffer.from(blobs[1].body.content, "base64")], [0, 255, 128, 13, 10]);
  assert.equal(requests.at(-1)?.body.force, false);
  existing = "developer edit"; requests.length = 0;
  await assert.rejects(commitFiles(input), (error: any) => error.status === 409);
  assert.equal(requests.filter(request => request.method !== "GET").length, 0);
  existing = "";
  assert.equal(await readFile("fixture/site", "index.html", "pinned-head"), "");
  await assert.rejects(commitFiles({ ...input, expectedFiles: [{ ...input.expectedFiles[0], allowMissing: true }] }), (error: any) => error.status === 409);
  existing = null;
  await assert.rejects(commitFiles(input), (error: any) => error.status === 409);
  assert.equal((await commitFiles({ ...input, expectedFiles: [{ ...input.expectedFiles[0], allowMissing: true }] })).sha, "new-commit");
  existing = "old html"; rejectRef = true;
  await assert.rejects(commitFiles(input), (error: any) => error.status === 422);
  assert.equal(requests.at(-1)?.body.force, false);
  console.log("websiteGitHub: pinned source conflicts, binary assets, absent versus empty files and non-forced commits passed");
} finally { globalThis.fetch = originalFetch; }
