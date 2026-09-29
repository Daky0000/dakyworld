import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { CapacityError } from "./capacity.js";
type Ownership = {
    owner: string;
    keys: string[];
    lost: boolean;
};
const storage = new AsyncLocalStorage<Ownership>();
const leaseSeconds = 90;
async function claim(tx: Prisma.TransactionClient, key: string, owner: string) {
    const rows = await tx.$queryRaw<Array<{
        key: string;
    }>> `
    INSERT INTO "ServiceLease" ("key", "owner", "expiresAt") VALUES (${key}, ${owner}, NOW() + ${leaseSeconds} * INTERVAL '1 second')
    ON CONFLICT ("key") DO UPDATE SET "owner" = EXCLUDED."owner", "expiresAt" = EXCLUDED."expiresAt"
    WHERE "ServiceLease"."expiresAt" < NOW() RETURNING "key"`;
    return rows.length === 1;
}
/** Validated inside the final transaction; stale owners cannot write publication state. */
export async function assertPublicationOwnership(tx?: Prisma.TransactionClient) {
    const context = storage.getStore();
    if (!context)
        return;
    if (context.lost)
        throw new CapacityError("Publication ownership expired. Review the publish status before retrying.", 409);
    const db = tx ?? prisma;
    const rows = await db.$queryRaw<Array<{
        key: string;
    }>>(Prisma.sql `
    SELECT "key" FROM "ServiceLease" WHERE "key" IN (${Prisma.join(context.keys)})
      AND "owner" = ${context.owner} AND "expiresAt" > clock_timestamp()
    ORDER BY "key" ${tx ? Prisma.sql `FOR UPDATE` : Prisma.empty}`);
    if (rows.length !== context.keys.length) {
        context.lost = true;
        throw new CapacityError("Publication ownership expired. Review the publish status before retrying.", 409);
    }
}
export async function withPublicationOwnership<T>(keys: string[], capacityLimit: number | null, work: () => Promise<T>): Promise<T> {
    const context: Ownership = { owner: randomUUID(), keys: [...new Set(keys)].sort(), lost: false };
    if (!context.keys.length)
        return work();
    const resourceKeys = [...context.keys];
    await prisma.$transaction(async (tx) => {
        if (capacityLimit) {
            let slotKey: string | undefined;
            for (let slot = 0; slot < capacityLimit; slot++) {
                const key = `publication:slot:${slot}`;
                if (await claim(tx, key, context.owner)) {
                    slotKey = key;
                    break;
                }
            }
            if (!slotKey)
                throw new CapacityError("Publishing is busy. Your draft is safe; try again shortly.");
            context.keys.push(slotKey);
        }
        for (const key of resourceKeys) {
            if (!await claim(tx, key, context.owner))
                throw new CapacityError("This page or website is already publishing. Wait for that publish to finish.", 409);
        }
    });
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
        if (heartbeat)
            return;
        heartbeat = prisma.serviceLease.updateMany({ where: { key: { in: context.keys }, owner: context.owner, expiresAt: { gt: new Date() } },
            data: { expiresAt: new Date(Date.now() + leaseSeconds * 1000) } })
            .then(result => { if (result.count !== context.keys.length)
            context.lost = true; })
            .catch(() => { context.lost = true; })
            .finally(() => { heartbeat = undefined; });
    }, 15000);
    timer.unref();
    try {
        return await storage.run(context, work);
    }
    finally {
        clearInterval(timer);
        // Renewals only update existing owner rows, so a delayed renewal cannot recreate this lease.
        await prisma.serviceLease.deleteMany({ where: { key: { in: context.keys }, owner: context.owner } }).catch(() => undefined);
    }
}
export async function commitPublication<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await assertPublicationOwnership(tx);
        return work(tx);
    }, { maxWait: 5000, timeout: 15000 });
}
