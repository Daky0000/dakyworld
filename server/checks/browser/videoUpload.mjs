import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { register } from "tsx/esm/api";

/**
 * A video an imported page names by a file beside it, end to end through the
 * real path: the server's page reading, structure change, preview document
 * (with its CSP) and publish splice feed the real editor.
 *
 * Written on 15 Oct 2026 after a demo imported as one HTML file asked for
 * `nevermind-venue-tour.mp4` on every load and got a 404 from every address —
 * the editor's preview, the demo link — and nothing anywhere said why, and
 * nothing could upload a video. The panel now says the file is missing, uploads
 * one (`sniffVideo` decides what it is, from its bytes), and a selected player's
 * own controls take clicks on the canvas.
 */
process.env.DATABASE_URL ??= "postgresql://checks:checks@127.0.0.1:1/checks";
register();
const services = new URL("../../src/services/website/", import.meta.url).href;
const { readPage, applyValues } = await import(services + "regions.ts");
const { editingSource, fieldValues } = await import(services + "document.ts");
const { previewDocument } = await import(services + "site.ts");
const { changeStructure, structureControls } = await import(services + "structure.ts");
const { sniffVideo } = await import(new URL("../../src/lib/fileType.ts", import.meta.url).href);
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Venue</title>
<style>body{margin:0;font-family:Georgia,serif}.tour{padding:24px}video{display:block;width:480px;height:270px;background:#000}</style></head>
<body><main><section class="tour"><h2>Take the tour</h2>
<div class="frame"><video controls playsinline preload="auto"><source src="nevermind-venue-tour.mp4" type="video/mp4">Your browser does not support HTML video.</video></div>
</section></main></body></html>`;

const browser = await chromium.launch({ headless: true });
// A real video to upload: Chromium records one.
const recordDir = mkdtempSync(join(tmpdir(), "dw-video-"));
let clip;
{
  const context = await browser.newContext({ recordVideo: { dir: recordDir, size: { width: 320, height: 180 } }, viewport: { width: 320, height: 180 } });
  const recorder = await context.newPage();
  await recorder.setContent('<div style="width:320px;height:180px;background:linear-gradient(90deg,#3157ff,#b8ff3d)"></div>');
  await recorder.waitForTimeout(1200);
  const path = await recorder.video().path();
  await context.close();
  clip = readFileSync(path);
}
assert.equal(sniffVideo(clip), "video/webm", "the recorded clip reads as WebM from its bytes");

let values = {};
let revision = 0;
const media = new Map();
const current = () => editingSource(html, values);
const published = () => applyValues(current(), fieldValues(values)).html;
const doc = () => {
  const source = current();
  const content = readPage(source);
  const controls = structureControls(source);
  return {
    site: { id: "venue", name: "Venue", publicUrl: "https://site.test/demos/venue", repo: null },
    links: [], readFrom: "imported file",
    page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://site.test/demos/venue", lastPublishedAt: null },
    sections: content.sections.map((section) => ({ id: section.id, label: section.label, kind: section.kind, fields: section.fields.map(({ attrInsert, markerSpan, ...field }) => ({ ...field, structure: controls[field.id] })) })),
    draft: { values: Object.fromEntries(Object.entries(fieldValues(values)).map(([id, edit]) => [id, { value: edit.value, style: edit.style, responsive: edit.responsive }])), revision, savedAt: null, savedBy: null },
    problems: [],
  };
};

const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => { try { localStorage.setItem("website-designer:tester", "yes"); } catch { /* optional */ } });
const serveMedia = (route) => {
  const bytes = media.get(new URL(route.request().url()).pathname);
  return bytes ? route.fulfill({ body: bytes, contentType: "video/webm" }) : route.fulfill({ status: 404, body: "" });
};
await page.route("https://site.test/**", serveMedia);
await page.route("https://media.test/**", serveMedia);
await page.route("**/api/**", (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (path.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  if (path.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Staff", external: true, permissions: [], uiState: { tours: { editor: { status: "dismissed", at: "2026-10-07T00:00:00.000Z" } } } } });
  if (path.endsWith("/access")) return route.fulfill({ json: { capabilities: { view: true, edit: true, review: true, publish: true } } });
  if (path.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [] } } });
  if (path.endsWith("/review-links")) return route.fulfill({ json: { links: [] } });
  if (path.endsWith("/tier-status")) return route.fulfill({ status: 404, json: {} });
  if (path.endsWith("/assets") && request.method() === "POST") {
    // The route's own decision, from the bytes: what an R2-backed site answers is an https address.
    const bytes = Buffer.from(request.postDataJSON().data, "base64");
    const type = sniffVideo(bytes);
    if (type !== "video/webm" && type !== "video/mp4") return route.fulfill({ status: 400, json: { error: "Upload an MP4 or WebM video." } });
    const key = `/assets/dw/${randomUUID()}.webm`;
    media.set(key, bytes);
    return route.fulfill({ status: 201, json: { id: "asset-1", url: `https://media.test${key}`, alt: "", size: bytes.length, contentType: type } });
  }
  if (path.endsWith("/assets")) return route.fulfill({ json: [] });
  if (path.endsWith("/structure") && request.method() === "POST") {
    const body = request.postDataJSON();
    const result = changeStructure(html, values, { kind: "settings", fieldId: body.fieldId, settings: body.settings });
    values = result.values;
    revision += 1;
    return route.fulfill({ json: { revision, selectedId: result.selectedId } });
  }
  if (path.includes("/preview")) {
    const applied = published();
    const preview = previewDocument(applied, "https://site.test/demos/venue", readPage(applied).fields, true, null);
    return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": preview.csp }, body: preview.html });
  }
  return route.fulfill({ json: doc() });
});

const frame = () => page.frameLocator('iframe[title="Page"]');
const video = () => frame().locator("video");
const inspector = page.locator("aside").last();
const select = async () => {
  await video().evaluate((el) => parent.postMessage({ source: "dakyworld-preview", type: "select", id: el.getAttribute("data-dw-field") }, location.origin));
  await page.waitForTimeout(250);
  const general = page.getByRole("tab", { name: "General", exact: true });
  if ((await general.getAttribute("aria-selected")) !== "true") await general.click();
};

try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("navigation", { name: "Tools" }).waitFor();
  await video().waitFor();
  await page.waitForTimeout(800);
  await select();
  const warning = inspector.getByRole("status").filter({ hasText: "nevermind-venue-tour.mp4" });
  await warning.waitFor({ timeout: 5000 });
  assert.match(await warning.innerText(), /no “nevermind-venue-tour\.mp4” on the server/, "a video whose file is missing says so, naming the file");

  await inspector.getByLabel("Choose a video to upload").setInputFiles({ name: "nevermind-venue-tour.webm", mimeType: "video/webm", buffer: clip });
  const apply = inspector.getByRole("button", { name: /^Apply \d+ change/ });
  await apply.waitFor({ timeout: 5000 });
  await apply.click();
  await page.waitForTimeout(400);
  await video().waitFor();
  const playable = await video().evaluate((el) => new Promise((resolve) => {
    const done = () => resolve({ ready: el.readyState, error: el.error ? el.error.code : null, src: el.currentSrc });
    if (el.readyState >= 2) return done();
    el.addEventListener("loadeddata", done, { once: true });
    el.addEventListener("error", done, { once: true, capture: true });
    setTimeout(done, 5000);
  }));
  assert.ok(playable.ready >= 2 && playable.error === null && playable.src.startsWith("https://media.test/assets/dw/"), `after the upload the canvas plays the uploaded file: ${JSON.stringify(playable)}`);
  const plays = await video().evaluate(async (el) => { el.muted = true; await el.play(); await new Promise((r) => setTimeout(r, 400)); return { paused: el.paused, time: el.currentTime }; });
  assert.ok(!plays.paused && plays.time > 0, `and it plays: ${JSON.stringify(plays)}`);
  await select();
  assert.equal(await inspector.getByRole("status").filter({ hasText: "can't be loaded" }).count(), 0, "the warning is gone once the file is there");

  // The canvas: the first click selects a player, the next ones reach its controls.
  await page.locator("body").press("Escape");
  await video().evaluate((el) => { window.reached = 0; el.addEventListener("click", () => { window.reached += 1; }); });
  await video().click({ position: { x: 240, y: 100 } });
  const first = await video().evaluate(() => window.reached);
  await video().click({ position: { x: 240, y: 100 } });
  const second = await video().evaluate(() => window.reached);
  assert.equal(first, 0, "the first click on a player selects it rather than pressing it");
  assert.equal(second, 1, "once selected, its own controls get the click");

  // The demo link: the published page under the policy the demo route sends.
  const out = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const body = published();
  await out.route("https://site.test/**", (route) => new URL(route.request().url()).pathname === "/demos/venue"
    ? route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; media-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https: data: blob:" }, body })
    : serveMedia(route));
  await out.route("https://media.test/**", serveMedia);
  await out.goto("https://site.test/demos/venue");
  const live = await out.locator("video").evaluate((el) => new Promise((resolve) => {
    const done = () => resolve({ ready: el.readyState, error: el.error ? el.error.code : null, src: el.currentSrc });
    if (el.readyState >= 2) return done();
    el.addEventListener("loadeddata", done, { once: true });
    setTimeout(done, 5000);
  }));
  await out.close();
  assert.ok(live.ready >= 2 && live.error === null && live.src.startsWith("https://media.test/"), `the published page plays it: ${JSON.stringify(live)}`);
  assert.deepEqual(errors, []);
  console.log("videoUpload: a missing video file is named in the panel, an uploaded file replaces it and plays on the canvas and the published page, and a selected player's controls take clicks.");
} finally {
  await browser.close();
  rmSync(recordDir, { recursive: true, force: true });
}
