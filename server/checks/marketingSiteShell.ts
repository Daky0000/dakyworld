/**
 * Does the header in the markup still say what the header in the script says?
 *
 * **The defect this exists for.** Every page of dakyworld.com ships a full
 * `<header class="site-header">` and a full `<footer>` in its markup, and then
 * `assets/site.js` throws both away on load and replaces them with a copy of
 * the same markup held as a string inside that file:
 *
 *     existingHeader.outerHTML = HEADER_HTML;
 *
 * Both copies are load-bearing and neither can simply be deleted. The markup is
 * what a crawler reads, what renders before the script runs, and what is left
 * if the script never arrives. The string is what every visitor actually ends
 * up looking at. The failure mode is therefore silent and one-directional: edit
 * the nav in the seventeen HTML files and the change is real to Google and
 * invisible to people, because the script overwrites it a moment later. The
 * edit looks done. It is not done.
 *
 * So this asserts the one property that makes the arrangement safe — that the
 * two copies agree — and fails with the exact links that differ when they do
 * not. It does not care about whitespace, attribute order or the markup around
 * the links; only about which pages the navigation offers, and in what order,
 * because that is the thing that drifted.
 *
 * Files only. No database, no API key, no network.
 *   npx tsx checks/marketingSiteShell.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const failures: string[] = [];
let passed = 0;

function check(name: string, ok: boolean): void {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

/** The repository root, where the marketing pages live. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The pages that carry the shared shell. Read from disk rather than listed,
 * so a new page is covered the day it is added rather than the day somebody
 * remembers to add it here.
 *
 * The redirect stubs are excluded by the same rule that makes them stubs: they
 * carry a header but no nav and no footer, because they exist to bounce a
 * visitor to /pricing and nothing else.
 */
const STUBS = new Set(["monthly-support.html", "one-time-projects.html", "foundation-build.html"]);
/** Not a page of the website — an internal document that happens to live here. */
const NOT_A_PAGE = new Set(["AGENT_SYSTEM_PLAN.html"]);

const pages = readdirSync(root)
  .filter((name) => name.endsWith(".html") && !STUBS.has(name) && !NOT_A_PAGE.has(name))
  .sort();

/** Every `href` inside the first element matching `open`…`close`, in order. */
function linksWithin(html: string, open: RegExp, close: string): string[] | null {
  const start = html.search(open);
  if (start === -1) return null;
  const end = html.indexOf(close, start);
  if (end === -1) return null;
  return [...html.slice(start, end).matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

const siteJs = readFileSync(join(root, "assets", "site.js"), "utf8");

/**
 * The script holds its markup as an array of single-quoted lines that are
 * joined, so the hrefs are read out of the source text rather than by running
 * it. Anchored to the HEADER_HTML / FOOTER_HTML assignments so a stray href
 * elsewhere in the file cannot be mistaken for part of the shell.
 */
function scriptBlock(name: string): string {
  const start = siteJs.indexOf(`var ${name} = [`);
  if (start === -1) throw new Error(`site.js no longer declares ${name}`);
  const end = siteJs.indexOf("].join(", start);
  if (end === -1) throw new Error(`could not find the end of ${name} in site.js`);
  return siteJs.slice(start, end);
}

const scriptNav = [...scriptBlock("HEADER_HTML").matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

// The brand link is in both copies and is not navigation; the comparison is
// about the nav links, so it is dropped from both sides the same way.
const navOnly = (links: string[]) => links.filter((href) => href !== "/");

check("site.js still declares a header to inject", scriptNav.length > 0);
check("its nav offers the pages the sitemap does", navOnly(scriptNav).length >= 7);

const expected = navOnly(scriptNav).join(" ");

for (const page of pages) {
  const html = readFileSync(join(root, page), "utf8");

  const markupNav = linksWithin(html, /<nav class="main-nav"/, "</nav>");
  if (markupNav === null) {
    check(`${page} carries a main nav in its markup`, false);
    continue;
  }

  const actual = navOnly(markupNav).join(" ");
  const agrees = actual === expected;
  check(`${page} nav matches the copy in site.js`, agrees);
  if (!agrees) {
    failures.push(`${page}: markup has [${actual}] but site.js injects [${expected}]`);
  }
}

/**
 * The injected shell references its images by root-absolute path.
 *
 * A relative `assets/…` here renders correctly on /pricing and breaks on any
 * URL with another segment in it — most visibly the 404 page, which is served
 * at whatever address was wrong. The markup was fixed for this; the script
 * holds the second copy and has to stay fixed too.
 */
const shellSrcs = [...(scriptBlock("HEADER_HTML") + scriptBlock("FOOTER_HTML")).matchAll(/src="([^"]*)"/g)].map((m) => m[1]);
check("the injected shell has images to check", shellSrcs.length > 0);
for (const src of shellSrcs) {
  check(`site.js references ${src} absolutely`, src.startsWith("/") || src.startsWith("http"));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((name) => `  - ${name}`).join("\n"));
  process.exit(1);
}
