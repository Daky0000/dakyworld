import { startCostAlerts } from "./costControl.js";
import { randomUUID } from "node:crypto";
import { acquireLease } from "../lib/leases.js";
import { capacity } from "../lib/capacity.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { startWatcher, stopWatcher } from "./mailbox/watcher.js";
import { startWebsiteWorkQueue } from "./websiteWorkQueue.js";
import { deliverInvalidations } from "./cacheInvalidation.js";
import { prisma } from "../lib/prisma.js";
import { renewBackgroundOwnership, stopBackgroundOwnership } from "../lib/backgroundOwnership.js";

export let backgroundReady = false;
export function startBackgroundRuntime() {
  if (capacity.role === "api") return () => undefined;
  const owner = randomUUID();
  let owned = false;
  let stopped = false;
  let busy = false;
  let stopQueue: (() => Promise<void>) | undefined;
  let delivery: ReturnType<typeof setInterval> | undefined;
  let lastCleanup = 0;
  const heartbeat = async () => {
    if (stopped || busy) return;
    busy = true;
    const deadline = setTimeout(() => { if (owned) process.exit(1); }, 20_000);
    try {
      const acquired = await acquireLease("background-runtime", owner, 45);
      if (stopped) return;
      if (!acquired) {
        if (owned) process.exit(1);
        return;
      }
      renewBackgroundOwnership();
      if (!owned) {
        owned = true;
        startCostAlerts();
        startScheduler();
        void startWatcher().catch(() => console.error("Mailbox watcher failed to start"));
        if (capacity.admission) stopQueue = startWebsiteWorkQueue();
        delivery = setInterval(() => { void deliverInvalidations().catch(() => undefined); }, 1000);
        backgroundReady = true;
      }
      if (Date.now() - lastCleanup > 60_000) {
        lastCleanup = Date.now();
        await prisma.cacheInvalidation.deleteMany({ where: { deliveredAt: { lt: new Date(Date.now() - 15 * 60_000) } } });
        // Keep quota/idempotency records for 30 days; never delete unfinished work.
        await prisma.websiteWorkJob.deleteMany({ where: { completedAt: { lt: new Date(Date.now() - 30 * 86_400_000) }, state: { in: ["COMPLETED", "FAILED", "CANCELLED"] } } });
      }
    } catch {
      if (owned) process.exit(1); // Fail closed before the ownership lease can expire.
      console.error("Background ownership unavailable; retrying");
    } finally { clearTimeout(deadline); busy = false; }
  };
  void heartbeat();
  const timer = setInterval(() => { void heartbeat(); }, 10_000);
  return async () => {
    stopped = true;
    stopBackgroundOwnership();
    clearInterval(timer); if (delivery) clearInterval(delivery);
    backgroundReady = false;
    const results = await Promise.allSettled([stopScheduler(), stopWatcher(), Promise.resolve().then(() => stopQueue?.())]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Background shutdown did not drain cleanly");
    // Leave the lease to expire, protecting against work still draining during shutdown.
  };
}
