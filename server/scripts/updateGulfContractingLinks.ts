import { prisma } from "../src/lib/prisma.js";
import { rewritePageLinks } from "../src/services/websiteSitePackage.js";

async function main() {
  console.log("=== Updating Gulf Contracting to path-based /website/gulf-contracting ===");

  const site = await prisma.site.findFirst({
    where: {
      OR: [
        { slug: "gulf-contracting" },
        { id: "cmwdzdnbs00001hotv4jbnkup" },
      ],
    },
  });

  if (!site) {
    console.error("Gulf Contracting site not found.");
    process.exit(1);
  }

  console.log(`Found Site: ${site.name} (${site.id}), current slug: ${site.slug}`);

  // 1. Update site record
  await prisma.site.update({
    where: { id: site.id },
    data: {
      publicUrl: `https://os.dakyworld.com/website/${site.slug}`,
      hostedSlug: null,
      hostedEnabled: false,
    },
  });
  console.log(`Updated site.publicUrl -> https://os.dakyworld.com/website/${site.slug}, cleared hostedSlug.`);

  // 2. Fetch pages
  const pages = await prisma.sitePage.findMany({
    where: { siteId: site.id },
    select: { id: true, title: true, filePath: true, path: true, sourceHtml: true, publishedHtml: true },
  });

  console.log(`Found ${pages.length} pages. Rewriting internal links...`);

  const byFile = new Map(pages.map((p) => [p.filePath, p.path]));
  const routes = new Set(pages.map((p) => p.path));
  const basePath = `/website/${site.slug}`;
  const scopedAssetBase = `/website/${site.slug}/assets/dw/`;
  const rewriteAssetUrls = (text: string) => text.replace(/(^|["'(\s,=])\/assets\/dw\//g, `$1${scopedAssetBase}`);

  let totalRewritten = 0;

  for (const page of pages) {
    if (!page.sourceHtml) continue;
    const { html: linkedSource, rewritten } = rewritePageLinks(page.sourceHtml, page.filePath, byFile, routes, basePath, site.slug);
    totalRewritten += rewritten;
    const newSource = rewriteAssetUrls(linkedSource);

    const linkedPublished = page.publishedHtml
      ? rewritePageLinks(page.publishedHtml, page.filePath, byFile, routes, basePath, site.slug).html
      : null;
    const newPublished = rewriteAssetUrls(linkedPublished || newSource);

    await prisma.sitePage.update({
      where: { id: page.id },
      data: {
        sourceHtml: newSource,
        publishedHtml: newPublished,
      },
    });
  }

  // 3. Rewrite /assets/dw/ inside SitePageVersion snapshots
  const versions = await prisma.sitePageVersion.findMany({
    where: { page: { siteId: site.id } },
    select: { id: true, html: true },
  });
  let updatedVersions = 0;
  for (const v of versions) {
    const nextHtml = rewriteAssetUrls(v.html);
    if (nextHtml !== v.html) {
      await prisma.sitePageVersion.update({ where: { id: v.id }, data: { html: nextHtml } });
      updatedVersions++;
    }
  }

  // 4. Rewrite /assets/dw/ inside text assets (CSS, JS)
  const textAssets = await prisma.siteAsset.findMany({
    where: {
      siteId: site.id,
      contentType: { in: ["text/css", "application/javascript", "text/javascript"] },
      content: { not: null },
    },
    select: { id: true, repoPath: true, content: true },
  });
  let updatedAssets = 0;
  for (const asset of textAssets) {
    if (!asset.content) continue;
    const original = Buffer.from(asset.content).toString("utf8");
    const next = rewriteAssetUrls(original);
    if (next !== original) {
      const buf = Buffer.from(next, "utf8");
      await prisma.siteAsset.update({
        where: { id: asset.id },
        data: { content: buf, size: buf.length },
      });
      updatedAssets++;
    }
  }

  console.log(`Successfully rewrote ${totalRewritten} links across ${pages.length} pages (${updatedVersions} versions, ${updatedAssets} text assets).`);

  // Verify index page links & asset refs
  const indexPage = pages.find((p) => p.path === "/" || p.filePath.includes("index.html"));
  if (indexPage) {
    const freshIndex = await prisma.sitePage.findUnique({
      where: { id: indexPage.id },
      select: { sourceHtml: true },
    });
    const sampleLinks = [...(freshIndex?.sourceHtml?.matchAll(/href="(\/website\/[^"]+)"/g) ?? [])].slice(0, 5).map(m => m[1]);
    console.log("Sample verified internal links on index page:");
    sampleLinks.forEach(link => console.log(`  -> ${link}`));
  }

  console.log("=== Done! ===");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
