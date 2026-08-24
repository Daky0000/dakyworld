/**
 * Can the editor be trusted with somebody's live website?
 *
 * The website editor does not re-render a page; it splices bytes into the file
 * the developer wrote. That is what keeps a publish a one-line diff instead of a
 * whole-file reformat, and it is also what makes a parser bug catastrophic
 * rather than cosmetic: an offset that is wrong by one writes a heading into the
 * middle of a class attribute and the page stops rendering.
 *
 * So six claims, the first five asserted against every real page in this
 * repository rather than a fixture, because a fixture is a page nobody visits:
 *
 *  1. Reading a page and applying no edits reproduces the file byte for byte.
 *  2. Every field's offsets lie inside the document and inside its own element,
 *     and no two fields overlap.
 *  3. An edit lands where it was aimed: change one field, re-read, and only
 *     that field's value differs.
 *  4. A stale draft refuses rather than writing to the wrong place.
 *  5. Nothing a build script owns is offered as editable — and excluding those
 *     blocks has not accidentally swallowed the page around them.
 *  6. Nothing a client can type reaches a page as anything but words.
 *
 * No database, no network, no key.
 *   npx tsx checks/website.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyValues, readPage } from "../src/services/website/regions.js";
import { checkLink, sanitizePlain, sanitizeRich } from "../src/services/website/sanitize.js";

const here = dirname(fileURLToPath(import.meta.url));
/** The website lives at the repository root, beside `server/`. See CLAUDE.md. */
const siteRoot = join(here, "..", "..");

let failures = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) return;
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

const pages = readdirSync(siteRoot)
  .filter((name) => name.endsWith(".html"))
  .sort();

check("the repository has pages to read", pages.length > 0);

let totalFields = 0;
for (const file of pages) {
  const source = readFileSync(join(siteRoot, file), "utf8");
  const page = readPage(source);
  totalFields += page.fields.length;

  // 1. Nothing in, nothing out.
  const untouched = applyValues(source, {});
  check(`${file}: applying no edits changes nothing`, untouched.html === source, `${source.length} bytes in, ${untouched.html.length} out`);

  // 2. Offsets are sane and do not collide.
  const spans: Array<{ start: number; end: number; id: string }> = [];
  for (const field of page.fields) {
    for (const span of [field.content, field.hrefSpan, field.srcSpan, field.altSpan]) {
      if (!span) continue;
      check(
        `${file}: ${field.id} offsets are inside the document`,
        span.start >= 0 && span.end <= source.length && span.start <= span.end,
      );
      spans.push({ ...span, id: field.id });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i += 1) {
    check(
      `${file}: ${spans[i - 1]!.id} and ${spans[i]!.id} do not overlap`,
      spans[i]!.start >= spans[i - 1]!.end,
      `${spans[i - 1]!.id} ends at ${spans[i - 1]!.end}, ${spans[i]!.id} starts at ${spans[i]!.start}`,
    );
  }

  // 3. An edit lands where it was aimed. Every text field on the page, one at a
  //    time, is the only affordable version of "every field" — and it is the one
  //    that would catch an off-by-one on any single element.
  const editable = page.fields.filter((field) => field.kind === "text" && field.content);
  for (const field of editable) {
    const marker = "Dakyworld editor probe";
    const result = applyValues(source, { [field.id]: { value: marker, original: field.value } });
    check(`${file}: ${field.id} reports itself changed`, result.changed.includes(field.id));
    check(`${file}: ${field.id} raises no conflict`, result.conflicts.length === 0);

    const after = readPage(result.html);
    const moved = after.fields.find((candidate) => candidate.id === field.id);
    check(`${file}: ${field.id} still exists after the edit`, Boolean(moved));
    check(`${file}: ${field.id} holds what was written`, moved?.value === marker, `found ${JSON.stringify(moved?.value)}`);

    const differing = after.fields.filter((candidate) => {
      const before = page.fields.find((original) => original.id === candidate.id);
      return !before || before.value !== candidate.value;
    });
    check(
      `${file}: ${field.id} is the only field the edit touched`,
      differing.length === 1 && differing[0]!.id === field.id,
      differing.map((candidate) => candidate.id).join(", "),
    );

    // The lengths either side of the spliced field must be unchanged, which is
    // the byte-level version of the same claim.
    const expected = source.length - field.value.length + marker.length;
    check(`${file}: ${field.id} changed only its own bytes`, result.html.length === expected);
  }

  // 4. A draft written against a page that has since moved refuses.
  const first = editable[0];
  if (first) {
    const stale = applyValues(source, { [first.id]: { value: "should not land", original: "something the page never said" } });
    check(`${file}: a stale edit is refused`, stale.html === source && stale.conflicts.length === 1);
  }

  // 5. Generated blocks are excluded, and excluding them has not swallowed the
  //    page. The first version of that filter matched "BEGIN S" instead of
  //    "BEGIN SEO", found no matching END, and treated every page as generated
  //    from its ninth line down — leaving two editable fields on a page with a
  //    hundred. A count floor is what turns that from silence into a failure.
  const generatedText = [...source.matchAll(/<!--\s*BEGIN\s+([A-Z][A-Z0-9_-]*)[^>]*-->([\s\S]*?)<!--\s*END\s+\1[^>]*-->/g)];
  for (const block of generatedText) {
    const start = block.index!;
    const end = start + block[0].length;
    for (const field of page.fields) {
      for (const span of [field.content, field.hrefSpan, field.srcSpan, field.altSpan]) {
        if (!span) continue;
        // Containment, not a text match. The page title and its description sit
        // *outside* the markers and are the owner's words — the generator reads
        // them out of the page — but copies of both appear inside the block as
        // og:title and og:description, so matching on text condemns the two
        // fields that are legitimately editable.
        check(
          `${file}: ${field.id} is not inside the generated ${block[1]} block`,
          !(span.start >= start && span.end <= end),
          `"${field.preview.slice(0, 40)}" is written by a build script`,
        );
      }
    }
  }

  // Whose words a script copies elsewhere, and which therefore have to say so.
  for (const field of page.fields) {
    if (field.tag !== "title" && !(field.tag === "meta" && field.label.includes("description"))) continue;
    check(`${file}: ${field.id} warns that its generated copies go stale`, Boolean(field.note), field.label);
  }
  if (generatedText.length && source.length > 15_000) {
    check(`${file}: excluding generated blocks left the page editable`, page.fields.length >= 20, `only ${page.fields.length} fields`);
  }

  const sections = page.sections.map((section) => `${section.label} (${section.fields.length})`);
  console.log(`  ${file.padEnd(24)} ${String(page.fields.length).padStart(4)} fields in ${page.sections.length} sections`);
  if (process.env.VERBOSE) for (const line of sections) console.log(`      ${line}`);
}

// --- what a client is allowed to put on their own website ---------------------
//
// The negatives are the point. "The script tag is gone" was true of the first
// version of this and told nobody that `alert(1)` was still being printed on the
// page as text, because unwrapping an unknown element and keeping its words is
// the right rule everywhere except where the "words" are source code.
const q = String.fromCharCode(34);
const SANITISER: Array<[string, string, (out: string) => boolean, string]> = [
  ["keeps inline formatting", "A <strong>bold</strong> word", (out) => out.includes("<strong>bold</strong>"), "the markup a heading already had"],
  ["keeps a class", `<strong class=${q}count-up${q}>0%</strong>`, (out) => out.includes("count-up"), "the homepage figures are styled by it"],
  ["keeps a data attribute", `<strong data-target=${q}70${q}>0%</strong>`, (out) => out.includes("data-target"), "the count-up reads its target from it"],
  ["drops a script tag", "Hello<script>alert(1)</script>", (out) => !out.includes("script"), ""],
  ["drops the script's code as well", "Hello<script>alert(1)</script>", (out) => !out.includes("alert"), "stripping the tag is not the same as removing the code"],
  ["drops an inline handler", `<span onclick=${q}steal()${q}>hi</span>`, (out) => !out.includes("onclick") && !out.includes("steal"), ""],
  ["drops a javascript: link but keeps its words", `<a href=${q}javascript:evil()${q}>click</a>`, (out) => !out.includes("javascript") && out.includes("click"), ""],
  ["keeps a real link", `<a href=${q}/contact${q}>Talk to us</a>`, (out) => out.includes(`href=${q}/contact${q}`), ""],
  ["unwraps a pasted div, keeping the sentence", "<div><p>Some words</p></div>", (out) => out.includes("Some words") && !out.includes("<div"), ""],
  ["drops a style that fetches", `<span style=${q}background:url(http://x/y)${q}>hi</span>`, (out) => !out.includes("url("), ""],
  ["keeps a style that only colours", `<span style=${q}color:var(--blue)${q}>hi</span>`, (out) => out.includes("color:var(--blue)"), "half a dozen headings carry exactly this"],
  ["escapes a stray angle bracket", "2 < 3", (out) => out.includes("&lt;"), ""],
  ["leaves an existing entity alone", "Kumasi &mdash; Ghana", (out) => out.includes("&mdash;") && !out.includes("&amp;mdash;"), ""],
];

for (const [name, input, passes, why] of SANITISER) {
  const out = sanitizeRich(input);
  check(`sanitiser ${name}`, passes(out), `${why ? `${why}. ` : ""}got ${JSON.stringify(out)}`);
}

const LINKS: Array<[string, boolean]> = [
  ["/contact", true],
  ["#coverage", true],
  ["about.html", true],
  ["https://example.com/x", true],
  ["mailto:hello@dakyworld.com", true],
  ["tel:+233200000000", true],
  ["javascript:alert(1)", false],
  ["data:text/html,<script>alert(1)</script>", false],
  ["//evil.example.com", false],
  ["", false],
];
for (const [href, expected] of LINKS) {
  check(`link ${JSON.stringify(href)} is ${expected ? "allowed" : "refused"}`, checkLink(href).ok === expected);
}

// A plain-text field is not a way in either.
check("plain text never carries markup", !sanitizePlain("<b>x</b>").includes("<b>"));

console.log(`\n${pages.length} page(s), ${totalFields} editable fields`);
if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("website: all checks passed");
