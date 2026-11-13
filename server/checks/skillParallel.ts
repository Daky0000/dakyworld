/**
 * Several tasks under one skill at once, never two about the same record
 * (`services/agents/parallel.ts`).
 *
 * One task per agent was a rule about a record written as a rule about an
 * agent: it kept two tasks about one lead from interleaving their writes, and
 * it also made five first letters to five different companies wait in a row.
 * What this holds still:
 *
 *  1. **The rule**, pure: different records may share a skill up to the
 *     ceiling; the same record never; a task about no record has the skill to
 *     itself in both directions; at a ceiling of one nothing shares anything.
 *  2. **The ceiling**: three in orchestrator mode, one on the roster, and a
 *     setting wins over both.
 *  3. **The claim**, against a real database: the condition the claim is made
 *     under lets a task about a different lead through and refuses one about
 *     the same lead, one about no record, and anything at all beside a task
 *     about no record.
 *
 * A database and nothing else.
 *   npx tsx checks/skillParallel.ts
 */
process.env.AGENTS_MODE = "orchestrator";
delete process.env.AGENTS_PER_SKILL;

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
const { clearSettingsCache } = await import("../src/lib/settings.js");
const { ensureAgents } = await import("../src/services/agentRegistry.js");
const { transition } = await import("../src/services/agents/state.js");
const { DEFAULT_PER_SKILL, claimGuard, mayStartBeside, perSkillLimit, recordsOf } = await import("../src/services/agents/parallel.js");

const TITLE = "Skill parallel check:";
const NONE = { leadId: null, clientId: null, projectId: null, proposalId: null, invoiceId: null };
const leadIds: string[] = [];

async function reset() {
  const tasks = await prisma.agentTask.findMany({ where: { title: { startsWith: TITLE } }, select: { id: true } });
  const ids = tasks.map((task) => task.id);
  if (ids.length > 0) {
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  if (leadIds.length > 0) await prisma.lead.deleteMany({ where: { id: { in: leadIds.splice(0) } } });
  await prisma.lead.deleteMany({ where: { companyName: { startsWith: "Skill Parallel Check" } } });
}

function setEnv(mode: "orchestrator" | "roster", perSkill?: string) {
  process.env.AGENTS_MODE = mode;
  if (perSkill === undefined) delete process.env.AGENTS_PER_SKILL;
  else process.env.AGENTS_PER_SKILL = perSkill;
  clearSettingsCache();
}

async function main() {
  await reset();
  await ensureAgents();

  // --- 1. The rule -------------------------------------------------------------
  console.log("\nWhich tasks may share a skill");
  {
    const a = recordsOf({ ...NONE, leadId: "A" });
    const b = recordsOf({ ...NONE, leadId: "B" });
    const c = recordsOf({ ...NONE, leadId: "C" });
    const d = recordsOf({ ...NONE, leadId: "D" });
    check("an idle skill takes anything", mayStartBeside(a, [], 3) && mayStartBeside([], [], 3));
    check("a different lead may start beside one running", mayStartBeside(b, [a], 3));
    check("the same lead may not", !mayStartBeside(a, [a], 3));
    check("up to the ceiling and no further", mayStartBeside(c, [a, b], 3) && !mayStartBeside(d, [a, b, c], 3));
    check("a task about no record does not start beside anything", !mayStartBeside([], [a], 3));
    check("and nothing starts beside a task about no record", !mayStartBeside(a, [[]], 3));
    check("at a ceiling of one, nothing shares", !mayStartBeside(b, [a], 1));

    const proposal = recordsOf({ ...NONE, leadId: "A", proposalId: "P" });
    check("sharing any one record is sharing", !mayStartBeside(proposal, [a], 3) && !mayStartBeside(a, [proposal], 3));
    check("a lead and a client with the same id are different records", mayStartBeside(recordsOf({ ...NONE, clientId: "A" }), [a], 3));
  }

  // --- 2. The ceiling ----------------------------------------------------------
  console.log("\nThe ceiling");
  {
    setEnv("orchestrator");
    check(`unset, orchestrator mode allows ${DEFAULT_PER_SKILL}`, (await perSkillLimit()) === DEFAULT_PER_SKILL, String(await perSkillLimit()));
    setEnv("roster");
    check("unset, the roster allows one", (await perSkillLimit()) === 1, String(await perSkillLimit()));
    setEnv("orchestrator", "1");
    check("a setting of one wins over the mode", (await perSkillLimit()) === 1, String(await perSkillLimit()));
    setEnv("roster", "2");
    check("and so does a setting of two", (await perSkillLimit()) === 2, String(await perSkillLimit()));
    setEnv("orchestrator", "0");
    check("zero is not a ceiling of none: it reads as the default", (await perSkillLimit()) === DEFAULT_PER_SKILL, String(await perSkillLimit()));
    setEnv("orchestrator", "99");
    check("and a silly number is capped", (await perSkillLimit()) <= 6, String(await perSkillLimit()));
    setEnv("orchestrator");
  }

  // --- 3. The claim ------------------------------------------------------------
  console.log("\nThe claim, as the database arbitrates it");
  {
    const skill = await prisma.agent.findFirstOrThrow({ where: { tier: "SUB_AGENT", tasks: { none: { status: "RUNNING" } } }, orderBy: { key: "asc" } });
    const leadA = await prisma.lead.create({ data: { contactName: "Parallel A", companyName: "Skill Parallel Check A" } });
    const leadB = await prisma.lead.create({ data: { contactName: "Parallel B", companyName: "Skill Parallel Check B" } });
    leadIds.push(leadA.id, leadB.id);

    const make = (name: string, leadId: string | null, status: "QUEUED" | "RUNNING" = "QUEUED") =>
      prisma.agentTask.create({ data: { agentKey: skill.key, title: `${TITLE} ${name}`, brief: "Exists so the claim has something to be made on.", origin: "OWNER", status, leadId } });
    const claim = async (task: { id: string; leadId: string | null }, limit: number) => {
      const result = await transition(task.id, {
        to: "RUNNING",
        reason: "Check: claimed.",
        actor: "check",
        expect: ["QUEUED"],
        guard: claimGuard({ ...NONE, leadId: task.leadId }, limit),
      });
      // Put back, so each question is asked of the same starting state.
      if (result.moved) await prisma.agentTask.update({ where: { id: task.id }, data: { status: "QUEUED" } });
      return result.moved;
    };

    const runningA = await make("running on A", leadA.id, "RUNNING");
    const sameLead = await make("second on A", leadA.id);
    const otherLead = await make("first on B", leadB.id);
    const batch = await make("about no record", null);

    check("a task about another lead is claimed beside it", await claim(otherLead, 3));
    check("a task about the same lead is not", !(await claim(sameLead, 3)));
    check("a task about no record is not", !(await claim(batch, 3)));
    check("at a ceiling of one, the other lead is not claimed either", !(await claim(otherLead, 1)));

    await prisma.agentTask.update({ where: { id: runningA.id }, data: { status: "QUEUED" } });
    await prisma.agentTask.update({ where: { id: batch.id }, data: { status: "RUNNING" } });
    check("nothing is claimed beside a running task about no record", !(await claim(otherLead, 3)) && !(await claim(sameLead, 3)));

    await prisma.agentTask.update({ where: { id: batch.id }, data: { status: "QUEUED" } });
    check("with the skill idle, anything is claimed", (await claim(batch, 3)) && (await claim(sameLead, 3)) && (await claim(otherLead, 1)));
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
