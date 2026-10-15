import assert from "node:assert/strict";
import { register } from "tsx/esm/api";

/**
 * What typography on an element reaches inside it, through the real path:
 * the server's own page reading, draft cleaning, preview document (with its
 * CSP) and publish splice feed the real editor, and the published page is
 * measured at 1280, 820 and 390 pixels.
 *
 * Written on 15 Oct 2026 after three fixes for "font size does nothing on
 * tablet and phone" shipped green against a hand-written preview while the
 * real one did other things: a paragraph's weight un-bolded its bold words, its
 * colour recoloured its links, a section's size flattened its heading, and a
 * Desktop size never reached a word with a size class of its own. The rule is
 * in `shared/websiteResponsive.ts` (TEXT_METRICS).
 */
process.env.DATABASE_URL ??= "postgresql://checks:checks@127.0.0.1:1/checks";
register();
const services = new URL("../../src/services/website/", import.meta.url).href;
const { readPage, applyValues } = await import(services + "regions.ts");
const { editingSource, fieldValues } = await import(services + "document.ts");
const { previewDocument } = await import(services + "site.ts");
const { sanitizeValue } = await import(services + "index.ts");
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Reach</title><style>
body{margin:0;font-family:Georgia,serif;color:#222}
.hero{padding:40px;background:#f4f0e8}
.hero h1{font-size:56px;margin:0 0 16px}
.hero h1 .accent{font-size:60px;color:#3157ff}
.lead{font-size:20px;color:#555}
.lead a{color:#0a7d32;text-decoration:underline}
@media (max-width:1024px){.hero h1{font-size:44px}.lead{font-size:18px}}
@media (max-width:640px){.hero h1{font-size:32px}.lead{font-size:16px}}
</style></head><body><main><section class="hero" data-dw-field="hero">
<h1 data-dw-field="heading">Build <span class="accent">faster</span> today</h1>
<p class="lead" data-dw-field="lead">A lead with <strong>bold words</strong> and <a href="/more">a link</a> inside it.</p>
</section></main></body></html>`;

let values = {};
let revision = 0;
const current = () => editingSource(html, values);
const published = () => applyValues(current(), fieldValues(values)).html;
const doc = () => {
  const content = readPage(current());
  return {
    site: { id: "reach", name: "Reach", publicUrl: "https://site.test", repo: "reach/site" },
    links: [], readFrom: "imported file",
    page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://site.test/", lastPublishedAt: null },
    sections: content.sections.map((section) => ({ id: section.id, label: section.label, kind: section.kind, fields: section.fields.map(({ attrInsert, markerSpan, ...field }) => field) })),
    draft: { values: Object.fromEntries(Object.entries(fieldValues(values)).map(([id, edit]) => [id, { value: edit.value, style: edit.style, responsive: edit.responsive }])), revision, savedAt: null, savedBy: null },
    problems: [],
  };
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("https://site.test/**", (route) => route.fulfill({ status: 404, body: "" }));
await page.route("**/api/**", (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  if (path.endsWith("/draft") && route.request().method() === "PUT") {
    const byId = new Map(readPage(current()).fields.map((field) => [field.id, field]));
    const next = {};
    for (const [id, edit] of Object.entries(route.request().postDataJSON()?.values ?? {})) {
      const field = byId.get(id);
      const clean = field ? sanitizeValue(field, edit) : {};
      if (Object.keys(clean).length) next[id] = clean;
    }
    values = next;
    revision += 1;
    return route.fulfill({ json: { revision, problems: [], unknown: [] } });
  }
  if (path.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Client", external: true, permissions: [], uiState: { tours: { editor: { status: "dismissed", at: "2026-10-07T00:00:00.000Z" } } } } });
  if (path.endsWith("/access")) return route.fulfill({ json: { capabilities: { view: true, edit: true, review: true, publish: true } } });
  if (path.endsWith("/assets")) return route.fulfill({ json: [] });
  if (path.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [] } } });
  if (path.endsWith("/review-links")) return route.fulfill({ json: { links: [] } });
  if (path.endsWith("/tier-status")) return route.fulfill({ status: 404, json: {} });
  if (path.includes("/preview")) {
    const applied = published();
    const preview = previewDocument(applied, "https://site.test/", readPage(applied).fields, true, null);
    return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": preview.csp }, body: preview.html });
  }
  return route.fulfill({ json: doc() });
});

const frame = () => page.frameLocator('iframe[title="Page"]');
const DEVICE = { desktop: "Desktop", tablet: "Tablet", mobile: "Phone" };
const WIDTH = { desktop: 1280, tablet: 820, mobile: 390 };
const device = async (name) => { await page.getByRole("button", { name: DEVICE[name], exact: true }).first().click(); await page.waitForTimeout(400); };
const select = async (id) => { await frame().locator(`[data-dw-field="${id}"]`).evaluate((el, fieldId) => parent.postMessage({ source: "dakyworld-preview", type: "select", id: fieldId }, location.origin), id); await page.waitForTimeout(150); };
const typography = async () => {
  const styleTab = page.getByRole("tab", { name: "Style", exact: true });
  if ((await styleTab.getAttribute("aria-selected")) !== "true") await styleTab.click();
  const section = page.locator('.dx-style [data-section="typography"]');
  if (!(await section.evaluate((details) => details.open))) await section.locator(":scope > summary").click();
  return section;
};
const set = async (id, label, value, kind = "text") => {
  await select(id);
  const section = await typography();
  if (kind === "select") return section.getByRole("combobox", { name: label, exact: true }).selectOption(value);
  const box = section.getByRole("textbox", { name: label, exact: true });
  await box.fill(value);
  await box.press("Tab");
  await page.waitForTimeout(200);
};
// What the words look like, read the same way in the editor and on the published page.
const look = (root) => root.locator('[data-dw-field="hero"]').evaluate((hero) => {
  const css = (selector, property) => getComputedStyle(hero.querySelector(selector)).getPropertyValue(property);
  return {
    heading: css("h1", "font-size"), accent: css(".accent", "font-size"), accentColour: css(".accent", "color"),
    lead: css(".lead", "font-size"), leadWeight: Number(css(".lead", "font-weight")), strongWeight: Number(css(".lead strong", "font-weight")),
    link: css(".lead a", "color"), linkLine: css(".lead a", "text-decoration-line"),
  };
});
const publishedAt = async (name) => {
  const out = await browser.newPage({ viewport: { width: WIDTH[name], height: 900 } });
  const body = published();
  await out.route("https://site.test/**", (route) => new URL(route.request().url()).pathname === "/" ? route.fulfill({ contentType: "text/html", body }) : route.fulfill({ status: 404, body: "" }));
  await out.goto("https://site.test/");
  const seen = await look(out);
  await out.close();
  return seen;
};

const want = {
  desktop: { heading: "40px", lead: "20px" },
  tablet: { heading: "30px", lead: "14px" },
  mobile: { heading: "20px", lead: "13px" },
};
const verify = (where, name, seen) => {
  assert.equal(seen.heading, want[name].heading, `${where} ${name}: the heading takes its size`);
  assert.equal(seen.accent, want[name].heading, `${where} ${name}: a word with a size class of its own takes the heading's size too`);
  assert.equal(seen.accentColour, "rgb(49, 87, 255)", `${where} ${name}: the accent word keeps its own colour`);
  assert.ok(seen.strongWeight > seen.leadWeight, `${where} ${name}: bold words stay bolder than their paragraph (${seen.strongWeight} vs ${seen.leadWeight})`);
  assert.equal(seen.link, "rgb(10, 125, 50)", `${where} ${name}: the link keeps its colour`);
  assert.equal(seen.linkLine, "underline", `${where} ${name}: the link keeps its underline`);
  assert.ok(Number.parseFloat(seen.heading) > Number.parseFloat(seen.lead), `${where} ${name}: a section's size leaves its heading bigger than its paragraph`);
};

try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("navigation", { name: "Tools" }).waitFor();
  await frame().locator('[data-dw-field="heading"]').waitFor();
  for (const [name, heading, leadSize, weight, colour, sectionSize] of [
    ["desktop", "40", null, "300", "#990099", null],
    ["tablet", "30", "14", "200", "#009999", "13"],
    ["mobile", "20", "13", "100", "#999900", "12"],
  ]) {
    await device(name);
    await set("heading", "Font size", heading);
    await set("heading", "Text color", "#CC0000");
    await set("lead", "Font weight", weight, "select");
    await set("lead", "Text color", colour);
    if (leadSize) await set("lead", "Font size", leadSize);
    if (sectionSize) await set("hero", "Font size", sectionSize);
    verify("canvas", name, await look(frame()));
  }
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(1200);
  await page.reload();
  await page.getByRole("navigation", { name: "Tools" }).waitFor();
  await frame().locator('[data-dw-field="heading"]').waitFor();
  for (const name of ["desktop", "tablet", "mobile"]) {
    await device(name);
    verify("after reload", name, await look(frame()));
  }
  for (const name of ["desktop", "tablet", "mobile"]) verify("published", name, await publishedAt(name));
  assert.deepEqual(errors, []);
  console.log("typographyReach: a heading's size reaches every word inside it on Desktop, Tablet and Phone; bold words, links and an accent colour keep their own; a section's size leaves its heading bigger — on the canvas, after a reload and on the published page.");
} finally {
  await browser.close();
}
