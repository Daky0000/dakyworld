import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const origin = "http://127.0.0.1:5199";
const liveOrigin = "https://builder-images.invalid";
const canonical = "/assets/dw/uploaded-image.png";
const previewPath = "/api/website/sites/demo/assets/uploaded-image/content";
const previewUrl = `${origin}${previewPath}`;
const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map(key => [key, true]));
const originalStyle = "height: 140px; background-image: url('/images/original.svg'); background-size: cover";
const document = {
  site: { id: "demo", name: "Image fixture", publicUrl: liveOrigin, repo: "demo/site" },
  links: [], readFrom: "imported file",
  page: { id: "one", title: "Home", path: "/nested/", filePath: "nested/index.html", status: "LIVE", url: `${liveOrigin}/nested/`, lastPublishedAt: null },
  sections: [{ id: "hero", label: "Hero", kind: "section", fields: [
    { id: "hero.image", kind: "image", tag: "img", value: "/images/original.svg", alt: "Original image", preview: "Hero image", label: "Hero image", order: 0 },
    { id: "hero.background", kind: "container", tag: "div", value: "", preview: "Hero background", label: "Hero background", style: originalStyle, order: 1 },
  ] }],
  draft: { revision: 0, savedAt: null, savedBy: null, values: {} }, problems: [],
};
let uploaded = null;
let uploadBytes = null;
const savedValues = [];
let releaseFirstSave;
const firstSave = new Promise(resolve => { releaseFirstSave = resolve; });
let saveReleased = false;
const assets = () => uploaded ? [{ ...uploaded, filename: "replacement.png", preview: previewPath }] : [];
const htmlEscape = value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

// The published origin does not contain unpublished uploads. Returning a real
// 404 makes a canonical URL written directly into the iframe fail visibly.
await page.route(`${liveOrigin}/**`, route => {
  if (new URL(route.request().url()).pathname === "/images/original.svg") {
    return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#3157ff"/></svg>' });
  }
  return route.fulfill({ status: 404, contentType: "text/plain", body: "This image has not been published." });
});
await page.route("**/api/**", async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "image-tester", name: "Client", external: true, permissions: [] } });
  if (url.pathname.endsWith("/access")) return route.fulfill({ json: { capabilities } });
  if (url.pathname.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [], aiEnabled: false } } });
  if (url.pathname.endsWith("/tier-status")) return route.fulfill({ status: 404, json: { error: "No tier fixture" } });
  if (url.pathname === previewPath) return route.fulfill({ contentType: "image/png", body: uploadBytes });
  if (url.pathname.endsWith("/assets")) {
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      assert.equal(body.filename, "replacement.png");
      uploadBytes = Buffer.from(body.data, "base64");
      assert.ok(uploadBytes.length > 0, "The actual upload must contain image bytes");
      uploaded = { id: "uploaded-image", url: canonical, alt: body.alt };
      return route.fulfill({ json: uploaded });
    }
    return route.fulfill({ json: assets() });
  }
  if (url.pathname.endsWith("/draft")) {
    const payload = request.postDataJSON();
    savedValues.push(payload.values);
    if (!saveReleased) await firstSave;
    document.draft = { ...document.draft, values: payload.values, revision: document.draft.revision + 1, savedAt: new Date().toISOString() };
    return route.fulfill({ json: { revision: document.draft.revision, problems: [], unknown: [] } });
  }
  if (url.pathname.endsWith("/preview")) {
    // Match the server renderer: the saved document already maps uploaded
    // assets to authenticated preview URLs, while retaining the live <base>.
    const source = document.draft.values["hero.image"]?.value ?? "/images/original.svg";
    const src = source === canonical ? previewUrl : source;
    const style = (document.draft.values["hero.background"]?.style ?? originalStyle).replaceAll(canonical, previewUrl);
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><base href="${liveOrigin}/nested/"></head><body style="margin:0;padding:30px"><img data-dw-field="hero.image" alt="Hero image" src="${htmlEscape(src)}" style="width:240px;height:120px"><div data-dw-field="hero.background" style="${htmlEscape(style)}">Background</div><script>addEventListener("load", () => parent.postMessage({source:"dakyworld-preview",type:"ready"}, location.origin));</script></body></html>` });
  }
  return route.fulfill({ json: document });
});

const frameImage = () => page.frameLocator('iframe[title="Page"]').locator('[data-dw-field="hero.image"]');
async function assertImageLoaded(label) {
  await frameImage().waitFor();
  await page.waitForFunction(expected => {
    const img = document.querySelector('iframe[title="Page"]')?.contentDocument?.querySelector('[data-dw-field="hero.image"]');
    return img?.src === expected && img.complete && img.naturalWidth > 0;
  }, previewUrl, { timeout: 10_000 });
  assert.equal(await frameImage().evaluate(img => img.naturalWidth), 8, label);
}
async function selectLayer(name) {
  const layer = page.getByRole("treeitem", { name: new RegExp(name) });
  if (!await layer.isVisible()) await page.getByRole("button", { name: "Layers", exact: true }).click();
  await layer.click();
}
async function assertBackgroundLoaded() {
  const background = page.frameLocator('iframe[title="Page"]').locator('[data-dw-field="hero.background"]');
  await background.waitFor();
  const source = await background.evaluate(element => getComputedStyle(element).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1]);
  assert.equal(source, previewUrl, "Background CSS must retain the editor origin despite the live base URL");
  assert.equal(await background.evaluate(async (element, source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    return image.naturalWidth;
  }, source), 8, "The background URL must decode to real image bytes");
}

try {
  await page.goto(`${origin}/builder-harness.html?editor`);
  await page.getByRole("button", { name: "Close guide" }).click();
  await selectLayer("Hero image");
  await page.getByRole("button", { name: /^Media Library \(/ }).click();
  const library = page.getByRole("dialog", { name: "Media Library", exact: true });
  await library.getByRole("button", { name: /^Site Library & Upload/ }).click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 8; canvas.height = 6;
    const context = canvas.getContext("2d");
    context.fillStyle = "#0d9d80";
    context.fillRect(0, 0, 8, 6);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await library.locator('input[type="file"]').setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await library.getByLabel("Image description", { exact: true }).fill("Uploaded replacement");
  await library.getByRole("button", { name: "Upload & preview", exact: true }).click();
  await library.getByRole("button", { name: "Insert Media", exact: true }).click();
  await assertImageLoaded("A newly uploaded image must display before the draft save completes");
  assert.equal(document.draft.revision, 0, "Immediate preview cannot depend on saving or reloading");
  const inspectorImage = page.getByRole("complementary", { name: "Element inspector" }).getByRole("img", { name: "Uploaded replacement", exact: true });
  assert.ok(await inspectorImage.evaluate(img => img.complete && img.naturalWidth > 0), "The selected image thumbnail must display too");
  saveReleased = true;
  releaseFirstSave();
  await page.getByText(/Draft saved.*1 unpublished change/, { exact: false }).waitFor();
  assert.equal(document.draft.values["hero.image"].value, canonical);
  await assertImageLoaded("Autosave must leave the replacement visible");

  async function switchMode(name) {
    const summary = page.locator("summary[title='Switch editor view mode']");
    const details = summary.locator("xpath=..");
    if (!await details.evaluate(el => el.open)) {
      await summary.click();
    }
    await page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).click();
  }

  await switchMode("Preview");
  await assertImageLoaded("Preview mode must display the saved upload");
  await switchMode("Visual");
  await assertImageLoaded("Visual mode must replay the canonical draft through the preview resolver");
  // The real bridge sends this after iframe reloads. Force stale source data
  // so this checks the replay branch rather than only the server fixture.
  await frameImage().evaluate(img => {
    img.src = "/images/original.svg";
    parent.postMessage({ source: "dakyworld-preview", type: "ready" }, location.origin);
  });
  await assertImageLoaded("A ready message must replay the uploaded image without breaking its URL");

  await selectLayer("Hero background");
  await page.getByRole("button", { name: "Choose / Upload Image", exact: true }).click();
  await library.getByRole("button", { name: /^Site Library & Upload/ }).click();
  await library.getByTitle("Use replacement.png", { exact: true }).click();
  await assertBackgroundLoaded();
  await page.getByText(/Draft saved.*2 unpublished changes/, { exact: false }).waitFor();
  assert.match(document.draft.values["hero.background"].style, /url\('\/assets\/dw\/uploaded-image\.png'\)/);
  assert.ok(savedValues.every(values => !JSON.stringify(values).includes("/api/website/")), "Authenticated preview endpoints must never leak into saved drafts");

  await page.reload();
  await page.getByRole("tab", { name: "Content", exact: true }).waitFor();
  await assertImageLoaded("Reopening a saved draft must keep its image visible");
  await assertBackgroundLoaded();
  await selectLayer("Hero image");
  await page.getByRole("button", { name: /^Media Library \(/ }).click();
  await library.getByRole("button", { name: /^Site Library & Upload/ }).click();
  await library.getByTitle("Use replacement.png", { exact: true }).click();
  await assertImageLoaded("Selecting an existing uploaded asset must display immediately");
  assert.deepEqual(errors, []);
  console.log("builderImages: upload, immediate image and thumbnail, autosave, mode switch, ready replay, background, canonical draft URLs and reopening passed.");
} finally {
  releaseFirstSave();
  await browser.close();
}
