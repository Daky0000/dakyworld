/**
 * The General tab's Settings: a tag from the element's own family, its id, an
 * allowlist of other attributes, and a player's playback attributes — written
 * through the structure path so field identities survive a retag.
 *
 * Half of this is negatives. What matters most about an attribute editor on a
 * public page is what it refuses: script, addresses, classes, the editor's own
 * markers, a second element with the same id, a tag from another family.
 *
 * No database: the structure engine is pure over a page's HTML.
 */
import assert from "node:assert/strict";
import { changeStructure, StructureError } from "../src/services/website/structure.js";
import { DOCUMENT_KEY } from "../src/services/website/document.js";
import { readPage } from "../src/services/website/regions.js";
import { attributeNameProblem, attributeProblem, editableAttributes, readMediaTime, tagOptions, writeMediaTime } from "../src/shared/websiteElementSettings.js";

let checks = 0;
const ok = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  checks += 1;
};

const source = `<!doctype html>
<html lang="en"><head><title>Settings</title></head>
<body>
<header class="top"><nav><a href="/">Home</a></nav></header>
<div class="wrap" title="intro block"><h2 class="lead">Our services</h2><p>We build websites.</p></div>
<section id="contact"><h3>Contact</h3><p>Write to us.</p></section>
<video class="hero-video" src="/media/intro.mp4" controls></video>
<video class="single"><source src="/media/a.mp4" type="video/mp4"></video>
<video class="many" controls><source src="/media/a.webm"><source src="/media/a.mp4"></video>
</body></html>
`;

const fields = readPage(source).fields;
const byTag = (tag: string, nth = 0) => fields.filter((field) => field.tag === tag)[nth]!;
const heading = byTag("h2");
const wrap = fields.find((field) => field.kind === "container" && field.tag === "div")!;
const video = fields.find((field) => field.tag === "video" && field.attributes?.some((attr) => attr.value === "/media/intro.mp4"))!;
const single = fields.find((field) => field.tag === "video" && field.mediaSources === 1)!;
const many = fields.find((field) => field.tag === "video" && field.mediaSources === 2)!;

/** The document a settings change produces, and the fields read back from it. */
const settle = (fieldId: string, settings: Parameters<typeof changeStructure>[2] extends infer A ? A extends { settings: infer S } ? S : never : never, values = {}) => {
  const result = changeStructure(source, values, { kind: "settings", fieldId, settings });
  const html = result.values[DOCUMENT_KEY]!.document!.html;
  return { result, html, fields: readPage(html).fields };
};
const refused = (run: () => unknown, match: RegExp, name: string) => {
  assert.throws(run, (error: unknown) => error instanceof StructureError && match.test(error.message), name);
  checks += 1;
};
/** The page with the editor's identity markers taken out, for byte comparisons. */
const unmarked = (html: string) => html.replace(/ data-dw-node="[^"]*"/g, "");

/* ------------------------------------------------------------ the policy */

ok("a heading's family is the six levels", tagOptions("text", "h2").join() === "h1,h2,h3,h4,h5,h6");
ok("a paragraph may become a span or a div", tagOptions("text", "p").join() === "p,span,div");
ok("a container is offered the semantic boxes", tagOptions("container", "div").includes("section") && tagOptions("container", "div").includes("article"));
ok("main is never offered as a target", !tagOptions("container", "div").includes("main"));
ok("a list keeps its tag", tagOptions("container", "ul").length === 0);
ok("a list item keeps its tag", tagOptions("text", "li").length === 0);
ok("a button keeps its tag", tagOptions("button", "a").length === 0);

for (const [name, why] of [
  ["onclick", /script/], ["onmouseover", /script/], ["style", /Style tab/], ["class", /design system/], ["href", /Link/],
  ["target", /Link/], ["src", /Addresses/], ["srcdoc", /Addresses/], ["formaction", /Addresses/], ["data-dw-field", /editor/],
  ["data-hx-get", /code/], ["data-on-click", /code/], ["x-data", /Only id/], ["contenteditable", /Only id/],
] as const) {
  ok(`${name} is refused: ${why}`, why.test(attributeNameProblem(name, "div") ?? ""));
}
for (const name of ["id", "title", "lang", "dir", "role", "tabindex", "hidden", "aria-label", "aria-hidden", "data-track", "itemprop"]) {
  ok(`${name} is editable`, attributeNameProblem(name, "div") === null);
}
ok("a video's src is its own control, not a free attribute", attributeNameProblem("src", "video") === null && attributeNameProblem("src", "div") !== null);
ok("an id with a space is refused", attributeProblem("id", "two words", "div") !== null);
ok("an id starting with a digit is refused", attributeProblem("id", "1st", "div") !== null);
ok("a script address is refused anywhere", attributeProblem("title", "javascript:alert(1)", "div") !== null);
ok("a data: address is refused anywhere", attributeProblem("data-x", "data:text/html,hi", "div") !== null);
ok("an angle bracket is refused", attributeProblem("aria-label", "<b>", "div") !== null);
ok("a data- value can't hold code-shaped brackets", attributeProblem("data-track", "alert(1)", "div") !== null);
ok("a boolean takes no value", attributeProblem("hidden", "yes", "div") !== null && attributeProblem("hidden", "", "div") === null);
ok("a poster must be https or a site path", attributeProblem("poster", "http://cleartext.example/p.jpg", "video") !== null && attributeProblem("poster", "/assets/p.jpg", "video") === null);
ok("removing an editable attribute is always allowed", attributeProblem("aria-label", null, "div") === null);
ok("only editable attributes are sent to the panel", editableAttributes([{ name: "class", value: "x" }, { name: "id", value: "a" }, { name: "onclick", value: "x()" }], "div").map((attr) => attr.name).join() === "id");
ok("the panel is told about a heading's family", heading.tagOptions?.join() === "h1,h2,h3,h4,h5,h6");
ok("and about the attributes it may change", wrap.attributes?.some((attr) => attr.name === "title" && attr.value === "intro block") && !wrap.attributes?.some((attr) => attr.name === "class"));
ok("a single <source> address is offered as the player's own", single.attributes?.some((attr) => attr.name === "src" && attr.value === "/media/a.mp4"));
const timed = readMediaTime("/media/a.mp4#t=5,20");
ok("a start and end are read off the address", timed.base === "/media/a.mp4" && timed.start === 5 && timed.end === 20);
ok("and written back as a media fragment", writeMediaTime("/media/a.mp4", 3, null) === "/media/a.mp4#t=3" && writeMediaTime("/media/a.mp4#t=3", null, null) === "/media/a.mp4");

/* ------------------------------------------------------------- the tag */

{
  const { html, fields: after, result } = settle(heading.id, { tag: "h3" });
  ok("the heading opens as an h3", unmarked(html).includes('<h3 class="lead"'));
  ok("and closes as one", /Our services<\/h3>/.test(html));
  ok("nothing else in the page changed", unmarked(html) === source.replace('<h2 class="lead">Our services</h2>', '<h3 class="lead">Our services</h3>'));
  const moved = after.find((field) => field.id === heading.id);
  ok("the field keeps its id after the retag", moved?.tag === "h3" && moved.value === "Our services");
  ok("and stays selected", result.selectedId === heading.id);
  ok("the change is listed in words", result.values[DOCUMENT_KEY]!.document!.changes.at(-1)?.includes("tag changed to <h3>"));
}
{
  // A top-level div becoming a section is a new section on the page, which
  // renumbers the positional ids after it. Every field must survive by id.
  const { fields: after } = settle(wrap.id, { tag: "section" });
  for (const field of fields.filter((candidate) => candidate.attrInsert !== undefined && candidate.tag !== "body")) {
    const same = after.find((candidate) => candidate.id === field.id);
    ok(`${field.label} (${field.id}) keeps its id when a div becomes a section`, same && same.value === field.value);
  }
}
refused(() => settle(heading.id, { tag: "section" }), /family/, "a heading can't become a section");
refused(() => settle(byTag("p").id, { tag: "h1" }), /family/, "a paragraph can't become a heading here");
refused(() => settle(heading.id, { tag: "h2" }), /Nothing/, "a tag that is already there changes nothing and says so");

/* ------------------------------------------------------------ attributes */

{
  const { html } = settle(heading.id, { attributes: { id: "services-title" } });
    ok("and only that changed", unmarked(html) === source.replace('<h2 class="lead">', '<h2 id="services-title" class="lead">'));
}
refused(() => settle(heading.id, { attributes: { id: "contact" } }), /already has the ID/, "an id another element has is refused");
refused(() => settle(heading.id, { attributes: { onclick: "steal()" } }), /script/, "an event handler is refused");
refused(() => settle(heading.id, { attributes: { class: "hidden" } }), /design system/, "a class is refused");
refused(() => settle(heading.id, { attributes: { "data-dw-node": "x" } }), /editor/, "the editor's own markers are refused");
refused(() => settle(heading.id, { attributes: { title: "a<script>" } }), /character/, "markup in a value is refused");
{
  const { html } = settle(wrap.id, { attributes: { title: null, "aria-label": "Introduction", "data-track": "intro" } });
  // The title was the first attribute after `class`; taking it away and adding
  // two more must not cut into each other.
  ok("removing one attribute and adding two leaves well-formed markup", unmarked(html).includes('<div class="wrap" aria-label="Introduction" data-track="intro">') || unmarked(html).includes('<div aria-label="Introduction" data-track="intro" class="wrap">'));
  ok("the removed one is gone", !unmarked(html).includes('title="intro block"'));
}
{
  // The first attribute removed while another is inserted at the same offset.
  const { html } = changeStructure(source, {}, { kind: "settings", fieldId: byTag("section").id ?? "", settings: { attributes: { id: null, "aria-label": "Contact" } } }).values[DOCUMENT_KEY]!.document!;
  ok("taking the id away while adding a label leaves well-formed markup", unmarked(html).includes('<section aria-label="Contact">'));
}

/* ----------------------------------------------------------------- video */

{
  const { html, result } = settle(video.id, { attributes: { autoplay: "", muted: "", playsinline: "", controls: null, preload: "metadata", poster: "/assets/poster.jpg" } });
  const hero = /<video[^>]*hero-video[^>]*>/.exec(unmarked(html))?.[0] ?? "";
  ok("playback switches are written bare", / autoplay[ >]/.test(hero) && / muted[ >]/.test(hero) && / playsinline[ >]/.test(hero));
  ok("controls are taken away whole", !/controls/.test(hero));
  ok("preload and poster are written", hero.includes('preload="metadata"') && hero.includes('poster="/assets/poster.jpg"'));
  ok("the change is described as video settings", result.values[DOCUMENT_KEY]!.document!.changes.at(-1)?.includes("video settings changed"));
}
{
  const { html } = settle(single.id, { attributes: { src: "/media/b.mp4#t=2,9" } });
  ok("a single <source> takes the new address", unmarked(html).includes('<source src="/media/b.mp4#t=2,9" type="video/mp4">'));
  ok("and the video element gains no src of its own", unmarked(html).includes('<video class="single">'));
}
refused(() => settle(many.id, { attributes: { src: "/media/c.mp4" } }), /files for different browsers/, "a player with several sources keeps them");
refused(() => settle(video.id, { attributes: { src: "javascript:alert(1)" } }), /Script/, "a script address is refused as a video");

/* ----------------------------------------------------------- undo / redo */

{
  const first = settle(heading.id, { tag: "h4" }).result.values;
  const undone = changeStructure(source, first, { kind: "undo" }).values;
  const html = undone[DOCUMENT_KEY]?.document?.html;
  ok("undo puts the tag back", !html || unmarked(html) === source);
}

console.log(`websiteElementSettings: ${checks} checks — tag families, retag keeps every field id, attribute allowlist and its refusals, unique ids, same-offset splices, video settings, undo passed.`);
