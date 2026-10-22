/**
 * Elementor pages through the existing editor: strings in, Elementor's data out.
 *
 *   npx tsx checks/websiteElementor.ts
 *
 * No database and no network. The HTML below is the shape Elementor 4.3.5
 * renders (taken from a real local install), and the trees are what it saves.
 * Every edit goes through `applyElementorEdits` exactly as a publish does, and
 * half of what is asserted is what must *not* change: the rest of the tree,
 * byte for byte, and every refusal leaving the trees as they were.
 */
import assert from "node:assert/strict";
import { applyElementorEdits, discoverFields, elementorDocumentIds, elementorFieldMap, type ElementorDocuments, type ElementorNode } from "../src/services/website/index.js";
import { DOCUMENT_KEY, restoreDocument } from "../src/services/website/document.js";
import { changeStructure } from "../src/services/website/structure.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n").slice(0, process.env.VERBOSE ? 40 : 1).join("\n      ")}`); }
}

const PAGE = 26;
const HEADER = 40;
const html = `<!doctype html><html><head><title>Bakery</title></head><body>
<header data-elementor-type="header" data-elementor-id="${HEADER}" class="elementor elementor-${HEADER}">
  <div class="elementor-element elementor-element-hdr0001 e-con" data-id="hdr0001" data-element_type="container">
    <div class="elementor-element elementor-element-hdrtxt1 elementor-widget elementor-widget-heading" data-id="hdrtxt1" data-element_type="widget" data-widget_type="heading.default"><h2 class="elementor-heading-title">Kumasi Bakery</h2></div>
  </div>
</header>
<div data-elementor-type="wp-page" data-elementor-id="${PAGE}" class="elementor elementor-${PAGE}">
  <div class="elementor-element elementor-element-con0001 e-con e-parent" data-id="con0001" data-element_type="container">
    <div class="elementor-element elementor-element-hd30002 elementor-widget elementor-widget-heading" data-id="hd30002" data-element_type="widget" data-widget_type="heading.default"><h2 class="elementor-heading-title elementor-size-default">Fresh bread daily</h2></div>
    <div class="elementor-element elementor-element-tx30001 elementor-widget elementor-widget-text-editor" data-id="tx30001" data-element_type="widget" data-widget_type="text-editor.default"><p>We bake every morning in Kumasi.</p></div>
    <div class="elementor-element elementor-element-bt30001 elementor-widget elementor-widget-button" data-id="bt30001" data-element_type="widget" data-widget_type="button.default"><a class="elementor-button elementor-button-link" href="https://bakery.test/order"><span class="elementor-button-content-wrapper"><span class="elementor-button-text">Order now</span></span></a></div>
    <div class="elementor-element elementor-element-im30001 elementor-widget elementor-widget-image" data-id="im30001" data-element_type="widget" data-widget_type="image.default"><img src="https://bakery.test/wp-content/uploads/oven-300x200.png" alt="" class="attachment-medium size-medium wp-image-16"></div>
    <div class="elementor-element elementor-element-dyn0001 elementor-widget elementor-widget-heading" data-id="dyn0001" data-element_type="widget" data-widget_type="heading.default"><h2 class="elementor-heading-title">Bakery</h2></div>
  </div>
  <div class="elementor-element elementor-element-con0002 e-con e-parent" data-id="con0002" data-element_type="container">
    <div class="elementor-element elementor-element-hd30003 elementor-widget elementor-widget-heading" data-id="hd30003" data-element_type="widget" data-widget_type="heading.default"><h2 class="elementor-heading-title">Second container</h2></div>
    <div class="elementor-element elementor-element-ic30001 elementor-view-default elementor-widget elementor-widget-icon" data-id="ic30001" data-element_type="widget" data-widget_type="icon.default"><div class="elementor-icon-wrapper"><a class="elementor-icon" href="https://bakery.test/"><svg aria-hidden="true" class="e-font-icon-svg e-fas-star" viewBox="0 0 576 512"><path d="M259.3 17.8"></path></svg></a></div></div>
  </div>
  <div class="elementor-element elementor-element-fb40001 e-con e-atomic-element e-flexbox-base" data-id="fb40001" data-element_type="e-flexbox">
    <h2 data-interaction-id="hd40001" class="e-heading-base e-default-h2">Atomic heading</h2>
    <p class="e-paragraph-base" data-interaction-id="pa40001">Atomic paragraph text.</p>
    <button class="e-button-base" data-interaction-id="bt40001">Atomic button</button>
  </div>
</div>
<footer class="site-footer"><p>© 2026 Theme footer</p></footer>
</body></html>`;

const s = (value: string) => ({ $$type: "string", value });
const h = (value: string) => ({ $$type: "escaped-html", value });
const pageTree = (): ElementorNode[] => [
  { id: "con0001", elType: "container", settings: [], elements: [
    { id: "hd30002", elType: "widget", widgetType: "heading", settings: { title: "Fresh bread daily" }, elements: [] },
    { id: "tx30001", elType: "widget", widgetType: "text-editor", settings: { editor: "<p>We bake every morning in Kumasi.</p>" }, elements: [] },
    { id: "bt30001", elType: "widget", widgetType: "button", settings: { text: "Order now", link: { url: "https://bakery.test/order", is_external: "", nofollow: "" }, __globals__: { background_color: "globals/colors?id=primary" } }, elements: [] },
    { id: "im30001", elType: "widget", widgetType: "image", settings: { image: { url: "https://bakery.test/wp-content/uploads/oven.png", id: 16 }, image_size: "medium" }, elements: [] },
    { id: "dyn0001", elType: "widget", widgetType: "heading", settings: { title: "Bakery", __dynamic__: { title: "[elementor-tag id=\"1\" name=\"site-title\"]" } }, elements: [] },
  ] },
  { id: "con0002", elType: "container", settings: [], elements: [
    { id: "hd30003", elType: "widget", widgetType: "heading", settings: { title: "Second container" }, elements: [] },
    { id: "ic30001", elType: "widget", widgetType: "icon", settings: { selected_icon: { value: "fas fa-star", library: "fa-solid" }, link: { url: "https://bakery.test/" } }, elements: [] },
  ] },
  { id: "fb40001", elType: "e-flexbox", settings: [], elements: [
    { id: "hd40001", elType: "widget", widgetType: "e-heading", settings: { title: h("Atomic heading"), tag: s("h2") }, elements: [] },
    { id: "pa40001", elType: "widget", widgetType: "e-paragraph", settings: { paragraph: h("Atomic paragraph text.") }, elements: [] },
    { id: "bt40001", elType: "widget", widgetType: "e-button", settings: { text: h("Atomic button") }, elements: [] },
  ] },
];
const headerTree = (): ElementorNode[] => [
  { id: "hdr0001", elType: "container", settings: [], elements: [
    { id: "hdrtxt1", elType: "widget", widgetType: "heading", settings: { title: "Kumasi Bakery" }, elements: [] },
  ] },
];
const documents = (withHeader = true): ElementorDocuments => new Map([
  [PAGE, { postId: PAGE, kind: "page" as const, title: "Home", data: pageTree() }],
  ...(withHeader ? [[HEADER, { postId: HEADER, kind: "template" as const, title: "Header", data: headerTree() }] as const] : []),
]);
const fields = discoverFields(html).fields;
const field = (preview: string) => {
  const found = fields.find((entry) => !entry.id.startsWith("meta.") && entry.preview.trim() === preview);
  assert.ok(found, `no field reads "${preview}"`);
  return found;
};
/** The field whose own opening tag carries this Elementor id — a container, or a V4 widget. */
const fieldFor = (source: string, id: string) => {
  const found = discoverFields(source).fields.find((entry) => {
    if (entry.attrInsert === undefined) return false;
    const open = source.slice(source.lastIndexOf("<", entry.attrInsert), source.indexOf(">", entry.attrInsert));
    return open.includes(`data-id="${id}"`) || open.includes(`data-interaction-id="${id}"`);
  });
  assert.ok(found, `no field for ${id}`);
  return found;
};
const image = () => fields.find((entry) => entry.kind === "image")!;
const node = (tree: ElementorNode[], id: string): ElementorNode => {
  for (const entry of tree) {
    if (entry.id === id) return entry;
    const inner = entry.elements?.length ? (() => { try { return node(entry.elements!, id); } catch { return null; } })() : null;
    if (inner) return inner;
  }
  throw new Error(`no node ${id}`);
};
const apply = (values: Record<string, unknown>, docs = documents()) => applyElementorEdits({ html, documents: docs, values: values as never });
const pageData = (result: ReturnType<typeof apply>) => result.documents.get(PAGE)!.data;

console.log("\nWhat is editable");

check("the page renders its own tree and a header template, and both are found", () => {
  assert.deepEqual(elementorDocumentIds(html).documents.sort(), [PAGE, HEADER].sort());
});

check("words in V3 and V4 widgets are editable; the theme, a dynamic tag and an unreadable template are not", () => {
  const map = elementorFieldMap({ html, documents: documents() });
  for (const words of ["Fresh bread daily", "We bake every morning in Kumasi.", "Order now", "Atomic heading", "Atomic paragraph text.", "Atomic button", "Kumasi Bakery"]) {
    assert.ok(map.writable.has(field(words).id), `"${words}" should be writable`);
  }
  assert.ok(map.writable.has(image().id), "the picture (shown at a smaller size) should be writable");
  assert.match(map.notes.get(field("Bakery").id) ?? "", /dynamic tag/);
  assert.match(map.notes.get(field("© 2026 Theme footer").id) ?? "", /part of the theme/);
  const withoutHeader = elementorFieldMap({ html, documents: documents(false) });
  assert.match(withoutHeader.notes.get(field("Kumasi Bakery").id) ?? "", /Administrator/);
});

console.log("\nWriting");

check("V3 words, a button's words through its spans, and a link land in their own settings and nowhere else", () => {
  const button = field("Order now");
  const result = apply({
    [field("Fresh bread daily").id]: { value: "Fresh bread every day", original: "Fresh bread daily" },
    [field("We bake every morning in Kumasi.").id]: { value: "We bake <strong>every</strong> morning.", original: "We bake every morning in Kumasi." },
    [button.id]: { value: button.value.replace("Order now", "Order today"), original: button.value, href: "https://bakery.test/cakes", originalHref: "https://bakery.test/order" },
  });
  assert.deepEqual([result.unmappable, result.problems], [[], []]);
  const data = pageData(result);
  assert.equal((node(data, "hd30002").settings as Record<string, unknown>).title, "Fresh bread every day");
  assert.equal((node(data, "tx30001").settings as Record<string, unknown>).editor, "<p>We bake <strong>every</strong> morning.</p>");
  const buttonSettings = node(data, "bt30001").settings as Record<string, any>;
  assert.equal(buttonSettings.text, "Order today");
  assert.equal(buttonSettings.link.url, "https://bakery.test/cakes");
  assert.deepEqual(result.changedDocuments, [PAGE]);
  // Everything else is exactly what was read.
  assert.deepEqual(node(data, "con0002"), pageTree()[1]);
  assert.deepEqual(node(data, "fb40001"), pageTree()[2]);
});

check("V4 words are written inside their typed value", () => {
  const result = apply({ [field("Atomic heading").id]: { value: "Atomic, edited", original: "Atomic heading" } });
  assert.deepEqual((node(pageData(result), "hd40001").settings as Record<string, unknown>).title, h("Atomic, edited"));
  assert.deepEqual((node(pageData(result), "hd40001").settings as Record<string, unknown>).tag, s("h2"));
});

check("a header template's words go to the template, not the page", () => {
  const result = apply({ [field("Kumasi Bakery").id]: { value: "Kumasi Bakery & Café", original: "Kumasi Bakery" } });
  assert.deepEqual(result.changedDocuments, [HEADER]);
  assert.equal((node(result.documents.get(HEADER)!.data, "hdrtxt1").settings as Record<string, unknown>).title, "Kumasi Bakery & Café");
  assert.deepEqual(pageData(result), pageTree());
});

check("a new picture replaces the stored file and its attachment id, not the resized copy's address", () => {
  const picture = image();
  const result = applyElementorEdits({ html, documents: documents(), values: { [picture.id]: { value: "assets/dw/new.png", original: picture.value } }, media: new Map([["assets/dw/new.png", { id: 99, url: "https://bakery.test/wp-content/uploads/new.png" }]]) });
  assert.deepEqual((node(pageData(result), "im30001").settings as Record<string, unknown>).image, { url: "https://bakery.test/wp-content/uploads/new.png", id: 99 });
});

check("V3 styling: typography, colour, a tablet size and a hover colour go to the widget's own settings; a global colour is unlinked", () => {
  const heading = field("Fresh bread daily");
  const button = field("Order now");
  const result = apply({
    [heading.id]: { style: "color: #b32d2e; font-size: 40px", originalStyle: "", responsive: { tablet: "font-size: 28px" }, originalResponsive: {} },
    [button.id]: { style: "background-color: #1d6b41; --dw-hover-background-color: #0f3d25", originalStyle: "" },
  });
  assert.deepEqual([result.unmappable, result.problems], [[], []]);
  const headingSettings = node(pageData(result), "hd30002").settings as Record<string, unknown>;
  assert.equal(headingSettings.title_color, "#b32d2e");
  assert.deepEqual(headingSettings.typography_font_size, { unit: "px", size: 40, sizes: [] });
  assert.deepEqual(headingSettings.typography_font_size_tablet, { unit: "px", size: 28, sizes: [] });
  assert.equal(headingSettings.typography_typography, "custom");
  const buttonSettings = node(pageData(result), "bt30001").settings as Record<string, any>;
  assert.equal(buttonSettings.background_color, "#1d6b41");
  assert.equal(buttonSettings.button_background_hover_color, "#0f3d25");
  assert.equal(buttonSettings.__globals__.background_color, undefined, "a value set here must stop following the global colour");
});

check("a container's box styling and an https background image go to its own settings, per screen size", () => {
  const container = fieldFor(html, "con0001");
  assert.ok(container, "the first container's field");
  const result = apply({ [container.id]: { style: "padding: 24px; background-color: #eaf6ef; background-image: url(https://bakery.test/bg.png)", originalStyle: "", responsive: { mobile: "padding: 8px" }, originalResponsive: {} } });
  const settings = node(pageData(result), "con0001").settings as Record<string, any>;
  assert.equal(settings.padding.top, "24");
  assert.equal(settings.padding_mobile.top, "8");
  assert.equal(settings.background_color, "#eaf6ef");
  assert.equal(settings.background_image.url, "https://bakery.test/bg.png");
  assert.equal(settings.background_background, "classic");
  const picked = applyElementorEdits({ html, documents: documents(), values: { [container.id]: { style: "background-image: url('/assets/dw/bg.png')", originalStyle: "" } }, media: new Map([["/assets/dw/bg.png", { id: 7, url: "https://bakery.test/wp-content/uploads/bg.png" }]]) });
  assert.equal((node(pageData(picked), "con0001").settings as Record<string, any>).background_image.url, "https://bakery.test/wp-content/uploads/bg.png", "a picture from the site's assets is stored as its WordPress copy");
});

check("pressed (active) and focus styling: V4 keeps them as state variants; classic Elementor has no place and says so", () => {
  const v4 = apply({ [field("Atomic button").id]: { style: "--dw-active-background-color: #0f3d25; --dw-focus-box-shadow: 0 0 0 3px #3157ff", originalStyle: "" } });
  const button = node(pageData(v4), "bt40001");
  const local = Object.values(button.styles as Record<string, any>)[0];
  assert.ok(local, JSON.stringify([v4.unmappable, v4.problems]));
  const states = local.variants.map((entry: any) => entry.meta.state).sort();
  assert.deepEqual(states, ["active", "focus"]);
  assert.deepEqual([v4.unmappable, v4.problems], [[], []]);
  const classic = apply({ [field("Order now").id]: { style: "--dw-active-background-color: #0f3d25", originalStyle: "" } });
  assert.match(classic.unmappable.map((entry) => entry.message).join(" "), /pressed \(active\)/);
});

check("a gradient, a gradient over a picture (Elementor's overlay) and a background video map onto a container's own settings", () => {
  const container = fieldFor(html, "con0001");
  const gradient = apply({ [container.id]: { style: "background-image: linear-gradient(135deg, #1d6b41 10%, rgba(0, 0, 0, 0.5) 90%)", originalStyle: "" } });
  assert.deepEqual([gradient.unmappable, gradient.problems], [[], []]);
  const settings = node(pageData(gradient), "con0001").settings as Record<string, any>;
  assert.equal(settings.background_background, "gradient");
  assert.equal(settings.background_color, "#1d6b41");
  assert.equal(settings.background_color_b, "rgba(0, 0, 0, 0.5)");
  assert.deepEqual(settings.background_color_stop, { unit: "%", size: 10, sizes: [] });
  assert.deepEqual(settings.background_gradient_angle, { unit: "deg", size: 135, sizes: [] });

  const overlay = apply({ [container.id]: { style: "background-image: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent), url('https://bakery.test/bg.png')", originalStyle: "" } });
  assert.deepEqual([overlay.unmappable, overlay.problems], [[], []]);
  const layered = node(pageData(overlay), "con0001").settings as Record<string, any>;
  assert.equal(layered.background_image.url, "https://bakery.test/bg.png");
  assert.equal(layered.background_overlay_background, "gradient");
  assert.equal(layered.background_overlay_color, "rgba(0,0,0,0.6)");
  assert.equal(layered.background_overlay_color_b, "transparent");

  const video = applyElementorEdits({ html, documents: documents(), values: { [container.id]: { style: "--dw-bg-video: /assets/dw/loop.mp4", originalStyle: "" } }, media: new Map([["/assets/dw/loop.mp4", { id: 8, url: "https://bakery.test/wp-content/uploads/loop.mp4" }]]) });
  assert.deepEqual([video.unmappable, video.problems], [[], []]);
  const played = node(pageData(video), "con0001").settings as Record<string, any>;
  assert.equal(played.background_background, "video");
  assert.equal(played.background_video_link, "https://bakery.test/wp-content/uploads/loop.mp4");
});

check("a background Elementor has no place for is refused whole: three stops, an overlay on a widget, a video on a widget", () => {
  const container = fieldFor(html, "con0001");
  const heading = field("Fresh bread daily");
  for (const [id, style] of [
    [container.id, "background-image: linear-gradient(90deg, red, white, blue)"],
    [heading.id, "background-image: linear-gradient(red, blue), url('https://bakery.test/bg.png')"],
    [heading.id, "--dw-bg-video: https://bakery.test/loop.mp4"],
    [container.id, "--dw-bg-video: http://bakery.test/loop.mp4"],
  ] as const) {
    const result = apply({ [id]: { style, originalStyle: "" } });
    assert.ok(result.unmappable.length + result.problems.length > 0, style);
    // Read and refused, an element's empty settings may come back `{}` rather than `[]`; nothing else.
    assert.equal(JSON.stringify(pageData(result)).replaceAll('"settings":{}', '"settings":[]'), JSON.stringify(pageTree()), `nothing written for ${style}`);
  }
});

check("V4 styling becomes typed props on the element's own style, per screen size and on hover", () => {
  const result = apply({ [field("Atomic heading").id]: { style: "color: #7a4e06; padding: 4px 8px; --dw-hover-color: #c8871b", originalStyle: "", responsive: { mobile: "font-size: 22px" }, originalResponsive: {} } });
  assert.deepEqual([result.unmappable, result.problems], [[], []]);
  const heading = node(pageData(result), "hd40001");
  const classes = (heading.settings as Record<string, any>).classes.value as string[];
  const style = (heading.styles as Record<string, any>)[classes[0]!];
  const variant = (breakpoint: string, state: string | null) => style.variants.find((entry: any) => entry.meta.breakpoint === breakpoint && entry.meta.state === state).props;
  assert.deepEqual(variant("desktop", null).color, { $$type: "color", value: "#7a4e06" });
  assert.equal(variant("desktop", null).padding.$$type, "dimensions");
  assert.deepEqual(variant("desktop", "hover").color, { $$type: "color", value: "#c8871b" });
  assert.deepEqual(variant("mobile", null)["font-size"], { $$type: "size", value: { size: 22, unit: "px" } });
});

console.log("\nLayout");

check("delete, duplicate and move made with the layout buttons are replayed on the tree by id", () => {
  let values: Record<string, any> = {};
  const fieldIn = (source: string, id: string) => fieldFor(source, id).id;
  const current = () => (values[DOCUMENT_KEY]?.document?.html as string | undefined) ?? html;
  values = changeStructure(html, values, { kind: "remove", fieldId: fieldIn(current(), "con0002"), force: true }).values;
  values = changeStructure(html, values, { kind: "duplicate", fieldId: fieldIn(current(), "tx30001") }).values;
  values = changeStructure(html, values, { kind: "before", fieldId: fieldIn(current(), "im30001"), targetId: fieldIn(current(), "hd30002") }).values;
  const result = apply(values);
  assert.deepEqual([result.unmappable, result.problems], [[], []]);
  const data = pageData(result);
  assert.deepEqual(data.map((entry) => entry.id), ["con0001", "fb40001"]);
  const children = data[0]!.elements!.map((entry) => entry.id);
  assert.equal(children[0], "im30001");
  assert.equal(children.filter((id) => id === "tx30001").length, 1);
  assert.equal(children.length, 6, "the copy is a new element");
  const copy = data[0]!.elements!.find((entry) => !pageTree()[0]!.elements!.some((original) => original.id === entry.id))!;
  assert.deepEqual(copy.settings, { editor: "<p>We bake every morning in Kumasi.</p>" });
});

check("words changed before a layout change are not lost when the layout is published", () => {
  let values: Record<string, any> = { [field("Fresh bread daily").id]: { value: "Fresh bread every day", original: "Fresh bread daily" } };
  const removeId = fieldFor(html, "con0002").id;
  values = changeStructure(html, values, { kind: "remove", fieldId: removeId, force: true }).values;
  assert.deepEqual(Object.keys(values), [DOCUMENT_KEY], "the layout change folds the edit into its snapshot");
  const result = apply(values);
  assert.deepEqual([result.unmappable, result.problems], [[], []]);
  assert.equal((node(pageData(result), "hd30002").settings as Record<string, unknown>).title, "Fresh bread every day");
  assert.ok(!JSON.stringify(pageData(result)).includes("Second container"));
});

check("an icon is not an edit after a layout change (the snapshot's own markers are not differences)", () => {
  const values = changeStructure(html, {}, { kind: "remove", fieldId: fieldFor(html, "fb40001").id, force: true }).values;
  const result = apply(values);
  assert.deepEqual([result.unmappable, result.problems], [[], []]);
  assert.deepEqual(pageData(result).map((entry) => entry.id), ["con0001", "con0002"]);
});

check("deleting a classic widget's heading deletes the widget, not only its words", () => {
  const values = changeStructure(html, {}, { kind: "remove", fieldId: field("Second container").id, force: true }).values;
  const result = apply(values);
  assert.deepEqual([result.unmappable, result.problems], [[], []]);
  assert.deepEqual(node(pageData(result), "con0002").elements!.map((entry) => entry.id), ["ic30001"]);
});

check("a section added from the library is refused, not dropped on publish in silence", () => {
  const added = html.replace(`<div class="elementor-element elementor-element-con0002`, `<section><h2>Opening hours</h2><p>Every day, 6am to 2pm.</p></section>\n  <div class="elementor-element elementor-element-con0002`);
  const result = apply(restoreDocument(html, {}, added, "Added a section"));
  assert.ok(result.unmappable.some((entry) => entry.part === "added"), JSON.stringify(result.unmappable));
  const inside = html.replace(`<h2 class="elementor-heading-title">Second container</h2></div>`, `<h2 class="elementor-heading-title">Second container</h2></div><p>A new paragraph</p>`);
  assert.ok(apply(restoreDocument(html, {}, inside, "Added a paragraph")).unmappable.some((entry) => entry.part === "added"), "inside an existing container too");
});

console.log("\nRefusals change nothing");

check("a dynamic tag's words, a style Elementor has no place for and the theme footer are refused whole", () => {
  for (const values of [
    { [field("Bakery").id]: { value: "Bakers", original: "Bakery" } },
    { [field("Fresh bread daily").id]: { style: "box-shadow: 0 0 4px red", originalStyle: "" } },
    { [field("© 2026 Theme footer").id]: { value: "© 2027", original: "© 2026 Theme footer" } },
  ]) {
    const result = apply(values);
    assert.ok(result.unmappable.length + result.problems.length > 0, JSON.stringify(values).slice(0, 80));
  }
});

check("words that are no longer in the element refuse the publish", () => {
  const result = apply({ [field("Fresh bread daily").id]: { value: "New", original: "Words that were changed in Elementor meanwhile" } });
  assert.equal(result.problems.length, 1);
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed:\n  ${failures.join("\n  ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
