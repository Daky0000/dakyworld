/** The contextual inspector's rules, without a browser. No IO. */
import assert from "node:assert/strict";
import {
  ADVANCED_PROPERTIES, BROWSER_DEFAULTS, EXCLUSIVE_SECTIONS, PROPERTY_OWNER, elementCapabilities,
  inspectorSections, inspectorValue, isBrowserDefault, meaningfulValue, ownersOf, positionControls,
  readableValue, toHex, type ElementFacts, type SectionKey,
} from "../client/src/lib/elementInspector.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const facts = (over: Partial<ElementFacts> = {}): ElementFacts => ({
  kind: "text", tag: "h1", display: "block", parentDisplay: "block", position: "static", hasText: true, childCount: 0, ...over,
});
const sections = (over: Partial<ElementFacts> = {}) => inspectorSections(elementCapabilities(facts(over)));
const has = (section: SectionKey, over: Partial<ElementFacts> = {}) => sections(over).includes(section);

/* ------------------------------------------------- property has one owner */

// The defect this replaces: width and height were editable from two sections at
// once, writing the same declaration from controls showing different values.
const doubled = Object.entries(PROPERTY_OWNER).filter(([, owner]) => Array.isArray(owner));
for (const [property, owner] of doubled) {
  const pair = owner as SectionKey[];
  check(`${property} is claimed by exactly two sections`, pair.length === 2);
  check(
    `${property}'s two owners can never both be visible`,
    EXCLUSIVE_SECTIONS.some(([left, right]) => (pair[0] === left && pair[1] === right) || (pair[0] === right && pair[1] === left)),
  );
}
for (const [left, right] of EXCLUSIVE_SECTIONS) {
  check(`${left} and ${right} are never drawn together`, !sections().includes(left) || !sections().includes(right));
}
equal("width has one owner", ownersOf("width"), ["size"]);
equal("height has one owner", ownersOf("height"), ["size"]);
check("every advanced property is a property the inspector owns", [...ADVANCED_PROPERTIES].every((property) => ownersOf(property).length > 0));
check("no browser default is listed for a property nobody owns", Object.keys(BROWSER_DEFAULTS).every((property) => ownersOf(property).length > 0));

/* ----------------------------------------------- what each element offers */

check("a heading shows typography", has("typography"));
check("a heading shows no image controls", !has("image"));
check("a heading shows no flex controls", !has("flexContainer"));
check("an image shows image controls", has("image", { kind: "image", tag: "img" }));
check("an image shows no typography", !has("typography", { kind: "image", tag: "img" }));
check("an image is sizeable even when the browser lays it out inline", has("size", { kind: "image", tag: "img", display: "inline" }));
check("an inline text link is not given width and height", !has("size", { kind: "link", tag: "a", display: "inline" }));
check("a link that renders as a button is", has("size", { kind: "link", tag: "a", display: "inline-flex" }));
check("a container with no words of its own has no typography", !has("typography", { kind: "container", tag: "div", hasText: false, childCount: 2 }));
check("a container with words does", has("typography", { kind: "container", tag: "div", hasText: true, childCount: 2 }));
check("a container has no content control", !has("content", { kind: "container", tag: "div", childCount: 2 }));

check("flex controls appear only on a flex container", has("flexContainer", { kind: "container", tag: "div", display: "flex", childCount: 2 }));
check("inline-flex counts", has("flexContainer", { kind: "container", tag: "div", display: "inline-flex", childCount: 2 }));
check("grid controls appear only on a grid container", has("gridContainer", { kind: "container", tag: "div", display: "grid", childCount: 2 }));
check("a grid container is not offered flex direction", !has("flexContainer", { kind: "container", tag: "div", display: "grid", childCount: 2 }));
check("a block container is offered neither", !has("flexContainer", { kind: "container", tag: "div", childCount: 2 }) && !has("gridContainer", { kind: "container", tag: "div", childCount: 2 }));
check("an element with no children gets no Display control", !has("layout"));
check("an element with children does", has("layout", { childCount: 1 }));

check("flex-child controls follow the parent", has("flexChild", { parentDisplay: "flex" }));
check("a flex child is not offered grid placement", !has("gridChild", { parentDisplay: "flex" }));
check("grid-child controls follow the parent", has("gridChild", { parentDisplay: "grid" }));
check("a grid child is not offered grow and shrink", !has("flexChild", { parentDisplay: "grid" }));
check("a child of neither gets no within-parent section", !has("flexChild") && !has("gridChild"));
check("being a flex container says nothing about being a flex child", !has("flexChild", { display: "flex", childCount: 2 }));

check("a static element hides Position", !has("position"));
check("a positioned element shows it", has("position", { position: "absolute" }));
check("Advanced is always reachable", has("advanced") && has("advanced", { kind: "image", tag: "img" }));

/* ------------------------------------------------------ position offsets */

equal("static offers no offsets", positionControls("static"), { offsets: [], zIndex: false });
equal("relative offers all four and the stacking order", positionControls("relative"), { offsets: ["top", "right", "bottom", "left"], zIndex: true });
equal("absolute offers all four", positionControls("absolute").offsets, ["top", "right", "bottom", "left"]);
equal("sticky offers the two that do anything", positionControls("sticky"), { offsets: ["top", "bottom"], zIndex: true });
equal("an empty position is treated as static", positionControls(""), { offsets: [], zIndex: false });

/* ------------------------------------------------- source, computed, override */

const website = inspectorValue("font-size", { computed: "72px", device: "desktop" });
equal("an unedited value shows what the site renders", [website.effective, website.origin, website.overridden], ["72px", "website", false]);
const written = inspectorValue("font-size", { computed: "60px", source: "60px", device: "desktop" });
equal("a style attribute in the page is its own origin", written.origin, "inline");
const edited = inspectorValue("font-size", { computed: "64px", source: "72px", override: "64px", device: "desktop" });
equal("an edit at desktop reads as an override", [edited.effective, edited.origin, edited.overridden], ["64px", "desktop-override", true]);
const phone = inspectorValue("font-size", { computed: "42px", device: "mobile" });
equal("the phone shows the phone's computed value", [phone.effective, phone.origin], ["42px", "website"]);
const phoneEdited = inspectorValue("font-size", { computed: "38px", override: "38px", device: "mobile" });
equal("an edit at phone width is a phone override", [phoneEdited.effective, phoneEdited.origin, phoneEdited.overridden], ["38px", "phone-override", true]);
const inherited = inspectorValue("font-size", { computed: "64px", base: "64px", device: "tablet" });
equal("a tablet inheriting the base edit says where it came from", [inherited.origin, inherited.overridden], ["desktop-override", false]);
const tabletOwn = inspectorValue("font-size", { computed: "50px", base: "64px", override: "50px", device: "tablet" });
equal("a tablet override wins over the base edit", [tabletOwn.effective, tabletOwn.origin], ["50px", "tablet-override"]);
equal("an unreachable frame leaves the control empty rather than inventing a value", inspectorValue("color", { device: "desktop" }).effective, "");
equal("reading a value never produces an override", inspectorValue("color", { computed: "rgb(8, 16, 31)", device: "desktop" }).override, undefined);
equal("a blank override is not an override", inspectorValue("color", { computed: "red", override: "   ", device: "desktop" }).origin, "website");
// A desktop draft is seeded with the element's whole style attribute, so every
// declaration a developer wrote arrives as an "override" until it differs.
const untouchedInline = inspectorValue("font-size", { computed: "60px", source: "60px", override: "60px", device: "desktop" });
equal("an unedited style attribute is not somebody's override", [untouchedInline.origin, untouchedInline.overridden], ["inline", false]);
const touchedInline = inspectorValue("font-size", { computed: "48px", source: "60px", override: "48px", device: "desktop" });
equal("changing it is", [touchedInline.origin, touchedInline.overridden], ["desktop-override", true]);
const carriedBase = inspectorValue("font-size", { computed: "60px", source: "60px", base: "60px", device: "tablet" });
equal("a tablet inheriting an untouched attribute credits the website", carriedBase.origin, "inline");

/* ------------------------------------------------------- browser defaults */

check("a static position is a default nobody chose", isBrowserDefault("position", "static"));
check("z-index auto is one too", isBrowserDefault("z-index", "auto"));
check("a transparent background is one too", isBrowserDefault("background-color", "rgba(0, 0, 0, 0)"));
check("a real background is not", !isBrowserDefault("background-color", "rgb(8, 16, 31)"));
check("Chrome's three-part text-decoration is still none", isBrowserDefault("text-decoration", "none solid rgb(0, 0, 0)"));
check("a default is hidden while nothing has set it", !meaningfulValue(inspectorValue("opacity", { computed: "1", device: "desktop" })));
check("the same default is shown once somebody sets it", meaningfulValue(inspectorValue("opacity", { computed: "0.5", override: "0.5", device: "desktop" })));
check("a default written into the page's own HTML is shown", meaningfulValue(inspectorValue("opacity", { computed: "1", source: "1", device: "desktop" })));
check("a real site value is always shown", meaningfulValue(inspectorValue("font-size", { computed: "72px", device: "desktop" })));
check("a property nothing measured and nobody set announces no origin", !meaningfulValue(inspectorValue("width", { device: "desktop" })));
check("an emptied override still announces itself, so the reset stays reachable", meaningfulValue(inspectorValue("width", { source: "40px", override: "", device: "desktop" })) === false);
check("a measured width does announce one", meaningfulValue(inspectorValue("width", { computed: "540px", device: "desktop" })));

/* ------------------------------------------------------------- readability */

equal("rgb becomes hex", toHex("rgb(8, 16, 31)"), "#08101F");
equal("short hex expands", toHex("#abc"), "#AABBCC");
equal("a name the browser did not resolve is left alone", toHex("currentColor"), null);
const palette = [{ label: "Ink", value: "#08101F" }, { label: "Lime", value: "#B8FF3D" }];
equal("a palette colour is named", readableValue("color", "rgb(8, 16, 31)", palette), "Ink · #08101F");
equal("a colour outside the palette is still readable", readableValue("color", "rgb(255, 0, 0)", palette), "#FF0000");
equal("a font stack reads as its typeface", readableValue("font-family", '"Space Grotesk", sans-serif'), "Space Grotesk");
equal("a weight reads as a word", readableValue("font-weight", "700"), "700 · Bold");
equal("an unknown weight is left as a number", readableValue("font-weight", "437"), "437");
equal("a length is left exactly as it is", readableValue("font-size", "1.05rem"), "1.05rem");

console.log(`websiteInspector: ${checks} checks — single ownership, capability derivation, parent-aware sections, conditional position, effective values and readable display passed`);
