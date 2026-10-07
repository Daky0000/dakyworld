import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { ensureTheses, TOP_10_TARGET_COUNTRIES, TOP_10_THESIS_KEYS } from "../src/services/hunt/theses.js";
import { nextHuntAt } from "../src/services/hunt/run.js";

async function main() {
  console.log("=== Dakyworld Global Hunts: Top 10 Target Economies ===");
  console.log("Target Countries:", TOP_10_TARGET_COUNTRIES.join(", "));
  console.log();

  console.log("1. Ensuring all theses and scraper sources exist in database...");
  const { created, sources } = await ensureTheses();
  console.log(`   Created ${created} new theses and ${sources} scraper sources.`);

  const shouldEnable = process.argv.includes("--enable");

  console.log("\n2. Checking Top 10 Target Country theses...");
  const theses = await prisma.leadThesis.findMany({
    where: { key: { in: [...TOP_10_THESIS_KEYS] } },
    include: { source: true },
    orderBy: { name: "asc" },
  });

  for (const thesis of theses) {
    const input = (thesis.source?.input as Record<string, unknown>) ?? {};
    const loc = input.locationQuery ?? "N/A";
    const status = thesis.enabled ? "ACTIVE (hunting)" : "PAUSED (disabled)";
    console.log(` - [${status}] ${thesis.name}`);
    console.log(`   Key: ${thesis.key} | Location: ${loc} | Tz: ${thesis.timezone}`);
  }

  if (shouldEnable) {
    console.log("\n3. Enabling all Top 10 Country hunts...");
    let enabledCount = 0;
    for (const thesis of theses) {
      if (!thesis.enabled) {
        await prisma.leadThesis.update({
          where: { id: thesis.id },
          data: {
            enabled: true,
            nextRunAt: nextHuntAt({ ...thesis, enabled: true }),
          },
        });
        enabledCount++;
      }
    }
    console.log(`   Enabled ${enabledCount} hunts. All 10 countries are now actively scheduled.`);
  } else {
    console.log("\n(Tip: Run with --enable to turn on automated hunting for all 10 countries immediately)");
  }
}

main()
  .catch((err) => {
    console.error("Failed to sync hunts:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
