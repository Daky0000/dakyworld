/**
 * What the inspector actually draws, asked of a real browser.
 *
 * A compile proves nothing about which controls a selected element gets, and a
 * unit test over the model proves the rules and not the wiring. This renders
 * the component and reads the panel back.
 */
/*
 * Run it against the harness page:
 *
 *   npm --prefix client exec vite -- --port 5199 --strictPort --host 127.0.0.1
 *   node checks/browser/inspector.mjs
 *
 * Playwright is not a dependency of this project — the OS is not otherwise
 * browser-driven — so this finds an installed copy and says so plainly when it
 * cannot. `PLAYWRIGHT_URL` names one explicitly.
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
const page = await browser.newPage({ viewport: { width: 420, height: 1400 } });
const problems = [];
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

/**
 * Which groups the panel drew.
 *
 * Read from `data-section` rather than from the heading's classes: a check that
 * breaks when somebody restyles a heading is a check nobody trusts, and this one
 * is about which controls an element gets.
 */
const sections = async () => page.$$eval("[data-section]", (nodes) => nodes.map((node) => node.getAttribute("data-section")));

/** Every control the panel drew, by its accessible name. */
const labels = () => page.$$eval("input, select, [role=radiogroup]", (nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? node.getAttribute("title") ?? ""));
const valueOf = (label) =>
  page.$$eval(
    "input, select",
    (nodes, wanted) => {
      const found = nodes.find((node) => (node.getAttribute("aria-label") ?? "") === wanted);
      return found ? found.value : null;
    },
    label,
  );
const originOf = (property) =>
  page.$$eval("[data-origin]", (nodes, wanted) => {
    const found = nodes.find((node) => node.getAttribute("data-origin") === wanted);
    return found ? found.textContent.trim() : "";
  }, property);

/* ------------------------------------------------------------- a heading */

await select("heading");
let drawn = await sections();
check("a heading is offered typography", drawn.includes("typography"));
check("a heading is offered no image controls", !drawn.includes("image"));
check("a heading is offered no flex arrangement", !drawn.includes("flexContainer"));
check("a heading is offered no grid", !drawn.includes("gridContainer"));
check("a static heading hides Position", !drawn.includes("position"));
check("Advanced is present", drawn.includes("advanced"));
check("the content slot is drawn", (await page.$('[data-testid="content-slot"]')) !== null);

// The point of the whole second phase: the control shows the site's own value.
check("font size shows the website's 72px", (await valueOf("Size")) === "72px");
check("and says the website is where it came from", (await originOf("font-size")) === "Website");
check("the font reads as the family the site uses", (await valueOf("Font")) === '"Space Grotesk", sans-serif');
check("weight comes back as the site's 700", (await valueOf("Weight")) === "700");
check("max width shows the site's 780px", (await valueOf("Max width")) === "780px");

let names = await labels();
check("width and height appear once each", names.filter((name) => name === "Width").length === 1 && names.filter((name) => name === "Height").length === 1);
check("a heading gets no image fit", !names.includes("Fit"));

// A control with nothing behind it must not claim the website decided it, and a
// select must not offer its first option as the current state.
check("an unmeasured width shows no origin", (await originOf("width")) === "");
check("and reads as designed rather than as a number", (await valueOf("Width")) === "");
check("a case control nothing has set is not showing UPPERCASE", (await valueOf("Case")) === "");
// A group with nothing set starts shut, so opening it is also a check of the
// toggle every group now has.
await page.click('[data-section="spacing"] button[aria-expanded="false"]');
names = await labels();
check("a shut group opens when asked", names.includes("padding top"));
check("the spacing boxes are named in full for a screen reader", names.includes("padding top") && names.includes("margin left"));
check("and drawn as a box rather than four labelled lines", !(await page.textContent("body")).includes("padding top"));

// Acceptance criterion: opening an element writes nothing.
check("looking at an element does not touch the draft", (await page.evaluate(() => window.__harness.writes.length)) === 0);

/* ---------------------------------------------------------------- a photo */

await select("image");
drawn = await sections();
check("an image is offered image controls", drawn.includes("image"));
check("an image is offered no typography", !drawn.includes("typography"));
names = await labels();
check("an image has a fit control", names.includes("Fit"));
check("an image has no font control", !names.includes("Font"));
check("object fit shows the site's cover", (await valueOf("Fit")) === "cover");

/* ------------------------------------------------------------ containers */

await select("flexRow");
drawn = await sections();
check("a flex container gets the arrangement controls", drawn.includes("flexContainer"));
check("a flex container is not offered grid tracks", !drawn.includes("gridContainer"));
check("a flex container is not treated as a flex child", !drawn.includes("flexChild"));
names = await labels();
check("direction is offered", names.includes("Direction"));
check("grid columns are not", !names.includes("Columns"));
check("the row gap shows the site's 24px", (await valueOf("Row gap")) === "24px");

await select("gridWrap");
drawn = await sections();
check("a grid container gets grid controls", drawn.includes("gridContainer"));
check("a grid container is not offered flex direction", !drawn.includes("flexContainer"));
check("the track list shows what the site defines", (await valueOf("Columns")) === "repeat(3, 1fr)");

/* --------------------------------------------------------- parent-aware */

await select("flexChild");
drawn = await sections();
check("a child of a flex row gets flex-child controls", drawn.includes("flexChild"));
check("and no grid placement", !drawn.includes("gridChild"));
names = await labels();
check("grow and shrink are offered", names.includes("Grow") && names.includes("Shrink"));
check("grid column is not", !names.includes("Column"));

await select("gridChild");
drawn = await sections();
check("a child of a grid gets grid placement", drawn.includes("gridChild"));
check("and not grow and shrink", !drawn.includes("flexChild"));
names = await labels();
check("grid column is offered", names.includes("Column"));
check("grow is not", !names.includes("Grow"));

/* ------------------------------------------------------ position offsets */

await select("overlay");
drawn = await sections();
check("an absolutely positioned element shows Position", drawn.includes("position"));
names = await labels();
check("all four offsets are offered", ["top", "right", "bottom", "left"].every((side) => names.includes(side)));
check("the stacking order is offered", names.includes("Stack order"));

await select("sticky");
names = await labels();
check("a sticky element is offered top and bottom", names.includes("top") && names.includes("bottom"));
check("and not left and right, which do nothing to it", !names.includes("left") && !names.includes("right"));

await select("heading");
names = await labels();
check("a static element is offered no offsets at all", !["top", "right", "bottom", "left"].some((side) => names.includes(side)));

/* ------------------------------------------------------ origin and reset */

await select("edited");
check("an edited value shows the edit", (await valueOf("Size")) === "64px");
check("and is marked as an override", (await originOf("font-size")) === "Override");
check("a reset is offered", (await page.$('[aria-label="Reset font-size"]')) !== null);
check("nothing has been written by looking", (await page.evaluate(() => window.__harness.writes.length)) === 0);
await page.click('[aria-label="Reset font-size"]');
check("resetting removes the declaration", (await page.evaluate(() => window.__harness.writes.at(-1))) === "");

await select("developerInline");
check("a style attribute the developer wrote is shown", (await valueOf("Size")) === "60px");
check("and is not called somebody's override", (await originOf("font-size")) === "Website");
check("so no reset is offered for it", (await page.$('[aria-label="Reset font-size"]')) === null);

/* -------------------------------------------------------- browser noise */

await select("heading");
const text = await page.textContent("body");
check("opacity 1 is not announced as a value somebody chose", !/Opacity[\s\S]{0,80}Website/.test(text));

await browser.close();

if (problems.length) {
  console.error(`inspectorBrowser: ${problems.length} of ${checks} failed`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(`inspectorBrowser: ${checks} checks — contextual sections, parent-aware controls, conditional offsets, effective values, origin and reset passed in Chromium`);
