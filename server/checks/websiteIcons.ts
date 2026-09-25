/**
 * SVG files and icons in the Website Builder. No database.
 *
 *   npx tsx checks/websiteIcons.ts
 *
 * Three things are held here. An SVG is only ever stored as the sanitiser
 * rebuilt it, so nothing that can run survives. An inline icon is a field of
 * its own, and a button's icon belongs to the button, without either one
 * moving the ids that older drafts were written against. And an icon is
 * changed by naming one, never by sending markup, so the only SVG the editor
 * can write into somebody's page is one from its own library.
 */
import assert from "node:assert/strict";
import { sanitizeSvg, SvgRejected, looksLikeSvg } from "../src/lib/svgSanitize.js";
import { optimizeImageBuffer } from "../src/lib/imageOptimization.js";
import { applyValues, readPage, type SiteField } from "../src/services/website/regions.js";
import { sanitizeValue, sanitizeSharedValue } from "../src/services/website/index.js";
import { ICON_LIBRARY, iconChoiceMarkup, safeIconSrc } from "../src/shared/websiteIcons.js";
import { readTailwindConfig, tailwindCdnCss, usesTailwindCdn } from "../src/services/website/cdnStyles.js";

let checks = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks += 1;
}
function equal(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name);
  checks += 1;
}
function rejects(name: string, fn: () => unknown) {
  assert.throws(fn, SvgRejected, name);
  checks += 1;
}

// --- The sanitiser -----------------------------------------------------------

const plain = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M5 12h14" stroke="currentColor"/></svg>';
const clean = sanitizeSvg(plain);
check("a plain icon survives", clean.includes('<path d="M5 12h14" stroke="currentColor"/>'));
check("its casing is SVG's, not HTML's", clean.includes('viewBox="0 0 24 24"'));
check("it gains the namespace a file needs", clean.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));

const hostile = [
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>',
  '<svg onload="alert(1)"><rect width="1" height="1"/></svg>',
  '<svg><rect width="1" height="1" onclick="alert(1)"/></svg>',
  '<svg><a href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>',
  '<svg><use href="&#106;avascript:alert(1)"/><rect width="1" height="1"/></svg>',
  '<svg><foreignObject><iframe src="https://evil.example"></iframe></foreignObject><rect width="1" height="1"/></svg>',
  '<svg><style>@import url(https://evil.example/x.css)</style><rect width="1" height="1"/></svg>',
  '<svg><rect width="1" height="1" fill="url(https://evil.example/track)"/></svg>',
  '<svg><rect width="1" height="1" style="fill:url(https://evil.example/t)"/></svg>',
  '<svg><image href="https://evil.example/track.png" width="1" height="1"/><rect width="1" height="1"/></svg>',
  '<svg><use xlink:href="https://evil.example/sprite.svg#a"/><rect width="1" height="1"/></svg>',
  '<svg><set attributeName="onmouseover" to="alert(1)"/><rect width="1" height="1"/></svg>',
  '<svg><animate attributeName="href" values="javascript:alert(1)"/><rect width="1" height="1"/></svg>',
  '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]><svg><rect width="1" height="1"/><text>&x;</text></svg>',
];
for (const input of hostile) {
  const out = sanitizeSvg(input).toLowerCase();
  check(`nothing executable survives: ${input.slice(0, 60)}`, !/script|onload|onclick|onmouseover|javascript|foreignobject|iframe|@import|evil\.example|<!entity|<set|<animate/.test(out));
  check(`and the drawing does: ${input.slice(0, 40)}`, out.includes("<rect"));
}
check("url(#gradient) inside the file is kept", sanitizeSvg('<svg><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="1" height="1" fill="url(#g)"/></svg>').includes('fill="url(#g)"'));
check("a fragment href is kept", sanitizeSvg('<svg><defs><path id="p" d="M0 0h1"/></defs><use href="#p"/></svg>').includes('href="#p"'));
check("an inline raster image is kept", sanitizeSvg('<svg><image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/></svg>').includes("data:image/png;base64"));
rejects("HTML is not SVG", () => sanitizeSvg("<html><body>hi</body></html>"));
rejects("a tag that never closes is refused", () => sanitizeSvg('<svg><rect width="1"'));
rejects("an SVG with nothing to draw once cleaned is refused", () => sanitizeSvg("<svg><script>alert(1)</script></svg>"));
check("SVG bytes are recognised", looksLikeSvg(Buffer.from('<?xml version="1.0"?>\n<!-- made by hand -->\n<svg viewBox="0 0 1 1"></svg>')));
check("a PNG is not SVG", !looksLikeSvg(Buffer.from([0x89, 0x50, 0x4e, 0x47])));

// --- Upload and import both go through it ------------------------------------

const stored = await optimizeImageBuffer(Buffer.from('<svg onload="x()"><circle r="4" cx="5" cy="5"/></svg>'));
equal("an uploaded SVG is stored as SVG", [stored.contentType, stored.extension], ["image/svg+xml", "svg"]);
check("and stored as rebuilt, not as sent", !stored.content.toString("utf8").includes("onload"));

// --- Reading icons off a page ------------------------------------------------

const page = `<!doctype html><html><head><title>T</title></head><body>
<header><a class="brand" href="/"><svg class="mark" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></a></header>
<main><section>
  <h1>Heading</h1>
  <p>Words with <svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg> an inline glyph.</p>
  <a class="btn btn-primary" href="/book">Book a call <svg class="arrow" width="16" height="16" viewBox="0 0 24 24"><path d="M5 12h14"/></svg></a>
  <a class="btn btn-dark" href="/plans">See plans</a>
  <a class="btn" href="/call"><i class="fa fa-phone"></i> Call us</a>
  <button class="btn" type="button" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12"/></svg></button>
  <div class="features"><svg aria-label="Fast" viewBox="0 0 24 24"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg><p>Fast</p></div>
</section></main></body></html>`;

const read = readPage(page);
const byLabel = (predicate: (field: SiteField) => boolean) => read.fields.filter(predicate);
const book = byLabel((f) => f.kind === "button" && f.href === "/book")[0]!;
const plans = byLabel((f) => f.kind === "button" && f.href === "/plans")[0]!;
const call = byLabel((f) => f.kind === "button" && f.href === "/call")[0]!;
const icons = byLabel((f) => f.kind === "icon");

equal("a button's trailing SVG is its icon", [book.iconType, book.iconPosition], ["svg", "end"]);
equal("and the words stay just the words", book.value, "Book a call");
equal("an icon font before the words is an icon too", [call.iconType, call.iconPosition], ["font", "start"]);
check("a button with no icon may be given one", plans.iconAddable === true && plans.icon === undefined);
check("an inline SVG by itself is an icon field", icons.some((f) => f.preview === "Fast"));
check("the brand mark inside a link is an icon field", icons.some((f) => f.icon?.includes('class="mark"')));
check("an icon-only button's SVG is an icon field", icons.some((f) => f.icon?.includes("M6 6l12 12")));
check("an SVG inside a sentence stays part of the sentence", !icons.some((f) => f.icon?.includes('<rect width="1" height="1"/>')));
check("a button's icon is not offered twice", !icons.some((f) => f.icon?.includes('class="arrow"')));
check("icon ids have their own namespace", icons.every((f) => /^icon\.\d+$/.test(f.id)));

const withoutIcons = readPage(page.replace(/<svg[\s\S]*?<\/svg>/g, ""));
// Kinds may differ (a sentence holding an SVG is rich text), ids may not.
const idsOf = (fields: SiteField[]) => fields.filter((f) => f.kind !== "icon" && !f.id.startsWith("layout.")).map((f) => f.id);
equal("adding icon fields moves no existing id", idsOf(read.fields), idsOf(withoutIcons.fields));

// --- Changing them -----------------------------------------------------------

const swapped = applyValues(page, { [book.id]: { icon: { library: "arrow-up-right" }, originalIcon: book.icon } });
check("a button's icon is swapped for a library icon", swapped.html.includes('data-dw-icon="arrow-up-right"'));
check("the new icon keeps the old one's class and size", /<svg[^>]*width="16" height="16" class="arrow"[^>]*data-dw-icon="arrow-up-right"/.test(swapped.html));
check("and the old drawing is gone", !swapped.html.includes('<path d="M5 12h14"/></svg></a>'));
check("the words are untouched", swapped.html.includes("Book a call <svg"));

const removed = applyValues(page, { [call.id]: { icon: null, originalIcon: call.icon } });
check("an icon can be taken away", !removed.html.includes("fa-phone") && removed.html.includes("Call us"));

const added = applyValues(page, { [plans.id]: { icon: { library: "arrow-right" }, iconPosition: "end" } });
check("a button with none can be given one, after its words", /See plans <svg[^>]*data-dw-icon="arrow-right"/.test(added.html));
check("drawn in the button's own colour, at the size of its text", /data-dw-icon="arrow-right"/.test(added.html) && added.html.includes('stroke="currentColor"') && added.html.includes('width="1em"'));

const both = applyValues(page, { [plans.id]: { value: "Compare plans", icon: { library: "arrow-right" }, iconPosition: "start" } });
check("new words and a new icon land together", /<svg[^>]*data-dw-icon="arrow-right"[^>]*>.*<\/svg> Compare plans<\/a>/.test(both.html));

const image = applyValues(page, { [book.id]: { icon: { src: "/assets/dw/arrow.svg" } } });
check("an image file can be the icon", image.html.includes('<img src="/assets/dw/arrow.svg" alt="" aria-hidden="true"'));

const standalone = icons.find((f) => f.preview === "Fast")!;
const replaced = applyValues(page, { [standalone.id]: { icon: { library: "zap" } } });
check("a standalone icon is swapped whole", replaced.html.includes('data-dw-icon="zap"') && !replaced.html.includes('aria-label="Fast"'));

const moved = applyValues(page.replace('class="arrow"', 'class="arrow big"'), { [readPage(page.replace('class="arrow"', 'class="arrow big"')).fields.find((f) => f.href === "/book")!.id]: { icon: { library: "x" }, originalIcon: book.icon } });
equal("an icon a developer changed since the draft is a conflict, not an overwrite", moved.changed.length, 0);
check("and it is reported", moved.conflicts.length === 1);

// --- Only a choice is accepted, never markup ---------------------------------

equal("a real library icon is accepted", sanitizeValue(book, { icon: { library: "check" } }).icon, { library: "check" });
equal("a name the library does not have is dropped", sanitizeValue(book, { icon: { library: "not-an-icon" } }).icon, undefined);
equal("a script address is dropped", sanitizeValue(book, { icon: { src: "javascript:alert(1)" } }).icon, undefined);
equal("a data address is dropped", sanitizeValue(book, { icon: { src: "data:image/svg+xml,<svg onload=x>" } }).icon, undefined);
equal("an address with a quote in it is dropped", sanitizeValue(book, { icon: { src: '/a.svg" onerror="x' } }).icon, undefined);
equal("markup smuggled in as a name is dropped", sanitizeValue(book, { icon: { library: "<svg onload=x>" } }).icon, undefined);
check("an accepted choice is stamped with what the page had", sanitizeValue(book, { icon: { library: "check" } }).originalIcon === book.icon);
equal("taking away an icon that is not there is nothing", sanitizeValue(plans, { icon: null }).icon, undefined);
equal("a new icon's side is kept", sanitizeValue(plans, { icon: { library: "check" }, iconPosition: "end" }).iconPosition, "end");
equal("an icon's drawing cannot be typed over", sanitizeValue(standalone, { value: "<svg onload=x>" }).value, undefined);
equal("shared elements take the same choices", sanitizeSharedValue(book, { icon: { library: "check" } }).icon, { library: "check" });
equal("and refuse the same smuggling", sanitizeSharedValue(book, { icon: { src: "javascript:x" } }).icon, undefined);

// --- The library itself ------------------------------------------------------

check("every library icon becomes markup", ICON_LIBRARY.every((icon) => iconChoiceMarkup({ library: icon.name })?.startsWith("<svg")));
check("and every one survives the sanitiser unchanged in substance", ICON_LIBRARY.every((icon) => sanitizeSvg(iconChoiceMarkup({ library: icon.name })!).includes("<")));
check("library names are unique", new Set(ICON_LIBRARY.map((icon) => icon.name)).size === ICON_LIBRARY.length);
equal("a site path is a safe icon address", safeIconSrc("/assets/dw/a.svg"), "/assets/dw/a.svg");
equal("https is a safe icon address", safeIconSrc("https://cdn.example/a.png"), "https://cdn.example/a.png");
equal("a protocol-relative address is not", safeIconSrc("//evil.example/a.png"), null);

// --- Pages exported from AI builders (Tailwind CDN, Material Symbols) ------

const exported = `<!doctype html><html><head><title>T</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<script id="tailwind-config">tailwind.config = { darkMode: "class", theme: { extend: { colors: { "on-secondary-fixed": "#1c1c1a", "primary": "#7a5900" }, spacing: { "gutter": "20px" } } }, plugins: [] }</script>
</head><body>
<nav><a class="text-primary border-b-2 border-primary" href="/products">Products</a></nav>
<div class="flex items-center"><button class="btn-primary px-6 py-2">Request a Quote</button></div>
<div class="flex"><button class="btn-primary px-8 py-4">Request a Quote <span class="material-symbols-outlined ml-2 text-xl">arrow_forward</span></button></div>
<a class="card" href="/q"><div class="w-12 h-12"><span class="material-symbols-outlined text-2xl">request_quote</span></div><h3>Request a quotation</h3></a>
<a class="flex items-center" href="#"><svg class="w-4 h-4 mr-1 fill-current" viewbox="0 0 24 24"><path d="M1 1h2"/></svg> WhatsApp us</a>
</body></html>`;
const ex = readPage(exported).fields;
const quote = ex.filter((f) => f.kind === "button" && f.value === "Request a Quote");
equal("a button inside a wrapper is a button, not the wrapper's markup", quote.length, 2);
check("no field's words are a button's markup", !ex.some((f) => /<button/i.test(f.value)));
check("a Material Symbols arrow after the words is the button's icon", quote.some((f) => f.iconType === "font" && f.iconPosition === "end" && f.icon?.includes("arrow_forward")));
check("and the words no longer carry its name", !quote.some((f) => f.value.includes("arrow_forward")));
check("the other quote button may be given one", quote.some((f) => f.iconAddable));
check("a box holding only a Material icon is an icon, not the word request_quote", ex.some((f) => f.kind === "icon" && f.iconType === "font" && f.preview === "request quote"));
equal("`text-primary` on a nav link is a colour, not a button", ex.find((f) => f.href === "/products")?.kind, "link");
const ligatureSwap = applyValues(exported, { [quote.find((f) => f.icon)!.id]: { icon: { library: "arrow-right" } } });
check("a font icon is swapped for a drawn one, keeping its size class", /<svg[^>]*class="material-symbols-outlined ml-2 text-xl"[^>]*data-dw-icon="arrow-right"/.test(ligatureSwap.html));

check("a Tailwind CDN page is recognised", usesTailwindCdn(exported) && !usesTailwindCdn("<html><script src=\"/app.js\"></script></html>"));
equal("its config is read as data", (readTailwindConfig(exported)?.theme as { extend: { colors: Record<string, string> } }).extend.colors.primary, "#7a5900");
check("but only the design parts of it", readTailwindConfig(exported)?.plugins === undefined);
equal("a config that is code is not run, and not used", readTailwindConfig("<script>tailwind.config = { theme: { extend: require('x') } }</script>"), null);
const built = await tailwindCdnCss(exported);
check("the page's utilities are built", /\.w-4\s*\{\s*width:\s*1rem/.test(built ?? "") && /\.h-4\s*\{/.test(built ?? ""));
check("with its own colours", /\.bg-on-secondary-fixed|\.text-primary\s*\{[^}]*122 89 0|\.text-primary\s*\{[^}]*#7a5900/i.test(built ?? "") || (built ?? "").includes(".text-primary"));
check("and the plugins its script asked for", (built ?? "").includes("[type='text']"));
check("nothing in it can close the style element it goes in", !/<\/style/i.test(built ?? ""));
equal("a page without the CDN gets nothing built", await tailwindCdnCss("<html><body class=\"w-4\">x</body></html>"), null);

// --- Brand logo & media element detection and replacement -------------------

const brandPage = `<!doctype html><html><body><header><a class="brand" href="/"><div class="brand-face" aria-hidden="true"><i></i></div><div class="brand-type"><strong>Nevermind</strong></div></a></header></body></html>`;
const brandRead = readPage(brandPage);
const brandIcon = brandRead.fields.find((f) => f.kind === "icon" && f.label.includes("brand-face"));
check("a brand-face div is collected as an icon field", Boolean(brandIcon));
check("and it is not coerced into a layout container", !brandRead.fields.some((f) => f.kind === "container" && f.label.includes("brand-face")));

if (brandIcon) {
  const brandSwapped = applyValues(brandPage, { [brandIcon.id]: { icon: { library: "zap" } } });
  check("swapping brand icon replaces inner <i> drawing", !brandSwapped.html.includes("<i></i>") && brandSwapped.html.includes('data-dw-icon="zap"'));
  const brandImg = applyValues(brandPage, { [brandIcon.id]: { icon: { src: "/assets/dw/logo.png" } } });
  check("replacing brand icon with image writes <img> and drops old div markup", brandImg.html.includes('<img src="/assets/dw/logo.png"') && !brandImg.html.includes('<div class="brand-face"'));
}

console.log(`websiteIcons: ${checks} checks passed`);
