# The mail room, demo pages, and the website audit team

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

**The mail room** — `src/lib/imap.ts`, `src/services/mailbox/`, `routes/inbox.ts`,
the `mail.room` agent. Every email module before Aug 2026 was outbound: the app
could compose, schedule, sequence and send, and had no idea whether anybody
answered. A reply was something the founder noticed in his own webmail and then
remembered to type in — the one step in the pipeline that depended on a person
being at a desk. So a sequence kept writing to somebody who had already said
yes, and the fastest-moving event this business produces reached the system last.

```
IMAP IDLE ──┐
            ├─→ sync.ts ─→ parse.ts ─→ ingest.ts ─→ triage.ts ─→ router.ts ─→ AgentTask
minute tick ┘   (UID       (quote      (dedupe,     (a model:    (a table:
                 cursor)    stripped)   thread,      what is      whose job
                                        match)       this)        is this)
                                            └─→ consequences.ts (no model, always)
```

- **IMAP, not a provider API.** Sending has two paths because the provider
  differences live there; reading has none, and every mailbox this company
  could use already speaks IMAP. The Settings form arrives **pre-filled from
  the SMTP block** — the host is the SMTP host with `smtp` swapped for `imap`,
  the port is 993, and the password is usually the same App Password — so
  connecting is normally read-it-and-press-Connect. Credentials are proved
  against the real server before they are stored, exactly as SMTP is.
- **Both folders are read, and Sent is the half people forget.** The founder
  answers a prospect from his phone; the app knows nothing about it; the
  sequence writes again on Thursday asking whether they saw his first email.
  Reading Sent is what stops that — and a message the *app* sent is told apart
  from one typed by hand by looking its `Message-ID` up in the outbox.
- **The live connection is an optimisation over a poll that runs anyway.**
  `watcher.ts` sits in IDLE so a reply is read in seconds; `readMailboxOnce()`
  is also on the minute tick. Every failure path in the watcher degrades to the
  tick, which is why it is safe to run a socket inside a web process.
- **Consequences are code and run whether or not a model does.** Stop the
  sequence, suppress a bounce, honour an opt-out, log the conversation, move a
  NEW lead to Qualifying. None of that is contingent on an API key, because the
  sequence that keeps writing to somebody who replied is the failure this whole
  module exists to end.
- **An out-of-office is not a reply.** It carries `Auto-Submitted`, arrives
  seconds after a send, and treating it as an answer stops the sequence and
  loses the prospect in silence. `parse.ts` decides from the headers whether a
  machine wrote it and nothing acts on one — except a bounce, which suppresses
  **the address in `Final-Recipient`**, never `mailer-daemon@`.
- **The model says what a letter is; a table says whose it is.** `triage.ts`
  chooses between sixteen named intents; `ROUTES` in `router.ts` maps each to
  an agent, with a `known`/`stranger` split because the same question from a
  client and from a stranger is two different jobs. A model that picked the
  agent could hand a client's complaint to the cold outreach writer, and no
  prompt wording makes that reliably impossible. Below `CONFIDENCE_FLOOR` (0.6)
  the message goes to a person, and a paused or retired agent is not a
  destination — the chain ends at the Mail Room and then at nobody.
- **Routing raises a task; it never sends.** The brief tells the agent to draft
  with `email.draft` and stop, and the existing autonomy and dry-run gates
  decide the rest. On a fresh deployment an answered cold email produces a
  draft in the outbox, never a letter that left unattended.
- **`NEEDS_NO_REPLY` is not cosmetic.** The Inbox screen is a to-do list, and
  the first render of it put a bounce and an out-of-office above a stranger
  asking for a quote. A list that fills with machine mail is a list somebody
  stops reading, and then the enquiry is lost for the reason the module exists.
- **Threading is done by finding the stored message, not by matching a key.**
  A conversation's *first* message has no `In-Reply-To` and no `References`, so
  a key derived from the reference root keys it one way and every reply to it
  another: the letter and its answer were two conversations, and a reply typed
  on a phone was a third. `findThreadByReferences()` looks the ids up against
  `MailMessage.messageId`; the subject-plus-counterpart key is the fallback for
  the many clients that answer with neither header.
- **`triage` is its own model job** (`lib/models/registry.ts`) because it is the
  only one that runs once per *arriving* message rather than once per piece of
  work somebody asked for. Separating it is what lets a busy mailbox be moved to
  a cheap model from the Settings screen without moving everything else. The
  wording is a **writer job** owned by `mail.room`, so editing that agent
  changes how the post is read — see "Writers read the agent that owns them".
- **`ensureAgents()` only ever creates**, so the routed agents — `support.desk`,
  `outreach.followup`, `billing.invoicer`, `proposal.writer`, `cco` — do **not**
  get `inbox.read` and `inbox.handled` on an existing database. Tick them on the
  Agents screen, and set `mail.room` to Active; it seeds DRAFT like every other
  specialist.

**Demos** — `src/services/demoBuilder.ts`, `designReferences.ts`,
`routes/demos.ts`. For a lead with no website or a bad one, the demo is the
strongest thing to offer instead of a call: far easier to say yes to, and it is
the argument itself rather than a claim about the argument. **Playbook v3
narrowed where it appears** — a first email's default ask is the smaller
artefact (the outline, the screenshot, the checklist), and the demo is the
stronger option where the design or the absence of a site is the whole story.
Either way it is an offer, never a request for time. When they agree,
`buildDemo` runs — design direction first (`job: "research"` → Perplexity, with
`search_domain_filter` pinned to variant.com, themeforest.net, motionsites.ai
and aura.build, so the style comes from published work rather than a model's
memory), then the page (`job: "html"` → ChatGPT). It is stored on `Demo` and
served at **`/demos/<slug>`**.

- **The demo banner is injected by `demoBuilder`, never asked of the model.** A
  page carrying a real business's name that does not say it is a concept can be
  mistaken for theirs, by them or by anyone the link reaches.
- **`/demos/<slug>` is public and mounted above the SPA catch-all in
  `index.ts`** or the React app answers it. `/demos` itself has no route there
  and falls through to the authenticated Demos screen — the list of who is
  being pitched to must not be public.
- The served page gets a strict CSP; `sanitiseDemoHtml` strips external
  scripts, iframes, offsite form actions and flags hotlinked images first, so
  the page does not arrive broken by its own headers.
- Nothing builds without a scan behind it. The route answers 409 and the tool
  throws — a guard that only exists in a button is not a guard.
- **A lead with no website gets one built before the letter is written** —
  `services/leadDemo.ts`, `demoIsTheArgument()` in `leadPrep.ts`,
  `POST /emails/draft`'s `demo` option. `buildDemo` could do this from August
  and **nothing ever called it on its own**: somebody had to notice the lead
  had no site and press a button, while the drafter was being told to offer "a
  page built for them to look at" that did not exist. That letter is the one
  with no evidence behind it — nothing fetched, nothing measured, nothing
  photographed — so it was a stranger predicting their future, which is the
  least persuasive email in this trade. Now the page is built during the draft,
  the link is a fact like any other (`emailContext` already carried it), and
  the doctrine's "When they have no website" section makes the link the whole
  ask: no call, no list of what a website contains, no second question.
  Three rules: **only where there is no site** (a demo for a working site is a
  redesign pitch, which is somebody's decision — `demo: "always"` is how it is
  made), **never twice** (a page the prospect may already have opened must not
  change under them), and **a failure is a note, never an error** — the facts
  say which of the two happened, because a letter offering a link that does not
  exist is the one mistake here a prospect definitely notices.
- `EmailPurpose.DEMO_READY` carries the link, and `emailContext` puts the URL
  and whether it has been opened into the facts.

**The website audit team** — `src/services/audit/`, `routes/audits.ts`. Four
reviewers over one site, compiled into one document. It runs on its own at the
end of `prepareLead` (the "Look at them" button sends `withAuditTeam: true`)
and can be run on its own from `POST /api/audits/run` or the `audit.website`
tool. The result is a `WebsiteAudit` row plus two artefacts: a branded PDF for
a person to read, and Markdown the cold lead writer argues from.

```
evidence.ts   fetch once, measure once, photograph twice (1280 and 390),
              and rent a browser once (services/seoAudit.ts)
  ├ ux.ts          job: "vision"  — what a visitor sees, with a box per finding
  ├ performance.ts measured, then job: "text" for the summary only
  ├ content.ts     job: "text"    — the visible words, markup stripped
  └ security.ts    no model at all
redesign.ts   job: "redesign" — ten weighted headings, one score (0.16 of the
              site's own), one of four calls, and the proposal paragraph.
              Runs before synthesis.ts, because its score is in that number.
synthesis.ts  callClaude, named rather than routed
annotate.ts   draws the boxes; markdown.ts and pdf.ts render
```

**Describing the page and deciding about it are two questions, and one model
answering both is what this splits up.** `ux.ts` says what is visibly true and
boxes each point onto the screenshot; `redesign.ts` reads the same two pictures
and answers the one the business owner actually has. A reviewer that has just
listed six faults recommends a rebuild, because a list of faults is what a
rebuild is argued from — and "you need a new website" is the most expensive
sentence in a proposal to have got wrong, in both directions.

- **It runs beside the compile, not before it.** Both read the sections rather
  than the site, and they are asked separately for the same reason the four
  reviewers do not talk to each other: a decider that has read a summary agrees
  with it. The UI/UX *findings* are handed over, though, so one document cannot
  say two things about one homepage.
- **It is not a discipline, and its score is 0.16 of the site's own** —
  `LOOK_WEIGHT` in `audit/types.ts`, taken out of UX's old 0.32 rather than
  added on top. The look of a page is measured twice now and that is the point:
  the UI/UX section subtracts a fixed number of points per fault, which answers
  *what is wrong with it* and cannot answer *how well is it made* — a plain,
  competent, forgettable page has no faults to subtract and scores in the
  nineties. The ten headings answer the second question directly. Appearance
  keeps exactly the weight it always had, split evenly between the two ways of
  asking. It is still not a discipline: no findings, no reviewer row, no
  section, never re-run on its own. **A call that could not be made is left out
  of the average, never scored zero** — a zero states that the page looks as bad
  as a page can look, about a business nobody photographed.
- **So the call runs before the compile rather than beside it.** They used to
  go together in one `Promise.all` because neither needs the other's answer,
  which is still true — the compile is not shown the verdict. What changed is
  that the synthesis is *told* the site's number, and handing it a total worked
  out without a section about to be added is how a summary comes to quote a
  figure the front page does not carry.
- **Under 70, a redesign is the answer and judgement may not say otherwise** —
  `REDESIGN_FLOOR`. One band of latitude would let a page scoring 65 be called
  a sharpening job, which is the one direction the error is expensive in: the
  owner buys the smaller job and the smaller job does not work. Harshness
  inside one band is left alone; two bands is still refused in both directions.
- **Ten headings, weighted in code, and the model never sees the total.** It
  scores each heading out of a hundred; `weighApart()` multiplies by the fixed
  weights in `CATEGORY_WEIGHTS` and adds. Ask a model for eleven numbers where
  the eleventh is a weighted mean of the other ten and it will give you eleven
  numbers, one of which is wrong — noticed by the one reader who checks, who
  is the owner holding the invoice. A heading the model omits scores nought and
  says so in its own row, rather than being dropped out of a total that then
  describes nine tenths of a page.
- **The verdict has to be reachable from the working.** Four calls now
  (LEAVE_IT, REFINE, REDESIGN, REBUILD, worst last), and the bands are stated
  in the contract so the model can aim at them. `agreeWithTheNumbers()` allows
  **one** band of disagreement — a well-made page that never says what the
  company sells scores in the seventies and still needs rebuilding, and saying
  so is why a model is asked rather than a spreadsheet — and pulls back two,
  recording the move on `RedesignVerdict.adjusted`. That sentence is shown on
  the internal screen and nowhere a client reads: it is a fact about how the
  report was made, and a PDF that footnotes its own decider reads as though
  nobody stood behind the verdict.
- **Two numbers in one document is a fault unless the document says what each
  measures.** The redesign score is about how the page *looks*; `overallScore`
  is the whole site including three things no photograph shows. Both the PDF
  band and the Markdown carry that sentence, and it is asserted.
- **`TARGETED_FIXES` is `REFINE` now, and stored reports still hold it.** A PDF
  is built from its row every time somebody asks for one, so a renamed enum is
  not a migration — it is every old audit rendering a blank heading.
  `normaliseCall()` and `categoryName()` absorb both renames (the nine-value
  `RedesignArea` was folded into the ten scoring categories, so an issue now
  names the heading it pulled down).
- **LEAVE_IT is a real answer and the direction list is emptied when it is
  given.** A model that decides a page is fine and then lists five changes to it
  has answered both ways, and the list is the half a reader acts on.
- **A vendor that cannot be shown the picture never answers.** Perplexity
  declares `redesign` and not `vision`; if it refuses the image the chain moves
  to a model that can see, and the document says who decided. An oversized
  picture fails the attempt rather than being dropped from it — an answer
  written without the screenshot is indistinguishable from one written with it.
- **A UI/UX re-run decides again; any other section's re-run does not.** Nothing
  the call was argued from has moved, and paying for a second opinion would give
  the document two answers a fortnight apart.
- **The searched sources are printed in the Markdown only.** They are pages
  about how sites in a trade look now, not evidence about this business, and a
  list of links under a client-facing verdict reads as though it were.

- **Two reviewers have no judgement in them and that is the point.** Every
  speed, SEO and security finding is arithmetic on a header, a tag, a DNS
  record or a measured millisecond, and each one is checkable by the person
  reading. A model asked to review a stranger's site for security will find
  *something*, and what it finds is a plausible vulnerability that may not
  exist — in a document that goes out under Dakyworld's name to somebody who
  knows the truth. The speed section's model call writes the summary and cannot
  add a finding.
- **The speed half is measured in a browser, the verdict is not**
  (`services/seoAudit.ts`, `smart-digital/complete-seo-audit-tool`, **billed per
  page analysed** — so `crawlPages` is off and `maxPages` is 1). First paint,
  speed index, blocked interaction, layout shift, image weight in real KB and
  links verified by an actual request are things a fetch cannot answer at any
  price. The actor's own 0-100 score and its own issue list are **deliberately
  thrown away**: two scoring systems in one document is one too many, and it
  would report the same missing title tag twice in different words.
- **Where a measurement and an inference overlap, the measurement wins and the
  inference is dropped.** Counting render-blocking files is a proxy for the
  browser being stuck; unsized images are the usual cause of a page that jumps.
  When a browser has since measured no delay and no movement, neither finding is
  printed — telling somebody their page keeps visitors waiting, when a browser
  timed it and it does not, is a false statement dressed up as arithmetic.
- **The audit reuses the scan's screenshots, and only when they are
  screenshots.** `picturesToReuse()` in `evidence.ts` used to branch on whether
  the option had been *passed*, and `leadPrep` passes what its own capture
  returned whether or not that produced anything — a `ShotResult` with
  `shot: null` and the reason in `note` is an ordinary return from `siteShot`.
  So one flaky Apify run during the scan switched off the audit's capture as
  well, and the UI/UX section reported "Nobody has seen how the site looks"
  about a site that photographs perfectly well. Re-running that section on its
  own worked every time, because a re-run has no handed-over picture to
  inherit — which is what made it look like a fault in the section. The
  discarded result's reason is kept and printed only if this run's own capture
  fails too.
- **A section that could not run is unscored, never zero and never a hundred.**
  `DisciplineReport.scored` exists because the first render read "Content
  100/100 — nobody read the writing on the page": no findings scores a hundred.
  `overallScore` averages only the sections that ran — and refuses to publish a
  number at all below `MIN_SCORED_WEIGHT` (half the weight), because rescaling
  to the sections that ran is also what let one section at 0.22 weight become
  the whole site's score. That shipped as "92/100 — Strong" for a site whose
  certificate had expired and which nobody could open.
- **Regions are fractions of the image, never pixels.** The picture is cropped,
  shrunk for the model and resized again for the PDF. `clampRegion` also
  rescales an answer given in percentages or in 1024-pixel coordinates, which
  is what a model actually returns about a third of the time.
- **The synthesis cannot introduce a fault.** Every `priority` entry must name a
  finding id that a reviewer produced; anything else is dropped and counted in
  the notes.
- **The Markdown is assembled in code and only its prose comes from a model.**
  The next thing that reads it is another model, and a drafter that has learned
  where the evidence lives must not have to re-learn it per company. Its last
  section is the internal email brief and it is labelled as such — that is the
  one part never pasted to the business.
- **PDF text goes through `pdfText()`.** PDFKit's standard Helvetica is
  WinAnsi, which has no arrow, so every "Settings → AI models" note in the app
  rendered as `Settings !' AI models` until it did.
- Deleting a review deletes its files explicitly. The file FKs are ON DELETE
  SET NULL so losing a PDF never costs a report its findings, which means
  nothing else would ever clean them up; `orphanedFiles` covers the cascade
  from a deleted lead.
- `annotate.ts` writes pixels into `png.ts`'s decoder output and carries its own
  5x7 bitmap digits. No canvas dependency and no native build.

