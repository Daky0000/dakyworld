/**
 * Do leads stay in their lists, and does searching find them?
 *
 * Four defects, one shape: the leads screen kept promising a grouping it was
 * not actually doing.
 *
 * **A list was whatever fell in the first page.** `GET /api/leads` returned up
 * to 300 rows by date and the browser bucketed them, so a list of 400 rendered
 * as a block of 300 with "300" in its header, and the older list underneath it
 * did not appear at all. The number in a block header is what somebody sizes
 * an outreach batch against, and it was a count of what had been fetched.
 *
 * **Search reached seven columns.** A lead's own columns live in
 * `Lead.customFields` — that is the whole point of an imported list keeping
 * its columns — and the search clause matched Lead scalars only. Typing a
 * value that is visible on the screen returned nothing.
 *
 * **A scrape could never add to a list, only open one.** Every shipped
 * template ended its group name in `{{date}}`, so the daily healthcare capture
 * produced "Healthcare · 2026-08-24", then "Healthcare · 2026-08-25". Nobody
 * wanted a list per run — `Lead.scraperRunId` already answers which run — and
 * an audience only exists if the same list is added to.
 *
 * **An unnamed column became "Column F".** A blank header matches no header
 * rule, so the column was mapped to `custom` — including a column of email
 * addresses, which then produced leads with no `contactEmail` at all.
 * Reachable businesses filed as unreachable because a header cell was empty.
 *
 * The negatives are half of this file, and they are the half worth reading:
 *
 *   - **A pinned list wins over the name**, so renaming a list does not make
 *     the next run open a second one.
 *   - **Adoption, not overwrite.** A source landing in a list somebody already
 *     has must not rename it, re-tag it, or touch the leads in it.
 *   - **A column somebody named is never renamed from its contents.** The
 *     review screen exists so a person can decide; reading the cells over the
 *     top of that decision would undo it.
 *
 * Database only. No API key, no network, no Docker beyond Postgres itself.
 *   npx tsx checks/leadGroups.ts
 */
import express from "express";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/lib/prisma.js";
import { leadsRouter } from "../src/routes/leads.js";
import { attachUser, requireAuth } from "../src/middleware/auth.js";
import { leadIdsMatchingCustomFields } from "../src/services/leadSearch.js";
import { detectTables, normalizePlan, readColumn } from "../src/services/sheetPlan.js";
import { renderGroupName, resolveGroup } from "../src/services/scraperRunner.js";
import { SCRAPER_TEMPLATES } from "../src/services/scraperTemplates.js";
import type { SheetGrid } from "../src/services/spreadsheet.js";

const failures: string[] = [];
let passed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The function under test, by id — every case here starts from a stored source. */
const resolveGroupFor = async (id: string) => resolveGroup(await prisma.scraperSource.findUniqueOrThrow({ where: { id } }));

/** Everything this run makes carries the mark, so cleanup can't touch real data. */
const MARK = "leadgroupscheck";

async function reset() {
  await prisma.lead.deleteMany({ where: { contactName: { startsWith: MARK } } });
  await prisma.scraperSource.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.leadGroup.deleteMany({ where: { slug: { startsWith: MARK } } });
}

interface GroupBlock {
  id: string;
  name: string;
  tags: string[];
  total: number;
  leads: { id: string; contactName: string }[];
}

async function main() {
  await reset();

  const app = express();
  app.use(express.json());
  // Mounted the way index.ts mounts it. Without attachUser the router answers
  // 401 to everything and the check reports a defect in the route that is
  // really a defect in the harness.
  app.use(attachUser);
  app.use("/api", requireAuth);
  app.use("/api/leads", leadsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/leads${path}`);
    return (await response.json()) as T;
  };

  // --- Two lists, one of them bigger than a page ---------------------------

  // Slugs are what a source adopts a list by, so these are the slugs the names
  // actually produce rather than convenient short ones.
  const big = await prisma.leadGroup.create({
    data: { name: `${MARK} big list`, slug: `${MARK}-big-list`, tags: ["cold-outreach"] },
  });
  const small = await prisma.leadGroup.create({ data: { name: `${MARK} small list`, slug: `${MARK}-small-list` } });

  // 320 in one list and 4 in the other, with the small list created last — so
  // the big list's rows are exactly what fills a 300-row page and pushes the
  // small one off the end of it.
  await prisma.lead.createMany({
    data: Array.from({ length: 4 }, (_, index) => ({ contactName: `${MARK} small ${index}`, groupId: small.id })),
  });
  await prisma.lead.createMany({
    data: Array.from({ length: 320 }, (_, index) => ({
      contactName: `${MARK} big ${index}`,
      groupId: big.id,
      customFields: { site_notes: index === 7 ? "Runs the whole shop off a Facebook page" : "nothing to report" },
    })),
  });
  await prisma.lead.create({ data: { contactName: `${MARK} loose one` } });

  console.log("\nGrouped, with a list bigger than one page");
  // Scoped to this run. A dev database has ungrouped leads of its own, and a
  // check that counts those is a check that passes or fails on what somebody
  // was doing yesterday.
  const MINE = `q=${MARK}`;
  const grouped = await get<{ groups: GroupBlock[]; totalGroups: number; totalLeads: number }>(`/grouped?perGroup=10&${MINE}`);
  const bigBlock = grouped.groups.find((group) => group.id === big.id);
  const smallBlock = grouped.groups.find((group) => group.id === small.id);
  const looseBlock = grouped.groups.find((group) => group.id === "none");

  check("every list is present", Boolean(bigBlock && smallBlock && looseBlock), grouped.groups.map((group) => group.name).join(" / "));
  check("the big list counts all 320", bigBlock?.total === 320, `got ${bigBlock?.total}`);
  check("it previews only what was asked for", bigBlock?.leads.length === 10, `got ${bigBlock?.leads.length}`);
  check("the small list is not swallowed by the big one", smallBlock?.total === 4, `got ${smallBlock?.total}`);
  check("leads in no list are their own block", looseBlock?.total === 1, `got ${looseBlock?.total}`);
  check(
    "ungrouped sorts last",
    grouped.groups[grouped.groups.length - 1]?.id === "none",
    grouped.groups.map((group) => group.id).join(","),
  );

  // The old flat page is the comparison that makes the point: it cannot show
  // the small list at all, because 320 newer rows sit in front of it.
  const flat = await get<{ items: { groupId: string | null }[]; total: number }>(`/?take=300&${MINE}`);
  check(
    "a flat page really would have hidden the smaller list",
    flat.items.filter((lead) => lead.groupId === small.id).length === 0,
    `${flat.items.filter((lead) => lead.groupId === small.id).length} of its rows fetched`,
  );

  // --- Searching spans every list, and every list's own columns -------------

  console.log("\nSearching");
  const searched = await get<{ groups: GroupBlock[]; totalLeads: number }>("/grouped?q=facebook%20page");
  check("a custom column is searched at all", searched.totalLeads === 1, `got ${searched.totalLeads}`);
  check("the answer says which list it is in", searched.groups[0]?.id === big.id, searched.groups[0]?.name);
  check("lists with no match drop out", searched.groups.length === 1, `${searched.groups.length} blocks`);
  check(
    "the match is the right lead",
    searched.groups[0]?.leads[0]?.contactName === `${MARK} big 7`,
    searched.groups[0]?.leads[0]?.contactName,
  );

  // A search is a question about everything, not about the list you happen to
  // be looking at — but filtering to one list still narrows it.
  const searchedElsewhere = await get<{ totalLeads: number }>(`/grouped?q=facebook%20page&groupId=${small.id}`);
  check("filtering to a list still narrows the search", searchedElsewhere.totalLeads === 0, `got ${searchedElsewhere.totalLeads}`);

  // The flat list, the counters and the export all build from the same filter,
  // so a value found in one has to be found in all of them.
  const flatSearch = await get<{ total: number }>("/?q=facebook%20page");
  const statsSearch = await get<{ total: number; reachable: number }>("/stats?q=facebook%20page");
  check("the flat list finds it too", flatSearch.total === 1, `got ${flatSearch.total}`);
  check("the counters agree", statsSearch.total === 1, `got ${statsSearch.total}`);
  // The tile beside it must count the same search. It did not: a spread that
  // set its own `OR` replaced the search's, so "reachable" was every reachable
  // lead in the database sitting next to a total of one.
  check("the reachable tile counts the search too", statsSearch.reachable <= 1, `got ${statsSearch.reachable}`);

  // Searching a list's *name* finds its leads, which is how you reach a list
  // you had forgotten was there.
  const byListName = await get<{ totalLeads: number }>(`/grouped?q=${encodeURIComponent(`${MARK} small`)}`);
  check("a list name is searchable", byListName.totalLeads === 4, `got ${byListName.totalLeads}`);

  // A wildcard is a literal in the arm that writes its own LIKE. Asserted on
  // that arm rather than on the whole search, because Prisma's `contains`
  // offers no escape and a bare `%` really is a wildcard there — said plainly
  // in services/leadSearch.ts rather than papered over here.
  const wildcards = await leadIdsMatchingCustomFields("%%");
  check("a wildcard is a literal in the custom-column search", wildcards.length === 0, `${wildcards.length} matched`);
  const literal = await leadIdsMatchingCustomFields("shop off a Facebook");
  check("and an ordinary phrase still matches", literal.length === 1, `${literal.length} matched`);

  // --- A scrape adds to a list rather than opening one ---------------------

  console.log("\nCapture sources and their lists");
  const source = await prisma.scraperSource.create({
    data: { name: `${MARK} healthcare`, actorId: "check/actor", groupName: `${MARK} healthcare` },
  });

  const firstRun = await resolveGroupFor(source.id);
  const pinned = await prisma.scraperSource.findUnique({ where: { id: source.id } });
  const secondRun = await resolveGroupFor(source.id);
  check("two runs land in one list", firstRun === secondRun, `${firstRun} then ${secondRun}`);
  check("the source remembers it", pinned?.leadGroupId === firstRun, `${pinned?.leadGroupId}`);

  // Renaming the list must not make the next run open a second one — the pin
  // is the identity, not the name.
  await prisma.leadGroup.update({ where: { id: firstRun }, data: { name: `${MARK} renamed by hand` } });
  check("renaming a list does not fork it", (await resolveGroupFor(source.id)) === firstRun);

  // A second source pointed at a name that already exists adopts that list
  // rather than making "… 2" — and adopting leaves it exactly as it was.
  const adopter = await prisma.scraperSource.create({
    data: { name: `${MARK} clinics`, actorId: "check/actor", groupName: `${MARK} big list` },
  });
  const adopted = await resolveGroupFor(adopter.id);
  const untouched = await prisma.leadGroup.findUnique({
    where: { id: big.id },
    include: { _count: { select: { leads: true } } },
  });
  check("a source adopts a list that already exists", adopted === big.id, `${adopted} vs ${big.id}`);
  check("adopting does not rename it", untouched?.name === `${MARK} big list`, untouched?.name);
  check("adopting does not touch its tags", untouched?.tags.join(",") === "cold-outreach", untouched?.tags.join(","));
  check("adopting does not touch its leads", untouched?._count.leads === 320, `${untouched?._count.leads}`);

  // A deleted list is not a failed run: by the time this matters the leads are
  // already scraped and paid for, so the source re-pins to a fresh one.
  const orphan = await prisma.scraperSource.create({
    data: { name: `${MARK} orphan`, actorId: "check/actor", groupName: `${MARK} orphan list` },
  });
  const orphanGroup = await resolveGroupFor(orphan.id);
  await prisma.leadGroup.delete({ where: { id: orphanGroup } });
  const reopened = await resolveGroupFor(orphan.id);
  check("a deleted list is re-opened rather than failing the run", Boolean(reopened) && reopened !== orphanGroup, reopened);

  // Nothing ships with a date in its list name any more, and the default is
  // the source's own name — a dated default is what made adding impossible.
  check("the default list name carries no date", renderGroupName(null, { ...source, name: "Healthcare" }) === "Healthcare");
  check(
    "no shipped template stamps a date on its list",
    SCRAPER_TEMPLATES.every((template) => !/\{\{\s*(date|month)\s*\}\}/i.test(template.groupName)),
    SCRAPER_TEMPLATES.map((template) => template.groupName).filter((name) => /\{\{/.test(name)).join(", "),
  );
  // Still supported for somebody who genuinely asks for a list per day.
  check("{{date}} still works when asked for", /^Weekly \d{4}-\d{2}-\d{2}$/.test(renderGroupName("Weekly {{date}}", source)));

  // --- A column nobody named is named from what is in it -------------------

  console.log("\nColumns nothing named");
  check("a column of addresses is an email column", readColumn(["a@b.com", "c@d.org", "e@f.net"])?.field === "contactEmail");
  check(
    "a column of numbers is a phone column",
    readColumn(["+233 24 123 4567", "0244 987 654", "0302 555 111"])?.field === "contactPhone",
    JSON.stringify(readColumn(["+233 24 123 4567", "0244 987 654", "0302 555 111"])),
  );
  check("a column of links is a website column", readColumn(["https://a.com", "www.b.org", "https://c.net"])?.field === "website");
  check(
    "a column of Facebook pages is not a website column",
    readColumn(["https://facebook.com/a", "https://www.facebook.com/b", "https://facebook.com/c"])?.label === "Facebook",
    JSON.stringify(readColumn(["https://facebook.com/a", "https://www.facebook.com/b", "https://facebook.com/c"])),
  );
  check(
    "a column of sentences is Notes",
    readColumn(["Called them twice, no answer at all", "Waiting on us to send the proposal over"])?.label === "Notes",
  );
  check(
    "a column of three words is named after them",
    readColumn(["Sent", "Pending", "Sent", "Replied"])?.label === "Sent / Pending / Replied",
    JSON.stringify(readColumn(["Sent", "Pending", "Sent", "Replied"])),
  );
  check("a column of dates is a date column", readColumn(["2026-01-04", "2026-02-11", "2026-03-30"])?.type === "DATE");
  // The negatives: nothing is invented out of one value, or out of noise.
  check("one value names nothing", readColumn(["hello"]) === null);
  check("a mix names nothing", readColumn(["hello", "2026-01-04", "a@b.com", "eight"]) === null);

  // The whole path: a sheet with a blank header cell over a column of emails.
  const grid: SheetGrid = {
    name: "Sheet1",
    truncated: false,
    totalRows: 4,
    rows: [
      ["Business", "", "Town"],
      ["Adjei Dental", "hello@adjei.com", "Accra"],
      ["Kumasi Motors", "sales@kumasimotors.com", "Kumasi"],
      ["Tema Foods", "info@temafoods.com", "Tema"],
    ],
  };
  const [table] = detectTables([grid]);
  const emailColumn = table?.columns.find((column) => column.index === 1);
  check("an unnamed column of emails maps to the email field", emailColumn?.field === "contactEmail", JSON.stringify(emailColumn));
  check("and is called Email, not Column B", emailColumn?.label === "Email", emailColumn?.label);

  // Every plan goes through `normalizePlan` — the analyst's, the rules', and
  // the one the review screen sends back. That is the path which had no way to
  // look at the cells at all.
  const fromAnalyst = normalizePlan(
    {
      summary: "",
      tables: [
        {
          id: "t",
          sheet: "Sheet1",
          title: "Imported",
          headerRow: 0,
          firstDataRow: 1,
          lastDataRow: 3,
          startColumn: 0,
          endColumn: 2,
          leadSource: "DIRECTORY",
          status: "NEW",
          confidence: 0.5,
          notes: "",
          include: true,
          columns: [
            { index: 0, header: "Business", label: "Business", field: "companyName", type: "TEXT" },
            // What a model sends back for a column it could not name.
            { index: 1, header: "", label: "", field: "custom", type: "TEXT" },
            { index: 2, header: "Town", label: "Town", field: "city", type: "TEXT" },
          ],
        },
      ],
    },
    [grid],
  );
  const normalised = fromAnalyst.tables[0]?.columns.find((column) => column.index === 1);
  check("an analyst's unnamed column is read too", normalised?.field === "contactEmail", JSON.stringify(normalised));

  // The negative that matters most here: a column somebody named keeps its
  // name and its mapping, however obviously the cells look like something else.
  const named = normalizePlan(
    {
      summary: "",
      tables: [
        {
          ...fromAnalyst.tables[0],
          columns: [
            { index: 0, header: "Business", label: "Business", field: "companyName", type: "TEXT" },
            { index: 1, header: "", label: "Billing contact", field: "custom", type: "TEXT" },
            { index: 2, header: "Town", label: "Town", field: "city", type: "TEXT" },
          ],
        },
      ],
    },
    [grid],
  );
  const kept = named.tables[0]?.columns.find((column) => column.index === 1);
  check("a column somebody named is left alone", kept?.label === "Billing contact" && kept?.field === "custom", JSON.stringify(kept));

  server.close();
  await reset();
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((name) => `  - ${name}`).join("\n"));
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
