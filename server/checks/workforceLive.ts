/**
 * Can the workforce actually start, and do empty lists go away?
 *
 * Four things a deployment shipped in a state where nothing happened and
 * nothing said why:
 *
 * **Every agent was a draft and `commissionWorkforce` could not help.** That
 * pass only ever touches an agent still in exactly the state it shipped in,
 * which is the right guard and cannot reach a roster somebody has already
 * touched. On the live service it held on fifty-four of fifty-six: the pass ran,
 * reported "left as you had them" against nearly everybody, and left a floor of
 * drafts behind a message that reads like success. `activateWorkforce` is the
 * answer to the Owner asking for the workforce to be on, and the assertions
 * that matter here are what it refuses to touch.
 *
 * **Nothing ever wrote an `AgentSchedule`.** `AgentTaskOrigin.SCHEDULE` is
 * written by exactly one thing and that thing had no rows, so a live database
 * could hold a willing workforce, tens of thousands of captured businesses, and
 * no reason for anybody to begin. "Run agents now" looped over an empty table
 * and honestly reported that nothing was waiting.
 *
 * **Empty lists accumulated and could not all be reached.** A scrape opens a
 * list, an import opens one per worksheet, and a deleted batch leaves its list
 * standing. The grouped view pages at twenty-five blocks with no pager, so the
 * tickboxes can only ever reach the first twenty-five of them.
 *
 * **And removing one silently unhooks a capture source.**
 * `ScraperSource.leadGroupId` is `onDelete: SetNull`, so the delete succeeds,
 * warns nobody, and the next run's businesses arrive ungrouped.
 *
 * The negatives are half of this file and they are the half worth reading: a
 * retired agent must stay retired, an agent's autonomy and dry run must not
 * move, a marked pass must not run twice, a list being captured into must
 * survive, and a list with a lead in it must never be touched.
 *
 * Database only. No API key, no network, no Docker beyond Postgres itself.
 *   npx tsx checks/workforceLive.ts
 */
import type { AgentStatus, Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { SETTING, getSetting, setSetting } from "../src/lib/settings.js";
import { activateWorkforce, ensureAgents } from "../src/services/agentRegistry.js";
import { ensureStandingWork } from "../src/services/agents/standingWork.js";
import { findEmptyLists, removeEmptyLists } from "../src/services/leadLists.js";

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

/** Everything this run makes carries the mark, so cleanup cannot touch real data. */
const MARK = "workforcelivecheck";

/**
 * The two markers this file drives passes behind.
 *
 * Both are one-shot on a real database, so a check that simply called them
 * would do nothing on its second run and report that as success. They are
 * saved, cleared, and put back exactly as found — including *absent*, which is
 * a different state from empty and is the state a fresh database is in.
 */
let priorActivation: string | null | undefined;
let priorStanding: string | null | undefined;

/**
 * Every agent's status before this file touched anything.
 *
 * Both passes under test act on the **whole** roster by design — that is what
 * they are for — so running them against a developer's database would switch
 * fifty-six real agents on and seed seven real schedules, and leave them that
 * way. Restoring is done in `reset()` rather than at the end of `main` so that
 * the failure path covers it too: a check that quietly changes how somebody's
 * workforce runs is worse than anything it catches.
 */
let priorStatuses: { key: string; status: AgentStatus }[] = [];
/**
 * Every standing schedule as it was, put back verbatim afterwards.
 *
 * The table is emptied before the seed runs, because `ensureStandingWork`
 * adopts a schedule that already exists rather than making a second one — so on
 * any database that has already been seeded it would correctly create nothing,
 * and a check asserting that it creates something would fail on the state
 * rather than on the code. Snapshot, clear, seed, restore.
 */
let priorSchedules: Prisma.AgentScheduleUncheckedCreateInput[] = [];
/** Whether the table was cleared. An empty snapshot is a real state, so the length cannot stand in for this. */
let schedulesTaken = false;
/** When this run began, so its own history rows can be told from the database's. */
let startedAt: Date | null = null;

async function reset() {
  await prisma.agentSchedule.deleteMany({ where: { agentKey: { startsWith: MARK } } });
  if (schedulesTaken) {
    // Everything, then the snapshot back — including whatever the seed created
    // during the run, which is not part of what was found.
    await prisma.agentSchedule.deleteMany({});
    if (priorSchedules.length) await prisma.agentSchedule.createMany({ data: priorSchedules });
    priorSchedules = [];
    schedulesTaken = false;
  }
  await prisma.agentAutonomyChange.deleteMany({ where: { agentKey: { startsWith: MARK } } });
  await prisma.agent.deleteMany({ where: { key: { startsWith: MARK } } });
  await prisma.lead.deleteMany({ where: { contactName: { startsWith: MARK } } });
  await prisma.scraperSource.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.leadGroup.deleteMany({ where: { slug: { startsWith: MARK } } });

  for (const row of priorStatuses) {
    await prisma.agent.updateMany({ where: { key: row.key, status: { not: row.status } }, data: { status: row.status } });
  }
  priorStatuses = [];
  // `activation` rows this run wrote against real agents. Scoped by time, not
  // by actor alone: the history is meant to answer "who moved this agent", and
  // a cleanup that swept every activation row would delete the real answer for
  // every agent a boot had legitimately switched on.
  if (startedAt) await prisma.agentAutonomyChange.deleteMany({ where: { actor: "activation", at: { gte: startedAt } } });

  if (priorActivation !== undefined) {
    if (priorActivation === null) await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_WORKFORCE_ACTIVE } });
    else await setSetting(SETTING.AGENT_WORKFORCE_ACTIVE, priorActivation);
  }
  if (priorStanding !== undefined) {
    if (priorStanding === null) await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_STANDING_WORK } });
    else await setSetting(SETTING.AGENT_STANDING_WORK, priorStanding);
  }
}

/** A row in exactly the shape `activateWorkforce` has to decide about. */
async function agent(suffix: string, status: "DRAFT" | "ACTIVE" | "PAUSED" | "RETIRED", autonomyLevel = 1, dryRun = true) {
  return prisma.agent.create({
    data: {
      key: `${MARK}.${suffix}`,
      name: `${MARK} ${suffix}`,
      title: "Check subject",
      department: "REVENUE",
      status,
      autonomyLevel,
      dryRun,
      mission: "Exist so that a pass can decide about it.",
    },
  });
}

async function main() {
  priorActivation = await getSetting(SETTING.AGENT_WORKFORCE_ACTIVE);
  priorStanding = await getSetting(SETTING.AGENT_STANDING_WORK);
  await reset();

  // The roster this file asks about, seeded rather than assumed. A check that
  // only passes against state a previous run left behind is a check nobody can
  // read a new failure out of — `ensureStandingWork` seeds against seven agent
  // keys, and on a clean database all seven would skip and the skip would read
  // as the feature not working.
  await ensureAgents();
  priorStatuses = await prisma.agent.findMany({ select: { key: true, status: true } });
  startedAt = new Date();

  // --- Switching the workforce on -----------------------------------------

  // Four rows covering every branch. The two that must not move are the point:
  // a retired agent is a job that no longer exists, and an agent somebody
  // raised to level 4 with dry run off must come out of this holding exactly
  // that, or the pass is quietly rewriting the workforce rather than waking it.
  await agent("draft", "DRAFT");
  await agent("paused", "PAUSED");
  await agent("retired", "RETIRED");
  await agent("configured", "DRAFT", 4, false);

  await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_WORKFORCE_ACTIVE } });
  const activated = await activateWorkforce();

  check("a draft is switched on", activated?.woke.includes(`${MARK}.draft`) === true, JSON.stringify(activated?.woke));
  check("a paused agent is switched on and named apart", activated?.unpaused.includes(`${MARK}.paused`) === true, JSON.stringify(activated?.unpaused));
  check("a retired agent is left alone", activated?.retired.includes(`${MARK}.retired`) === true, JSON.stringify(activated?.retired));

  const retired = await prisma.agent.findUniqueOrThrow({ where: { key: `${MARK}.retired` } });
  check("a retired agent's status is untouched", retired.status === "RETIRED", retired.status);

  // The whole safety story of this pass in one assertion: it writes `status`
  // and nothing else, so no agent comes out of it able to do more than it
  // could before — only able to be given something.
  const configured = await prisma.agent.findUniqueOrThrow({ where: { key: `${MARK}.configured` } });
  check(
    "an agent's autonomy and dry run are not moved",
    configured.status === "ACTIVE" && configured.autonomyLevel === 4 && configured.dryRun === false,
    `${configured.status} level=${configured.autonomyLevel} dryRun=${configured.dryRun}`,
  );

  const woken = await prisma.agent.findUniqueOrThrow({ where: { key: `${MARK}.draft` } });
  check("a woken draft keeps the shipped autonomy and dry run", woken.autonomyLevel === 1 && woken.dryRun === true, `level=${woken.autonomyLevel} dryRun=${woken.dryRun}`);

  // "Who switched this agent on" has to have an answer, and the level columns
  // on that row must record the move that actually happened — which is none.
  const history = await prisma.agentAutonomyChange.findFirst({ where: { agentKey: `${MARK}.draft` } });
  check(
    "the move is written to the history with the actor and no level change",
    history?.actor === "activation" && history.fromLevel === history.toLevel && history.fromDryRun === history.toDryRun,
    JSON.stringify(history),
  );

  // A pass that reasserted this on every boot would switch a paused agent back
  // on every time somebody deployed, which is what would make pausing useless.
  await prisma.agent.update({ where: { key: `${MARK}.draft` }, data: { status: "PAUSED" } });
  const second = await activateWorkforce();
  check("the pass is marked and does not run twice", second === null, JSON.stringify(second));
  const stillPaused = await prisma.agent.findUniqueOrThrow({ where: { key: `${MARK}.draft` } });
  check("an agent paused after the pass stays paused", stillPaused.status === "PAUSED", stillPaused.status);

  // --- Standing work -------------------------------------------------------

  priorSchedules = await prisma.agentSchedule.findMany();
  schedulesTaken = true;
  await prisma.agentSchedule.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_STANDING_WORK } });
  const standing = await ensureStandingWork();

  check("standing work is seeded", (standing?.created.length ?? 0) > 0, JSON.stringify(standing?.skipped));

  const schedules = await prisma.agentSchedule.findMany();
  check("every seeded schedule is enabled", schedules.length > 0 && schedules.every((row) => row.enabled), `${schedules.filter((row) => row.enabled).length}/${schedules.length}`);
  check("every seeded schedule has a next run worked out", schedules.every((row) => row.nextRunAt !== null), JSON.stringify(schedules.map((row) => row.nextRunAt)));
  check("every seeded schedule has a brief a model can work from", schedules.every((row) => row.brief.length >= 20), JSON.stringify(schedules.map((row) => row.brief.length)));

  // The whole point of `raiseStandingWork`: a schedule is only worth seeding if
  // the query that raises work can see it.
  const visible = await prisma.agentSchedule.count({ where: { enabled: true, agentKey: { in: schedules.map((row) => row.agentKey) } } });
  check("the raising query can see them", visible === schedules.length, `${visible} of ${schedules.length}`);

  // Marked, so a schedule the Owner later disables or deletes stays gone —
  // without this, every deploy would put back the thing they just switched off.
  const again = await ensureStandingWork();
  check("standing work is marked and does not seed twice", again === null, JSON.stringify(again));

  // --- Empty lists ---------------------------------------------------------

  const bare = await prisma.leadGroup.create({ data: { name: `${MARK} bare`, slug: `${MARK}-bare`, autoCreated: true } });
  const held = await prisma.leadGroup.create({ data: { name: `${MARK} held`, slug: `${MARK}-held` } });
  const fed = await prisma.leadGroup.create({ data: { name: `${MARK} fed`, slug: `${MARK}-fed`, autoCreated: true } });
  const byHand = await prisma.leadGroup.create({ data: { name: `${MARK} by hand`, slug: `${MARK}-by-hand`, autoCreated: false } });

  await prisma.lead.create({ data: { contactName: `${MARK} someone`, groupId: held.id } });
  await prisma.scraperSource.create({
    data: { name: `${MARK} source`, actorId: "check/none", preset: "CUSTOM", leadSource: "WEB_SCRAPE", input: {}, leadGroupId: fed.id },
  });

  const found = await findEmptyLists();
  const removableIds = found.removable.map((row) => row.id);
  check("an empty list is offered", removableIds.includes(bare.id), JSON.stringify(found.removable.map((row) => row.name)));
  check("a list with a lead in it is not offered", !removableIds.includes(held.id));
  check(
    "an empty list a source captures into is kept back and named",
    !removableIds.includes(fed.id) && found.keptFeeding.some((row) => row.id === fed.id),
    JSON.stringify(found.keptFeeding.map((row) => row.name)),
  );

  // The daily sweep is deliberately narrower than the button: a list somebody
  // typed a name for is never removed behind their back, however empty it is.
  const autoOnly = await findEmptyLists({ autoOnly: true });
  check("the automatic sweep leaves a hand-made list alone", !autoOnly.removable.some((row) => row.id === byHand.id));
  check("the button offers the hand-made list", removableIds.includes(byHand.id));

  // And the age guard, which is what stops the sweep deleting the list
  // somebody is in the middle of filling.
  const tooNew = await findEmptyLists({ olderThanMs: 60 * 60_000 });
  check("a list made moments ago is left for later", !tooNew.removable.some((row) => row.id === bare.id));

  await removeEmptyLists();

  check("the empty list is gone", (await prisma.leadGroup.count({ where: { id: bare.id } })) === 0);
  check("the list with a lead in it survives", (await prisma.leadGroup.count({ where: { id: held.id } })) === 1);
  check("the list being captured into survives", (await prisma.leadGroup.count({ where: { id: fed.id } })) === 1);

  // The reason that last one matters, stated as the thing that would actually
  // have gone wrong: `onDelete: SetNull` means removing the list does not fail
  // and does not warn — it unhooks the source, and the next run's businesses
  // arrive ungrouped with nothing anywhere to say why.
  const source = await prisma.scraperSource.findFirstOrThrow({ where: { name: `${MARK} source` } });
  check("the source still points at its list", source.leadGroupId === fed.id, String(source.leadGroupId));

  await reset();
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((name) => `  - ${name}`).join("\n"));
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
