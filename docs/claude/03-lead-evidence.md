# What is known about a lead, and how it is proved

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

**Nothing writes to a lead until somebody has looked at it** —
`src/services/leadPrep.ts`. A scraped row is a name, an email and three
em-dashes, and an email written from that can only be generic, because generic
is all the record holds. `prepareLead()` runs three stages before a word is
drafted:

1. `leadResearch.ts` — who they are, established against live sources
   (`job: "research"` → Perplexity), filling only *blank* fields on the lead and
   writing the discovery note.
2. `companyAudit.ts` — their site and mail domain, fetched and resolved. The
   checkable half.
3. `siteShot.ts` + `homepageLook.ts` — a screenshot of the homepage through
   Dakyworld's own Apify actor, read by a vision model (`job: "vision"`).
   The half markup cannot answer: what a first-time visitor actually sees.

**The scan writes back to the record.** It is not only evidence for a letter:
the trade and town the homepage states fill Category and Location, the
`mailto:`/`tel:`/profile links in the markup fill the contact fields and
socials, the findings become **tags** (`auditTags` — the filterable ones only,
not all of them), and `scoreLead` re-runs on what is now known (`Math.max`, so
a re-run never demotes a lead somebody has worked on). Tags are added and never
removed: a finding that has gone away is good news for the next look, not a
silent untagging that makes an earlier campaign impossible to reconstruct.

**The two contact rules are deliberately different.** An address a *search*
associated with a company is held back for a person, because a search can
attach the wrong company to a name. An address read out of the homepage we just
fetched is written straight in when the field is empty — it cannot be somebody
else's, and the worst case is that it is stale.

**When the four-reviewer report ran, it is what the letter argues from — and
for a month it was not.** `buildFacts()` read the `CompanyAudit` and the
`HomepageLook` and nothing else, while the review itself sat in a column and
went out **attached to the same email**. A business whose review found nothing
on the first screen saying what they sell, no way to make contact, and a page
worth rebuilding got a letter opening on the year in their footer, with that
review stapled to it. A letter arguing something weaker than its own attachment
is worse than one with no attachment at all.

- **The review runs before the facts are built, not after.** It used to be
  last, on the reasoning that the scan decides what the *letter* says and the
  team produces the *report* for a different reader. They are not different
  readers.
- **It supersedes the scan rather than adding to it.** The review's security
  section is handed the very `CompanyAudit` the scan produced and its UI/UX
  section read the same photographs, so it is a superset. Giving the drafter
  both lists puts two overlapping descriptions of one page into one prompt,
  which is how a model averages them into the blandest sentence available.
  `auditTeamFindings()` is the flattened list; `redFlags`, `caseStrength` and
  `strongestPoint` all take it and all prefer it.
- **`synthesis.emailBrief` was written for this and nothing read it.**
  `openOn` is the opening line, chosen by the model that weighed all four
  sections against each other; `doNotSay` is the guard naming what the evidence
  will not support, which a drafter that never sees it reaches for first
  *because* those are the claims that would make the strongest letter.
- **A page the review says to rebuild is a strong case whatever the severities
  are.** The ten headings judge the page as a whole, and a site under the
  redesign floor with nothing worse than four MEDIUMs on it is exactly the
  business that needs telling — the "nothing is broken and none of it is
  working" case, which no per-fault severity can express.
- **Everything that asks agrees, because they all read the same row.**
  `latestAuditReport(leadId)` reads `WebsiteAudit`; the three screens that show
  a case strength beside a draft, and `reportToAttach()`, all go through it.
  Copying the findings onto `LeadResearch` would give each of them a copy to
  drift from.
- **The scenario chooser was already built to accept the review's ids and was
  never given them.** `coldEmailScenarios.ts` lists both vocabularies against
  every scenario — `cert-untrusted` *and* `sec-cert-untrusted` — so a lead whose
  review found six faults was choosing its letter's shape from whatever the two
  quick checks happened to see. `emailContext` reads both now.
- **A report read out of a JSON column is untrusted shape**, not the type it is
  cast to: every reader guards `Array.isArray` before touching it, because the
  alternative is a `TypeError` inside the path that decides what a cold email
  says.

**A weak case is an output, not a gap.** `caseStrength()` reads the worst
non-GOOD severity across the review when there is one, and across the audit and
the look when there is not. When it is WEAK or NONE the
drafter is told **THERE IS NO STRONG CASE HERE** in those words and instructed
to write three honest sentences or to say the lead is not worth writing to; the
polish fails an email built on minor housekeeping whatever else is right about
it; and the composer says so above the draft. This exists because of a real
sent-quality failure: a letter that opened on missing link-preview tags and
closed on missing analytics, about a site that was fine. A system that always
produces an output will produce that email every time.

Then `emailDrafter.ts` picks the **angle** from the one fact that changes it —
no website is a different letter from a bad website — and `emailPolish.ts`
(`job: "humanise"` → Perplexity) reads it last, changing how it is said and
never what it says. `POST /emails/draft` runs all of it and returns the work:
the pre-polish draft, what the polish changed, and anything it *added*, which
should always be empty and is shown loudly when it is not.

Four rules hold it honest, and each has a failure mode behind it:

- **Fill a blank or leave it empty; never overwrite and never guess.** A scrape
  read the address off the business's own listing; a search read it off
  whatever ranked. Every filled value carries the URL it came from, and one
  without a citable source is dropped on arrival.
- **A researched contact address is offered, never applied.** Everything else
  being wrong costs a sentence in a draft somebody reads. An email address
  being wrong sends a letter about a stranger's business to a stranger.
- **A `website` value is validated as a URL before it is stored.** It decides
  which argument the email makes, so garbage there turns Dakyworld's strongest
  opening into a pitch about a site that does not exist.
- **Every stage degrades to a note, never an error.** No Perplexity key, no
  Apify token, a site that blocks headless browsers — each is a sentence in
  `notes[]`, and what comes back is still something a person can send.
- **The email opens where the evidence is strongest, and "strongest" means to
  the business.** `strongestPoint(audit, look)` ranks by severity and then
  breaks ties in favour of what a customer can *see* over what a tool measured.
  This was a real defect: the headline came from `audit.findings` alone, so a
  CRITICAL observation about the page could never beat a MEDIUM DNS detail, and
  a cement manufacturer got a letter about which hostname resolves. Accurate,
  and worth nothing to the reader.
- **The look answers a business question, not a design one.** `worthFixing`
  (problem / costsThem / whyWorthPaying), `fitsTheBusiness` — the gap between
  what a company is and what its page makes it look like, which is invisible in
  the markup and lands hardest with an established firm — and a `plainly` line
  on every observation with no web vocabulary in it at all. The email reaches
  for `plainly`; the owner is not a developer and never will be.
- **When there is no screenshot, the drafter is told nobody has seen the page**
  and forbidden from stretching a technical check into a design opinion; the
  composer says so in amber. Without that, a lead whose Apify token is missing
  silently produces DNS-trivia emails and nobody can tell why.

Results live on `LeadResearch` (one row per lead, `STALE_AFTER_DAYS = 30`), so
the second draft to the same person costs nothing and the Owner can read what
the email was argued from after it has gone.

