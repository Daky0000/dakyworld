import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");

/**
 * Three things somebody reported on 12 Oct 2026, held as what a browser shows.
 *
 *  - The Layers panel came loose see-through, and could not be put back by
 *    dragging it home. The colour is read off the element, not the attribute:
 *    the fault was a variable that did not reach it.
 *  - A block holding a form answered a delete with a sentence sending the
 *    person to the source editor. It asks, and then it deletes.
 *  - Two rows above the Style tab that were reading rather than controls.
 */
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const structure = [];
page.on("pageerror", (error) => errors.push(error.message));

const WARNING = "This block holds a form. Deleting the block deletes everything inside it, so anything on the site that depends on that may stop working.";
const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map((key) => [key, true]));
const contact = {
  id: "contact", kind: "container", tag: "section", value: "", preview: "Contact", label: "Contact", order: 1,
  structure: { remove: false, duplicate: false, move: true, forceRemove: true, removeWarning: WARNING, previousId: "hero.title", group: "main", duplicateReason: "A copy of this block would repeat its form, embed or scripts." },
};
const document = {
  site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" }, links: [], readFrom: "imported file",
  page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null },
  sections: [
    { id: "hero", label: "Hero", kind: "section", fields: [{ id: "hero.title", kind: "text", tag: "h1", value: "Welcome home", preview: "Welcome home", label: "Main heading", order: 0, structure: { remove: true, duplicate: true, move: true, nextId: "contact", group: "main" } }] },
    { id: "layout", label: "Layout and containers", kind: "section", fields: [contact] },
  ],
  draft: { revision: 0, savedAt: null, savedBy: null, values: {} }, problems: [],
};
const PREVIEW = '<html><body style="margin:0;background:#f4f0e8;font-family:Arial;padding:60px"><h1 data-dw-field="hero.title" style="font-size:64px">Welcome home</h1><section data-dw-field="contact" style="padding:40px;background:#fff"><form><input name="email"><button>Send</button></form></section></body></html>';

await page.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  if (url.pathname.endsWith("/structure")) {
    structure.push(route.request().postDataJSON());
    document.sections[1].fields = [];
    document.draft = { ...document.draft, revision: document.draft.revision + 1 };
    return route.fulfill({ json: { revision: document.draft.revision, selectedId: null } });
  }
  if (url.pathname.endsWith("/draft")) return route.fulfill({ json: { revision: document.draft.revision, problems: [], unknown: [] } });
  if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Client", external: true, permissions: [], uiState: { tours: { editor: { status: "dismissed", at: "2026-10-07T00:00:00.000Z" } } } } });
  if (url.pathname.endsWith("/access")) return route.fulfill({ json: { capabilities } });
  if (url.pathname.endsWith("/assets")) return route.fulfill({ json: [] });
  if (url.pathname.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [], aiEnabled: true } } });
  if (url.pathname.includes("/preview")) return route.fulfill({ contentType: "text/html", body: PREVIEW });
  return route.fulfill({ json: document });
});

let passed = 0;
await mkdir("checks/artifacts", { recursive: true });
const check = (label, condition, detail = "") => { assert.ok(condition, `${label}${detail ? ` — ${detail}` : ""}`); passed += 1; };
const solid = (colour) => /^rgb\(/.test(colour) || (/^rgba\(/.test(colour) && Number(colour.split(",")[3].replace(")", "")) === 1);
const centre = async (locator) => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
async function drag(from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
}

try {
  for (const theme of ["dark", "light"]) {
    await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
    await page.evaluate((name) => { localStorage.setItem("dw-structure-floating", "docked"); localStorage.removeItem("dw-structure-bounds"); localStorage.setItem("website-editor-theme", name); }, theme);
    await page.reload();
    await page.getByRole("button", { name: "Layers", exact: true }).click();
    await page.getByRole("treeitem", { name: /Welcome home/ }).waitFor();
    const drawer = page.locator(".dx-drawer");
    const panelColour = await drawer.evaluate((element) => getComputedStyle(element).backgroundColor);
    check(`[${theme}] docked, the panel sits in its drawer`, (await drawer.locator(".editor-layers").count()) === 1);

    // Popped out with its button.
    await page.getByRole("button", { name: "Float the Layers panel", exact: true }).click();
    const floating = page.locator(".dx-layers-float");
    await floating.waitFor();
    const colour = await floating.evaluate((element) => getComputedStyle(element).backgroundColor);
    check(`[${theme}] floating, the panel has a background`, solid(colour), colour);
    check(`[${theme}] and it is the editor's panel colour`, colour === panelColour, `${colour} vs ${panelColour}`);
    check(`[${theme}] because it is drawn inside the editor`, await floating.evaluate((element) => Boolean(element.closest(".website-editor"))));
    check(`[${theme}] its rows are still there`, (await floating.getByRole("treeitem").count()) === 2);
    const home = drawer.locator(".dx-layers-home");
    await page.screenshot({ path: `checks/artifacts/layers-floating-${theme}.png` });
    check(`[${theme}] the drawer keeps a slot for it`, (await home.count()) === 1 && /Layers is floating/.test(await home.innerText()));

    // Carried home and let go.
    const head = floating.locator(".dx-layers-head");
    const slot = await centre(home);
    await drag(await centre(head), slot);
    await drawer.locator(".dx-layers-home[data-armed]").waitFor();
    await page.screenshot({ path: `checks/artifacts/layers-docking-${theme}.png` });
    check(`[${theme}] over its drawer, the slot says it will take it`, /Let go to dock/.test(await home.innerText()));
    await page.mouse.up();
    await drawer.locator(".editor-layers").waitFor();
    check(`[${theme}] let go there, it docks`, (await page.locator(".dx-layers-float").count()) === 0);
    check(`[${theme}] and that is remembered`, (await page.evaluate(() => localStorage.getItem("dw-structure-floating"))) === "docked");

    // Dragged out by its header, not by the button.
    const dockedHead = drawer.locator(".dx-layers-head");
    await drag(await centre(dockedHead), { x: 980, y: 420 });
    await page.mouse.up();
    await floating.waitFor();
    const pulled = await floating.evaluate((element) => getComputedStyle(element).backgroundColor);
    check(`[${theme}] dragged out, it is still solid`, solid(pulled) && pulled === panelColour, pulled);
    const box = await floating.boundingBox();
    check(`[${theme}] and it is where it was dropped`, box.x > 500 && box.y > 200, JSON.stringify(box));

    // A short drag that never leaves the drawer is not a float.
    await home.getByRole("button", { name: "Dock it here", exact: true }).click();
    await drawer.locator(".editor-layers").waitFor();
    const start = await centre(drawer.locator(".dx-layers-head"));
    await drag(start, { x: start.x + 30, y: start.y + 60 });
    await page.mouse.up();
    await drawer.locator(".editor-layers").waitFor();
    check(`[${theme}] a nudge inside the drawer leaves it docked`, (await page.locator(".dx-layers-float").count()) === 0);
  }

  // The Style tab starts with its controls.
  await page.getByRole("treeitem", { name: /Welcome home/ }).click();
  await page.getByRole("tab", { name: "Style", exact: true }).click();
  await page.locator(".dx-style summary", { hasText: "Typography" }).waitFor();
  const inspector = page.getByRole("complementary", { name: "Element inspector" });
  await page.screenshot({ path: "checks/artifacts/style-tab-top.png" });
  check("no line naming the screen size above the Style panels", (await inspector.locator(".dx-scope").count()) === 0 && !/all screens/.test(await inspector.innerText()));
  check("no Saved style menu when there is nothing saved to choose", (await inspector.getByLabel("Saved style").count()) === 0);
  check("Normal and Hover are still there", (await inspector.getByRole("button", { name: "Hover", exact: true }).count()) === 1);

  // A block holding a form: asked, then deleted.
  await page.getByRole("treeitem", { name: /Contact/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).waitFor();
  check("nothing sends the person to the source editor", !/source editor|controlled by the page source/i.test(await page.locator(".website-editor").innerText()));
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  const asked = await dialog.innerText();
  await page.screenshot({ path: "checks/artifacts/delete-question.png" });
  check("deleting it asks first", /Delete .Contact.\?/.test(asked), asked);
  check("in the server's own words for what goes with it", asked.includes(WARNING));
  check("and says it can be undone", /Undo brings it back/.test(asked));
  check("the question is a solid panel too", solid(await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)));
  await dialog.getByRole("button", { name: "Keep it", exact: true }).click();
  check("keeping it changes nothing", structure.length === 0 && (await dialog.count()) === 0);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete anyway", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role="treeitem"]').length === 1);
  check("saying yes deletes it", structure.length === 1 && structure[0].kind === "remove" && structure[0].fieldId === "contact");
  check("and the request carries the yes", structure[0].force === true, JSON.stringify(structure[0]));

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`layersAndDelete: ${passed} checks — the floating Layers panel is solid in both themes and docks when carried home, the Style tab opens on its controls, and a block holding a form is deleted after one question, in Chromium.`);
} finally {
  await browser.close();
}
