import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { CapacityError } from "./capacity.js";
import { AsyncLocalStorage } from "node:async_hooks";
const held = new AsyncLocalStorage<Set<string>>();

export async function acquireLease(key: string, owner: string, seconds = 30): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ key: string }>>`
    INSERT INTO "ServiceLease" ("key", "owner", "expiresAt") VALUES (${key}, ${owner}, NOW() + ${seconds} * INTERVAL '1 second')
    ON CONFLICT ("key") DO UPDATE SET "owner" = EXCLUDED."owner", "expiresAt" = EXCLUDED."expiresAt"
    WHERE "ServiceLease"."expiresAt" < NOW() OR "ServiceLease"."owner" = ${owner} RETURNING "key"`;
  return rows.length === 1;
}

export async function withCapacityLease<T>(resource: string, limit: number, work: () => Promise<T>): Promise<T> {
  if (held.getStore()?.has(resource)) return work();
  const owner = randomUUID();
  let key: string | null = null;
  for (let slot = 0; slot < limit; slot++) {
    const candidate = `capacity:${resource}:${slot}`;
    if (await acquireLease(candidate, owner, 120)) { key = candidate; break; }
  }
  if (!key) throw new CapacityError();
  let finishing = false;
  let heartbeat: Promise<void> | undefined;
  // A lost ownership heartbeat must stop this process before a second owner can run.
  const timer = setInterval(() => {
    if (heartbeat || finishing) return;
    const deadline = setTimeout(() => { if (!finishing) process.exit(1); }, 30_000);
    heartbeat = acquireLease(key!, owner, 120).then(ok => { if (!ok && !finishing) process.exit(1); })
      .catch(() => { if (!finishing) process.exit(1); }).finally(() => { clearTimeout(deadline); heartbeat = undefined; });
  }, 30_000);
  timer.unref();
  try { return await held.run(new Set([...(held.getStore() ?? []), resource]), work); }
  finally {
    finishing = true;
    clearInterval(timer);
    // Do not release while a delayed heartbeat could recreate the lease afterwards.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([Promise.resolve(heartbeat).then(() => true), new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 5000); })]);
    if (deadline) clearTimeout(deadline);
    if (settled) await prisma.serviceLease.deleteMany({ where: { key, owner } }).catch(() => undefined);
  }
}
