/**
 * How often an agent may pick up work, as opposed to how much it may spend.
 *
 * The spending ceilings answer "how much money" and say nothing about "how
 * often", and those come apart: an agent doing cheap work can run all day well
 * inside its budget and still act far more than anybody meant it to.
 *
 * Three things have a way of going wrong here and each has an assertion:
 *
 *  - **Zero read as unset.** The obvious way to stop an agent taking work
 *    without retiring it, and the usual `> 0` guard hands back "no limit"
 *    instead. `Rehearsal.budgetUsd` carries a comment about this exact trap.
 *  - **The week resetting a day early.** `getUTCDay()` calls Sunday 0, so a
 *    naive subtraction starts a fresh week every Sunday, for ever.
 *  - **A held task being marked failed.** Being at a ceiling is the guardrail
 *    working. The task has to stay QUEUED with its place kept, exactly as the
 *    budget hold does, or a quota empties the queue instead of pacing it.
 *
 * Database only. No key, no network.
 */
import { hasPace, paceFor, paceStart, paceUsage } from "../src/services/agents/pace.js";
import { runDueTasks } from "../src/services/agents/runner.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const AGENT_KEY = "check.pace.agent";

async function reset() {
  await prisma.agentTaskTransition.deleteMany({ where: { task: { agentKey: AGENT_KEY } } });
  await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
}

console.log("\nWhere a period starts");
{
  // A Sunday. The week it belongs to began on the Monday *before* it.
  const sunday = new Date(Date.UTC(2026, 7, 30, 15, 0, 0));
  check("a Sunday belongs to the week that began on Monday", paceStart("WEEK", sunday).toISOString().startsWith("2026-08-24"), paceStart("WEEK", sunday).toISOString());
  const monday = new Date(Date.UTC(2026, 7, 31, 1, 0, 0));
  check("and Monday starts a new one", paceStart("WEEK", monday).toISOString().startsWith("2026-08-31"), paceStart("WEEK", monday).toISOString());
  check("a day starts at midnight UTC", paceStart("DAY", sunday).toISOString() === "2026-08-30T00:00:00.000Z", paceStart("DAY", sunday).toISOString());
  check("a month starts on the first", paceStart("MONTH", sunday).toISOString() === "2026-08-01T00:00:00.000Z", paceStart("MONTH", sunday).toISOString());
}

await reset();
await prisma.agent.create({
  data: {
    key: AGENT_KEY,
    name: "Pace Check",
    title: "Pace Check",
    tier: "SUB_AGENT",
    department: "TECHNOLOGY",
    status: "ACTIVE",
    mission: "Exists for one test run.",
    custom: true,
  },
});
const agentRow = () => prisma.agent.findUniqueOrThrow({ where: { key: AGENT_KEY } });
const startedToday = (n: number) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      prisma.agentTask.create({
        data: { agentKey: AGENT_KEY, title: `done ${i}`, brief: "done", status: "DONE", startedAt: new Date() },
      }),
    ),
  );

console.log("\nNo ceiling costs nothing");
{
  const agent = await agentRow();
  check("an agent with no ceilings declares none", !hasPace(agent));
  check("and is never at one", !(await paceFor(agent)).atCeiling);
}

console.log("\nA daily ceiling");
{
  await prisma.agent.update({ where: { key: AGENT_KEY }, data: { maxTasksPerDay: 2 } });
  await startedToday(1);
  check("one of two is under it", !(await paceFor(await agentRow())).atCeiling);

  await startedToday(1);
  const at = await paceFor(await agentRow());
  check("two of two is at it", at.atCeiling);
  check("and it names which period", at.period === "DAY", `${at.period}`);
  check("and says so in a sentence", at.note?.includes("today") === true, at.note ?? "");
}

console.log("\nZero is a ceiling, not an absence");
{
  // The trap. `> 0` reads this as unset and lets everything through, which is
  // the opposite of what somebody typing 0 meant.
  await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.update({ where: { key: AGENT_KEY }, data: { maxTasksPerDay: 0, maxTasksPerWeek: null, maxTasksPerMonth: null } });
  const none = await paceFor(await agentRow());
  check("zero stops an agent that has done nothing at all", none.atCeiling);
  check("and says it plainly", none.note?.includes("no tasks") === true, none.note ?? "");
}

console.log("\nThe shortest biting period is the one named");
{
  await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.update({ where: { key: AGENT_KEY }, data: { maxTasksPerDay: 10, maxTasksPerWeek: 2, maxTasksPerMonth: 100 } });
  await startedToday(2);
  const at = await paceFor(await agentRow());
  check("the week is what is biting, not the day", at.period === "WEEK", `${at.period}`);
  check("and the sentence says this week", at.note?.includes("this week") === true, at.note ?? "");
}

console.log("\nWhat the screen is shown");
{
  const usage = await paceUsage(await agentRow());
  check("every period is reported", usage.length === 3, `${usage.length}`);
  // "12 today, no limit" is the number somebody needs to pick a limit. A
  // screen that only counts once a limit exists cannot help them choose one.
  check("counts come back whether or not a ceiling is set", usage.every((row) => row.started === 2), JSON.stringify(usage));
  check("and the ceiling beside them", usage.find((row) => row.period === "WEEK")?.limit === 2);
}

console.log("\nA held task keeps its place");
{
  // Being at a ceiling is the guardrail working — the same as being over
  // budget, and the same as being at the concurrency limit. It is not an error
  // and it must not move the task.
  await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY, status: "QUEUED" } });
  const waiting = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "waiting", brief: "waiting", status: "QUEUED" },
  });
  await runDueTasks(new Date());
  const after = await prisma.agentTask.findUniqueOrThrow({ where: { id: waiting.id } });
  check("a task held by the ceiling is still queued", after.status === "QUEUED", after.status);
  check("it was not started", after.startedAt === null, `${after.startedAt}`);
  check("and it is not marked failed", after.error === null, `${after.error}`);

  // The control. Raise the ceiling and the same task is startable — otherwise
  // the assertion above passes on an agent that could never run anything.
  await prisma.agent.update({
    where: { key: AGENT_KEY },
    data: { maxTasksPerDay: null, maxTasksPerWeek: null, maxTasksPerMonth: null },
  });
  check("with the ceiling lifted it is no longer held", !(await paceFor(await agentRow())).atCeiling);
}

await reset();
console.log(bad ? `\n${bad} PROBLEM(S)` : `\nPace is a ceiling on how often, and a held task keeps its place.`);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
