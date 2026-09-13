# The rehearsal room

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

**The rehearsal room** — `src/services/rehearsals/`, `routes/rehearsals.ts`, the
`/rehearsals` screen. One real website, put through one real workflow, with
nothing able to leave the building. It exists because there was no way to answer
*what would actually happen if I pointed the workforce at this business* short
of making a real lead and giving a real agent a real task — which works, leaves
a real lead in the pipeline, and depends on every agent in the chain being at an
autonomy that cannot send anything.

Nothing is simulated. Same agents, same prompts, same tools through the same
gate, same money, same delegation rules. Exactly three things differ:

- **`AgentTask.rehearsal`** is passed to `invokeTool` as `dryRun`, and
  `delegate` and `handOff` copy it onto the tasks they create — so the
  guarantee holds across a run that fans out to nine agents.
- **`Lead.rehearsal`** marks the scratch lead: hidden from `buildWhere` in
  `routes/leads.ts` (and so from every count, group and export built on it),
  from the dashboard's pipeline count, from the phone-only list, and — the one
  that matters — **refused by `enrol()`**, which is the only door into an email
  sequence. That last one is not belt and braces: the scratch lead starts with
  no address and `leadPrep` fills one in from the business's own homepage.
- **It can be thrown away**, which is what makes the second one cheap.

**The dry run is narrowed to `outward`, and `services/rehearsals/policy.ts`
argues why.** A blanket dry run is the obvious first draft and it is wrong
twice: a read has no `preview`, so `invokeTool` refuses it outright — every
agent in the run blind, every timeline a wall of refusals — and previewing the
writes would mean a rehearsal in which every agent describes work nobody can
open. Reads, writes to our own records, and **spending** all really happen; what
the run cost is totalled on screen instead. `capture.run` is the one to watch:
it spends without being outward.

**A rehearsal has a ceiling in money as well as in tasks.** `MAX_TASKS` (24)
counts conversations, and a conversation is not a fixed price — a run can sit
well inside twenty-four tasks and still spend more than the person watching it
meant to. `Rehearsal.budgetUsd` is checked on every drain (default $3, set on
the start form, **0 means no ceiling** — a `.positive()` guard there would
silently restore the default for the one person who typed 0 on purpose), and a
run past it is stopped with what it spent and what it was allowed written on the
row. The Spent tile shows the ceiling beside the total and the Tokens tile shows
the cached share, because a run whose cache reads are zero is a run that paid
for its instructions a dozen times and nothing else on the screen would say so.

**A rehearsal wakes the agents it needs and puts them back** —
`rehearsals/wake.ts`. Every specialist and most of the board seed as a **draft**
and a draft picks nothing up, so the first version of the screen was five
greyed-out workflows and an errand: switch eleven agents on by hand, and be left
with a floor switched on because of a test, quietly taking real work. Starting a
run now wakes the starting agent plus its whole reporting tree (`reportsUnder` —
the set `delegate` can reach), and `delegate`/`handOff` wake a draft target as
they reach it, which matters most for hand-offs because those go sideways to
anybody at all.

- **A draft is woken; a paused agent is not.** Pausing is something a person
  *did* — it is how the Owner stops an agent's standing work — and a test is not
  a reason to overrule it. Retired likewise. Both refuse with the reason said.
- **Waking is three columns, not one, and for months it was one.** A draft
  seeds at `autonomyLevel 1` with `dryRun` on, and `permissionFor` downgrades
  every spending, outward, write and send call from an agent in that state to a
  preview — so an agent the rehearsal itself woke could not carry out a single
  tool it owned. A whole-floor run against a real site is what showed it: the
  Website Auditor, woken from draft, prepared `site.look` and `audit.website`
  and ran neither, while the SEO Specialist — already active at a working level
  because somebody had switched it on weeks before — ran both for real on the
  same site in the same minute. The run was a test of which agents happened to
  be configured. A woken agent is now lifted to `REHEARSAL_AUTONOMY` (4, the
  level `invokeTool` requires to spend) with dry run off, **raised only, never
  lowered**, and the level and the flag go back with the status. The guarantee
  is untouched by it: `policy.ts` holds every outward call at a preview through
  `invokeTool`'s own floor whatever the card says, which is asserted.
- **An agent that was already ACTIVE keeps what the Owner gave it.** Same
  distinction as the paused one, at the other end: autonomy 1 on a draft is a
  default nobody chose, and autonomy 1 on a live agent is a decision. So a run
  can still contain an agent that prepared everything and did nothing — which is
  why every prepared call now carries `heldBecause` and the screen prints it.
- **The lift and the restore are both written to `AgentAutonomyChange`**, actor
  `rehearsal`. A history with holes in it is the thing that column exists to
  prevent, and "who moved this agent to four" has to have an answer.
- **`Rehearsal.wokeAgents` is written before the status changes**, in the same
  transaction. An agent awake with no record of who woke it is an agent that
  stays awake, and then a test has permanently changed how the business runs.
- **`restoreWakes()` skips agents another RUNNING rehearsal still needs.** Two
  runs at once will often wake the same specialist, and the first to finish
  putting it back would stop the second dead — with the symptom appearing on the
  *other* run.
- **`restoreOrphanedWakes()` at boot**, beside `resumeInterruptedTasks()`, for a
  container killed mid-run. It also marks that rehearsal STOPPED rather than
  leaving it RUNNING for ever.
- **`settleIdleRehearsals()` on the minute tick** is the floor under `nudge`,
  which is the screen draining its own run and was the only caller of `settle`.
  A rehearsal whose tab was closed part-way stayed RUNNING with its agents awake
  until the next restart — already wrong, and worse now that waking lifts an
  autonomy level as well as a status.
- It restores only agents still sitting at ACTIVE, so an agent the Owner has
  since paused or switched on for good is left alone.

**The agent at the top does not get to finish before its directors have** —
`askForClosingBrief()` in `rehearsals/run.ts`, `Rehearsal.closingTaskId`.
`delegate` and `handOff` are fire-and-forget for a good reason — an agent that
blocked on a report would hold its own agent lock while that report queued
behind it, and `REHEARSAL_CONCURRENCY` is 1, so waiting is a deadlock rather
than a delay. The consequence was invisible until a whole-floor run showed it
plainly: the Chief Executive read the numbers, handed the site to two directors,
and wrote a brief saying "two hand-offs queued" that carried none of their
findings. Every wide scenario ended that way, every time, with the run's
headline answer the least informed thing in it.

So the wait moves to where waiting is free. When `settle` finds nothing can move
again, the starting agent is given one more task carrying **what each of them
actually said, in their own words** — a précis assembled here would be this file
doing the job the agent is about to be asked to do. The negatives are the half
worth keeping: it does not fire when the root task did not finish (an agent that
escalated asked a person a question, and a confident summary over the top of it
buries the question), not when nobody else worked, not twice, and not when it
would tip the run past `MAX_TASKS` or its budget — a closing brief the next
drain stops is worse than not asking.

**Reasoning is on the timeline now, for every task and not only these.**
`AgentStepKind.THOUGHT` existed since the runtime shipped and nothing ever wrote
one — `runAgentLoop` collected every text block into `narration`, kept it on the
checkpoint and handed it back after the run, so an agent's reasoning was paid
for and shown to nobody. `onText` writes it as it happens.
`dropTrailingThought()` removes the last one, because the final text block is
the summary and gets its own FINISHED step.

The screen's own poll drives the run (`nudge`), which is unusual enough to be
commented at the route: the minute tick would eventually start every queued task
in the tree, and six hops at one a minute is five minutes of a still screen that
reads as a hang. `checks/rehearsal.ts` is the committed half — 97 assertions,
database only — and every claim in it carries the **negative** that catches the
mistake worth catching: an unrestricted agent must still really be allowed to
send, a rehearsal must not blind its own agents, an ordinary lead must still
enrol, an ordinary delegation must *not* come out marked as a rehearsal, and a
paused agent must stay paused. Ten of its assertions had **never once passed**:
the five gate sections assert against nine tools the harness's own agents were
never granted, and a grant is checked before everything else — so a file that
was permanently ten red is a file nobody reads a new failure out of. The
toolkit was widened rather than the assertions weakened. `tmp/rehearsalDrive.ts` drives a whole run
against a local Anthropic stub, starting from a floor where every agent is a
draft.

