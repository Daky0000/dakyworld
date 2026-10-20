/**
 * Phase 4 of the publish router plan: is GitHub Pages through an Actions
 * workflow (Route P) meaningfully faster than the classic build with .nojekyll?
 *
 *   GITHUB_TOKEN=<token with contents, pages, workflows write on the test repo> \
 *   node scripts/pagesTiming.mjs --repo owner/africon-app-timing --runs 5
 *
 * Run it against a COPY of a customer's site, never the real one: it commits
 * fifteen times and switches the repository's Pages source back and forth. For
 * each of three set-ups it commits a page change carrying a unique marker and
 * times from the commit to the marker being visible on the Pages address:
 *
 *   1. classic branch build, no .nojekyll;
 *   2. classic branch build, with .nojekyll;
 *   3. the DakyX workflow (services/publishRoutes/pagesActions.ts).
 *
 * Build Route P only if (3) beats (2) by ten seconds or more on the median
 * (docs/publish-router.md). It restores the classic build at the end.
 */
import { setTimeout as wait } from "node:timers/promises";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const repo = flag("repo", "");
const runs = Number(flag("runs", "5"));
const branch = flag("branch", "main");
const pagePath = flag("page", "index.html");
const token = process.env.GITHUB_TOKEN;
if (!repo || !token) {
  console.error("Usage: GITHUB_TOKEN=… node scripts/pagesTiming.mjs --repo owner/name [--runs 5] [--branch main] [--page index.html]");
  process.exit(2);
}

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
};

async function readFile(path) {
  const file = await api(`/contents/${path}?ref=${branch}`).catch(() => null);
  return file ? { sha: file.sha, text: Buffer.from(file.content, "base64").toString("utf8") } : null;
}
async function writeFile(path, text, message) {
  const current = await readFile(path);
  await api(`/contents/${path}`, { method: "PUT", body: JSON.stringify({ message, branch, content: Buffer.from(text).toString("base64"), ...(current ? { sha: current.sha } : {}) }) });
}
async function removeFile(path, message) {
  const current = await readFile(path);
  if (current) await api(`/contents/${path}`, { method: "DELETE", body: JSON.stringify({ message, branch, sha: current.sha }) });
}

const WORKFLOW = `name: DakyX Pages
on:
  push:
    branches: [${JSON.stringify(branch)}]
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: dakyx-pages, cancel-in-progress: true }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "\${{ steps.deployment.outputs.page_url }}" }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with: { path: "." }
      - id: deployment
        uses: actions/deploy-pages@v4
`;

async function setup(mode) {
  if (mode === "workflow") {
    await api("/pages", { method: "PUT", body: JSON.stringify({ build_type: "workflow" }) });
    await writeFile(".github/workflows/dakyx-pages.yml", WORKFLOW, "timing: workflow");
  } else {
    await api("/pages", { method: "PUT", body: JSON.stringify({ build_type: "legacy", source: { branch, path: "/" } }) });
    await removeFile(".github/workflows/dakyx-pages.yml", "timing: classic build");
    if (mode === "nojekyll") await writeFile(".nojekyll", "", "timing: .nojekyll");
    else await removeFile(".nojekyll", "timing: no .nojekyll");
  }
  await wait(90_000); // Let the set-up commit's own build finish first.
}

async function timeOne(pagesUrl) {
  const marker = `dakyx-timing-${Date.now().toString(36)}`;
  const page = await readFile(pagePath);
  if (!page) throw new Error(`${pagePath} is not in ${repo}`);
  const next = page.text.replace(/<!-- dakyx-timing-[a-z0-9]+ -->/g, "").replace(/<\/body>/i, `<!-- ${marker} --></body>`);
  const started = Date.now();
  await writeFile(pagePath, next, `timing ${marker}`);
  const url = `${pagesUrl.replace(/\/$/, "")}/${pagePath === "index.html" ? "" : pagePath}`;
  while (Date.now() - started < 20 * 60_000) {
    const body = await fetch(`${url}?t=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } }).then((response) => response.text()).catch(() => "");
    if (body.includes(marker)) return Math.round((Date.now() - started) / 1000);
    await wait(2_000);
  }
  return null;
}

const median = (values) => {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const pages = await api("/pages");
const results = {};
try {
  for (const mode of ["classic", "nojekyll", "workflow"]) {
    console.log(`\n${mode}: setting up…`);
    await setup(mode);
    results[mode] = [];
    for (let run = 1; run <= runs; run++) {
      const seconds = await timeOne(pages.html_url);
      results[mode].push(seconds);
      console.log(`  run ${run}: ${seconds === null ? "did not appear within 20 minutes" : `${seconds} s`}`);
      await wait(15_000);
    }
  }
} finally {
  console.log("\nRestoring the classic build…");
  await setup("nojekyll").catch((error) => console.error(`Could not restore: ${error.message}`));
}

console.log("\nMedian seconds from commit to visible:");
for (const [mode, values] of Object.entries(results)) console.log(`  ${mode.padEnd(9)} ${median(values) ?? "—"}  (${values.join(", ")})`);
const gain = median(results.nojekyll ?? []) !== null && median(results.workflow ?? []) !== null ? median(results.nojekyll) - median(results.workflow) : null;
console.log(gain === null ? "\nNot enough results to decide." : gain >= 10 ? `\nThe workflow is ${gain} s faster on the median: build Route P.` : `\nThe workflow is only ${gain} s faster on the median: keep .nojekyll and drop Route P.`);
