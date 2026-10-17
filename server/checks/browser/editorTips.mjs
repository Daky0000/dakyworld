import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

/**
 * The editor's hover tips (`EditorTips.tsx`), hovered for real.
 *
 * The case that started it: a button's styles are classes from the customer's
 * own stylesheet, so the chips read "B", "O", "W". The tip has to say what each
 * one *looks like*, and the only way to know that is to measure it in the
 * preview — so the assertions are on the colours the sample reports, which come
 * from the stylesheet below and nowhere else.
 */
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map((key) => [key, true]));
const structure = { remove: true, duplicate: true };
const document = {
  site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" },
  links: [],
  readFrom: "imported file",
  page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null },
  sections: [{
    id: "hero",
    label: "Hero",
    kind: "section",
    fields: [
      { id: "hero.box", kind: "container", tag: "div", value: "", preview: "Box", label: "Container 1", order: 0, href: "", structure },
      { id: "hero.cta", kind: "button", tag: "a", value: "Get started", preview: "Get started", label: "Button", order: 1, href: "/contact", newTab: false, parentId: "hero.box", structure, variant: "btn-b", variantStem: "btn", variants: ["btn-b", "btn-o", "btn-w"] },
    ],
  }],
  draft: { revision: 0, savedAt: null, savedBy: null, values: {} },
  problems: [],
};

await page.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  if (url.pathname.endsWith("/draft")) return route.fulfill({ json: { revision: 1, problems: [], unknown: [] } });
  if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Client", external: true, permissions: [], uiState: { tours: { editor: { status: "dismissed", at: "2026-10-07T00:00:00.000Z" } } } } });
  if (url.pathname.endsWith("/access")) return route.fulfill({ json: { capabilities } });
  if (url.pathname.endsWith("/assets")) return route.fulfill({ json: [] });
  if (url.pathname.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [], aiEnabled: true } } });
  if (url.pathname.includes("/preview")) {
    return route.fulfill({
      contentType: "text/html",
      body: `<html><head><style>
        .btn{display:inline-block;padding:10px 18px;border-radius:999px;border:2px solid transparent;font-weight:700}
        .btn-b{background:#1a4fff;color:#ffffff}
        .btn-o{background:transparent;color:#1a4fff;border-color:#1a4fff}
        .btn-w{background:#ffffff;color:#0a0f1d}
      </style></head><body style="margin:0;background:#f4f0e8;font-family:Arial;padding:60px">
        <div data-dw-field="hero.box" style="display:block;background:#0a0f1d;padding:30px"><a data-dw-field="hero.cta" class="btn btn-b" href="/contact">Get started</a></div>
      </body></html>`,
    });
  }
  return route.fulfill({ json: document });
});

const frame = () => page.frameLocator('iframe[title="Page"]');
const select = async (id) => frame().locator("body").evaluate((_, fieldId) => parent.postMessage({ source: "dakyworld-preview", type: "select", id: fieldId }, location.origin), id);
const inspector = () => page.getByRole("complementary", { name: "Element inspector" });
const tip = () => page.locator("#dx-editor-tip");
/** Hover, wait for the tip, and hand back its words. */
const hoverTip = async (locator) => {
  await page.mouse.move(0, 0);
  await tip().waitFor({ state: "detached" }).catch(() => {});
  await locator.hover();
  await tip().waitFor();
  return (await tip().innerText()).replace(/\s+/g, " ");
};

try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("navigation", { name: "Tools" }).waitFor();
  await frame().locator("a.btn").waitFor();
  await select("hero.cta");
  await inspector().waitFor();

  /* ------------------------------------------------- button style chips */
  const chips = inspector().getByRole("group", { name: "Button style" });
  await chips.waitFor();
  assert.deepEqual(await chips.getByRole("button").allTextContents(), ["B", "O", "W", "None"], "the chips are the site's own class suffixes");

  const outline = await hoverTip(chips.getByRole("button", { name: "O", exact: true }));
  assert.match(outline, /btn-o/, "the tip names the class");
  assert.match(outline, /Outline, no fill/, "an outline style is described as one");
  assert.match(outline, /2px #1A4FFF border/, "with the border it really has");
  assert.match(outline, /#1A4FFF text/);
  const sample = tip().locator(".dx-tip-sample");
  assert.equal(await sample.innerText(), "Get started", "the sample carries the button's own words");
  assert.equal(await sample.evaluate((element) => getComputedStyle(element).borderTopColor), "rgb(26, 79, 255)");
  assert.equal(await tip().locator(".dx-tip-stage").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(10, 15, 29)", "shown on the colour the button actually sits on");

  assert.match(await hoverTip(chips.getByRole("button", { name: "B", exact: true })), /Filled #1A4FFF · #FFFFFF text/, "B is the filled blue");
  assert.match(await hoverTip(chips.getByRole("button", { name: "W", exact: true })), /Filled #FFFFFF · #0A0F1D text/, "W is the white one");
  assert.match(await hoverTip(chips.getByRole("button", { name: "None", exact: true })), /No style.*base look/);

  // Measuring must leave the page exactly as it was.
  assert.equal(await frame().locator("a").count(), 1, "the measured copy is removed");
  assert.equal(await frame().locator("a").getAttribute("class"), "btn btn-b", "the real button is untouched");

  /* ---------------------------------------------------- the glossary */
  const label = inspector().getByText("Button style", { exact: true });
  assert.match(await hoverTip(label), /designer already made for buttons/, "a label from the glossary explains itself");
  assert.equal(await label.evaluate((element) => getComputedStyle(element).cursor), "help", "and looks like it can be asked");

  // The tip stays on screen.
  const box = await tip().boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 1000, "the tip is inside the window");

  /* ------------------------------------ an option inside a labelled group */
  await select("hero.box");
  await inspector().getByRole("tab", { name: "Style" }).click();
  const display = inspector().getByRole("radiogroup", { name: "Display" });
  await display.waitFor();
  assert.match(await hoverTip(display.getByRole("radio", { name: "In-blk" })), /Inline block: sits in a line with text/, "an abbreviated option is spelled out");
  assert.equal(await display.getByRole("radio", { name: "In-blk" }).getAttribute("title"), null, "the browser's own title no longer doubles it");

  /* --------------------------------------------------- dismissing it */
  await page.keyboard.press("Escape");
  await tip().waitFor({ state: "detached" });

  await mkdir("tmp", { recursive: true });
  await page.mouse.move(0, 0);
  await chips.count();
  await select("hero.cta");
  await inspector().getByRole("tab", { name: "General" }).click();
  await hoverTip(inspector().getByRole("group", { name: "Button style" }).getByRole("button", { name: "O", exact: true }));
  // Nothing in the editor may cover it: the inspector once did.
  const covered = await tip().evaluate((element) => {
    // elementFromPoint skips pointer-events:none, which the tip is.
    element.style.pointerEvents = "auto";
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    element.style.pointerEvents = "";
    return Boolean(top && !element.contains(top));
  });
  assert.equal(covered, false, "the tip is drawn above the inspector");
  await page.waitForTimeout(200);
  await page.screenshot({ path: "tmp/editor-tips.png" });

  assert.deepEqual(errors, [], "no page errors");
  console.log("editor tips: ok");
} finally {
  await browser.close();
}
