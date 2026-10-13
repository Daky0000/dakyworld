# Costs, ceilings, effort and model tiers

> Part of the DakyXTech OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

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
  failure it exists to catch. Zero reads says so in the warning colour.
- **Beside it, the same rate over Claude alone** (`claudeCacheHitRate`,
  `claudeCalls`; rows whose model starts `claude`). Only the Claude SDK path
  sends breakpoints — the chat-completions wire records no cache by decision
  (see [02](02-model-routing-and-cost.md); do not "fix" that 0% by sending
  `cache_control` there) — and the ladder puts every agent turn on a free rung
  first, so the global figure is diluted by every free turn and a broken Claude
  cache moves it a point or two. Null with no Claude calls, exactly 0 (in the
  warning colour) when Claude calls read nothing back. The model table carries
  each model's cache reads and writes for the same reason.
- **"Work that could wait"** (`paidOneShotByPurpose`) is measurement for the
  Message Batches API, which charges half for a request that can wait up to
  24 hours: paid (`costUsd > 0`), succeeded, and outside any agent task (an
  agent turn waits on the one before it), grouped by purpose, top 15, with the
  Claude part and each purpose's share of all model spend. **A candidate list,
  not a verdict** — the ledger cannot tell a writer called from a screen from
  the same writer called by a nightly job. There is no batch path, on purpose.
  The protocol before building one: read this list over 30 days, read each
  candidate purpose's code to see whether anybody waits on it, and check the
  discount, the batch limits and whether structured output, prompt caching and
  thinking behave the same in a batch against Anthropic's current API docs —
  not from memory.
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
nothing. At 50% the screen says so, at 75% the workforce carries on **more
cheaply** — `budgetWantsCheaper` in `agents/complexity.ts` holds a complex task
at standard (dropping its retry `effortFloor` with it), and with routing `off`
talks the legacy `high` effort down to `medium` — at 90% spending work
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
  half-done) and the gate in `tools/invoke.ts` for `spends` tools only. The
  third stop, `shouldStop` between iterations, checks **only the task's own
  `budgetUsd`** — a scope budget reaches a running task through the gate and
  the level cap, not there. **Never inside `callModel`** — stopping
  mid-turn leaves the half-finished turn the whole checkpoint design exists to
  avoid.
- **A read is never held.** Only a tool that spends is gated. A blanket hold
  blinds every agent without saving a penny, which is the mistake
  `rehearsals/policy.ts` argues out at length.
- **A task's own `budgetUsd` is settable** — the give-task form's "Spend
  ceiling (USD)" (`POST /agents/:key/tasks`) and the task drawer
  (`POST /agents/tasks/:id/budget`, gated with Run), $0–$100. Until Oct 2026
  nothing wrote it and a ceiling meant psql. **Zero and null are both no
  ceiling** and both are stored as null — the schema's call for this column,
  the reverse of a `Budget` below. At four fifths `easeOff` in `runner.ts`
  lowers the run one step, once; at the ceiling `shouldStop` stops it. The
  drawer also shows the task's cache reads and writes and `treeCostUsd`, the
  task and everything delegated under it (six levels, a visited set so a
  `parentId` loop answers); `checks/taskBudgetApi.ts` holds all of it, through
  a real `runTask`. `averageCallUsd` and `estimatedToFinishUsd` are per call,
  which since one `LlmCall` row is written per paid turn means per turn.
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
**A model is admitted by a rate** — shipped in the code tables or declared by
the Owner under `models.pricing` (`isPricedModelAsync`); a declared rate is
also what it is billed at, so the guard and the bill agree. One priced model is
refused anyway: `claude-haiku-4-5` stays in the price table for the calls it
served, but `CLAUDE_WITHOUT_EFFORT` refuses it as a choice, because every
Claude request this app sends carries `output_config.effort` and Haiku 4.5
400s on it — which the ladder reads as "hand the work to the next vendor".
That covers every door, not only the job and level pickers: `PUT
/settings/models/anthropic` refuses it with the same sentence
(`whyNotChoosable`), and `anthropic.model` / `anthropic.model.economy` — and
`ANTHROPIC_MODEL` / `ANTHROPIC_MODEL_ECONOMY` in the environment, which nothing
validates — are read through `claudeModelSetting()` in `claudePricing.ts`,
which skips such a pin with one log line and falls back to the shipped model.
Those two settings are what `defaultModel`, `modelForEffort` and the
standard/complex levels' `vendorChoice` fall back to, so a pin saved while Haiku
4.5 was the shipped simple model would otherwise have sent every standard-level
turn to a 400.
**A job with no tier declared is `standard`** — named that way round so a job
added later and not thought about costs too much rather than quietly being done
badly.

**An agent task has a level as well** — `services/agents/complexity.ts`, 9 Oct
2026. The router sits between a claimed task and `runAgentLoop` and sizes it
simple, standard or complex; the level picks the paid model on every vendor of
the floor (`TIER_MODELS` in registry.ts) and the effort with it. Free NVIDIA
rungs still serve first. Four stages, first answer wins:

1. **Fixed answers.** `AgentTask.levelOverride` (the Owner's call, per task, from
   the give-task form or the task drawer — `POST /agents/tasks/:id/level`). A
   **resume reuses the stored `level`** — one conversation is not split across two
   judgements, and a model change is a cache miss. **A retry after a failed run
   raises effort before it raises the model** (the Owner's rule): the first
   retry keeps the level — so the model and its warm cache — and thinks one step
   harder (`effortFloor`, low → medium → high → xhigh → max); a second failure in
   a row comes back **one level up**. A complex task has nowhere further to go,
   so it keeps thinking harder instead, to max. **So the level no longer always
   fixes the effort**: the floor is the one thing that raises it, the loop takes
   the higher of the two, and a budget in its downgrade band, which holds a
   complex task at standard, drops the floor with it. "A retry" is read from the transitions (`lastFailure` in the
   runner), not from `claim.from`, which says QUEUED whenever anybody requeued
   the task first; see [07](07-agent-runtime.md). A pause for a busy vendor, a
   block that was answered, and a failure the reaper or a restart wrote do not
   count, because none of them was the model's fault — and a pause in the middle
   of a retry comes back on the rung its checkpoint saved. **The ladder reads
   why the run failed** (`failureClass`, off the FAILED transition) and only a
   failure the model could have avoided climbs — `tool-error`, `other`, and an
   untagged failure from before the classes. A **`truncated`** retry keeps its
   level at the level's own effort, never higher, which is a step down for a
   retry that was already thinking harder: every Claude turn carries the same
   fixed `max_tokens` (16,000) and thinking is counted inside it, so climbing
   spends more of a budget that was already too small, then reaches a dearer
   model. The ceiling is not raised for it — above it the SDK refuses a call
   that is not streamed. **`vendor-unavailable` and `budget` buy nothing**: same
   level, same effort. Each says so on the ROUTED step. The streak those
   failures leave still counts towards "two in a row" for a later failure that
   does climb.
2. **`scoreTask()`**, pure: agent tier, origin (schedule and delegated −1), the
   tools the brief points at (`likelyTools` — a build or judgement tool +2,
   reading only −1), brief length, wording cues (capped ±2; "care plan" is a
   product and never counts as "plan"), `WRITES_FOR_OUTSIDE` +1, linked
   proposal/project +1. Below zero simple, 0–3 standard, 4+ complex. **A task
   with nothing to say about it is standard** — the same rule as a job with no
   tier.
3. **A free look**, only on a boundary score (−1, 0, 3, 4) and only in mode
   `full`: one `callModel({ job: "routing", provider: "nvidia" })`, answer
   clamped to one step from the rules, 15 s timeout, any failure keeps the rules'
   answer. **Pinned to NVIDIA and declared by NVIDIA alone** — sizing on a paid
   model would be paying to decide how much to pay, and an unpinned call would
   also land on the turn-scripted Claude fakes in `checks/commissionedRun.ts`.
   No NVIDIA key, no look.
4. **The budget.** Downgrade or approve band ⇒ at most standard, over the
   Owner's override too (the ceiling is theirs as well). `easeOff` still lowers
   one level, once, between turns — measured on the whole effort scale, so a
   retry thinking at `xhigh` or `max` (`effortFloor`) eases off like any other
   run; it used to compare against low-to-high only, and those were the runs
   most likely to be near their ceiling. A retry whose level cannot drop (a
   standard task asked for medium) gives back the raised thinking instead, on
   the same model.

Resolution of a slot (`tierSlot`): `models.tierModels` (priced ids only, like
`models.jobModels`) → the model the Owner had already set for that vendor
(`anthropic.model` = complex, `anthropic.model.economy` = standard,
`<vendor>.model` = standard) → `TIER_MODELS`. **`agents.routing`** is the mode:
`full` (unset), `rules`, or `off` — off is the rollback with no deploy and puts
every model back on `legacyEffort(agent)`, the old rank-based answer, and writes
no level. The runner writes `level`/`levelReason`/`levelSource` and a `ROUTED`
step; the Costs screen splits agent spend by level (`levelSpend`). Settings → AI
models → Task levels edits the 3×3 grid and the mode. Held by
`checks/taskRouting.ts`, which asserts each vendor's request body on its own.

