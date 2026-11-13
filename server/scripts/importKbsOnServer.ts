import fs from "node:fs";
import path from "node:path";
import { effectivePermissions, WITH_ACCESS } from "../src/lib/accessRoles.js";
import { invalidate } from "../src/lib/cache.js";
import { prisma } from "../src/lib/prisma.js";
import { appUrl } from "../src/services/emailSender.js";
import type { WebsiteActor } from "../src/services/websiteActor.js";
import { analyzeImportPackage } from "../src/services/websitePackageImport.js";
import { commitSitePackage, compoundPagePart } from "../src/services/websiteSitePackage.js";

const DEFAULT_ARCHIVE_PATH = "/tmp/kbs-out.zip";
const DEFAULT_SITE_SLUG = "kbs-engineering";
const DEFAULT_SITE_NAME = "KBS Engineering & Transportation Services";
const PREFERRED_OWNER_ID = "cmsgtf08q0000102nyhk0fjps";

async function resolveOwner() {
  const byId = await prisma.user.findUnique({
    where: { id: PREFERRED_OWNER_ID },
    include: WITH_ACCESS,
  });
  if (byId && byId.active) return byId;

  const superAdmin = await prisma.user.findFirst({
    where: { active: true, accessRole: { superAdmin: true } },
    include: WITH_ACCESS,
  });
  if (superAdmin) return superAdmin;

  const ownerRole = await prisma.user.findFirst({
    where: { active: true, role: "OWNER" },
    include: WITH_ACCESS,
  });
  if (ownerRole) return ownerRole;

  const anyActive = await prisma.user.findFirst({
    where: { active: true },
    include: WITH_ACCESS,
  });
  if (!anyActive) {
    throw new Error("No active user found to own imported website.");
  }
  return anyActive;
}

async function main() {
  const archivePath = process.env.ARCHIVE_PATH?.trim() || DEFAULT_ARCHIVE_PATH;
  const slug = process.env.SITE_SLUG?.trim() || DEFAULT_SITE_SLUG;
  const name = process.env.SITE_NAME?.trim() || DEFAULT_SITE_NAME;

  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive not found at ${archivePath}`);
  }

  const owner = await resolveOwner();
  const baseUrl = (await appUrl()).replace(/\/+$/, "");
  const publicUrl = `${baseUrl}/website/${slug}`;

  let site = await prisma.site.findUnique({ where: { slug } });
  if (!site) {
    site = await prisma.site.create({
      data: {
        name,
        slug,
        publicUrl,
        clientId: null,
        hostedEnabled: false,
        members: {
          create: {
            userId: owner.id,
            role: "MANAGER",
          },
        },
      },
    });
    console.log(`Created site ${site.id} (${site.slug}) -> ${site.publicUrl}`);
  } else {
    site = await prisma.site.update({
      where: { id: site.id },
      data: {
        name,
        publicUrl,
        clientId: null,
        deletionScheduledFor: null,
      },
    });
    await prisma.siteMember.upsert({
      where: { siteId_userId: { siteId: site.id, userId: owner.id } },
      create: { siteId: site.id, userId: owner.id, role: "MANAGER" },
      update: { role: "MANAGER" },
    });
    console.log(`Reusing site ${site.id} (${site.slug}) -> ${site.publicUrl}`);
  }

  const actor: WebsiteActor = {
    dbUser: owner,
    permissions: effectivePermissions(owner),
    headers: {},
  };

  const buffer = fs.readFileSync(archivePath);
  const analysis = await analyzeImportPackage({
    buffer,
    filename: path.basename(archivePath),
    autoBuild: true,
  });

  const result = await commitSitePackage({
    req: actor,
    siteId: site.id,
    analysis,
  });

  const pages = await prisma.sitePage.findMany({
    where: { siteId: site.id },
    select: { id: true, path: true, title: true, sourceHtml: true, publishedHtml: true },
    orderBy: [{ sortOrder: "asc" }, { path: "asc" }],
  });

  let publishedCount = 0;
  for (const page of pages) {
    if (page.sourceHtml && page.publishedHtml !== page.sourceHtml) {
      await prisma.sitePage.update({
        where: { id: page.id },
        data: { publishedHtml: page.sourceHtml },
      });
      publishedCount++;
    }
  }

  const assetsCount = await prisma.siteAsset.count({ where: { siteId: site.id } });
  await invalidate(`public:${site.id}`, "pages").catch(() => undefined);
  await invalidate("public", "hosts").catch(() => undefined);

  console.log(`Imported into site ${site.id} owned by ${owner.id} (${owner.email})`);
  console.log(`Commit result: ${JSON.stringify(result)}`);
  console.log(`Published HTML synced on ${publishedCount}/${pages.length} pages; total assets: ${assetsCount}`);
  for (const page of pages) {
    const part = compoundPagePart(page.path);
    const route = part ? `${baseUrl}/website/${slug}-${part}` : `${baseUrl}/website/${slug}/`;
    console.log(`  - ${page.path} (${page.title}) -> ${route}`);
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
