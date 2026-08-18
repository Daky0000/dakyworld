import { prisma } from "../lib/prisma.js";

/**
 * The tag vocabulary.
 *
 * Leads have carried a `tags` array since the scrapers landed, and nothing
 * ever looked at it: a scrape wrote the business category into it, an import
 * wrote whatever a "Labels" column happened to contain, and the two never
 * agreed on spelling, so the array was write-only. There was no list of what
 * tags exist, no way to filter by one, and no way to rename one without
 * touching every lead that carried it.
 *
 * This is the half that was missing. `LeadTag` is a **registry, not a
 * constraint**: four writers put tags on a lead — a scrape, a spreadsheet
 * import, an inbound webhook, a person — and three of them invent the words as
 * they go, so a foreign key would make those writes fail on a label nobody had
 * registered. Instead every tag is upserted here *as it is used*, and the
 * arrays on `Lead` and `LeadGroup` hold the **slug**.
 *
 * Storing the slug rather than the label is what makes a rename cost one row.
 * `label` is what a person reads and can change freely; `slug` is the identity
 * and never changes, because changing it would orphan every lead holding it.
 */

/** How long a tag may be. Long enough for "needs-security-review", short enough to render as a chip. */
const SLUG_MAX = 40;
const LABEL_MAX = 60;

/**
 * The tag palette.
 *
 * Deliberately a short list of brand values rather than a colour picker: forty
 * hand-picked colours across a lead table is noise, and the design system's
 * whole argument is that colour means something. Lime stays out — it is the
 * action colour, roughly 1-5% of a surface, and a tag is neither an action nor
 * rare.
 */
export const TAG_COLOURS = ["blue", "cyan", "ink", "amber", "emerald", "red"] as const;
export type TagColour = (typeof TAG_COLOURS)[number];

export function isTagColour(value: unknown): value is TagColour {
  return typeof value === "string" && (TAG_COLOURS as readonly string[]).includes(value);
}

/**
 * The identity of a tag, from anything a person or a scraper might type.
 *
 * "Dental Clinic", "dental clinic" and "  Dental  Clinic " are one tag. Accents
 * are folded the same way `slugify` folds them elsewhere in this app, so
 * "Café" and "Cafe" don't become two tags that look identical in a list.
 * Returns null for anything that normalises to nothing.
 */
export function tagSlug(value: string): string | null {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\da-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug || null;
}

/** What a freshly-coined tag is called before anybody renames it. */
function defaultLabel(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ").slice(0, LABEL_MAX);
  return trimmed || value.slice(0, LABEL_MAX);
}

/** Slugs, de-duplicated, order preserved. What actually goes into a `tags` array. */
export function normaliseTags(values: readonly string[] | null | undefined): string[] {
  if (!values?.length) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const slug = tagSlug(value);
    if (slug) seen.add(slug);
  }
  return [...seen];
}

/**
 * Normalises, and makes sure every tag exists in the registry.
 *
 * Called by everything that writes tags. Never throws on a tag it has not seen
 * before — coining one is the normal case, and a scrape that failed because it
 * met a new business category would be a worse system than one with a slightly
 * untidy tag list. Untidy is fixable from the Tags screen; a failed capture is
 * not.
 */
export async function registerTags(values: readonly string[] | null | undefined, options: { autoCreated?: boolean } = {}): Promise<string[]> {
  if (!values?.length) return [];

  // Kept as pairs so a tag coined by a scrape gets the scrape's own words as
  // its label — "Dental clinic", not "dental-clinic".
  const wanted = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const slug = tagSlug(value);
    if (slug && !wanted.has(slug)) wanted.set(slug, defaultLabel(value));
  }
  if (wanted.size === 0) return [];

  const autoCreated = options.autoCreated ?? true;
  const now = new Date();
  const existing = await prisma.leadTag.findMany({ where: { slug: { in: [...wanted.keys()] } }, select: { slug: true } });
  const known = new Set(existing.map((tag) => tag.slug));

  const missing = [...wanted.entries()].filter(([slug]) => !known.has(slug));
  if (missing.length > 0) {
    // Two captures finishing at once can race for the same new tag, and losing
    // that race must not fail the capture — hence skipDuplicates rather than a
    // transaction.
    await prisma.leadTag.createMany({
      data: missing.map(([slug, label]) => ({ slug, label, autoCreated, lastUsedAt: now })),
      skipDuplicates: true,
    });
  }
  if (known.size > 0) {
    await prisma.leadTag.updateMany({ where: { slug: { in: [...known] } }, data: { lastUsedAt: now } });
  }

  return [...wanted.keys()];
}

export interface TagUsage {
  id: string;
  slug: string;
  label: string;
  colour: string | null;
  description: string | null;
  autoCreated: boolean;
  lastUsedAt: Date | null;
  /** How many leads carry it. */
  leads: number;
  /** How many lead lists carry it. */
  groups: number;
}

/**
 * Every tag, with what actually uses it.
 *
 * Counting a string inside an array column is a `has` filter per tag, which is
 * one query each and fine at the size a tag list ever reaches — but the two
 * `groupBy`s below do it in two queries instead, because a scrape that coins a
 * tag per business category can leave a few hundred of them behind and the
 * Tags screen should not be three hundred round trips.
 */
export async function listTags(): Promise<TagUsage[]> {
  const [tags, leadRows, groupRows] = await Promise.all([
    prisma.leadTag.findMany({ orderBy: [{ label: "asc" }] }),
    prisma.lead.findMany({ where: { NOT: { tags: { isEmpty: true } } }, select: { tags: true } }),
    prisma.leadGroup.findMany({ where: { NOT: { tags: { isEmpty: true } } }, select: { tags: true } }),
  ]);

  const count = (rows: { tags: string[] }[]) => {
    const totals = new Map<string, number>();
    for (const row of rows) for (const tag of row.tags) totals.set(tag, (totals.get(tag) ?? 0) + 1);
    return totals;
  };
  const leadTotals = count(leadRows);
  const groupTotals = count(groupRows);

  return tags.map((tag) => ({
    id: tag.id,
    slug: tag.slug,
    label: tag.label,
    colour: tag.colour,
    description: tag.description,
    autoCreated: tag.autoCreated,
    lastUsedAt: tag.lastUsedAt,
    leads: leadTotals.get(tag.slug) ?? 0,
    groups: groupTotals.get(tag.slug) ?? 0,
  }));
}

/**
 * Brings every tag already written into a `tags` array into the registry — and
 * normalises the arrays themselves.
 *
 * Run once at boot, and it has two jobs because the tags already in the
 * database were written before any of this existed. A scrape stored the raw
 * business category ("Website build"), so the arrays hold **labels, not
 * slugs** — which means registering the slug alone is not enough: the tag would
 * appear on the Tags screen with a count of zero while a lead was visibly
 * carrying it, and filtering by it would return nothing. Both were true the
 * first time this ran.
 *
 * So the arrays are rewritten to slugs as well. That is a one-time data
 * migration living in the boot path rather than in a SQL file, because it needs
 * `tagSlug()` — the same folding every writer uses, which is the whole point:
 * one spelling, decided in one place.
 *
 * Idempotent. Once the arrays hold slugs, normalising them again changes
 * nothing and no row is written.
 */
export async function backfillTags(): Promise<number> {
  const [leads, groups, known] = await Promise.all([
    prisma.lead.findMany({ where: { NOT: { tags: { isEmpty: true } } }, select: { id: true, tags: true } }),
    prisma.leadGroup.findMany({ where: { NOT: { tags: { isEmpty: true } } }, select: { id: true, tags: true } }),
    prisma.leadTag.findMany({ select: { slug: true } }),
  ]);

  const registered = new Set(known.map((tag) => tag.slug));
  // Keyed by slug, valued by the words it was written as — so a tag coined by a
  // scrape keeps "Website build" as its label rather than becoming
  // "website build".
  const unknown = new Map<string, string>();
  for (const row of [...leads, ...groups]) {
    for (const tag of row.tags) {
      const slug = tagSlug(tag);
      if (slug && !registered.has(slug) && !unknown.has(slug)) unknown.set(slug, defaultLabel(tag));
    }
  }

  if (unknown.size > 0) {
    await prisma.leadTag.createMany({
      data: [...unknown].map(([slug, label]) => ({ slug, label, autoCreated: true })),
      skipDuplicates: true,
    });
  }

  // Now the arrays. Only rows whose contents actually change are written.
  const changed = (rows: { id: string; tags: string[] }[]) =>
    rows
      .map((row) => ({ id: row.id, tags: normaliseTags(row.tags) }))
      .filter((row, index) => {
        const before = rows[index].tags;
        return row.tags.length !== before.length || row.tags.some((tag, position) => tag !== before[position]);
      });

  const leadFixes = changed(leads);
  const groupFixes = changed(groups);

  if (leadFixes.length > 0 || groupFixes.length > 0) {
    await prisma.$transaction([
      ...leadFixes.map((row) => prisma.lead.update({ where: { id: row.id }, data: { tags: row.tags } })),
      ...groupFixes.map((row) => prisma.leadGroup.update({ where: { id: row.id }, data: { tags: row.tags } })),
    ]);
    console.log(`[tags] normalised the tags on ${leadFixes.length} lead(s) and ${groupFixes.length} list(s)`);
  }

  return unknown.size;
}

/**
 * Takes a tag out of circulation.
 *
 * Deleting the registry row alone would leave the slug sitting in every array
 * that held it — invisible on the Tags screen, still filterable, still
 * exported. So the arrays are rewritten first and the row goes last: a tag
 * that is deleted is gone from the leads too, which is what "delete" plainly
 * means to whoever clicked it.
 */
export async function deleteTag(slug: string): Promise<{ leads: number; groups: number }> {
  const [leads, groups] = await Promise.all([
    prisma.lead.findMany({ where: { tags: { has: slug } }, select: { id: true, tags: true } }),
    prisma.leadGroup.findMany({ where: { tags: { has: slug } }, select: { id: true, tags: true } }),
  ]);

  await prisma.$transaction([
    ...leads.map((lead) =>
      prisma.lead.update({ where: { id: lead.id }, data: { tags: lead.tags.filter((tag) => tag !== slug) } }),
    ),
    ...groups.map((group) =>
      prisma.leadGroup.update({ where: { id: group.id }, data: { tags: group.tags.filter((tag) => tag !== slug) } }),
    ),
    prisma.leadTag.deleteMany({ where: { slug } }),
  ]);

  return { leads: leads.length, groups: groups.length };
}

/**
 * Adds and removes tags on many leads at once, without losing what is already
 * there.
 *
 * Prisma's `push` can add to an array column in a single `updateMany`, but
 * there is no `pull` and no way to de-duplicate — pushing a tag a lead already
 * carries stores it twice. So the rows are read, merged in memory and written
 * back. At the size a bulk action reaches (a scrape's worth of leads, not a
 * database's) that is the honest trade.
 */
export async function retagLeads(ids: string[], add: string[], remove: string[]): Promise<number> {
  const addSlugs = await registerTags(add, { autoCreated: false });
  const removeSlugs = normaliseTags(remove);
  if (addSlugs.length === 0 && removeSlugs.length === 0) return 0;

  const leads = await prisma.lead.findMany({ where: { id: { in: ids } }, select: { id: true, tags: true } });
  const changed = leads
    .map((lead) => {
      const next = [...new Set([...lead.tags.filter((tag) => !removeSlugs.includes(tag)), ...addSlugs])];
      const same = next.length === lead.tags.length && next.every((tag) => lead.tags.includes(tag));
      return same ? null : { id: lead.id, tags: next };
    })
    .filter((row): row is { id: string; tags: string[] } => row !== null);

  if (changed.length === 0) return 0;
  await prisma.$transaction(changed.map((row) => prisma.lead.update({ where: { id: row.id }, data: { tags: row.tags } })));
  return changed.length;
}
