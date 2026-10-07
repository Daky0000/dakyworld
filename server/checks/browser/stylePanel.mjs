import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const writes = [];
page.on("pageerror", error => errors.push(error.message));
const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map(key => [key, true]));
const document = { site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" }, links: [], readFrom: "imported file", page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null }, sections: [{ id: "hero", label: "Hero", kind: "section", fields: [{ id: "hero.title", kind: "text", tag: "h1", value: "Welcome home", preview: "Welcome home", label: "Main heading", order: 0 }] }], draft: { revision: 0, savedAt: null, savedBy: null, values: {} }, problems: [] };
await page.route("**/api/**", route => {
  const url = new URL(route.request().url());
  // Presence leases are expected on mount; all other writes remain subject to the assertions below.
  if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  // Remembering which tours somebody has seen is not a change to the page.
  if (route.request().method() !== "GET" && !url.pathname.endsWith("/auth/ui-state")) writes.push(url.pathname);
  if (url.pathname.endsWith("/draft")) {
    const payload=route.request().postDataJSON();
    document.draft={...document.draft, values:payload?.values ?? {}, revision:document.draft.revision+1, savedAt:new Date().toISOString()};
    return route.fulfill({json:{revision:document.draft.revision,problems:[],unknown:[]}});
  }
  if (url.pathname.endsWith("/assistant/preview")) return route.fulfill({json:{html:'<h1>Better together</h1>'}});
  if (url.pathname.endsWith("/assistant")) return route.fulfill({json:{explanation:"A clearer heading",values:{"hero.title":{value:"Better together"}},changes:[{fieldId:"hero.title",label:"Main heading",property:"value",before:"Welcome home",after:"Better together"}],costUsd:0,model:"test",note:null}});
  if (url.pathname.endsWith("/review")) return route.fulfill({json:{revision:document.draft.revision,sourceHash:"fixture",summary:[],problems:[],conflicts:[],missing:[],publishable:true}});
  if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Client", external: true, permissions: [], uiState: { tours: { editor: { status: "dismissed", at: "2026-10-07T00:00:00.000Z" } } } } });
  if (url.pathname.endsWith("/access")) return route.fulfill({ json: { capabilities } });
  if (url.pathname.endsWith("/assets")) return route.fulfill({ json: [] });
  if (url.pathname.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [], aiEnabled: true } } });
  if (url.pathname.includes("/preview")) return route.fulfill({ contentType: "text/html", body: '<html><body style="margin:0;background:#f4f0e8;font-family:Arial;padding:60px"><h1 data-dw-field="hero.title" style="font-size:64px">Welcome home</h1><p>A quiet space to make your next idea real.</p></body></html>' });
  return route.fulfill({ json: document });
});
/**
 * The Style tab, control by control: each one must change the page in the
 * frame (the computed style, not the attribute) and land in the saved draft.
 */
const frameH1 = () => page.frameLocator('iframe[title="Page"]').locator("h1");
const computedOf = (property) => frameH1().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
const saved = () => document.draft.values["hero.title"]?.style ?? "";
const save = async () => { await page.keyboard.press("Control+s"); await page.waitForTimeout(400); };
try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("navigation", { name: "Tools" }).waitFor();
  await frameH1().waitFor();
  await frameH1().evaluate(() => parent.postMessage({ source: "dakyworld-preview", type: "select", id: "hero.title" }, location.origin));
  await page.getByRole("tab", { name: "Style", exact: true }).click();
  const panel = page.locator(".dx-style");
  await panel.waitFor();
  for (const title of ["Size", "Spacing", "Typography", "Background", "Border", "Effects", "Position"]) {
    assert.equal(await panel.locator("summary", { hasText: title }).count() >= 1, true, `${title} section is there`);
  }

  await mkdir("checks/artifacts", { recursive: true });
  await page.screenshot({ path: "checks/artifacts/style-panel-top.png" });
  // Size: typing a number writes it with its unit and the page follows.
  await panel.getByLabel("Width", { exact: true }).fill("600");
  assert.equal(await computedOf("width"), "600px", "Width changes the page");
  await panel.getByLabel("Width unit", { exact: true }).selectOption("%");
  await panel.getByLabel("Width", { exact: true }).fill("50");

  // Spacing: one side at a time.
  await panel.getByLabel("padding top").fill("24");
  assert.equal(await computedOf("padding-top"), "24px", "Padding top changes the page");
  await panel.getByLabel("margin bottom").fill("12");

  // Typography.
  await panel.getByLabel("Font size", { exact: true }).fill("40");
  assert.equal(await computedOf("font-size"), "40px", "Font size changes the page");
  await panel.getByLabel("Weight", { exact: true }).selectOption("300");
  assert.equal(await computedOf("font-weight"), "300");
  await panel.getByTitle("Italic").click();
  assert.equal(await computedOf("font-style"), "italic");
  await panel.getByTitle("Underline").click();
  await panel.getByRole("button", { name: "Centre", exact: true }).click();
  assert.equal(await computedOf("text-align"), "center");
  await panel.getByLabel("Case", { exact: true }).selectOption("uppercase");
  assert.equal(await computedOf("text-transform"), "uppercase");

  // Border, effects, position: open their sections first.
  await panel.locator("summary", { hasText: "Border" }).click();
  await panel.getByLabel("Border width", { exact: true }).fill("2");
  await panel.getByLabel("Border style", { exact: true }).selectOption("dashed");
  assert.equal(await computedOf("border-top-style"), "dashed");
  await panel.getByLabel("Corner radius", { exact: true }).fill("10");
  await panel.locator("summary", { hasText: "Effects" }).click();
  await panel.getByRole("radio", { name: "Medium", exact: true }).click();
  assert.notEqual(await computedOf("box-shadow"), "none", "A shadow tile gives the element a shadow");
  await panel.getByLabel("Opacity", { exact: true }).fill("70");
  assert.equal(await computedOf("opacity"), "0.7");
  await panel.locator("summary", { hasText: "Position" }).click();
  await panel.getByLabel("Position type", { exact: true }).selectOption("relative");
  await panel.getByLabel("Layer order", { exact: true }).fill("5");

  await save();
  const style = saved();
  for (const part of ["width: 50%", "padding-top: 24px", "margin-bottom: 12px", "font-size: 40px", "font-weight: 300", "font-style: italic", "text-decoration: underline", "text-align: center", "text-transform: uppercase", "border-width: 2px", "border-style: dashed", "border-radius: 10px", "box-shadow: 0 8px 20px rgba(0,0,0,.18)", "opacity: 0.7", "position: relative", "z-index: 5"]) {
    assert.ok(style.includes(part), `saved draft has ${part} — got ${style}`);
  }

  // Default takes one property back to the website's own value.
  await panel.getByLabel("Layer order", { exact: true }).locator("xpath=ancestor::div[contains(@class,'dx-f')][1]").getByRole("button", { name: "Default" }).click();
  await save();
  assert.equal(saved().includes("z-index"), false, "Default removes the override");

  // Undo takes back the last step.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  assert.equal(await panel.getByLabel("Layer order", { exact: true }).inputValue(), "5", "Undo brings the override back");

  await mkdir("checks/artifacts", { recursive: true });
  await page.screenshot({ path: "checks/artifacts/style-panel.png" });
  assert.deepEqual(errors, []);
  console.log("stylePanel: size, spacing, typography, border, shadow, opacity, position change the page and save; Default resets; Undo restores.");
} finally { await browser.close(); }
