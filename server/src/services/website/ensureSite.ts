import { prisma } from "../../lib/prisma.js";

/**
 * The company's own website, put into the editor once.
 *
 * Seeded rather than created through the UI because it is not a choice anybody
 * makes — dakyworld.com exists, it is in this repository, and an editor that
 * opened onto an empty list would be asking the owner to tell it something it
 * already knows.
 *
 * Written once and never re-applied: the repository, branch and address are all
 * editable afterwards, and a boot that reset them would undo a correction the
 * moment the service restarted. Pages are deliberately *not* seeded here — they
 * are discovered from the repository or the sitemap, so a page added next month
 * appears without anybody editing this file.
 */
export async function ensureDakyworldSite(): Promise<boolean> {
  const existing = await prisma.site.findUnique({ where: { slug: "dakyworld" } });
  if (existing) return false;

  await prisma.site.create({
    data: {
      name: "Dakyworld",
      slug: "dakyworld",
      publicUrl: "https://dakyworld.com",
      // The website is the root of this same repository, served by GitHub Pages
      // — see DOMAINS.md. `repoPath` is empty for exactly that reason.
      repoOwner: "Daky0000",
      repoName: "dakyworld",
      repoBranch: "main",
      repoPath: "",
    },
  });
  return true;
}
