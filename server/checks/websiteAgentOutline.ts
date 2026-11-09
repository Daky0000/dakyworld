/**
 * What the Builder agent's model is shown of a page. No database, no network.
 *
 * It was the first 220 fields as JSON: on the DakyX homepage, 343 fields,
 * so the bottom third — the footer among it — was invisible, and the list
 * alone was 34,700 characters. The outline shows every element once, nested,
 * in less. These hold that: every field is on a line of its own, a section's
 * container says which section it is, the selected element and its
 * containers keep their styles, a long page keeps its selection when it is
 * cut, and the whole homepage costs less than the old list of two thirds of it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SitePage } from "@prisma/client";
import { discoverFields, structureControls } from "../src/services/website/index.js";
import { expandGroupChanges, mentionedPages, pageFacts, pageList, pageOutline, selectedDetails } from "../src/services/websiteAgentOutline.js";

const page = `<!doctype html><html><head><title>Kumasi Bakery — fresh bread every morning in Kumasi, Ashanti Region, Ghana</title></head><body>
<header><a href="/"><img src="/logo.png" alt="Kumasi Bakery"></a><nav><a href="/menu">Menu</a><a href="#">Order</a></nav></header>
<main>
  <section id="hero"><div class="wrap"><h1>Fresh bread every morning</h1><p style="color: #5b6374">Baked in Kumasi since 1998.</p><a class="btn btn-primary" href="/order">Order now</a></div></section>
  <section id="pricing"><h2>Our prices</h2><div class="cards"><div class="card"><h3>Loaf</h3><p>[Price]</p></div><div class="card"><h3>Cake</h3><p>From GHS 120</p></div></div></section>
  <section id="gallery"><h2>The oven</h2><img src="/uploads/oven.jpg"><h1>Second main heading</h1></section>
</main>
<footer><p>© 2026 Kumasi Bakery</p></footer>
</body></html>`;
const { fields, sections } = discoverFields(page);
const controls = structureControls(page);
const loaf = fields.find((field) => field.preview === "Loaf")!;
const outline = pageOutline({ fields, sections, controls, selectedId: loaf.id });
const lines = outline.text.split("\n");

// Every element once, by id, at the start of its own line.
for (const field of fields) {
  const at = lines.filter((line) => line.trimStart().startsWith(`${field.id} `));
  assert.equal(at.length, 1, `${field.id} (${field.label}) appears ${at.length} times`);
}
assert.equal(outline.shown, fields.length);
assert.equal(outline.total, fields.length);

// Nesting is indentation: the loaf card's heading is deeper than the pricing section.
const depth = (id: string) => lines.find((line) => line.trimStart().startsWith(`${id} `))!.search(/\S/);
const pricingHeading = fields.find((field) => field.preview === "Our prices")!;
assert.ok(depth(loaf.id) > depth(pricingHeading.id), "a card's heading sits inside its section");
assert.ok(lines.some((line) => /§"Our prices"/.test(line) && /\bsection\b/.test(line)), "the pricing section's container carries its heading");
assert.match(lines.find((line) => line.includes(loaf.id))!, /◀ selected$/, "the selection is marked");
assert.ok(lines.some((line) => /→\/order/.test(line) && /variant=btn-primary/.test(line)), "a button says where it goes and which style it wears");
assert.ok(lines.some((line) => /alt=missing/.test(line)), "a picture with no description says so");

// Locks are said once, in a legend, and referred to.
const locked = pageOutline({ fields, sections, controls, locks: { writable: new Set(fields.filter((field) => field.preview !== "© 2026 Kumasi Bakery").map((field) => field.id)), notes: new Map([[fields.find((field) => field.preview === "© 2026 Kumasi Bakery")!.id, "Your theme writes this footer. Change it in WordPress."]]) } });
assert.deepEqual(locked.legend, ["Your theme writes this footer. Change it in WordPress."]);
assert.ok(locked.text.split("\n").some((line) => line.includes("© 2026") && line.includes("[locked L1]")));

// Cut to fit, the deepest lines go first — and the selection and its containers stay.
const cut = pageOutline({ fields, sections, controls, selectedId: loaf.id, maxLines: 12 });
assert.ok(cut.shown <= 12 + 6, `cut to ${cut.shown}`);
assert.ok(cut.text.includes(`${loaf.id} `), "the selected element survives the cut");
assert.match(cut.text, /\(\+\d+ more inside\)/, "a container says what it holds that was left out");

// The selected element in full.
assert.deepEqual(Object.keys(selectedDetails(loaf)!).slice(0, 4), ["id", "kind", "tag", "label"]);

// Facts a model would miscount.
const facts = pageFacts(fields).join("\n");
assert.match(facts, /1 picture has no description/);
assert.match(facts, /2 main headings/);
assert.match(facts, /1 link goes nowhere/);
assert.match(facts, /browser title \(meta\.0\) is \d+ characters/);
assert.match(facts, /no search description/);
assert.match(facts, /placeholder words such as \[Customer name\]/);
const orderNow = fields.find((field) => field.preview === "Order now")!;
assert.match(facts, new RegExp(`The page has 1 button: ${orderNow.id.replace(/\./g, "\\.")}\\.`), "the btn link is counted as a button");

// Every button id is handed over, so "all buttons" needs no searching.
// Webflow, Elementor and a site's own "cta" count; a plain link does not.
const oneClass = discoverFields(`<!doctype html><html><head><title>t</title></head><body><main>
<a class="button w-button" href="/a">Book a call</a><a class="elementor-button" href="/b">Get a quote</a><a class="hero-cta" href="/c">Start</a><a href="/d">About us</a>
</main></body></html>`);
const oneClassFacts = pageFacts(oneClass.fields).join("\n");
const buttonIds = oneClass.fields.filter((field) => field.kind === "button").map((field) => field.id);
assert.equal(buttonIds.length, 3);
assert.ok(oneClassFacts.includes(`The page has 3 buttons: ${buttonIds.join(", ")}.`), oneClassFacts);

// "Make all buttons gold" is one change, and code finds every button (9 Nov
// 2026: a small model asked twice what a button was and changed nothing).
const gold = { fieldId: "all:button", operation: "set_style", property: "background-color", value: "#DAA563", reason: "" };
const all = expandGroupChanges([gold], oneClass.fields);
assert.deepEqual(all.changes.map((change) => change.fieldId), buttonIds, "one change per button, in page order");
assert.ok(all.changes.every((change) => change.value === "#DAA563" && change.property === "background-color"));
assert.equal(all.empty.length, 0);
assert.ok(!all.changes.some((change) => change.fieldId === oneClass.fields.find((field) => field.preview === "About us")!.id), "a plain link is not a button");

// A named change for the same property overrides the group; another property does not.
const green = { ...gold, fieldId: buttonIds[0], value: "#00AA00" };
const words = { fieldId: buttonIds[0], operation: "replace_text", property: "", value: "Book now", reason: "" };
const mixed = expandGroupChanges([gold, green, words], oneClass.fields).changes;
assert.equal(mixed.filter((change) => change.fieldId === buttonIds[0] && change.operation === "set_style").length, 1, "the first button is green once, not gold and green");
assert.equal(mixed.find((change) => change.fieldId === buttonIds[0] && change.operation === "set_style")!.value, "#00AA00");
assert.ok(mixed.some((change) => change.fieldId === buttonIds[0] && change.operation === "replace_text"), "and still gets its new words");

// The other groups, and a group with nothing in it.
assert.equal(expandGroupChanges([{ ...gold, fieldId: "ALL:LINK" }], oneClass.fields).changes.length, 1, "case does not matter; only the plain link");
assert.deepEqual(expandGroupChanges([{ ...gold, fieldId: "all:image" }], oneClass.fields), { changes: [], empty: ["this page has no pictures to change"] });
assert.ok(expandGroupChanges([{ ...gold, fieldId: "all:heading" }], fields).changes.length >= 4, "the bakery's headings");
assert.ok(!expandGroupChanges([{ ...gold, fieldId: "all:text" }], fields).changes.some((change) => change.fieldId.startsWith("meta.")), "the browser title is never a paragraph");

// Pages named in the request, besides the open one.
const sitePages = [
  { id: "home", title: "Home", path: "/", status: "LIVE" },
  { id: "about", title: "About", path: "/about", status: "LIVE" },
  { id: "menu", title: "Our menu", path: "/menu", status: "LIVE" },
  { id: "old", title: "Old offers", path: "/old", status: "HIDDEN" },
] as SitePage[];
assert.deepEqual(mentionedPages("On the About page, make the heading match", sitePages, "home").map((entry) => entry.id), ["about"]);
assert.deepEqual(mentionedPages("copy the price from /menu", sitePages, "home").map((entry) => entry.id), ["menu"]);
assert.deepEqual(mentionedPages("tell me about your about section", sitePages, "home").map((entry) => entry.id), [], "the word alone is not the page");
assert.deepEqual(mentionedPages("put the phone number on the about section", sitePages, "home"), [], "a section of this page is not the page of that name");
assert.deepEqual(mentionedPages("update the old offers page", sitePages, "home"), [], "a hidden page is not offered");
assert.deepEqual(mentionedPages("on the home page, add a button", sitePages, "home"), [], "the open page is already there");
const listed = pageList(Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, title: `Page ${index}`, path: `/page-${index}`, status: "LIVE" }) as SitePage), [], 30);
assert.equal(listed.list.length, 30);
assert.equal(listed.more, 10);

// The DakyX homepage: every element, in less than the old list of the first 220.
const home = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const homeFields = discoverFields(home);
const homeOutline = pageOutline({ fields: homeFields.fields, sections: homeFields.sections, controls: structureControls(home) });
const oldList = JSON.stringify(homeFields.fields.slice(0, 220).map((f) => ({ id: f.id, label: f.label, kind: f.kind, tag: f.tag, value: (f.value ?? "").slice(0, 120), ...(f.href !== undefined ? { href: f.href } : {}), ...(f.style ? { style: f.style } : {}) })));
assert.equal(homeOutline.shown, homeFields.fields.length, "every element of the homepage");
assert.ok(homeOutline.text.length < oldList.length * 0.6, `outline ${homeOutline.text.length} characters, old list ${oldList.length}`);

console.log(`websiteAgentOutline: every element once and nested, sections named, the selection kept through a cut, facts counted; the DakyX homepage's ${homeOutline.shown} elements in ${homeOutline.text.length.toLocaleString("en-GB")} characters against ${oldList.length.toLocaleString("en-GB")} for the old first 220 — passed`);
