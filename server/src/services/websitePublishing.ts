import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { WebsiteError } from "./website/site.js";

/** A database lock coordinates publishes across processes, including rollbacks. */
export async function withWebsitePublishLock<T>(pageId: string, publish: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('website-publish'), hashtext(${pageId})) AS acquired`;
    if (!lock?.acquired) throw new WebsiteError(409, "This page is already being published. Wait for that publish to finish, then review again.");
    return publish(tx);
  }, { maxWait: 5_000, timeout: 90_000 });
}

/**
 * The same, for a change that writes several pages at once.
 *
 * Every page is locked before anything is read, so a shared publish and an
 * ordinary publish of one of its pages cannot both decide what the file should
 * say and then both write it. Sorted, because two publishes taking the same
 * locks in different orders is a deadlock rather than a refusal.
 */
export async function withWebsitePublishLocks<T>(pageIds: string[], publish: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const ordered = [...new Set(pageIds)].sort();
  return prisma.$transaction(async tx => {
    for (const pageId of ordered) {
      const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('website-publish'), hashtext(${pageId})) AS acquired`;
      if (!lock?.acquired) throw new WebsiteError(409, "One of the pages this change affects is already being published. Wait for that publish to finish, then review again.");
    }
    return publish(tx);
  }, { maxWait: 5_000, timeout: 120_000 });
}
