import { prisma } from "../../lib/prisma.js";
import type { Counters } from "./runner.js";

/**
 * Putting a resumed run's tallies back in step with what actually happened.
 *
 * A checkpoint is written after every tool call, in one `upsert` that carries
 * the conversation and the counters together — so the two cannot drift apart in
 * the ordinary case, and this is not a fix for a torn write. What it is a fix
 * for is the one gap that write cannot close: a process that finishes a tool
 * call and dies before the checkpoint lands. The side effect happened, its
 * `ToolCall` row is on the ledger, its step is on the timeline, and the
 * checkpoint that comes back on resume has never heard of it.
 *
 * **Only ever upward.** The counters this corrects are the ones that *spend*
 * something — tool calls, consults, hand-offs, delegations, gaps — and every
 * one of them is enforced as a ceiling. A checkpoint that undercounts hands a
 * resumed task a second helping of an allowance it has already used: two more
 * hand-offs, three more consults, another run at a spending cap. So where the
 * ledger has seen more than the checkpoint, the ledger wins; where the
 * checkpoint has seen more, the checkpoint wins and nothing is lowered.
 *
 * That asymmetry is deliberate and it is not free: the resumed agent may be
 * charged for a consult whose answer is no longer in its conversation. That is
 * the right way round. Losing an answer costs a question; regaining an
 * allowance costs whatever the allowance was protecting.
 *
 * **`escalated` is never reconciled.** It is not a count, it is the sentence an
 * agent stopped on, and it decides whether the task finishes BLOCKED. A
 * timeline entry is not proof the run still intends to stop — the agent may
 * have escalated, been answered, and carried on — so the checkpoint is the only
 * honest source and it is copied through untouched.
 *
 * **The ledgers, not `LlmCall`.** `LlmCall` records model calls, tokens and
 * cost, and holds none of these counters — a reconciliation against it could
 * only ever answer a question nobody is asking. `ToolCall` carries `taskId`,
 * `dryRun` and `refusedReason`, which is exactly the tool half; `AgentTaskStep`
 * carries one row per consult, delegation, hand-off and gap. Those two are the
 * ledgers that hold the facts, so those two are what this reads.
 */

export interface Reconciliation {
  counters: Counters;
  /** What changed, in words, for the timeline and the log. Empty when nothing did. */
  corrections: string[];
}

/** One row per thing an agent did, from the two ledgers that outlive a conversation. */
async function ledgerTallies(taskId: string) {
  const [tools, steps] = await Promise.all([
    // Refusals and dry runs are counted apart from real calls because the
    // runner counts them apart: a prepared action is not a failure and a
    // refusal is the gate working.
    prisma.toolCall.groupBy({
      by: ["dryRun"],
      where: { taskId, refusedReason: null },
      _count: true,
    }),
    prisma.agentTaskStep.groupBy({
      by: ["kind"],
      where: { taskId },
      _count: true,
    }),
  ]);

  const refused = await prisma.toolCall.count({ where: { taskId, refusedReason: { not: null } } });
  const byKind = Object.fromEntries(steps.map((row) => [row.kind, row._count]));

  return {
    // `toolCalls` in the runner counts every call the loop made, prepared ones
    // included. The ledger splits them, so they are added back up here.
    toolCalls: tools.reduce((total, row) => total + row._count, 0) + refused,
    dryRun: tools.find((row) => row.dryRun)?._count ?? 0,
    refused,
    delegated: byKind.DELEGATED ?? 0,
    consulted: byKind.CONSULTED ?? 0,
    handedOff: byKind.HANDED_OFF ?? 0,
    gapsRaised: byKind.GAP_RAISED ?? 0,
  };
}

/**
 * Reads the ledgers and returns the counters a resume should actually start from.
 *
 * Never throws and never writes. A reconciliation that failed must not stop a
 * task resuming — the checkpoint's own numbers are the fallback, and they are
 * the numbers the run would have used before this existed.
 */
export async function reconcileCounters(taskId: string, fromCheckpoint: Counters): Promise<Reconciliation> {
  try {
    const ledger = await ledgerTallies(taskId);
    const counters: Counters = {
      ...fromCheckpoint,
      consultedBy: { ...fromCheckpoint.consultedBy },
    };
    const corrections: string[] = [];

    const raise = (name: keyof typeof ledger, label: string) => {
      const seen = ledger[name];
      const held = counters[name as "toolCalls"] as number;
      if (seen <= held) return;
      (counters[name as "toolCalls"] as number) = seen;
      corrections.push(`${label}: ${held} on the checkpoint, ${seen} on the record`);
    };

    raise("toolCalls", "tool calls");
    raise("dryRun", "prepared actions");
    raise("refused", "refusals");
    raise("delegated", "delegations");
    raise("consulted", "consults");
    raise("handedOff", "hand-offs");
    raise("gapsRaised", "skill gaps");

    // The split has to follow the total it belongs to, or the per-priority
    // ceilings are enforced against a number that says fewer questions were
    // asked than the cap has already counted. Recovered consults go under
    // `medium`, the same fallback `restoreCounters` uses for a checkpoint
    // written before the split existed: the total is what is enforced, and
    // which kind of question it was is the half nothing reads back.
    const inSplit = counters.consultedBy.low + counters.consultedBy.medium + counters.consultedBy.high;
    if (inSplit < counters.consulted) counters.consultedBy.medium += counters.consulted - inSplit;

    return { counters, corrections };
  } catch (err) {
    console.error(`[agent] could not reconcile ${taskId}'s counters against the ledger:`, (err as Error).message);
    return { counters: fromCheckpoint, corrections: [] };
  }
}
