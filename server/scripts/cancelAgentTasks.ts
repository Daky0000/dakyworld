/**
 * Cancels every agent task that has not finished, keeping the history.
 *
 * The blunt way to clear the board is `DELETE FROM "AgentTask"`, and it is
 * wrong for a reason that only shows up later: the transitions, the steps, the
 * costs and the turnaround times are what the performance reporting is built
 * to read. Throwing the rows away buys a tidy screen today and an empty
 * dashboard for ever. Cancelling says the same thing to anyone looking at the
 * board — nothing is waiting on you — and leaves the record of what happened.
 *
 * **Every move goes through `transition()`**, which is the only thing allowed
 * to write a status. It refuses an illegal move, it writes an
 * `AgentTaskTransition` for each one, and it settles the escalation flag on the
 * way out of BLOCKED. Updating the rows directly would be faster and would
 * leave nine tasks that had been cancelled by nobody, for no reason, with the
 * questions they raised still counted as waiting.
 *
 * Running tasks are asked to stop as well as cancelled: the loop checks
 * `interruptRequested` between iterations, so a run already in flight notices
 * rather than carrying on and writing its outcome over this.
 *
 *   # Look first, change nothing:
 *   npx tsx scripts/cancelAgentTasks.ts
 *
 *   # Then do it:
 *   npx tsx scripts/cancelAgentTasks.ts --yes
 *
 *   # Only the ones stuck waiting on somebody:
 *   npx tsx scripts/cancelAgentTasks.ts --only-waiting --yes
 *
 *   # Against the deployed database, from the server directory:
 *   railway run npx tsx scripts/cancelAgentTasks.ts --yes
 */
import type { AgentTaskStatus } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { IllegalTransition, transition } from "../src/services/agents/state.js";

/** Everything that has not reached an end. */
const UNFINISHED: AgentTaskStatus[] = ["QUEUED", "RUNNING", "NEEDS_APPROVAL", "BLOCKED"];
/** The subset that is sitting waiting for a person. */
const WAITING: AgentTaskStatus[] = ["BLOCKED", "NEEDS_APPROVAL"];

async function main() {
  const args = new Set(process.argv.slice(2));
  const commit = args.has("--yes");
  const onlyWaiting = args.has("--only-waiting");
  const includeRehearsals = args.has("--include-rehearsals");

  const statuses = onlyWaiting ? WAITING : UNFINISHED;

  const tasks = await prisma.agentTask.findMany({
    where: {
      status: { in: statuses },
      // A rehearsal's tasks are a specimen, and tearing them down is the
      // rehearsal's own job — it puts back the autonomy it borrowed. Cancelling
      // them from outside leaves that half undone.
      ...(includeRehearsals ? {} : { rehearsal: false }),
    },
    select: { id: true, agentKey: true, title: true, status: true, blockedReason: true },
    orderBy: { createdAt: "asc" },
  });

  const counts = new Map<AgentTaskStatus, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);

  console.log(`${tasks.length} unfinished task(s)${onlyWaiting ? " waiting on a person" : ""}:`);
  for (const [status, count] of counts) console.log(`  ${status.padEnd(16)} ${count}`);
  for (const task of tasks.slice(0, 20)) {
    console.log(`  · ${task.agentKey} — ${task.title.slice(0, 70)} (${task.status})`);
  }
  if (tasks.length > 20) console.log(`  …and ${tasks.length - 20} more.`);

  // Prepared actions outlive the task that prepared them, and an approval whose
  // task has been cancelled is a button that would carry out work nobody is
  // waiting for any more. Reported rather than decided here: declining somebody
  // else's prepared payment is not this script's call.
  const pending = await prisma.actionRequest.count({ where: { status: "PENDING" } });
  if (pending > 0) {
    console.log(`\n${pending} prepared action(s) are still waiting under Approvals. Cancelling a task does not decide them.`);
  }

  if (!commit) {
    console.log("\nNothing was changed. Pass --yes to cancel them.");
    await prisma.$disconnect();
    return;
  }

  let cancelled = 0;
  let missed = 0;
  const problems: string[] = [];

  for (const task of tasks) {
    try {
      const moved = await transition(task.id, {
        to: "CANCELLED",
        reason: "Cleared by the Owner — every unfinished agent task was cancelled together.",
        actor: "owner",
        // Only out of where it was when we looked. A task that started running,
        // finished, or was answered in the seconds since is not ours to
        // overwrite, and losing that race is a normal outcome rather than a
        // fault.
        expect: statuses,
        data: { interruptRequested: true, finishedAt: new Date() },
      });
      if (moved.moved) cancelled += 1;
      else missed += 1;
    } catch (err) {
      missed += 1;
      if (err instanceof IllegalTransition) problems.push(`${task.id}: ${err.message}`);
      else problems.push(`${task.id}: ${(err as Error).message}`);
    }
  }

  console.log(`\nCancelled ${cancelled} task(s).`);
  if (missed > 0) console.log(`${missed} moved on before this reached them and were left alone.`);
  for (const problem of problems.slice(0, 10)) console.log(`  ! ${problem}`);

  const left = await prisma.agentTask.count({
    where: { status: { in: UNFINISHED }, ...(includeRehearsals ? {} : { rehearsal: false }) },
  });
  console.log(`${left} unfinished task(s) remain.`);

  await prisma.$disconnect();
}

void main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
