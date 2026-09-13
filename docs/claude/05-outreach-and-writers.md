# Outreach doctrine, the writers, prompt surfaces and phone channels

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

**The outreach doctrine is the authority** —
[`server/src/services/outreachDoctrine.ts`](../../server/src/services/outreachDoctrine.ts).
It replaced Cold Email Playbook v3 on 22 Aug 2026 at the founder's instruction:
the playbook was to come out of the cold email agent entirely and be rebuilt
from the installed skill libraries. `docs/cold-email-playbook.md` is kept as
history, marked superseded, and **nothing in the code reads it**.

One file now holds all three outbound doctrines — cold, follow-up and
WhatsApp/SMS — because they are one system that has to agree with itself, and
keeping them apart is how the polish stage came to enforce a rule the drafter
had already dropped. Four things in it **reverse** the playbook, so do not
"restore" any of them:

- **The letter opens on the reader, not on us.** The playbook opened every
  email with "Daky here from Dakyworld" *before* the observation. Leading with
  yourself is the commonest reason a stranger stops reading. Dakyworld is still
  named inside the first three lines — `coldEmailChecks` blocks a send
  otherwise — but it comes *after* the thing that was seen.
- **There are no scenarios.** Eighteen numbered letters produced eighteen
  recognisable shapes. The writer now picks a framework from the evidence.
  `coldEmailScenarios.ts` survives as **evidence routing only** — which
  confirmed finding is strongest, and `chooseScenario()` returning null still
  means there is no email — but no part of one reaches a model.
- **Subjects are two to four lowercase words and deliberately boring**, not
  "six words or fewer, specific". The subject's only job is to get the email
  opened.
- **One true proof point belongs in a first email** — whichever figures the
  website currently publishes, read from it rather than listed here (70% of the
  manual work removed on one automation, 30+ enquiries a month, 30+ hours
  returned monthly, as of Sep 2026; the four-hour security-incident claim went
  when the site stopped offering managed cybersecurity) — where it fits the issue just
  described. The playbook had none.

**More than one red flag is one letter and one attachment** — `redFlags()` in
`leadPrep.ts`, the doctrine's "When there is more than one red flag",
`reportToAttach()` in `emailSender.ts`. Looking properly at a business
routinely turns up three or four serious faults, and everything about the
drafter encouraged it to argue from all of them. A list of everything wrong
with somebody's website, sent by a stranger, is a sales audit: it invites an
argument about the third item instead of a conversation about the first, and
nobody replies to it.

- **A red flag is CRITICAL or HIGH, from either half of the scan.** MEDIUM is
  housekeeping — real, worth fixing, not worth a paragraph in a first letter —
  and counting it would make every business look alarming, which is how the
  word stops meaning anything.
- **Two or more, and the four-reviewer report runs itself.** `withAuditTeam`
  is tri-state now: asked for, refused, or *earned by the findings*. There has
  to be something to attach, or the sentence "a few other things came up and
  they are in the report" is a stranger saying "there are other problems with
  your business" and offering nothing. **A batch still never runs it** — sixty
  leads prepared overnight would be sixty reports nobody asked for.
- **`composeMessage` attaches it, exactly as it attaches an invoice.** A rule
  that must hold on every message cannot depend on whoever composed it
  remembering to tick a box, and this is the same reasoning — and the same
  failure — as "attach the PDF" was for invoices. It is a `StoredAttachment`
  kind of its own keyed on the *review* rather than the file, so a report
  re-run between drafting and sending goes out as it now stands.
- **The letter and the attachment are decided from the same facts.** Where no
  PDF rendered, the fact the drafter reads says so and forbids mentioning a
  report at all. An email referring to an attachment that is not there is the
  one mistake in this pipeline a reader definitely notices.

`checks/coldEvidence.ts` (31) covers both halves, database only, and half of it
is negatives: one red flag attaches nothing, a project update never carries an
audit of a stranger's website, a review with no rendered PDF is skipped rather
than failing the send, and a business that already has a site is never given a
demo behind somebody's back.

What survived is the honesty floor, and it survived because it was never
playbook: only what was confirmed, **what it makes harder rather than what it
has cost**, no price in a first email, no private individual named, and never
implying anything physical (Dakyworld is entirely remote).

`tmp/outreachSwap.ts` is the harness. For every rule it asserts the new wording
is present **and that its opposite is absent**, across the drafter, the phone
drafter and both agent seeds — the negative half being the one that catches the
next version of the bug this codebase has already paid for twice.

**A prompt improvement that never reaches the model is not an improvement, and
the symptom is "nothing changed".** Three ways that happened here, all worth
checking before writing another word of prompt:

0. **The prompt being edited was not the prompt being run.** The largest of the
   three, and the one that made the other two hard to see. Every deliverable
   this company produces — the cold email, the polish, the proposal, the
   WhatsApp message, three audit sections, the demo page, the research — was
   written by a string constant in `lib/` or `services/` that **no screen
   displayed and no edit could reach**, while the Agents screen showed a prompt
   that governed only that agent's own task runs. `DISCIPLINE_AGENTS` made it
   literal: it supplied the name printed on the audit PDF — "Reviewed by the
   Page Reviewer" — while an anonymous constant did the reviewing, and the UX
   prompt actually opened "You are the Dakyworld UI/UX Designer", an agent the
   one-job split had moved off that work. So the doctrine existed twice:
   `outreach.writer`'s seed carried the whole playbook in its `process` layer,
   and so did `draftSystem()`. One was editable; the other was the one that
   ran. **See "Writers read the agent that owns them" below** — that is the fix
   and the rule that keeps it fixed.
1. **A later stage was enforcing the earlier doctrine.** `emailPolish` runs
   *after* the drafter and rewrites the text. Its `TEST.COLD_OUTREACH` still
   required "what it costs them" and treated a self-introduction as
   throat-clearing, so it edited v3 back out of every draft. The last writer in
   a chain sets the house style whatever the first one was told.
2. **The prompt contradicted itself.** The purpose brief said "never what it has
   already cost them" and "the ask is never a meeting"; the legacy `angle()`
   block, emitted immediately after, said "say what it costs them" three times
   and "ask for fifteen minutes". A model given both does not average them — it
   falls back to the generic email it already knew. `angle()` and the scenario
   are two answers to one question, so **only one is emitted**: the scenario
   when the findings chose one, the angle only when they did not.

`tmp/writerAudit.ts` is the tool for this. It prints the composed prompt, asserts
each rule is present *and* that its opposite is not, and reports what fraction of
the prompt is actually facts about the business. Run it before adding
instructions, not after.

**Writers read the agent that owns them** — `src/services/writers/`. Every job a
model writes is named in `registry.ts` and given exactly one owning agent, and
`brief.ts` resolves what that writer is told: a per-job override first, then
**the owning agent's own instruction once a person has edited it**, then the
wording the code ships. An agent may own several jobs; a job has exactly one
owner, because two agents editing one deliverable is the contradiction that
makes a model fall back to the generic output it already knew.

- **Doctrine and contract are different things and only one is editable.** The
  doctrine is how Dakyworld writes this — voice, judgement, what may be
  claimed. The contract is the shape of the answer: the fields, the plain-text
  rule, the severity words that get scored, the opt-out the app appends, the
  fabrication rules on a demo page carrying somebody's real business name.
  `composeWriterSystem()` puts the contract *after* the doctrine and no edit
  path can reach it, so a rewritten voice can make a letter worse and can never
  make it unparseable, uncompliant, or libellous about a stranger.
- **An untouched seed deliberately falls through to the shipped wording.** A
  seeded agent's ten layers describe a colleague ("you report to the CRO,
  escalate when…"); the shipped doctrine describes the letter. Swapping one for
  the other on an agent nobody edited would quietly make every draft worse.
  The first edit is what hands the agent authority over its own deliverable.
- **The override is read with a direct query, not `getSetting`.** That cache is
  per-process and cleared only by the process that wrote it — on more than one
  instance, a brief edited on one would go on being ignored by the other, which
  is this bug again wearing a different hat.
- **`emailPolish` no longer carries its own copy of the checklist.** It runs
  last and rewrites the text, which makes it the house style whatever the
  drafter was told, so it is resolved to the *same* job as the drafter. A
  second copy of a doctrine is a second doctrine.
- The Agents screen's compiled prompt returns `writes`: which deliverables this
  agent's wording governs, and whether it is governing them *yet*. That panel
  is the answer to "where do these words actually go", which the screen could
  not answer before.

`tmp/writerReach.ts` is the harness. It plants a shibboleth in an agent's
wording and asserts it comes out of the real composer, that the contract
survives, that the polish sees the same doctrine, and — the check that catches
the next version of this bug — that **every job in the registry is actually
passed to the composer by the file it claims**, since a job key is a string and
nothing else verifies it. 63 checks, database only, no key.

**The old doctrine also reaches the drafter through the facts.** Two files feed
the cold writer in words rather than in rules: `audit/markdown.ts` writes the
internal email brief the writer argues from, and `audit/synthesis.ts` decides
the `consequence` sentence and the DEMO/FIX ask that go into it. Both were still
saying "ask for fifteen minutes" and "what that costs them" long after the
drafter stopped. **Anything that writes an instruction another writer will read
is part of the playbook surface** — the drafter, the polish, the two agent
prompts, the synthesis and the audit Markdown.

**Effort is a quality decision and it was set wrong.** The cold email — the
shortest, most-read thing the company produces — was drafted at `medium` while a
proposal and a demo page were at `high`. Both email stages are `high` now, and
the agent runner picks by *what the work is* rather than by tier alone
(`WRITES_FOR_OUTSIDE` in `agents/runner.ts`): a judgement or a piece of writing
that leaves the building gets high, reading a record and filing a task does not.

**The playbook guides; it does not dictate.** The scenarios say what a letter
must establish and how small the ask should be. `subjectExamples` and
`exampleAsk` are named that way on purpose — they calibrate register and are
never text to reuse, because twenty businesses in one scenario receiving the
same subject line and the same closing question is a mail merge with eighteen
variants, which is the thing the playbook exists to prevent. The first version
of `scenarioForPrompt()` said `Subject: use "X"` and a model does what it is
told; it now frames both as calibration, and `coldEmailChecks.ts` warns when a
draft reuses one verbatim. **Guards are the exception and are rules** — "never
mention fraud", "no same-day promise" — and are stated as such in the prompt.

`coldEmailScenarios.ts` holds the **eighteen scenarios as data** — signals,
guidance, register examples, and the guard that belongs to that letter and no
other. Eleven are chosen in code from the finding ids the audit produced,
worst first; seven need a person to supply the evidence (a new branch, a
registrar account, a sector incident) and are never chosen automatically.
`chooseScenario()` returning null is a real answer and means there is no email.

`coldEmailChecks.ts` runs the **nine of the fifteen checklist items that are
arithmetic on the rendered text** — unresolved merge fields, the opt-out,
identification, one question, unsupported "most people" claims, marketing
filler, jargon, the subject, the length, the price — against the *polished*
text, because that is what would actually be sent. Blocking failures surface at
the top of the composer in red. The other six are judgement and are listed for
the reviewer, never ticked by code. The reply-based opt-out is appended by
`emailRender` rather than asked of the model: a rule that must hold on every
message cannot depend on a model remembering it.

The same doctrine lives in three places that must agree — the playbook, the
drafter's `SHIPPED_DOCTRINE`, and the `outreach.writer` / `outreach.followup`
prompts — plus the `dakyworld-cold-email` skill for writing outside the app.
**The drafter's copy is now a default rather than the authority**: once either
agent has been edited, its wording is what writes the letter and the constant
steps aside (`services/writers/`). That is what makes the third copy safe —
before it, the agent prompts were documentation of a doctrine that a constant
enforced.
`applyColdEmailPlaybook()` is the one-off pass that puts the v3 wording onto
agents that already exist, marked by `agents.coldEmailPlaybookV3` and skipping
any prompt the Owner has rewritten.


**The phone channels** — `src/lib/{phone,whatsapp,messageDrafter}.ts`,
`src/services/{messageSender,whatsappTemplates}.ts`, `routes/messages.ts`,
`routes/messaging.ts`. Most of a scraped list has a number and no email — a
Maps listing carries a phone number because a customer needs one, while an
address is a thing a business chose to publish — so the largest group of leads
in this database could not be reached by anything the app did.

**One rule shapes the whole module.** WhatsApp carries a message you wrote only
within **24 hours of that person's last inbound message**; outside that window
it carries a template Meta approved in advance and nothing else. A scraped lead
has never written to us, so **every first WhatsApp is a MARKETING template and
waits on Meta's review** — minutes, occasionally a day. That is not a latency
this code can engineer away, which is why `MessageThread.lastInboundAt` exists
and why the window is re-read at the moment of sending rather than trusted from
the composer: 24 hours is long enough for it to have closed since the draft.

**So `wa.me` is a first-class route, not a fallback.** `MessageRoute.LINK`
prepares a message and hands back a click-to-chat link a person opens and sends
from their own WhatsApp — no Business account, no template review, no
per-conversation fee, and it arrives from a human being rather than a brand,
which is what a small business here actually replies to. **A LINK message reads
`READY` until somebody says they sent it** (`markSentByHand`). Copying a link is
not sending a message, and an outbox that marks things sent on the strength of a
click is an outbox nobody can trust about anything.

- **`lib/phone.ts` refuses rather than guesses.** The same handset arrives six
  ways and the number *is* the identity here — it is what a thread is keyed on
  and what an opt-out is recorded against, so two spellings means two threads
  and an opt-out on one that does not stop the other. The failure mode is
  silence, not an error: both providers accept a malformed number and the
  message goes to nobody, or to a stranger under Dakyworld's name.
- **A landline is not "no phone".** A WhatsApp to one is a conversation fee for
  nothing and an SMS to one is money burnt, so `reachabilityOf` reports it
  unreachable *with the reason* rather than quietly trying.
- **An SMS cliff is invisible and `smsCost` is why it is priced in code.** 160
  GSM-7 characters is one segment, 161 is two, and one curly apostrophe pasted
  in from a word processor re-encodes the whole message as UCS-2 and drops the
  limit to 70. `toGsm7` is offered, never applied silently.
- **`MessageSuppression` is keyed on the number and crosses channels.** Somebody
  who replies STOP on WhatsApp has not asked to keep getting texts. An inbound
  STOP also cancels everything queued on both channels and stops any email
  sequence the lead is in — `emailSequences.stopOnReply` is keyed on an address,
  and a lead reached by phone because they have no address could never have
  triggered it.
- **`lib/messageDrafter.ts` is part of the playbook surface.** Same doctrine as
  the email drafter — identify yourself first, say what it makes harder rather
  than what it has cost, no price, an ask that offers rather than requests — and
  a different shape, because there is no signature to append (the name goes *in*
  the words, which the email drafter is explicitly forbidden from doing) and 70
  words is the ceiling rather than the floor.
- **A forty-word message is not handed a letter's evidence.** `buildFacts()`
  composes the case for a cold *email* and says so in the words — "THIS LETTER
  ARGUES FROM IT", "put it in the letter on its own line", "I have put them in a
  short report and attached it" — and all twenty-five lines of it, plus the lead
  score and the deal size, were going to a writer producing a chat bubble with
  no attachment and no room. That is instructions for a different job, and a
  model given instructions for a different job falls back to the generic message
  it already knew: the reported symptom was drafts "not related to context",
  produced from a prompt containing everything anybody had found out about the
  business. `phoneFacts()` **selects, and never rewrites** — rewriting is the
  tempting version and it turns "We already emailed them 3 days ago" into a
  false statement about what this company did. The strongest point, the guard on
  what may not be claimed, what to offer and the demo link lead; the letter's own
  mechanics and our pipeline's bookkeeping are dropped; the rest are capped at
  eight with one line saying how many were held back and forbidding any mention
  of them.
- **The phone drafter has an `angle()` now, and the email drafter had one since
  August.** It is the one choice no amount of evidence can make, because it is
  about the *absence* of it — a business with no website is a different message
  from a business whose site somebody has looked at — and on forty words that
  choice is most of the draft.
- **`caseStrength` was computed and thrown away.** `POST /messages/draft` worked
  it out, returned it so the composer could print the amber warning, and never
  told the drafter — so a business with nothing wrong with it got a confident
  pitch, because writing one is what the drafter was asked to do.
- **The `message.draft` tool now looks before it writes.** The HTTP route has
  prepared the lead since the phone channels shipped; the tool went straight to
  `resolveContext`, so every message an *agent* wrote to an unprepared lead was
  generic by construction — one fact, "Nobody has looked at this business yet" —
  and nothing on any screen said which of the two paths had produced a draft. It
  takes the same `prepare: auto | always | never`, degrades a failed look to a
  note rather than an error, and returns `lookedAtThemFirst` and `caseStrength`
  so a thin draft can be told from a thin business.
- **A cold WhatsApp is always a template, so one starter template carries the
  finding as a variable** (`site_observation`). The other three name a fault in
  their fixed wording, which made them sendable only to a business with that
  exact fault — a drafter arguing from a four-reviewer review and a template set
  that knows three stock faults are two halves that do not meet. The `wa.me`
  route is the other answer and carries the drafted words verbatim.
- `checks/coldOutreach.ts` (48) holds all of it plus the routing, database and a
  fake Perplexity on localhost. Half of it is the negatives: a fact is never
  reworded, the demo link and the guard are never among the lines cut, a client
  email must not route to the outreach job, and a lead with no website must not
  be fenced to a guessed domain.
- **`coldEmailChecks.preSendCheck` took a `channel` rather than being forked.**
  One doctrine with three sets of numbers: the subject check does not run where
  there is no subject, and the length band differs. Two copies of a checklist
  drift, and the drift is invisible until a v3 email and a v2 WhatsApp reach the
  same prospect on the same day.
- **`WhatsAppTemplate` mirrors Meta and never leads it.** Only `syncTemplates`
  writes a status, because Meta is the only thing that knows one — a template
  can be approved and then paused a week later because recipients blocked it.
  `checkTemplate` catches every one of Meta's refusals *before* submission
  (a name with capitals, a body starting or ending on a variable, adjacent
  variables, a gap in the numbering), because each of them comes back as a
  generic "invalid parameter" hours later.
- **A template body is never modified.** Meta approved an exact string, so the
  opt-out is *not* appended to one — which is why every starter template carries
  its own.
- **Meta's error codes are translated.** `explain()` in `lib/whatsapp.ts` turns
  `(#131047) Re-engagement message` into the sentence that says what to do. The
  raw text sends somebody looking for a bug in an app that is working exactly as
  Meta requires. `WhatsAppError`, `HubtelError` and `MessagingError` join
  `AnalystError` and `ApifyError` as the classes whose message the error handler
  passes through, for the same stated reason.
- **`routes/messaging.ts` is public and mounted above the JSON parser** — the
  fourth route on that page for which the signature covers the exact bytes.
  Verification matters *more* here than on the generic webhook route: an
  unverified inbound would open a 24-hour free-form window to a number of the
  caller's choosing, or opt a live prospect out. Meta signs with the app secret;
  **Hubtel signs nothing at all**, so its SMS callbacks carry a secret in the
  query string and are refused without one.
- **`quality_rating` is fetched, not stored.** It falls when recipients block or
  report, a RED number loses the ability to start conversations at all, and
  there is nowhere else in this app to see it.

`tmp/phoneChannels.ts` drives all of it — the number table, the segment
arithmetic, the channel-aware checklist, Meta's template rules, then the whole
send-and-receive loop against a real Postgres and a local stub playing Meta and
Hubtel, then the webhook over **real HTTP mounted as `index.ts` mounts it**.
That last part is the one that cannot be faked, and it is the same trap
`tmp/slackButtons.ts` exists for. It also audits the composed prompt the way
`tmp/writerAudit.ts` does: every v3 rule present, and every superseded one
absent.

