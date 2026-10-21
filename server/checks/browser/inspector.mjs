/**
 * What the Style tab actually draws, asked of a real browser.
 *
 * A compile proves nothing about which controls a selected element gets, and a
 * unit test over the model proves the rules and not the wiring. This renders
 * the component in `inspector-harness.html` and reads the panel back.
 *
 * Since 11 Oct 2026 the tab is the same for every element — Elementor's model,
 * at Dan's request — so what this holds is: every element has every section;
 * the few controls that depend on the element appear exactly when they should;
 * a value shows where it comes from; and looking writes nothing.
 *
 *   npm --prefix client exec vite -- --port 5199 --strictPort --host 127.0.0.1
 *   node checks/browser/inspector.mjs
 */
async function playwright() {
  const candidates = [process.env.PLAYWRIGHT_URL, "playwright"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch {
      /* try the next one */
    }
  }
  console.error("inspectorBrowser: skipped — no Playwright available. Install it, or set PLAYWRIGHT_URL to an installed copy's index.mjs.");
  process.exit(2);
}

const { chromium } = await playwright();

const url = process.argv[2] ?? "http://127.0.0.1:5199/inspector-harness.html";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 2400 } });
const problems = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let checks = 0;
const check = (name, condition) => {
  checks += 1;
  if (!condition) problems.push(name);
};

await page.goto(url, { waitUntil: "networkidle" });

const select = async (name) => {
  await page.evaluate((next) => window.__harness.select(next), name);
  await page.waitForFunction((next) => document.querySelector('[data-testid="case"]').textContent === next, name);
};
const sections = () => page.$$eval("[data-section]", (nodes) => nodes.map((node) => node.getAttribute("data-section")));
const open = async (name) => {
  const section = page.locator(`[data-section="${name}"]`);
  if (!(await section.evaluate((details) => details.open))) await section.locator(":scope > summary").click();
  // A section draws its controls once it is open; count() does not wait for that.
  await section.locator(":scope > .dx-accb > *").first().waitFor();
  return section;
};
const showMore = async (name) => {
  const button = page.locator(`[data-section="${name}"]`).getByRole("button", { name: "Show more" });
  if (await button.count()) await button.click();
};
const named = (label) => page.getByLabel(label, { exact: true });
const groups = () => page.$$eval('[role="radiogroup"]', (nodes) => nodes.map((node) => node.getAttribute("aria-label")));
const writes = () => page.evaluate(() => window.__harness.writes.length);
const lastWrite = () => page.evaluate(() => window.__harness.writes.at(-1) ?? "");
const EVERY = ["layout", "spacing", "size", "position", "typography", "background", "border", "effects", "mask", "custom"];

/* ------------------------------------------------- the same for everyone */

for (const name of ["heading", "image", "flexRow", "gridWrap", "flexChild", "gridChild", "overlay", "tablet", "layered"]) {
  await select(name);
  check(`${name} has every section, in order`, JSON.stringify(await sections()) === JSON.stringify(EVERY));
}

/* ---------------------------------------------------------- a heading */

await select("heading");
check("a heading opens on Typography", await page.locator('[data-section="typography"]').evaluate((details) => details.open));
check("font size shows the website's 72 as its placeholder", (await named("Font size").getAttribute("placeholder")) === "72");
check("and holds no value of its own", (await named("Font size").inputValue()) === "");
check("weight names the website's own", (await page.locator("#dx-font-weight-s option").first().textContent()) === "Default (700 Bold)");
await open("size");
check("max width shows the site's 780", (await named("Max width").getAttribute("placeholder")) === "780");
check("a block heading is offered no flex controls", !(await groups()).includes("Direction"));
check("nor the flex-child ones", !(await groups()).includes("Flex size"));
check("a static heading is offered no offsets", (await page.getByLabel("Top offset").count()) === 0);
check("looking at an element writes nothing", (await writes()) === 0);

await named("Width unit").selectOption("%");
await named("Width").fill("50");
check("a number takes the unit chosen", (await lastWrite()) === "width: 50%");
await named("Width unit").selectOption("fx");
await named("Width").fill("calc(100% - 2rem)");
check("a half-typed value is not written while it is being typed", !(await lastWrite()).includes("calc"));
await named("Width").blur();
check("fx writes any value as typed", (await lastWrite()).includes("width: calc(100% - 2rem)"));

await open("spacing");
await named("Padding top").fill("10");
const linked = await lastWrite();
check("linked padding writes all four sides", ["top", "right", "bottom", "left"].every((side) => linked.includes(`padding-${side}: 10px`)));
await page.getByRole("button", { name: "Link padding" }).click();
await named("Padding left").fill("4");
check("unlinked, one side changes alone", (await lastWrite()).includes("padding-left: 4px") && (await lastWrite()).includes("padding-top: 10px"));

/* ---------------------------------------------------------- a picture */

await select("image");
check("a picture opens on Size, with Show more open", (await page.locator('[data-section="size"]').evaluate((details) => details.open)) && (await named("Object fit").count()) === 1);
check("its fit is the site's cover", (await page.locator("#dx-object-fit-s option").first().textContent()) === "Default (Cover)");
check("and it is still offered typography, like every element", (await page.locator('[data-section="typography"]').count()) === 1);

/* ------------------------------------------------------------ containers */

await select("flexRow");
let drawn = await groups();
check("a flex container gets the flex controls", ["Direction", "Justify content", "Align items", "Wrap"].every((name) => drawn.includes(name)));
check("and not the grid ones", (await page.getByLabel("Columns", { exact: true }).count()) === 0);
check("the gaps show the site's 24", (await named("Gaps column").getAttribute("placeholder")) === "24");
check("align content waits for wrapping", (await page.getByLabel("Align content").count()) === 0);
await page.getByRole("radio", { name: "Wrap", exact: true }).click();
check("and appears once it wraps", (await page.getByLabel("Align content").count()) === 1);

await select("gridWrap");
check("a grid container gets columns, counted from what renders", (await named("Columns").getAttribute("placeholder")) === "3");
check("and no flex direction", !(await groups()).includes("Direction"));
await named("Columns").fill("4");
check("a number of columns makes that many equal tracks", (await lastWrite()).includes("grid-template-columns: repeat(4, minmax(0, 1fr))"));

/* --------------------------------------------------------- parent-aware */

await select("flexChild");
drawn = await groups();
check("a child of a flex row gets align self, order and flex size", ["Align self", "Order", "Flex size"].every((name) => drawn.includes(name)));
check("and no grid placement", (await page.getByLabel("Column", { exact: true }).count()) === 0);
await page.getByRole("radio", { name: "Grow", exact: true }).click();
check("grow fills the spare space", (await lastWrite()).includes("flex-grow: 1") && (await lastWrite()).includes("flex-shrink: 1"));

await select("gridChild");
check("a child of a grid gets its column and row", (await named("Column").count()) === 1 && (await named("Row").count()) === 1);
check("and not flex size", !(await groups()).includes("Flex size"));

/* ------------------------------------------------------ position offsets */

await select("overlay");
check("a positioned element opens Position", await page.locator('[data-section="position"]').evaluate((details) => details.open));
check("with all four offsets", (await Promise.all(["Top", "Right", "Bottom", "Left"].map((side) => page.getByLabel(`${side} offset`, { exact: true }).count()))).every((count) => count === 1));

/* ------------------------------------------------------ origin and reset */

await select("edited");
check("an edited value shows the edit", (await named("Font size").inputValue()) === "64");
check("and offers its reset dot", (await page.getByRole("button", { name: "Reset Font size" }).count()) === 1);
const before = await writes();
await page.getByRole("button", { name: "Reset Font size" }).click();
check("resetting removes a declaration the page never had", (await writes()) === before + 1 && !(await lastWrite()).includes("font-size"));

await select("developerInline");
check("a style the developer wrote is shown", (await named("Font size").inputValue()) === "60");
check("and is not offered as somebody's change to reset", (await page.getByRole("button", { name: "Reset Font size" }).count()) === 0);
check("its dot says where it came from", (await page.getByRole("button", { name: /^Font size: Set on this element/ }).count()) === 1);
await named("Font size").fill("50");
const kept = await lastWrite();
check("editing one property leaves a developer's shorthand alone", kept.includes("margin: 0 auto") && kept.includes("font-size: 50px"));

await select("tablet");
check("on a smaller screen, the wider screen's value is the placeholder", (await named("Font size").getAttribute("placeholder")) === "48");
check("and its dot says it is handed down", (await page.getByRole("button", { name: /^Font size: Comes from a wider screen/ }).count()) === 1);

/* ----------------------------------------------------------- list values */

await select("layered");
await open("background");
check("a background shorthand reads as its layers", (await page.getByRole("button", { name: "Image: hero.jpg", exact: true }).count()) === 1);
check("with its colour as the base colour", (await named("Background color").inputValue()) === "#0D1526");
await open("effects");
check("two shadows read as two rows", (await page.getByRole("button", { name: /^Outset: / }).count()) === 1 && (await page.getByRole("button", { name: /^Inset: / }).count()) === 1);
check("a transform reads as its moves", (await page.getByRole("button", { name: /^Move: 10, 0, 0 px/ }).count()) === 1 && (await page.getByRole("button", { name: /^Rotate: / }).count()) === 1);
check("a filter reads as its row", (await page.getByRole("button", { name: "Blur: 2px", exact: true }).count()) === 1);
await open("custom");
check("what no control owns is in Custom CSS", (await page.getByLabel("Custom CSS").inputValue()).includes("text-shadow: 0 1px 2px #0003"));
await page.getByRole("button", { name: "Remove Inset: 0px 1px 0px 0px" }).click();
const shadow = await lastWrite();
check("removing one shadow keeps the other", shadow.includes("box-shadow: 0px 2px 8px 0px rgba(0,0,0,.12)") && !shadow.includes("inset"));
check("and leaves the background shorthand as written", shadow.includes("background: url('/hero.jpg') center/cover no-repeat, #0D1526"));
await page.getByRole("button", { name: "Image: hero.jpg", exact: true }).click();
await page.getByRole("button", { name: "Replace image" }).click();
const layered = await lastWrite();
check("replacing a layer's picture keeps its fit and position", layered.includes("background-image: url('/picked.jpg')") && layered.includes("background-size: cover") && layered.includes("background-color: #0D1526") && !layered.includes("background: "));

await select("developerTransform");
await open("effects");
check("a transform the rows cannot express is shown as written", ((await page.locator(".dx-raw code").first().textContent()) ?? "").includes("matrix(1, 0, 0, 1, 10, 0)"));

await open("custom");
await page.getByLabel("Custom CSS").fill("cursor: pointer; color: red; background-image: url(x.png); --dw-enter: x");
await page.getByLabel("Custom CSS").blur();
const customWrite = await lastWrite();
check("custom CSS keeps what it may", customWrite.includes("cursor: pointer"));
check("and refuses what a control owns or the page may not carry", !customWrite.includes("color: red") && !customWrite.includes("url(") && !customWrite.includes("--dw-enter: x"));
check("saying why", (await page.locator(".dx-note.warn").textContent()).includes("set it with its control above"));

if (errors.length) problems.push(...errors.map((error) => `page error: ${error}`));
await browser.close();

if (problems.length) {
  console.error(`inspectorBrowser: ${problems.length} of ${checks} failed`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(`inspectorBrowser: ${checks} checks — the same sections for every element, context controls exactly when they apply, units and fx, linked sides, dots and resets, shorthands left alone, list values as rows, custom CSS refusals passed in Chromium`);
