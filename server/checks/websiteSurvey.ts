/**
 * The survey, against a small website that has all the things in it.
 *
 *   npx tsx checks/websiteSurvey.ts
 *
 * No database and no network: `surveySite` is given pages, so the fixtures here
 * are the website. Four pages is enough to tell "on more than one page" from
 * "on every page", which is the distinction the header and footer answers turn
 * on and the one a two-page fixture cannot make.
 *
 * What is deliberately *not* asserted is a specific ordering of unclassified
 * blocks: a survey that has to be right about the order of things it could not
 * name is asserting the implementation rather than the answer.
 */
import assert from "node:assert/strict";
import { kindLabel, roleLabel, surveySite, type SurveyPage } from "../src/services/website/survey.js";

let checks = 0;
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  checks += 1;
};
const equal = (name: string, actual: unknown, expected: unknown) => {
  assert.deepEqual(actual, expected, name);
  checks += 1;
};

/* ------------------------------------------------------------- the website */

const header = `<header class="site-header"><nav aria-label="Main"><a href="/">Home</a><a href="/shop">Shop</a><a href="/events">Events</a><a href="/contact">Contact</a></nav><a class="btn btn-primary" href="/quote">Get a quote</a></header>`;
const footer = `<footer class="site-footer"><p>&copy; 2026 Kwame Textiles</p><a class="btn" href="/quote">Get a quote</a></footer>`;
const crumbs = (here: string) => `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>${here}</span></nav>`;

/**
 * The design lives in a stylesheet, as it does on almost every real website,
 * and is written with custom properties, as it is on most modern ones. A survey
 * that only read the page would find one inline colour and call this site
 * almost colourless.
 */
const SITE_CSS = `
  :root{--ink:#1a1a2e;--brand:#3157ff;--line:#E5E5E5;--display:"Space Grotesk",Arial,sans-serif}
  body{font-family:var(--display);color:var(--ink);background:#FFFFFF}
  .btn{background-color:var(--brand);color:#fff;font-weight:600;font-size:16px}
  h1{font-family:var(--display);font-size:48px;font-weight:700;color:var(--ink)}
  .card{border-color:var(--line)}
  .price{color:var(--ink)}
  a{color:var(--brand)}
`;

const page = (body: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="/site.css"><style>.local{color:#1a1a2e}</style></head><body>${body}</body></html>`;

const withCss = (entry: SurveyPage): SurveyPage => ({ ...entry, stylesheets: [{ href: "/site.css", css: SITE_CSS }] });

const pages: SurveyPage[] = [
  {
    pageId: "home",
    title: "Home",
    path: "/",
    html: page(`${header}<main><h1>Cloth woven in Accra</h1><p>Hand finished, delivered anywhere.</p><a class="btn btn-primary" href="/quote">Get a quote</a></main>${footer}`),
  },
  {
    pageId: "shop",
    title: "Shop",
    path: "/shop",
    html: page(
      `${header}${crumbs("Shop")}<main><div class="grid">` +
        ["Kente throw", "Adinkra wrap", "Indigo scarf", "Batik runner"]
          .map((name) => `<div class="card"><a href="/shop/${name.toLowerCase().replace(/ /g, "-")}"><img src="/i.png" alt="${name}"><h3>${name}</h3><span>GHS 450</span></a></div>`)
          .join("") +
        `</div></main>${footer}`,
    ),
  },
  {
    pageId: "product",
    title: "Kente throw",
    path: "/shop/kente-throw",
    html: page(
      `${header}${crumbs("Kente throw")}<main><h1>Kente throw</h1><span class="price">GHS 450</span><p>Woven on a narrow loom.</p><button class="btn">Add to cart</button></main>${footer}`,
    ),
  },
  {
    pageId: "event",
    title: "Open studio",
    path: "/events/open-studio",
    html: page(
      `${header}${crumbs("Open studio")}<main><h1>Open studio</h1><p>14 March 2026 — doors open at 6pm.</p><p>Venue: Osu workshop. Tickets are free.</p><a class="btn" href="/quote">Get a quote</a></main>${footer}`,
    ),
  },
];

const survey = surveySite(pages.map(withCss));

/* ------------------------------------------------------------ what repeats */

equal("every page was read", survey.pagesRead, 4);

const roleOf = (role: string) => survey.elements.filter((element) => element.role === role);
const named = (role: string) => roleOf(role)[0];

check("the header was found", named("header"));
check("and it is on every page", named("header")?.everywhere === true);
check("the header says why it was called one", /landmark|header/i.test(named("header")?.roleReason ?? ""));

check("the footer was found", named("footer"));
check("and it is on every page", named("footer")?.everywhere === true);

const breadcrumbs = named("breadcrumbs");
check("breadcrumbs were found", breadcrumbs);
check("breadcrumbs are not on the home page", breadcrumbs && !breadcrumbs.pageIds.includes("home"));
check("but are on the three pages that have them", breadcrumbs?.pageIds.length === 3);
check(
  "breadcrumbs are told apart from navigation, not folded into it",
  breadcrumbs?.role === "breadcrumbs" && breadcrumbs.role !== named("primary-navigation")?.role,
);

check("a region carries the pages it appears on", survey.elements.every((element) => element.pageIds.length >= 2));
check("and every region says how sure it is", survey.elements.every((element) => element.confidence === "high" || element.confidence === "medium"));
check("every role has a label somebody can read", survey.elements.every((element) => roleLabel(element.role).length > 0));

/* -------------------------------------------------------- what it asks for */

const quote = survey.callsToAction.find((action) => action.words === "Get a quote");
check("the call to action repeated across the site was found", quote);
equal("it is on every page", quote?.pageIds.length, 4);
equal("it is a button, not a link", quote?.kind, "button");
equal("and it says where it goes", quote?.href, "/quote");
check(
  "it counts every appearance, not merely every page",
  // Header and footer on four pages, plus the body of home and of the event page.
  (quote?.occurrences ?? 0) > (quote?.pageIds.length ?? 0),
);

check("the navigation links are reported too", survey.callsToAction.some((action) => action.words === "Shop" && action.kind === "link"));
check(
  "a one-off action is not called site-wide",
  !survey.callsToAction.some((action) => action.words === "Add to cart"),
);

/* ------------------------------------------------------------ what pages are */

const kindOf = (pageId: string) => survey.templates.find((template) => template.pages.some((entry) => entry.pageId === pageId))?.kind;

equal("the front page is the home page", kindOf("home"), "home");
equal("a page repeating one card is a catalogue", kindOf("shop"), "catalogue");
equal("a price with a way to buy is a product page", kindOf("product"), "product");
equal("a date with event words is an event page", kindOf("event"), "event");
check("every template says what it matched on", survey.templates.every((template) => template.signals.length > 0));
check("every kind has a label somebody can read", survey.templates.every((template) => kindLabel(template.kind).length > 0));
check("every page landed in exactly one template", survey.templates.flatMap((template) => template.pages).length === pages.length);

/* -------------------------------------------------------------- the palette */

const colour = (value: string) => survey.palette.colours.find((entry) => entry.value === value);

equal("the stylesheet was read once for each page that links it", survey.palette.readFrom.stylesheets, 4);
check("and the page's own <style> was seen too", survey.palette.readFrom.inline);
check("the brand blue was found", colour("#3157ff"));
check("and it is known to be a background", colour("#3157ff")?.roles.includes("background"));
check("the ink colour was found", colour("#1a1a2e"));
check("and it is known to be text", colour("#1a1a2e")?.roles.includes("text"));
check("#FFFFFF and #ffffff are one colour, not two", survey.palette.colours.filter((entry) => entry.value === "#ffffff").length === 1);
check("a three-digit hex is expanded rather than listed separately", colour("#ffffff"));
check("the border colour is known to be a border", colour("#e5e5e5")?.roles.includes("border"));

// The whole point of reading the stylesheet: these colours are only ever
// written as var(--brand) outside their own declaration, so a survey that did
// not resolve tokens would find each of them exactly once.
check("a colour used only through a token is counted every time it is used", (colour("#3157ff")?.uses ?? 0) > 1);
check("and is known to be doing more than one job", (colour("#3157ff")?.roles.length ?? 0) > 1);

const token = (name: string) => survey.palette.tokens.find((entry) => entry.name === name);
check("the site's tokens were collected", token("--brand"));
equal("with the value they hold", token("--brand")?.value, "#3157ff");
check("and are known to be colours", token("--brand")?.isColour === true);
check("a token counts how often the site leans on it", (token("--brand")?.uses ?? 0) >= 2);
check("a token that is not a colour is not called one", token("--display")?.isColour === false);
check("a token defined in terms of another resolves", !/var\(/.test(token("--display")?.value ?? "var("));

const face = survey.palette.typefaces[0];
equal("the site's typeface is the one it uses most", face?.family, "space grotesk");
check("the fallback stack is not mistaken for a second typeface", !survey.palette.typefaces.some((entry) => entry.family === "arial"));
check("type sizes were collected", survey.palette.sizes.some((entry) => entry.value === "48px"));
check("and weights", survey.palette.weights.some((entry) => entry.value === "700"));
check("colours are ordered by how much the site leans on them", survey.palette.colours.every((entry, index, all) => index === 0 || all[index - 1]!.uses >= entry.uses));

/* ------------------------------------------------ the header and its pieces */

/**
 * A header full of repeated pieces is one finding, not nine.
 *
 * Everything inside a site's furniture repeats as often as the furniture does —
 * a logo, a search box, a row of section links. Three pages of one real news
 * site produced forty regions this way, of which two were the answer. What must
 * survive the tidying is anything the survey could actually name: the
 * navigation lives inside the header on most websites ever built, and reporting
 * the header while dropping its navigation loses the more useful of the two.
 */
const furniture = `<header class="masthead"><div class="logo"><a href="/"><img src="/logo.png" alt="Kwame"></a></div><div class="search"><a href="/search"><h4>Search</h4></a></div><nav aria-label="Main"><a href="/">Home</a><a href="/shop">Shop</a></nav></header>`;
const nested = surveySite([
  { pageId: "n1", title: "One", path: "/", html: `<!doctype html><html><body>${furniture}<main><h1>One</h1><p>First.</p></main></body></html>` },
  { pageId: "n2", title: "Two", path: "/two", html: `<!doctype html><html><body>${furniture}<main><h1>Two</h1><p>Second.</p></main></body></html>` },
  { pageId: "n3", title: "Three", path: "/three", html: `<!doctype html><html><body>${furniture}<main><h1>Three</h1><p>Third.</p></main></body></html>` },
]);

check("the header is reported", nested.elements.some((element) => element.role === "header"));
check(
  "its unnamed pieces are not reported beside it",
  nested.elements.filter((element) => element.role === "unclassified").length === 0,
);
check("so the header is one finding, not a list of its parts", nested.elements.length <= 3);

/*
 * The case above is folded away by detection, not by the survey: a block wholly
 * inside another on every page never reaches here. The survey's own rule is for
 * the case detection lets through — an inner piece found on *more* pages than
 * the region around it, because the region itself differs somewhere. That is
 * not a corner: it is what a real news site does, and it produced forty regions
 * where two were the answer. Here the logo is identical on three pages while
 * the header around it changes on the third.
 */
const logo = `<div class="logo"><a href="/"><img src="/l.png" alt="Kwame"></a><h4>Kwame</h4></div>`;
const masthead = (extra: string) => `<header class="masthead">${logo}<div class="x">${extra}</div></header>`;
const shifting = (head: string, body: string) => `<!doctype html><html><body>${head}<main>${body}</main></body></html>`;
const uneven = surveySite([
  { pageId: "u1", title: "A", path: "/", html: shifting(masthead(`<a href="/one"><h5>One</h5></a>`), "<h1>A</h1><p>x</p>") },
  { pageId: "u2", title: "B", path: "/b", html: shifting(masthead(`<a href="/one"><h5>One</h5></a>`), "<h1>B</h1><p>y</p>") },
  { pageId: "u3", title: "C", path: "/c", html: shifting(masthead(`<a href="/two"><h5>Two</h5></a>`), "<h1>C</h1><p>z</p>") },
]);
check("the header is still the finding", uneven.elements.some((element) => element.role === "header"));
check(
  "and a piece of it on more pages than the header itself is folded in, not listed beside it",
  uneven.elements.every((element) => element.role !== "unclassified"),
);

// A navigation wholly inside a header on every page is folded into it by
// detection, before the survey sees either — which is why nothing here asserts
// that both come back. It survives only where the two are found on different
// numbers of pages, and the rule below is what stops *this* stage from folding
// it away in the cases where it does survive.
const namedInsideNamed = surveySite([
  { pageId: "p1", title: "One", path: "/", html: `<!doctype html><html><body><header class="masthead"><div class="logo"><a href="/"><img src="/l.png" alt="K"></a></div></header><main><h1>One</h1></main></body></html>` },
  { pageId: "p2", title: "Two", path: "/two", html: `<!doctype html><html><body><header class="masthead"><div class="logo"><a href="/"><img src="/l.png" alt="K"></a></div></header><nav aria-label="Main"><a href="/">Home</a><a href="/shop">Shop</a></nav><main><h1>Two</h1></main></body></html>` },
  { pageId: "p3", title: "Three", path: "/three", html: `<!doctype html><html><body><header class="masthead"><div class="logo"><a href="/"><img src="/l.png" alt="K"></a></div></header><nav aria-label="Main"><a href="/">Home</a><a href="/shop">Shop</a></nav><main><h1>Three</h1></main></body></html>` },
]);
check("a header is reported", namedInsideNamed.elements.some((element) => element.role === "header"));
check("and a navigation that is not inside it is reported too", namedInsideNamed.elements.some((element) => element.role === "primary-navigation"));

/* ------------------------------------------ a site that names nothing itself */

/**
 * No <header>, no <footer>, no telling class — only position can answer.
 *
 * This is the rule that had never once fired: the element came from one parse of
 * the page and the list of outermost blocks from another, so asking whether the
 * element *was* one of those blocks compared nodes from two different trees and
 * was always false. It failed silently, as a wrong answer that looks like a
 * cautious one: every such block came back as "repeats across pages, but nothing
 * in it says what it is".
 */
const bare = surveySite([
  { pageId: "a", title: "A", path: "/", html: `<!doctype html><html><body><div class="strip"><a href="/">Kwame</a><a href="/shop">Shop</a></div><main><h1>One</h1><p>First.</p></main><div class="end"><p>&copy; 2026</p></div></body></html>` },
  { pageId: "b", title: "B", path: "/b", html: `<!doctype html><html><body><div class="strip"><a href="/">Kwame</a><a href="/shop">Shop</a></div><main><h1>Two</h1><p>Second.</p></main><div class="end"><p>&copy; 2026</p></div></body></html>` },
]);

const bareRole = (role: string) => bare.elements.find((element) => element.role === role);
check("a repeated first block with nothing naming it is the header", bareRole("header"));
check("and says position is why", /first block/i.test(bareRole("header")?.roleReason ?? ""));
check("a repeated last block with nothing naming it is the footer", bareRole("footer"));
check("and says position is why", /last block/i.test(bareRole("footer")?.roleReason ?? ""));

/* ------------------------------------------------- a page the size of a real one */

/**
 * Not a benchmark — a catastrophe guard.
 *
 * The fixtures above are a few hundred bytes and hid two separate collapses:
 * detection compared every block against every other block, and the survey
 * re-read the whole page for every question it asked about it. Two copies of one
 * real news page took over eight minutes between them, which in a request is not
 * slow but broken. The bound is loose on purpose: real time here is well under a
 * second, so this fires on a regression of that shape and not on a busy machine.
 */
// Each page lists different things, as real listing pages do. Three pages
// carrying the identical 400 links would be site furniture by the survey's own
// rule, and rightly not a catalogue.
const heavyPage = (page: number) => {
  const cards = Array.from(
    { length: 400 },
    (_, index) =>
      `<article class="card"><a href="/thing/${page}-${index}"><img src="/i${index}.png" alt="Thing ${index}"><h3>Thing ${page}-${index}</h3><p>A short line about it.</p></a></article>`,
  ).join("");
  return `<!doctype html><html><head><link rel="stylesheet" href="/s.css"></head><body>${header}<main><div class="grid">${cards}</div></main>${footer}</body></html>`;
};
const heavyPages: SurveyPage[] = [1, 2, 3].map((n) => ({ pageId: `heavy-${n}`, title: `Heavy ${n}`, path: `/heavy-${n}`, html: heavyPage(n), stylesheets: [{ href: "/s.css", css: SITE_CSS }] }));

const startedAt = Date.now();
const heavy = surveySite(heavyPages);
const tookMs = Date.now() - startedAt;

check(`three pages of 400 cards are surveyed promptly (took ${tookMs}ms)`, tookMs < 15_000);
equal("and all three were read", heavy.pagesRead, 3);
check("the header is still found in the noise", heavy.elements.some((element) => element.role === "header"));
equal("and a page of 400 linked cards is a catalogue", heavy.templates[0]?.kind === "home" ? heavy.templates[1]?.kind : heavy.templates[0]?.kind, "catalogue");

/* ------------------------------------------------------- a site of one page */

const alone = surveySite([withCss(pages[0]!)]);
equal("one page has nothing to compare against", alone.elements.length, 0);
equal("and nothing repeats across it", alone.callsToAction.length, 0);
check("but its colours are still readable", alone.palette.colours.length > 0);
check("and it is still classified", alone.templates.length === 1);

console.log(`websiteSurvey: ${checks} checks — global regions named, repeated calls to action counted, page kinds told apart, and the site's real colours and type read from the markup`);
