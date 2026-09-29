import { PrismaClient } from "@prisma/client";
import { capacity, integerSetting } from "./capacity.js";

// Single shared Prisma client instance for the whole process.
const databaseUrl = process.env.DATABASE_URL;
const url = databaseUrl ? new URL(databaseUrl) : null;
if (url && !url.searchParams.has("connection_limit")) {
  url.searchParams.set("connection_limit", String(integerSetting("DB_POOL_SIZE", capacity.role === "worker" ? 5 : 10, 1, 100)));
}
export const prisma = new PrismaClient({
  ...(url ? { datasources: { db: { url: url.toString() } } } : {}),
  log: [{ emit: "event", level: "query" }],
});
export const databaseMetrics = { queries: 0, durationMs: 0, slowQueries: 0 };
prisma.$on("query", event => {
  databaseMetrics.queries++;
  databaseMetrics.durationMs += event.duration;
  if (event.duration > 250) databaseMetrics.slowQueries++;
});
