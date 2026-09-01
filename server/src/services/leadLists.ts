import { prisma } from "../lib/prisma.js";

/**
 * Lists with nothing in them.
 *
 * A `LeadGroup` is created far more often than anybody makes one. A scraper
 * source opens one to capture into, a workbook import opens one per worksheet,
 * and a hunt opens one per thesis — so thirty-nine lists is one bad import, and
 * a batch deleted for being the wrong town leaves its list standing empty
 * behind it. None of that is a fault; the residue is.
 *
 * Emptiness alone is not enough to delete on, and the two exceptions below are
 * the whole reason this is a service rather than one `deleteMany`:
 *
 * 1. **A list a capture source points at.** `ScraperSource.leadGroupId` is
 *    `onDelete: SetNull`, so removing the list does not fail and does not warn
 *    — it silently unhooks the source, and the next run's four hundred
 *    businesses arrive ungrouped. A source's destination is empty every time
 *    before its first run and again after its rows are moved on, so this is the
 *    common case, not the corner.
 * 2. **A list made moments ago.** Making a list and then filling it is two
 *    actions with a gap between them, and a sweep that runs in that gap deletes
 *    the thing somebody is in the middle of using. Only the automatic sweep
 *    holds this back; a person pressing the button has already looked at the
 *    count.
 *
 * `LeadField` cascades from the group, so an empty list with a bespoke column
 * set loses that set with it. That is correct — the columns describe rows that
 * no longer exist — but it is the reason the age guard exists at all.
 */
export interface EmptyList {
  id: string;
  name: string;
  autoCreated: boolean;
  createdAt: Date;
}

export interface EmptyListSweep {
  /** Empty and safe to remove. Named `removable` because the read and the sweep share this shape. */
  removable: EmptyList[];
  /** Empty, but a capture source still writes into them. Never swept. */
  keptFeeding: EmptyList[];
}

export interface EmptyListOptions {
  /**
   * Ignore lists newer than this. The automatic sweep passes an hour; the
   * button passes nothing, because the Owner pressing it is the decision.
   */
  olderThanMs?: number;
  /**
   * Only lists a scrape, an import or a hunt opened. The daily sweep uses this
   * so that a list somebody typed a name for is never removed behind their
   * back, however empty it is.
   */
  autoOnly?: boolean;
}

/** The empty lists, split by whether they can be removed. */
export async function findEmptyLists(options: EmptyListOptions = {}): Promise<EmptyListSweep> {
  const groups = await prisma.leadGroup.findMany({
    where: {
      leads: { none: {} },
      ...(options.autoOnly ? { autoCreated: true } : {}),
      ...(options.olderThanMs ? { createdAt: { lt: new Date(Date.now() - options.olderThanMs) } } : {}),
    },
    select: { id: true, name: true, autoCreated: true, createdAt: true, _count: { select: { sources: true } } },
    orderBy: { createdAt: "asc" },
  });

  const removable: EmptyList[] = [];
  const keptFeeding: EmptyList[] = [];
  for (const group of groups) {
    const row = { id: group.id, name: group.name, autoCreated: group.autoCreated, createdAt: group.createdAt };
    (group._count.sources > 0 ? keptFeeding : removable).push(row);
  }
  return { removable, keptFeeding };
}

/**
 * Removes them.
 *
 * No `expect` exchange, unlike every other delete on the leads router, and
 * deliberately: those carry one because they destroy leads. This destroys only
 * the empty containers around them — by definition there is nothing inside to
 * lose, and the count it reports is the count it acted on because the two are
 * read in the same call.
 */
export async function removeEmptyLists(options: EmptyListOptions = {}): Promise<EmptyListSweep> {
  const found = await findEmptyLists(options);
  if (found.removable.length === 0) return found;

  // Re-checked inside the delete rather than trusted from the read above: a
  // capture finishing between the two would otherwise have its rows' list
  // deleted out from under it.
  await prisma.leadGroup.deleteMany({
    where: { id: { in: found.removable.map((group) => group.id) }, leads: { none: {} }, sources: { none: {} } },
  });
  return found;
}
