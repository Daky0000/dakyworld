/** What the editor promises about a website, checked against real markup. No IO. */
import assert from "node:assert/strict";
import { analysePage, summariseCompatibility, READINESS_LABEL } from "../src/services/website/compatibility.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const page = (body: string, head = "") => `<!doctype html><html><head><title>Page</title>${head}</head><body>${body}</body></html>`;
const codes = (html: string) => analysePage(html).findings.map((finding) => finding.code).sort();
const gradeOf = (html: string) => analysePage(html).grade;

/* ------------------------------------------------------- a plain page */

const plain = page('<main><h1>Better systems</h1><p>Words.</p><a href="/contact">Contact</a><img src="/a.png" alt="A"></main>');
equal("a plain page has nothing to warn about", codes(plain), []);
equal("and is fully editable", gradeOf(plain), "editable");
equal("its editable things are counted without the containers or the page title", analysePage(plain).editable, 4);
check("the title is still a field somebody can edit", analysePage(plain).fields.text >= 3);
equal("and by kind", analysePage(plain).fields.image, 1);

/* --------------------------------------------------------- limitations */

check("a script is a limitation rather than a refusal", codes(page("<main><h1>Hi</h1></main><script>go()</script>")).includes("scripts"));
equal("and only a limitation", gradeOf(page("<main><h1>Hi</h1></main><script>go()</script>")), "limited");
check("structured data is content, not behaviour", !codes(page('<main><h1>Hi</h1></main><script type="application/ld+json">{}</script>')).includes("scripts"));
check("a link that goes nowhere on its own is called out", codes(page('<main><h1>Hi</h1><a href="#">Open</a></main>')).includes("script-links"));
check("so is a javascript: link", codes(page('<main><h1>Hi</h1><a href="javascript:void(0)">Open</a></main>')).includes("script-links"));
check("a picture with several sizes warns about replacing it", codes(page('<main><h1>Hi</h1><img src="/a.png" srcset="/a.png 1x, /b.png 2x" alt="A"></main>')).includes("srcset"));

/* --------------------------------------------------- developer-controlled */

const withForm = page('<main><h1>Hi</h1><form action="/x"><input name="a"></form></main>');
check("a form is the developer's", codes(withForm).includes("forms"));
equal("which downgrades the page", gradeOf(withForm), "developer");
check("an embedded frame is too", codes(page('<main><h1>Hi</h1><iframe src="https://maps.example"></iframe></main>')).includes("embeds"));
check("so is a custom element", codes(page("<main><h1>Hi</h1><price-table></price-table></main>")).includes("custom-elements"));
check("so is behaviour written into an attribute", codes(page('<main><h1>Hi</h1><button onclick="go()">Go</button></main>')).includes("inline-handlers"));
check("a picture group is the developer's, not the image control's", codes(page('<main><h1>Hi</h1><picture><source srcset="/a.webp"><img src="/a.png" alt="A"></picture></main>')).includes("picture"));

/* ------------------------------------------------------------ refusals */

const shell = page('<div id="root"></div><script src="/app.js"></script>');
check("an application shell has nothing to edit", codes(shell).includes("no-content"));
equal("and is not supported", gradeOf(shell), "unsupported");

/* ---------------------------------------------------------- annotations */

const annotated = page('<main><h1 data-dw-field="hero.title">Hi</h1></main>');
const note = analysePage(annotated).findings.find((finding) => finding.code === "annotations")!;
equal("marked-up fields are reported as a good thing", note.grade, "editable");
equal("and do not spoil the grade", gradeOf(annotated), "editable");

/* ------------------------------------------------------- the whole site */

const publishing = { repository: true, credentials: true, branch: "main", blocked: null };
const site = summariseCompatibility({
  pages: [
    { pageId: "1", title: "Home", path: "/", html: plain },
    { pageId: "2", title: "Contact", path: "/contact", html: withForm },
    { pageId: "3", title: "App", path: "/app", html: page('<main><h1>Hi</h1></main><script>go()</script>') },
  ],
  publishing,
});
equal("the rating names what a developer keeps", site.rating, "Good, with parts a developer keeps");
equal("every page is listed with its own grade", site.pages.map((entry) => entry.grade), ["editable", "developer", "limited"]);
equal("findings are merged across pages, worst first", site.findings[0]!.grade, "developer");
equal("and counted", site.findings.find((finding) => finding.code === "forms")!.count, 1);
equal("editable things are totalled", site.totals.editable, analysePage(plain).editable + analysePage(withForm).editable + analysePage(page('<main><h1>Hi</h1></main><script>go()</script>')).editable);
equal("a site with a developer-owned part is ready with limits", site.readiness, "LIMITED");

const clean = summariseCompatibility({ pages: [{ pageId: "1", title: "Home", path: "/", html: plain }], publishing });
equal("a site with nothing to warn about is excellent", clean.rating, "Excellent");
equal("and simply ready", clean.readiness, "READY");

const unreadable = summariseCompatibility({ pages: [{ pageId: "1", title: "Home", path: "/", html: plain }, { pageId: "2", title: "Gone", path: "/gone", unreadable: "404 from the repository." }], publishing });
equal("a page that could not be read is not silently dropped", unreadable.pages[1]!.unreadable, "404 from the repository.");
equal("and puts the site in front of somebody", unreadable.readiness, "NEEDS_REVIEW");

const shellSite = summariseCompatibility({ pages: [{ pageId: "1", title: "App", path: "/", html: shell }], publishing });
equal("a site of application shells is not supported", shellSite.rating, "Not supported");

const mixed = summariseCompatibility({ pages: [{ pageId: "1", title: "Home", path: "/", html: plain }, { pageId: "2", title: "App", path: "/app", html: shell }], publishing });
equal("one unsupported page among good ones is limited rather than refused", mixed.rating, "Limited");

const noRepo = summariseCompatibility({ pages: [{ pageId: "1", title: "Home", path: "/", html: plain }], publishing: { repository: false, credentials: true, branch: null, blocked: "No repository is connected, so there is nowhere to publish to." } });
equal("a perfectly editable site that cannot publish says so", noRepo.readiness, "PUBLISH_BLOCKED");
equal("without pretending its pages are the problem", noRepo.rating, "Excellent");

const nothing = summariseCompatibility({ pages: [], publishing });
equal("a site nobody has scanned is not judged yet", nothing.readiness, "CONNECTED");
check("every readiness state reads as a sentence", Object.values(READINESS_LABEL).every((label) => label.length > 3));

console.log(`websiteCompatibility: ${checks} checks — per-page grading, merged site findings, honest ratings and readiness passed`);
