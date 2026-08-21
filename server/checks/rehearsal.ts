/**
 * Can anything escape a rehearsal?
 *
 * A rehearsal points the whole workforce at a real business's real website.
 * Everything about it is real — the prompts, the tools, the models, the money —
 * and exactly one thing must not be: nothing may reach that business. This
 * file is the list of ways it could, each of which was closed deliberately and
 * each of which is one careless edit from reopening.
 *
 *  1. **The gate.** `dryRun: true` at the call site holds even for an agent at
 *     autonomy 5 with its own dry run switched off. This is the whole
 *     guarantee: the runner passes `task.rehearsal` there, and if
 *     `permissionFor` ever stopped treating the caller's flag as a floor, every
 *     other check in this file would still pass while letters went out.
 *  2. **Inheritance.** A rehearsal that held only its first agent would be a
 *     rehearsal whose *second* agent sends the letter. `delegate` and `handOff`
 *     copy the flag onto the tasks they create — and this drives both of them
 *     for real rather than writing the shape it hopes to find.
 *  3. **The sequences.** The scratch lead starts with no address, and then
 *     `leadPrep` reads one off the business's own homepage — so by the time a
 *     run is ten minutes old there is a genuine address on a lead that nobody
 *     chose to approach. `enrol()` refuses it.
 *  4. **The pipeline.** It stays out of the leads list, and therefore out of
 *     every count, group and export built on that filter.
 *  5. **Teardown.** It can be thrown away, it refuses to be thrown away
 *     mid-run, and it cannot take a real lead with it.
 *  6. **Waking.** Most of the roster seeds as a draft and a draft picks nothing
 *     up, so a rehearsal switches on what it needs. Putting them back is the
 *     half that matters: an agent left awake by an abandoned test is the floor
 *     quietly changed, taking real work off the minute tick days later with
 *     nothing connecting it to the run that did it. A paused agent is never
 *     woken — that is a decision somebody made.
 *
 * Every claim carries a **negative** beside the positive, which is the half
 * that catches the mistakes worth catching: an unrestricted agent must still
 * really be allowed to send, a rehearsal must not blind its own agents, an
 * ordinary lead must still enrol, an ordinary delegation must *not* come out
 * marked as a rehearsal, a paused agent must stay paused, and teardown must not
 * be able to delete a real lead. Without those, a gate that refused everything
 * and a runner that marked everything would both read as a clean pass.
 *
 * Database only. No API key, no network, no Docker beyond Postgres itself.
 *   npx tsx checks/rehearsal.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { permissionFor } from "../src/services/tools/invoke.js";
import { findTool, TOOLS } from "../src/services/tools/catalogue.js";
import { enrol } from "../src/services/emailSequences.js";
import { buildWhere as buildLeadWhere } from "../src/routes/leads.js";
import { tasksIn, teardownRehearsal, RehearsalRefused } from "../src/services/rehearsals/run.js";
import { SCENARIOS } from "../src/services/rehearsals/scenarios.js";
import { heldByRehearsal } from "../src/services/rehearsals/policy.js";
import { reportsUnder, restoreOrphanedWakes, restoreWakes, wakeFor } from "../src/services/rehearsals/wake.js";
import { workflowTools, type Counters } from "../src/services/agents/runner.js";

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

const AGENT_KEY = "check.rehearsal";
/** The manager the delegation comes from, and the colleague it goes sideways to. */
const MANAGER_KEY = "check.rehearsal.manager";
const SIDEWAYS_KEY = "check.rehearsal.other";
const ALL_KEYS = [AGENT_KEY, MANAGER_KEY, SIDEWAYS_KEY];
const MARK = "rehearsalcheck";

function freshCounters(): Counters {
  return { toolCalls: 0, dryRun: 0, refused: 0, escalated: null, delegated: 0, consulted: 0, handedOff: 0, gapsRaised: 0 };
}

/**
 * Deletes everything this run made.
 *
 * Called at the start and at the end, and the final call must be the
 * delete-only half — a reset that also creates would re-make on the way out
 * exactly what it was meant to remove.
 */
async function reset() {
  await prisma.rehearsal.deleteMany({ where: { host: { startsWith: MARK } } });

  const tasks = await prisma.agentTask.findMany({ where: { agentKey: { in: ALL_KEYS } }, select: { id: true } });
  const ids = tasks.map((task) => task.id);
  if (ids.length > 0) {
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskCheckpoint.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.toolCall.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.llmCall.deleteMany({ where: { taskId: { in: ids } } });
    // Children first: a parent cannot go while a delegation still points at it.
    await prisma.agentTask.deleteMany({ where: { parentId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.toolCall.deleteMany({ where: { agentKey: { in: ALL_KEYS } } });
  await prisma.emailEnrollment.deleteMany({ where: { toEmail: { startsWith: MARK } } });
  await prisma.emailSequenceStep.deleteMany({ where: { sequence: { name: { startsWith: MARK } } } });
  await prisma.emailSequence.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.lead.deleteMany({ where: { contactName: { startsWith: MARK } } });
  await prisma.agentMemory.deleteMany({ where: { agentKey: { in: ALL_KEYS } } });
  await prisma.agent.deleteMany({ where: { key: { in: ALL_KEYS } } });
}

/**
 * Three agents, all as permissive as this system allows.
 *
 * Autonomy 5 with dry run off is an agent that may send, publish and spend
 * without asking anybody. The guarantee is asserted against that rather than
 * against the level-1 default every agent actually ships at: if it holds here
 * it holds everywhere, and the shipped default would make it hold for the
 * wrong reason.
 */
async function makeAgents() {
  const common = {
    department: "TECHNOLOGY" as const,
    status: "ACTIVE" as const,
    mission: "Exists for the duration of one test run.",
    autonomyLevel: 5,
    dryRun: false,
    // One of each kind the policy distinguishes: outward, read, write, and a
    // spending one. A grant is checked before the dry-run rule, so a toolkit
    // missing one of these fails as "not granted" and says nothing about the
    // rule under test.
    toolkit: ["email.send", "lead.read", "lead.update", "lead.prepare"],
  };
  // A manager, because `delegate` is only handed to an agent with reports and
  // only accepts an agent that reports to it.
  await prisma.agent.create({
    data: { key: MANAGER_KEY, name: "Rehearsal Check Manager", title: "Harness", tier: "FUNCTIONAL", ...common },
  });
  await prisma.agent.create({
    data: { key: AGENT_KEY, name: "Rehearsal Check", title: "Harness", tier: "SUB_AGENT", managerKey: MANAGER_KEY, ...common },
  });
  // Reports to nobody, so work reaching it can only have gone sideways.
  await prisma.agent.create({
    data: { key: SIDEWAYS_KEY, name: "Rehearsal Check Colleague", title: "Harness", tier: "SUB_AGENT", ...common },
  });
}

// --- 1. The gate --------------------------------------------------------------

async function theGateHoldsAtAnyAutonomy() {
  console.log("\nThe gate");

  const send = findTool("email.send");
  const read = findTool("lead.read");
  const write = findTool("lead.update");
  const research = findTool("lead.prepare");
  if (!send || !read || !write || !research) {
    check("the catalogue still has the tools this asserts against", false, "email.send / lead.read / lead.update / lead.prepare");
    return;
  }

  // Asserted through the same expression the runner evaluates, so the two
  // cannot drift into a check that passes about a rule nothing applies.
  check("an outward call is held", heldByRehearsal(send));
  check("a read is not", !heldByRehearsal(read));
  check("nor is a write to our own records", !heldByRehearsal(write));
  check("nor is paying for research", !heldByRehearsal(research));

  // The control. Without it, a gate that refused everything would make every
  // assertion below green while the app did nothing at all.
  const normal = await permissionFor(send, { agentKey: AGENT_KEY, userId: null, dryRun: false });
  check("an unrestricted agent may really send", normal.allowed && !normal.mustDryRun, JSON.stringify(normal));

  const rehearsed = await permissionFor(send, { agentKey: AGENT_KEY, userId: null, dryRun: heldByRehearsal(send) });
  check("the same agent in a rehearsal may only prepare", rehearsed.allowed && rehearsed.mustDryRun);

  // The negative that matters most, and the defect this replaced. A blanket
  // dry run would have met `invokeTool`'s "this tool cannot be previewed, and a
  // dry run must not carry it out" and refused every read in the run — every
  // agent blind, every timeline a wall of refusals, and the whole exercise a
  // test of nothing.
  const reading = await permissionFor(read, { agentKey: AGENT_KEY, userId: null, dryRun: heldByRehearsal(read) });
  check("a rehearsal does not blind its own agents", reading.allowed && !reading.mustDryRun, JSON.stringify(reading));
  check("and a read could not have been previewed anyway", !read.preview);

  const writing = await permissionFor(write, { agentKey: AGENT_KEY, userId: null, dryRun: heldByRehearsal(write) });
  check("a write to the scratch lead really happens", writing.allowed && !writing.mustDryRun);

  // A tool that cannot describe itself must not be dry-run into silently doing
  // it. Asserted over the whole catalogue rather than the two this harness
  // holds, because a rehearsal is the one place where every outward call takes
  // that branch, on every run.
  const unpreviewable = TOOLS.filter((tool) => heldByRehearsal(tool) && !tool.preview);
  check("every outward tool in the catalogue can be previewed", unpreviewable.length === 0, unpreviewable.map((tool) => tool.key).join(", "));
}

// --- 2. Inheritance -----------------------------------------------------------

/**
 * The flag survives a handover — asserted by making the handover.
 *
 * `delegate` and `handOff` are driven directly rather than through the agent
 * loop, because the loop needs a model and these two need nothing. That is the
 * point of doing it this way: a harness that created the child row itself with
 * `rehearsal: parent.rehearsal` would be asserting its own arithmetic, and
 * would go on passing for ever after the runner stopped copying the flag.
 */
async function theFlagIsInherited() {
  console.log("\nInheritance");

  const manager = await prisma.agent.findUniqueOrThrow({ where: { key: MANAGER_KEY } });
  const parent = await prisma.agentTask.create({
    data: { agentKey: MANAGER_KEY, title: `${MARK} parent`, brief: "A harness task.", origin: "OWNER", rehearsal: true },
  });

  const tools = workflowTools(manager, parent, freshCounters());
  const delegate = tools.find((tool) => tool.name === "delegate");
  const handOff = tools.find((tool) => tool.name === "handOff");
  check("a manager is given delegate and handOff", Boolean(delegate) && Boolean(handOff));
  if (!delegate || !handOff) return;

  const delegated = await delegate.run({
    agentKey: AGENT_KEY,
    title: `${MARK} delegated`,
    brief: "Everything they need, written as if to somebody who was not here.",
  });
  check("the delegation was accepted", !delegated.isError, delegated.content);

  const handed = await handOff.run({
    agentKey: SIDEWAYS_KEY,
    title: `${MARK} handed`,
    brief: "Everything they need, written as if to somebody who was not here.",
    why: "It is their craft rather than mine.",
  });
  check("the hand-off was accepted", !handed.isError, handed.content);

  const children = await prisma.agentTask.findMany({ where: { parentId: parent.id }, select: { agentKey: true, rehearsal: true } });
  check("both created a task", children.length === 2, `${children.length}`);
  check("a delegated child carries the flag", children.find((task) => task.agentKey === AGENT_KEY)?.rehearsal === true);
  check("a task handed sideways carries it too", children.find((task) => task.agentKey === SIDEWAYS_KEY)?.rehearsal === true);

  const tree = await tasksIn(parent.id);
  check("the reader walks the whole tree", tree.length === 3, `${tree.length} tasks`);
  check("every task in it is a rehearsal", tree.every((task) => task.rehearsal));

  // The negative. Without it, a runner that hard-coded `rehearsal: true` on
  // every delegation would pass everything above while quietly putting the real
  // workforce into permanent dry run.
  const ordinary = await prisma.agentTask.create({
    data: { agentKey: MANAGER_KEY, title: `${MARK} ordinary parent`, brief: "A harness task.", origin: "OWNER" },
  });
  const ordinaryDelegate = workflowTools(manager, ordinary, freshCounters()).find((tool) => tool.name === "delegate");
  await ordinaryDelegate?.run({
    agentKey: AGENT_KEY,
    title: `${MARK} ordinary child`,
    brief: "Everything they need, written as if to somebody who was not here.",
  });
  const ordinaryChild = await prisma.agentTask.findFirst({ where: { parentId: ordinary.id }, select: { rehearsal: true } });
  check("an ordinary delegation is not marked as a rehearsal", ordinaryChild?.rehearsal === false, JSON.stringify(ordinaryChild));
}

// --- 3. The sequences ---------------------------------------------------------

async function nothingRehearsedEntersASequence() {
  console.log("\nSequences");

  const sequence = await prisma.emailSequence.create({
    data: {
      name: `${MARK} sequence`,
      trigger: "LEAD_CREATED",
      active: true,
      steps: { create: [{ position: 1, delayDays: 0, subject: "Hello", bodyHtml: "<p>Hello</p>" }] },
    },
  });

  // The address is the point. A rehearsal lead starts with none, and `leadPrep`
  // fills it from the business's own homepage — so this is the state a run is
  // genuinely in after ten minutes, not a contrived one.
  const rehearsed = await prisma.lead.create({
    data: { contactName: `${MARK} rehearsed`, contactEmail: `${MARK}@example.com`, rehearsal: true, source: "OTHER" },
  });
  const real = await prisma.lead.create({
    data: { contactName: `${MARK} real`, contactEmail: `${MARK}-real@example.com`, rehearsal: false, source: "OTHER" },
  });

  const refused = await enrol({ sequenceId: sequence.id, leadId: rehearsed.id });
  check("a rehearsal lead cannot be enrolled", !refused.enrolled, refused.reason ?? "");
  check("and it is told why", (refused.reason ?? "").toLowerCase().includes("rehearsal"));

  // The control again: the same call on an ordinary lead must work, or this
  // would pass on a sequence engine that is simply broken.
  const allowed = await enrol({ sequenceId: sequence.id, leadId: real.id });
  check("an ordinary lead still enrols", allowed.enrolled, allowed.reason ?? "");

  const enrollments = await prisma.emailEnrollment.count({ where: { leadId: rehearsed.id } });
  check("no enrollment row was written for it", enrollments === 0, `${enrollments} rows`);
}

// --- 4. The pipeline ----------------------------------------------------------

function itStaysOutOfThePipeline() {
  console.log("\nThe pipeline");

  const normal = buildLeadWhere({}) as { rehearsal?: boolean };
  check("the leads list hides rehearsals by default", normal.rehearsal === false, JSON.stringify(normal.rehearsal));

  const asked = buildLeadWhere({ rehearsal: "only" }) as { rehearsal?: boolean };
  check("and can be asked for them", asked.rehearsal === true);
}

// --- 5. Teardown --------------------------------------------------------------

async function itCanBeThrownAway() {
  console.log("\nTeardown");

  const lead = await prisma.lead.create({ data: { contactName: `${MARK} scratch`, rehearsal: true, source: "OTHER" } });
  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: `${MARK} root`, brief: "A harness task.", origin: "OWNER", rehearsal: true, leadId: lead.id },
  });
  const running = await prisma.rehearsal.create({
    data: {
      website: `https://${MARK}.test`,
      host: `${MARK}.test`,
      scenario: "cold-outreach",
      leadId: lead.id,
      rootTaskId: task.id,
      status: "RUNNING",
    },
  });

  let refused: unknown = null;
  try {
    await teardownRehearsal(running.id);
  } catch (err) {
    refused = err;
  }
  check("a running rehearsal refuses to be deleted", refused instanceof RehearsalRefused);
  check("and nothing was removed", (await prisma.agentTask.count({ where: { id: task.id } })) === 1);

  await prisma.rehearsal.update({ where: { id: running.id }, data: { status: "SETTLED" } });
  const result = await teardownRehearsal(running.id);
  check("a settled one is removed", result.tasks === 1 && result.leadRemoved, JSON.stringify(result));
  check("the task is gone", (await prisma.agentTask.count({ where: { id: task.id } })) === 0);
  check("the scratch lead is gone", (await prisma.lead.count({ where: { id: lead.id } })) === 0);

  // The guard that stops a mis-pointed rehearsal deleting somebody's prospect.
  const realLead = await prisma.lead.create({ data: { contactName: `${MARK} not a rehearsal`, rehearsal: false, source: "OTHER" } });
  const mispointed = await prisma.rehearsal.create({
    data: { website: `https://${MARK}2.test`, host: `${MARK}2.test`, scenario: "cold-outreach", leadId: realLead.id, status: "SETTLED" },
  });
  await teardownRehearsal(mispointed.id);
  check("teardown cannot delete a real lead", (await prisma.lead.count({ where: { id: realLead.id } })) === 1);
  await prisma.lead.delete({ where: { id: realLead.id } });
}

// --- 6. Waking, and putting back -----------------------------------------------

/**
 * A rehearsal switches on what it needs and leaves the floor as it found it.
 *
 * Two halves, and the second is the one that matters. Waking a draft is
 * convenience; **failing to put it back** is a test that quietly changed how
 * the business runs — an agent nobody chose to switch on, taking real work off
 * the minute tick, days later, with nothing connecting it to the rehearsal that
 * did it.
 *
 * The negatives here are the whole point: a paused agent must stay paused, and
 * an agent another live rehearsal still needs must not be put back underneath
 * it.
 */
async function itWakesWhatItNeedsAndPutsItBack() {
  console.log("\nWaking");

  // The chart the harness built: MANAGER -> AGENT, with SIDEWAYS reporting to
  // nobody. So `reportsUnder` should find the first two and not the third.
  const under = await reportsUnder(MANAGER_KEY);
  check("the reporting tree is walked", under.includes(MANAGER_KEY) && under.includes(AGENT_KEY), under.join(", "));
  check("and stops at the edge of it", !under.includes(SIDEWAYS_KEY), under.join(", "));

  await prisma.agent.update({ where: { key: AGENT_KEY }, data: { status: "DRAFT" } });
  await prisma.agent.update({ where: { key: SIDEWAYS_KEY }, data: { status: "PAUSED" } });

  const rehearsal = await prisma.rehearsal.create({
    data: { website: `https://${MARK}wake.test`, host: `${MARK}wake.test`, scenario: "cold-outreach", status: "RUNNING" },
  });

  const woke = await wakeFor(rehearsal.id, [AGENT_KEY, SIDEWAYS_KEY, MANAGER_KEY]);
  check("a draft is woken", woke.woke[AGENT_KEY] === "DRAFT", JSON.stringify(woke.woke));
  check("an already-active agent is left alone", !(MANAGER_KEY in woke.woke));

  // A person paused that agent on purpose. A test is not a reason to overrule
  // it, and the refusal has to say so rather than fail silently.
  check("a paused agent is not woken", !(SIDEWAYS_KEY in woke.woke));
  check("and the refusal says why", woke.refused.some((entry) => entry.key === SIDEWAYS_KEY && entry.reason.includes("decision you made")));
  check("the paused agent really is still paused", (await prisma.agent.findUnique({ where: { key: SIDEWAYS_KEY } }))?.status === "PAUSED");
  check("the woken one really is active", (await prisma.agent.findUnique({ where: { key: AGENT_KEY } }))?.status === "ACTIVE");

  // Written down before the status changed, which is what makes it reversible
  // after a crash.
  const recorded = await prisma.rehearsal.findUnique({ where: { id: rehearsal.id }, select: { wokeAgents: true } });
  check("what was woken is on the record", Boolean((recorded?.wokeAgents as Record<string, string>)?.[AGENT_KEY]));

  // A second live rehearsal holding the same agent. The first to finish must
  // not put it back underneath the second — the symptom of that appears on the
  // *other* run, which is the kind nobody reproduces.
  const other = await prisma.rehearsal.create({
    data: {
      website: `https://${MARK}wake2.test`,
      host: `${MARK}wake2.test`,
      scenario: "cold-outreach",
      status: "RUNNING",
      wokeAgents: { [AGENT_KEY]: "DRAFT" },
    },
  });
  const heldBack = await restoreWakes(rehearsal.id);
  check("an agent another live run still needs is not put back", !heldBack.includes(AGENT_KEY), heldBack.join(", "));
  check("and it is still active", (await prisma.agent.findUnique({ where: { key: AGENT_KEY } }))?.status === "ACTIVE");

  await prisma.rehearsal.update({ where: { id: other.id }, data: { status: "SETTLED" } });
  const restored = await restoreWakes(other.id);
  check("once nothing needs it, it goes back", restored.includes(AGENT_KEY), restored.join(", "));
  check("as a draft, not as something else", (await prisma.agent.findUnique({ where: { key: AGENT_KEY } }))?.status === "DRAFT");

  // The crash path: a rehearsal left RUNNING with agents still awake.
  await prisma.agent.update({ where: { key: AGENT_KEY }, data: { status: "ACTIVE" } });
  const orphan = await prisma.rehearsal.create({
    data: {
      website: `https://${MARK}wake3.test`,
      host: `${MARK}wake3.test`,
      scenario: "cold-outreach",
      status: "RUNNING",
      wokeAgents: { [AGENT_KEY]: "DRAFT" },
    },
  });
  const swept = await restoreOrphanedWakes();
  check("a run killed mid-flight does not leave the floor switched on", swept >= 1, `${swept}`);
  check("the agent is a draft again", (await prisma.agent.findUnique({ where: { key: AGENT_KEY } }))?.status === "DRAFT");
  check(
    "and the abandoned run is marked stopped rather than left running for ever",
    (await prisma.rehearsal.findUnique({ where: { id: orphan.id } }))?.status === "STOPPED",
  );

  await prisma.agent.update({ where: { key: AGENT_KEY }, data: { status: "ACTIVE" } });
  await prisma.agent.update({ where: { key: SIDEWAYS_KEY }, data: { status: "ACTIVE" } });
}

// --- 7. The catalogue ---------------------------------------------------------

/**
 * Every workflow still starts with somebody who exists.
 *
 * A scenario names an agent key, and a key is a string that nothing else
 * verifies. The one-job split renamed fourteen agents in a single pass; the
 * failure mode of the next one is a rehearsal that refuses at the moment
 * somebody presses the button. Same trap `tmp/rosterCheck.ts` covers for the
 * roster's own `managerKey`.
 */
async function everyScenarioStartsWithSomebody() {
  console.log("\nThe workflow catalogue");

  const keys = [...new Set(SCENARIOS.map((scenario) => scenario.startAgent))];
  const found = await prisma.agent.findMany({ where: { key: { in: keys } }, select: { key: true } });
  const missing = keys.filter((key) => !found.some((agent) => agent.key === key));
  check("every scenario's starting agent is on the roster", missing.length === 0, missing.join(", "));

  const duplicates = SCENARIOS.length - new Set(SCENARIOS.map((scenario) => scenario.key)).size;
  check("no two workflows share a key", duplicates === 0);

  // The brief is what the whole run is decided from. One that forgot to
  // interpolate the address would send an agent to look at nothing.
  const built = SCENARIOS.map((scenario) => scenario.brief({ site: "https://example.test", name: "Example" }));
  check("every brief names the site it is about", built.every((brief) => brief.includes("https://example.test")));
  check("every brief names the business", built.every((brief) => brief.includes("Example")));
}

async function main() {
  console.log("The rehearsal room\n==================");
  await reset();
  await makeAgents();

  await theGateHoldsAtAnyAutonomy();
  await theFlagIsInherited();
  await nothingRehearsedEntersASequence();
  itStaysOutOfThePipeline();
  await itCanBeThrownAway();
  await itWakesWhatItNeedsAndPutsItBack();
  await everyScenarioStartsWithSomebody();

  await reset();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

void main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exitCode = 1;
});
