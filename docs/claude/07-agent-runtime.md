# The agent runtime: tasks, hiring, Slack, memory and state

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

**The agent runtime** — `src/services/agents/`. `runner.ts` is what turns a
task into work: it claims an `AgentTask`, builds the prompt from the agent's
ten prompt layers plus its recalled memories plus the resolved record, hands it
only the tools its `toolkit` grants, and turns a manual tool-use loop
(`lib/claudeAgent.ts`) until the agent finishes or escalates. Every call still
goes through `invokeTool`, so the gate is unchanged.

**An agent turn is a job like any other, and it routes like one.** The loop
itself picks its vendor: **NVIDIA first and free first** — it climbs the three
rungs of the `agent` free ladder before anything is paid for — then the paid
floor, which is Claude, then ChatGPT, then Gemini, whichever of them has a key.
A rehearsal dies no more on an empty Anthropic balance while free capacity sits
there unasked. There is **one** place in the loop that decides what a failure
means, for all four vendors: a rung that did not serve climbs to the next rung;
an exhausted ladder hands on to the floor **including on a 429**; a paid vendor
hands on for anything at all; and NVIDIA with free models switched off keeps
the old, narrower rule so a rate limit still requeues rather than moving the
bill. A **key-level refusal** (401/402/403) also puts NVIDIA on a 15-minute
cooldown so the resumes behind it start at the floor instead of each paying one
call into the same refusal. The loop's internal state stays Anthropic-shaped
throughout: `chatCompletionsTurn()` and `geminiTurn()` translate at the wire, so
a checkpoint written by one vendor resumes on another, and the effort travels as
`reasoning_effort` mapped onto what the wire accepts — low, medium, high, and
nothing else, because two of the free models answer 400 to any other value. It
is sent only to a model that declares it takes it.
`checks/agentLoopNvidia.ts` drives the real loop against a fake NVIDIA and pins
the wire shape, the checkpoint shape and the handover; it switches free models
**off for the `agent` job** in its own scenarios, because the ladder has its own
file and this one is about the wire.

**Check `result.dryRun` before `result.refusedReason`.** A dry run carries a
`refusedReason` too — it is the sentence explaining *why* the call was
downgraded — so checking the refusal first files prepared work as refused,
leaves `dryRunCalls` at zero, and finishes the task `DONE`. The Owner then
reads "done" about work that never happened. This shipped broken once.

**Seven tools exist outside the catalogue** and every agent has them regardless
of its toolkit, because they are how an agent takes part in the system rather
than things it does to the business. Three are about the agent itself:
`escalate` (stop and ask → `BLOCKED`), `remember` (write a memory), and
`delegate` (hand work to a *direct report* only — never sideways or upward; a
specialist does not get this one). Four are about working with the rest of the
workforce.

**Agents can reach each other now** — `workflowTools()` in `agents/runner.ts`.
Before Aug 2026 an agent had exactly two ways out of work it could not do: hand
it *down* to a report, or stop and ask a person. Neither is what a colleague
would do, and the result was agents attempting crafts that were not theirs. The
prompt teaches four steps and says to stop at the first one that answers:

1. **`findAgent`** — search the roster in plain words ("edit a video"). Free, no
   model call, matched on skills and mission rather than on tool keys.
   Everything else depends on it: an agent cannot hand work to a key it has
   never seen, and one that cannot *look* would report a gap for a craft that
   has been on the roster since March. **It names the route as well as the
   craftsman** (`RosterMatch.through`): a match that is not your report but
   sits under one of them says so, because otherwise an executive searching for
   "website audit" is handed a specialist four rungs down with no road to it but
   `handOff`, of which every task gets two. That is what a whole-floor run did —
   the Chief Executive tried three specialists, was told each time that they do
   not report to it, converted them to sideways hand-offs, spent both, and never
   asked the three directors who own those lanes and to whom it may delegate as
   often as it likes.
2. **`consult`** — ask a colleague one question and get the answer back inside
   this task. **Deliberately one model call and no tools**, not a nested agent
   run: a consult that could call tools would be a second agent working the same
   task at once, which is the thing "one agent, one task" exists to prevent, and
   it could spend money the asking agent never budgeted for. The colleague
   answers from *its own* prompt layers and *its own* recalled memories of this
   lead — which is the entire value, and is asserted in `tmp/collaboration.ts`
   with a shibboleth planted in the colleague's prompt. Capped at
   `MAX_CONSULTS` (3).
3. **`handOff`** — the work itself is somebody else's craft. Goes *sideways*
   where `delegate` only goes down, so it demands a `why` that lands on the
   brief and on the timeline. Capped at `MAX_HANDOFFS` (2): a task with three
   craft pieces in it was somebody else's brief from the start, and the honest
   answer to that is an escalation.
4. **`needSkill`** — only when `findAgent` found nobody. This is the road to the
   Agent Creator, below.

A consult's answer is put in front of the asking agent as **an opinion, not a
checked fact**, with the standing rule that the record in front of it wins. Two
agents agreeing with each other is not evidence.

**The workforce hires itself, and no model can** — `agents/hiring.ts`,
`routes/slack.ts`, the `people.recruiter` seed. Three steps, and keeping them
apart *is* the safety story:

```
needSkill          AgentGap            Agent Creator       AgentHireRequest    Agent
an agent says   →  demand, counted  →  reads the gap,   →  a design waiting →  the row
"nobody here       per craft           checks the           on a decision       (only
 can do this"      (timesRequested)    roster first                             applyHire)
```

- **`agent.hire` files a request. It never creates an agent.** `applyHire()` is
  the only thing that writes to `Agent`, and it is reached from a signed Slack
  interaction, an authenticated API call, or the AUTO policy — never from a
  model. An agent that could write that table could grant itself any tool in the
  catalogue by hiring a copy of itself with a wider toolkit, and no prompt
  wording reliably prevents that. So the wording is not what prevents it.
- **A gap is demand, and demand is counted before it is met.** A second agent
  asking for the same craft joins the existing row and bumps `timesRequested`
  rather than opening a second one; `requestedByKeys` is the set, so the same
  agent asking twice does not count twice. One agent's frustration is a bad
  reason to employ somebody permanently; three agents on three different jobs is
  a good one, and that fact only exists if the requests land together.
- **The loop closes.** A blocking `needSkill` stops the task at `BLOCKED` with
  its checkpoint kept. When a hire is approved, `nudgeWaitingTask()` appends the
  new agent's name to *both* the brief and the conversation it will rejoin, and
  requeues it — the same mechanism, and the same reason, as
  `appendOwnerAnswer()`. Without it a filled gap is a new agent nobody thinks to
  use and a blocked task that stays blocked.
- **The Agent Creator's real job is the refusal.** The easy answer to every gap
  is yes, and forty agents each doing a third of somebody else's job is worse
  than the nine crafts this started with. `findOverlaps()` puts "this is 75% the
  Video Editor" on the card, and `agent.closeGap` — which names who *should*
  have taken the work, and tells the agent that asked — is expected to be the
  common outcome.
- **The overlap threshold was tuned against real proposals, not chosen.** At
  `score >= 0.25` a proposed Bookkeeper was flagged as 27% the Proposal Writer
  on the single shared word "invoice". It is now `shared.length >= 2 && score >=
  0.4`, at which a genuine second Cold Lead Writer still scores 85%.
  `tmp/overlapCheck.ts` holds both halves: the duplicates that must warn and the
  honest new crafts that must not.
- **The guards all refuse at proposal time**, so what reaches a person would
  work if they said yes: a key already taken or already proposed, a manager that
  does not exist, `agents.maxCustomAgents` (25), `agents.maxHiresPerDay` (3) and
  `MAX_PENDING` (5) waiting. **Zero is a value in those ceilings, not an
  absence** — setting one to zero is the obvious way to stop hiring, and the
  usual `parsed > 0` guard would silently restore the default instead.
- Pending requests **expire after 72 hours** rather than sitting for ever,
  because pending requests are counted: five forgotten ones would stop the Agent
  Creator proposing anything at all with nothing on screen to say why.

**ASK or AUTO, and it is answered from Slack** — `agents.hirePolicy`.

- **ASK** (the default) posts the design to Slack with Approve / Decline /
  "approve these automatically from now on". **AUTO** creates it there and then
  and posts the same card with an Undo on it instead. `/dakyworld hiring
  auto|ask` changes the standing setting, because the moment somebody wants to
  change it is the moment they are reading a hiring card, not the moment they
  are looking at a Settings screen.
- **The policy sits under dry run, not beside it.** An agent in dry run decides
  nothing, so AUTO only comes into play once the Owner has taken the Agent
  Creator out of it. **AUTO decides who exists; it never decides what they may
  do** — every hire lands at autonomy 1 with dry run on whichever way it was
  approved.
- **A hire lands ACTIVE where `POST /agents` lands DRAFT, and that is not an
  inconsistency.** Filling in a form is not by itself a decision to employ
  somebody. Clicking Approve on a card that says *hire this* is, and making
  somebody then find the agent and switch it on turns one decision into two, the
  second of which is invisible and gets forgotten.
- **Slack must never be the only road.** A workspace nobody connected, a signing
  secret nobody pasted, an app somebody removed — each would otherwise mean
  proposals nothing can approve, and the symptom would read as the agent not
  working. `GET`/`PUT /agents/hiring/policy`, `/agents/hiring/gaps`,
  `/agents/hiring/requests` and the panel at the top of the Agents screen do
  everything the buttons do.

**Slack talks back now, and one thing guards it** — `routes/slack.ts`,
`verifySlackRequest()`. Every payload carries an HMAC over the exact bytes sent
plus a timestamp, so the router is mounted **above the JSON parser** in
`index.ts` for the same reason the two webhook routes are. Four rules:

- **An unconfigured Slack refuses everything inbound**, which is the opposite of
  the outbound rule and the right way round for each: failing to *send* an alert
  must not break the work, and failing to *verify* a click must never approve a
  hire.
- **Replay matters here**, so a payload more than five minutes old is refused
  however well it is signed.
- **The signature proves it came from Slack, not that the clicker may decide.**
  `slack.approverIds` is the second check. Blank means anybody in the channel —
  right for a one-person company, wrong the day somebody else joins it.
- **Acknowledged first, worked afterwards.** Slack retries anything it does not
  hear from within three seconds, and a retried Approve would be a second agent
  — so `applyHire` is idempotent about an already-approved request rather than
  throwing, and `tmp/slackButtons.ts` asserts that a re-delivery creates nothing.
- **Acknowledge before opening a dialog, then exchange the trigger immediately.**
  Both the acknowledgement and `views.open` have a three-second deadline.
  Waiting for the API response before acknowledging makes a slow modal look
  like a failed click. Submissions validate permissions and empty input inline,
  then replace the form with a processing view. `views.update` shows the actual
  outcome, including refusals, instead of closing a dialog on an unsaved answer.
  Slash commands also acknowledge first and return results via `response_url`.
  `checks/agentSlackCommunications.ts` covers slow modal calls, result delivery,
  stale answers, and status totals beyond the five displayed examples.

**An agent that stops and asks is heard now** — `agents/escalationCards.ts`,
`agents/escalations.ts`. `escalate` wrote `BLOCKED` to a row and nothing else,
so the most important thing an agent ever says reached no channel and no
notification: an escalation was indistinguishable from an agent that stopped.
`finishTask` is the one funnel, so the card is posted from there — for BLOCKED
and FAILED only, and only when *this* run is the one that ended it, since a run
overtaken by the reaper must not announce an outcome it did not write.

- **The card carries the agent's own choices as buttons.** `escalate` puts them
  on the `BLOCKED` step, and the commonest answer — "the second one" — should be
  one tap rather than a sentence typed on a phone. "Answer…" opens a dialog
  where there is a bot token, and every card also prints
  `/dakyworld answer <id> …` with the id filled in, because that is the only
  road that works on a webhook-only workspace.
- **One answer, everywhere** — `recordOwnerAnswer()`. The browser route and the
  Slack buttons were two copies of "append to the brief, rejoin the
  conversation, requeue", and the third thing neither did was rewrite the Slack
  card. That is what *"I decided and nothing happened in Slack"* actually was.
- **A webhook post is still recorded as posted**, under a `webhook` sentinel
  channel, because a webhook reports neither a channel nor a message id.
  Without it `settleTaskCard` cannot tell a question that was never posted —
  where announcing an answer would be shouting at a channel that never saw it —
  from one sitting on the wall with live buttons under it.
- **A rehearsal is silent, and failures are capped; escalations never are.**
  Nine agents rehearsing against one company would be nine questions about work
  that is not real. Failures arrive in weather — a vendor going down fails
  everything at once — so four cards in ten minutes and the rest are left to the
  Agents screen. A question is always worth interrupting somebody for.

**A prepared call says which gate stopped it.** `permissionFor` returns no
reason when the *caller* asked for the dry run rather than the agent's card
forcing it — which in a rehearsal is the guarantee itself — so the one call the
feature exists to hold came back unexplained, and the screen filled the silence
with the wrong answer: it labelled every prepared action "would have left the
building", including internal research an agent simply was not allowed to run.
`heldBecause` is never blank now, the rehearsal floor is named ahead of the
card's reason because it binds whatever the card says, the reason reaches the
agent too (the Website Auditor, held by its own autonomy level, reported its
audit as "pending a person's approval"), and the screen separates the two using
the catalogue's `outward` flag rather than sniffing the sentence.

**A rehearsal's prepared actions are specimens, not proposals.** Every outward
call a rehearsal previewed was filed as a live `ActionRequest`, counted in the
pending badge, and posted to Slack with a working *Approve — do it* button —
and approving one re-invokes the tool for real, against the real business the
rehearsal was pointed at. They are still filed, because the rehearsal screen
reads them back; `ActionRequest.rehearsal` keeps them out of `listRequests`,
`countPending` and the card, and `approve()` refuses one outright as the last
guard rather than the only one.

**Whether Slack works is now a thing the app can answer** —
`services/slackHealth.ts`, `GET /api/settings/slack/health`, the panel under
Settings → Alerts. *"When I decide, nothing happens in Slack"* is the single
symptom of five unrelated faults, four of which left no trace anywhere the
Owner could see: nothing connected; **a bot token with no default channel**, so
every card is built and none is posted inside a `catch` that logs and returns
false; a bot never invited (`ok: false` on a 200); no signing secret, so cards
appear and every button on them is refused with a 503 nobody sees; and
Interactivity never switched on, so the click goes nowhere at all.
`verifySlackRequest` now records every inbound verdict — the last one that
verified and the last one that did not, with its reason — because a verified
request is the *only* proof the wiring is right, and `/dakyworld ping` exists to
produce one on demand. The health read never posts: a check that puts a message
in the channel every time somebody opens Settings is a check that gets turned
off.

**A sixth fault the health check could not have named, and the queue that ended
it** — `services/slack/queue.ts`, `services/slack/worker.ts`, the delivery table
under Settings → Alerts. Every setting can be correct and a message still never
arrive, because Slack was rate-limiting, restarting or holding a token somebody
revoked during the ninety seconds it was sent in. Outgoing notifications used to
be a bare `fetch` inside the code that had something to say, so that message was
gone and the only record it had ever been meant to exist was a line in a log.

A notification is now a row first and a request second:

- **Written before it is sent.** `enqueueSlack()` is one insert. It cannot fail
  because Slack is down, and it is safe to call from the middle of a task doing
  something more important.
- **`idempotencyKey` makes enqueueing idempotent**, which is what lets a boot
  pass re-raise every open escalation without asking whether it already did.
- **`orderKey` + `seq` keep one card's messages in order**, because an answer
  arriving before its own question is the worst thing a queue like this can do.
  `coalesceKey` is the other half: a question still waiting to go out when its
  answer lands is *replaced* by the answer rather than posted and immediately
  corrected. Rows already `SENDING` are never coalesced — a request on the wire
  cannot be recalled, and pretending otherwise would make the status a lie.
- **The lease is `runTask`'s claim, one table across** — a conditional
  `updateMany` plus a `leaseOwner` of the same shape as `runOwner`. No Redis, no
  second service. The candidate query is raw SQL because "the earliest unsent
  message per order key, but only if nothing earlier is still in flight" is a
  correlated `NOT EXISTS` the Prisma query API cannot express.
- **Three outcomes, not two.** Permanent failures (`invalid_auth`,
  `channel_not_found`, `missing_scope` — `isPermanentSlackError`) stop at once
  rather than backing off for a day against a setting only a person can fix.
  Transient ones back off with jitter and honour `Retry-After`. And a request
  that left and never answered is recorded **UNCERTAIN and never retried
  automatically**: an aborted `chat.postMessage` may well have posted, and
  retrying asks for the same decision twice.
- **The worker has its own five-second interval**, not the scheduler's minute.
  A capture starting fifty seconds late is nothing; a card appearing a minute
  after somebody pressed the button has already sent them back to the app.
- **`slackTs` is written back inside the same transaction as the status flip.**
  A delivery marked delivered whose subject never learned the message id is
  worse than one that failed, because the card can then never be settled and
  nothing will try again. `POSTED_BY_WEBHOOK` survives the move for the same
  reason it existed: it is how a webhook-only transport records that a question
  reached a wall somewhere.

All of it sits behind `flags.slackQueue` (`lib/featureFlags.ts`), so the direct
path is a setting away rather than a deploy away. `checks/slackQueue.ts` drives
the real worker against a local stub — no network, no token, no workspace.

`/dakyworld` also answers `status`, `tasks`, `answer` and `approvals`.
`status` counts NEEDS_APPROVAL tasks separately from the approval queue —
only outward and spending previews become cards, so a task holding a prepared
write is work waiting on a person with nothing in the queue to represent it.

`checks/slackEscalations.ts` (51) is the committed half: it signs payloads with
the app's own secret and drives the real router over real HTTP, and plays the
incoming webhook on the same local express, so both directions run with no
network and no credential. Half of it is negatives — an unsigned request, a
wrong secret, somebody not on the approver list, a re-delivered click, a
rehearsal that must post nothing, and an escalation that must still be posted
during a run of failures.

**Memory is recalled by subject, not by similarity.** `agents/memory.ts` files
a memory against `lead:abc`, `client:xyz` or `self`, and recall returns only
what this agent concluded about the subjects this task is about. An embedding
search would occasionally surface a fact about a different client in the
context of this one, and the failure mode of that is a letter to the wrong
company. `findSecret()` refuses to store anything credential-shaped — a memory
is re-read into a prompt every time its subject comes up.

**There are two scopes and only one is private.** An `AGENT` memory is one
agent's own. A `SHARED` one belongs to the company: `agentKey` is null so it
outlives its author, `authorKey` records who concluded it (`owner` for one a
person typed), and every agent is shown it. **Sharing widens who sees a
memory, never when it comes up** — recall is still by subject, so a shared
fact about one client surfaces only on tasks about that client. `company` is
the shared equivalent of `self` and is recalled on every task. The two are put
in the prompt under separate headings because they carry different authority:
an agent's own conclusions lose to the record in front of it, a house rule
does not. Shared memories get a point of importance in the recall ranking but
not in the stored row, and `pruneMemories()` never sweeps them.

**Agents come in two kinds.** The nineteen management agents recommend and
decide; the thirty-one `SUB_AGENT` specialists make things — Web Developer,
Graphic Designer, Video Editor, Ad Designer, Proposal Writer, Cold Lead Writer
and the rest, each with `skills` (a client's words, matched by a router)
separate from `toolkit` (a permission). Both kinds seed at autonomy 1 with dry
run on, and the create route cannot say otherwise.

**A prompt is a document with parts, and every agent works the same four
passes** — `METHOD` in `agents/runner.ts`, `LAYER_HEADINGS` in
`agents/authored.ts`, and the `process` layer of all 51 seeds, rewritten
29 Aug 2026.

This is the other half of putting free models first. A strong model reads a
paragraph of craft doctrine and *infers* the procedure — look at the record
before deciding, put a source under a figure, re-read a draft before handing it
over. A weaker one does the thing the paragraph talks about and skips the
procedure nobody wrote down, and the failure reads as carelessness rather than
as a missing instruction: an agent that answered from the brief without opening
the record, a number with nothing under it, a letter nobody checked. Every agent
turn now starts on a free model, so the procedure has to be written down.

- **`METHOD` is four named passes — Establish, Decide, Produce, Verify — given
  to every agent, seeded or hired**, as its own labelled region of the prompt.
  Four rather than ten because a list long enough to be complete is a list a
  model skims. It says **nothing** about tools, escalation, memory or who to
  ask: all four already have paragraphs in the working region, and a prompt that
  says the same thing twice in two sets of words is how a model ends up
  averaging two instructions into neither.
- **The ten layers are joined under headings now**, not as ten anonymous
  paragraphs in which the rule about money, the definition of finished and the
  description of the craft all look alike. It costs about thirty tokens and it
  is what lets `METHOD` say "one finished thing, of the kind named under *What
  you produce*" and have that mean something. The words are untouched; this is
  layout.
- **Every seed's `process` is an ordered workflow**, numbered, ending where the
  craft ends rather than trailing off. The judgement that was already in them is
  kept sentence for sentence — it was the good part — and what was added is the
  order, the first step naming what to read, and the step that was missing.
  `outreach.writer` and `outreach.followup` are deliberately untouched: their
  `process` is the shipped outreach doctrine, rebuilt from the skill libraries
  on 22 Aug at the founder's instruction, and it is prose for a reason.
- **Nothing needed a migration.** `refreshUneditedSeedPrompts()` runs on every
  boot and carries a changed seed onto any agent whose wording the Owner has not
  rewritten — 48 of the 51 on the first run, with the other three unchanged.

**One agent, one job — one *deliverable*, not one department.** Applied to the
whole roster in Aug 2026, which is where eighteen of the specialists came from.
The Lead Lifecycle Manager was told to "capture, enrich, score, qualify and
route"; Commercial Operations wrote proposals, raised invoices *and* chased
payment; Business Intelligence was four analysts in one prompt. An agent
holding three jobs has one prompt that must describe all three, one toolkit
that is the union of all three, and one memory in which what it concluded about
chasing an invoice is recalled while it is writing a proposal — three separate
ways of being worse at each. The test for anything added: **does this produce
more than one kind of finished thing?** A cold email and a LinkedIn message are
one thing in two wrappers; a proposal and an invoice are two things.

`narrowSeededAgents()` is what carried that split onto a database that already
had the old wording. It runs **once** (`agents.oneJobPass`), only over the
fourteen agents in `NARROWED`, **skips any agent whose prompt the Owner has
rewritten** (`promptEditedAt`), and **never touches a toolkit** — it prints the
tools an agent no longer needs and leaves the untick to a person, because
revoking a grant silently is invisible until the day something cannot be done.

**`ensureAgents()` only ever creates, which cuts both ways.** A new seeded
agent — `design.ux` and `sec.analyst` arrived with the audit team — appears on
the next deploy. A new *tool* added to an existing agent's `toolkit` does not:
the row is already there, so `audit.website` and `audit.read` have to be ticked
by hand on the Agents screen for the SEO Specialist, the Copywriter, the Web
Developer and the Cold Lead Writer. Check that before concluding an agent
cannot do something.

**The workforce is commissioned, once, and the shipped defaults are still what
a new agent arrives on** — `commissionWorkforce()` in `agentRegistry.ts`,
`COMMISSIONED_AUTONOMY` (2), `POST /agents/commission`. An agent ships DRAFT at
autonomy 1 with dry run on, which is three separate ways of doing nothing:
`runDueTasks` claims nothing for a draft, autonomy 1 holds every outward and
spending call at a preview, and dry run holds every *internal* write there too.
Each is the right default for an agent nobody has looked at. All three on all
fifty-six is a roster with an empty timeline and no error anywhere to explain
it — which is what a deployment nobody clicked through actually was.

- **Level 2 is what makes "switch the workforce on" and "approve everything
  that leaves the building" the same setting** rather than opposite ones. It is
  below both `EXECUTE_LEVEL` (3) and `SPEND_LEVEL` (4), so 46 of the 72 tools
  do real work and **not one outward or spending tool acts unsupervised** —
  each is held, files an `ActionRequest`, and posts to Slack with an Approve
  button that carries it out exactly as prepared. Walked over the whole
  catalogue in `checks/commissioning.ts`, not a sample, because the failure
  worth catching is a tool added next month whose flags nobody checked.
- **It only ever touches an agent still in the state it shipped in.** Any other
  combination is a decision somebody made: a paused agent stays paused, a
  retired one stays retired, one already raised to 4 keeps 4, and one switched
  on and deliberately left at level 1 is left there. It never lowers anything.
- **It runs once ever, behind a marker**, exactly as the one-job split does. A
  pass that reasserted this on every boot would switch a paused agent back on
  every time somebody deployed, which is the one behaviour that would make
  pausing useless. `POST /agents/commission` re-runs it for agents that arrived
  later — a hire lands ACTIVE at autonomy 1 with dry run on, so it is asleep in
  the two ways that are left — and is bound by the same rule.
- Every move is written to `AgentAutonomyChange` with the actor
  `commissioning`, because "who put this agent on level 2" has to have an
  answer.
- **The boot log says whether a decision can actually reach anybody.** This
  matters more since commissioning: before it, an unreachable Slack was one of
  several reasons nothing happened; now the approval queue is the only thing
  between prepared work and a customer, so an unconfigured Slack is a queue
  filling up silently while every screen says the agents are fine.
  `slackHealth()` knew all of it already and only the Settings screen ever
  asked.

**Six of the seven agents the mail room routes to could not read the letter.**
`inbox.read` and `inbox.handled` were in `mail.room`'s seed and nobody else's,
so a routed task began with the agent unable to open the message it was raised
about. Documented here for months as a live-database migration gap; it was
wrong in the *seeds*, so a fresh deployment had it too. Fixed there, which
means `reconcileSeedToolkits()` grants it on every existing database at the
next boot.

**An agent is not sent a tool it could not possibly use** —
`workflowAvailability()` in `runner.ts`. Measured against the real roster, a
turn costs ~5,430 tokens before anything happens: 2,482 of system prompt and
2,948 of tool schema, of which the agent's *own* granted tools are 711 and the
nine workflow tools are 2,118. The scaffolding for asking a colleague is three
times the weight of the job, and part of it is provably dead before the turn
begins: `addToHistory` and `readHistory` both refuse when the task is not about
a lead, a client or a project, `consult` refuses once the allowance is spent,
and `handOff` once `MAX_HANDOFFS` are gone.

- **The prompt is built from the same answer as the tool list**, and that half
  is the one that matters. A prompt naming a tool that was not sent spends a
  whole turn on a call that cannot resolve, which costs several times the
  schema it saved. The routing ladder is renumbered rather than left with holes
  in it — "stop at the first step that answers" is an instruction about an
  ordered list, and one running 1, 2, 4 invites a model to go looking for 3.
- **`findAgent` and `needSkill` are never pruned.** An agent that cannot look
  reports a gap for a craft the roster has had since March, and `needSkill` is
  the only road to the Agent Creator.
- **Stable for the length of a run**, because `toolsFor` is called once per
  claim, before the loop — which is what keeps the cache breakpoint on the last
  tool definition valid from the first turn to the last. A resume recomputes it
  from the restored counters, which is when the saving is largest.
- Worth 516 tokens a turn on a task about no record, 601 on a resumed one, and
  1,117 on both — every turn, every task, every agent.

**An approved letter can be asked for twice and go once.** `approve()` carries
work out through `invokeTool` like anything else and passed no
`idempotencyKey`, so the executed `ToolCall` carried a null one and the replay
guard could not see it: the task that prepared the letter could be resumed at a
higher autonomy and send it again, and a duplicate card approved twice was two
letters. `outwardKey` now lives in `services/tools/idempotency.ts` and both the
runner and `approvals.ts` import it — deriving it twice would be one edit away
from two different hashing rules, which is the failure this codebase already
had over `vendorBase`. Only where there is a task to scope it to.

**Every agent check now seeds the roster it asks about.** `checks/roster.ts`
seeded two thirds of the way down while the section above it edited an agent's
wording and asserted the edit reached the deliverable — so on a clean database
there was nothing to edit and all twenty-one of those assertions reported the
shipped wording as a failure of the writer layer. `checks/rehearsal.ts` asked
whether every scenario's starting agent was on the roster and nothing in it
created one. Both were green on the second run of the day and red on the first.
**A check that only passes against state a previous run left behind is a check
nobody can read a new failure out of** — the same lesson `checks/roster.ts`'s
own reconcile section carries a comment about.

Five committed check files cover this module now, all database-only:
`commissioning.ts` (34) walks the gate at the commissioned card over the whole
catalogue; `agentToolBudget.ts` (46) holds the pruning to never removing a
capability and never naming an absent tool; `agentCollaboration.ts` (37) runs
`findAgent`, `delegate`, `handOff`, `needSkill` and `consult`'s refusals
against the **real seeded roster**, because the failure worth catching is a
rename; `slackApprovals.ts` (48) drives the whole approval loop over real HTTP
with signed payloads against the router mounted as `index.ts` mounts it; and
`commissionedRun.ts` (16) is one real `runTask` against a local model stub
proving all five mechanisms at once — the claim, the gate, the queue, the card
and the finishing state.

**Every agent's wording is editable, including a seeded one.** That was not
true until Aug 2026 — the API refused to rewrite a built-in agent on the
grounds that shipped wording is a diff, which left the Owner editing
TypeScript or hiring a duplicate agent to say the same job differently. A
prompt is the instruction, so it is theirs. `ensureAgents()` only ever
creates, so an edit survives every deploy; a rewritten seeded agent carries
`promptEditedAt`, and `POST /agents/:key/prompt/reset` puts the seed's wording
back. **Reset never touches the toolkit, the autonomy level or dry run** —
what an agent is told to do and what it is allowed to reach are different
decisions. An edit lands on the agent's next task, because `runner.ts` reads
the row rather than a cache.

**One agent takes one task at a time.** `MAX_CONCURRENT` is the process
ceiling; the per-agent ceiling is one, enforced in the claim itself as a
relation filter (`agent: { tasks: { none: { status: "RUNNING" } } }`) so two
processes cannot both win. The reason is memory as much as legibility: an
agent writes what it concluded as it goes and reads it back on the next task
about the same subject, so two tasks about one lead running side by side
interleave those writes and the agent contradicts itself with nothing in the
timeline to show why. **This makes a stranded `RUNNING` row block its agent
entirely**, which is why `reapAbandoned()` runs on every tick and requeues
anything whose heartbeat has been quiet for five minutes that no live process
owns.

**A run survives the browser, the deploy and the stop button**
(`agents/checkpoint.ts`, `AgentTaskCheckpoint`). `POST /tasks/:id/run` was
always fire-and-forget, so a closed tab never stopped anything; what was lost
was everything else. A task is up to sixteen model turns with tool calls in
them, and a deploy landing mid-task threw all of it away and began again from
the brief — research repaid for, an audit re-run, the same first email drafted
twice. Now the loop hands its whole state out after every model turn **and
after every single tool call**, and a claim with a checkpoint on it rejoins that
conversation instead of starting one.

- **The half-finished turn is the part that matters.** A turn asking for three
  tools with two already run is where a crash is most dangerous, because
  "again" for `email.send` means the prospect gets the letter twice.
  `pendingAssistant` and `pendingResults` hold that turn *outside* `messages`
  — an assistant turn with only some of its results after it is not a
  conversation the API will accept — and a resume runs only the calls that
  genuinely never happened.
- **The iteration cap counts across resumes**, or a task interrupted five times
  gets five times the budget. `attempts` works the other way: it resets on any
  run that *progressed*, so the cap catches a task that keeps dying in the same
  place rather than one that keeps meeting deploys.
- **Every checkpoint write proves ownership** (`runOwner`, matched in the
  update) and touches the heartbeat in the same statement. A process reaped as
  dead that later wakes up finds its token replaced and stops rather than
  writing its stale conversation over the run that took over.
- **A RUNNING task can be stopped now.** It used to answer "it cannot be
  interrupted safely", which was true of a loop that checked nothing and kept
  no place. `interruptRequested` is read between iterations and between tool
  calls — the two points where the conversation is whole — so a stop is a pause,
  and the task returns to QUEUED with its place kept. SIGTERM does the same
  thing to every run at once (`drainRunningTasks()`), and `resumeInterruptedTasks()`
  hands back on boot whatever did not make it.
- **Answering an escalation appends to the conversation, not just the brief.**
  Without `appendOwnerAnswer()` the agent resumes at the moment it asked its
  question, having never been told the answer, and asks it again.
- DONE and NEEDS_APPROVAL clear the checkpoint; BLOCKED, FAILED and CANCELLED
  keep it, which is what makes "Carry on" mean carry on. `pruneCheckpoints()`
  sweeps them after 30 days.

**"Start the day" moves the time, and only the time** —
`services/agents/startTheDay.ts`. Every ceiling still applies and a draft
agent stays asleep, which the doc has always said. What it also did was wake
**every** QUEUED task with a future `scheduledFor` — and two different things
wear that column: a task `retry.ts` put down for five minutes on a rate limit,
and a task the Owner scheduled for Tuesday through `POST /agents/:key/tasks`.
Pressing the button on Monday started Tuesday's work with nothing anywhere
saying so. `retryReason` separates them, because `retry.ts` is the only thing
that writes the pair; it is the same predicate `isPaused` reads, and
`routes/agents.ts` imports that rather than writing its three conditions out a
second time. `checks/startTheDay.ts` covers it.

**A business the judge could not be asked about is not a business that was
judged** — `huntReport()` in `services/hunt/run.ts`. The `catch` around
`judge()` is right and stays: a lead must never be deleted because a model was
down, so it keeps its place with no verdict against it and the next hunt looks
again. What was wrong is that it `continue`d silently while `audited` stayed at
the whole batch, so five looked at with three judge calls thrown came out as
"Looked at 5. 0 fit, 2 did not" and status SUCCEEDED — a vendor down for an
afternoon reading exactly like a thesis nobody qualifies under. Those three are
counted, named, excluded from `audited` so the three numbers add up, and the
run is PARTIAL. **UNDECIDED is not the same thing**: that is the judge running
and finding the evidence will not answer the question, which is a verdict about
the business and was audited. The reporting is its own function because
everything above it in `cycle` needs Apify, a screenshot and a model, and this
needs nothing.

**`trimToFit` measures before it copies** — `services/agents/checkpoint.ts`.
It runs after every model turn *and* every tool call, so a sixteen-turn task
pays for it fifty-odd times, and it was deep-copying and serialising a
conversation that may be three megabytes before establishing there was nothing
to do — then re-serialising the whole thing after every block it trimmed. A
JSON document is the size of its parts, so a trim's saving is subtracted from a
running total instead. Measured on a 40-turn conversation: 4.0ms → 1.7ms under
the ceiling, 118.8ms → 18.4ms over it. The copy is made only when something is
about to change, because the caller's `messages` is the live conversation the
loop is still turning — asserted in `checks/conversationTrim.ts`.

**Two sweeps were written and put on nobody's schedule**, both on the daily
housekeeping tick now. `pruneMemories()` matters because recall has a ceiling
of 24 per task, so an agent's memory that nothing has ever pulled up does not
sit there harmlessly — it takes the place of one that would have been useful.
Only an agent's own weakly-held, never-recalled conclusions older than six
months; a shared memory is never swept, because "nothing has come up about it"
is not evidence a house rule stopped being true. `refreshStaleServers()` says
*"fire-and-forget from a route"* in its own doc and no route fired it, so a
connected MCP server's advertised tools were read once and never again.

**The unused per-call spending setting has been removed.** `maxCallSpend()`
was never invoked and `agents.maxCallUsd` had no settings route. Keeping them
suggested a guard that did not exist. Task and other enforced budgets remain;
a future per-call guard needs structured pre-call estimates before it can
promise a limit.

**One id gathers a run** — `traceId` on `AgentTask`, stamped on every
`ToolCall`, `LlmCall` and `AgentTaskTransition` it causes. Every one of those
facts was already being written down and none of them joined up: `ToolCall` had
no `taskId` though `invokeTool` has always been handed one, `LlmCall` had only a
free-text `purpose`, and `AgentTaskStep.toolCallId` was documented in the schema
as the link between the timeline and the audit trail and was **never once
written**, because nothing gave the id back. `invokeTool` returns `callId` now
and the runner puts it on all four step branches.

**Attribution is ambient, and only attribution** — `lib/runContext.ts`, an
`AsyncLocalStorage` the runner enters once around the whole task. A writer
inside a tool handler inside the loop is four frames from anything holding a
task id, and threading one through forty signatures is forty chances to forget.
An explicit argument always wins over the store, which is what stops an approval
executing weeks later from inheriting whatever happens to be running in the same
process. **Nothing in it decides what is allowed** — the grant is still read
from the `Agent` row inside `permissionFor`, because ambient state that changes
permissions is state nobody can review at the call site.

**A task's status has one writer** — `transition()` in `agents/state.ts`. It was
ten: the claim, the reaper, the interrupt, the boot resume, the rate-limit
requeue, two routes, the hiring nudge and `finishTask` twice. Each was correct
alone; together they were a state machine nobody had written down. `ALLOWED`
declares the legal moves, an undeclared one throws, and every move that happens
lands in `AgentTaskTransition` with a reason and an actor.

- **Returning `moved: false` is not an error.** Losing a claim race is normal,
  and so is a slow run finding that the reaper requeued its task — which is why
  `finishTask` passes `expect: ["RUNNING"]` and warns rather than writing its
  outcome over the run that took over.
- **No terminal state reaches another directly.** Rewriting an outcome in place
  is how a run that never happened comes to read as work that did; going back
  through QUEUED means the history shows the re-run. `NEEDS_APPROVAL → DONE` is
  the one exception, because accepting prepared work is a decision about the
  same run.
- **Token counts come from the `LlmCall` ledger, not the checkpoint.** The
  checkpoint is deleted for DONE and NEEDS_APPROVAL, so it could only ever
  answer for runs that failed — and a task short enough never to save its place
  does not write one at all.
- **And so does the money** — `spendOn()`, both ledgers, at every ending. It
  was passed in by the caller, which was wrong in both directions: the two
  `catch` paths passed a literal zero, so a task that had spent three dollars
  and then met a broken vendor wrote $0.00 beside truthful token counts on the
  same row; and the success paths passed the agent loop's own tally, which
  counts only the turns the loop itself took, so every model call inside a tool
  handler — a writer, a consult, a sub-analyst — was billed to nobody.
  `ToolCall.costUsd` is in the sum too: an Apify run is money against a ceiling
  exactly as a model turn is. `AgentTask.costUsd` is not decoration — the
  Agents screen totals thirty days of it and `rehearsals/run.ts` sums it
  against a budget — and the same sum enforces the task's own ceiling in
  `shouldStop`, so a run cannot be stopped at one number and recorded at
  another. `backfillTaskCosts()` corrected the rows written before this, once,
  marked by `agents.costBackfill`.
- **Nothing outside the task is charged to it.** Three faults shared that
  shape and all three are in `checks/agentSpendAndOutages.ts`. A 429 skips
  `retry.ts`'s answerable-phrase sweep entirely, because the message carries up
  to 300 characters of the vendor's own prose and both a free-tier day limit ("Add 10
  credits to unlock…") and Google ("Quota exceeded for quota metric") say one
  of those words inside a plain rate limit — the two likeliest failures here
  were blocking the task and posting an escalation card for a limit that clears
  in five minutes. A consult whose model call fails spends no consult and is
  written to the timeline as a failed step, so `priorConsult` cannot hand the
  error back as that colleague's opinion for the rest of the task, and
  `reconcileCounters` skips it on resume rather than charging for it there
  instead. That skip is spelt `OR: [{ ok: null }, { ok: true }]`: `ok` is
  nullable and `step()` writes null unless told otherwise, so `ok: { not: false }`
  is *unknown* for almost every row and drops the whole ledger.

**An outward tool call can be asked for twice and happen once** —
`InvokeOptions.idempotencyKey`, derived by the runner as
`${taskId}:${tool}:${sha256(input)}` with the object keys sorted, because a
model does not emit them in a stable order. `invokeTool` looks for a
*successful, non-dry-run* `ToolCall` with that key and returns its recorded
output rather than running again. Deliberately narrow in three ways: opt-in
rather than derived in the gate (two identical sends can be two correct sends —
a monthly reminder is the same payload every month); outward tools only (a
repeated read must not return a stale answer); and checked *after* the
permission gate, so a replay whose grant has been revoked is refused like
anything else. `dispatchWebhook` also carries an `X-Dakyworld-Event-Id` now, for
the receivers we cannot dedupe for.

**And so can every other tool, inside the one window where "again" can only
mean a replay** — `InvokeOptions.replayOfLostTurn`, `AgentToolCallMeta` in
`lib/claudeAgent.ts`. Outward-only was the right first narrowing and it left
the larger half of the crash window open: the tools most often lost between a
call landing and the checkpoint saying so are not outward at all. They are the
ones that spend money without leaving the building — a capture run, a homepage
photographed, a section of an audit — and the ones that write a row a person
then finds twice, like `proposal.draft`. Thirteen of the twenty-one tools that
spend are not outward.

- **The window is the turn a resume restored, and nothing else.** The loop
  collects the `tool_use` ids out of `pendingAssistant` before anything runs and
  clears them the moment that turn completes, so every call the model asks for
  afterwards is a fresh decision and is never deduplicated. That distinction is
  the whole design: an agent that photographs a page, changes it and photographs
  it again is doing that deliberately, and a blanket "same arguments, same call"
  rule would hand it the old picture.
- **`meta` is optional and absent means not a replay.** A harness or a route
  driving one tool directly is not resuming a conversation, and defaulting the
  other way would answer a check's first call with some earlier run's output.
- **`delegate` and `handOff` do not go through `invokeTool`**, so they carry the
  guard themselves: on a restored turn, a child task with the same parent, taker
  and title is already theirs and a second one is another agent waking up to do
  work that is done.

`checks/replayGuard.ts` (12) holds all three, and half of it is the negatives —
a deliberate repeat must still run, a call with no run behind it must still run,
and a manager who raises the same title twice on purpose must still get two
tasks.

**A question waiting on a person is read two ways, and they have to agree.**
`blockedTasks()` reads `status`; `openEscalations()` reads `escalationStatus`,
which is written inside `transition()` and is the column the weekly digest and
the close endpoint work from. The migration that added it did not backfill, and
a task already sitting in BLOCKED never transitions again until somebody answers
it — at which point it is written ANSWERED. So the oldest questions in the
system were the only ones the digest could not see, while the Agents screen
listed them the whole time. A backfill fixes the rows that exist and
`WAITING_ON_A_PERSON` fixes the reading, taking a null as pending **only**
alongside BLOCKED: a closed question stays closed, and a task that never asked
anything has no null to interpret.

**Approving a task will not close it while its actions wait.**
`POST /agents/tasks/:id/approve` predates the approval queue, and once the queue
existed the two disagreed: the route wrote DONE while the letter that task had
prepared sat PENDING under Approvals. It answers 409 and names them now.
Deciding the actions is what closes the task.

