import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Bulk actions over leads, addressed by a filter rather than by a list of ids.
 *
 * ## Why a filter and not ids
 *
 * Every bulk endpoint here took `ids: string[]`, which is exactly right for the
 * thing it was built for — a person ticks twenty rows after a scrape and moves
 * them into a list. It cannot express the other half of the job. This database
 * holds 46,110 leads across 57 lists, and "delete every lead from the March
 * scrape" is not forty-six thousand cuids in a request body; it is the same
 * filter the screen is already showing, which `buildWhere` already builds.
 *
 * So both halves are supported and exactly one is required. An id list is a
 * literal selection. A filter is "whatever matches", and it is resolved at the
 * moment of the write rather than at the moment of the click.
 *
 * ## The count is quoted back, and checked
 *
 * A filter that matched twelve rows when the screen drew it can match forty
 * thousand by the time somebody presses the button — a scrape finishes, an
 * import commits. So a destructive filter action carries `expect`: the number
 * the person was looking at. If the filter no longer matches that many, nothing
 * happens and both numbers come back.
 *
 * This is the same exchange `SitePage.draftRevision` makes in the website
 * editor, for the same reason: a write whose target has moved underneath it is
 * refused rather than applied to whatever is there now.
 *
 * ## What a deleted lead takes with it, and what it does not
 *
 * Five relations point at `Lead` with the default `RESTRICT`, so a delete fails
 * outright unless each is dealt with. The old endpoint handled two of them, and
 * a lead that had ever been emailed could not be bulk-deleted at all — the
 * foreign key surfaced as a bare 500.
 *
 * - **`Communication` is deleted.** It is the log of contact with *this* lead
 *   and means nothing detached from one.
 * - **`EmailMessage`, `Message` and `AgentTask` are detached.** Each is a
 *   record of something that actually happened — a letter that was sent, a text
 *   somebody received, work an agent did — and deleting the prospect is not a
 *   reason to destroy the evidence of it.
 * - **A lead with a proposal is kept back, not failed.** A proposal is a priced
 *   commercial document and the lead is the counterparty on it; detaching would
 *   quietly lose who it was for. The old code refused the *whole* request when
 *   any one lead had one, which turns two proposals into forty-six thousand
 *   leads that cannot be cleared. They are skipped and reported by name.
 *
 * Everything else already declares `Cascade` or `SetNull` and needs nothing.
 */

/** One page of work. Large enough to be quick, small enough not to hold a lock for a minute. */
const PAGE = 500;

export interface BulkTarget {
  /** A literal selection. */
  ids?: string[];
  /** Everything matching, as `buildWhere` produced it. */
  where?: Prisma.LeadWhereInput;
  /**
   * How many the caller believes this matches. Required for a filter delete and
   * ignored for an id list, where the caller has already named every row.
   */
  expect?: number;
}

export class BulkCountChanged extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `That matched ${actual} lead(s), not the ${expected} you were shown — something has changed since the screen was drawn. ` +
        `Nothing has been deleted. Reload and try again.`,
    );
    this.name = "BulkCountChanged";
  }
}

/**
 * Turns a request into a `where`, or throws if it says neither or both.
 *
 * Both is refused rather than merged. "These twenty, and also everything
 * matching" is not a thing anybody means, and guessing which half they meant is
 * how a bulk delete removes more than somebody asked for.
 */
export function targetWhere(target: BulkTarget): Prisma.LeadWhereInput {
  const hasIds = Array.isArray(target.ids) && target.ids.length > 0;
  const hasFilter = target.where !== undefined;
  if (hasIds && hasFilter) throw new Error("Give either a selection or a filter, not both.");
  if (!hasIds && !hasFilter) throw new Error("Give either a selection or a filter.");
  return hasIds ? { id: { in: target.ids as string[] } } : (target.where as Prisma.LeadWhereInput);
}

/** How many leads this would act on, before it acts on any of them. */
export async function countTarget(target: BulkTarget): Promise<number> {
  return prisma.lead.count({ where: targetWhere(target) });
}

/**
 * Refuses a filter action whose target has moved since the caller looked.
 *
 * Only for a filter: an id list already names every row, so there is nothing to
 * be surprised by.
 */
async function confirmCount(target: BulkTarget, where: Prisma.LeadWhereInput): Promise<number> {
  const actual = await prisma.lead.count({ where });
  if (target.ids?.length) return actual;
  if (target.expect === undefined) {
    throw new Error("A filter action has to say how many leads it expects to affect.");
  }
  if (target.expect !== actual) throw new BulkCountChanged(target.expect, actual);
  return actual;
}

export interface BulkDeleteResult {
  deleted: number;
  /** Kept because a priced document hangs off them. Named, not just counted. */
  keptWithProposals: { id: string; name: string }[];
  /** Rows pointed at a deleted lead and left in place with the link cleared. */
  detached: { emails: number; messages: number; tasks: number };
}

/**
 * Deletes every lead the target names, except the ones that must not go.
 *
 * Paged, because this is used to clear tens of thousands of rows and one
 * statement holding every one of them is a lock nothing else can get past.
 * Each page is its own transaction: an interrupted run has deleted a whole
 * number of pages rather than half of one, and running it again finishes the
 * job.
 */
export async function deleteLeads(target: BulkTarget): Promise<BulkDeleteResult> {
  const where = targetWhere(target);
  await confirmCount(target, where);

  const result: BulkDeleteResult = { deleted: 0, keptWithProposals: [], detached: { emails: 0, messages: 0, tasks: 0 } };
  const skip = new Set<string>();

  for (;;) {
    // Re-queried each time rather than paged with an offset. Deleting rows out
    // from under an offset is how a paged sweep skips half of what it was
    // asked to do; excluding what has been kept back is what stops it looping
    // for ever on the same page.
    const page = await prisma.lead.findMany({
      where: skip.size > 0 ? { AND: [where, { id: { notIn: [...skip] } }] } : where,
      select: { id: true, contactName: true, companyName: true },
      take: PAGE,
    });
    if (page.length === 0) break;

    const ids = page.map((lead) => lead.id);

    // A priced document naming this business. Read per page rather than once
    // up front: on a target of forty thousand, one `in` list of forty thousand
    // ids is a query nobody enjoys.
    const withProposals = await prisma.proposal.findMany({
      where: { leadId: { in: ids } },
      select: { leadId: true },
      distinct: ["leadId"],
    });
    const blocked = new Set(withProposals.map((row) => row.leadId).filter((id): id is string => Boolean(id)));
    for (const lead of page) {
      if (!blocked.has(lead.id)) continue;
      skip.add(lead.id);
      result.keptWithProposals.push({ id: lead.id, name: lead.companyName || lead.contactName });
    }

    const deletable = ids.filter((id) => !blocked.has(id));
    if (deletable.length === 0) continue;

    await prisma.$transaction(async (tx) => {
      // Deleted: a contact log means nothing without the lead it is about.
      await tx.communication.deleteMany({ where: { leadId: { in: deletable } } });

      // Detached: each of these is a record of something that happened, and
      // the prospect going away is not a reason to lose it. All three are
      // RESTRICT, so without this the delete below simply fails.
      result.detached.emails += (await tx.emailMessage.updateMany({ where: { leadId: { in: deletable } }, data: { leadId: null } })).count;
      result.detached.messages += (await tx.message.updateMany({ where: { leadId: { in: deletable } }, data: { leadId: null } })).count;
      result.detached.tasks += (await tx.agentTask.updateMany({ where: { leadId: { in: deletable } }, data: { leadId: null } })).count;

      result.deleted += (await tx.lead.deleteMany({ where: { id: { in: deletable } } })).count;
    });
  }

  return result;
}

export interface BulkUpdate {
  status?: string;
  groupId?: string | null;
}

/** The non-tag half of a bulk edit, over a selection or a filter. */
export async function updateLeads(target: BulkTarget, update: BulkUpdate): Promise<number> {
  const where = targetWhere(target);
  await confirmCount(target, where);

  const data: Prisma.LeadUncheckedUpdateManyInput = {};
  if (update.status) data.status = update.status as Prisma.LeadUncheckedUpdateManyInput["status"];
  if (update.groupId !== undefined) data.groupId = update.groupId;
  if (Object.keys(data).length === 0) return 0;

  return (await prisma.lead.updateMany({ where, data })).count;
}

/** Every id the target names, for the paths that still need a literal list. */
export async function targetIds(target: BulkTarget, cap = 50_000): Promise<string[]> {
  const rows = await prisma.lead.findMany({ where: targetWhere(target), select: { id: true }, take: cap });
  return rows.map((row) => row.id);
}
