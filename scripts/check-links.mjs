#!/usr/bin/env node
/**
 * Checks every internal link on the marketing site, and can fix the one thing
 * that was actually wrong with them.
 *
 * The site is served from GitHub Pages, which answers `/pricing` with
 * `pricing.html`. Both spellings work, which is exactly why the inconsistency
 * survived: twenty-one links across four pages pointed at `/pricing.html`,
 * `/contact.html?plan=growth` and so on while every canonical, every nav item
 * and every footer link used the extensionless form. Nothing looked broken.
 *
 * What it costs is real all the same. Two URLs for one page means a crawler
 * finds both, has to decide they are the same thing, and splits whatever
 * authority the internal links carry until it does. The canonical tag resolves
 * it eventually; pointing at the canonical form in the first place means there
 * is nothing to resolve.
 *
 *   node scripts/check-links.mjs        # report
 *   node scripts/check-links.mjs --fix  # rewrite .html links to the canonical form
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const SKIP = new Set(["AGENT_SYSTEM_PLAN.html"]);
const pages = readdirSync(".").filter((f) => f.endsWith(".html") && !SKIP.has(f));
const known = new Set(pages.map((f) => `/${f.replace(/\.html$/, "")}`).concat(["/", "/index"]));

/** Commented-out markup is not a link. `insights.html` carries a placeholder for an article that does not exist yet. */
const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

const fix = process.argv.includes("--fix");
const problems = [];
const inbound = new Map();
let rewritten = 0;

for (const file of pages) {
  const original = readFileSync(file, "utf8");
  const live = withoutComments(original);

  for (const match of live.matchAll(/href="([^"]+)"/g)) {
    const raw = match[1];
    if (/^(https?:|mailto:|tel:|#|data:|javascript:)/i.test(raw)) continue;

    const path = raw.split("#")[0].split("?")[0];
    if (!path || path.startsWith("assets/") || path.startsWith("/assets/")) continue;

    const target = (path.startsWith("/") ? path : `/${path}`).replace(/\.html$/, "").replace(/\/$/, "") || "/";
    if (!inbound.has(target)) inbound.set(target, new Set());
    inbound.get(target).add(file);

    if (path.endsWith(".html")) problems.push([file, raw, "uses .html; every canonical is extensionless"]);
    else if (!known.has(target === "/" ? "/index" : target) && target !== "/") problems.push([file, raw, "no such page"]);
  }

  if (fix) {
    // Only inside href="…", and only where the path is one of ours — an
    // external .html link, or the placeholder in a comment, must not be touched.
    const next = original.replace(/href="(\/?[A-Za-z0-9._-]+)\.html((?:\?|#)[^"]*)?"/g, (whole, base, rest = "") => {
      const target = (base.startsWith("/") ? base : `/${base}`).replace(/^\/index$/, "");
      if (!known.has(target || "/index")) return whole;
      rewritten += 1;
      return `href="${target || "/"}${rest}"`;
    });
    if (next !== original) writeFileSync(file, next);
  }
}

if (fix) {
  console.log(`Rewrote ${rewritten} link(s) to the canonical extensionless form.`);
  process.exit(0);
}

const orphans = pages.filter((f) => {
  if (f === "404.html") return false;
  const self = `/${f.replace(/\.html$/, "")}`.replace(/^\/index$/, "/");
  return ![...(inbound.get(self) ?? [])].some((from) => from !== f);
});

console.log(`${pages.length} pages checked.\n`);
if (problems.length) {
  console.log("Problems:");
  for (const [file, link, why] of problems) console.log(`  ${file.padEnd(24)} ${link.padEnd(40)} ${why}`);
} else {
  console.log("No broken or non-canonical internal links.");
}
if (orphans.length) console.log(`\nNot linked from anywhere: ${orphans.join(", ")}`);

console.log("\nInbound internal links:");
for (const file of [...pages].sort()) {
  const self = `/${file.replace(/\.html$/, "")}`.replace(/^\/index$/, "/");
  const count = [...(inbound.get(self) ?? [])].filter((from) => from !== file).length;
  console.log(`  ${file.padEnd(26)} ${count}`);
}

process.exit(problems.length ? 1 : 0);
