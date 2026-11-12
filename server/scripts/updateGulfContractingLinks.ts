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

  let totalRewritten = 0;

  for (const page of pages) {
    if (!page.sourceHtml) continue;
    const { html: newSource, rewritten } = rewritePageLinks(page.sourceHtml, page.filePath, byFile, routes, basePath);
    totalRewritten += rewritten;

    const newPublished = page.publishedHtml
      ? rewritePageLinks(page.publishedHtml, page.filePath, byFile, routes, basePath).html
      : null;

    await prisma.sitePage.update({
      where: { id: page.id },
      data: {
        sourceHtml: newSource,
        publishedHtml: newPublished || newSource,
      },
    });
  }

  console.log(`Successfully rewrote ${totalRewritten} links across ${pages.length} pages.`);

  // Verify index page links
  const indexPage = pages.find((p) => p.path === "/" || p.filePath.includes("index"));
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
