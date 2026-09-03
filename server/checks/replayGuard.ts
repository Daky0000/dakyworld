/**
 * What a resumed run must not do twice.
 *
 * A checkpoint is written after every tool call, so the conversation and the
 * counters cannot drift apart. The one gap that write cannot close is a
 * process that finishes a tool call and dies before the checkpoint lands: the
 * side effect happened, and the turn that comes back on resume has no result
 * for it, so the loop calls the tool again.
 *
 * `idempotencyKey` has always covered that for outward tools — "again" for
 * `email.send` is a second letter. What it did not cover is everything else,
 * and the tools most often lost in that window are not outward at all. They
 * are the ones that spend money without leaving the building (a capture run, a
 * homepage photographed, a section of an audit) and the ones that write a row
 * a person then finds twice (`proposal.draft`, `invoice.draft`). `delegate`
 * and `handOff` do not go through `invokeTool` at all, and their second run is
 * another agent waking up to do work that is already done.
 *
 * Three properties, and the second matters as much as the first:
 *
 *  - **Inside the restored turn, the same call is not made twice.**
 *  - **Outside it, nothing is deduplicated.** Two identical calls can both be
 *    meant — a page looked at again after it has been changed is the case —
 *    and a blanket rule would answer the second with the first one's stale
 *    output.
 *  - **A call with no `meta` at all is not a replay.** A harness or a route
 *    driving one tool directly is not resuming a conversation.
 *
 * Database only. `lead.update` is the subject because it writes something a
 * check can see, needs no key and no network, and is not outward — which is
 * exactly the class this closes.
 */
import { toolsFor, workflowTools, type Counters } from "../src/services/agents/runner.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const AGENT_KEY = "check.replay.agent";
const REPORT_KEY = "check.replay.report";

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
  const tasks = await prisma.agentTask.findMany({
    where: { agentKey: { in: [AGENT_KEY, REPORT_KEY] } },
    select: { id: true },
  });
  const ids = tasks.map((row) => row.id);
  if (ids.length > 0) {
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.toolCall.deleteMany({ where: { taskId: { in: ids } } });
  }
  await prisma.toolCall.deleteMany({ where: { agentKey: { in: [AGENT_KEY, REPORT_KEY] } } });
  await prisma.agentTask.deleteMany({ where: { agentKey: { in: [AGENT_KEY, REPORT_KEY] } } });
  await prisma.agent.deleteMany({ where: { key: { in: [AGENT_KEY, REPORT_KEY] } } });
  await prisma.lead.deleteMany({ where: { contactName: "Replay Check Lead" } });
}

await reset();

const manager = await prisma.agent.create({
  data: {
    key: AGENT_KEY,
    name: "Replay Check",
    title: "Replay Check",
    tier: "FUNCTIONAL",
    department: "TECHNOLOGY",
    status: "ACTIVE",
    mission: "Exists for the length of this check.",
    toolkit: ["lead.update"],
    // Not in dry run, or `lead.update` would be prepared rather than done and
    // this would be a check about previews.
    dryRun: false,
    autonomyLevel: 4,
    custom: true,
  },
});

await prisma.agent.create({
  data: {
    key: REPORT_KEY,
    name: "Replay Check Report",
    title: "Replay Check Report",
    tier: "SUB_AGENT",
    department: "TECHNOLOGY",
    status: "ACTIVE",
    mission: "Exists for the length of this check.",
    managerKey: AGENT_KEY,
    custom: true,
  },
});

const lead = await prisma.lead.create({ data: { contactName: "Replay Check Lead", leadScore: 0 } });
const task = await prisma.agentTask.create({
  data: { agentKey: AGENT_KEY, title: "Score the lead", brief: "Score it.", priority: 2, leadId: lead.id },
});

const scoreOf = async () =>
  (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { leadScore: true } })).leadScore;
const resetScore = () => prisma.lead.update({ where: { id: lead.id }, data: { leadScore: 0 } });

const granted = await toolsFor(manager, task, counters());
const update = granted.tools.find((tool) => tool.name === "lead__update");
if (!update) {
  console.log("  FAIL  the agent was not granted lead.update");
  process.exit(1);
}
const call = { id: lead.id, leadScore: 40 };

console.log("\nA tool that is not outward still runs, twice, in the ordinary case");
{
  const first = await update.run({ ...call }, { replay: false });
  check("the first call does the thing", (await scoreOf()) === 40, `${await scoreOf()} — ${first.content.slice(0, 120)}`);

  // The same arguments again, in the same task, as a fresh decision. This is
  // the property a blanket idempotency rule would break: an agent that changes
  // something, looks again and changes it back must not be answered with the
  // output it got an hour ago.
  await resetScore();
  await update.run({ ...call }, { replay: false });
  check("a deliberate repeat is not deduplicated", (await scoreOf()) === 40, `${await scoreOf()}`);

  // No `meta` at all — a harness or a route driving the tool directly.
  await resetScore();
  await update.run({ ...call });
  check("and neither is a call with no run behind it", (await scoreOf()) === 40, `${await scoreOf()}`);
}

console.log("\nInside the turn a resume restored, it does not happen again");
{
  await resetScore();
  const replayed = await update.run({ ...call }, { replay: true });
  check("the tool is not run a second time", (await scoreOf()) === 0, `lead score is ${await scoreOf()}`);
  check("and the model is answered rather than refused", !replayed.isError, replayed.content.slice(0, 160));

  // The replay is on the ledger as a replay. "Why did this run do nothing" is
  // answered from `ToolCall` or it is not answered at all.
  const rows = await prisma.toolCall.findMany({
    where: { taskId: task.id, tool: "lead.update" },
    orderBy: { createdAt: "asc" },
  });
  const marked = rows.filter((row) => (row.output as { replayed?: boolean } | null)?.replayed === true);
  check("the replay is written down as one", marked.length === 1, `${marked.length} of ${rows.length} rows`);
}

console.log("\nAnd the same for work handed to somebody else");
{
  const workflow = workflowTools(manager, task, counters());
  const delegate = workflow.find((tool) => tool.name === "delegate");
  if (!delegate) {
    check("the manager can delegate", false, workflow.map((tool) => tool.name).join(", "));
  } else {
    const input = {
      agentKey: REPORT_KEY,
      title: "Replay check: a piece of the work",
      brief: "Everything they need, written as if to somebody who was not here.",
    };
    const children = () => prisma.agentTask.count({ where: { parentId: task.id, agentKey: REPORT_KEY } });

    await delegate.run({ ...input }, { replay: false });
    check("delegating queues one task", (await children()) === 1, `${await children()}`);

    // The expensive one. A second child is a second agent, waking up to do
    // work that is already done — and nothing about the first one is on the
    // conversation the resumed run came back with.
    const again = await delegate.run({ ...input }, { replay: true });
    check("a replayed delegation does not queue a second", (await children()) === 1, `${await children()}`);
    check("and says the work is already theirs", again.content.toLowerCase().includes("already"), again.content.slice(0, 160));
    check("and is not an error the model has to handle", !again.isError, again.content.slice(0, 160));

    // Outside the window, a manager raising the same title twice means it.
    await delegate.run({ ...input }, { replay: false });
    check("a deliberate second delegation still queues one", (await children()) === 2, `${await children()}`);
  }
}

await reset();
console.log(bad ? `\n${bad} PROBLEM(S)` : `\nA run that died at the wrong moment does not pay for its tools twice.`);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
