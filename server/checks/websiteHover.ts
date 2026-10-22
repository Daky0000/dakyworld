/**
 * A site's own `:hover` rules, read for the Hover view.
 *
 *   npx tsx checks/websiteHover.ts
 *
 * No database and no network: `hoverRules` on the CSS three kinds of site
 * actually ship — a hand-written stylesheet, Elementor's generated post CSS and
 * Tailwind's built utilities. The selector it returns is what the editor hands
 * to `element.matches`, so a wrong one is a hover the panel never shows.
 */
import assert from "node:assert/strict";
import { hoverRules } from "../src/services/website/hover.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}`); }
}

const rules = hoverRules([
  { css: `
    .btn { color: #111 }
    .btn:hover { background-color: #0f3d25; color: #fff !important }
    .card:hover .title, .menu a:hover { text-decoration: underline }
    a:hover::after { content: ""; width: 100% }
    @media (min-width: 768px) { .nav-link:hover { opacity: .8 } }
    .broken:hover { }
    .btn:active { transform: translateY(1px) }
    .btn:focus-visible { box-shadow: 0 0 0 3px #3157ff }
    .form:focus-within { border-color: red }
    .x:activeTab { color: red }
  ` },
  { css: `.elementor-26 .elementor-element.elementor-element-bt30001 .elementor-button:hover, .elementor-26 .elementor-element.elementor-element-bt30001 .elementor-button:focus{background-color:#0f3d25;color:#ffee00;}` },
  { css: `.hover\\:bg-lime:hover{background-color:#c6f432}.focus\\:hover\\:underline:hover{text-decoration-line:underline}.group:hover .group-hover\\:text-white{color:#fff}` },
  { css: `.elementor .e-hd40001-hv:active{color:#aa0001;}` },
  { css: `this is { not css` },
]);
const find = (hover: string) => rules.find((rule) => rule.hover === hover);

check("a plain rule: `:hover` taken out of the selector, declarations kept, !important said", () => {
  const rule = find(".btn:hover");
  assert.ok(rule);
  assert.equal(rule.selector, ".btn");
  assert.equal(rule.self, true);
  assert.deepEqual(rule.declarations, [["background-color", "#0f3d25"], ["color", "#fff !important"]]);
  assert.ok(!rules.some((entry) => entry.selector === ".btn" && entry.hover === ".btn"), "a rule without :hover is not a hover rule");
});

check("a selector list is split, and hovering an ancestor is told apart from hovering the element", () => {
  assert.equal(find(".card:hover .title")?.selector, ".card .title");
  assert.equal(find(".card:hover .title")?.self, false);
  assert.equal(find(".menu a:hover")?.self, true);
});

check("a pseudo-element, an empty rule and unparseable CSS give nothing", () => {
  assert.ok(!rules.some((rule) => rule.hover.includes("::after")));
  assert.ok(!rules.some((rule) => rule.hover.includes("broken")));
});

check("a rule inside @media carries its condition, so the panel can match it to the screen", () => {
  assert.equal(find(".nav-link:hover")?.media, "(min-width: 768px)");
});

check("Elementor's post CSS: its hover and its :focus twin are one rule each, for their own state", () => {
  const button = rules.filter((entry) => entry.selector.includes("elementor-element-bt30001"));
  assert.deepEqual(button.map((entry) => entry.state).sort(), ["focus", "hover"]);
  assert.ok(button.every((entry) => entry.selector === ".elementor-26 .elementor-element.elementor-element-bt30001 .elementor-button"));
});

check("pressed and focus rules are read as their own state; :focus-within and :active-ish names are not", () => {
  assert.equal(find(".btn:active")?.state, "active");
  assert.equal(find(".btn:active")?.selector, ".btn");
  assert.equal(find(".btn:focus-visible")?.state, "focus");
  assert.equal(find(".btn:focus-visible")?.selector, ".btn");
  assert.equal(find(".elementor .e-hd40001-hv:active")?.state, "active");
  assert.ok(!rules.some((entry) => entry.hover.includes("focus-within")), "focus-within is about a child, not this element");
  assert.ok(!rules.some((entry) => entry.hover.includes("activeTab")));
});

check("Tailwind: an escaped `\\:hover` inside a class name is part of the name", () => {
  assert.equal(find(".hover\\:bg-lime:hover")?.selector, ".hover\\:bg-lime");
  assert.equal(find(".focus\\:hover\\:underline:hover")?.selector, ".focus\\:hover\\:underline");
  assert.equal(find(".group:hover .group-hover\\:text-white")?.selector, ".group .group-hover\\:text-white");
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed:\n  ${failures.join("\n  ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
