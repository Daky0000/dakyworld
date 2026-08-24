/**
 * What the search box on the Leads page actually reaches.
 *
 * The leads table is not one table. Every list carries its own columns — an
 * imported sheet keeps every column it arrived with, and those live in
 * `Lead.customFields` rather than as Lead scalars (see services/leadFields.ts).
 * The search clause matched seven scalars and nothing else, so the column
 * somebody keeps their notes, their contact person or their second phone
 * number in was invisible to the one box on the screen that promises to find
 * things. Typing a value you can *see in the table* returned nothing.
 *
 * So a query is matched against three things:
 *
 *   1. The Lead scalars — name, company, email, phone, place, website, notes.
 *   2. The name of the list a lead is in, so "healthcare" finds the healthcare
 *      list's leads without first having to filter to it.
 *   3. Every custom column of every list, by value.
 *
 * (3) is a raw query, and deliberately so. Prisma's JSON filters need a `path`,
 * and the whole point is that the keys differ per list and are not known here;
 * `jsonb_each_text` walks whatever keys a row happens to carry. Values only —
 * matching keys as well would make a search for "notes" return every lead in
 * every list that has a Notes column.
 *
 * It is a scan over the leads that have custom columns, so it is bounded by
 * `CUSTOM_MATCH_LIMIT` and only runs when something has actually been typed.
 * If that ever gets slow the fix is a pg_trgm index on the extracted text, not
 * a narrower search: a search that quietly skips columns is the defect.
 *
 * One asymmetry worth knowing about. This arm escapes `%` and `_`, because it
 * writes its own LIKE. The scalar arm cannot: Prisma's `contains` binds the
 * value straight into a LIKE pattern and offers no escape, so a `%` typed into
 * the search box is a wildcard there and a literal here. The visible symptom
 * is that searching for a bare `%` returns everything, which is odd rather
 * than harmful — and the alternative is hand-writing every scalar clause as
 * raw SQL to fix a character nobody searches for on purpose.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * How many custom-column matches one search may contribute.
 *
 * High enough that no realistic search is truncated, low enough that a
 * one-letter query can't pull every lead in the database through this path.
 * Scalar matches are unaffected by it — this caps one of the three arms.
 */
export const CUSTOM_MATCH_LIMIT = 2000;

/** Below this a query is too broad to be worth scanning JSON for. */
const MIN_CUSTOM_QUERY = 2;

/**
 * Lead ids whose custom columns contain `q`, in any list, under any key.
 *
 * Returns `[]` rather than throwing when the query is too short — a one-letter
 * search still works, it just doesn't reach into JSON for it.
 */
export async function leadIdsMatchingCustomFields(q: string): Promise<string[]> {
  const needle = q.trim();
  if (needle.length < MIN_CUSTOM_QUERY) return [];

  // `%` and `_` are wildcards in LIKE, so a search for "50%" would otherwise
  // match everything. Escaped with a backslash, declared to Postgres below.
  const pattern = `%${needle.replace(/[\%_]/g, (char) => `\${char}`)}%`;

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l."id"
    FROM "Lead" l
    WHERE l."customFields" IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_each_text(l."customFields") AS entry(key, value)
        WHERE entry.value ILIKE ${pattern} ESCAPE '\\'
      )
    LIMIT ${CUSTOM_MATCH_LIMIT}
  `;
  return rows.map((row) => row.id);
}

/**
 * The scalar half of the search, as an OR list.
 *
 * `customIds` comes from `leadIdsMatchingCustomFields`. Passed in rather than
 * fetched here so the clause stays synchronous — `buildWhere` is called from
 * three routes and a check, and none of them should have to care that one arm
 * of a search needs a round trip.
 */
export function searchClauses(q: string, customIds: string[] = []): Prisma.LeadWhereInput[] {
  const contains = { contains: q, mode: "insensitive" } as const;
  const clauses: Prisma.LeadWhereInput[] = [
    { contactName: contains },
    { companyName: contains },
    { contactEmail: contains },
    { contactPhone: contains },
    { city: contains },
    { region: contains },
    { country: contains },
    { category: contains },
    { address: contains },
    { website: contains },
    { discoveryNotes: contains },
    // The list a lead is in is part of what it is. Searching "healthcare"
    // should find the healthcare list's leads whichever list you're looking at.
    { group: { name: contains } },
  ];
  if (customIds.length) clauses.push({ id: { in: customIds } });
  return clauses;
}
