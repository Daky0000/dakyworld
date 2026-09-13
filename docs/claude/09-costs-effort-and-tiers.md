# Costs, ceilings, effort and model tiers

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

**What it all costs, and a ceiling on it** — `src/services/costs.ts`,
`src/services/budgets.ts`, `routes/costs.ts`, the `/costs` screen. `llmLedger.ts`
has said since the day it was written that the question the ledger exists to
answer is *"what did this month cost and which feature spent it"*. Nothing
answered it. Every model call had been priced and attributed for months — by
feature, by agent, by task, by trace — and the only way to read any of it was one
task at a time in the agent drawer, one run at a time in a rehearsal, or as a
single number inside `analytics.read`. The screen is entirely read-only
aggregation over `LlmCall` and `ToolCall`, grouped on columns those tables were
already indexed by, so none of it needed a migration.

- **The cache tile is the one worth watching.** The prompt cache went missing
  once for a month: nothing broke, no check failed, every answer was right, and
  the bill was the only symptom. Its denominator is **input + cache reads +
  cache writes**, because all three are input — dividing by `inputTokens` alone
  reports a healthy cache on a run that cached nothing, which is exactly the
  failure it exists to catch. Zero reads says so in amber.
- **Failed, refused and prepared are three different things.** A failure is
  spend (a timeout after the tokens burned costs real money) and is never a
  denominator. A refusal and a dry run are the gate working, and are counted
  apart from a fault — a night when nothing happened looks identical to a night
  when nothing was *allowed* to.
- **A window with none of something says so.** Cost per proposal in a week with
  no proposals is not zero and is not a dash; it is a thing we have no evidence
  about. `costEachUsd` is nullable for that reason and the screen prints "none in
  this window".
- **The outcome ratios share one numerator and do not add up.** Said on the page,
  because attributing each model call to the one business outcome it eventually
  contributed to is much harder than it looks — one research call feeds an email,
  an audit and a proposal — and a made-up allocation is worse than an honest
  ratio because it looks precise.

**A ceiling is `warn → downgrade → approve → pause`, not an on/off switch.**
Lead capture has had `capture.monthlyBudgetUsd` since it could spend and a
rehearsal has had `budgetUsd` since it could fan out; the four model vendors had
nothing. At 50% the screen says so, at 75% the workforce carries on **on the
economy model** (`effortUnderBudget` in `agents/runner.ts`), at 90% spending work
is **prepared for a decision** instead of done, and at 100% nothing new starts.
The middle two are the point: a ceiling that can only stop work is one nobody
dares set low enough to be useful, and both reuse machinery that already exists
rather than inventing a third way for work to be held.

- **Usage is never a stored counter.** It is summed from the two ledgers, which
  are indexed for it. `recordLlmCall` is explicitly allowed to fail silently —
  accounting must not break the work it accounts for — so a counter would drift
  the first time a write failed, and a ceiling that has quietly lost count is not
  a ceiling.
- **Enforced at three points, all of them places where stopping is already
  safe**: the claim in `runDueTasks` (nothing has started, so nothing is
  half-done), the gate in `tools/invoke.ts` for `spends` tools only, and
  `shouldStop` between iterations. **Never inside `callModel`** — stopping
  mid-turn leaves the half-finished turn the whole checkpoint design exists to
  avoid.
- **A read is never held.** Only a tool that spends is gated. A blanket hold
  blinds every agent without saving a penny, which is the mistake
  `rehearsals/policy.ts` argues out at length.
- **A task over its own `budgetUsd` goes BLOCKED, not back to QUEUED.** An
  interrupt requeues, and a task over budget put back in the queue is picked up
  next tick, stopped before it does anything and requeued — once a minute, for
  ever, with nothing on any screen to say why. BLOCKED keeps the checkpoint just
  as an escalation does.
- **Zero is a ceiling, not an absence** — `hardLimitUsd: 0` means stop
  everything on that scope. The usual `> 0` guard reads it as unset, which is the
  same trap `Rehearsal.budgetUsd` carries a comment about.
- **A hard ceiling outranks an approval; a person driving a tool is not stopped
  at all.** Approving a letter is a decision about the letter, not a decision to
  go over budget. `asOwner` skips it like every other check.
- **Nothing is enforced until a ceiling exists**, and a deployment with none
  pays one cached `count()` every thirty seconds for the whole feature.
- `BudgetExceeded` joins `AnalystError`, `ApifyError` and the messaging classes
  as an error whose own sentence reaches the Owner (402), because a fixable
  setting must never render as "Something went wrong".

**A refusal is a third state on the roster screens, and it was invisible.**
`permissionFor` returns `allowed`, `mustDryRun` and a reason; both the Agents and
Tools screens printed the reason **only when `mustDryRun` was true**. So an agent
refused outright — paused, retired, or over a ceiling — rendered exactly like one
that could act freely, and the only symptom was the call failing later. `allowed`
is carried through both rosters now and the sentence is printed whenever there is
one.

**Effort decides the model, not only how hard it thinks** — `lib/claude.ts`.
`callClaude` resolved the model with `defaultModel()` and passed `effort` to the
API as the thinking budget alone, so **every one-shot call in the app ran on the
headline model however cheap the work was**. `modelForEffort` existed and was
wired into the agent loop only, which made the split look finished: a sub-agent
reading a record paid the economy rate while `mailbox/triage.ts`, which asks for
`low` in so many words and runs once per *arriving* message, paid Opus rates on
every one. An explicit `request.model` still wins.

**A job has a tier as well as a vendor** — `models/registry.ts`. `providerModel`
answers "which Gemini"; `modelForJob` answers "how much is reading the post worth
paying for", which is a different question and was not being asked. `triage` and
`organise` ship on the **economy tier** — following a schema, on a job with a
right answer, where nothing returned is read by a customer — and the Owner can
override any job from Settings → AI models (`models.jobModels`, holding only what
differs, like `models.routes`). A model with no published rate is refused on write
and ignored on read: an unpriced model prices at the dearest rate we know of,
which is the safe direction for a ceiling and a terrible place to find a typo.
**A job with no tier declared is `standard`** — named that way round so a job
added later and not thought about costs too much rather than quietly being done
badly.

