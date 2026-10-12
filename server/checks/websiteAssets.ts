/**
 * Loading a site's images without loading a site's images.
 *
 *   DATABASE_URL=<isolated local editor database> npx tsx checks/websiteAssets.ts
 *
 * `embedWebsiteAssets` and `websiteAssetFiles` are the two places a customer's
 * uploaded pictures turn into bytes in this process. Both used to ask for every
 * asset row on the site — content included — and then filter to the handful the
 * page actually used, and `publishPages` called one of them once per page
 * *concurrently*. A site with two hundred photographs therefore loaded its whole
 * library to render one preview, and multiplied that by the page count to
 * publish. That is the shape that has taken this service down before, so:
 *
 *  1. **Only referenced assets are read.** Three uploads, one referenced, one
 *     blob loaded — asserted by counting the queries that name `content`, not
 *     by timing anything. A faster implementation and a lazier one look
 *     identical from outside, and an assertion about elapsed time passes on a
 *     quiet laptop and fails in CI for reasons unrelated to the code.
 *  2. **Many pages read the library once.** Not once per page.
 *  3. **The output is unchanged.** This is a refactor, so the negatives are the
 *     point: an asset referenced twice, and a repoPath that is a prefix of
 *     another, must both come back exactly as before.
 *  4. **A swept asset refuses a commit rather than writing an empty file.**
 *     `content` is nullable now, and committing a null as base64 would put a
 *     broken image in somebody's repository and report success.
 *  5. **A swept asset keeps its address in a preview**, because that address is
 *     where the published site is already serving it from.
 *  6. **Deleting an upload sees both kinds of unpublished change.** A page
 *     draft is the obvious one; a shared element's draft is the one that was
 *     missed, and it is the one where deleting does silent damage — the shared
 *     publish commits no file and the page goes live pointing at nothing.
 *  7. **An upload is found by every address it can be written as** — including
 *     the R2 one, which on a site served from a sub-path does not contain the
 *     site-relative address the draft rule used to look for.
 *  8. **The R2 object outlives its row while anything published may use it**,
 *     as a pure rule: a verified publish, a published page, a page's source.
 *  9. **A hosted site refuses to delete a picture a live page is using**,
 *     because there is no repository holding a second copy — through the real
 *     route, with the row asserted still there. A site with a repository may.
 * 10. **The all-sites library is paged**, follows its cursor to the end without
 *     a gap or a repeat, carries none of the site row, and is still scoped to
 *     the sites the caller may see.
 */
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("These checks require an isolated local test/editor database. Set DATABASE_URL to one.");
}
process.env.NODE_ENV = "development";
process.env.DEV_NO_AUTH = "true";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const { prisma } = await import("../src/lib/prisma.js");
const { assetUrl, embedWebsiteAssets, mentionsAsset, storedObjectStillNeeded, unpublishedUsesOf, websiteAssetFiles, websiteAssetFilesIn } = await import("../src/services/websiteAssets.js");
const { registerWebsiteManagement } = await import("../src/services/websiteManagement.js");

/** Every SiteAsset read, and whether it asked for the blob. */
const seen: string[] = [];
prisma.$use(async (params, next) => {
  if (params.model === "SiteAsset" && params.action === "findMany") {
    const select = (params.args?.select ?? {}) as Record<string, unknown>;
    seen.push(select.content ? "content" : "metadata");
  }
  return next(params);
});
const since = () => { const taken = [...seen]; seen.length = 0; return taken; };

const siteIds: string[] = [];
const userIds: string[] = [];
try {
  const site = await prisma.site.create({
    data: { name: "Asset check", slug: `assetcheck-${randomUUID().slice(0, 8)}`, publicUrl: "https://assets.example/site", repoPath: "docs" },
  });
  siteIds.push(site.id);

  const bytes = (fill: number) => Buffer.alloc(64, fill);
  const make = async (repoPath: string, fill: number) =>
    prisma.siteAsset.create({
      data: { siteId: site.id, filename: "upload.png", repoPath, contentType: "image/png", content: bytes(fill), size: 64, alt: "" },
    });

  const used = await make("assets/dw/used.png", 1);
  await make("assets/dw/spare.png", 2);
  // A repoPath that is a prefix of another: the filter is a substring test, so
  // this is how a naive one quietly commits a file nobody referenced.
  const prefix = await make("assets/dw/used.png.bak", 3);

  const page = `<img src="${assetUrl(site, used.repoPath)}"> and again <img src="${assetUrl(site, used.repoPath)}">`;

  /* ------------------------------------------- 1. only what is referenced */
  since();
  const files = await websiteAssetFiles(site, page);
  equal("one metadata query, then one for the bytes", since(), ["metadata", "content"]);
  equal("only the referenced asset is committed", files.map((file) => file.path), ["docs/assets/dw/used.png"]);
  equal("its bytes are the ones uploaded", files[0]!.content, bytes(1).toString("base64"));
  equal("committed as base64, as before", files[0]!.encoding, "base64");
  check("the prefix-sharing asset is not committed", !files.some((file) => file.path.includes(prefix.repoPath)));
  equal("an asset referenced twice is committed once", files.length, 1);

  const framework = await websiteAssetFilesIn(site, page, "public");
  equal("the framework path puts it in the static folder instead", framework.map((file) => file.path), ["public/assets/dw/used.png"]);

  /* ------------------------------------------- 2. many pages, one read */
  const tenPages = Array.from({ length: 10 }, () => page).join(" ");
  since();
  const many = await websiteAssetFiles(site, tenPages);
  equal("ten pages of HTML still read the library once", since(), ["metadata", "content"]);
  equal("and commit the referenced file once", many.length, 1);

  since();
  const none = await websiteAssetFiles(site, "<p>a page with no pictures at all</p>");
  equal("a page with no images never asks for a blob", since(), ["metadata"]);
  equal("and commits nothing", none, []);

  /* ------------------------------------------- 4 and 5. a swept asset */
  await prisma.siteAsset.update({ where: { id: used.id }, data: { content: null, publishedAt: new Date() } });

  await assert.rejects(
    () => websiteAssetFiles(site, page),
    (error: Error) => /already published/.test(error.message) && /used\.png/.test(error.message),
    "a swept asset refuses the commit and names the file",
  );
  checks++;

  const preview = await embedWebsiteAssets(site, page);
  check("a swept asset keeps its address in a preview", preview.includes(assetUrl(site, used.repoPath)));

  const kept = await prisma.siteAsset.findUniqueOrThrow({ where: { id: used.id } });
  equal("sweeping keeps the size", kept.size, 64);
  equal("sweeping keeps the address", kept.repoPath, "assets/dw/used.png");
  equal("sweeping keeps the description", kept.alt, "");

  /* ------------------------------------------- an unswept one still embeds */
  const spare = `<img src="${assetUrl(site, "assets/dw/spare.png")}">`;
  const embedded = await embedWebsiteAssets(site, spare);
  check("an unpublished upload is still embedded for the preview", embedded.includes(`data:image/png;base64,${bytes(2).toString("base64")}`));
  check("and its URL is gone, because the bytes replaced it", !embedded.includes(assetUrl(site, "assets/dw/spare.png")));

  /* ------------------------------------------- 6. what still needs a file */
  // Nothing unpublished points at the spare upload yet.
  equal("an upload nothing is waiting on is free to delete", await unpublishedUsesOf(site, "assets/dw/spare.png"), []);

  const home = await prisma.sitePage.create({
    data: { siteId: site.id, title: "Home", path: "/", filePath: "index.html", sortOrder: 0 },
  });
  await prisma.sitePage.update({
    where: { id: home.id },
    data: { draft: { hero: { src: assetUrl(site, "assets/dw/spare.png") } } as never },
  });
  equal(
    "a page draft holding it is named by its page",
    await unpublishedUsesOf(site, "assets/dw/spare.png"),
    ["Home"],
  );

  // The one that was missed. A shared change is stored against the element and
  // never copied into a page draft, so a scan of pages alone reports nothing.
  await prisma.sitePage.update({ where: { id: home.id }, data: { draft: Prisma.DbNull } });
  await prisma.sharedElement.create({
    data: {
      siteId: site.id,
      key: "header",
      name: "Header",
      slots: [{ slot: "logo", kind: "image" }] as never,
      draft: { logo: { src: assetUrl(site, "assets/dw/spare.png") } } as never,
      draftRevision: 1,
      draftSavedAt: new Date(),
    },
  });
  equal(
    "a shared element's draft holding it is seen at all, and named as itself",
    await unpublishedUsesOf(site, "assets/dw/spare.png"),
    ["the Header"],
  );
  equal(
    "and an image no unpublished change mentions is still free to delete",
    await unpublishedUsesOf(site, "assets/dw/used.png"),
    [],
  );

  /* ------------------------------------------- 7. every address it can have */
  // This site is served from /site, so its uploads' site-relative address is
  // /site/assets/dw/… — which the R2 address does not contain.
  const r2Address = "https://media.example/assets/dw/spare.png";
  check("the R2 address does not contain the site-relative one here", !r2Address.includes(assetUrl(site, "assets/dw/spare.png")));
  check("the site-relative address is a use", mentionsAsset(`<img src="${assetUrl(site, "assets/dw/spare.png")}">`, "assets/dw/spare.png"));
  check("the bare repository path is a use", mentionsAsset(`<img src="assets/dw/spare.png">`, "assets/dw/spare.png"));
  check("the R2 address is a use", mentionsAsset(`<img src="${r2Address}">`, "assets/dw/spare.png"));
  check("another upload's address is not", !mentionsAsset(`<img src="${assetUrl(site, used.repoPath)}">`, "assets/dw/spare.png"));
  check("no HTML at all is not", !mentionsAsset(null, "assets/dw/spare.png"));

  await prisma.sitePage.update({
    where: { id: home.id },
    data: { draft: { hero: { src: "https://media.example/assets/dw/r2only.png" } } as never },
  });
  equal(
    "a draft holding a picture by its R2 address is seen on a site served from a sub-path",
    await unpublishedUsesOf(site, "assets/dw/r2only.png"),
    ["Home"],
  );
  await prisma.sitePage.update({ where: { id: home.id }, data: { draft: Prisma.DbNull } });

  /* ------------------------------------------- 8. when the R2 object may go */
  // Keys shaped the way the upload routes mint them: the only ones this system
  // ever deletes from a bucket the whole company shares.
  const loose = { repoPath: `assets/dw/${randomUUID()}.png`, publishedAt: null };
  const other = `assets/dw/${randomUUID()}.png`;
  equal("nothing published uses it: the object may go", storedObjectStillNeeded(loose, []), null);
  equal(
    "a page using a different upload does not keep it",
    storedObjectStillNeeded(loose, [{ title: "Home", publishedHtml: `<img src="https://media.example/${other}">`, sourceHtml: null }]),
    null,
  );
  check(
    "a published page carrying its R2 address keeps it, and the reason names the page",
    storedObjectStillNeeded(loose, [{ title: "Home", publishedHtml: `<img src="https://media.example/${loose.repoPath}">`, sourceHtml: null }])?.includes("Home"),
  );
  check(
    "a page's source counts as much as its published copy",
    storedObjectStillNeeded(loose, [{ title: "About", publishedHtml: null, sourceHtml: `<img src="/${loose.repoPath}">` }])?.includes("About"),
  );
  check("a publish verified live keeps it, whatever the pages say now", storedObjectStillNeeded({ ...loose, publishedAt: new Date() }, []) !== null);
  check("another site's library holding the same path keeps it", storedObjectStillNeeded(loose, [], 1) !== null);
  check(
    "a package's own path is never this upload's alone to delete",
    storedObjectStillNeeded({ repoPath: "assets/img/logo.png", publishedAt: null }, []) !== null &&
      storedObjectStillNeeded({ repoPath: "assets/dw/a.png", publishedAt: null }, []) !== null,
  );

  /* ------------------------------------------- 9 and 10. the routes */
  const customer = await prisma.user.create({ data: { email: `assetcheck-${randomUUID().slice(0, 8)}@example.test`, name: "Asset check customer" } });
  userIds.push(customer.id);
  // A site with no repository: DakyX serves it, and its uploads have no other copy.
  const hosted = await prisma.site.create({
    data: { name: "Hosted asset check", slug: `assetcheck-hosted-${randomUUID().slice(0, 8)}`, publicUrl: "https://shop.hosting.invalid", hostedEnabled: true },
  });
  siteIds.push(hosted.id);
  await prisma.siteMember.create({ data: { siteId: hosted.id, userId: customer.id, role: "MANAGER" } });
  const repo = await prisma.site.create({
    data: { name: "Repository asset check", slug: `assetcheck-repo-${randomUUID().slice(0, 8)}`, publicUrl: "https://owner.github.io/site", repoOwner: "owner", repoName: "site" },
  });
  siteIds.push(repo.id);

  const upload = (siteId: string, repoPath: string) =>
    prisma.siteAsset.create({ data: { siteId, filename: repoPath.split("/").pop()!, repoPath, contentType: "image/png", content: bytes(9), size: 64, alt: "" } });
  const onLivePage = await upload(hosted.id, "assets/dw/on-live-page.png");
  const viaR2 = await upload(hosted.id, "assets/dw/via-r2.png");
  const inSource = await upload(hosted.id, "assets/dw/in-source.png");
  const onHiddenPage = await upload(hosted.id, "assets/dw/on-hidden-page.png");
  const unused = await upload(hosted.id, "assets/dw/unused.png");
  const committed = await upload(repo.id, "assets/dw/committed.png");
  const drafted = await upload(repo.id, "assets/dw/drafted.png");

  await prisma.sitePage.createMany({
    data: [
      { siteId: hosted.id, title: "Home", path: "/", filePath: "index.html", sortOrder: 0, sourceHtml: "<h1>Home</h1>", publishedHtml: `<img src="${assetUrl(hosted, onLivePage.repoPath)}">` },
      { siteId: hosted.id, title: "About", path: "/about", filePath: "about.html", sortOrder: 1, sourceHtml: "<h1>About</h1>", publishedHtml: `<img src="https://media.example/${viaR2.repoPath}">` },
      // Never published: what the page *is* still needs the picture.
      { siteId: hosted.id, title: "Contact", path: "/contact", filePath: "contact.html", sortOrder: 2, sourceHtml: `<img src="${assetUrl(hosted, inSource.repoPath)}">` },
      // Not served, and not in the customer's page list either.
      { siteId: hosted.id, title: "Old offer", path: "/old", filePath: "old.html", sortOrder: 3, status: "HIDDEN", sourceHtml: "<h1>Old</h1>", publishedHtml: `<img src="${assetUrl(hosted, onHiddenPage.repoPath)}">` },
      { siteId: repo.id, title: "Home", path: "/", filePath: "index.html", sortOrder: 0, publishedHtml: `<img src="${assetUrl(repo, committed.repoPath)}">` },
      { siteId: repo.id, title: "Pricing", path: "/pricing", filePath: "pricing.html", sortOrder: 1, draft: { hero: { src: assetUrl(repo, drafted.repoPath) } } as never },
    ],
  });

  let principal: Record<string, unknown> | undefined;
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { dbUser?: unknown }).dbUser = principal; next(); });
  const router = express.Router();
  registerWebsiteManagement(router, {
    loadSite: async (_req, id) => prisma.site.findUniqueOrThrow({ where: { id } }),
    loadPage: async () => { throw new Error("Not used by these routes."); },
  });
  app.use("/api/website", router);
  app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/website`;
  try {
    const remove = async (siteId: string, assetId: string) => {
      const response = await fetch(`${base}/sites/${siteId}/assets/${assetId}`, { method: "DELETE" });
      return { status: response.status, error: response.status === 204 ? "" : ((await response.json()) as { error: string }).error };
    };
    const stillThere = async (id: string) => (await prisma.siteAsset.count({ where: { id } })) === 1;
    const deletedEvent = (id: string) => prisma.siteAuditEvent.findFirst({ where: { kind: "ASSET_DELETED", detail: { path: ["assetId"], equals: id } } });

    // --- 9. a hosted site: no second copy anywhere
    for (const [asset, page, how] of [
      [onLivePage, "Home", "by its site address"],
      [viaR2, "About", "by its R2 address"],
      [inSource, "Contact", "in a page's source that has not been published yet"],
    ] as const) {
      const refused = await remove(hosted.id, asset.id);
      equal(`a hosted site refuses to delete a picture a live page uses ${how}`, refused.status, 409);
      check(`…naming the page (${page})`, refused.error.includes(page));
      check("…and saying why", /no other copy/.test(refused.error));
      check("…and the row is still there", await stillThere(asset.id));
      equal("…and nothing was recorded as deleted", await deletedEvent(asset.id), null);
    }

    const hiddenOnly = await remove(hosted.id, onHiddenPage.id);
    equal("a picture only a hidden page carries can go — that page is not served", hiddenOnly.status, 204);
    check("…and its row is gone", !(await stillThere(onHiddenPage.id)));

    const free = await remove(hosted.id, unused.id);
    equal("a picture nothing uses can go", free.status, 204);
    check("…and its row is gone", !(await stillThere(unused.id)));
    check("…and the deletion is on the audit trail", (await deletedEvent(unused.id)) !== null);

    // --- a site with a repository: the published copy is in the repository
    const fromRepo = await remove(repo.id, committed.id);
    equal("a site with a repository may delete a picture its published page uses", fromRepo.status, 204);
    check("…and its row is gone", !(await stillThere(committed.id)));

    const fromDraft = await remove(repo.id, drafted.id);
    equal("…but not one an unpublished draft still needs", fromDraft.status, 409);
    check("…naming the draft's page", fromDraft.error.includes("Pricing"));
    check("…and that row is still there", await stillThere(drafted.id));

    // --- 10. the all-sites library, a page at a time
    principal = { id: customer.id, name: customer.name, active: true, accessRole: { external: true, superAdmin: false }, deniedPermissions: [] };
    const expected = (await prisma.siteAsset.findMany({ where: { siteId: hosted.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } })).map((asset) => asset.id);
    equal("the customer's site has three uploads left to list", expected.length, 3);

    type Listed = { id: string; siteId: string; siteName: string; url: string; repoPath: string; preview: string } & Record<string, unknown>;
    const listed: Listed[] = [];
    const cursors: Array<string | null> = [];
    let cursor: string | null = null;
    do {
      const response: Response = await fetch(`${base}/assets?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      equal("a page of the library answers 200", response.status, 200);
      const items = (await response.json()) as Listed[];
      check("no page is longer than asked for", items.length <= 2);
      listed.push(...items);
      cursor = response.headers.get("X-Next-Cursor");
      cursors.push(cursor);
    } while (cursor && cursors.length < 10);
    equal("the first page says where the next begins", cursors[0], expected[1]);
    equal("and the last says nothing", cursors[cursors.length - 1], null);
    equal("following the cursor reaches every upload once, in order", listed.map((asset) => asset.id), expected);
    check("only the sites this person may open are listed", listed.every((asset) => asset.siteId === hosted.id));
    check("no item carries the site row", listed.every((asset) => !("site" in asset)));
    check("each item still says which site it is on", listed.every((asset) => asset.siteName === hosted.name));
    check("…and where it is served", listed.every((asset) => asset.url === assetUrl(hosted, asset.repoPath)));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log(`websiteAssets: ${checks} checks passed — referenced assets only, one read however many pages, a swept asset refuses a commit, a hosted site keeps a picture a live page uses, and the library pages.`);
} finally {
  await prisma.sharedElement.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.sitePage.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.siteAsset.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}
