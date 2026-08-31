/**
 * The crafts enough agents have asked for that the answer is a decision.
 *
 * `recordGap` has counted `timesRequested` since the hiring loop shipped, and
 * nothing ever read it except a Slack command somebody had to think to type.
 * Every gap does raise a review on the Agent Creator's queue when it is
 * filed — but that road is exactly the one that goes quiet when the Agent
 * Creator is a draft, is retired, or has its review cancelled, which is the
 * case this exists to make visible.
 *
 * Three things are asserted and each fails differently:
 *
 *  - **The count is of separate agents, not of requests.** One agent asking
 *    three times is one agent's frustration; three agents on three jobs is the
 *    argument. `requestedByKeys` is a set and the count is its size, so a
 *    single agent must never reach the threshold on its own.
 *  - **A settled gap leaves.** Filled and declined are decisions already made,
 *    and a list that keeps showing them is a list nobody finishes reading.
 *  - **The notice is silent with nothing to say.** A weekly message that
 *    arrives every week saying "nothing to report" is one people stop opening,
 *    and the week it matters is the week it is ignored.
 *
 * Database only. No key, no network; Slack is never configured here, which is
 * the branch worth exercising — the notice must report what it found and post
 * nothing, rather than throwing inside a scheduler tick.
 */
import { gapsReadyToDecide, postGapNotice, recordGap } from "../src/services/agents/hiring.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const SKILL = "keep the books for a limited company";
const QUIET = "restring a double bass";
const ASKERS = ["check.gap.one", "check.gap.two", "check.gap.three"];

async function reset() {
  const gaps = await prisma.agentGap.findMany({
    where: { skillNeeded: { in: [SKILL, QUIET] } },
    select: { id: true },
  });
  for (const gap of gaps) {
    // The review task is keyed on the gap id inside `input`, and it is created
    // on a real agent — the Agent Creator — so it cannot be swept by agent key.
    await prisma.agentTask.deleteMany({ where: { input: { path: ["gapId"], equals: gap.id } } });
  }
  await prisma.agentGap.deleteMany({ where: { skillNeeded: { in: [SKILL, QUIET] } } });
  await prisma.agent.deleteMany({ where: { key: { in: ASKERS } } });
}

await reset();

for (const key of ASKERS) {
  await prisma.agent.create({
    data: {
      key,
      name: `Gap Check ${key.slice(-3)}`,
      title: "Gap Check",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      mission: "Exists for one test run.",
      custom: true,
    },
  });
}

const mine = async () => (await gapsReadyToDecide()).filter((gap) => gap.skillNeeded === SKILL);

console.log("\nOne agent asking is not an argument");
{
  await recordGap({ requestedByKey: ASKERS[0], skillNeeded: SKILL, reason: "The retainer accounts need reconciling and it is not my craft." });
  check("one asker is below the threshold", (await mine()).length === 0, `${(await mine()).length}`);

  // The same agent again. `requestedByKeys` is a set, so this must not count.
  await recordGap({ requestedByKey: ASKERS[0], skillNeeded: SKILL, reason: "Again, and still not my craft." });
  const row = await prisma.agentGap.findFirstOrThrow({ where: { skillNeeded: SKILL } });
  check("the same agent asking twice counts once", row.timesRequested === 1, `${row.timesRequested}`);
  check("and it is still below the threshold", (await mine()).length === 0);
}

console.log("\nThree separate agents is");
{
  await recordGap({ requestedByKey: ASKERS[1], skillNeeded: SKILL, reason: "I cannot close the month either, and it is not mine." });
  check("two is still not enough", (await mine()).length === 0, `${(await mine()).length}`);

  await recordGap({ requestedByKey: ASKERS[2], skillNeeded: SKILL, reason: "Third job this week that stopped on the same thing." });
  const ready = await mine();
  check("three separate agents reaches it", ready.length === 1, `${ready.length}`);
  check("and it counts three", ready[0]?.timesRequested === 3, `${ready[0]?.timesRequested}`);
  check("and names all three", ASKERS.every((key) => ready[0]?.requestedBy.includes(key)), ready[0]?.requestedBy.join(", "));
  // Read from the Agent Creator's own queue rather than assumed. A gap with no
  // review open on it is one nothing is carrying forward, which is a different
  // problem from one nobody has decided yet — and the dashboard counts them apart.
  check("and says whether anything is reviewing it", "reviewTaskId" in (ready[0] ?? {}), JSON.stringify(ready[0]).slice(0, 160));
}

console.log("\nA rehearsal never grows the workforce");
{
  const before = (await mine())[0]?.timesRequested ?? 0;
  const outcome = await recordGap({
    requestedByKey: ASKERS[0],
    skillNeeded: SKILL,
    reason: "Raised against a scratch lead during a rehearsal.",
    rehearsal: true,
  });
  check("a rehearsal files nothing", outcome.gapId === "rehearsal", outcome.gapId);
  check("and the real count is untouched", ((await mine())[0]?.timesRequested ?? 0) === before, `${(await mine())[0]?.timesRequested}`);
}

console.log("\nA settled gap leaves the list");
{
  const row = await prisma.agentGap.findFirstOrThrow({ where: { skillNeeded: SKILL } });
  await prisma.agentGap.update({ where: { id: row.id }, data: { status: "FILLED" } });
  check("a filled gap is not waiting on a decision", (await mine()).length === 0);

  await prisma.agentGap.update({ where: { id: row.id }, data: { status: "DECLINED" } });
  check("nor is a declined one", (await mine()).length === 0);

  // IN_REVIEW is not settled — it is the Agent Creator holding it, which is
  // exactly the state that goes quiet when nothing is actually reviewing.
  await prisma.agentGap.update({ where: { id: row.id }, data: { status: "IN_REVIEW" } });
  check("one under review is still waiting on a decision", (await mine()).length === 1);
}

console.log("\nThe notice");
{
  // Slack is not configured in a check. It must report the count it found and
  // post nothing, rather than throwing inside a scheduler tick.
  const notice = await postGapNotice();
  check("with no Slack it posts nothing", !notice.posted);
  check("and still says how many are waiting", notice.count >= 1, `${notice.count}`);

  await prisma.agentGap.updateMany({ where: { skillNeeded: SKILL }, data: { status: "FILLED" } });
  const quiet = await postGapNotice();
  const others = await gapsReadyToDecide();
  // Only meaningful on a database with no other gap over the threshold, which
  // is the ordinary case — said rather than asserted blindly, because a real
  // database is allowed to have its own.
  if (others.length === 0) check("with nothing to say it says nothing", !quiet.posted && quiet.count === 0, `${quiet.count}`);
  else check("with nothing of its own it reports only the others", quiet.count === others.length, `${quiet.count} vs ${others.length}`);
}

await reset();
console.log(bad ? `\n${bad} PROBLEM(S)` : `\nA craft three agents have asked for is a decision somebody can see.`);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
