import type { ToolDefinition } from "../tools/types.js";

/**
 * What a rehearsal holds back, and — just as important — what it does not.
 *
 * The first draft of this said "everything", by handing `invokeTool` a blanket
 * `dryRun: true` for every call in a rehearsal. That is wrong twice over, and
 * the second way is worse than the first:
 *
 * 1. **A read has no preview**, so `invokeTool` would refuse it outright:
 *    "Read leads can't be previewed, and a dry run must not carry it out."
 *    Every agent in the run would have been blind — unable to read the lead it
 *    was given, the audit it was told to argue from, or the record it was
 *    asked to update. The timeline would have filled with refusals and the
 *    rehearsal would have been a test of nothing.
 * 2. **The artefacts are the point.** The research, the site audit, the
 *    drafted letter, the priced proposal — those are what a person opens
 *    afterwards to judge whether the workforce is any good. A rehearsal that
 *    previewed them would produce a run in which every agent describes work
 *    nobody can read.
 *
 * So the line is drawn where the risk actually is: **`outward`**, the flag the
 * catalogue already carries for a call that is visible outside the company.
 * Sending an email, enrolling somebody in a sequence, opening a GitHub issue,
 * booking a meeting, raising a payment, publishing a demo page under a
 * stranger's business name. Those stop at a preview in a rehearsal whatever
 * autonomy their agent is on, and that is the whole of the guarantee.
 *
 * **What a rehearsal deliberately does not hold back:**
 *
 * - **Reads.** Nothing is at stake and everything depends on them.
 * - **Writes to our own records.** They land on the scratch lead, which is
 *   marked, kept out of the pipeline, and deleted with the rehearsal.
 * - **Spending.** A research pass and a site audit cost real money on real
 *   models and a real Apify run, and there is no honest way to rehearse them
 *   without paying. What the run cost is totalled on the screen instead —
 *   which is a thing worth knowing before the workforce is turned loose on
 *   four hundred leads.
 *
 * The one to keep an eye on is `capture.run`: it spends without being outward,
 * so a brief that talked an agent into scraping a city would really scrape it.
 * Nothing in the shipped scenarios asks for that, and the ceiling on the run
 * plus the cost readout is what would show it.
 *
 * **This is a floor, not the only gate.** `permissionFor` still applies the
 * agent's own card on top — its autonomy level and its dry-run flag — and for
 * a long time that quietly cancelled everything argued above: an agent the
 * rehearsal itself woke sat at the seeded autonomy 1 with dry run on and could
 * carry out none of its own tools, so the artefacts this file calls the point
 * of the exercise were never produced. `wake.ts` now lifts the agents it wakes
 * for the length of the run. An agent that was *already* active keeps whatever
 * the Owner set, deliberately — so a run can still contain one that prepared
 * everything and did nothing, and `heldBecause` on each prepared call is where
 * that is said rather than left to be guessed at.
 */
export function heldByRehearsal(tool: Pick<ToolDefinition, "outward">): boolean {
  return tool.outward;
}

/**
 * The guarantee, in the words the screen uses.
 *
 * Kept beside the rule it describes rather than in the route, because a
 * sentence that promises more than the predicate delivers is worse than no
 * sentence at all.
 */
export const REHEARSAL_GUARANTEE =
  "Every call that would reach outside the company — an email, a message, a payment, a booking, a published page — stops at a preview, whatever autonomy the agents are on. Research, reviews and drafts really run and really cost money; what they produce hangs off a scratch lead that goes when you throw the rehearsal away.";
