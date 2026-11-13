/**
 * Sub-tasks in order, and a parent that hears how they ended
 * (`services/agents/waiting.ts`).
 *
 * A sub-task used to start the moment its skill was free and its parent never
 * read the result. What this holds still:
 *
 *  1. **`after`**: a sub-task raised after another carries that one's id, is
 *     named `s1`, `s2` in the order raised, and a reference to something not
 *     raised yet is refused with the ones that exist.
 *  2. **The wait**: a waiting task is not ready while what it waits for is
 *     queued, running or blocked on a person; it is ready once that has ended,
 *     failed, been cancelled or been deleted — and when the skill it waits on
 *     takes no work at all, which must not be a wait for ever.
 *  3. **`awaitSubtasks`**: refused with nothing raised; stops the run and names
 *     every sub-task while one is still going; answers at once, without
 *     stopping, when all have ended; and is capped.
 *  4. **The hand-over**: a parent is told to check each result against what it
 *     asked for, a dependent is handed the results as material, and both are
 *     told plainly when a piece did not finish.
 *
 * A database and nothing else. No model is called.
 *   npx tsx checks/delegationOrder.ts
 */
process.env.AGENTS_MODE = "orchestrator";

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

const { prisma } = await import("../src/lib/prisma.js");
const { ensureAgents } = await import("../src/services/agentRegistry.js");
const { workflowTools } = await import("../src/services/agents/runner.js");
const { MAX_WAITS, endedAs, openSubtasks, readyToCarryOn, resolveAfter, subtaskRef, waitedResults } = await import("../src/services/agents/waiting.js");
type Counters = import("../src/services/agents/runner.js").Counters;

const TITLE = "Delegation order check:";
const DRAFT_SKILL = "tmp.delegation.draft";

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

const restore: Array<{ key: string; status: "DRAFT" | "ACTIVE" | "PAUSED" | "RETIRED" }> = [];

async function reset() {
  for (const row of restore.splice(0)) await prisma.agent.updateMany({ where: { key: row.key }, data: { status: row.status } });
  const tasks = await prisma.agentTask.findMany({ where: { title: { startsWith: TITLE } }, select: { id: true } });
  const ids = tasks.map((task) => task.id);
  if (ids.length > 0) {
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    // Children before parents: the delegation relation points upward.
    await prisma.agentTask.deleteMany({ where: { id: { in: ids }, parentId: { not: null } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.agent.deleteMany({ where: { key: DRAFT_SKILL } });
}

async function activate(key: string) {
  const row = await prisma.agent.findUniqueOrThrow({ where: { key }, select: { status: true } });
  restore.push({ key, status: row.status });
  await prisma.agent.update({ where: { key }, data: { status: "ACTIVE" } });
}

async function main() {
  await reset();
  await ensureAgents();

  // A manager and two skills that do not report to it, from the real roster.
  const manager = await prisma.agent.findFirstOrThrow({ where: { tier: { not: "SUB_AGENT" }, status: { notIn: ["RETIRED", "PAUSED"] } }, orderBy: { key: "asc" } });
  const [first, second] = await prisma.agent.findMany({
    where: { tier: "SUB_AGENT", status: { notIn: ["RETIRED", "PAUSED"] }, key: { not: manager.key } },
    orderBy: { key: "asc" },
    take: 2,
  });
  await activate(first.key);
  await activate(second.key);

  const parent = await prisma.agentTask.create({
    data: { agentKey: manager.key, title: `${TITLE} parent`, brief: "Audit the site, then write the letter from the audit, then say what was sent.", origin: "OWNER", status: "RUNNING" },
  });
  const counters = fresh();
  const tool = (name: string) => workflowTools(manager, parent, counters, 3).find((entry) => entry.name === name)!;

  // --- 1. `after` --------------------------------------------------------------
  console.log("\nRaising work in order");
  {
    check("a manager is offered awaitSubtasks beside delegate", Boolean(tool("delegate")) && Boolean(tool("awaitSubtasks")));

    const nothingYet = await tool("awaitSubtasks").run({ reason: "To report what was done." });
    check("waiting with nothing raised is refused", nothingYet.isError === true && nothingYet.stop !== true, String(nothingYet.content).slice(0, 80));

    const early = await tool("delegate").run({ agentKey: second.key, title: `${TITLE} too early`, brief: "A piece raised after work that does not exist yet.", after: ["s1"] });
    check("naming an earlier sub-task before any exists is refused", early.isError === true, String(early.content).slice(0, 100));
    check("and nothing was queued for it", (await prisma.agentTask.count({ where: { parentId: parent.id } })) === 0);

    const audit = await tool("delegate").run({ agentKey: first.key, title: `${TITLE} audit`, brief: "Audit the homepage and report the top three faults.", acceptance: ["Names three faults"] });
    check("an independent piece is queued", audit.isError !== true, String(audit.content).slice(0, 100));
    check("and is told its reference, s1", String(audit.content).includes("s1"), String(audit.content).slice(0, 140));

    const letter = await tool("delegate").run({ agentKey: second.key, title: `${TITLE} letter`, brief: "Write the first letter, arguing from the audit's findings.", after: ["s1"] });
    check("a dependent piece is queued", letter.isError !== true, String(letter.content).slice(0, 100));
    check("and is told what it starts after", String(letter.content).includes("starts when"), String(letter.content).slice(0, 160));

    const wrong = await tool("delegate").run({ agentKey: second.key, title: `${TITLE} unknown`, brief: "A piece raised after a reference that is not there.", after: ["s9"] });
    check("an unknown reference is refused, naming the ones that exist", wrong.isError === true && String(wrong.content).includes("s1"), String(wrong.content).slice(0, 140));
  }

  const children = await prisma.agentTask.findMany({ where: { parentId: parent.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const [auditTask, letterTask] = children;

  // --- 2. The wait -------------------------------------------------------------
  console.log("\nThe wait");
  {
    check("two sub-tasks exist, and no third", children.length === 2, String(children.length));
    check("the independent one waits for nothing", auditTask.waitsFor.length === 0, auditTask.waitsFor.join(","));
    check("the dependent one waits for the audit", letterTask.waitsFor.length === 1 && letterTask.waitsFor[0] === auditTask.id, letterTask.waitsFor.join(","));
    check("references follow the order raised", (await subtaskRef(parent.id, auditTask.id)) === "s1" && (await subtaskRef(parent.id, letterTask.id)) === "s2");

    const byTitle = await resolveAfter(parent.id, [auditTask.title.toUpperCase()]);
    check("an exact title works as a reference too", "ids" in byTitle && byTitle.ids[0] === auditTask.id);

    check("not ready while the audit is queued", !(await readyToCarryOn()).includes(letterTask.id));
    await prisma.agentTask.update({ where: { id: auditTask.id }, data: { status: "RUNNING" } });
    check("nor while it runs", !(await readyToCarryOn()).includes(letterTask.id));
    await prisma.agentTask.update({ where: { id: auditTask.id }, data: { status: "BLOCKED", blockedReason: "Which page is the homepage?" } });
    check("nor while it has asked a person a question", !(await readyToCarryOn()).includes(letterTask.id));
    check("a blocked task has not ended", !endedAs({ status: "BLOCKED", agent: { name: "x", status: "ACTIVE" } }).ended);

    await prisma.agentTask.update({ where: { id: auditTask.id }, data: { status: "DONE", summary: "Three faults: an expired certificate, no phone number, a 9 second load." } });
    check("ready once the audit is done", (await readyToCarryOn()).includes(letterTask.id));

    const handed = await waitedResults(letterTask, letterTask.waitsFor, "dependent");
    check("the dependent is handed the audit's result", handed.includes("expired certificate") && handed.includes("s1"), handed.slice(0, 200));
    check("with the checks that were set for it", handed.includes("Names three faults"));
    check("as material to build on", handed.includes("Build on it"));

    await prisma.agentTask.update({ where: { id: auditTask.id }, data: { status: "FAILED", error: "The site did not answer." } });
    check("a failed piece also ends the wait", (await readyToCarryOn()).includes(letterTask.id));
    const failed = await waitedResults(letterTask, letterTask.waitsFor, "dependent");
    check("and the dependent is told a piece did not finish", failed.includes("did not finish") && failed.includes("did not answer"), failed.slice(0, 200));

    // A skill that takes no work: the wait must end, and say why.
    await prisma.agent.create({
      data: { key: DRAFT_SKILL, name: "Draft Skill (check)", title: "Check fixture", tier: "SUB_AGENT", department: "DELIVERY", status: "DRAFT", mission: "Exists to be a draft.", custom: true },
    });
    const stuck = await prisma.agentTask.create({ data: { agentKey: DRAFT_SKILL, title: `${TITLE} never starts`, brief: "Queued under a skill that is a draft.", origin: "AGENT", parentId: parent.id } });
    const waiter = await prisma.agentTask.create({ data: { agentKey: second.key, title: `${TITLE} waits on a draft`, brief: "Waits for work a draft skill holds.", origin: "AGENT", parentId: parent.id, waitsFor: [stuck.id] } });
    check("work queued under a draft skill does not hold anything for ever", (await readyToCarryOn()).includes(waiter.id));
    const never = await waitedResults(waiter, waiter.waitsFor, "dependent");
    check("and it is said that it never started", never.includes("NOT STARTED"), never.slice(0, 200));

    await prisma.agentTask.delete({ where: { id: stuck.id } });
    check("nor does work that no longer exists", (await readyToCarryOn()).includes(waiter.id));
    await prisma.agentTask.delete({ where: { id: waiter.id } });
  }

  // --- 3. awaitSubtasks --------------------------------------------------------
  console.log("\nWaiting for the results");
  {
    await prisma.agentTask.update({ where: { id: auditTask.id }, data: { status: "DONE", error: null, summary: "Three faults: an expired certificate, no phone number, a 9 second load." } });
    const { open, all } = await openSubtasks(parent.id);
    check("one sub-task is still open", open.length === 1 && all.length === 2, `${open.length}/${all.length}`);

    const stopped = await tool("awaitSubtasks").run({ reason: "To check the letter against the audit and report what was sent." });
    check("with one still going, the run stops", stopped.stop === true && stopped.isError !== true, String(stopped.content).slice(0, 100));
    check("holding every sub-task it raised, not only the open one", counters.waitingOn?.length === 2, String(counters.waitingOn?.length));
    check("and the wait is counted", counters.waited === 1, String(counters.waited));

    await prisma.agentTask.update({ where: { id: letterTask.id }, data: { status: "NEEDS_APPROVAL", summary: "Letter prepared, leading on the expired certificate." } });
    counters.waitingOn = undefined;
    const atOnce = await tool("awaitSubtasks").run({ reason: "To report what was sent." });
    check("with all ended, it answers at once and does not stop", atOnce.stop !== true && atOnce.isError !== true, String(atOnce.content).slice(0, 80));
    check("the answer is both results", String(atOnce.content).includes("expired certificate") && String(atOnce.content).includes("Letter prepared"));
    check("prepared work is said to be waiting for approval, not done", String(atOnce.content).includes("waiting for a person's approval"));
    check("and the parent is told to check them", String(atOnce.content).includes("Check each result"));
    check("an immediate answer spends no wait", counters.waited === 1, String(counters.waited));

    await prisma.agentTask.update({ where: { id: letterTask.id }, data: { status: "RUNNING" } });
    counters.waited = MAX_WAITS;
    const capped = await tool("awaitSubtasks").run({ reason: "To wait a fourth time." });
    check(`a wait past ${MAX_WAITS} is refused`, capped.isError === true && capped.stop !== true, String(capped.content).slice(0, 100));

    const specialist = workflowTools(first, parent, fresh(), 3).map((entry) => entry.name);
    check("a specialist with hand-offs left is offered it too", specialist.includes("awaitSubtasks") && !specialist.includes("delegate"), specialist.join(", "));
  }

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
