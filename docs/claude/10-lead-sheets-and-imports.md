# Lead sheets, plans, worksheets and imports

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

**Reading a lead sheet is a routed job, so its plan is checked rather than
trusted** — `services/sheetPlan.ts` → `repairPlan()`. `normalizePlan` clamps a
plan to something that *can* be run — real indices, known field targets, unique
keys — and says nothing about whether it makes sense, and it was the only thing
between the analyst and the pipeline. That was survivable while one model read
every sheet and read them well; the honest position on a routed job is that the
next model to serve it is one nobody here has tried. Three repairs, and every
one of them is **reported** at the top of the review screen rather than done
quietly:

- **A table split at a blank row is joined back up.** The prompt calls this
  "the most damaging mistake available to you" and it is not overstating it:
  the fragment sits below the header, so it has no header, so every column in
  it is unnamed, so nothing in it is a name — and `extractRows` drops a row it
  cannot name. The Owner gets an empty group beside a full one that stops
  halfway down their file. Two of five leads, gone quietly.
- **Two tables claiming the same rows are separated.** The opposite failure and
  the worse one, because it does not look like a failure: the same business
  written into two groups, scored twice, written to twice.
- **A table where nothing was mapped as the name gets one anyway.**
  `buildTable` has always rescued this; the analyst's plans went through
  `normalizePlan` instead and did not, so a whole table could import as an
  empty group. Chosen by reading the cells (`nameishness`), not by taking the
  first column going — the leftmost column of a lead sheet is very often S/N,
  and four leads called "1", "2", "4" and "5" are saved in the same sense that
  a shredded document is filed.

**A plan that came back *from* the review screen is never repaired.** A person
who splits a table there has decided to split it, and an "obvious" correction
that undoes what somebody just did by hand is the worst thing this could do.
The other negative that matters as much: two genuinely different tables must
not be merged, so a continuation is only recognised when the later block has no
header of its own, sits at most two *blank* rows below, and fills the same
columns.

Three more repairs landed on 28 Aug 2026, all boundary faults:

- **A table that stops halfway down the sheet gets run on.** The other half of
  the split-at-a-blank-row complaint, and nothing fixed it: a table the analyst
  simply *truncated* has no second fragment to be joined to, so `uncoveredRows`
  noticed the loss and only ever said so — a sentence in a summary about
  several thousand leads that are not there. `extendedEnd` walks the rows below
  and stops **at the first** sign of anything new: a row another table claims, a
  banner, a row that names columns, a totals line, a blank run longer than a
  gap, a different column footprint, or a cell whose *kind* contradicts the
  column above it. That last one is what tells a second table's `Email` header
  from another lead — the word "Email" in a column that has held nothing but
  email addresses for two hundred rows is a header, whatever else it looks like.
- **A title read as the header row is moved down — and the columns are renamed
  off the real one.** Moving the row alone would correct where the data starts
  and leave every column still named after a cell of the table's title, which is
  the half worth having. `namesColumns` is the guard both directions use: a row
  is a header only if it *names* two lead fields and *contains* none — no
  address with an @ in it, no URL, no run of digits long enough to be a phone
  number. Without that, a data row reading `Kofi Mensah | Accra | website design
  | referral` passes the old shape test and gets promoted.
- **The analyst can see the middle of the file at last** — `renderGrid`. This
  was the largest of the three by a distance and it made every boundary
  assertion above moot on a real file: the render was the first 110 rows and the
  last 15, so a second table starting at row 400 was **invisible**, a table
  ending at row 380 was invisible, and a model asked for exact boundaries could
  only answer about the two ends of what it had been shown. Now every row that
  could *be* a boundary is printed wherever it sits, with two rows of context,
  and only uniform stretches are elided — with the count printed in place and
  the real row numbers on either side of it. Costs more tokens than two ends
  did, deliberately: a sheet is read once per import.

Prompt point 3 exists for the elisions. A model that reads
"… 412 more rows in the same shape …" as a boundary ends its table there, which
is the exact fault this was fixing.

**And `repairPlan` had never once been called.** It is the paragraphs above,
75 assertions of it, and until Aug 2026 no route reached it: `/analyze` went
straight to `normalizePlan`, which clamps indices and asks no questions. The
protection existed, was tested, was documented here, and was not wired in.
It runs on the analyse path only — a plan coming back from the review screen is
still left alone, for the reason stated above.

`checks/sheetAnalyst.ts` (78) is the committed half — it drives the real
`analyzeGrids` against a fake NVIDIA and a fake Anthropic and asserts on the
request body, then runs the repairs over a sheet shaped like the one the prompt
describes. Its negatives are the half worth reading: a correctly-read header row
must be left alone, and a table with another below it must not run on into it.

**A worksheet is a lead list; a table is not** — `plan.grouping` in
`services/sheetPlan.ts` (`planGroups`), applied by `commitPlan`. Every detected
table used to become its own list, and on a real file that is wrong: a tab of
leads with three section headings down it is three tables to the detector and
**one list** to the person who typed it, so one worksheet arrived on the Leads
page as three lists scattered among a workbook's other ninety, with nothing on
any of them saying they were one thing.

- **`"sheet"` is the default and `"table"` is a switch on the review screen.**
  The old behaviour still has to be reachable: a tab holding a table of people
  and a table of organisations forced into one column set is what loses data.
- **A merged list's columns are the union of its tables'**, first table winning
  on a shared key. Merging onto the first section's columns is how a section
  carrying an email address arrives with none.
- **A tab holding exactly one table keeps that table's own title.** A banner the
  analyst read off the file ("Companies/Organizations") says more than the tab
  name; two or more tables and the tab name is the point.
- **The checkpoint gained `groupIds`.** A list now outlives the table that
  opened it, so a commit resumed between a worksheet's second and third section
  has to find the list rather than open a second one with the same name. The old
  `currentGroupId` is still read on resume.

**Every list and every lead carries its worksheet as a tag**, and the file name
beside it where the two differ — a workbook's tabs are routinely "Leads 1" …
"Leads 39", and a tab name alone is then no answer. That is what makes "these
came off the same sheet" filterable (`GET /leads?tags=`) rather than something
to remember: a list can be renamed, split, or emptied into another, and the tag
on the lead survives all three. Written through `registerTags`, so the words
land in the registry and the arrays hold slugs.

**And the import had been overwriting `Lead.tags` on every refresh.** The update
path copies every non-empty scalar, and an array is neither null nor `""` — so a
re-import of an updated sheet wrote the sheet's own Tags column straight over
whatever a scrape or a person had put on the lead. Tags are merged now, never
replaced.

`checks/importGrouping.ts` (29) is the committed half, database only: a
worksheet of three sections where only the third carries an email column, then a
re-import with a hand-added tag on one lead that has to survive it.

**A workbook is read one tab per request** — `services/sheetSource.ts`,
`POST /imports/analyze`. It used to be one request for the whole file: every
tab read and held at once, and all of them in a single analyst prompt. On a
real 39-tab workbook that is a third of a million cells and ~100,000 tokens,
and what came back was `502` with no way to tell whether any of it had run.

The first call opens the import and names the tabs without reading any of them;
each call after it reads exactly one and returns *that tab's* tables. Four
things get fixed rather than one: nothing is held but the tab being read, the
analyst sees one sheet and reads it better than it read thirty-nine, no request
is long enough to be cut off, and the screen gets a count that moves. A tab
that fails stops the run and keeps the ones behind it — "Carry on from <tab>"
resumes at the one that broke.

- **`GridSource` replaced `SheetGrid[]` everywhere it mattered.** It holds one
  grid — ask for the next and the previous is dropped — and `each()` serves a
  whole plan in a single pass while still holding one. Preview went from 18.5s
  to 3.3s on 39 tabs that way. `commitPlan`, `normalizePlanFrom` and
  `buildPreviewsFrom` all take one.
- **The cache holds the file, not the parse.** 20 MB of bytes rather than a
  third of a million cells, so the browser sends the workbook once instead of
  attaching it to all 39 calls.
- **Re-reading a tab replaces its tables rather than appending them.** A retry
  after a dropped connection would otherwise double that one group, silently,
  and only that one.
- `checks/bulkImport.ts` (16) is the committed half. The assertion that matters
  most is that reading tab by tab produces the plan reading them together does.

`checks/modelChoice.ts` (18), `checks/costs.ts` (32) and `checks/budgets.ts` (33)
are the committed halves. The first asserts on **what went over the wire** against
a fake Anthropic, because a correct `modelForJob()` that nothing calls is
precisely the defect it was written for; the other two need only Postgres. All
three carry the negatives that matter more than the positives — a standard-tier
job must stay on the good model, an explicit model must still win, an unbudgeted
agent must still really spend, and a read must never be held.

