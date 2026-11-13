/**
 * Direct import script for Gulf Contracting Co. W.L.L.
 *
 * Runs on the server (or locally with DB connection), extracts the static export,
 * parses all 52 pages, freezes hydration, uploads assets to R2, rewrites internal links,
 * and commits all pages to the database under the Gulf Contracting site.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { prisma } from "../src/lib/prisma.js";
import { appUrl } from "../src/services/emailSender.js";
import { extractPageTitle, routePathForFile } from "../src/services/websitePackageImport.js";
import { commitSitePackage } from "../src/services/websiteSitePackage.js";
import type { WebsiteActor } from "../src/services/websiteActor.js";
import { buildPageTree, flattenPageTree } from "../client/src/lib/pageTree.js";

function getAllFiles(currentDir: string, baseDir = currentDir): Array<{ relPath: string; fullPath: string; buffer: Buffer }> {
  let results: Array<{ relPath: string; fullPath: string; buffer: Buffer }> = [];
  const list = fs.readdirSync(currentDir);
  for (const file of list) {
    const fullPath = path.join(currentDir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(fullPath, baseDir));
    } else {
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join("/");
      results.push({ relPath, fullPath, buffer: fs.readFileSync(fullPath) });
    }
  }
  return results;
}

async function main() {
  console.log("=== GULF CONTRACTING SITE IMPORT ===");

  // 1. Prepare directory
  const tarPath = "/tmp/gulf-static.tar.gz";
  const extractDir = "/tmp/gulf-export";

  let siteSourceDir = "";
  if (fs.existsSync(path.join(extractDir, "gulf-contracting-static-site"))) {
    console.log(`Using already extracted files in ${extractDir}/gulf-contracting-static-site...`);
    siteSourceDir = path.join(extractDir, "gulf-contracting-static-site");
  } else if (fs.existsSync(tarPath)) {
    console.log(`Extracting ${tarPath} into ${extractDir}...`);
    fs.mkdirSync(extractDir, { recursive: true });
    execSync(`tar -xzf "${tarPath}" -C "${extractDir}"`);
    siteSourceDir = path.join(extractDir, "gulf-contracting-static-site");
    if (!fs.existsSync(siteSourceDir)) siteSourceDir = extractDir;
  } else if (fs.existsSync("C:/Users/ASUS/Downloads/New folder/gulf-contracting-static-site")) {
    siteSourceDir = "C:/Users/ASUS/Downloads/New folder/gulf-contracting-static-site";
  } else {
    throw new Error(`Cannot find site archive at ${tarPath} or local path.`);
  }

  console.log(`Scanning site files from ${siteSourceDir}...`);
  const allFiles = getAllFiles(siteSourceDir);
  console.log(`Found ${allFiles.length} total files.`);

  // 2. Separate HTML pages and static assets
  const htmlFiles = allFiles.filter((f) => /\.(html|htm)$/i.test(f.relPath));
  const assetFiles = allFiles.filter((f) => !/\.(html|htm)$/i.test(f.relPath));

  console.log(`Found ${htmlFiles.length} HTML pages and ${assetFiles.length} asset files.`);

  const pages = htmlFiles.map((f) => {
    const html = f.buffer.toString("utf8");
    return {
      filePath: f.relPath,
      path: routePathForFile(f.relPath, true),
      title: extractPageTitle(html, f.relPath),
      html,
    };
  });

  const assets = assetFiles.map((f) => ({
    repoPath: f.relPath,
    content: f.buffer,
  }));

  // 3. Find or create Site
  const owner = await prisma.user.findFirst({
    where: { role: "OWNER" },
    include: { accessRole: true },
  });
  if (!owner) throw new Error("No OWNER user found in database.");

  let site = await prisma.site.findFirst({
    where: {
      OR: [
        { slug: { startsWith: "gulf-contracting" } },
        { name: "Gulf Contracting Co. W.L.L." },
      ],
    },
  });

  if (!site) {
    console.log("Creating Site record for 'Gulf Contracting Co. W.L.L.'...");
    site = await prisma.site.create({
      data: {
        name: "Gulf Contracting Co. W.L.L.",
        slug: "gulf-contracting",
        publicUrl: `${(await appUrl()).replace(/\/+$/, "")}/website/gulf-contracting`,
        members: {
          create: {
            userId: owner.id,
            role: "MANAGER",
          },
        },
      },
    });
    console.log(`Site created: ID=${site.id}, Slug=${site.slug}`);
  } else {
    console.log(`Using existing Site: ID=${site.id}, Slug=${site.slug}`);
  }

  // 4. Commit package to site (freezes Next.js hydration, stores assets to R2, rewrites links, creates pages)
  console.log("Running commitSitePackage...");
  const accessRole = owner.accessRole ?? {
    id: "owner-role",
    name: "Owner",
    key: "owner",
    superAdmin: true,
    system: true,
    permissions: ["website.manage", "*"],
  };

  const actor: WebsiteActor = {
    dbUser: { ...owner, accessRole } as any,
    permissions: new Set(["website.manage", "system.admin", "*"]),
    headers: {},
  };

  const result = await commitSitePackage({
    req: actor,
    siteId: site.id,
    analysis: {
      isZip: true,
      pages,
      assets,
      missingAssets: [],
      externalResources: [],
      warnings: [],
      sourcePackage: null,
      autoBuilt: false,
    },
  });

  console.log("\n=== IMPORT SUCCESSFUL! ===");
  console.log(`Site ID:           ${result.siteId}`);
  console.log(`Site Name:         ${result.siteName}`);
  console.log(`Pages Imported:    ${result.pagesCount}`);
  console.log(`Assets Stored:     ${result.assetsCount} (in Cloudflare R2 as WebP)`);
  console.log(`Links Rewritten:   ${result.linksRewritten}`);
  console.log(`Build Kind:        ${result.build.label} (Frozen: ${result.build.frozen})`);
  console.log(`Controls Restored: ${result.interactions.restored}`);
  console.log(`Duplicates Handled:${result.duplicatePages.length}`);

  console.log("\n--- Notes ---");
  for (const note of result.notes) {
    console.log(`• ${note}`);
  }

  console.log("\n--- Page Hierarchy ---");
  const tree = buildPageTree(result.pages);
  const rows = flattenPageTree(tree, new Set());
  for (const r of rows) {
    const indent = "  ".repeat(r.depth);
    console.log(`${indent}• ${r.node.label} (${r.node.path})`);
  }

  // 5. Clean up temporary files on server
  if (fs.existsSync(tarPath)) {
    try {
      fs.unlinkSync(tarPath);
      fs.rmSync(extractDir, { recursive: true, force: true });
      console.log("\nCleaned up temporary transfer files.");
    } catch {}
  }

  console.log("\nGulf Contracting site import completed successfully!");
}

main()
  .catch((err) => {
    console.error("IMPORT ERROR:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
