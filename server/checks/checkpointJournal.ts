/**
 * A resumed run's tallies, against what the record says actually happened.
 *
 * The gap this closes is narrow and real: a checkpoint is written after every
 * tool call, carrying the conversation and the counters in one `upsert`, so the
 * two cannot drift in the ordinary case. What that write cannot cover is a
 * process that finishes a tool call and dies before the checkpoint lands — the
 * side effect happened, its `ToolCall` row is on the ledger, and the checkpoint
 * that comes back has never heard of it.
 *
 * The assertions that matter are the two directions:
 *
 *  - **Upward, where the ledger has seen more.** Every counter here is enforced
 *    as a ceiling, so a checkpoint that undercounts hands a resumed task a
 *    second helping of an allowance it has already spent.
 *  - **Never downward.** A checkpoint ahead of the ledger is a run whose
 *    bookkeeping simply has not landed yet, and lowering it to match would be
 *    the same bug wearing the opposite sign.
 *
 * Database only. No key, no network — the ledgers are rows, and rows are all
 * this reads.
 */
import { reconcileCounters } from "../src/services/agents/checkpoint-journal.js";
import type { Counters } from "../src/services/agents/runner.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const AGENT_KEY = "check.journal.agent";

function counters(over: Partial<Counters> = {}): Counters {
  return {
    toolCalls: 0,
    dryRun: 0,
    refused: 0,
    escalated: null,
    delegated: 0,
    consulted: 0,
    consultedBy: { low: 0, medium: 0, high: 0 },
    handedOff: 0,
    gapsRaised: 0,
    ...over,
  };
}

async function reset() {
  const tasks = await prisma.agentTask.findMany({ where: { agentKey: AGENT_KEY }, select: { id: true } });
  const ids = tasks.map((row) => row.id);
  if (ids.length > 0) await prisma.toolCall.deleteMany({ where: { taskId: { in: ids } } });
  await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
}

await reset();
await prisma.agent.create({
  data: {
    key: AGENT_KEY,
    name: "Journal Check",
    title: "Journal Check",
    tier: "SUB_AGENT",
    department: "TECHNOLOGY",
    status: "ACTIVE",
    mission: "Exists for one test run.",
    custom: true,
  },
});

const task = await prisma.agentTask.create({
  data: { agentKey: AGENT_KEY, title: "Work something out", brief: "Do the thing.", priority: 2 },
});

/** One row per thing that really happened, as the tool ledger records them. */
async function ledger(entries: { tool: string; dryRun?: boolean; refused?: boolean }[]) {
  for (const entry of entries) {
    await prisma.toolCall.create({
      data: {
        tool: entry.tool,
        agentKey: AGENT_KEY,
        taskId: task.id,
        traceId: task.traceId,
        ok: !entry.refused,
        dryRun: entry.dryRun ?? false,
        refusedReason: entry.refused ? "Out of scope." : null,
      },
    });
  }
}

let seq = 0;
async function timeline(kind: "CONSULTED" | "DELEGATED" | "HANDED_OFF" | "GAP_RAISED", message: string) {
  await prisma.agentTaskStep.create({ data: { taskId: task.id, seq: (seq += 1), kind, message } });
}

console.log("\nNothing to reconcile");
{
  const { counters: after, corrections } = await reconcileCounters(task.id, counters());
  check("an empty ledger changes nothing", after.toolCalls === 0 && after.consulted === 0, JSON.stringify(after));
  check("and says so", corrections.length === 0, corrections.join("; "));
}

console.log("\nThe ledger has seen more than the checkpoint");
{
  // Three real calls, one prepared, one refused — and a checkpoint that stopped
  // counting after the first two. This is the crash-before-the-write case.
  await ledger([
    { tool: "lead.read" },
    { tool: "lead.read" },
    { tool: "email.draft" },
    { tool: "email.send", dryRun: true },
    { tool: "email.send", refused: true },
  ]);
  await timeline("CONSULTED", "Asked the designer");
  await timeline("CONSULTED", "Asked the copywriter");
  await timeline("HANDED_OFF", "To the developer");
  await timeline("GAP_RAISED", "Nobody can edit video");

  const { counters: after, corrections } = await reconcileCounters(task.id, counters({ toolCalls: 2 }));

  check("tool calls are put back in step", after.toolCalls === 5, `${after.toolCalls}`);
  check("prepared actions are counted", after.dryRun === 1, `${after.dryRun}`);
  check("refusals are counted", after.refused === 1, `${after.refused}`);
  check("consults are recovered from the timeline", after.consulted === 2, `${after.consulted}`);
  check("hand-offs too", after.handedOff === 1, `${after.handedOff}`);
  check("and skill gaps", after.gapsRaised === 1, `${after.gapsRaised}`);
  check("what changed is said, for the timeline", corrections.length > 0, corrections.join("; "));

  // The split has to follow the total it belongs to, or the per-priority
  // ceilings are enforced against a number saying fewer questions were asked
  // than the cap has already counted.
  const inSplit = after.consultedBy.low + after.consultedBy.medium + after.consultedBy.high;
  check("the per-priority split follows the total it belongs to", inSplit === after.consulted, `${inSplit} vs ${after.consulted}`);
}

console.log("\nNever downward");
{
  // A checkpoint ahead of the ledger is a run whose bookkeeping has not landed
  // yet. Lowering it to match would be the same bug with the opposite sign: an
  // allowance handed back that had already been spent.
  const ahead = counters({ toolCalls: 99, consulted: 3, handedOff: 2, dryRun: 7, refused: 4, delegated: 5, gapsRaised: 6 });
  const { counters: after, corrections } = await reconcileCounters(task.id, ahead);
  check("a checkpoint ahead of the record keeps its tool calls", after.toolCalls === 99, `${after.toolCalls}`);
  check("its consults", after.consulted === 3, `${after.consulted}`);
  check("its hand-offs", after.handedOff === 2, `${after.handedOff}`);
  check("its prepared actions", after.dryRun === 7, `${after.dryRun}`);
  check("and nothing is reported as corrected", corrections.length === 0, corrections.join("; "));
}

console.log("\nWhat is never reconciled");
{
  // `escalated` is not a count — it is the sentence an agent stopped on, and it
  // decides whether the task finishes BLOCKED. A timeline entry is not proof
  // the run still intends to stop: the agent may have escalated, been answered,
  // and carried on.
  const { counters: after } = await reconcileCounters(task.id, counters({ escalated: "Which of the two prices?" }));
  check("the escalation is carried through untouched", after.escalated === "Which of the two prices?", `${after.escalated}`);

  const { counters: carried } = await reconcileCounters(task.id, counters({ escalated: null }));
  check("and a run that is not stopped is not given one", carried.escalated === null, `${carried.escalated}`);
}

console.log("\nIt never writes");
{
  // A reconciliation is a read. If it wrote, the act of resuming a task would
  // change the ledger it is being measured against — and every subsequent
  // resume would reconcile against its own last answer.
  const before = await prisma.toolCall.count({ where: { taskId: task.id } });
  const steps = await prisma.agentTaskStep.count({ where: { taskId: task.id } });
  await reconcileCounters(task.id, counters());
  check("the tool ledger is untouched", (await prisma.toolCall.count({ where: { taskId: task.id } })) === before, `${before}`);
  check("and so is the timeline", (await prisma.agentTaskStep.count({ where: { taskId: task.id } })) === steps, `${steps}`);
}

console.log("\nA broken ledger is not a broken resume");
{
  // Never throws. A reconciliation that fell over must not stop a task
  // resuming — the checkpoint's own numbers are what the run would have used
  // before this existed.
  const { counters: after, corrections } = await reconcileCounters("no-such-task-id", counters({ toolCalls: 4 }));
  check("an unknown task resumes on its checkpoint's numbers", after.toolCalls === 4, `${after.toolCalls}`);
  check("and reports no corrections", corrections.length === 0, corrections.join("; "));
}

await reset();
console.log(bad ? `\n${bad} PROBLEM(S)` : `\nA resumed run cannot get its allowance back by dying at the right moment.`);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
