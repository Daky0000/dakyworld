import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

// Read-only and compatible with the schema before the additive migration.
try {
  const rows = await prisma.$queryRaw<Array<{ total: bigint; country: bigint; city: bigint }>>`
    SELECT COUNT(*) AS total, COUNT(country) AS country, COUNT(city) AS city FROM "DemoVisit"`;
  console.log(JSON.stringify(rows, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
  console.log("Pre-migration records have no verifiable provenance and will display as legacy. No rows changed.");
} finally { await prisma.$disconnect(); }
