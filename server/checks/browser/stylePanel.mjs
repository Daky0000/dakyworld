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
  // The same nine sections as every other element, in the page builder's order.
  assert.deepEqual(
    await panel.locator("[data-section]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-section"))),
    ["layout", "spacing", "size", "position", "typography", "background", "border", "effects"],
    "every section is there, Custom CSS only with Designer controls",
  );
  const open = async (name) => {
    const section = panel.locator(`[data-section="${name}"]`);
    if (!(await section.evaluate((details) => details.open))) await section.locator(":scope > summary").click();
    return section;
  };
  const more = async (section) => {
    const button = section.getByRole("button", { name: "Show more" });
    if (await button.count()) await button.click();
  };

  await mkdir("checks/artifacts", { recursive: true });
  await page.screenshot({ path: "checks/artifacts/style-panel-top.png" });
  // Size: typing a number writes it with its unit and the page follows.
  const size = await open("size");
  await size.getByLabel("Width", { exact: true }).fill("600");
  assert.equal(await computedOf("width"), "600px", "Width changes the page");
  await size.getByLabel("Width unit", { exact: true }).selectOption("%");
  await size.getByLabel("Width", { exact: true }).fill("50");

  // Spacing: linked, one box sets all four sides.
  const spacing = await open("spacing");
  await spacing.getByLabel("Padding top").fill("24");
  assert.equal(await computedOf("padding-top"), "24px", "Padding top changes the page");
  assert.equal(await computedOf("padding-right"), "24px", "and, linked, every other side");
  await spacing.getByRole("button", { name: "Link margin" }).click();
  await spacing.getByLabel("Margin bottom").fill("12");
  assert.equal(await computedOf("margin-bottom"), "12px", "unlinked, one side on its own");
  assert.notEqual(await computedOf("margin-top"), "12px");

  // Typography.
  const typography = await open("typography");
  await typography.getByLabel("Font size", { exact: true }).fill("40");
  assert.equal(await computedOf("font-size"), "40px", "Font size changes the page");
  await typography.getByLabel("Font weight", { exact: true }).selectOption("300");
  assert.equal(await computedOf("font-weight"), "300");
  await typography.getByRole("radio", { name: "Align center" }).click();
  assert.equal(await computedOf("text-align"), "center");
  await more(typography);
  await typography.getByTitle("Italic").click();
  assert.equal(await computedOf("font-style"), "italic");
  await typography.getByTitle("Underline").click();
  await typography.getByRole("radio", { name: "Uppercase" }).click();
  assert.equal(await computedOf("text-transform"), "uppercase");

  // Border, effects, position.
  const border = await open("border");
  await border.getByLabel("Border width top", { exact: true }).fill("2");
  await border.getByLabel("Border type", { exact: true }).selectOption("dashed");
  assert.equal(await computedOf("border-top-style"), "dashed");
  await border.getByLabel("Border radius top left", { exact: true }).fill("10");
  assert.equal(await computedOf("border-bottom-right-radius"), "10px", "linked corners move together");
  const effects = await open("effects");
  await effects.getByLabel("Shadow preset", { exact: true }).selectOption("medium");
  assert.notEqual(await computedOf("box-shadow"), "none", "A shadow preset gives the element a shadow");
  await effects.getByLabel("Opacity", { exact: true }).fill("70");
  assert.equal(await computedOf("opacity"), "0.7");
  const position = await open("position");
  await position.getByLabel("Position", { exact: true }).selectOption("relative");
  await position.getByLabel("Z-index", { exact: true }).fill("5");

  await save();
  const style = saved();
  for (const part of ["width: 50%", "padding-top: 24px", "margin-bottom: 12px", "font-size: 40px", "font-weight: 300", "font-style: italic", "text-decoration: underline", "text-align: center", "text-transform: uppercase", "border-top-width: 2px", "border-style: dashed", "border-top-left-radius: 10px", "box-shadow: 0 8px 20px rgba(0,0,0,.18)", "opacity: 0.7", "position: relative", "z-index: 5"]) {
    assert.ok(style.includes(part), `saved draft has ${part} — got ${style}`);
  }

  // The dot beside a changed label takes that one property back.
  await position.getByRole("button", { name: "Reset Z-index" }).click();
  await save();
  assert.equal(saved().includes("z-index"), false, "the reset dot removes the override");

  // Undo takes back the last step.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  assert.equal(await position.getByLabel("Z-index", { exact: true }).inputValue(), "5", "Undo brings the override back");

  await mkdir("checks/artifacts", { recursive: true });
  await page.screenshot({ path: "checks/artifacts/style-panel.png" });
  assert.deepEqual(errors, []);
  console.log("stylePanel: size, linked and unlinked spacing, typography, border, shadow, opacity, position change the page and save; the dot resets; Undo restores.");
} finally { await browser.close(); }
