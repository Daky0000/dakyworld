import { installShutdown } from "./lib/shutdown.js";
import "dotenv/config";
import http from "node:http";
import { capacity } from "./lib/capacity.js";
import { prisma } from "./lib/prisma.js";
import { startBackgroundRuntime } from "./services/backgroundRuntime.js";
import { startLocalInvalidations } from "./services/cacheInvalidation.js";
import { drainRunningTasks } from "./services/agents/runner.js";

if (capacity.role !== "worker") throw new Error("Worker requires SERVICE_ROLE=worker");
await prisma.$connect();
const stopLocal = startLocalInvalidations();
const stop = startBackgroundRuntime();
// A standby worker is healthy while waiting for the old deployment's ownership lease.
const server = http.createServer((req, res) => {
  if (req.url !== "/api/ready") { res.writeHead(404); res.end(); return; }
  void prisma.$queryRaw`SELECT 1`.then(() => { res.writeHead(200); res.end("ready"); }, () => { res.writeHead(503); res.end("unavailable"); });
});
server.listen(Number(process.env.PORT ?? 4001), "0.0.0.0");
installShutdown({
  server,
  stop: async () => { stopLocal(); await stop(); },
  drain: drainRunningTasks,
  disconnect: () => prisma.$disconnect(),
});
