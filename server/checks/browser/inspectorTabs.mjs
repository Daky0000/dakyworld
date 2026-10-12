import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

/**
 * The inspector's three tabs — General, Style, Interactions — the same for
 * every element, driven through the real editor in a real browser.
 *
 * Every Style and Interactions assertion reads the *computed* style of the
 * element in the frame. Asserting that the editor wrote an attribute is not a
 * test of anything: four rounds of green tests once did exactly that while a
 * CSP nonce had switched every inline style off.
 *
 * Settings that are markup (tag, id, attributes) are structure changes on the
 * server, so here what is asserted is the request the editor sends — the server
 * half is `checks/websiteElementSettings.ts`.
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
  links: [{ path: "/contact", title: "Contact" }],
  readFrom: "imported file",
  page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null },
  sections: [{
    id: "hero",
    label: "Hero",
    kind: "section",
    fields: [
      { id: "hero.title", kind: "text", tag: "h1", value: "Welcome home", preview: "Welcome home", label: "Main heading", order: 0, href: "", style: "font-size: 64px", structure, tagOptions: ["h1", "h2", "h3", "h4", "h5", "h6"], attributes: [{ name: "id", value: "top" }] },
      { id: "hero.box", kind: "container", tag: "div", value: "", preview: "Box", label: "Container 1", order: 1, href: "", structure, tagOptions: ["div", "section", "header", "footer", "article", "aside", "nav"] },
      { id: "hero.cta", kind: "button", tag: "a", value: "Get started", preview: "Get started", label: "Button", order: 2, href: "/contact", newTab: false, parentId: "hero.box", structure },
      { id: "hero.video", kind: "unsupported", tag: "video", value: "", preview: "VIDEO element", label: "VIDEO element", order: 3, structure: { remove: false, duplicate: false, reason: "This element is controlled by the page source." }, attributes: [{ name: "src", value: "/media/intro.mp4" }, { name: "controls", value: "" }], mediaSources: 0 },
    ],
  }],
  draft: { revision: 0, savedAt: null, savedBy: null, values: {} },
  problems: [],
};
const structureCalls = [];

await page.addInitScript(() => {
  // Designer controls, as the account menu would have remembered them.
  try { localStorage.setItem("website-designer:tester", "yes"); } catch { /* storage is optional */ }
});
await page.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  if (url.pathname.endsWith("/draft")) {
    const payload = route.request().postDataJSON();
    document.draft = { ...document.draft, values: payload?.values ?? {}, revision: document.draft.revision + 1, savedAt: new Date().toISOString() };
    return route.fulfill({ json: { revision: document.draft.revision, problems: [], unknown: [] } });
  }
  if (url.pathname.endsWith("/structure")) {
    structureCalls.push(route.request().postDataJSON());
    document.draft = { ...document.draft, revision: document.draft.revision + 1 };
    return route.fulfill({ json: { revision: document.draft.revision, selectedId: structureCalls.at(-1).fieldId } });
  }
  if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Client", external: true, permissions: [], uiState: { tours: { editor: { status: "dismissed", at: "2026-10-07T00:00:00.000Z" } } } } });
  if (url.pathname.endsWith("/access")) return route.fulfill({ json: { capabilities } });
  if (url.pathname.endsWith("/assets")) return route.fulfill({ json: [] });
  if (url.pathname.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [], aiEnabled: true } } });
  if (url.pathname.includes("/preview")) {
    return route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0;background:#f4f0e8;font-family:Arial;padding:60px"><h1 data-dw-field="hero.title" style="font-size:64px">Welcome home</h1><div data-dw-field="hero.box" style="display:block"><p>One</p><a data-dw-field="hero.cta" href="/contact">Get started</a></div><video data-dw-field="hero.video" src="/media/intro.mp4" controls style="width:200px;height:100px"></video></body></html>',
    });
  }
  return route.fulfill({ json: document });
});

const frame = () => page.frameLocator('iframe[title="Page"]');
const heading = () => frame().locator("h1");
const computed = (property) => heading().evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
const saved = () => document.draft.values["hero.title"] ?? {};
const save = async () => { await page.keyboard.press("Control+s"); await page.waitForTimeout(400); };
const select = async (id = "hero.title") => heading().evaluate((_, fieldId) => parent.postMessage({ source: "dakyworld-preview", type: "select", id: fieldId }, location.origin), id);
const inspector = () => page.getByRole("complementary", { name: "Element inspector" });

try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("navigation", { name: "Tools" }).waitFor();
  await heading().waitFor();
  await select();
  await inspector().waitFor();

  /* --------------------------------------------------------- three tabs */
  const tabs = await inspector().getByRole("tab").allTextContents();
  assert.deepEqual(tabs, ["General", "Style", "Interactions"], "every element has the same three tabs");
  assert.equal(await inspector().getByRole("tab", { name: "General" }).getAttribute("aria-selected"), "true", "General opens first");

  /* ------------------------------------------------------------ General */
  const general = inspector();
  await general.locator('[data-section="content"]').waitFor();
  await general.locator('[data-section="settings"]').waitFor();
  assert.equal(await general.getByLabel("HTML tag").inputValue(), "h1", "the tag shows the heading level");
  await general.getByLabel("HTML tag").selectOption("h2");
  await page.waitForFunction(() => true);
  await page.waitForTimeout(300);
  assert.deepEqual(structureCalls.at(-1)?.settings, { tag: "h2" }, "choosing a level sends a settings change");
  assert.equal(structureCalls.at(-1)?.kind, "settings");
  assert.equal(structureCalls.at(-1)?.fieldId, "hero.title");

  const id = general.getByLabel("ID", { exact: true });
  assert.equal(await id.inputValue(), "top", "the element's own id is shown");
  await id.fill("two words");
  await general.getByRole("alert").filter({ hasText: "starts with a letter" }).waitFor();
  const before = structureCalls.length;
  await id.press("Enter");
  assert.equal(structureCalls.length, before, "an id the server would refuse is never sent");
  await id.fill("welcome");
  await id.press("Enter");
  await page.waitForTimeout(300);
  assert.deepEqual(structureCalls.at(-1)?.settings, { attributes: { id: "welcome" } }, "a good id is sent");

  await general.getByRole("button", { name: "Add attribute" }).click();
  await general.getByLabel("Attribute name").fill("onclick");
  await general.getByLabel("Attribute value").fill("steal()");
  await general.getByRole("alert").filter({ hasText: "script" }).waitFor();
  assert.equal(await general.getByRole("button", { name: "Add", exact: true }).isDisabled(), true, "an event handler cannot be added");
  await general.getByLabel("Attribute name").fill("data-track");
  await general.getByLabel("Attribute value").fill("hero");
  await general.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(structureCalls.at(-1)?.settings, { attributes: { "data-track": "hero" } }, "an allowed attribute is sent");

  const phone = general.getByRole("button", { name: "Show on phone" });
  assert.equal(await phone.getAttribute("aria-pressed"), "true");
  await phone.click();
  await save();
  assert.match(saved().responsive?.mobile ?? "", /display: none/, "hiding on phones writes the phone override");
  assert.doesNotMatch(saved().style ?? "", /display: none/, "and leaves desktop alone");
  await general.getByRole("button", { name: "Show on phone" }).click();
  await save();
  assert.doesNotMatch(saved().responsive?.mobile ?? "", /display/, "showing it again takes the override away");

  /* -------------------------------------------------------------- Style */
  await inspector().getByRole("tab", { name: "Style" }).click();
  const style = inspector().locator(".dx-style");
  await style.waitFor();
  for (const name of ["layout", "spacing", "size", "position", "typography", "background", "border", "effects", "custom"]) {
    assert.equal(await style.locator(`[data-section="${name}"]`).count(), 1, `${name} is in the Style tab`);
  }
  const open = async (name) => {
    const section = style.locator(`[data-section="${name}"]`);
    if (!(await section.evaluate((details) => details.open))) await section.locator(":scope > summary").click();
    return section;
  };

  const typography = await open("typography");
  await typography.getByLabel("Font size", { exact: true }).fill("40");
  assert.equal(await computed("font-size"), "40px", "font size changes the page");
  await typography.getByRole("radio", { name: "Align center" }).click();
  assert.equal(await computed("text-align"), "center", "alignment changes the page");

  const layout = await open("layout");
  await layout.getByRole("radio", { name: "Flex", exact: true }).click();
  assert.equal(await computed("display"), "flex", "display changes the page");
  await layout.getByRole("radio", { name: "Column", exact: true }).click();
  assert.equal(await computed("flex-direction"), "column", "the flex controls appear once it is flex, and work");

  const spacing = await open("spacing");
  await spacing.getByLabel("Padding top", { exact: true }).fill("24");
  assert.equal(await computed("padding-left"), "24px", "linked padding sets every side");
  assert.equal(await computed("padding-bottom"), "24px");

  const border = await open("border");
  await border.getByLabel("Border width top", { exact: true }).fill("3");
  assert.equal(await computed("border-top-width"), "3px", "a border width is drawn");
  assert.equal(await computed("border-left-style"), "solid", "a width alone gets a solid line, or it would draw nothing");

  const effects = await open("effects");
  await effects.getByRole("button", { name: "Add box shadow" }).click();
  assert.notEqual(await computed("box-shadow"), "none", "adding a shadow draws one");
  await effects.getByRole("button", { name: "Add transform" }).click();
  await effects.getByLabel("Move X", { exact: true }).fill("12");
  assert.match(await computed("transform"), /matrix\(1, 0, 0, 1, 12, 0\)/, "a move transform moves it");

  const custom = await open("custom");
  await custom.getByLabel("Custom CSS").fill("text-shadow: 0 1px 2px #000000; cursor: url(x.png), auto");
  await custom.getByLabel("Custom CSS").blur();
  assert.notEqual(await computed("text-shadow"), "none", "custom CSS reaches the page");
  await custom.getByText("pictures, quotes and script", { exact: false }).waitFor();

  await typography.getByRole("button", { name: "Reset Font size" }).click();
  assert.equal(await computed("font-size"), "64px", "the dot puts the page's own value back");

  await save();
  for (const part of ["display: flex", "flex-direction: column", "padding-top: 24px", "padding-left: 24px", "border-top-width: 3px", "border-style: solid", "text-align: center", "text-shadow: 0 1px 2px #000000"]) {
    assert.ok((saved().style ?? "").includes(part), `saved draft has ${part} — got ${saved().style}`);
  }
  assert.doesNotMatch(saved().style ?? "", /cursor/, "a refused declaration is not saved");
  assert.ok((saved().style ?? "").includes("font-size: 64px") && !(saved().style ?? "").includes("font-size: 40px"), "a reset puts back the value the page had, not nothing");

  /* ------------------------------------------------------- Interactions */
  await inspector().getByRole("tab", { name: "Interactions" }).click();
  await inspector().getByRole("button", { name: "Create an interaction" }).first().click();
  await inspector().getByText("On page load: Fade In", { exact: true }).waitFor();
  assert.match(await computed("animation-name"), /^dw-enter-fade\b/, "an entrance animates the element on the page");
  await inspector().getByLabel("Trigger", { exact: true }).selectOption("hover");
  await inspector().getByText("On hover: Fade In", { exact: true }).waitFor();
  assert.doesNotMatch(await computed("animation-name"), /dw-enter-fade/, "a hover interaction does nothing at rest");
  await heading().hover();
  await page.waitForTimeout(100);
  assert.match(await computed("animation-name"), /dw-enter-fade/, "and plays while the pointer is over it");
  await page.mouse.move(5, 5);
  await inspector().getByLabel("Effect", { exact: true }).selectOption("slide");
  await inspector().getByRole("radio", { name: "From left" }).click();
  await inspector().getByRole("radio", { name: "Interaction tabs" }).first().waitFor({ state: "detached" }).catch(() => {});
  await inspector().getByRole("radio", { name: "Settings" }).click();
  await inspector().getByRole("button", { name: "Mobile portrait" }).click();
  await save();
  const motion = saved().style ?? "";
  assert.ok(motion.includes("--dw-onhover: dw-fx-slide-left"), `the hover slot holds the slide — got ${motion}`);
  assert.ok(motion.includes("--dw-onhover-no-m: 1"), "switching phones off is written");
  assert.doesNotMatch(motion, /--dw-enter/, "moving the interaction to another trigger empties the old slot");
  await inspector().getByRole("button", { name: "Remove interaction" }).click();
  await save();
  assert.doesNotMatch(saved().style ?? "", /--dw-onhover/, "removing an interaction removes all of it");

  /* ------------------------------------- other elements, the same tabs */
  // A button: its words are Content; where it goes is Settings → Link.
  await select("hero.cta");
  await inspector().getByRole("tab", { name: "General" }).click();
  assert.deepEqual(await inspector().getByRole("tab").allTextContents(), ["General", "Style", "Interactions"], "a button has the same three tabs");
  const content = inspector().locator('[data-section="content"]');
  const settings = inspector().locator('[data-section="settings"]');
  await content.getByText("Button text", { exact: true }).waitFor();
  assert.equal(await content.getByLabel("Where it goes").count(), 0, "the destination is not in Content");
  assert.equal(await settings.getByLabel("Where it goes").inputValue(), "/contact", "it is under Settings, as Link");
  await settings.getByLabel("Where it goes").fill("/pricing");
  await settings.getByText("Open in a new tab").click();
  await save();
  assert.equal(document.draft.values["hero.cta"]?.href, "/pricing", "a new destination is saved");
  assert.equal(document.draft.values["hero.cta"]?.newTab, true, "and so is the new tab");
  // WhatsApp is how most of these businesses are reached: one chip starts the
  // address, and a number typed the way people write it becomes the digits a
  // wa.me link needs.
  await settings.getByRole("button", { name: "WhatsApp", exact: true }).click();
  // The chip puts the caret after the prefix; type there, as a person would.
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Where it goes" && document.activeElement.selectionStart === document.activeElement.value.length);
  await page.keyboard.type("+233 20 123 4567");
  await settings.getByLabel("Where it goes").blur();
  assert.equal(await settings.getByLabel("Where it goes").inputValue(), "https://wa.me/233201234567", "a WhatsApp number is tidied to digits");
  await save();
  assert.equal(document.draft.values["hero.cta"]?.href, "https://wa.me/233201234567", "and saved as the link");

  // A container: nothing of its own to type, the elements inside it listed.
  await select("hero.box");
  await content.getByText("Elements inside (1)", { exact: true }).waitFor();
  await inspector().getByRole("tab", { name: "Style" }).click();
  assert.equal(await inspector().locator('[data-section="layout"]').evaluate((details) => details.open), true, "a container opens on Layout");
  assert.deepEqual(await inspector().getByRole("tab").allTextContents(), ["General", "Style", "Interactions"]);

  // A video: its playback settings are its Content, each one an attribute.
  // They are gathered and sent once: every send reloads the page beside the
  // panel and counts as an edit against the plan's allowance.
  await select("hero.video");
  await inspector().getByRole("tab", { name: "General" }).click();
  await content.getByText("Autoplay", { exact: true }).waitFor();
  const sent = structureCalls.length;
  await content.getByText("Autoplay", { exact: true }).click();
  await content.getByText("Player controls", { exact: true }).click();
  await content.getByLabel("Video file").fill("javascript:alert(1)");
  await content.getByRole("alert").waitFor();
  await content.getByLabel("Video file").press("Enter");
  await content.getByLabel("Video file").fill("/media/new.mp4");
  await content.getByLabel("Video file").press("Enter");
  await content.getByLabel("Start time").fill("5");
  await content.getByLabel("Start time").press("Enter");
  assert.equal(structureCalls.length, sent, "nothing is sent while the switches are being set");
  await content.getByRole("button", { name: "Apply 4 changes", exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(structureCalls.length, sent + 1, "the whole set is one request");
  assert.equal(structureCalls.at(-1)?.fieldId, "hero.video");
  assert.deepEqual(
    structureCalls.at(-1)?.settings,
    { attributes: { autoplay: "", muted: "", controls: null, src: "/media/new.mp4#t=5" } },
    "autoplay goes with muted (a browser will not start it otherwise), controls come off whole, a script address is never sent, and a start time is a media fragment",
  );

  await mkdir("checks/artifacts", { recursive: true });
  await page.screenshot({ path: "checks/artifacts/inspector-tabs.png" });
  assert.deepEqual(errors, []);
  console.log("inspectorTabs: the same three tabs on a heading, a button, a container and a video; settings sent as structure changes with refusals said; visibility per screen; every Style section changing the computed page; reset by dot; custom CSS refusals; interactions animating at rest and on hover; a button's link under Settings; video playback as attributes passed.");
} finally {
  await browser.close();
}
