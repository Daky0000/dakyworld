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
 */
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

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
const { assetUrl, embedWebsiteAssets, unpublishedUsesOf, websiteAssetFiles, websiteAssetFilesIn } = await import("../src/services/websiteAssets.js");

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

  console.log(`websiteAssets: ${checks} checks passed — referenced assets only, one read however many pages, and a swept asset refuses a commit rather than writing an empty file.`);
} finally {
  await prisma.sharedElement.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.sitePage.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.siteAsset.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.$disconnect();
}
