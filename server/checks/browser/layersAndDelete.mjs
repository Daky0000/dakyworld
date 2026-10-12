import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 *
 * And four from the launch audit the same day:
 *
 *  - The menu said "Del" beside Delete and the key did nothing. It goes through
 *    the menu's own door now — the same question for a block holding a form —
 *    from the editor and from inside the page, where the keyboard is after a
 *    click, and never while anything is being typed into.
 *  - Docked, Layers filled the top third of its drawer.
 *  - The inspector's tabs were buttons that looked like tabs.
 *  - A form could be moved and deleted and was still called read-only.
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
const footer = {
  id: "footer", kind: "container", tag: "footer", value: "", preview: "Footer", label: "Footer", order: 2,
  structure: { remove: false, duplicate: false, move: false, forceRemove: false, group: "main", reason: "This part of the page can't be moved or deleted." },
};
const document = {
  site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" }, links: [], readFrom: "imported file",
  page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null },
  sections: [
    { id: "hero", label: "Hero", kind: "section", fields: [{ id: "hero.title", kind: "text", tag: "h1", value: "Welcome home", preview: "Welcome home", label: "Main heading", order: 0, structure: { remove: true, duplicate: true, move: true, nextId: "contact", group: "main" } }] },
    { id: "layout", label: "Layout and containers", kind: "section", fields: [contact, footer] },
  ],
  draft: { revision: 0, savedAt: null, savedBy: null, values: {} }, problems: [],
};
// The page goes through the server's own `previewDocument`, so the frame runs
// the real picker: half of the Delete key lives in that script, which exists
// only as a string in site.ts, and a hand-written stand-in would prove nothing
// about it.
const RAW = '<html><body style="margin:0;background:#f4f0e8;font-family:Arial;padding:60px"><h1 style="font-size:64px">Welcome home</h1><section style="padding:40px;background:#fff"><form><input name="email"><button>Send</button></form></section><footer style="padding:20px">Footer</footer></body></html>';
const PREVIEW = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
  import { readFileSync } from "node:fs";
  const { previewDocument } = await import("./src/services/website/site.ts");
  const html = readFileSync(0, "utf8");
  const fields = [["hero.title", "text", "h1"], ["contact", "container", "section"], ["footer", "container", "footer"]]
    .map(([id, kind, tag]) => ({ id, kind, tag, label: id, value: "", attrInsert: html.indexOf("<" + tag) + tag.length + 1 }));
  process.stdout.write(previewDocument(html, "http://127.0.0.1:5199/", fields).html);
`], { cwd: join(dirname(fileURLToPath(import.meta.url)), "..", ".."), input: RAW, encoding: "utf8" });
assert.ok(PREVIEW.includes('data-dw-field="contact"') && PREVIEW.includes('type: "delete"'), "the preview carries the real picker");

await page.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  if (url.pathname.endsWith("/structure")) {
    const request = route.request().postDataJSON();
    structure.push(request);
    if (request.kind === "remove") for (const section of document.sections) section.fields = section.fields.filter((field) => field.id !== request.fieldId);
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
/** The docked panel against the body of the drawer it sits in. */
const layersFit = (drawer) => drawer.evaluate((element) => {
  const body = element.querySelector(".dx-dbody").getBoundingClientRect();
  const layers = element.querySelector(".editor-layers").getBoundingClientRect();
  return { body: Math.round(body.height), layers: Math.round(layers.height), fills: layers.height >= body.height - 2 && Math.abs(body.bottom - layers.bottom) <= 2 };
});
/** Nothing new asked and nothing sent: what a Delete that must do nothing leaves behind. */
const untouched = async (label, before) => {
  await page.waitForTimeout(250);
  check(label, structure.length === before && (await page.getByRole("alertdialog").count()) === 0, JSON.stringify(structure.slice(before)));
};
async function drag(from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
}

try {
  for (const theme of ["dark", "light"]) {
    await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
    await page.evaluate((name) => { localStorage.setItem("dw-structure-floating", "docked"); localStorage.removeItem("dw-structure-bounds"); localStorage.removeItem("dw-layers-height"); localStorage.setItem("website-editor-theme", name); }, theme);
    await page.reload();
    await page.getByRole("button", { name: "Layers", exact: true }).click();
    await page.getByRole("treeitem", { name: /Welcome home/ }).waitFor();
    const drawer = page.locator(".dx-drawer");
    const panelColour = await drawer.evaluate((element) => getComputedStyle(element).backgroundColor);
    check(`[${theme}] docked, the panel sits in its drawer`, (await drawer.locator(".editor-layers").count()) === 1);
    // Filling it, not its top third: the 35% cap was from when the list sat
    // above the properties in one panel.
    const fit = await layersFit(drawer);
    await page.screenshot({ path: `checks/artifacts/layers-docked-${theme}.png` });
    check(`[${theme}] and fills it`, fit.fills, JSON.stringify(fit));

    if (theme === "dark") {
      // Resized from its bottom edge, it keeps the height it was given — on
      // this visit and the next — and the drawer no longer decides.
      const foot = await centre(drawer.locator(".editor-layers .dx-layers-foot"));
      await drag(foot, { x: foot.x, y: foot.y - 240 });
      await page.mouse.up();
      const resized = await layersFit(drawer);
      check("resized, it keeps the height it was dragged to", !resized.fills && Math.abs(resized.layers - (fit.layers - 240)) <= 6, JSON.stringify(resized));
      await page.reload();
      await page.getByRole("button", { name: "Layers", exact: true }).click();
      await page.getByRole("treeitem", { name: /Welcome home/ }).waitFor();
      const remembered = await layersFit(drawer);
      check("and has it again after a reload", Math.abs(remembered.layers - resized.layers) <= 2, JSON.stringify(remembered));
      await page.evaluate(() => localStorage.removeItem("dw-layers-height"));
      await page.reload();
      await page.getByRole("button", { name: "Layers", exact: true }).click();
      await page.getByRole("treeitem", { name: /Welcome home/ }).waitFor();
      check("never resized, it fills the drawer again", (await layersFit(drawer)).fills);
    }

    // Popped out with its button.
    await page.getByRole("button", { name: "Float the Layers panel", exact: true }).click();
    const floating = page.locator(".dx-layers-float");
    await floating.waitFor();
    const colour = await floating.evaluate((element) => getComputedStyle(element).backgroundColor);
    check(`[${theme}] floating, the panel has a background`, solid(colour), colour);
    check(`[${theme}] and it is the editor's panel colour`, colour === panelColour, `${colour} vs ${panelColour}`);
    check(`[${theme}] because it is drawn inside the editor`, await floating.evaluate((element) => Boolean(element.closest(".website-editor"))));
    check(`[${theme}] its rows are still there`, (await floating.getByRole("treeitem").count()) === 3);
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

  await page.getByRole("treeitem", { name: /Welcome home/ }).click();
  const inspector = page.getByRole("complementary", { name: "Element inspector" });

  // The inspector's tabs are tabs to a screen reader and to the keyboard too:
  // each names the panel it controls, the panel names the tab it belongs to,
  // the arrows move along them and only the chosen one is a Tab stop.
  const tablist = inspector.getByRole("tablist", { name: "Element settings" });
  const tabs = await tablist.getByRole("tab").evaluateAll((elements) => elements.map((element) => ({
    name: element.textContent.trim(), id: element.id, selected: element.getAttribute("aria-selected"), tabIndex: element.tabIndex,
    controls: element.getAttribute("aria-controls"), panel: document.getElementById(element.getAttribute("aria-controls") ?? "")?.getAttribute("role") ?? null,
  })));
  check("three tabs in a tablist", tabs.map((tab) => tab.name).join() === "General,Style,Interactions", JSON.stringify(tabs));
  check("each controls the tab panel", tabs.every((tab) => tab.id && tab.controls && tab.panel === "tabpanel"), JSON.stringify(tabs));
  check("one is selected, and it is the only Tab stop", tabs.map((tab) => `${tab.selected}:${tab.tabIndex}`).join() === "true:0,false:-1,false:-1", JSON.stringify(tabs));
  const panelFor = async () => inspector.getByRole("tabpanel").evaluate((element) => ({ by: element.getAttribute("aria-labelledby"), name: document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() }));
  check("the panel is labelled by the chosen tab", (await panelFor()).name === "General", JSON.stringify(await panelFor()));
  const focusedTab = () => page.evaluate(() => document.activeElement?.getAttribute("role") === "tab" && document.activeElement.getAttribute("aria-selected") === "true" ? document.activeElement.textContent.trim() : null);
  await tablist.getByRole("tab", { name: "General", exact: true }).focus();
  for (const [key, expected] of [["ArrowRight", "Style"], ["ArrowRight", "Interactions"], ["ArrowRight", "General"], ["ArrowLeft", "Interactions"], ["Home", "General"], ["End", "Interactions"]]) {
    await page.keyboard.press(key);
    check(`${key} moves to ${expected}, chooses it and labels the panel with it`, (await focusedTab()) === expected && (await panelFor()).name === expected, `${await focusedTab()} / ${JSON.stringify(await panelFor())}`);
  }

  // The Style tab starts with its controls.
  await page.getByRole("tab", { name: "Style", exact: true }).click();
  await page.locator(".dx-style summary", { hasText: "Typography" }).waitFor();
  await page.screenshot({ path: "checks/artifacts/style-tab-top.png" });
  check("no line naming the screen size above the Style panels", (await inspector.locator(".dx-scope").count()) === 0 && !/all screens/.test(await inspector.innerText()));
  check("no Saved style menu when there is nothing saved to choose", (await inspector.getByLabel("Saved style").count()) === 0);
  check("Normal and Hover are still there", (await inspector.getByRole("button", { name: "Hover", exact: true }).count()) === 1);

  /* ------------------------------------------------- Delete, from the keyboard */
  // Never while something is being typed into. The inspector's own box first.
  await page.getByRole("tab", { name: "General", exact: true }).click();
  const box = inspector.getByRole("textbox", { name: "Main heading" });
  await box.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Delete");
  await untouched("Delete in the inspector's text box is a letter, not the heading", 0);
  check("and the heading is still selected", (await page.getByRole("treeitem", { name: /Welcome home/, selected: true }).count()) === 1);
  await page.getByRole("button", { name: "Search or filter layers" }).click();
  await page.getByRole("textbox", { name: "Search layers" }).focus();
  await page.keyboard.press("Delete");
  await untouched("nor in a plain input", 0);
  await page.getByRole("button", { name: "Search or filter layers" }).click();

  // On the page itself. After a click the keyboard is inside the frame, so the
  // page's own boxes count as typing too, and so does typing on the page.
  const canvas = page.frameLocator('iframe[title="Page"]');
  await canvas.locator('input[name="email"]').click();
  await page.getByRole("treeitem", { name: /Contact/, selected: true }).waitFor();
  await page.keyboard.press("Delete");
  await untouched("Delete in one of the page's own boxes leaves its block alone", 0);
  await canvas.locator('[data-dw-field="hero.title"]').dblclick();
  await canvas.locator('[data-dw-field="hero.title"][data-dw-editing]').waitFor();
  await page.keyboard.press("End");
  await page.keyboard.press("Delete");
  await untouched("nor while typing on the page", 0);
  await page.keyboard.press("Escape");
  await canvas.locator("[data-dw-editing]").waitFor({ state: "detached" });

  // Refused wherever the menu's Delete is greyed out.
  await page.getByRole("treeitem", { name: /Footer/ }).click();
  await page.keyboard.press("Delete");
  await untouched("Delete on something that cannot be deleted does nothing", 0);

  // A block holding a form: asked, then deleted.
  await page.getByRole("treeitem", { name: /Contact/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).waitFor();
  check("nothing sends the person to the source editor", !/source editor|controlled by the page source/i.test(await page.locator(".website-editor").innerText()));
  const dialog = page.getByRole("alertdialog");
  // The key asks the menu's question, and a second press does not answer it.
  await page.getByRole("treeitem", { name: /Contact/ }).focus();
  await page.keyboard.press("Delete");
  await dialog.waitFor();
  const askedByKey = await dialog.innerText();
  check("the Delete key asks the same question first", /Delete .Contact.\?/.test(askedByKey) && askedByKey.includes(WARNING), askedByKey);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(250);
  check("and a second Delete is not a yes", structure.length === 0 && (await dialog.count()) === 1);
  await dialog.getByRole("button", { name: "Keep it", exact: true }).click();
  await untouched("Keep it, after the key, changes nothing", 0);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.waitFor();
  const asked = await dialog.innerText();
  await page.screenshot({ path: "checks/artifacts/delete-question.png" });
  check("deleting it asks first", /Delete .Contact.\?/.test(asked), asked);
  check("in the server's own words for what goes with it", asked.includes(WARNING));
  check("and says it can be undone", /Undo brings it back/.test(asked));
  check("the question is a solid panel too", solid(await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)));
  await dialog.getByRole("button", { name: "Keep it", exact: true }).click();
  check("keeping it changes nothing", structure.length === 0 && (await dialog.count()) === 0);
  // Pressed on the page, where the keyboard is after clicking the block.
  await canvas.locator('[data-dw-field="contact"]').click({ position: { x: 12, y: 12 } });
  await page.getByRole("treeitem", { name: /Contact/, selected: true }).waitFor();
  await page.keyboard.press("Delete");
  await dialog.waitFor();
  check("Delete on the page asks the same question", (await dialog.innerText()) === askedByKey);
  await dialog.getByRole("button", { name: "Delete anyway", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role="treeitem"]').length === 2);
  check("saying yes deletes it", structure.length === 1 && structure[0].kind === "remove" && structure[0].fieldId === "contact");
  check("and the request carries the yes", structure[0].force === true, JSON.stringify(structure[0]));

  // Something that needs no question goes at once, and only once for one press.
  await page.getByRole("treeitem", { name: /Welcome home/ }).click();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.querySelectorAll('[role="treeitem"]').length === 1);
  await page.waitForTimeout(250);
  check("Delete takes a block that needs no question straight away", structure.length === 2 && structure[1].kind === "remove" && structure[1].fieldId === "hero.title" && !structure[1].force, JSON.stringify(structure[1]));

  /* ------------------------------------------ a form is not "read-only" any more */
  // It moves and deletes like any other block; what is out of reach is what is
  // inside it, and that is what it says — in the inspector and in List mode.
  // Its name is the server's, held by checks/websiteHtmlImport.ts.
  document.sections[1].fields.push({
    id: "signup", kind: "unsupported", tag: "form", value: "", preview: "FORM element", label: "FORM element", order: 3, previewReadOnly: true,
    structure: { remove: false, duplicate: false, move: true, forceRemove: true, removeWarning: WARNING, group: "main" },
  });
  await page.reload();
  await page.getByRole("button", { name: "Layers", exact: true }).click();
  await page.getByRole("treeitem", { name: /form/i }).click();
  const general = await inspector.getByRole("tabpanel").innerText();
  await page.screenshot({ path: "checks/artifacts/form-inspector.png" });
  check("the inspector says a form's insides can't be edited here", /inside this form can't be edited here/.test(general), general);
  check("and that it can still be moved and deleted", /still move it, delete it/.test(general), general);
  check("nothing on screen calls it read-only", !/read-only|Preserved Element/i.test(await page.locator(".website-editor").innerText()));
  await page.getByRole("button", { name: /^Editor mode/ }).click();
  await page.getByRole("menuitemradio", { name: "List", exact: true }).click();
  const card = page.locator(".dx-listcard", { hasText: "FORM element" });
  await card.waitFor();
  const listed = await card.innerText();
  check("List mode says the same", /can't be edited here/.test(listed) && /move it, delete it/.test(listed) && !/read-only/i.test(listed), listed);

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`layersAndDelete: ${passed} checks — the floating Layers panel is solid in both themes and docks when carried home, docked it fills its drawer until resized, the inspector's tabs are tabs, the Style tab opens on its controls, a block holding a form is deleted after one question, the Delete key takes the same path from the editor and from the page but never while anything is being typed, and a form says what is true of it, in Chromium.`);
} finally {
  await browser.close();
}
