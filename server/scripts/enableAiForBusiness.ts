import "dotenv/config";
import { writeFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { siteOwnTier } from "../src/services/websiteAiSwitch.js";
import { updateSiteSettings } from "../src/services/websiteSiteSettings.js";

/**
 * Switches AI on for every Business website that has it saved as off (Dan,
 * 21 Oct 2026: one switch, on for Business sites, existing and new).
 *
 * A Business site that never saved its settings is on already — the plan
 * decides when nobody has chosen (`siteAiEnabled`). But until 21 Oct 2026 the
 * settings schema defaulted the switch to false and every save of the settings
 * screen wrote that default, so a Business site whose name or colours were
 * ever saved carries an `aiEnabled: false` nobody chose. Those are the ones
 * this turns on.
 *
 *   npx tsx scripts/enableAiForBusiness.ts                            # dry run
 *   npx tsx scripts/enableAiForBusiness.ts --apply --backup <file>    # writes
 *
 * `--apply` refuses to run without `--backup`, which records each site's
 * previous value before anything is written. Every site switched on gets an
 * audit line.
 */
const apply = process.argv.includes("--apply");
const backupIndex = process.argv.indexOf("--backup");
const backupPath = backupIndex >= 0 ? process.argv[backupIndex + 1] : undefined;
if (apply && !backupPath) {
  console.error("--apply needs --backup <file>, so every replaced value is recorded first.");
  process.exit(2);
}

try {
  const sites = await prisma.site.findMany({
    where: { settings: { path: ["aiEnabled"], equals: false } },
    select: { id: true, name: true, settings: true },
    orderBy: { name: "asc" },
  });
  const business: typeof sites = [];
  for (const site of sites) if ((await siteOwnTier(site.id)) === "MANAGED") business.push(site);

  console.log(`${sites.length} website(s) have AI saved as off; ${business.length} of them are on Business.`);
  for (const site of business) console.log(`  switch on  ${site.id} ${site.name}`);

  if (!apply) {
    console.log("\nDry run: nothing was written. Re-run with --apply --backup <file> to switch them on.");
  } else {
    writeFileSync(backupPath!, JSON.stringify(business.map(({ id, name }) => ({ id, name, aiEnabled: false })), null, 2));
    console.log(`\nBackup of ${business.length} previous value(s) written to ${backupPath}.`);
    let switched = 0;
    for (const site of business) {
      let changed = false;
      await updateSiteSettings(site.id, (current) => {
        // Somebody may have saved it while this ran; their choice stands.
        if ((current as { aiEnabled?: unknown }).aiEnabled !== false) return current;
        changed = true;
        return { ...current, aiEnabled: true };
      });
      if (!changed) { console.log(`  skipped ${site.name}: changed by somebody while this ran`); continue; }
      await prisma.siteAuditEvent.create({ data: {
        siteId: site.id, kind: "SETTINGS_UPDATED", actorName: "Maintenance script",
        summary: "Switched AI on: this website is on Business, and AI is on for Business websites",
        detail: { changed: ["aiEnabled"], from: false, to: true } as Prisma.InputJsonValue,
      } });
      switched += 1;
    }
    console.log(`Switched on ${switched} of ${business.length}.`);
  }
} finally {
  await prisma.$disconnect();
}
