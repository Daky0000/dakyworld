import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Changing `Site.settings` without losing somebody else's change.
 *
 * `settings` is one JSON document that a dozen features keep a key in — the
 * design palette, the editing policy, scheduled publishes, find-and-replace
 * tokens, SEO, acknowledged publish risks, staff notes. Each of them used to
 * read the whole document, change its key and write the whole document back.
 * Two of those at once — a client's comment arriving while somebody saved the
 * palette — and whichever wrote second silently put back the other's old
 * value. Nothing failed; a change just was not there any more.
 *
 * This takes the row lock first (`SELECT … FOR UPDATE`), so the read and the
 * write are one step for everybody else: the second writer waits, then reads
 * what the first one wrote. `mutate` receives a copy it may change freely and
 * returns the next document.
 */
export type SiteSettings = Record<string, unknown>;

export async function updateSiteSettings(
  siteId: string,
  mutate: (current: SiteSettings) => SiteSettings | Promise<SiteSettings>,
): Promise<SiteSettings> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ settings: unknown }>>`SELECT "settings" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`;
    if (!rows.length) throw new Error(`Site ${siteId} does not exist.`);
    const raw = rows[0]!.settings;
    const current: SiteSettings = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as SiteSettings) } : {};
    const next = await mutate(current);
    await tx.site.update({ where: { id: siteId }, data: { settings: next as Prisma.InputJsonValue } });
    return next;
  });
}

/** Sets one key, leaving every other key exactly as the latest writer left it. */
export function setSiteSetting(siteId: string, key: string, value: unknown): Promise<SiteSettings> {
  return updateSiteSettings(siteId, (current) => ({ ...current, [key]: value }));
}
