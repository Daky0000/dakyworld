/**
 * Is an agent sent a tool it could not possibly use?
 *
 * Every agent carries nine workflow tools on top of its own — escalate,
 * remember, the two history ones, delegate, and the four for working with
 * colleagues. Measured against the real roster they are about 2,100 tokens of
 * JSON Schema per turn, where the agent's *own* granted tools average 711. So
 * two thirds of what a typical turn spends before it does anything is the
 * scaffolding for asking somebody else, and a good part of that is provably
 * dead on arrival:
 *
 *   - `addToHistory` and `readHistory` both refuse when the task is not about a
 *     lead, a client or a project. There is no company to have a history.
 *   - `consult` refuses once the task's allowance is spent.
 *   - `handOff` refuses once `MAX_HANDOFFS` are gone.
 *
 * The positives here are that those are dropped. **The negatives are the point
 * and there are more of them**, because every way of getting this wrong is
 * worse than the tokens it saves:
 *
 *   - **The prompt must never name a tool that was not sent.** An agent told to
 *     consult a colleague, with no `consult` in its list, spends a whole turn
 *     on a call that cannot resolve — which costs several times the schema.
 *   - **`findAgent` is never pruned.** An agent that cannot look reports a gap
 *     for a craft the roster has had since March.
 *   - **Nothing is dropped while it still works.** One consult left is a
 *     consult, and an agent silently unable to ask is the expensive failure.
 *   - **A capability is never removed** — only a call that would be refused.
 *
 * A database and nothing else. No API key, no network.
 *   npx tsx checks/agentToolBudget.ts
 */
import type { Agent, AgentTask } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { ensureAgents } from "../src/services/agentRegistry.js";
import { composePrompt, toolsFor, workflowAvailability, workflowTools, type Counters } from "../src/services/agents/runner.js";
import { taskSubjects } from "../src/services/agents/context.js";

const failures: string[] = [];
let passed = 0;

function ok(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const fresh = (): Counters => ({
  toolCalls: 0,
  dryRun: 0,
  refused: 0,
  escalated: null,
  delegated: 0,
  consulted: 0,
  consultedBy: { low: 0, medium: 0, high: 0 },
  handedOff: 0,
  gapsRaised: 0,
});

const spent = (): Counters => ({ ...fresh(), consulted: 3, consultedBy: { low: 0, medium: 3, high: 0 }, handedOff: 2 });

function taskOn(over: Partial<AgentTask>): AgentTask {
  return {
    id: "budget-task",
    agentKey: "x",
    title: "A task",
    brief: "A brief",
    status: "RUNNING",
    priority: 2,
    rehearsal: false,
    skipLook: false,
    leadId: null,
    clientId: null,
    projectId: null,
    proposalId: null,
    invoiceId: null,
    input: null,
    origin: "OWNER",
    parentId: null,
    dueAt: null,
    ...over,
  } as AgentTask;
}

const est = (value: string) => Math.round(value.length / 4);
const weigh = (tools: { name: string; description: string; inputSchema: unknown }[]) =>
  est(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))));

async function main() {
  await ensureAgents();
  const manager = await prisma.agent.findFirstOrThrow({ where: { tier: { not: "SUB_AGENT" } }, orderBy: { key: "asc" } });
  const specialist = await prisma.agent.findFirstOrThrow({ where: { tier: "SUB_AGENT" }, orderBy: { key: "asc" } });

  const names = (agent: Agent, task: AgentTask, counters: Counters, limit?: number) =>
    workflowTools(agent, task, counters, limit).map((tool) => tool.name);

  console.log("\nA task about a company");
  const aboutLead = taskOn({ leadId: "lead-1" });
  const full = names(manager, aboutLead, fresh(), 3);
  ok("the history tools are there when there is a company to have one", full.includes("addToHistory") && full.includes("readHistory"));
  ok("so is consult, with the allowance untouched", full.includes("consult"));
  ok("and handOff, with none spent", full.includes("handOff"));
  ok("a manager gets delegate", full.includes("delegate"));
  ok("findAgent is always there", full.includes("findAgent"));
  ok("and so is needSkill — the only road to the Agent Creator", full.includes("needSkill"));

  console.log("\nA task about no record at all");
  const aboutNothing = taskOn({});
  const bare = names(manager, aboutNothing, fresh(), 3);
  ok("addToHistory is not sent — it could only refuse", !bare.includes("addToHistory"));
  ok("nor readHistory", !bare.includes("readHistory"));
  ok("but remember still is: a lesson does not need a company", bare.includes("remember"));
  ok("and escalate, which is never pruned", bare.includes("escalate"));
  // Why dropping them is safe, asserted rather than trusted to a comment.
  //
  // Both handlers open with `const [subject] = taskSubjects(task)` and refuse
  // when there is none, and `workflowAvailability` prunes on
  // `taskSubjects(task).length > 0` — the same expression, so the tool is
  // withheld in exactly the cases where it would have answered with an error.
  // Asserting the predicate is what keeps those two in step: if a handler ever
  // learns to do something useful without a subject, this is where it shows up.
  ok("a task about no record has no memory subject at all", taskSubjects(aboutNothing).length === 0);
  ok("and a task about a lead has one", taskSubjects(aboutLead).length > 0);
  ok("which is the condition the pruning reads", workflowAvailability(manager, aboutNothing, fresh(), 3).history === false);
  ok("and the condition it keeps them on", workflowAvailability(manager, aboutLead, fresh(), 3).history === true);

  console.log("\nAn allowance that has been spent");
  const exhausted = names(manager, aboutLead, spent(), 3);
  ok("consult is not sent once the allowance is gone", !exhausted.includes("consult"));
  ok("handOff is not sent once the hand-offs are gone", !exhausted.includes("handOff"));
  ok("findAgent survives both — looking is still free and still right", exhausted.includes("findAgent"));
  ok("delegate survives: a manager may always use its own reports", exhausted.includes("delegate"));

  console.log("\nNothing is dropped while it still works");
  const oneLeft: Counters = { ...fresh(), consulted: 2, consultedBy: { low: 0, medium: 2, high: 0 }, handedOff: 1 };
  const nearly = names(manager, aboutLead, oneLeft, 3);
  ok("one consult left means consult is still sent", nearly.includes("consult"));
  ok("one hand-off left means handOff is still sent", nearly.includes("handOff"));
  // The safe direction when the ceiling is unknown.
  const unknown = names(manager, aboutLead, spent());
  ok("with no ceiling worked out, consult is kept rather than guessed away", unknown.includes("consult"));

  console.log("\nA specialist");
  const sub = names(specialist, aboutLead, fresh(), 3);
  ok("has no delegate — it has nobody under it", !sub.includes("delegate"));
  ok("but can still ask sideways", sub.includes("handOff") && sub.includes("consult"));

  console.log("\nThe prompt says only what was sent");
  for (const [label, counters, task, limit] of [
    ["a subjectless task", fresh(), aboutNothing, 3],
    ["a spent allowance", spent(), aboutLead, 3],
    ["a spent allowance on a subjectless task", spent(), aboutNothing, 3],
  ] as [string, Counters, AgentTask, number][]) {
    const can = workflowAvailability(manager, task, counters, limit);
    const sent = new Set(workflowTools(manager, task, counters, limit).map((t) => t.name));
    const regions = await composePrompt(manager, [], { can });
    const prompt = regions.map((r) => r.text).join("\n");
    for (const tool of ["addToHistory", "readHistory", "consult", "handOff"]) {
      if (sent.has(tool)) continue;
      ok(`${label}: the prompt does not tell it to use \`${tool}\``, !prompt.includes(`\`${tool}\``));
    }
    // And the other direction, which is the one that would make an agent worse.
    for (const tool of ["findAgent", "needSkill"]) {
      ok(`${label}: the prompt still names \`${tool}\``, prompt.includes(`\`${tool}\``));
    }
    // The ladder is renumbered rather than left with holes in it.
    const steps = [...prompt.matchAll(/^(\d)\. `/gm)].map((m) => Number(m[1]));
    ok(`${label}: the routing ladder is numbered without gaps`, steps.every((n, i) => n === i + 1), steps.join(","));
  }

  console.log("\nThe Agents screen still shows the whole job");
  const shown = await composePrompt(manager, []);
  const shownText = shown.map((r) => r.text).join("\n");
  for (const tool of ["addToHistory", "readHistory", "consult", "handOff"]) {
    ok(`with no task in hand the compiled prompt still describes \`${tool}\``, shownText.includes(`\`${tool}\``));
  }

  console.log("\nWhat it is worth");
  const agents = await prisma.agent.findMany({ orderBy: { key: "asc" } });
  let richest = 0;
  let leanest = 0;
  for (const agent of agents) {
    richest += weigh((await toolsFor(agent, taskOn({ leadId: "lead-1", agentKey: agent.key }), fresh(), 3)).tools);
    leanest += weigh((await toolsFor(agent, taskOn({ agentKey: agent.key }), spent(), 3)).tools);
  }
  const perAgent = Math.round((richest - leanest) / agents.length);
  console.log(`  a task about a company with everything unspent: ${Math.round(richest / agents.length)} tok/agent`);
  console.log(`  a resumed task about no record:                 ${Math.round(leanest / agents.length)} tok/agent`);
  ok("pruning is worth something worth having, per turn", perAgent > 400, `${perAgent} tok/agent/turn`);
  // A saving that came from removing something an agent needed would show up
  // here as an implausibly large one.
  ok("and not so much that a capability went missing", perAgent < 1600, `${perAgent} tok/agent/turn`);

  await prisma.$disconnect();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
