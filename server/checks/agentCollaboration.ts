/**
 * When the work is not this agent's craft, does the agent actually reach the
 * right colleague?
 *
 * Before Aug 2026 an agent had two ways out of work it could not do: hand it
 * *down* to a report, or stop and ask a person. Neither is what a colleague
 * would do, and the result was agents attempting crafts that were not theirs.
 * The four workflow tools — `findAgent`, `consult`, `handOff`, `needSkill` —
 * are the answer, and the existing checks cover their *accounting*: how many
 * consults a priority buys, what a resume counts, that zero means zero. What
 * nothing covered is whether any of them does the thing it says.
 *
 * That is the gap this closes, and it is the difference between a roster and a
 * workforce. The assertions run against the **real seeded roster** rather than
 * a pair of harness agents, because the failure worth catching is a rename: the
 * one-job split renamed fourteen agents in a single pass, and a routing rule
 * that no longer finds anybody fails silently as "nobody here can do this",
 * which reads exactly like an honest gap.
 *
 * The negatives are the half that matter:
 *
 *   - **Delegation goes down the chart and nowhere else.** An agent handing
 *     work sideways or upward is routing around whoever owns that lane.
 *   - **A paused or retired colleague is not a destination**, on either tool.
 *   - **A hand-off to somebody who does not exist is refused**, rather than
 *     quietly filing a task against a key nobody holds.
 *   - **`findAgent` names the route, not only the craftsman.** An executive
 *     told about a specialist four rungs down, with no road to it but
 *     `handOff`, spends both hand-offs and never asks the director who owns
 *     that lane. That is a real whole-floor run, not a hypothetical.
 *   - **A gap is only raised for a craft nobody has.**
 *
 * `consult` is the one tool here that makes a model call, so what is asserted
 * about it is everything up to the wire — who it will and will not ask, and
 * what it does when the allowance is gone. The call itself is covered by
 * `checks/agentSpendAndOutages.ts`.
 *
 * A database and nothing else. No API key, no network.
 *   npx tsx checks/agentCollaboration.ts
 */
import type { Agent, AgentTask } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { ensureAgents } from "../src/services/agentRegistry.js";
import { searchRoster } from "../src/services/agents/hiring.js";
import { workflowTools, type Counters } from "../src/services/agents/runner.js";
import { recordCreated } from "../src/services/agents/state.js";

const failures: string[] = [];
let passed = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const OUTSIDER = "tmp.collab.outsider";
const HARNESS_TASK_TITLE = "Collaboration harness task";

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

async function reset() {
  const tasks = await prisma.agentTask.findMany({
    where: { OR: [{ title: HARNESS_TASK_TITLE }, { agentKey: OUTSIDER }, { title: { startsWith: "Collab:" } }] },
    select: { id: true },
  });
  const ids = tasks.map((task) => task.id);
  if (ids.length > 0) {
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.agentGap.deleteMany({ where: { skillNeeded: { contains: "underwater basket" } } });
  await prisma.agent.deleteMany({ where: { key: OUTSIDER } });
}

/** A task belonging to `agent`, real enough for the tools to write against. */
async function taskFor(agent: Agent): Promise<AgentTask> {
  const task = await prisma.agentTask.create({
    data: { agentKey: agent.key, title: HARNESS_TASK_TITLE, brief: "Exists so the workflow tools have something to hang off.", origin: "OWNER", status: "RUNNING" },
  });
  await recordCreated(task.id, task.traceId, "QUEUED", { reason: "Harness.", actor: "check" });
  return task;
}

const toolOf = (agent: Agent, task: AgentTask, counters: Counters, name: string) =>
  workflowTools(agent, task, counters, 3).find((tool) => tool.name === name);

async function main() {
  await reset();
  await ensureAgents();

  // A director with reports, taken from the real chart rather than invented.
  const director = await prisma.agent.findFirstOrThrow({
    where: { key: { in: (await prisma.agent.findMany({ where: { managerKey: { not: null } }, select: { managerKey: true } })).map((a) => a.managerKey!) } },
    orderBy: { key: "asc" },
  });
  const report = await prisma.agent.findFirstOrThrow({ where: { managerKey: director.key }, orderBy: { key: "asc" } });
  const task = await taskFor(director);
  console.log(`\nUsing ${director.name} (\`${director.key}\`) and its report ${report.name} (\`${report.key}\`).`);

  // --- findAgent --------------------------------------------------------------
  console.log("\nLooking for a colleague");

  const find = toolOf(director, task, fresh(), "findAgent")!;
  const forVideo = await find.run({ need: "edit a video" });
  check("a craft the roster has is found", !String(forVideo.content).includes("Nobody on the roster"), String(forVideo.content).slice(0, 90));
  const forNothing = await find.run({ need: "underwater basket weaving for cats" });
  check("a craft it does not have says so plainly", String(forNothing.content).includes("Nobody on the roster"));
  check("and points at needSkill rather than at trying anyway", String(forNothing.content).includes("needSkill"));

  const matches = await searchRoster("write a proposal", director.key);
  check("the search never returns the agent doing the asking", !matches.some((m) => m.key === director.key));
  check("and never a retired one", !matches.some((m) => m.status === "RETIRED"));

  // A manager with no route to another branch of the chart correctly has none
  // to offer — the route only exists where the match sits under one of the
  // asker's own reports. So the case worth asserting is the one that produced
  // the defect: an executive at the top, searching for a craft several rungs
  // down, which used to be handed the specialist and no road to it.
  const chief = await prisma.agent.findFirst({ where: { key: "ceo" } });
  if (chief) {
    const fromTheTop = await searchRoster("write a proposal for a client", chief.key);
    const routed = fromTheTop.filter((m) => m.through);
    const reports = fromTheTop.filter((m) => m.reportsToYou);
    check(
      "from the top of the chart, a match is reachable — by delegation or through somebody",
      routed.length + reports.length > 0,
      `${fromTheTop.length} matches, ${routed.length} with a route, ${reports.length} direct reports`,
    );
    // The sentence the agent actually reads, which is the half that changes
    // what it does: naming the craftsman alone is what spent both hand-offs.
    const chiefTask = await taskFor(chief);
    const chiefFind = toolOf(chief, chiefTask, fresh(), "findAgent")!;
    const rendered = String((await chiefFind.run({ need: "write a proposal for a client" })).content);
    check(
      "and the agent is told how to get there, not just who it is",
      rendered.includes("delegate") || rendered.includes("reports to you"),
      rendered.slice(0, 160),
    );
    // Every route offered has to be walkable. `routeTo` builds the chart out of
    // the same rows the search runs over, so a retired agent part-way up breaks
    // the chain and the route should come back null rather than naming somebody
    // who no longer works here.
    const live = new Set((await prisma.agent.findMany({ where: { status: { not: "RETIRED" } }, select: { key: true } })).map((a) => a.key));
    check(
      "every route offered points through somebody who is still here",
      routed.every((m) => m.through !== null && live.has(m.through.key)),
      routed.map((m) => m.through?.key).join(","),
    );
  }

  // --- delegate ---------------------------------------------------------------
  console.log("\nHanding work down the chart");

  const delegate = toolOf(director, task, fresh(), "delegate")!;
  const down = await delegate.run({ agentKey: report.key, title: "Collab: a piece of the work", brief: "Everything they need, written as if to somebody who was not here." });
  check("a report takes the work", !down.isError, String(down.content).slice(0, 90));
  const child = await prisma.agentTask.findFirst({ where: { title: "Collab: a piece of the work" } });
  check("and a real task is queued for them", child?.agentKey === report.key, String(child?.agentKey));
  check("carrying the brief they were given", (child?.brief ?? "").includes("somebody who was not here"));
  check("marked as coming from an agent, under the task it came out of", child?.origin === "AGENT" && child?.parentId === task.id);

  // The negative that keeps the chart meaningful.
  const sideways = await delegate.run({ agentKey: director.key === report.managerKey ? OUTSIDER : director.key, title: "Collab: sideways", brief: "Twenty characters at least, easily." });
  check("delegating to somebody who is not your report is refused", sideways.isError === true, String(sideways.content).slice(0, 90));
  const nobody = await delegate.run({ agentKey: "no.such.agent", title: "Collab: nobody", brief: "Twenty characters at least, easily." });
  check("delegating to an agent that does not exist is refused", nobody.isError === true, String(nobody.content).slice(0, 90));

  // A paused colleague is not a destination — pausing is something a person did.
  const was = report.status;
  await prisma.agent.update({ where: { key: report.key }, data: { status: "PAUSED" } });
  const toPaused = await delegate.run({ agentKey: report.key, title: "Collab: to a paused agent", brief: "Twenty characters at least, easily." });
  check("delegating to a paused colleague is refused", toPaused.isError === true, String(toPaused.content).slice(0, 90));
  check("and no task is queued against them", !(await prisma.agentTask.findFirst({ where: { title: "Collab: to a paused agent" } })));
  await prisma.agent.update({ where: { key: report.key }, data: { status: was } });

  // --- handOff ----------------------------------------------------------------
  console.log("\nHanding work sideways");

  const outsider = await prisma.agent.create({
    data: {
      key: OUTSIDER,
      name: "Collab Outsider",
      title: "Harness",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      mission: "Exists so a sideways hand-off has somewhere to go.",
      toolkit: [],
    },
  });

  const counters = fresh();
  const handOff = toolOf(director, task, counters, "handOff")!;
  const across = await handOff.run({ agentKey: outsider.key, title: "Collab: across the chart", brief: "Everything they need, written out in full for somebody who was not here.", why: "It is their craft and not mine." });
  check("an agent that does not report to you can still be handed work", !across.isError, String(across.content).slice(0, 90));
  const handed = await prisma.agentTask.findFirst({ where: { title: "Collab: across the chart" } });
  check("and gets a real task", handed?.agentKey === outsider.key, String(handed?.agentKey));
  // A hand-off goes sideways across the chart, so unlike a delegation it has to
  // carry a reason a person would accept — and the person who reads it is the
  // agent receiving it, in the brief.
  check("the reason travels on the brief the receiving agent reads", (handed?.brief ?? "").includes("their craft and not mine"), (handed?.brief ?? "").slice(-90));
  check("naming who handed it over", (handed?.brief ?? "").includes(director.name), (handed?.brief ?? "").slice(-90));
  const handOffStep = await prisma.agentTaskStep.findFirst({ where: { taskId: task.id, kind: "HANDED_OFF" } });
  check("and it is on the handing agent's own timeline", Boolean(handOffStep), "no HANDED_OFF step written");
  check("it is counted against the task's two", counters.handedOff === 1, String(counters.handedOff));

  const unknown = await handOff.run({ agentKey: "no.such.agent", title: "Collab: nobody", brief: "Everything they need, written out in full for somebody who was not here.", why: "Testing." });
  check("handing to an agent that does not exist is refused", unknown.isError === true, String(unknown.content).slice(0, 90));
  check("and files nothing", !(await prisma.agentTask.findFirst({ where: { title: "Collab: nobody" } })));

  // The cap, which is what makes a third piece an escalation about the brief.
  const spentCounters: Counters = { ...fresh(), handedOff: 2 };
  const cappedTool = workflowTools(director, task, spentCounters, 3).find((t) => t.name === "handOff");
  check("once both are spent the tool is not even offered", !cappedTool);
  // ...and the handler refuses on its own too, which is what makes the pruning
  // an optimisation rather than the guard. The tool is built while there is
  // still allowance left and the counter is spent underneath it — the closure
  // holds the same object, which is exactly what happens within a run.
  const drifting = fresh();
  const builtEarly = toolOf(director, task, drifting, "handOff")!;
  drifting.handedOff = 2;
  const third = await builtEarly.run({
    agentKey: outsider.key,
    title: "Collab: a third piece",
    brief: "Everything they need, written out in full for somebody who was not here.",
    why: "Testing the cap.",
  });
  check("the handler refuses a third even when the tool was already in hand", third.isError === true, String(third.content).slice(0, 90));
  check("and says an escalation is the honest answer to a brief with three crafts in it", String(third.content).includes("escalate"));
  check("filing nothing", !(await prisma.agentTask.findFirst({ where: { title: "Collab: a third piece" } })));

  // --- needSkill --------------------------------------------------------------
  console.log("\nSaying nobody here can do this");

  const gapCounters = fresh();
  const needSkill = toolOf(director, task, gapCounters, "needSkill")!;
  await needSkill.run({ skill: "underwater basket weaving", reason: "The client asked for it and nobody here does it.", blocking: false });
  const gap = await prisma.agentGap.findFirst({ where: { skillNeeded: { contains: "underwater basket" } } });
  check("a gap is recorded for a craft nobody has", Boolean(gap));
  check("naming who asked", (gap?.requestedByKeys ?? []).includes(director.key), (gap?.requestedByKeys ?? []).join(","));

  // Demand is counted before it is met: the same agent asking twice is one
  // request, a second agent asking is a second.
  await needSkill.run({ skill: "underwater basket weaving", reason: "Asking again about the same thing.", blocking: false });
  const afterSecond = await prisma.agentGap.findFirst({ where: { skillNeeded: { contains: "underwater basket" } } });
  check("the same agent asking twice does not open a second gap", (await prisma.agentGap.count({ where: { skillNeeded: { contains: "underwater basket" } } })) === 1);
  check("nor count as two agents wanting it", (afterSecond?.requestedByKeys ?? []).length === 1, (afterSecond?.requestedByKeys ?? []).join(","));

  // --- consult ----------------------------------------------------------------
  console.log("\nAsking a colleague, up to the wire");

  const consultCounters = fresh();
  const consult = toolOf(director, task, consultCounters, "consult")!;
  const askNobody = await consult.run({ agentKey: "no.such.agent", question: "Would this scope need a designer at all?" });
  check("consulting somebody who does not exist is refused", askNobody.isError === true, String(askNobody.content).slice(0, 90));
  check("and spends nothing", consultCounters.consulted === 0, String(consultCounters.consulted));

  await prisma.agent.update({ where: { key: outsider.key }, data: { status: "RETIRED" } });
  const askRetired = await consult.run({ agentKey: outsider.key, question: "Would this scope need a designer at all?" });
  check("consulting a retired colleague is refused", askRetired.isError === true, String(askRetired.content).slice(0, 90));
  check("and spends nothing either", consultCounters.consulted === 0, String(consultCounters.consulted));

  const askSelf = await consult.run({ agentKey: director.key, question: "Would this scope need a designer at all?" });
  check("an agent cannot consult itself", askSelf.isError === true, String(askSelf.content).slice(0, 90));

  await reset();
  await prisma.$disconnect();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
