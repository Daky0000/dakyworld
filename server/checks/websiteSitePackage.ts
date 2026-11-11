/**
 * A whole website imported as a ZIP: every page works, and the pages form a tree.
 *
 * 11 Nov 2026. The Gulf Contracting site (a Next.js static export, 52 pages)
 * imported as a ZIP looked right in the editor and undid every edit on the
 * published site: React hydrated each page from the copy of its content in
 * `self.__next_f`, and put the original words back. Files kept archive paths as
 * shared storage keys, links between pages broke one folder down, and two
 * files for `/404` overwrote each other. This holds the pure parts of the fix
 * on a package built here in the same shape, without a database:
 *
 *  - which tool built the site (`recogniseBuild`), and what freezing takes out;
 *  - one page per address (`choosePages`);
 *  - links between pages pointing at each page's own address;
 *  - files bundled under per-site names, stylesheets followed, unused files left out;
 *  - the page tree the page list and the editor's switcher draw.
 *
 * The real 52-page export was run through the same functions and opened in
 * Chromium on the day: no failed request, every link answering, the edited
 * heading still there after three seconds, the menu drawer opening.
 */
import assert from "node:assert/strict";
import { freezePage, interactionsIn, recogniseBuild } from "../src/services/website/buildOutput.js";
import { bundleSiteFiles, choosePages, pageLinkTarget, rewritePageLinks, routeOfLink, tidyPageTitles } from "../src/services/websiteSitePackage.js";
import { extractPageTitle, mimeTypeFromPath, routePathForFile } from "../src/services/websitePackageImport.js";
import { buildPageTree, defaultCollapsed, flattenPageTree, pageAncestors, pageForHref } from "../client/src/lib/pageTree.js";

let checks = 0;
const equal = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); checks++; };
const ok = (name: string, value: unknown) => { assert.ok(value, name); checks++; };

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** A page shaped like a Next.js app-router static export. */
const nextPage = (title: string, body: string) => `<!DOCTYPE html><html lang="en" class="__variable_a"><head><meta charSet="utf-8"/>
<link rel="preload" as="image" href="/images/logo.png"/>
<link rel="stylesheet" href="/_next/static/css/site.css" data-precedence="next"/>
<link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/webpack-1.js"/>
<script src="/_next/static/chunks/main-app-1.js" async=""></script>
<script src="https://www.googletagmanager.com/gtag/js?id=G-1" async=""></script>
<title>${title}</title>
<script src="/_next/static/chunks/polyfills-1.js" noModule=""></script></head><body>
<header><a href="/"><img src="/images/logo.png" alt="Logo"/></a>
<button type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="nav-drawer">Menu</button></header>
<dialog id="nav-drawer"><button type="button" class="drawer-close" aria-label="Close navigation menu">Close</button>
<a href="/about/">About</a><a href="/projects/">Projects</a></dialog>
<main>${body}</main>
<button type="button" class="slider-next">Next slide</button>
<form><input name="email"/><button type="submit">Send</button></form>
<script>(self.__next_f=self.__next_f||[]).push([0])</script><script>self.__next_f.push([1,"1:\\"$Sreact.fragment\\""])</script>
<script>window.dataLayer=window.dataLayer||[];</script>
</body></html>`;

/* ------------------------------------------------------------- recognising */

const files = ["_next/static/css/site.css", "_next/static/chunks/main-app-1.js", "_next/static/chunks/webpack-1.js", "_next/static/chunks/polyfills-1.js", "_next/static/chunks/139.lazy.js", "images/logo.png", "index.txt", "about/index.txt", "docs/terms.pdf", "_next/static/media/font-1.woff2", "images/unused.png"];
const home = nextPage("Home", `<h1>Committed to quality</h1><a href="/projects/alpha/">Alpha</a><a href="docs/terms.pdf">Terms</a><a href="#top">Top</a><a href="https://example.com/">Elsewhere</a><a href="mailto:a@b.c">Mail</a>`);
equal("a Next.js app-router export is recognised", recogniseBuild(files, [{ html: home }]), { kind: "next-app", label: "a Next.js export", freezes: true });
equal("a Next.js pages-router export is recognised", recogniseBuild([], [{ html: '<script id="__NEXT_DATA__" type="application/json">{}</script><script src="/_next/static/chunks/main.js"></script>' }]).kind, "next-pages");
equal("a Gatsby build is recognised", recogniseBuild(["page-data/app-data.json"], [{ html: '<div id="___gatsby"></div>' }]).kind, "gatsby");
equal("a Nuxt build is recognised", recogniseBuild([], [{ html: '<script src="/_nuxt/entry.js"></script><script>window.__NUXT__={}</script>' }]).kind, "nuxt");
equal("an Astro page with islands is recognised", recogniseBuild([], [{ html: "<astro-island uid=1></astro-island>" }]).kind, "astro");
equal("plain Astro output is plain HTML", recogniseBuild(["_astro/a.css"], [{ html: '<link rel="stylesheet" href="/_astro/a.css">' }]).kind, "plain");
equal("a Webflow export is recognised and not frozen", recogniseBuild([], [{ html: '<html data-wf-page="1"><script src="js/webflow.js"></script>' }]), { kind: "webflow", label: "a Webflow export", freezes: false });
equal("hand-written HTML is plain", recogniseBuild(["css/site.css"], [{ html: '<html><script src="js/menu.js"></script></html>' }]), { kind: "plain", label: "plain HTML", freezes: false });

/* ----------------------------------------------------------------- freezing */

const build = recogniseBuild(files, [{ html: home }]);
const frozen = freezePage(home, build);
ok("the runtime's script tags are gone", !/_next\/static\/chunks/.test(frozen.html));
ok("the flight data React hydrates from is gone", !/__next_f/.test(frozen.html));
equal("what was taken out is counted", frozen.removed, { scripts: 2, data: 2, preloads: 1 });
ok("the stylesheet stays", frozen.html.includes('href="/_next/static/css/site.css"'));
ok("a picture preload stays", frozen.html.includes('<link rel="preload" as="image" href="/images/logo.png"/>'));
ok("a third-party script (analytics) stays", frozen.html.includes("googletagmanager.com/gtag/js"));
ok("the site's own inline script that is not the runtime stays", frozen.html.includes("window.dataLayer"));
ok("the behaviours script is added once, before </body>", (frozen.html.match(/data-dw-behaviours/g) ?? []).length === 1 && /data-dw-behaviours[\s\S]*<\/body>/.test(frozen.html));
equal("freezing twice changes nothing more", freezePage(frozen.html, build).html, frozen.html);
equal("the menu button and the drawer's close button are restored; the slider button is named as lost", { restored: frozen.interactions.restored, unrestored: frozen.interactions.unrestored }, { restored: 2, unrestored: ["Next slide"] });
equal("a submit button in a form is neither", interactionsIn("<form><button>Go</button></form>"), { restored: 0, unrestored: [] });
equal("a plain page is not touched", freezePage('<html><body><script src="js/menu.js"></script></body></html>', recogniseBuild([], [{ html: "" }])).html, '<html><body><script src="js/menu.js"></script></body></html>');
equal("a client-only part is counted", freezePage(`${home}<template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"></template>`, build).clientOnlyParts, 1);

/* -------------------------------------------------------------- one address */

equal("404.html and 404/index.html are one address", routePathForFile("404/index.html"), routePathForFile("404.html"));
const chosen = choosePages([
  { filePath: "index.html", path: "/" },
  { filePath: "404/index.html", path: "/404" },
  { filePath: "404.html", path: "/404" },
  { filePath: "about/index.html", path: "/about" },
]);
equal("the file nearer the top is kept", chosen.kept.map((page) => page.filePath), ["index.html", "404.html", "about/index.html"]);
equal("and the other is reported", chosen.dropped, [{ filePath: "404/index.html", keptFilePath: "404.html", path: "/404" }]);

/* ------------------------------------------------------------------- titles */

equal("a title's entities are decoded", extractPageTitle("<title>Services &amp; Capabilities — Gulf</title>", "x.html"), "Services & Capabilities — Gulf");
equal("the site's name is dropped from the list's titles", tidyPageTitles(["Gulf Contracting Co. W.L.L. — Qatari Grade A Building Contractor", "About Us — Gulf Contracting Co. W.L.L.", "Projects — Gulf Contracting Co. W.L.L.", "Al Darwish Tower — Gulf Contracting Co. W.L.L."]), ["Gulf Contracting Co. W.L.L. — Qatari Grade A Building Contractor", "About Us", "Projects", "Al Darwish Tower"]);
equal("a leading site name too", tidyPageTitles(["Acme | Home", "Acme | About", "Acme | Contact"]), ["Home", "About", "Contact"]);
equal("titles with nothing in common are left alone", tidyPageTitles(["Home", "About us", "Contact"]), ["Home", "About us", "Contact"]);

/* -------------------------------------------------------------------- links */

const byFile = new Map([
  ["index.html", "/"],
  ["about/index.html", "/about"],
  ["projects/index.html", "/projects"],
  ["projects/alpha/index.html", "/projects/alpha"],
  ["contact.html", "/contact"],
]);
const routes = new Set(byFile.values());
equal("/about/ is the about page", pageLinkTarget("/about/", "index.html", byFile, routes), { route: "/about", suffix: "" });
equal("a relative link one folder down", pageLinkTarget("../index.html", "projects/alpha/index.html", byFile, routes), { route: "/projects", suffix: "" });
equal("./ is the folder's own page", pageLinkTarget("./", "projects/index.html", byFile, routes), { route: "/projects", suffix: "" });
equal("contact.html and contact are the contact page", [pageLinkTarget("contact.html", "index.html", byFile, routes)?.route, pageLinkTarget("/contact", "about/index.html", byFile, routes)?.route], ["/contact", "/contact"]);
equal("a fragment and a query are kept", pageLinkTarget("/about/?a=1&b=2#team", "index.html", byFile, routes), { route: "/about", suffix: "?a=1&b=2#team" });
equal("too many .. stops at the root", pageLinkTarget("../../../about/", "projects/alpha/index.html", byFile, routes), { route: "/about", suffix: "" });
equal("a root link from a page that sat in a folder inside the archive", pageLinkTarget("/about/", "site/index.html", new Map([["site/about/index.html", "/about"]]), new Set(["/about"])), { route: "/about", suffix: "" });
for (const href of ["#top", "https://example.com/", "mailto:a@b.c", "//cdn.example.com/x", "docs/terms.pdf", "/missing/", "tel:+1"]) {
  equal(`${href} is not a page link`, pageLinkTarget(href, "index.html", byFile, routes), null);
}
equal("route spellings", ["/about/index.html", "/about/", "/about.html", "/", "/index.html"].map(routeOfLink), ["/about", "/about", "/about", "/", "/"]);
const relinked = rewritePageLinks('<a href="../index.html">Up</a><a href="/about/#team">Team</a><a class=x href=contact.html>C</a><a href="https://example.com/">E</a>', "projects/alpha/index.html", byFile, routes, "/");
// contact.html from projects/alpha/ is projects/alpha/contact.html, which is not a page.
equal("links are rewritten to page addresses; one to no page is left alone", relinked.html, '<a href="/projects">Up</a><a href="/about#team">Team</a><a class=x href=contact.html>C</a><a href="https://example.com/">E</a>');
equal("and counted", relinked.rewritten, 2);
equal("an unquoted link gains quotes", rewritePageLinks("<a href=../../about/>A</a>", "projects/alpha/index.html", byFile, routes, "/").html, '<a href="/about">A</a>');
equal("under a site served at /shop/, addresses carry the base", rewritePageLinks('<a href="/about/">A</a><a href="/">H</a>', "index.html", byFile, routes, "/shop/").html, '<a href="/shop/about">A</a><a href="/shop/">H</a>');
equal("an ampersand in a kept query is escaped again", rewritePageLinks('<a href="/about/?a=1&amp;b=2">A</a>', "index.html", byFile, routes, "/").html, '<a href="/about?a=1&amp;b=2">A</a>');

/* -------------------------------------------------------------------- files */

const css = Buffer.from("@font-face{font-family:x;src:url(/_next/static/media/font-1.woff2) format(\"woff2\")}body{background:url(../../../images/logo.png)}");
const archive = new Map<string, Buffer>([
  ["_next/static/css/site.css", css],
  ["_next/static/chunks/main-app-1.js", Buffer.from("console.log(1)")],
  ["_next/static/chunks/webpack-1.js", Buffer.from("console.log(2)")],
  ["_next/static/chunks/polyfills-1.js", Buffer.from("")],
  ["_next/static/chunks/139.lazy.js", Buffer.from("")],
  ["_next/static/media/font-1.woff2", Buffer.from("wOF2")],
  ["images/logo.png", PNG],
  ["images/unused.png", PNG],
  ["index.txt", Buffer.from("0:[]")],
  ["about/index.txt", Buffer.from("0:[]")],
  ["docs/terms.pdf", Buffer.from("%PDF-1.4")],
]);
const bundled = await bundleSiteFiles([{ filePath: "index.html", html: frozen.html }], archive, "/assets/dw");
const stored = new Map(bundled.files.map((file) => [file.source, file]));
equal("only what the page uses is stored", [...stored.keys()].sort(), ["_next/static/css/site.css", "_next/static/media/font-1.woff2", "docs/terms.pdf", "images/logo.png"]);
equal("the runtime and its data are left out", bundled.leftOut, ["_next/static/chunks/139.lazy.js", "_next/static/chunks/main-app-1.js", "_next/static/chunks/polyfills-1.js", "_next/static/chunks/webpack-1.js", "about/index.txt", "images/unused.png", "index.txt"]);
ok("every stored file has a per-site name", bundled.files.every((file) => /^assets\/dw\/[0-9a-f-]{36}\.[a-z0-9]+$/.test(file.repoPath)));
equal("a PNG is stored as WebP", stored.get("images/logo.png")?.contentType, "image/webp");
equal("a PDF is stored as a PDF", stored.get("docs/terms.pdf")?.contentType, "application/pdf");
const sheet = stored.get("_next/static/css/site.css")!.content.toString("utf8");
ok("the stylesheet's font points at its stored name", sheet.includes(`url(/assets/dw/${stored.get("_next/static/media/font-1.woff2")!.repoPath.split("/").pop()})`));
ok("the stylesheet's picture, named relative to it, points at its stored name", sheet.includes(`url(/assets/dw/${stored.get("images/logo.png")!.repoPath.split("/").pop()})`));
ok("the page names no archive path any more", !/\/images\/logo\.png|_next\/static|docs\/terms\.pdf/.test(bundled.pages[0]!));
equal("PDF and text types", [mimeTypeFromPath("a.pdf"), mimeTypeFromPath("a.txt")], ["application/pdf", "text/plain"]);

/* --------------------------------------------------------------------- tree */

const sitePages = [
  { id: "h", title: "Home", path: "/" },
  { id: "a", title: "About", path: "/about" },
  { id: "p", title: "Projects", path: "/projects" },
  ...Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, title: `Project ${i}`, path: `/projects/p-${i}` })),
  { id: "b1", title: "First post", path: "/blog/first" },
  { id: "b2", title: "Second post", path: "/blog/second" },
];
const tree = buildPageTree(sitePages);
equal("top level: home first, then the site's sections", tree.map((node) => node.path), ["/", "/about", "/projects", "/blog"]);
equal("project pages sit under the projects page", tree[2]!.children.length, 10);
equal("a folder with no page of its own is a group", { page: tree[3]!.page, label: tree[3]!.label, children: tree[3]!.children.length }, { page: null, label: "Blog", children: 2 });
equal("a big group starts collapsed", [...defaultCollapsed(tree)], ["/projects"]);
equal("collapsed rows are skipped", flattenPageTree(tree, defaultCollapsed(tree)).map((row) => row.node.path), ["/", "/about", "/projects", "/blog", "/blog/first", "/blog/second"]);
equal("a project page's parents: home, then projects", pageAncestors("/projects/p-3", sitePages).map((page) => page.id), ["h", "p"]);
equal("a top-level page's parent is home", pageAncestors("/about", sitePages).map((page) => page.id), ["h"]);
equal("home has no parent", pageAncestors("/", sitePages), []);
equal("a canvas link to a page opens that page", pageForHref("https://gulf.dakyx.site/projects/p-3?x=1#y", "https://gulf.dakyx.site/", sitePages)?.id, "p3");
equal("under a base path too", pageForHref("https://u.github.io/site/about/", "https://u.github.io/site/", sitePages)?.id, "a");
equal("a link to another website is not a page", pageForHref("https://example.com/about", "https://gulf.dakyx.site/", sitePages), null);

console.log(`websiteSitePackage: ${checks} checks passed`);
