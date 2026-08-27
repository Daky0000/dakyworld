/**
 * The visual editor, checked against every real page in this repository.
 *
 * Two new things sit on top of the splice model, and both write into somebody's
 * live website, so both get held to the same standard as the rest of it.
 *
 * **Marking the elements.** The preview names every editable element with a
 * `data-dw-field` so a click can say which field it landed on. That is an
 * insert per field into the page — 203 of them on the homepage — and an
 * off-by-one in any of them corrupts the document. The ids come from the
 * server's own parse rather than being worked out in the browser precisely
 * because they are positional: a second implementation would have to agree with
 * the first for ever.
 *
 * **Styling an element.** A style is written as an inline `style` attribute on
 * the one element that was selected, never as a rule in a stylesheet — a rule
 * would apply to every page at once and to elements nobody was editing, which
 * is not what "make this heading bigger" means. The claims:
 *
 *  1. Marking a page changes nothing but the attributes it adds — every field
 *     still reads back with the same value, and the mark lands inside the
 *     opening tag rather than in the middle of an attribute.
 *  2. A style edit lands on the element it was aimed at and on nothing else,
 *     and the file diff is that one line.
 *  3. An element that already has a style keeps whatever the editor has no
 *     control for. Dropping a developer's own declarations silently is the
 *     quiet version of breaking their page.
 *  4. A stale style refuses, exactly as a stale heading does.
 *  5. `safeStyle` keeps what styles and drops what does anything else. A draft
 *     outlives the session that wrote it and is spliced into a public page.
 *  6. **The preview's own policy still permits a `style=""` attribute.** This one
 *     is here because it broke in production and nothing caught it: a nonce
 *     anywhere in `style-src` makes a browser ignore `'unsafe-inline'` in that
 *     directive, and `'unsafe-inline'` is what allows style attributes. Nonceing
 *     the picker's stylesheet therefore switched off every inline style in the
 *     preview — the one thing the visual editor writes. The element kept its
 *     attribute, the browser dropped the declarations, and a heading set to
 *     align left simply did not move. Asserting the attribute is set is not
 *     enough; the policy that decides whether it does anything is the claim.
 *
 * No database, no network, no key.
 *   npx tsx checks/websiteVisual.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyValues, buildPreview, discoverFields, safeStyle } from "../src/services/website/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "..", "..");

let failures = 0;
let passed = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

const pages = readdirSync(siteRoot)
  .filter((name) => name.endsWith(".html"))
  .sort();

console.log("\nWhat the preview's own policy allows");
{
  const home = readFileSync(join(siteRoot, "index.html"), "utf8");
  const fields = discoverFields(home).fields;
  const picking = buildPreview(home, "https://dakyworld.com", fields).csp;
  const plain = buildPreview(home, "https://dakyworld.com").csp;

  const styleSrc = picking.split(";").map((d) => d.trim()).find((d) => /^style-src\b/i.test(d)) ?? "";
  const styleAttr = picking.split(";").map((d) => d.trim()).find((d) => /^style-src-attr\b/i.test(d)) ?? "";
  const nonced = /'nonce-/.test(styleSrc);

  check(
    "a style attribute is allowed in the preview the editor writes into",
    !nonced || /'unsafe-inline'/.test(styleAttr),
    `style-src carries a nonce, which makes 'unsafe-inline' in it inert, and style-src-attr does not put attributes back: ${styleAttr || "(absent)"}`,
  );
  check("the picker's own stylesheet still runs on its nonce", /'nonce-/.test(styleSrc));
  check("the plain preview is not given a nonce at all", !/'nonce-/.test(plain), plain);
  check("nothing is framed but the editor", /frame-ancestors 'self'/.test(picking));
  check("and a preview of the contact page cannot send anything", /form-action 'none'/.test(picking));
}

console.log("\nMarking every editable element");
for (const name of pages) {
  const html = readFileSync(join(siteRoot, name), "utf8");
  const content = discoverFields(html);
  const marked = buildPreview(html, "https://dakyworld.com", content.fields);

  // Whitespace-prefixed: that is how a mark is inserted into a tag. The
  // picker's own script mentions the attribute too, as `[data-dw-field="`.
  const markCount = (marked.html.match(/\sdata-dw-field="/g) ?? []).length;
  const markable = content.fields.filter((field) => field.attrInsert !== undefined).length;
  check(`${name}: every markable field is marked`, markCount === markable, `${markCount} marks for ${markable} fields`);

  // The mark has to land inside an opening tag. Anywhere else and it is text
  // on the page or, worse, inside another attribute's value.
  const stray = /[^<][a-z"'\s=/-]\sdata-dw-field="[^"]*"(?![^<>]*>)/i.test(marked.html);
  check(`${name}: no mark landed outside a tag`, !stray);

  // And the page still reads the same afterwards: same fields, same values.
  const after = discoverFields(marked.html.replace(/<base [^>]*>/i, ""));
  const sameIds = after.fields.map((f) => f.id).join(",") === content.fields.map((f) => f.id).join(",");
  check(`${name}: the marked page still has the same fields`, sameIds);
  const sameValues = content.fields.every((field) => after.fields.find((f) => f.id === field.id)?.value === field.value);
  check(`${name}: and the same values`, sameValues);

  check(`${name}: the picker is only added when asked for`, !buildPreview(html, "https://dakyworld.com").html.includes("data-dw-field"));
  check(`${name}: the picker's script carries a nonce the policy names`, /nonce="([^"]+)"/.test(marked.html) && marked.csp.includes("'nonce-"));
}

console.log("Styling one element");
for (const name of pages) {
  const html = readFileSync(join(siteRoot, name), "utf8");
  const content = discoverFields(html);
  const target = content.fields.find((field) => field.kind !== "image" && field.attrInsert !== undefined);
  if (!target) continue;

  const applied = applyValues(html, {
    [target.id]: { style: "color: #3157FF; font-size: 40px", original: target.value, originalStyle: target.style ?? undefined },
  });
  check(`${name}: the style is written`, applied.changed.includes(target.id), JSON.stringify(applied.conflicts).slice(0, 200));

  const after = discoverFields(applied.html);
  const styled = after.fields.find((field) => field.id === target.id);
  check(`${name}: onto the element it was aimed at`, styled?.style === "color: #3157FF; font-size: 40px", styled?.style);
  check(`${name}: and nothing else on the page moved`, after.fields.every((field) => field.id === target.id || field.value === content.fields.find((f) => f.id === field.id)?.value));

  const changedLines = html.split("\n").filter((line, index) => line !== applied.html.split("\n")[index]).length;
  check(`${name}: the file diff is one line`, changedLines === 1, `${changedLines} lines`);
}

console.log("Keeping what the developer wrote");
{
  const html = `<div><h1 style="font-size:clamp(40px,5vw,70px);letter-spacing:-.03em">Hello</h1></div>`;
  const content = discoverFields(html);
  const heading = content.fields.find((field) => field.tag === "h1")!;
  check("an existing style is read off the element", heading.style === "font-size:clamp(40px,5vw,70px);letter-spacing:-.03em", heading.style);

  // The editor sends the whole declaration string back, having kept what it has
  // no control for — this is the assertion that it *can*, i.e. that the value
  // it was given round-trips.
  const kept = "letter-spacing:-.03em; color: #3157FF";
  const applied = applyValues(html, { [heading.id]: { style: kept, originalStyle: heading.style } });
  const after = discoverFields(applied.html).fields.find((field) => field.tag === "h1");
  check("what the editor sends back is what is written", after?.style === kept, after?.style);
}

console.log("Refusing a stale style");
{
  const html = `<div><h1 style="color:red">Hello</h1></div>`;
  const content = discoverFields(html);
  const heading = content.fields.find((field) => field.tag === "h1")!;
  const applied = applyValues(html, { [heading.id]: { style: "color: blue", originalStyle: "color:green" } });
  check("a style written against a page that has moved is refused", applied.conflicts.length === 1 && applied.changed.length === 0);
  check("and the page is left exactly as it was", applied.html === html);
}

console.log("What a style may contain");
const styleCases: [string, string, string][] = [
  ["a plain declaration", "color: #3157FF", "color: #3157FF"],
  ["several", "color: red; font-size: 20px", "color: red; font-size: 20px"],
  ["a remote image", "background: url(https://evil.example/x.png)", ""],
  ["an IE expression", "width: expression(alert(1))", ""],
  ["a javascript url", "background: javascript:alert(1)", ""],
  ["a quote that would leave the attribute", 'color: red" onload="alert(1)', ""],
  ["an angle bracket", "color: red<script>", ""],
  ["a property that is not one", "9: red", ""],
  ["empty declarations", ";;; ;", ""],
  ["a value nobody would type", `color: ${"a".repeat(200)}`, ""],
];
for (const [label, input, expected] of styleCases) {
  check(`safeStyle keeps ${label}`.replace("keeps a remote image", "drops a remote image"), safeStyle(input) === expected, `${JSON.stringify(safeStyle(input))} for ${JSON.stringify(input)}`);
}

// And the whole way through: a hostile draft cannot become an attribute escape.
{
  const html = `<div><h1>Hello</h1></div>`;
  const content = discoverFields(html);
  const heading = content.fields.find((field) => field.tag === "h1")!;
  const applied = applyValues(html, { [heading.id]: { style: 'color: red" onmouseover="alert(1)', original: heading.value } });
  check("a hostile style never becomes markup", !applied.html.includes("onmouseover"), applied.html);
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log("websiteVisual: all checks passed");
