/** Responsive edits through the real discovery, draft and HTML writer. No IO. */
import assert from "node:assert/strict";
import {
  applyValues, categoriseChanges, describeChanges, discoverFields, normalizeResponsive,
  regenerateResponsiveStyles, renderResponsiveCss, responsiveEqual, safeResponsiveStyle, sanitizeValue,
} from "../src/services/website/index.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }
const source = '<!doctype html><html><head><title>Responsive test</title><style>.original{color:teal}</style></head><body><main><section id="hero"><h1 data-dw-field="hero-title" style="font-size: 60px; color: navy">Original heading</h1><p>Body copy</p><img src="photo.jpg" alt="Photo"></section></main><script>window.original=true</script></body></html>';
const original = discoverFields(source);
const heading = original.fields.find((field) => field.id === "hero-title")!;
const edit = sanitizeValue(heading, { responsive: { tablet: "font-size:42px; padding: 2rem", mobile: "font-size: 28px !important" } });
equal("original responsive map is stamped even when absent", edit.originalResponsive, {});
equal("draft canonicalizes device declarations", edit.responsive, { tablet: "font-size: 42px; padding: 2rem", mobile: "font-size: 28px" });
const first = applyValues(source, { [heading.id]: edit });
equal("responsive edit is counted", first.changed, [heading.id]);
equal("responsive edit has no conflicts", first.conflicts, []);
const read = discoverFields(first.html);
const responsiveHeading = read.fields.find((field) => field.id === heading.id)!;
equal("responsive overrides rediscovered from escaped JSON", responsiveHeading.responsive, edit.responsive);
equal("field IDs and content numbering survive generated markup", read.fields.map((field) => [field.id, field.value]), original.fields.map((field) => [field.id, field.value]));
equal("base styling survives media edits", responsiveHeading.style, heading.style);
check("source script remains unchanged", first.html.includes('<script>window.original=true</script>'));
check("source stylesheet remains unchanged", first.html.includes('<style>.original{color:teal}</style>'));
check("generated block is unique", (first.html.match(/<style data-dw-responsive-styles>/g) ?? []).length === 1);
const token = first.html.match(/data-dw-style="(dw-[a-f0-9]{24})"/)?.[1];
check("generated token has a restricted selector-safe alphabet", token);
const css = renderResponsiveCss(token!, edit.responsive!);
check("tablet cascade precedes phone cascade", css.indexOf("max-width: 1024px") < css.indexOf("max-width: 640px"));
check("tablet declarations remain available to phones", css.includes("padding: 2rem !important"));
check("normalized declarations get exactly one important", !css.includes("!important !important") && css.includes("font-size: 28px !important"));
check("selectors have intended specificity", css.includes(`[data-dw-style="${token}"]`.repeat(3)));
equal("unchanged responsive input is a no-op", sanitizeValue(responsiveHeading, { responsive: { mobile: "font-size:28px !IMPORTANT", tablet: "font-size:42px; padding:2rem;" } }), {});
equal("no edits preserves full source bytes", applyValues(first.html, {}).html, first.html);
equal("unchanged override leaves full source bytes", applyValues(first.html, { [heading.id]: { responsive: edit.responsive } }).html, first.html);
equal("regeneration is idempotent", regenerateResponsiveStyles(first.html), first.html);

const combined = sanitizeValue(responsiveHeading, { value: "Updated heading", style: "font-size: 64px; color: maroon", responsive: { mobile: "font-size: 30px" } });
const second = applyValues(first.html, { [heading.id]: combined });
equal("combined content/base/device edit is one field", second.changed, [heading.id]);
const updated = discoverFields(second.html).fields.find((field) => field.id === heading.id)!;
equal("complete replacement removes tablet override", updated.responsive, { mobile: "font-size: 30px" });
equal("combined content survives", updated.value, "Updated heading");
equal("combined base style survives", updated.style, "font-size: 64px; color: maroon");
check("token is stable through subsequent edits", second.html.includes(`data-dw-style="${token}"`));
check("removed tablet rule no longer renders", !second.html.includes("max-width: 1024px"));
check("repeated edits never duplicate generated block", (second.html.match(/<style data-dw-responsive-styles>/g) ?? []).length === 1);

const reset = sanitizeValue(updated, { responsive: {} });
const cleared = applyValues(second.html, { [heading.id]: reset });
equal("cleared field has no override", discoverFields(cleared.html).fields.find((field) => field.id === heading.id)!.responsive, undefined);
check("last reset removes the generated block", !cleared.html.includes("data-dw-responsive-styles"));
check("reset keeps stable token for the next edit", cleared.html.includes(`data-dw-style="${token}"`));
check("reset retains source stylesheet", cleared.html.includes('<style>.original{color:teal}</style>'));
const restored = applyValues(cleared.html, { [heading.id]: { responsive: { tablet: "display: grid" } } });
check("editing after reset retains same token", restored.html.includes(`data-dw-style="${token}"`));

const developerChanged = first.html.replace("font-size: 42px; padding: 2rem", "font-size: 44px; padding: 2rem");
const stale = applyValues(developerChanged, { [heading.id]: combined });
equal("responsive source change conflicts before writing any part", stale.changed, []);
equal("responsive conflict preserves source exactly", stale.html, developerChanged);
equal("responsive conflict identifies the field", stale.conflicts.map((conflict) => conflict.id), [heading.id]);
check("different key order and insignificant syntax compare canonically", responsiveEqual({ mobile: "color:red!important", tablet: "width:80%;" }, { tablet: "width: 80%", mobile: "color: red" }));
const container = original.fields.find((field) => field.kind === "container" && field.tag === "section")!;
const containerEdit = sanitizeValue(container, { responsive: { mobile: "padding: 1rem" } });
const movedContainer = applyValues(source.replace("Body copy", "Developer copy"), { [container.id]: containerEdit });
equal("container structure still detects stale responsive changes", movedContainer.conflicts.map((conflict) => conflict.id), [container.id]);

const tokenOther = "dw-aaaaaaaaaaaaaaaaaaaaaaaa";
const unsupported = `<input data-dw-style="${tokenOther}" data-dw-responsive='{&quot;tablet&quot;:&quot;width: 80%&quot;}' value="Keep me">`;
const withOther = first.html.replace("</body>", `${unsupported}</body>`);
const preserving = applyValues(withOther, { [heading.id]: { responsive: {} } });
check("unsupported element attributes survive exactly", preserving.html.includes(unsupported));
check("unsupported element rules survive another element reset", preserving.html.includes(`[data-dw-style="${tokenOther}"]`) && preserving.html.includes("width: 80% !important"));
check("all rules retain single generated block", (preserving.html.match(/<style data-dw-responsive-styles>/g) ?? []).length === 1);
const duplicateBlocks = first.html.replace("</head>", '<style data-dw-responsive-styles>.old{color:red}</style></head>');
equal("duplicate owned blocks are consolidated", (regenerateResponsiveStyles(duplicateBlocks).match(/<style data-dw-responsive-styles>/g) ?? []).length, 1);
const duplicateTokenSource = first.html.replace("</body>", `${unsupported.replace(tokenOther, token!)}</body>`);
const duplicateTokenUpdate = applyValues(duplicateTokenSource, { [heading.id]: { responsive: { mobile: "opacity: .5" } } });
const newToken = duplicateTokenUpdate.html.match(/<h1[^>]*data-dw-style="([^"]+)"/)?.[1];
check("editing a colliding token assigns a separate target", newToken && newToken !== token);
check("colliding unsupported node retains original token", duplicateTokenUpdate.html.includes(unsupported.replace(tokenOther, token!)));

const attacks = [
  'color: red; background: url(https://attacker.test/pixel)',
  'color: red; background-image: image-set("https://attacker.test/pixel" 1x)',
  'color: red; background: u\\72l(https://attacker.test/pixel)',
  'color: red; background: u/**/rl(https://attacker.test/pixel)',
  'color: red; width: expression(alert(1))',
  'color: red; width: 1px}</style><script>alert(1)</script>',
  'color: red; width: 1px}body{display:none',
  'color: red; background-image: var(--remote-image)',
  'color: red; cursor: var(--remote-cursor)',
  'color: red; filter: url(#existing-filter)',
  'color: red; @import: evil',
];
for (const attack of attacks) {
  equal(`dangerous declaration rejected: ${attack}`, safeResponsiveStyle(attack), "color: red");
  const html = applyValues(source, { [heading.id]: { responsive: { mobile: attack } } }).html;
  check("untrusted responsive declarations cannot create script nodes", !html.includes("<script>alert(1)</script>"));
}
equal("safe controls retain units, formulas, gradients, font names and transforms", safeResponsiveStyle('padding: clamp(1rem, 4vw, 3rem); background: linear-gradient(90deg, red, blue); font-family: "Open Sans", serif; transform: translateY(2rem); width: var(--content-width)'), 'padding: clamp(1rem, 4vw, 3rem); background: linear-gradient(90deg, red, blue); font-family: "Open Sans", serif; transform: translateY(2rem); width: var(--content-width)');
equal("arbitrary breakpoint keys are dropped", normalizeResponsive({ desktop: "color: red", tablet: 42, mobile: "color:blue" }), { mobile: "color: blue" });
equal("unsafe selector cannot create CSS", renderResponsiveCss('dw-"]{}</style>', { mobile: "color: red" }), "");
const malformedJson = source.replace("<h1 ", '<h1 data-dw-responsive="&notjson;" ');
equal("malformed saved responsive map is safely ignored", discoverFields(malformedJson).fields.find((field) => field.id === heading.id)!.responsive, {});
const fragment = '<h2 data-dw-field="fragment-title">Fragment</h2>';
const fragmentUpdated = applyValues(fragment, { "fragment-title": { responsive: { mobile: "text-align: center" } } });
equal("fragments retain field identity", discoverFields(fragmentUpdated.html).fields.map((field) => field.id), ["fragment-title"]);
check("fragments receive responsive CSS", fragmentUpdated.html.includes("data-dw-responsive-styles"));

const summaries = describeChanges(original.fields, { [heading.id]: edit });
equal("reviews identify both device changes", summaries.map((summary) => [summary.part, summary.label]), [["styling", "Main heading (tablet)"], ["styling", "Main heading (phone)"]]);
check("responsive summaries are categorized as styling", categoriseChanges(summaries).styles);
equal("reset review describes inheritance", describeChanges([updated], { [heading.id]: reset })[0]!.to, "inherited styling");
console.log(`websiteResponsive: ${checks} checks passed`);
