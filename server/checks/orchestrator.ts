/**
 * One agent, many skills (`services/agents/orchestrator.ts`).
 *
 * In orchestrator mode there is one agent and every other row in the Agent
 * table is one of its skills. What this holds still:
 *
 *  1. **Choosing the skill**, as pure functions over the real seeds: an
 *     unmistakable task goes to its skill on the rules alone; an ambiguous one
 *     is asked about (the fake here) and never guessed; a task nothing fits
 *     stays with the orchestrator; "care plan" is a product, not the verb
 *     "plan".
 *  2. **The dispatch**: a task given to the orchestrator is moved to the
 *     chosen skill once, with one step saying why, and is never moved again.
 *  3. **One memory**: what one skill concluded about a record is recalled by
 *     another skill working that record — and a skill's lessons about its own
 *     craft are not.
 *  4. **What must not change**: the row is created ACTIVE holding nothing that
 *     writes, sends or spends; pausing it stops everything; and `roster` puts
 *     every rule back.
 *
 * A database and nothing else. No model is called.
 *   npx tsx checks/orchestrator.ts
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
const { SETTING, clearSettingsCache } = await import("../src/lib/settings.js");
const { AGENT_SEEDS, ensureAgents } = await import("../src/services/agentRegistry.js");
const { listAllTools } = await import("../src/services/tools/catalogue.js");
const { recall, remember } = await import("../src/services/agents/memory.js");
const { composePrompt, step, workflowTools } = await import("../src/services/agents/runner.js");
const { recordCreated } = await import("../src/services/agents/state.js");
const {
  DISPATCH_TOOL,
  ORCHESTRATOR_KEY,
  agentMode,
  chooseSkill,
  dispatchOrchestratorTasks,
  ensureOrchestrator,
  isClearWinner,
  orchestratorHalted,
  rankSkills,
} = await import("../src/services/agents/orchestrator.js");
type SkillCandidate = import("../src/services/agents/orchestrator.js").SkillCandidate;

const TITLE = "Orchestrator check:";
const SUBJECT = "lead:orchestrator-check-subject";

const seeds: SkillCandidate[] = AGENT_SEEDS.map((seed) => ({
  key: seed.key,
  name: seed.name,
  title: seed.title,
  mission: seed.mission,
  skills: seed.skills ?? [],
  status: "ACTIVE",
  tier: seed.tier,
}));

function setMode(mode: "orchestrator" | "roster") {
  process.env.AGENTS_MODE = mode;
  clearSettingsCache();
}

let writerStatus: "DRAFT" | "ACTIVE" | "PAUSED" | "RETIRED" | null = null;

async function reset() {
  if (writerStatus) {
    await prisma.agent.updateMany({ where: { key: "outreach.writer" }, data: { status: writerStatus } });
    writerStatus = null;
  }
  const tasks = await prisma.agentTask.findMany({ where: { title: { startsWith: TITLE } }, select: { id: true } });
  const ids = tasks.map((task) => task.id);
  if (ids.length > 0) {
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.agentMemory.deleteMany({ where: { content: { startsWith: "Orchestrator check" } } });
  await prisma.agent.deleteMany({ where: { key: ORCHESTRATOR_KEY } });
  await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_ORCHESTRATOR_OFFERED } });
  clearSettingsCache();
}

const writeStep = (taskId: string, kind: "ROUTED", message: string, extra: { tool: string; data: Record<string, unknown> }) =>
  step(taskId, kind, message, extra);

async function main() {
  await reset();
  await ensureAgents();

  // --- 1. Choosing the skill --------------------------------------------------
  console.log("\nChoosing the skill");
  {
    const cold = await chooseSkill(
      { title: "Write a cold email to the Accra plumbing lead", brief: "First message to a plumbing company whose certificate has expired. Lead with that." },
      { candidates: seeds, ask: null },
    );
    check("a cold email goes to the Cold Lead Writer on the rules alone", cold.key === "outreach.writer" && cold.decidedBy === "rules", `${cold.key} ${cold.decidedBy}`);

    const seo = await chooseSkill({ title: "Audit this website's SEO", brief: "Run a technical SEO audit of the homepage and report the top three faults." }, { candidates: seeds, ask: null });
    check("an SEO audit goes to the SEO Specialist", seo.key === "seo.specialist", String(seo.key));

    const vague = await chooseSkill({ title: "Do the thing", brief: "Please handle it." }, { candidates: seeds, ask: null });
    check("a task nothing fits stays with the orchestrator", vague.key === null && vague.decidedBy === "none", `${vague.key} ${vague.decidedBy}`);

    const plan = rankSkills("Plan next quarter. Decide the three priorities for the company and say what we stop doing.", seeds);
    check(
      "“plan” does not match the care-plan skills",
      !plan.slice(0, 3).some((entry) => entry.key.startsWith("careplan.")),
      plan.slice(0, 3).map((entry) => `${entry.key} ${entry.score}`).join(", "),
    );

    const logo = { title: "Design a logo", brief: "A new client needs a logo and brand colours." };
    const ranked = rankSkills(`${logo.title} ${logo.brief}`, seeds);
    check("an ambiguous task is not a clear winner", !isClearWinner(ranked), ranked.slice(0, 2).map((entry) => `${entry.key} ${entry.score}`).join(", "));

    const unasked = await chooseSkill(logo, { candidates: seeds, ask: null });
    check("with nobody to ask, it is never guessed", unasked.key === null, String(unasked.key));

    let shortlisted: string[] = [];
    const asked = await chooseSkill(logo, {
      candidates: seeds,
      ask: async (_task, shortlist) => {
        shortlisted = shortlist.map((skill) => skill.key);
        return { key: "design.graphic", reason: "A logo is artwork a client keeps." };
      },
    });
    check("the right skill was on the shortlist it was asked about", shortlisted.includes("design.graphic"), shortlisted.join(", "));
    check("and the answer is taken", asked.key === "design.graphic" && asked.decidedBy === "model", `${asked.key} ${asked.decidedBy}`);

    const invented = await chooseSkill(logo, { candidates: seeds, ask: async () => null });
    check("an unusable answer leaves it with the orchestrator", invented.key === null, String(invented.key));

    const spans = await chooseSkill(logo, { candidates: seeds, ask: async () => ({ key: null, reason: "It needs two crafts." }) });
    check("“none” from the look is an answer, and the task is kept", spans.key === null && spans.decidedBy === "model", `${spans.key} ${spans.decidedBy}`);
  }

  // --- 2. The row -------------------------------------------------------------
  console.log("\nThe orchestrator's own row");
  {
    check("unset, the mode is orchestrator", (await agentMode()) === "orchestrator");
    const first = await ensureOrchestrator();
    check("the first boot creates it", first === "created", first);
    const row = await prisma.agent.findUniqueOrThrow({ where: { key: ORCHESTRATOR_KEY } });
    check("active, so the master switch ships on", row.status === "ACTIVE", row.status);
    check("at the commissioned level, out of dry run", row.autonomyLevel === 2 && row.dryRun === false, `${row.autonomyLevel} ${row.dryRun}`);

    const catalogue = await listAllTools();
    const dangerous = row.toolkit.filter((key) => {
      const tool = catalogue.find((entry) => entry.key === key);
      return !tool || tool.scope !== "read" || tool.spends || tool.outward;
    });
    check("it holds nothing that writes, sends or spends", dangerous.length === 0, dangerous.join(", "));
    check("and it does hold reading tools", row.toolkit.length > 0, String(row.toolkit.length));

    const kept = row.toolkit.slice(1);
    await prisma.agent.update({ where: { key: ORCHESTRATOR_KEY }, data: { toolkit: kept, status: "PAUSED" } });
    const second = await ensureOrchestrator();
    const after = await prisma.agent.findUniqueOrThrow({ where: { key: ORCHESTRATOR_KEY } });
    check("a second boot changes nothing", second === "unchanged", second);
    check("a tool the Owner unticked stays unticked", after.toolkit.length === kept.length, `${after.toolkit.length} vs ${kept.length}`);
    check("and a paused orchestrator stays paused", after.status === "PAUSED", after.status);

    check("paused, it stops every skill", Boolean(await orchestratorHalted()), String(await orchestratorHalted()));
    await prisma.agent.update({ where: { key: ORCHESTRATOR_KEY }, data: { status: "ACTIVE" } });
    check("active, nothing is stopped", (await orchestratorHalted()) === null);
  }

  // --- 3. The dispatch --------------------------------------------------------
  console.log("\nThe dispatch");
  {
    // Put back by `reset()`: other checks read the roster in the state it ships in.
    writerStatus = (await prisma.agent.findUniqueOrThrow({ where: { key: "outreach.writer" }, select: { status: true } })).status;
    await prisma.agent.update({ where: { key: "outreach.writer" }, data: { status: "ACTIVE" } });
    const clear = await prisma.agentTask.create({
      data: {
        agentKey: ORCHESTRATOR_KEY,
        title: `${TITLE} Write a cold email to the Accra plumbing lead`,
        brief: "First cold email to a plumbing company whose certificate has expired. Lead with that.",
        origin: "OWNER",
      },
    });
    await recordCreated(clear.id, clear.traceId, clear.status, { reason: "Check.", actor: "check" });
    const vague = await prisma.agentTask.create({
      data: { agentKey: ORCHESTRATOR_KEY, title: `${TITLE} zzz`, brief: "Qqq www eee rrr ttt yyy.", origin: "OWNER" },
    });
    await recordCreated(vague.id, vague.traceId, vague.status, { reason: "Check.", actor: "check" });

    const moved = await dispatchOrchestratorTasks(writeStep);
    const clearNow = await prisma.agentTask.findUniqueOrThrow({ where: { id: clear.id } });
    const vagueNow = await prisma.agentTask.findUniqueOrThrow({ where: { id: vague.id } });
    check("the clear task was moved to its skill", clearNow.agentKey === "outreach.writer", clearNow.agentKey);
    check("and is still queued, for the claim to start", clearNow.status === "QUEUED", clearNow.status);
    check("the task nothing fits stays the orchestrator's", vagueNow.agentKey === ORCHESTRATOR_KEY, vagueNow.agentKey);
    check("one task counted as moved", moved >= 1, String(moved));

    const steps = await prisma.agentTaskStep.findMany({ where: { taskId: { in: [clear.id, vague.id] }, tool: DISPATCH_TOOL } });
    check("each has one step saying what was decided", steps.length === 2, String(steps.length));
    check("the step names the skill", steps.some((entry) => entry.taskId === clear.id && entry.message.includes("Cold Lead Writer")));

    await dispatchOrchestratorTasks(writeStep);
    const again = await prisma.agentTaskStep.count({ where: { taskId: { in: [clear.id, vague.id] }, tool: DISPATCH_TOOL } });
    check("a second pass decides nothing twice", again === 2, String(again));

    setMode("roster");
    const rosterTask = await prisma.agentTask.create({
      data: { agentKey: ORCHESTRATOR_KEY, title: `${TITLE} Write a cold email in roster mode`, brief: "First cold email to a lead about a cold start.", origin: "OWNER" },
    });
    await dispatchOrchestratorTasks(writeStep);
    const untouched = await prisma.agentTask.findUniqueOrThrow({ where: { id: rosterTask.id } });
    check("in roster mode nothing is dispatched", untouched.agentKey === ORCHESTRATOR_KEY, untouched.agentKey);
    setMode("orchestrator");
  }

  // --- 4. One memory ----------------------------------------------------------
  console.log("\nOne memory");
  {
    await remember({ agentKey: "outreach.writer", kind: "FACT", subject: SUBJECT, content: "Orchestrator check: the owner answers the phone before nine and never after." });
    await remember({ agentKey: "outreach.writer", kind: "LESSON", subject: "self", content: "Orchestrator check: a lesson about writing cold letters only the writer needs." });

    const asOne = await recall("proposal.writer", [SUBJECT], { everySkill: true });
    check("another skill is shown what was learnt about the record", asOne.some((memory) => memory.line.includes("answers the phone")));
    check("but not a different craft's lessons about itself", !asOne.some((memory) => memory.line.includes("cold letters only the writer")));

    const asRoster = await recall("proposal.writer", [SUBJECT]);
    check("on the roster, an agent's memory is still its own", !asRoster.some((memory) => memory.line.includes("answers the phone")));

    const other = await recall("proposal.writer", ["lead:somebody-else-entirely"], { everySkill: true });
    check("and recall is still by subject", !other.some((memory) => memory.line.includes("answers the phone")));
  }

  // --- 5. Speaking as one agent ------------------------------------------------
  console.log("\nThe prompt and the tools");
  {
    const skill = await prisma.agent.findUniqueOrThrow({ where: { key: "outreach.writer" } });
    const regions = await composePrompt(skill, []);
    const first = regions[0];
    check("the prompt opens as the orchestrator, naming the skill", first.key === "orchestrator" && first.text.includes(skill.name), first.key);
    const working = regions.find((region) => region.key === "working")?.text ?? "";
    check("and says it is the only agent", working.includes("You are the only agent here"));
    check("without the roster's paragraph", !working.includes("You are not working alone"));

    const consulted = await composePrompt(skill, [], { working: false });
    check("a consulted skill answers as its craft, not as the orchestrator", consulted[0].key !== "orchestrator", consulted[0].key);

    setMode("roster");
    const roster = await composePrompt(skill, []);
    check("in roster mode the prompt is the roster's", roster[0].key === "instruction" && (roster.find((region) => region.key === "working")?.text ?? "").includes("You are not working alone"));
    setMode("orchestrator");

    // Any skill may raise a sub-task under any other: one agent has nobody to route around.
    const manager = await prisma.agent.findFirstOrThrow({ where: { tier: { not: "SUB_AGENT" }, key: { notIn: [ORCHESTRATOR_KEY] }, status: { notIn: ["RETIRED", "PAUSED"] } }, orderBy: { key: "asc" } });
    const stranger = await prisma.agent.findFirstOrThrow({
      where: { managerKey: { not: manager.key }, key: { notIn: [manager.key, ORCHESTRATOR_KEY] }, status: { notIn: ["RETIRED", "PAUSED"] } },
      orderBy: { key: "asc" },
    });
    const parent = await prisma.agentTask.create({
      data: { agentKey: manager.key, title: `${TITLE} parent`, brief: "Exists so delegate has something to hang off.", origin: "OWNER", status: "RUNNING" },
    });
    const counters = { toolCalls: 0, dryRun: 0, refused: 0, escalated: null, delegated: 0, consulted: 0, consultedBy: { low: 0, medium: 0, high: 0 }, handedOff: 0, gapsRaised: 0 };
    const delegate = workflowTools(manager, parent, counters, 3).find((tool) => tool.name === "delegate")!;
    const input = { agentKey: stranger.key, title: `${TITLE} child`, brief: "A sub-task raised under a skill that does not report to the one raising it." };

    const allowed = await delegate.run(input);
    check("a sub-task may be raised under any skill", allowed.isError !== true, String(allowed.content).slice(0, 100));

    const toSelf = await delegate.run({ ...input, agentKey: ORCHESTRATOR_KEY, title: `${TITLE} to the orchestrator` });
    check("but not under the orchestrator itself", toSelf.isError === true, String(toSelf.content).slice(0, 100));

    setMode("roster");
    const refused = await delegate.run({ ...input, title: `${TITLE} child on the roster` });
    check("on the roster, only a report may be delegated to", refused.isError === true, String(refused.content).slice(0, 100));
    setMode("orchestrator");
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
