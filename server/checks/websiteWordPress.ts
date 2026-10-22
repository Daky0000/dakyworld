/**
 * WordPress sites: connect, open, edit and publish, against a stub WordPress.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/websiteWordPress.ts
 *
 * Two halves. The first is the mapper on its own — strings in, a decision out —
 * because that is where a WordPress publish can go wrong without anybody
 * noticing: a heading written into the menu's copy of the same words, a
 * sentence half-replaced, `It's` failing to match the `It’s` WordPress serves.
 * Half of it is negatives, and every refusal asserts the content came back
 * byte-identical.
 *
 * The second runs the real routes against a stub WordPress on a local port:
 * the REST index, Application Password auth (and each way it is refused), the
 * page list, `context=edit` reads, writes and a media upload, plus the live
 * pages it renders from what is stored, `wptexturize` and all. Nothing leaves
 * the machine; the stub counts every write so "nothing was written" is a count.
 *
 * Needs Postgres and nothing else. Every row it makes is removed at the end.
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) || !/(test|check|editor)/i.test(databaseUrl.pathname)) {
  throw new Error("These checks require an isolated local test/editor database. Set DATABASE_URL to one.");
}

let passed = 0;
const failures: string[] = [];
async function check(name: string, test: () => unknown | Promise<unknown>) {
  try { await test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) {
    failures.push(name);
    const detail = error instanceof assert.AssertionError && error.operator !== "fail" ? ` (got ${JSON.stringify(error.actual)?.slice(0, 300)}, wanted ${JSON.stringify(error.expected)?.slice(0, 300)})` : "";
    console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}${detail}`);
  }
}

// Real sessions, so the routes' own access checks run: `middleware/auth.ts`
// reads DEV_NO_AUTH once, at import. It is switched on *after* the imports for
// one reason — the stub WordPress is on 127.0.0.1 over plain HTTP, and the
// outbound guard allows that only in development with DEV_NO_AUTH set, read at
// call time. Admission off, so a publish runs in the request.
Object.assign(process.env, { DEV_NO_AUTH: "false", NODE_ENV: "development", JOB_ADMISSION_ENABLED: "false" });

const { prisma } = await import("../src/lib/prisma.js");
const { ensureSystemRoles } = await import("../src/lib/accessRoles.js");
const { createSession } = await import("../src/lib/session.js");
const { attachUser, requireAuth } = await import("../src/middleware/auth.js");
const { websiteRouter } = await import("../src/routes/website.js");
const { applyWordPressEdits, detectWordPressBuilder, wordpressFieldMap, discoverFields, wordpressSiteHint, wordpressPurchaseNote } = await import("../src/services/website/index.js");
const { onboardingSteps } = await import("../src/services/websiteOnboarding.js");
const { siteCompatibility } = await import("../src/services/websiteReadiness.js");
const { assessPurchaseCompatibility, inspectPublicWebsite } = await import("../src/services/websiteCommerce.js");
const { checkWordPress, wordpressEndpoint } = await import("../src/services/websiteWordPress.js");
process.env.DEV_NO_AUTH = "true";

/* ================================================================ the mapper */

console.log("\nThe mapper, on strings");

const theme = (body: string, title = "About us") => `<!doctype html><html><head><title>${title} – Kumasi Bakery</title></head><body>
<header><nav><a href="/">Home</a> <a href="/about/">About</a> <a href="/contact/">Contact</a></nav></header>
<main><h1 class="entry-title">${title}</h1><div class="entry-content">${body}</div></main>
<footer><p>© 2026 Kumasi Bakery</p></footer></body></html>`;

/** What WordPress does to stored content on the way out, as much as matters here. */
function render(content: string): string {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, "");
  return withoutComments
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith("<") ? part.replace(/<img\b/, '<img loading="lazy" decoding="async"') : part.replace(/'/g, "&#8217;").replace(/ -- /g, " &#8211; ")))
    .join("");
}

const UPLOADS = "https://bakery.example.test/wp-content/uploads/2024/05";
const blocks = [
  "<!-- wp:heading -->",
  '<h2 class="wp-block-heading">Our story</h2>',
  "<!-- /wp:heading -->",
  "",
  "<!-- wp:paragraph -->",
  "<p>We're a family-run bakery in Kumasi -- baking since 1998.</p>",
  "<!-- /wp:paragraph -->",
  "",
  '<!-- wp:image {"id":12,"sizeSlug":"large"} -->',
  `<figure class="wp-block-image size-large"><img src="${UPLOADS}/oven.jpg" alt="Our oven" class="wp-image-12"/></figure>`,
  "<!-- /wp:image -->",
  "",
  "<!-- wp:paragraph -->",
  '<p>Questions? <a href="/contact/">Contact</a> us any time.</p>',
  "<!-- /wp:paragraph -->",
  "",
  "<!-- wp:buttons -->",
  '<div class="wp-block-buttons"><!-- wp:button -->',
  '<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/order/">Order a cake</a></div>',
  "<!-- /wp:button --></div>",
  "<!-- /wp:buttons -->",
].join("\n");
const blocksHtml = theme(render(blocks));
const blocksSource = { id: 7, type: "page" as const, content: blocks, title: "About us", builder: "blocks" as const };
const fieldsOf = (html: string) => discoverFields(html).fields;
const field = (html: string, preview: string) => {
  const found = fieldsOf(html).find((entry) => entry.preview.trim() === preview);
  assert.ok(found, `no field reads "${preview}"`);
  return found;
};
const image = (html: string) => fieldsOf(html).find((entry) => entry.kind === "image")!;

await check("builders are told apart, and a meta-storing builder only by this page's own id", () => {
  assert.equal(detectWordPressBuilder({ postId: 7, content: blocks, html: blocksHtml }), "blocks");
  assert.equal(detectWordPressBuilder({ postId: 7, content: "<p>Hello</p>", html: "" }), "classic");
  assert.equal(detectWordPressBuilder({ postId: 7, content: "[et_pb_section][et_pb_text]Hi[/et_pb_text][/et_pb_section]", html: "" }), "divi");
  assert.equal(detectWordPressBuilder({ postId: 7, content: "[vc_row][vc_column]Hi[/vc_column][/vc_row]", html: "" }), "wpbakery");
  assert.equal(detectWordPressBuilder({ postId: 7, content: "<p>fallback</p>", html: '<div data-elementor-type="wp-page" data-elementor-id="7" class="elementor elementor-7">' }), "elementor");
  // An Elementor header on a block-editor page does not make the page Elementor's.
  assert.equal(detectWordPressBuilder({ postId: 7, content: blocks, html: '<div data-elementor-type="header" data-elementor-id="31">' + blocksHtml }), "blocks");
});

await check("the page's own words are writable; the theme's, the menu's and repeated words are not", () => {
  const map = wordpressFieldMap({ html: blocksHtml, source: blocksSource });
  for (const words of ["Our story", "We’re a family-run bakery in Kumasi – baking since 1998.", "Order a cake", "About us"]) {
    assert.ok(map.writable.has(field(blocksHtml, words).id), `"${words}" should be writable`);
  }
  assert.ok(map.writable.has(image(blocksHtml).id), "the picture should be writable");
  assert.match(map.notes.get(field(blocksHtml, "© 2026 Kumasi Bakery").id) ?? "", /theme, a menu, a widget/);
  assert.match(map.notes.get(field(blocksHtml, "Home").id) ?? "", /not in this page's content/);
  // The nav says "Contact" and so does the sentence's own link.
  for (const entry of fieldsOf(blocksHtml).filter((candidate) => candidate.preview.trim() === "Contact")) {
    assert.ok(!map.writable.has(entry.id), "a repeated word must not be writable");
  }
  assert.equal(map.failure, undefined);
});

await check("an edit replaces exactly its own bytes, and an apostrophe matches across wptexturize", () => {
  const story = field(blocksHtml, "Our story");
  const paragraph = field(blocksHtml, "We’re a family-run bakery in Kumasi – baking since 1998.");
  const result = applyWordPressEdits({ html: blocksHtml, source: blocksSource, values: {
    [story.id]: { value: "Our story, since 1998", original: story.value },
    [paragraph.id]: { value: "We're still baking in Kumasi.", original: paragraph.value },
  } });
  assert.deepEqual([result.unmappable, result.problems], [[], []]);
  assert.equal(result.content, blocks
    .replace(">Our story<", ">Our story, since 1998<")
    .replace("We're a family-run bakery in Kumasi -- baking since 1998.", "We're still baking in Kumasi."));
  assert.equal(result.title, "About us");
});

await check("the title, a link's destination and a picture's description go to their own places", () => {
  const title = field(blocksHtml, "About us");
  const button = field(blocksHtml, "Order a cake");
  const picture = image(blocksHtml);
  const result = applyWordPressEdits({ html: blocksHtml, source: blocksSource, values: {
    [title.id]: { value: "About the bakery", original: title.value },
    [button.id]: { value: "Order a cake", original: button.value, href: "/cakes/", originalHref: button.href },
    [picture.id]: { value: picture.value, original: picture.value, alt: "The wood-fired oven", originalAlt: "Our oven" },
  } });
  assert.deepEqual([result.unmappable, result.problems], [[], []]);
  assert.equal(result.title, "About the bakery");
  assert.equal(result.content, blocks.replace('href="/order/"', 'href="/cakes/"').replace('alt="Our oven"', 'alt="The wood-fired oven"'));
});

await check("a new picture carries its media id into the class and the block, and drops the stale srcset", () => {
  const picture = image(blocksHtml);
  const result = applyWordPressEdits({
    html: blocksHtml, source: blocksSource,
    values: { [picture.id]: { value: "assets/dw/new-oven.png", original: picture.value } },
    media: new Map([["assets/dw/new-oven.png", { id: 501, url: `${UPLOADS}/new-oven.png` }]]),
  });
  assert.deepEqual([result.unmappable, result.problems], [[], []]);
  assert.match(result.content, /<!-- wp:image \{"id":501,"sizeSlug":"large"\} -->/);
  assert.match(result.content, new RegExp(`<img src="${UPLOADS}/new-oven.png" alt="Our oven" class="wp-image-501"/>`));
});

await check("refusals write nothing: styling, structure, stale words, theme words, a partial sentence", () => {
  const story = field(blocksHtml, "Our story");
  const footer = field(blocksHtml, "© 2026 Kumasi Bakery");
  const cases = [
    { [story.id]: { value: story.value, original: story.value, style: "color: red", originalStyle: "" } },
    { $document: { document: { baseHash: "x", html: blocksHtml, changes: ["moved"], undo: [], redo: [] } } },
    { [story.id]: { value: "Our history", original: "Our heritage" } },
    { [footer.id]: { value: "© 2027 Kumasi Bakery", original: footer.value } },
    // "baking since 1998." is inside a longer sentence: never whole, never written.
    { [story.id]: { value: "Sunday hours", original: "baking since 1998." } },
  ];
  for (const values of cases) {
    const result = applyWordPressEdits({ html: blocksHtml, source: blocksSource, values });
    assert.ok(result.unmappable.length + result.problems.length > 0, JSON.stringify(values).slice(0, 80));
    assert.equal(result.content, blocks);
    assert.equal(result.title, "About us");
  }
});

await check("an Elementor page is read-only, says so once, and refuses a publish whole", () => {
  const html = '<!doctype html><html><body><div data-elementor-type="wp-page" data-elementor-id="9" class="elementor elementor-9"><h2>Studio hours</h2></div></body></html>';
  const source = { id: 9, type: "page" as const, content: "<h2>Studio hours</h2>", title: "Studio", builder: detectWordPressBuilder({ postId: 9, content: "<h2>Studio hours</h2>", html }) };
  const map = wordpressFieldMap({ html, source });
  assert.equal(map.writable.size, 0);
  assert.match(map.failure ?? "", /built with Elementor/);
  const heading = field(html, "Studio hours");
  const result = applyWordPressEdits({ html, source, values: { [heading.id]: { value: "Studio times", original: heading.value } } });
  assert.match(result.unmappable[0]?.message ?? "", /Elementor/);
  assert.equal(result.content, source.content);
});

await check("the classic editor: a blank line is a paragraph, a single newline is not a boundary", () => {
  const content = "First line\nSecond line\n\nOpening hours are 7am to 6pm.";
  const html = theme("<p>First line<br />\nSecond line</p>\n<p>Opening hours are 7am to 6pm.</p>");
  const source = { id: 7, type: "page" as const, content, title: "About us", builder: "classic" as const };
  const first = field(html, "First line Second line");
  const hours = field(html, "Opening hours are 7am to 6pm.");
  const map = wordpressFieldMap({ html, source });
  assert.ok(map.writable.has(first.id) && map.writable.has(hours.id));
  const result = applyWordPressEdits({ html, source, values: { [hours.id]: { value: "Opening hours are 6am to 6pm.", original: hours.value } } });
  assert.equal(result.content, "First line\nSecond line\n\nOpening hours are 6am to 6pm.");
});

await check("Divi: a module title in a shortcode attribute is writable, and refuses what would break it", () => {
  const content = '[et_pb_section][et_pb_blurb title="Fresh bread" _builder_version="4.2"]<p>Baked daily before dawn.</p>[/et_pb_blurb][/et_pb_section]';
  const html = theme('<div class="et_pb_blurb"><h4 class="et_pb_module_header"><span>Fresh bread</span></h4><div class="et_pb_blurb_description"><p>Baked daily before dawn.</p></div></div>');
  const source = { id: 7, type: "page" as const, content, title: "About us", builder: "divi" as const };
  const title = field(html, "Fresh bread");
  const body = field(html, "Baked daily before dawn.");
  const map = wordpressFieldMap({ html, source });
  assert.ok(map.writable.has(title.id) && map.writable.has(body.id));
  const ok = applyWordPressEdits({ html, source, values: { [title.id]: { value: "Fresh bread & rolls", original: title.value }, [body.id]: { value: "Baked every morning.", original: body.value } } });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.content, '[et_pb_section][et_pb_blurb title="Fresh bread & rolls" _builder_version="4.2"]<p>Baked every morning.</p>[/et_pb_blurb][/et_pb_section]');
  const quoted = applyWordPressEdits({ html, source, values: { [title.id]: { value: 'The "best" bread', original: title.value } } });
  assert.equal(quoted.problems.length, 1);
  assert.equal(quoted.content, content);
});

await check("checkout reads a WordPress homepage as WordPress, and says what an Elementor page will do", () => {
  assert.deepEqual(wordpressSiteHint('<link rel="stylesheet" href="/wp-content/themes/x/style.css"><div class="wp-block-group">'), { wordpress: true, builder: "blocks" });
  assert.deepEqual(wordpressSiteHint('<script src="/wp-includes/js/x.js"></script><div data-elementor-type="wp-page" data-elementor-id="5">'), { wordpress: true, builder: "elementor" });
  assert.deepEqual(wordpressSiteHint("<html><body>A static page</body></html>"), { wordpress: false, builder: null });
  assert.match(wordpressPurchaseNote("blocks"), /Application Password/);
  assert.doesNotMatch(wordpressPurchaseNote("blocks"), /read-only/);
  assert.match(wordpressPurchaseNote("elementor"), /Elementor, which is edited in full here/);
});

await check("REST routes are built for both API root shapes", () => {
  assert.equal(wordpressEndpoint("https://a.test/wp-json", "/wp/v2/pages", { context: "edit" }), "https://a.test/wp-json/wp/v2/pages?context=edit");
  assert.equal(wordpressEndpoint("https://a.test/?rest_route=", "/wp/v2/pages", { context: "edit" }), "https://a.test/?rest_route=/wp/v2/pages&context=edit");
});

/* ================================================================ the stub */

console.log("\nThe routes, against a stub WordPress");

type StubPage = { id: number; slug: string; title: string; content: string; elementor?: boolean };
const USER = "efua";
const PASSWORD = "abcd efgh ijkl mnop qrst uvwx";
const stub = {
  pages: new Map<number, StubPage>(),
  writes: [] as Array<{ id: number; body: Record<string, string> }>,
  uploads: 0,
  stripAuthorization: false,
  redirectUsersMe: false,
};
const wp = express();
wp.use("/wp-json/wp/v2/media", express.raw({ type: () => true, limit: "5mb" }));
wp.use(express.json());
let origin = "";
wp.get("/", (_req, res) => {
  res.set("Link", `<${origin}/wp-json/>; rel="https://api.w.org/"`).type("html").send('<!doctype html><html><head><meta name="generator" content="WordPress 6.6.2"></head><body>Kumasi Bakery</body></html>');
});
wp.get("/wp-json/", (_req, res) => res.json({ name: "Kumasi Bakery", url: origin, home: origin, namespaces: ["oembed/1.0", "wp/v2"], authentication: { "application-passwords": { endpoints: {} } } }));
wp.use("/wp-json/wp/v2", (req, res, next) => {
  const header = stub.stripAuthorization ? undefined : req.headers.authorization;
  if (!header) return res.status(401).json({ code: "rest_not_logged_in", message: "You are not currently logged in." });
  const [user, password] = Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf8").split(":");
  if (user !== USER && user !== "writer") return res.status(401).json({ code: "invalid_username", message: "Unknown username." });
  if (password !== PASSWORD.replace(/ /g, "")) return res.status(401).json({ code: "incorrect_password", message: "The provided password is an invalid application password." });
  (req as unknown as { wpUser: string }).wpUser = user!;
  next();
});
wp.get("/wp-json/wp/v2/users/me", (req, res) => {
  if (stub.redirectUsersMe) return res.redirect(301, "https://elsewhere.example.test/wp-json/wp/v2/users/me");
  const writer = (req as unknown as { wpUser: string }).wpUser === "writer";
  res.json({ id: writer ? 2 : 1, name: writer ? "Kojo" : "Efua", roles: [writer ? "contributor" : "editor"], capabilities: writer ? { edit_posts: true } : { edit_pages: true, edit_published_pages: true, edit_others_pages: true, publish_pages: true, upload_files: true } });
});
wp.get("/wp-json/wp/v2/plugins", (_req, res) => res.status(403).json({ code: "rest_cannot_view_plugins", message: "Sorry." }));
wp.get("/wp-json/wp/v2/themes", (_req, res) => res.status(403).json({ code: "rest_cannot_view_themes", message: "Sorry." }));
const restPage = (page: StubPage) => ({ id: page.id, link: `${origin}/${page.slug}/`, status: "publish", title: { raw: page.title, rendered: page.title }, content: { raw: page.content }, modified_gmt: "2026-10-21T10:00:00" });
wp.get("/wp-json/wp/v2/pages", (_req, res) => {
  const all = [...stub.pages.values()].map(restPage);
  res.set({ "X-WP-Total": String(all.length), "X-WP-TotalPages": "1" }).json(all);
});
wp.get("/wp-json/wp/v2/pages/:id", (req, res) => {
  const page = stub.pages.get(Number(req.params.id));
  if (!page) return res.status(404).json({ code: "rest_post_invalid_id", message: "Invalid post ID." });
  res.json(restPage(page));
});
wp.post("/wp-json/wp/v2/pages/:id", (req, res) => {
  const page = stub.pages.get(Number(req.params.id))!;
  stub.writes.push({ id: page.id, body: req.body });
  if (typeof req.body.content === "string") page.content = req.body.content;
  if (typeof req.body.title === "string") page.title = req.body.title;
  res.json(restPage(page));
});
wp.post("/wp-json/wp/v2/media", (req, res) => {
  stub.uploads += 1;
  assert.ok(Buffer.isBuffer(req.body) && req.body.length > 0);
  res.status(201).json({ id: 501, source_url: `${origin}/wp-content/uploads/2026/10/new-oven.png` });
});
wp.post("/wp-json/wp/v2/media/:id", (_req, res) => res.json({ id: 501 }));
wp.get("/:slug", (req, res, next) => {
  const page = [...stub.pages.values()].find((candidate) => candidate.slug === req.params.slug);
  if (!page) return next();
  if (page.elementor) return res.type("html").send(`<!doctype html><html><body><div data-elementor-type="wp-page" data-elementor-id="${page.id}" class="elementor elementor-${page.id}"><h2>Studio hours</h2></div></body></html>`);
  res.type("html").send(theme(render(page.content), page.title));
});
const wpServer = wp.listen(0, "127.0.0.1");
await new Promise((resolve) => wpServer.once("listening", resolve));
origin = `http://127.0.0.1:${(wpServer.address() as AddressInfo).port}`;
stub.pages.set(7, { id: 7, slug: "about", title: "About us", content: blocks.replaceAll(UPLOADS, `${origin}/wp-content/uploads/2024/05`) });
stub.pages.set(9, { id: 9, slug: "studio", title: "Studio", content: "<h2>Studio hours</h2>", elementor: true });
const original7 = stub.pages.get(7)!.content;

// Somewhere that is not WordPress at all.
const plain = express();
plain.get("/", (_req, res) => res.type("html").send("<html><body>Just a page</body></html>"));
const plainServer = plain.listen(0, "127.0.0.1");
await new Promise((resolve) => plainServer.once("listening", resolve));
const plainOrigin = `http://127.0.0.1:${(plainServer.address() as AddressInfo).port}`;

await ensureSystemRoles();
const mark = `wpcheck-${randomUUID().slice(0, 8)}`;
const ownerRole = await prisma.accessRole.findUniqueOrThrow({ where: { key: "owner" } });
const owner = await prisma.user.create({ data: { email: `${mark}@example.test`, name: "Ama Owner", role: "OWNER", accessRoleId: ownerRole.id } });
const cookie = `dw_session=${await createSession(owner.id)}`;
const app = express();
app.use(express.json({ limit: "8mb" })); app.use(attachUser); app.use("/api", requireAuth); app.use("/api/website", websiteRouter);
app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/website`;
async function call(method: string, url: string, data?: unknown) {
  const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: data === undefined ? undefined : JSON.stringify(data) });
  const text = await response.text();
  let body: { error?: string } & Record<string, any> = {};
  try { body = JSON.parse(text); } catch { /* 204 or not JSON */ }
  return { status: response.status, body };
}
type PageView = { sections: Array<{ fields: Array<{ id: string; preview: string; kind: string; sourceManaged?: boolean; sourceNote?: string }> }>; builtFrom: { filePath: string; problem: string | null } | null; draftRevision?: number };
const viewFields = (view: PageView) => view.sections.flatMap((section) => section.fields);
const viewField = (view: PageView, preview: string) => {
  const found = viewFields(view).find((entry) => entry.preview.trim() === preview);
  assert.ok(found, `no field reads "${preview}"`);
  return found;
};

let siteId = "";
try {
  await check("checking a connection says who we are and what the site has, and saves nothing", async () => {
    const sites = await prisma.site.count();
    const result = await call("POST", "/wordpress/check", { address: origin, username: USER, password: PASSWORD });
    assert.equal(result.status, 200, result.body.error);
    assert.equal(result.body.siteName, "Kumasi Bakery");
    assert.equal(result.body.user.name, "Efua");
    assert.equal(result.body.version, "6.6.2");
    assert.equal(result.body.pageCount, 2);
    assert.equal(result.body.canEditPages, true);
    assert.equal(await prisma.site.count(), sites);
  });

  await check("each refusal names its own fix", async () => {
    const wrong = await call("POST", "/wordpress/check", { address: origin, username: USER, password: "wrong pass word here" });
    // Never 401: the app signs its own user out on one.
    assert.equal(wrong.status, 422);
    assert.match(wrong.body.error!, /Application Password/);
    const nobody = await call("POST", "/wordpress/check", { address: origin, username: "nobody", password: PASSWORD });
    assert.match(nobody.body.error!, /no user called “nobody”/);
    const writer = await call("POST", "/wordpress/check", { address: origin, username: "writer", password: PASSWORD });
    assert.equal(writer.status, 403);
    assert.match(writer.body.error!, /Administrator or Editor/);
    stub.stripAuthorization = true;
    const stripped = await call("POST", "/wordpress/check", { address: origin, username: USER, password: PASSWORD });
    stub.stripAuthorization = false;
    assert.match(stripped.body.error!, /SetEnvIf Authorization/);
    const elsewhere = await call("POST", "/wordpress/check", { address: plainOrigin, username: USER, password: PASSWORD });
    assert.equal(elsewhere.status, 422);
    assert.match(elsewhere.body.error!, /does not look like a WordPress site/);
  });

  await check("a redirect on an authenticated call is refused, never followed with the password", async () => {
    stub.redirectUsersMe = true;
    const result = await call("POST", "/wordpress/check", { address: origin, username: USER, password: PASSWORD });
    stub.redirectUsersMe = false;
    assert.equal(result.status, 409);
    assert.match(result.body.error!, /https:\/\/elsewhere\.example\.test.*only sent to the address it was connected with/);
  });

  await check("connecting saves the site, its encrypted password and its pages, and opens the front one", async () => {
    const created = await call("POST", "/sites", { name: "Kumasi Bakery", wordpress: { address: origin, username: USER, password: PASSWORD } });
    assert.equal(created.status, 201, created.body.error);
    siteId = created.body.id;
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, include: { wordpress: true, pages: { orderBy: { sortOrder: "asc" } } } });
    assert.equal(site.sourceKind, "wordpress");
    assert.equal(site.publicUrl, origin);
    assert.equal(site.hostedSlug, null);
    assert.ok(site.wordpress && !site.wordpress.applicationPassword.includes("abcd"), "the password must be stored encrypted");
    assert.deepEqual(site.pages.map((page) => [page.path, page.filePath]), [["/about", "wordpress/pages/7"], ["/studio", "wordpress/pages/9"]]);
    const view = await call("GET", `/sites/${siteId}/wordpress`);
    assert.equal(view.body.connection.username, USER);
    assert.ok(!JSON.stringify(view.body).includes("abcd"), "a route must never return the password");
  });

  const pageId = async (path: string) => (await prisma.sitePage.findFirstOrThrow({ where: { siteId, path } })).id;

  await check("the editor opens the live page and locks what WordPress's content does not hold", async () => {
    const opened = await call("GET", `/pages/${await pageId("/about")}`);
    assert.equal(opened.status, 200, opened.body.error);
    const view = opened.body as PageView;
    assert.equal(view.builtFrom?.filePath, "wordpress/pages/7");
    assert.equal(viewField(view, "Our story").sourceManaged, undefined);
    assert.equal(viewField(view, "© 2026 Kumasi Bakery").sourceManaged, true);
    assert.match(viewField(view, "© 2026 Kumasi Bakery").sourceNote ?? "", /theme, a menu/);
  });

  await check("a publish writes the words, the title and the description into WordPress, and only them", async () => {
    const id = await pageId("/about");
    const view = (await call("GET", `/pages/${id}`)).body as PageView;
    const page = await prisma.sitePage.findUniqueOrThrow({ where: { id } });
    const picture = viewFields(view).find((entry) => entry.kind === "image")!;
    const saved = await call("PUT", `/pages/${id}/draft`, { ifRevision: page.draftRevision, values: {
      [viewField(view, "Our story").id]: { value: "Our story, since 1998" },
      [viewField(view, "About us").id]: { value: "About the bakery" },
      [picture.id]: { alt: "The wood-fired oven" },
    } });
    assert.equal(saved.status, 200, saved.body.error);
    const before = stub.writes.length;
    const published = await call("POST", `/pages/${id}/publish`, {});
    assert.equal(published.status, 200, published.body.error);
    assert.equal(stub.writes.length, before + 1);
    assert.equal(stub.pages.get(7)!.content, original7.replace(">Our story<", ">Our story, since 1998<").replace('alt="Our oven"', 'alt="The wood-fired oven"'));
    assert.equal(stub.pages.get(7)!.title, "About the bakery");
    assert.match(published.body.note, /Saved in WordPress/);
    const after = await prisma.sitePage.findUniqueOrThrow({ where: { id } });
    assert.equal(after.draft, null);
    assert.equal(after.publishedHtml, null, "nothing is hosted for a WordPress site");
    const job = await prisma.publishJob.findFirstOrThrow({ where: { pageId: id }, orderBy: { createdAt: "desc" } });
    assert.equal(job.state, "DEPLOYING");
    assert.equal((job.detail as { wordpress?: boolean }).wordpress, true);
    assert.ok(job.verifyText && /since 1998|bakery/.test(job.verifyText), `verifyText ${job.verifyText}`);
    assert.equal(await prisma.sitePageVersion.count({ where: { pageId: id } }), 1);
  });

  await check("a style change is refused with the reason, and nothing reaches WordPress", async () => {
    const id = await pageId("/about");
    const view = (await call("GET", `/pages/${id}`)).body as PageView;
    const page = await prisma.sitePage.findUniqueOrThrow({ where: { id } });
    await call("PUT", `/pages/${id}/draft`, { ifRevision: page.draftRevision, values: { [viewField(view, "Our story, since 1998").id]: { style: "color: #c00" } } });
    const before = stub.writes.length;
    const published = await call("POST", `/pages/${id}/publish`, {});
    assert.equal(published.status, 400);
    assert.match(published.body.error!, /only be made in WordPress/);
    assert.equal(stub.writes.length, before);
    const discard = await prisma.sitePage.findUniqueOrThrow({ where: { id } });
    await prisma.sitePage.update({ where: { id }, data: { draft: Prisma.DbNull, draftRevision: discard.draftRevision + 1 } });
  });

  await check("words changed in WordPress after the draft refuse the publish, and write nothing", async () => {
    const id = await pageId("/about");
    const view = (await call("GET", `/pages/${id}`)).body as PageView;
    const page = await prisma.sitePage.findUniqueOrThrow({ where: { id } });
    await call("PUT", `/pages/${id}/draft`, { ifRevision: page.draftRevision, values: { [viewField(view, "Our story, since 1998").id]: { value: "Our story so far" } } });
    stub.pages.get(7)!.content = stub.pages.get(7)!.content.replace("Our story, since 1998", "Our history");
    const before = stub.writes.length;
    const published = await call("POST", `/pages/${id}/publish`, {});
    assert.equal(published.status, 409, published.body.error);
    assert.equal(stub.writes.length, before);
    assert.notEqual((await prisma.sitePage.findUniqueOrThrow({ where: { id } })).draft, null, "the draft must survive a refused publish");
    stub.pages.get(7)!.content = stub.pages.get(7)!.content.replace("Our history", "Our story, since 1998");
    const discard = await prisma.sitePage.findUniqueOrThrow({ where: { id } });
    await prisma.sitePage.update({ where: { id }, data: { draft: Prisma.DbNull, draftRevision: discard.draftRevision + 1 } });
  });

  await check("a new picture is uploaded to the media library and the page points at WordPress's copy", async () => {
    const id = await pageId("/about");
    const view = (await call("GET", `/pages/${id}`)).body as PageView;
    const picture = viewFields(view).find((entry) => entry.kind === "image")!;
    const current = (await call("GET", `/pages/${id}`)).body as { sections: Array<{ fields: Array<{ id: string; value: string }> }> };
    const oldSrc = current.sections.flatMap((section) => section.fields).find((entry) => entry.id === picture.id)!.value;
    await prisma.siteAsset.create({ data: { siteId, filename: "new oven.png", repoPath: "assets/dw/new-oven.png", contentType: "image/png", content: Buffer.from("89504e470d0a1a0a", "hex"), size: 8 } });
    const page = await prisma.sitePage.findUniqueOrThrow({ where: { id } });
    await prisma.sitePage.update({ where: { id }, data: { draft: { [picture.id]: { value: `https://cdn.example.test/assets/dw/new-oven.png`, original: oldSrc } }, draftRevision: page.draftRevision + 1 } });
    const uploads = stub.uploads;
    const published = await call("POST", `/pages/${id}/publish`, {});
    assert.equal(published.status, 200, published.body.error);
    assert.equal(stub.uploads, uploads + 1);
    const content = stub.pages.get(7)!.content;
    assert.match(content, /<!-- wp:image \{"id":501,"sizeSlug":"large"\} -->/);
    assert.ok(content.includes(`src="${origin}/wp-content/uploads/2026/10/new-oven.png"`) && content.includes("wp-image-501"));
  });

  await check("putting an earlier version back writes the difference into WordPress", async () => {
    const id = await pageId("/about");
    const first = await prisma.sitePageVersion.findFirstOrThrow({ where: { pageId: id, number: 1 } });
    const page = await prisma.sitePage.findUniqueOrThrow({ where: { id } });
    const before = stub.writes.length;
    const restored = await call("POST", `/pages/${id}/versions/${first.id}/publish`, { ifRevision: page.draftRevision });
    assert.equal(restored.status, 200, restored.body.error);
    assert.equal(stub.writes.length, before + 1);
    // The address comes back; the old attachment id cannot be known from the
    // page, so the stale new one is dropped rather than left pointing at the
    // wrong picture's srcset.
    const content = stub.pages.get(7)!.content;
    assert.ok(content.includes("/2024/05/oven.jpg") && !content.includes("new-oven") && !content.includes("wp-image-501"), "the first version's picture should be back");
    assert.ok(content.includes(">Our story, since 1998<"), "words the first version already had stay as they are");
  });

  // The stub stores no `_elementor_data`: what an Editor account, or an
  // Elementor too old to register the meta, sees. `checks/websiteElementor.ts`
  // covers the page when the data is there.
  await check("an Elementor page whose data cannot be read opens read-only with the reason, and its publish is refused", async () => {
    const id = await pageId("/studio");
    const opened = await call("GET", `/pages/${id}`);
    assert.equal(opened.status, 200, opened.body.error);
    assert.match((opened.body as PageView).builtFrom?.problem ?? "", /Elementor data could not be read/);
    const heading = viewField(opened.body as PageView, "Studio hours");
    const page = await prisma.sitePage.findUniqueOrThrow({ where: { id } });
    await call("PUT", `/pages/${id}/draft`, { ifRevision: page.draftRevision, values: { [heading.id]: { value: "Studio times" } } });
    const before = stub.writes.length;
    const published = await call("POST", `/pages/${id}/publish`, {});
    assert.equal(published.status, 409);
    assert.match(published.body.error!, /Elementor/);
    assert.equal(stub.writes.length, before);
  });

  await check("the scan keeps the page list in step with WordPress", async () => {
    stub.pages.set(11, { id: 11, slug: "menu", title: "Menu", content: "<!-- wp:paragraph --><p>Bread</p><!-- /wp:paragraph -->" });
    const scanned = await call("POST", `/sites/${siteId}/scan`);
    assert.equal(scanned.status, 200, scanned.body.error);
    assert.equal(scanned.body.added, 1);
    assert.equal(scanned.body.sourceKind, "wordpress");
  });

  await check("a WordPress site can be bought: checkout no longer refuses it", async () => {
    const purchase = await assessPurchaseCompatibility(origin);
    assert.equal(purchase.status, "COMPATIBLE_WITH_LIMITATIONS");
    assert.match(purchase.notes, /Application Password/);
    const preview = await inspectPublicWebsite(origin);
    assert.notEqual(preview.status, "NOT_SUPPORTED");
  });

  await check("onboarding checks the WordPress connection instead of a repository it will never have", async () => {
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    const { steps } = await onboardingSteps(site);
    const keys = steps.map((entry) => entry.key);
    assert.ok(keys.includes("wordpress") && !keys.includes("repository") && !keys.includes("branch"), keys.join(","));
    const byKey = Object.fromEntries(steps.map((entry) => [entry.key, entry]));
    assert.equal(byKey.wordpress!.state, "done", byKey.wordpress!.detail);
    assert.equal(byKey.publishing!.state, "done", byKey.publishing!.detail);
    assert.match(byKey.publishing!.detail, /into the pages in WordPress as efua/);
    // A password WordPress stopped taking blocks publishing, and says which.
    await prisma.wordPressConnection.update({ where: { siteId }, data: { pausedAt: new Date(), pausedReason: "WordPress did not accept that Application Password for efua." } });
    const paused = Object.fromEntries((await onboardingSteps(site)).steps.map((entry) => [entry.key, entry]));
    await prisma.wordPressConnection.update({ where: { siteId }, data: { pausedAt: null, pausedReason: null } });
    assert.equal(paused.wordpress!.state, "blocked");
    assert.equal(paused.publishing!.state, "blocked");
  });

  await check("the compatibility report counts an Elementor page as editable now", async () => {
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    const pages = await prisma.sitePage.findMany({ where: { siteId } });
    const report = await siteCompatibility(site, pages);
    assert.notEqual(report.pages.find((entry) => entry.path === "/studio")!.grade, "unsupported");
    assert.notEqual(report.pages.find((entry) => entry.path === "/about")!.grade, "unsupported");
  });

  await check("the SEO editor and shared publishing send a WordPress site to WordPress", async () => {
    const seo = await call("POST", `/sites/${siteId}/seo/page`, { pageId: await pageId("/about"), title: "New title" });
    assert.equal(seo.status, 409);
    assert.match(seo.body.error!, /SEO plugin/);
  });
} finally {
  if (siteId) await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.session.deleteMany({ where: { userId: owner.id } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: owner.id } });
  server.close();
  wpServer.close();
  plainServer.close();
  await prisma.$disconnect();
}


console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed:\n  ${failures.join("\n  ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
