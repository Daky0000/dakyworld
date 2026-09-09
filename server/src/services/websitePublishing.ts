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
