/**
 * Words that live inside an attribute, written so they cannot leave it.
 *
 * Until 12 Oct 2026 a page's search description, its social preview copy and
 * its keywords were written into `<meta content="…">` exactly as typed, with
 * only `&`, `<` and `>` escaped. A description of
 * `0;url=https://evil.example/phish" http-equiv="refresh` closed the attribute
 * and opened a second one, and once published every visitor of the page was
 * sent to that address — while the editor's preview, which strips refresh tags,
 * showed a normal page. Any EDITOR could do it from the ordinary draft save.
 * Pictures, links and alt text had the same gap on any imported page that
 * quoted its attributes with `'`, because only `"` was escaped.
 *
 * Two doors: `applyValues` escapes for whichever quote the page used (and
 * quotes a bare value), and the publish guard refuses a refresh, security
 * policy, cookie or `<base>` that the source page did not already have.
 *
 * Half of it is negatives: an apostrophe in a double-quoted description stays
 * an apostrophe, an entity stays the entity, and a page that always had a
 * refresh tag is not held up by it.
 *
 * Pure functions: no rows, no network.
 */
import assert from "node:assert/strict";
import { applyValues, readPage, sanitizeValue, type FieldValue, type SiteField } from "../src/services/website/index.js";
import { attr, decodeEntities, parseHtml, walk, type ElementNode } from "../src/services/website/parse.js";
import { runPublishGuardChecks } from "../src/services/websitePublishGuard.js";

let checks = 0;
let failed = 0;
const ok = (name: string, condition: unknown, detail = "") => {
  checks++;
  if (condition) console.log(`  ok    ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const page = (head: string, body = "<main><h1>Plumbing in Accra</h1><p>We fix pipes.</p></main>") =>
  `<!doctype html><html><head><title>Shop</title>${head}</head><body>${body}</body></html>`;

function fieldById(html: string, id: string): SiteField {
  const field = readPage(html).sections.flatMap((section) => section.fields).find((candidate) => candidate.id === id);
  assert.ok(field, `no field ${id} on the page`);
  return field;
}

function fieldWhere(html: string, test: (field: SiteField) => boolean): SiteField {
  const field = readPage(html).sections.flatMap((section) => section.fields).find(test);
  assert.ok(field, "no matching field on the page");
  return field;
}

/** Through the real save path: what the draft route stores, then what publishing writes. */
function edit(html: string, field: SiteField, raw: Parameters<typeof sanitizeValue>[1]): string {
  const stored = sanitizeValue(field, raw);
  const result = applyValues(html, { [field.id]: stored });
  assert.equal(result.conflicts.length, 0, "the edit conflicted");
  return result.html;
}

const elements = (html: string, tag: string): ElementNode[] => [...walk(parseHtml(html))].filter((node) => node.tag === tag);
const metas = (html: string) => elements(html, "meta");
const attrNames = (node: ElementNode) => node.attrs.map((candidate) => candidate.name);

const ATTACK = '0;url=https://evil.example/phish" http-equiv="refresh';
const SINGLE_ATTACK = "0;url=https://evil.example/phish' http-equiv='refresh";

console.log("A description cannot become a redirect");
{
  const html = page('<meta name="description" content="Our shop">');
  const out = edit(html, fieldById(html, "meta.1"), { value: ATTACK });
  const tags = metas(out);
  ok("still exactly one meta tag", tags.length === 1, out);
  ok("with no http-equiv on it", !attrNames(tags[0]!).includes("http-equiv"), attrNames(tags[0]!).join(","));
  ok("and the words typed are the words a visitor's browser reads", decodeEntities(attr(tags[0]!, "content") ?? "") === ATTACK, attr(tags[0]!, "content"));
}
{
  const html = page("<meta property='og:description' content='Our shop'>");
  const out = edit(html, fieldById(html, "meta.og_description"), { value: SINGLE_ATTACK });
  const tag = metas(out)[0]!;
  ok("a single-quoted social description gains no attribute either", attrNames(tag).join(",") === "property,content", attrNames(tag).join(","));
  ok("and reads back as typed", decodeEntities(attr(tag, "content") ?? "") === SINGLE_ATTACK, attr(tag, "content"));
}
{
  const html = page("<meta name=keywords content=plumbing>");
  const out = edit(html, fieldById(html, "meta.keywords"), { value: "pipes http-equiv=refresh" });
  const tag = metas(out)[0]!;
  ok("a bare value is quoted, so a space cannot start an attribute", attrNames(tag).join(",") === "name,content", out.match(/<meta[^>]*>/)?.[0]);
  ok("and keeps every word", attr(tag, "content") === "pipes http-equiv=refresh", attr(tag, "content"));
}
{
  const html = page('<meta property="og:title" content>');
  const out = edit(html, fieldById(html, "meta.og_title"), { value: 'x" http-equiv="refresh' });
  const tag = metas(out)[0]!;
  ok("a value-less attribute is given one, with its own =", attrNames(tag).join(",") === "property,content" && /content="/.test(out), out.match(/<meta[^>]*>/)?.[0]);
}
{
  // Drafts saved before the fix hold the quotes raw. applyValues is the door
  // they still pass through, so the escaping lives there.
  const html = page('<meta name="description" content="Our shop">');
  const stale: Record<string, FieldValue> = { "meta.1": { value: ATTACK } };
  const out = applyValues(html, stale).html;
  ok("a draft stored before the fix publishes safely too", !attrNames(metas(out)[0]!).includes("http-equiv"), out.match(/<meta[^>]*>/)?.[0]);
}

console.log("\nOrdinary words are left as words");
{
  const html = page('<meta name="description" content="Our shop">');
  const typed = 'We\'re "the best" & cheapest &mdash; call us';
  const out = edit(html, fieldById(html, "meta.1"), { value: typed });
  const written = out.match(/content="([^"]*)"/)?.[1] ?? "";
  ok("an apostrophe in a double-quoted description stays an apostrophe", written.includes("We're"), written);
  ok("a double quote is escaped", written.includes("&quot;the best&quot;"), written);
  ok("an entity already written is not escaped a second time", written.includes("&mdash;") && !written.includes("&amp;mdash;"), written);
  ok("a bare ampersand is escaped once", written.includes("&amp; cheapest"), written);
  ok("and the browser reads exactly what was typed", decodeEntities(written) === typed.replace("&mdash;", "—"), decodeEntities(written));
}
{
  const html = page("<meta name='description' content='Our shop'>");
  const out = edit(html, fieldById(html, "meta.1"), { value: 'A "quoted" word' });
  ok("a double quote in a single-quoted attribute is left alone", out.includes(`content='A "quoted" word'`), out.match(/<meta[^>]*>/)?.[0]);
}

console.log("\nPictures, links and alt text on a page that quotes with '");
{
  const html = page("", "<main><h1>Hi</h1><img src='/a.png' alt='A pipe'></main>");
  const image = fieldWhere(html, (field) => field.kind === "image" && field.tag === "img");
  const out = edit(html, image, { value: "/b.png' onerror='alert(1)" });
  const img = elements(out, "img")[0]!;
  ok("a picture address cannot add an onerror", !attrNames(img).includes("onerror"), out.match(/<img[^>]*>/)?.[0]);
  const alt = edit(html, image, { alt: "x' onerload='alert(1)" });
  ok("nor can its alt text add a handler", attrNames(elements(alt, "img")[0]!).join(",") === "src,alt", alt.match(/<img[^>]*>/)?.[0]);
  ok("and the alt reads back as typed", attr(elements(alt, "img")[0]!, "alt")?.replace(/&#39;/g, "'") === "x' onerload='alert(1)", attr(elements(alt, "img")[0]!, "alt"));
}
{
  const html = page("", "<main><h1>Hi</h1><a href='/contact'>Contact us</a></main>");
  const link = fieldWhere(html, (field) => field.hrefSpan !== undefined);
  const out = edit(html, link, { href: "/contact' onclick='alert(1)" });
  const anchor = elements(out, "a")[0]!;
  ok("a link address cannot add an onclick", !attrNames(anchor).includes("onclick"), out.match(/<a[^>]*>/)?.[0]);
}
{
  const html = page("", '<main><h1>Hi</h1><img src="/a.png" alt="A pipe"></main>');
  const image = fieldWhere(html, (field) => field.kind === "image" && field.tag === "img");
  const out = edit(html, image, { alt: "Ama's pipe" });
  ok("an apostrophe in double-quoted alt text is written as an apostrophe", out.includes(`alt="Ama's pipe"`), out.match(/<img[^>]*>/)?.[0]);
}

console.log("\nThe publish guard refuses a page control the page did not have");
{
  const source = page('<meta name="description" content="Our shop">');
  const planted = page('<meta name="description" content="x" http-equiv="refresh">');
  const guard = runPublishGuardChecks({ candidateHtml: planted, sourceHtml: source });
  ok("a new refresh tag blocks the publish", !guard.canPublish && !guard.checks.noNewPageControls, guard.summary);
  ok("and says what it is", guard.blockers.some((issue) => issue.description.includes("refresh redirect")), guard.blockers.map((issue) => issue.description).join(" | "));

  const encoded = page('<meta HTTP-EQUIV="&#82;efresh" content="0;url=https://evil.example">');
  ok("so does one written with an entity and in capitals", !runPublishGuardChecks({ candidateHtml: encoded, sourceHtml: source }).canPublish);
  for (const [label, head] of [
    ["a security policy", '<meta http-equiv="Content-Security-Policy" content="default-src *">'],
    ["a cookie", '<meta http-equiv="set-cookie" content="a=b">'],
    ["a base address", '<base href="https://evil.example/">'],
  ] as const) {
    ok(`and ${label}`, !runPublishGuardChecks({ candidateHtml: page(head), sourceHtml: source }).checks.noNewPageControls);
  }

  const already = page('<meta http-equiv="refresh" content="30">');
  const kept = runPublishGuardChecks({ candidateHtml: already.replace("<title>Shop</title>", "<title>Shop and more</title>"), sourceHtml: already });
  ok("a page that always had one publishes as before", kept.checks.noNewPageControls, kept.summary);
  const ordinary = runPublishGuardChecks({ candidateHtml: page('<meta name="description" content="New words">'), sourceHtml: source });
  ok("and an ordinary edit is not touched by it", ordinary.checks.noNewPageControls && !ordinary.blockers.some((issue) => issue.id.startsWith("new-page-control")), ordinary.summary);
}

console.log(`\n${checks - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
