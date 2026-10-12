/**
 * Is an agent sent a tool it could not possibly use?
 *
 * Every agent carries ten workflow tools on top of its own — escalate,
 * remember, update_living_context, the two history ones, delegate, and the
 * four for working with colleagues. Measured against the seeded roster (see
 * the tripwire at the bottom, which prints it) they are about three quarters
 * of the tool schema a typical turn sends. So most of what a turn spends
 * before it does anything is the scaffolding for asking somebody else, and a
 * good part of that is provably dead on arrival:
 *
 *   - `addToHistory` and `readHistory` both refuse when the task is not about a
 *     lead, a client or a project and names none. There is no company to have
 *     a history — except in standing work, which is about a batch and names
 *     one per call, so a scheduled task keeps them.
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
import { AGENT_SEEDS, ensureAgents } from "../src/services/agentRegistry.js";
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
  ok("a manager with a subject gets all ten workflow tools", full.length === 10, `${full.length}: ${full.join(", ")}`);
  ok("update_living_context among them", full.includes("update_living_context"));

  console.log("\nA task about no record at all");
  const aboutNothing = taskOn({});
  const bare = names(manager, aboutNothing, fresh(), 3);
  ok("addToHistory is not sent — it could only refuse", !bare.includes("addToHistory"));
  ok("nor readHistory", !bare.includes("readHistory"));
  ok("but remember still is: a lesson does not need a company", bare.includes("remember"));
  ok("and escalate, which is never pruned", bare.includes("escalate"));
  // Why dropping them is safe, asserted rather than trusted to a comment.
  //
  // Both handlers take the task's first subject when they are not handed a
  // `record`, and refuse when there is neither; `workflowAvailability` prunes
  // on `taskSubjects(task).length > 0` — the same expression — except for
  // standing work, where naming a record per call is the whole job. Asserting
  // the predicate is what keeps those in step: if a handler ever learns to do
  // something useful without a subject, this is where it shows up.
  ok("a task about no record has no memory subject at all", taskSubjects(aboutNothing).length === 0);
  ok("and a task about a lead has one", taskSubjects(aboutLead).length > 0);
  ok("which is the condition the pruning reads", workflowAvailability(manager, aboutNothing, fresh(), 3).history === false);
  ok("and the condition it keeps them on", workflowAvailability(manager, aboutLead, fresh(), 3).history === true);

  console.log("\nStanding work, about a batch rather than one record");
  const standing = taskOn({ origin: "SCHEDULE" });
  const batch = names(manager, standing, fresh(), 3);
  ok("a scheduled task about no record keeps readHistory — it names a record per call", batch.includes("readHistory"));
  ok("and addToHistory", batch.includes("addToHistory"));
  ok("which the pruning predicate agrees with", workflowAvailability(manager, standing, fresh(), 3).history === true);
  ok("an Owner's errand about no record still does not get them", !bare.includes("readHistory") && workflowAvailability(manager, aboutNothing, fresh(), 3).history === false);

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

  console.log("\nupdate_living_context is never pruned");
  for (const [label, list] of [
    ["about a company", full],
    ["about no record", bare],
    ["standing work", batch],
    ["a spent allowance", exhausted],
    ["one of each left", nearly],
    ["no ceiling worked out", unknown],
    ["a specialist", sub],
  ] as [string, string[]][]) {
    ok(`${label}: update_living_context is sent`, list.includes("update_living_context"));
  }

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

  // --- A tripwire on the weight of a turn -----------------------------------
  //
  // What every agent is sent before it does anything: the system prompt and
  // the tool schemas. Measured from the seeds rather than the rows, so an
  // Owner's own rewrite of one agent cannot trip it, and with the regions that
  // carry live business state — the company profile, the brand, the catalogue
  // — left out, because those grow with the business and not with this code.
  // A change that makes every turn of every agent ten per cent heavier should
  // be a decision somebody made on purpose, so it fails here until the numbers
  // below are moved by hand, with a reason in the commit.
  console.log("\nThe weight of a turn, per agent, from the seeds");
  const LIVE_REGIONS = new Set(["brand", "contact", "commercial"]);
  const SYSTEM_CHARS_PER_AGENT = 11_131;
  const TOOL_CHARS_PER_AGENT = 14_848;
  let systemChars = 0;
  let toolChars = 0;
  for (const seed of AGENT_SEEDS) {
    const agent = {
      ...seed,
      managerKey: seed.managerKey ?? null,
      skills: seed.skills ?? [],
      not_responsible: seed.not_responsible ?? [],
      not_responsible_subject: seed.not_responsible_subject ?? [],
      avatar: null,
      promptEditedAt: null,
    } as unknown as Agent;
    const task = taskOn({ leadId: "lead-1", agentKey: seed.key });
    const regions = await composePrompt(agent, [], { can: workflowAvailability(agent, task, fresh(), 3) });
    systemChars += regions.filter((region) => !LIVE_REGIONS.has(region.key)).reduce((total, region) => total + region.text.length, 0);
    const sent = (await toolsFor(agent, task, fresh(), 3)).tools;
    toolChars += JSON.stringify(sent.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))).length;
  }
  const systemPer = Math.round(systemChars / AGENT_SEEDS.length);
  const toolPer = Math.round(toolChars / AGENT_SEEDS.length);
  console.log(`  ${AGENT_SEEDS.length} seeded agents`);
  console.log(`  system prompt, without live business state: ${systemPer} chars/agent (recorded ${SYSTEM_CHARS_PER_AGENT})`);
  console.log(`  tool schemas, on a task about a company:    ${toolPer} chars/agent (recorded ${TOOL_CHARS_PER_AGENT})`);
  ok("the system prompt has not grown more than 10% past what was recorded", systemPer <= SYSTEM_CHARS_PER_AGENT * 1.1, `${systemPer} > ${Math.round(SYSTEM_CHARS_PER_AGENT * 1.1)}`);
  ok("nor have the tool schemas", toolPer <= TOOL_CHARS_PER_AGENT * 1.1, `${toolPer} > ${Math.round(TOOL_CHARS_PER_AGENT * 1.1)}`);

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
