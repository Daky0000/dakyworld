/**
 * A framework page shown beside the page itself.
 *
 * The question this answers is the one a customer asked directly: can the
 * `.tsx` not be turned into HTML, edited, and the changes applied back? Not by
 * us building it — that means running their toolchain, and a rendered heading
 * has no reliable way back to the literal it came from once it has been through
 * a loop and a layout. But their site is already built and live, so the HTML
 * exists, and each element that can be matched to a literal *is* editable.
 *
 * So everything here is about the matching, and the matching's failures are the
 * dangerous kind: showing somebody a heading, taking their edit, and changing a
 * different one. The rules are strict on purpose — same tag, identical value,
 * unique on both sides — and these assertions are what holds them there:
 *
 *  - a value that appears twice on the page matches nothing;
 *  - a value that the page does not have matches nothing;
 *  - an unmatched field is still editable, just not clickable on the picture;
 *  - only matched elements are marked in the frame, so nothing can be clicked
 *    that nothing can edit;
 *  - a page that has never been deployed has no picture and says why.
 */
import assert from "node:assert/strict";
import express from "express";
import { type AddressInfo } from "node:net";
import type { Site, SitePage } from "@prisma/client";
import { matchSourceToLive, registerWebsiteFrameworkView } from "../src/services/websiteFrameworkView.js";
import { WebsiteError } from "../src/services/website/site.js";
import { buildSourceManifest } from "../src/services/website/manifest.js";
import { discoverPageFields } from "../src/services/website/pageFields.js";

let passed = 0;
const source = [
  'export default function Pricing() {',
  '  return (',
  '    <main>',
  '      <h1>Plans that fit</h1>',
  '      <p>Every plan includes hosting and a person who answers.</p>',
  '      <a href="/contact">Talk to us</a>',
  '      <p>Repeated</p>',
  '      <p>Repeated</p>',
  '    </main>',
  '  );',
  '}',
].join("\n");
const live = [
  "<!doctype html><html><head><title>Plans</title></head><body>",
  '<div class="wrapper"><h1 class="text-4xl">Plans that fit</h1>',
  '<p class="muted">Every plan includes hosting and a person who answers.</p>',
  '<a class="btn" href="/contact">Talk to us</a>',
  "<p>Repeated</p><p>Repeated</p>",
  '<p>Built by the code, not from a literal.</p></div>',
  "</body></html>",
].join("");

const matched = matchSourceToLive({ source, filePath: "app/pricing/page.tsx", liveHtml: live });
const field = (value: string) => matched.fields.find((entry) => entry.value === value);

// ── What the page can show ──────────────────────────────────────────────────
assert.equal(field("Plans that fit")?.shownOnPage, true); passed++;
assert.equal(field("Every plan includes hosting and a person who answers.")?.shownOnPage, true); passed++;
assert.equal(field("/contact")?.shownOnPage, true); passed++;
// Two identical paragraphs, both from this one file, and the page shows exactly
// two: they are counted off one for one rather than refused, so both are
// offered on the picture as well as in the panel.
assert.equal(matched.fields.filter((entry) => entry.value === "Repeated").every((entry) => entry.shownOnPage === true), true); passed++;
assert.ok(matched.fields.some((entry) => entry.value === "Repeated")); passed++;
// Each source field matches at most one element. An element can legitimately
// appear twice — a link's words and its destination are two fields on the one
// `<a>` — so it is the source side that has to be unique, and it is.
assert.equal(new Set(matched.mapping.map((entry) => entry.sourceFieldId)).size, matched.mapping.length); passed++;
assert.ok(matched.mapping.length >= 3); passed++;

// ── A page that is not deployed ─────────────────────────────────────────────
const offline = matchSourceToLive({ source, filePath: "app/pricing/page.tsx", liveHtml: null });
assert.equal(offline.mapping.length, 0); passed++;
assert.ok(offline.fields.length > 0 && offline.fields.every((entry) => entry.shownOnPage === false)); passed++;

// ── A live page that has drifted from the source ────────────────────────────
// The host has not rebuilt yet, so the page still says the old thing. Nothing
// matches, which is correct: pointing at the old heading and calling it the new
// field is exactly the lie this is built to avoid.
const stale = matchSourceToLive({ source, filePath: "app/pricing/page.tsx", liveHtml: "<html><body><h1>Old heading</h1></body></html>" });
assert.equal(stale.fields.find((entry) => entry.value === "Plans that fit")?.shownOnPage, false); passed++;

// ── The same, for a template file ───────────────────────────────────────────
const vue = matchSourceToLive({
  source: "<template>\n  <section><h2>Our plans</h2></section>\n</template>",
  filePath: "pages/plans.vue",
  liveHtml: "<html><body><section><h2>Our plans</h2></section></body></html>",
});
assert.equal(vue.fields.find((entry) => entry.value === "Our plans")?.shownOnPage, true); passed++;

// ── Over HTTP ───────────────────────────────────────────────────────────────
const site = { id: "site-f", repoOwner: "fixture", repoName: "shop", repoPath: "", repoBranch: "main", publicUrl: "https://shop.example", sourceKind: "next" } as Site;
const page = { id: "page-1", siteId: "site-f", title: "Pricing", path: "/pricing", filePath: "app/pricing/page.tsx" } as SitePage;
const htmlPage = { ...page, id: "page-2", filePath: "index.html", path: "/" } as SitePage;
let liveAvailable = true;
const app = express();
const router = express.Router();
registerWebsiteFrameworkView(router, {
  loadPage: async (_req, id) => {
    if (id === "page-1") return { page, site };
    if (id === "page-2") return { page: htmlPage, site };
    throw new WebsiteError(404, "No such page");
  },
}, {
  file: async (_site, requested) => (requested.filePath === page.filePath ? source : null),
  live: async (url) => {
    assert.equal(url, "https://shop.example/pricing");
    if (!liveAvailable) throw new Error("fetch failed");
    return live;
  },
  authorize: async () => undefined,
  // A `.tsx` page now goes through the manifest branch, so the route needs one.
  // This page imports nothing, which makes it the useful case to pin: the wide
  // answer and the old single-file answer must agree on a page where there is
  // only one file to read. If they ever disagree here, the manifest has changed
  // what a simple page looks like, and that is a regression rather than a
  // feature.
  manifest: async (_site, requested) => {
    const files = [requested.filePath];
    const read = async (path: string) => (path === requested.filePath ? source : null);
    const manifest = await buildSourceManifest({ entry: requested.filePath, files, read });
    return { manifest, discovery: await discoverPageFields({ manifest, read }), read, repoPathFor: (path: string) => path };
  },
});
app.use("/website", router);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error instanceof WebsiteError ? error.status : 500).json({ error: error instanceof Error ? error.message : "Unexpected" });
});
const listener = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => listener.once("listening", resolve));
const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/website`;

try {
  const view = await (await fetch(`${origin}/pages/page-1/framework`)).json() as { fields: Array<{ value: string; shownOnPage: boolean }>; live: { available: boolean }; page: { url: string } };
  assert.equal(view.live.available, true); passed++;
  assert.equal(view.page.url, "https://shop.example/pricing"); passed++;
  assert.ok(view.fields.some((entry) => entry.value === "Plans that fit" && entry.shownOnPage)); passed++;

  const preview = await fetch(`${origin}/pages/page-1/framework/preview`);
  assert.equal(preview.status, 200);
  // The frame is same-origin and framed only by the editor.
  assert.equal(preview.headers.get("x-frame-options"), "SAMEORIGIN"); passed++;
  assert.match(preview.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/); passed++;
  const body = await preview.text();
  // Marked for selection: everything, so a click anywhere is answered. Marked
  // read-only: the paragraph the code built, and the pair that could not be
  // told apart — they outline and explain themselves rather than doing nothing.
  assert.match(body, /<h1[^>]*data-dw-field/); passed++;
  assert.match(body, /data-dw-field="[^"]*"[^>]*data-dw-readonly="true"[^>]*>\s*Built by the code/); passed++;
  // One mark per matched element, not one per matched field: the link's words
  // and its destination are the same element.
  // Every element is marked; the ones no field in this file was matched to
  // carry data-dw-readonly, so they select and outline without accepting words.
  // The picker's own script contains the attribute name as a string, so only
  // real field ids are counted.
  const marks = [...body.matchAll(/data-dw-field="([^"]+)"/g)].map((match) => match[1]!).filter((id) => /^[A-Za-z0-9_.:-]+$/.test(id));
  const mapped = new Set(matched.mapping.map((entry) => entry.htmlFieldId));
  assert.ok(marks.length >= 3); passed++;
  assert.ok(marks.some((id) => !mapped.has(id)), "unmatched elements are still marked, so the whole page answers a click"); passed++;
  for (const id of marks) {
    if (mapped.has(id)) continue;
    assert.match(body, new RegExp('data-dw-field="' + id.replace(/\./g, "\\.") + '"[^>]*data-dw-readonly="true"'));
  }
  passed++;

  // Typing on the page is switched on for the matched elements, which is what
  // makes this the builder rather than a form beside a screenshot. The words
  // come back here and become an edit to the literal they came from.
  assert.match(body, /contenteditable|startEdit/); passed++;
  assert.ok(body.includes('post({ type: "text"')); passed++;
  // And still only where something can receive them: the picker refuses to type
  // into a read-only mark, so the code-built paragraph stays read-only.
  assert.ok(body.includes('if (el.hasAttribute("data-dw-readonly")) return false')); passed++;

  // An HTML page belongs to the visual editor and says so rather than opening
  // an editor that would show its markup as text.
  const wrongEditor = await fetch(`${origin}/pages/page-2/framework`);
  assert.equal(wrongEditor.status, 400); passed++;
  assert.match((await wrongEditor.json() as { error: string }).error, /visual editor/); passed++;

  // Not deployed: the view still answers, with the reason; the preview refuses
  // rather than framing an error page.
  liveAvailable = false;
  const undeployed = await (await fetch(`${origin}/pages/page-1/framework`)).json() as { live: { available: boolean; reason: string | null }; fields: unknown[] };
  assert.equal(undeployed.live.available, false); passed++;
  assert.ok(undeployed.live.reason); passed++;
  assert.ok(undeployed.fields.length > 0); passed++;
  assert.equal((await fetch(`${origin}/pages/page-1/framework/preview`)).status, 409); passed++;

  console.log(`websiteFrameworkView: ${passed} live-page matching and framework editor checks passed`);
} finally {
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
}
