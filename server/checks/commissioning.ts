/**
 * Does switching the workforce on do exactly what it claims, and nothing else?
 *
 * The shipped state of an agent is three separate ways of doing nothing —
 * DRAFT so it claims no task, autonomy 1 so every outward and spending call is
 * a preview, dry run so every *internal* write is one too. `commissionWorkforce`
 * undoes all three at once, on fifty-six agents, in one pass. That is the most
 * consequential single write in this codebase, so the negatives here matter far
 * more than the positives:
 *
 *   - **Nothing outward and nothing that spends may act unsupervised** at the
 *     level it commissions to. This is the guarantee the whole change rests on:
 *     it is what makes "switch the workforce on" and "approve everything that
 *     leaves the building" the same sentence rather than opposite ones. Walked
 *     over the entire real catalogue, not a sample.
 *   - **A paused agent stays paused.** Pausing is something a person *did*, and
 *     a commissioning pass is not a reason to overrule it. Same for retired.
 *   - **An agent the Owner has already configured is left exactly as found** —
 *     raised, lowered, taken out of dry run, or switched on and deliberately
 *     left at level 1. Every one of those is a decision.
 *   - **It runs once**, so a deploy cannot switch a paused agent back on.
 *   - **It never lowers anything.**
 *   - **Every move is on the record**, because "who put this agent on level 2"
 *     has to have an answer.
 *
 * A database and nothing else. No API key, no network.
 *   npx tsx checks/commissioning.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { COMMISSIONED_AUTONOMY, commissionWorkforce, ensureAgents } from "../src/services/agentRegistry.js";
import { listAllTools } from "../src/services/tools/catalogue.js";
import { permissionFor, EXECUTE_LEVEL, SPEND_LEVEL } from "../src/services/tools/invoke.js";
import { SETTING, clearSettingsCache } from "../src/lib/settings.js";

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

/** Harness agents, told apart from the real roster by their keys. */
const SHIPPED = "check-commission-shipped";
const PAUSED = "check-commission-paused";
const RETIRED = "check-commission-retired";
const RAISED = "check-commission-raised";
const LIVE_AT_ONE = "check-commission-live";
const PROBE = "check-commission-probe";
const ALL = [SHIPPED, PAUSED, RETIRED, RAISED, LIVE_AT_ONE, PROBE];

async function reset() {
  await prisma.agentAutonomyChange.deleteMany({ where: { agentKey: { in: ALL } } });
  await prisma.agent.deleteMany({ where: { key: { in: ALL } } });
  await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_COMMISSIONED } });
  clearSettingsCache();
}

async function make(key: string, state: { status: string; autonomyLevel: number; dryRun: boolean; toolkit?: string[] }) {
  await prisma.agent.create({
    data: {
      key,
      name: key,
      title: "Harness",
      tier: "SUB_AGENT",
      department: "RISK",
      status: state.status as never,
      autonomyLevel: state.autonomyLevel,
      dryRun: state.dryRun,
      mission: "Exists so a pass can be asserted against it.",
      responsibilities: [],
      kpis: [],
      toolkit: state.toolkit ?? [],
      escalationPolicy: "n/a",
      prompt: {},
    },
  });
}

/**
 * The guarantee, over the whole catalogue.
 *
 * Deliberately every tool rather than a chosen few: the failure this exists to
 * catch is a tool added next month that is outward and whose flag nobody
 * checked against the commissioned level. A sample would not find it.
 */
async function nothingLeavesTheBuildingUnsupervised() {
  console.log("\nWhat a commissioned agent may do on its own");

  const tools = await listAllTools();
  await make(PROBE, { status: "ACTIVE", autonomyLevel: COMMISSIONED_AUTONOMY, dryRun: false, toolkit: tools.map((t) => t.key) });

  const actsForReal: string[] = [];
  const heldForApproval: string[] = [];
  for (const tool of tools) {
    const permission = await permissionFor(tool, { agentKey: PROBE, userId: null, dryRun: false });
    if (permission.allowed && !permission.mustDryRun) actsForReal.push(tool.key);
    else if (permission.allowed) heldForApproval.push(tool.key);
  }

  const outwardActing = tools.filter((t) => t.outward && actsForReal.includes(t.key)).map((t) => t.key);
  const spendingActing = tools.filter((t) => t.spends && actsForReal.includes(t.key)).map((t) => t.key);

  ok("no outward tool acts unsupervised at the commissioned level", outwardActing.length === 0, outwardActing.join(", "));
  ok("no tool that spends acts unsupervised at the commissioned level", spendingActing.length === 0, spendingActing.join(", "));
  // The other half, and the one that stops this being satisfied by refusing
  // everything: a commissioned agent has to be able to actually work.
  ok("and it can still do real internal work", actsForReal.length > tools.length / 3, `${actsForReal.length} of ${tools.length}`);
  ok(
    "every outward and spending tool is held for a decision rather than refused",
    tools.filter((t) => t.outward || t.spends).every((t) => heldForApproval.includes(t.key)),
  );
  // The level is what makes both true, so it is asserted rather than assumed.
  ok("the commissioned level sits below both gates", COMMISSIONED_AUTONOMY < EXECUTE_LEVEL && COMMISSIONED_AUTONOMY < SPEND_LEVEL,
    `level ${COMMISSIONED_AUTONOMY} vs execute ${EXECUTE_LEVEL} / spend ${SPEND_LEVEL}`);

  await prisma.agent.delete({ where: { key: PROBE } });
}

async function itWakesTheAsleepAndLeavesDecisionsAlone() {
  console.log("\nWhat the pass touches, and what it must not");

  await make(SHIPPED, { status: "DRAFT", autonomyLevel: 1, dryRun: true });
  await make(PAUSED, { status: "PAUSED", autonomyLevel: 1, dryRun: true });
  await make(RETIRED, { status: "RETIRED", autonomyLevel: 1, dryRun: true });
  await make(RAISED, { status: "DRAFT", autonomyLevel: 4, dryRun: false });
  await make(LIVE_AT_ONE, { status: "ACTIVE", autonomyLevel: 1, dryRun: true });

  const result = await commissionWorkforce();
  ok("the pass ran", result !== null);
  ok("it reports this as its first run", result?.firstRun === true);

  const after = new Map((await prisma.agent.findMany({ where: { key: { in: ALL } } })).map((a) => [a.key, a]));

  const shipped = after.get(SHIPPED);
  ok("an agent still in the state it shipped in is switched on", shipped?.status === "ACTIVE", String(shipped?.status));
  ok("taken out of dry run, so its work on our own records happens", shipped?.dryRun === false, String(shipped?.dryRun));
  ok(`and raised to ${COMMISSIONED_AUTONOMY}`, shipped?.autonomyLevel === COMMISSIONED_AUTONOMY, String(shipped?.autonomyLevel));
  ok("it is named in what the pass says it did", result?.woke.includes(SHIPPED) === true);

  const paused = after.get(PAUSED);
  ok("a PAUSED agent stays paused — pausing is something a person did", paused?.status === "PAUSED", String(paused?.status));
  ok("and is still in dry run", paused?.dryRun === true, String(paused?.dryRun));
  ok("with the reason given back", result?.leftAlone.some((r) => r.key === PAUSED && r.because.includes("paused")) === true);

  const retired = after.get(RETIRED);
  ok("a RETIRED agent stays retired", retired?.status === "RETIRED", String(retired?.status));

  const raised = after.get(RAISED);
  ok("an agent the Owner already raised keeps its level", raised?.autonomyLevel === 4, String(raised?.autonomyLevel));
  ok("and is not switched on by this pass either", raised?.status === "DRAFT", String(raised?.status));

  const live = after.get(LIVE_AT_ONE);
  ok("an agent switched on and deliberately left at level 1 is left there", live?.autonomyLevel === 1, String(live?.autonomyLevel));
  ok("and stays in dry run", live?.dryRun === true, String(live?.dryRun));

  // The whole point of the three columns moving together.
  ok("nothing was moved to a more restrictive state than it was found in",
    [...after.values()].every((a) => a.autonomyLevel >= 1 && !(a.status === "DRAFT" && result?.woke.includes(a.key))));
}

async function everyMoveIsOnTheRecord() {
  console.log("\nThe history");
  const entries = await prisma.agentAutonomyChange.findMany({ where: { agentKey: SHIPPED } });
  ok("the agent it woke has a history entry", entries.length === 1, `${entries.length} entries`);
  ok("naming what did it", entries[0]?.actor === "commissioning", String(entries[0]?.actor));
  ok("with the level it came from and went to", entries[0]?.fromLevel === 1 && entries[0]?.toLevel === COMMISSIONED_AUTONOMY);
  ok("and the dry-run flag it moved", entries[0]?.fromDryRun === true && entries[0]?.toDryRun === false);
  ok("and a reason that says approvals go to Slack", (entries[0]?.reason ?? "").toLowerCase().includes("slack"), entries[0]?.reason);

  const untouched = await prisma.agentAutonomyChange.count({ where: { agentKey: PAUSED } });
  ok("an agent it left alone has no history entry invented for it", untouched === 0, String(untouched));
}

async function itRunsOnce() {
  console.log("\nRunning it again");

  // The failure this guards: a pass that reasserted itself on every boot would
  // switch a paused agent back on every time somebody deployed, which is the
  // one behaviour that would make pausing useless.
  await prisma.agent.update({ where: { key: SHIPPED }, data: { status: "PAUSED" } });
  clearSettingsCache();

  const second = await commissionWorkforce();
  ok("a second boot does not run it again", second === null);
  const stillPaused = await prisma.agent.findUnique({ where: { key: SHIPPED } });
  ok("so an agent paused after commissioning stays paused across a deploy", stillPaused?.status === "PAUSED", String(stillPaused?.status));

  // The button, for agents that arrived later. Still bound by the same rule.
  const forced = await commissionWorkforce({ force: true });
  ok("the button can be pressed again", forced !== null);
  ok("but it says it is no longer the first run", forced?.firstRun === false);
  const afterForce = await prisma.agent.findUnique({ where: { key: SHIPPED } });
  ok("and even a forced run cannot switch a paused agent on", afterForce?.status === "PAUSED", String(afterForce?.status));

  // What force is actually for: something that arrived after the pass ran.
  await make(PROBE, { status: "DRAFT", autonomyLevel: 1, dryRun: true });
  const late = await commissionWorkforce({ force: true });
  ok("an agent that arrived after the pass is commissioned by the button", late?.woke.includes(PROBE) === true);
  const hired = await prisma.agent.findUnique({ where: { key: PROBE } });
  ok("and lands on the same card as everybody else", hired?.status === "ACTIVE" && hired?.autonomyLevel === COMMISSIONED_AUTONOMY && hired?.dryRun === false);
}

async function theRealRosterIsReachable() {
  console.log("\nThe roster this actually runs against");
  await ensureAgents();
  const asleep = await prisma.agent.count({ where: { status: "DRAFT", autonomyLevel: 1, dryRun: true, key: { notIn: ALL } } });
  const awake = await prisma.agent.count({ where: { status: "ACTIVE", key: { notIn: ALL } } });
  // Not an assertion about a number — it is an assertion that the pass and the
  // seeds agree about what "asleep" looks like, so the pass is not silently a
  // no-op on the roster it exists for.
  ok("the seeded roster is in a state this pass recognises", asleep + awake > 0, `${asleep} asleep, ${awake} awake`);
}

async function main() {
  await reset();
  await nothingLeavesTheBuildingUnsupervised();
  await itWakesTheAsleepAndLeavesDecisionsAlone();
  await everyMoveIsOnTheRecord();
  await itRunsOnce();
  await theRealRosterIsReachable();
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
