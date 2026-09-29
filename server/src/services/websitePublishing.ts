import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { capacity } from "../lib/capacity.js";
import { withPublicationOwnership } from "../lib/publicationLease.js";
export { commitPublication } from "../lib/publicationLease.js";

/** Ownership spans network work; only final database writes use commitPublication. */
export function withWebsitePublishLock<T>(pageId: string, publish: (db: Prisma.TransactionClient) => Promise<T>) {
  return withWebsitePublishLocks([pageId], publish);
}

export async function withWebsitePublishLocks<T>(pageIds: string[], publish: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const ordered = [...new Set(pageIds)].sort();
  const keys = ordered.map(id => `publication:page:${id}`);
  {
    const pages = await prisma.sitePage.findMany({ where: { id: { in: ordered } }, select: { siteId: true } });
    keys.push(...[...new Set(pages.map(page => page.siteId))].sort().map(id => `publication:site:${id}`));
  }
  return withPublicationOwnership(keys, capacity.admission ? 2 : null, () => publish(prisma));
}
