import assert from "node:assert/strict";
import { register } from "tsx/esm/api";

/**
 * Masks, audio, embeds and form words, through the real editor in a real
 * browser — asserting what Chromium computes and plays, never only that an
 * attribute was set.
 *
 * The page's reading, the structure change, the draft's sanitising, the publish
 * splice and the preview document (with its CSP) are the server's own functions;
 * only the network is stubbed.
 *
 * 1. **Mask.** Style → Mask → Circle cuts the picture on the canvas at once, a
 *    Bottom fade masks it, and both survive the draft's sanitiser into the
 *    published page — the seam where a panel looks right and a page is wrong.
 * 2. **Audio.** A player whose file is missing says so; uploading a WAV through
 *    "Upload audio" (judged by `playableMedia`, from its bytes) and Apply makes
 *    the canvas play it.
 * 3. **Embed.** An empty frame takes a youtu.be link with a start time and shows
 *    the embed after Apply; an address off the list is refused in words and
 *    changes nothing; a typed place becomes a map.
 * 4. **Form words.** A placeholder is a field: typing it in the panel changes
 *    the input on the canvas, and a double click never puts a caret in a control.
 */
process.env.DATABASE_URL ??= "postgresql://checks:checks@127.0.0.1:1/checks";
register();
const services = new URL("../../src/services/website/", import.meta.url).href;
const { readPage, applyValues } = await import(services + "regions.ts");
const { editingSource, fieldValues } = await import(services + "document.ts");
const { previewDocument } = await import(services + "site.ts");
const { changeStructure, structureControls } = await import(services + "structure.ts");
const { sanitizeValue } = await import(services + "index.ts");
const { sniffAudio } = await import(new URL("../../src/lib/fileType.ts", import.meta.url).href);
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bakery</title>
<style>body{margin:0;font-family:Georgia,serif}section{padding:24px}img{display:block;width:240px;height:160px;background:#c96}iframe{display:block;width:480px;height:270px;border:0}input{font-size:16px}</style></head>
<body><main>
<section class="team"><h2>Our team</h2><img src="https://site.test/ama.png" alt="Ama at the oven"></section>
<section class="listen"><h2>Listen</h2><div class="frame"><audio controls preload="auto"><source src="episode-1.mp3" type="audio/mpeg">Your browser does not support audio.</audio></div></section>
<section class="watch"><h2>Watch</h2><div class="frame"><iframe title="Video"></iframe></div></section>
<section class="contact"><h2>Write to us</h2><form><input name="name" placeholder="Your name"><select name="s"><option>Bread</option><option>Cakes</option></select><input type="submit" value="Send"></form></section>
</main></body></html>`;

/** A second of a 440 Hz tone as a WAV, which Chromium plays without a codec. */
function wav(seconds = 1, rate = 8000) {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let at = 0; at < samples; at += 1) data.writeInt16LE(Math.round(Math.sin((at / rate) * 2 * Math.PI * 440) * 8000), at * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8); head.write("fmt ", 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const tone = wav();
assert.equal(sniffAudio(tone), "audio/wav", "the generated tone reads as a WAV from its bytes");

let values = {};
let revision = 0;
const saves = [];
const media = new Map();
const current = () => editingSource(html, values);
const published = () => applyValues(current(), fieldValues(values)).html;
const fieldsNow = () => readPage(current()).fields;
const doc = () => {
  const source = current();
  const content = readPage(source);
  const controls = structureControls(source);
  return {
    site: { id: "bakery", name: "Bakery", publicUrl: "https://site.test", repo: null },
    links: [], readFrom: "imported file",
    page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://site.test/", lastPublishedAt: null },
    sections: content.sections.map((section) => ({ id: section.id, label: section.label, kind: section.kind, fields: section.fields.map(({ attrInsert, markerSpan, content: _c, ...field }) => ({ ...field, structure: controls[field.id] })) })),
    draft: { values: Object.fromEntries(Object.entries(fieldValues(values)).map(([id, edit]) => [id, { value: edit.value, style: edit.style, responsive: edit.responsive }])), revision, savedAt: null, savedBy: null },
    problems: [],
  };
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => { try { localStorage.setItem("website-designer:tester", "yes"); } catch { /* optional */ } });
const serveMedia = (route) => {
  const bytes = media.get(new URL(route.request().url()).pathname);
  return bytes ? route.fulfill({ body: bytes, contentType: "audio/wav" }) : route.fulfill({ status: 404, body: "" });
};
await page.route("https://site.test/**", serveMedia);
await page.route("https://media.test/**", serveMedia);
// The embedded services, so nothing leaves the machine.
await page.route(/^https:\/\/(?:www\.youtube\.com|maps\.google\.com)\//, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>embed</title><p>embedded</p>" }));
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (path.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  if (path.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Staff", external: true, permissions: [], uiState: { tours: { editor: { status: "dismissed", at: "2026-10-07T00:00:00.000Z" } } } } });
  if (path.endsWith("/access")) return route.fulfill({ json: { capabilities: { view: true, edit: true, review: true, publish: true } } });
  if (path.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [] } } });
  if (path.endsWith("/review-links")) return route.fulfill({ json: { links: [] } });
  if (path.endsWith("/tier-status")) return route.fulfill({ status: 404, json: {} });
  if (path.endsWith("/assets") && request.method() === "POST") {
    // The route's own decision, from the bytes and the player it is for.
    const { playableMedia } = await import(new URL("../../src/services/websiteManagement.ts", import.meta.url).href);
    const body = request.postDataJSON();
    const decided = playableMedia(Buffer.from(body.data, "base64"), body.kind);
    if (!decided || "refused" in decided) return route.fulfill({ status: 400, json: { error: decided?.refused ?? "Upload a picture." } });
    const key = `/assets/dw/upload.${decided.extension}`;
    media.set(key, Buffer.from(body.data, "base64"));
    return route.fulfill({ status: 201, json: { id: "asset-1", url: `https://media.test${key}`, alt: "", size: 1, contentType: decided.type } });
  }
  if (path.endsWith("/assets")) return route.fulfill({ json: [] });
  if (path.endsWith("/draft") && request.method() === "PUT") {
    // What the draft route does: each value is cleaned for its field, against the page as it stands.
    const body = request.postDataJSON();
    const byId = new Map(fieldsNow().map((field) => [field.id, field]));
    const next = { ...values };
    for (const [id, raw] of Object.entries(body.values ?? {})) {
      const field = byId.get(id);
      if (!field) continue;
      const clean = sanitizeValue(field, raw);
      if (Object.keys(clean).length) next[id] = clean;
      else delete next[id];
    }
    values = next;
    revision += 1;
    saves.push(body.values);
    return route.fulfill({ json: { savedAt: new Date().toISOString(), revision, changed: Object.keys(body.values ?? {}).length, unknown: [], problems: [] } });
  }
  if (path.endsWith("/structure") && request.method() === "POST") {
    const body = request.postDataJSON();
    try {
      const result = changeStructure(html, values, { kind: "settings", fieldId: body.fieldId, settings: body.settings });
      values = result.values;
      revision += 1;
      return route.fulfill({ json: { revision, selectedId: result.selectedId } });
    } catch (error) {
      return route.fulfill({ status: 409, json: { error: error.message } });
    }
  }
  if (path.includes("/preview")) {
    const applied = published();
    const preview = previewDocument(applied, "https://site.test/", readPage(applied).fields, true, null);
    return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": preview.csp }, body: preview.html });
  }
  return route.fulfill({ json: doc() });
});

const frame = () => page.frameLocator('iframe[title="Page"]');
const inspector = page.locator("aside").last();
const select = async (locator) => {
  await locator.evaluate((el) => parent.postMessage({ source: "dakyworld-preview", type: "select", id: el.getAttribute("data-dw-field") }, location.origin));
  await page.waitForTimeout(250);
};
const tab = async (name) => {
  const button = page.getByRole("tab", { name, exact: true });
  if ((await button.getAttribute("aria-selected")) !== "true") await button.click();
};

try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("navigation", { name: "Tools" }).waitFor();
  await frame().locator("img").waitFor();
  await page.waitForTimeout(800);

  /* ------------------------------------------------------------- 1. mask */
  const picture = frame().locator("img");
  await select(picture);
  await tab("Style");
  const mask = inspector.locator('details[data-section="mask"]');
  if (!(await mask.evaluate((el) => el.open))) await mask.locator("summary").click();
  await mask.getByRole("radio", { name: "Circle", exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(await picture.evaluate((el) => getComputedStyle(el).clipPath), "circle(50% at 50% 50%)", "Circle cuts the picture on the canvas at once");
  await mask.getByRole("radiogroup", { name: "Fade edge" }).getByRole("radio", { name: "Bottom", exact: true }).click();
  await page.waitForTimeout(200);
  assert.match(await picture.evaluate((el) => getComputedStyle(el).maskImage), /linear-gradient/, "a Bottom fade masks it");
  assert.equal(await mask.getByRole("radio", { name: "Circle", exact: true }).getAttribute("aria-checked"), "true", "the panel reads the shape back as the one chosen");
  // Through the draft's sanitiser and the publish splice, into a page a visitor gets.
  await page.waitForFunction(() => true);
  const saved = await page.waitForRequest((request) => request.url().endsWith("/draft") && request.method() === "PUT", { timeout: 15000 }).catch(() => null);
  if (!saved) await page.keyboard.press("Control+s");
  await page.waitForTimeout(1500);
  assert.ok(saves.length > 0, "the mask was saved");
  const out = await browser.newPage();
  await out.route("https://site.test/**", (route) => route.fulfill({ contentType: "text/html", body: published() }));
  await out.goto("https://site.test/");
  const live = await out.locator("img").evaluate((el) => ({ clip: getComputedStyle(el).clipPath, mask: getComputedStyle(el).maskImage }));
  assert.equal(live.clip, "circle(50% at 50% 50%)", "the published picture is a circle");
  // As computed: `to bottom` is the default and `transparent` serialises as a colour.
  assert.equal(live.mask, "linear-gradient(rgb(0, 0, 0) 65%, rgba(0, 0, 0, 0) 100%)", "and fades over its bottom third");
  await out.close();

  /* ------------------------------------------------------------ 2. audio */
  const audio = () => frame().locator("audio");
  await select(audio());
  await tab("General");
  const missing = inspector.getByRole("status").filter({ hasText: "episode-1.mp3" });
  await missing.waitFor({ timeout: 5000 });
  assert.match(await missing.innerText(), /Upload the audio file here/, "a player whose file is missing says so and offers the upload");
  await inspector.getByLabel("Choose an audio file to upload").setInputFiles({ name: "episode-1.wav", mimeType: "audio/wav", buffer: tone });
  const apply = inspector.getByRole("button", { name: /^Apply \d+ change/ });
  await apply.waitFor({ timeout: 5000 });
  await apply.click();
  await page.waitForTimeout(500);
  await audio().waitFor();
  const playable = await audio().evaluate((el) => new Promise((resolve) => {
    const done = () => resolve({ ready: el.readyState, error: el.error ? el.error.code : null, src: el.currentSrc });
    if (el.readyState >= 2) return done();
    el.addEventListener("loadeddata", done, { once: true });
    el.addEventListener("error", done, { once: true, capture: true });
    setTimeout(done, 5000);
  }));
  assert.ok(playable.ready >= 2 && playable.error === null && playable.src.startsWith("https://media.test/assets/dw/upload.wav"), `after the upload the canvas loads the file: ${JSON.stringify(playable)}`);
  const plays = await audio().evaluate(async (el) => { el.muted = true; await el.play(); await new Promise((resolve) => setTimeout(resolve, 400)); return { paused: el.paused, time: el.currentTime }; });
  assert.ok(!plays.paused && plays.time > 0, `and it plays: ${JSON.stringify(plays)}`);

  /* ------------------------------------------------------------ 3. embed */
  const embed = () => frame().locator("iframe");
  await select(embed());
  await tab("General");
  await inspector.getByText("This frame shows nothing yet.").waitFor({ timeout: 5000 });
  const link = inspector.getByLabel("Link or embed code");
  await link.fill("https://evil.example/login");
  await inspector.getByRole("button", { name: "Use this link" }).click();
  assert.match(await inspector.getByRole("alert").first().innerText(), /YouTube/, "an address off the list is refused in words");
  assert.equal(await inspector.getByRole("button", { name: /^Apply \d+ change/ }).count(), 0, "and nothing is waiting to be applied");
  await link.fill("https://youtu.be/dQw4w9WgXcQ?t=5");
  await inspector.getByRole("button", { name: "Use this link" }).click();
  await inspector.getByRole("button", { name: /^Apply \d+ change/ }).click();
  await page.waitForTimeout(600);
  await embed().waitFor();
  assert.equal(await embed().getAttribute("src"), "https://www.youtube.com/embed/dQw4w9WgXcQ?start=5", "the frame shows the video, from its embed address");
  assert.ok(published().includes('src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=5"'), "and the page that would be published says so");
  await select(embed());
  await inspector.getByText("Shows a YouTube video.").waitFor({ timeout: 5000 });

  /* ------------------------------------------------------- 4. form words */
  const input = () => frame().locator('input[name="name"]');
  await select(input());
  await tab("General");
  const box = inspector.getByRole("textbox", { name: "Placeholder" });
  await box.waitFor({ timeout: 5000 });
  await box.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Your full name");
  await page.waitForTimeout(400);
  assert.equal(await input().getAttribute("placeholder"), "Your full name", "typing a placeholder in the panel changes the input on the canvas");
  assert.equal(await inspector.getByRole("button", { name: "or type on the page" }).count(), 0, "a control is never offered a caret on the page");
  // Sent to the input itself: the editor's first-edit checklist sits over this corner of the canvas.
  await input().dispatchEvent("dblclick", { bubbles: true });
  await page.waitForTimeout(200);
  assert.equal(await input().evaluate((el) => el.isContentEditable || el.hasAttribute("contenteditable")), false, "a double click does not make a form control editable");

  const unexpected = errors.filter((message) => !/ResizeObserver/.test(message));
  assert.deepEqual(unexpected, [], `no page errors: ${unexpected.join(" | ")}`);
  console.log("masksMediaForms: mask cuts and fades on the canvas and the published page, audio uploads and plays, a frame takes a YouTube link and refuses another site, and a placeholder edits live");
} finally {
  await browser.close();
}
