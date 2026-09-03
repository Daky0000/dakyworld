/**
 * A question an agent asked, from being raised to being dealt with.
 *
 * `escalate` wrote BLOCKED to a row and posted a card. That card is right for
 * the first hour and wrong for the second week — it scrolls away, and a
 * question nobody ever answered became indistinguishable from one that was,
 * because nothing counted them. Answering also *requeues* the task, so by the
 * time anybody looks at the roster there is nothing left to say a question had
 * ever been asked.
 *
 * Three things are asserted here and each has a distinct way of going wrong:
 *
 *  - **The flag follows the task.** Derived inside `transition()` rather than
 *    written by its six callers, so a road into BLOCKED nobody thought about
 *    still records that somebody has to decide.
 *  - **The listing is honest.** A rehearsal's questions must not reach it, and
 *    an answered one must leave it.
 *  - **The route is reachable.** `/escalations` is one segment and sits on a
 *    router with `/:key` on it — mounted in the wrong order it answers "No such
 *    agent" for ever, which is a defect no unit test of the handler can see.
 *
 * Database only. No key, no network; Slack is never configured here, so the
 * digest exercises the path where there is nowhere to post.
 */
import express from "express";
import { attachUser, requireAuth } from "../src/middleware/auth.js";
import { agentsRouter } from "../src/routes/agents.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { closeEscalation, openEscalations, postEscalationDigest } from "../src/services/agents/escalationDigest.js";
import { recordCreated, transition } from "../src/services/agents/state.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const AGENT_KEY = "check.escalation.agent";
const PORT = 4598;

async function reset() {
  await prisma.agentTaskTransition.deleteMany({ where: { task: { agentKey: AGENT_KEY } } });
  await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
}

await reset();
await prisma.agent.create({
  data: {
    key: AGENT_KEY,
    name: "Escalation Check",
    title: "Escalation Check",
    tier: "SUB_AGENT",
    department: "TECHNOLOGY",
    status: "ACTIVE",
    mission: "Exists for one test run.",
    custom: true,
  },
});

async function newTask(extra: { rehearsal?: boolean } = {}) {
  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Price the retainer", brief: "Quote it.", ...extra },
  });
  await recordCreated(task.id, task.traceId, "QUEUED", { reason: "Harness.", actor: "check" });
  return task;
}
const statusOf = async (id: string) =>
  (await prisma.agentTask.findUniqueOrThrow({ where: { id }, select: { escalationStatus: true } })).escalationStatus;
const resolutionOf = async (id: string) =>
  prisma.agentTask.findUniqueOrThrow({
    where: { id },
    select: { escalationResolvedAt: true, escalationNote: true },
  });

console.log("\nThe flag follows the task");
{
  const task = await newTask();
  check("a task nobody has asked anything about carries nothing", (await statusOf(task.id)) === null);

  await transition(task.id, { to: "RUNNING", reason: "claimed", actor: "check" });
  check("running is not a question", (await statusOf(task.id)) === null);

  await transition(task.id, { to: "BLOCKED", reason: "Which of the two prices?", actor: "runner" });
  check("stopping to ask records a question", (await statusOf(task.id)) === "PENDING");
  check("and nothing yet says it was dealt with", (await resolutionOf(task.id)).escalationResolvedAt === null);

  await transition(task.id, { to: "QUEUED", reason: "Answered.", actor: "owner" });
  check("answering it records that somebody acted", (await statusOf(task.id)) === "ANSWERED");
  // Derived in `transition()` beside the status rather than passed by a
  // caller. Six roads lead out of BLOCKED and a stamp each of them has to
  // remember is a stamp one of them will not.
  const answered = await resolutionOf(task.id);
  check("and when", answered.escalationResolvedAt !== null, `${answered.escalationResolvedAt}`);

  // The task is back in the queue, so its *status* says nothing about the
  // question any more. That is the whole reason this is a separate column.
  const row = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } });
  check("and the task itself is back to work", row.status === "QUEUED", row.status);

  // A task that stops a second time is waiting on a *new* question, and the
  // age the digest reports has to be that one's age. Last in this section on
  // purpose: it puts the task back into BLOCKED, so anything asserting about
  // the requeue has to have run already.
  await transition(task.id, { to: "RUNNING", reason: "claimed again", actor: "check" });
  await transition(task.id, { to: "BLOCKED", reason: "And the discount?", actor: "runner" });
  const again = await resolutionOf(task.id);
  check("asking again clears the last answer's stamp", again.escalationResolvedAt === null, `${again.escalationResolvedAt}`);
  check("and its note", again.escalationNote === null, `${again.escalationNote}`);
}

console.log("\nEvery road into BLOCKED is a question");
{
  // Not just `escalate`. A skill gap and a task over its own spending ceiling
  // both land here, and both need a person — which is all the flag claims.
  const task = await newTask();
  await transition(task.id, { to: "RUNNING", reason: "claimed", actor: "check" });
  await transition(task.id, { to: "BLOCKED", reason: "Over its own budget.", actor: "runner" });
  check("a budget stop is waiting on somebody too", (await statusOf(task.id)) === "PENDING");
  await prisma.agentTask.deleteMany({ where: { id: task.id } });
}

console.log("\nWhat the listing shows");
{
  const waiting = await newTask();
  await transition(waiting.id, { to: "RUNNING", reason: "claimed", actor: "check" });
  await transition(waiting.id, {
    to: "BLOCKED",
    reason: "asked",
    actor: "runner",
    data: { blockedReason: "Which of the two prices?", finishedAt: new Date() },
  });

  const rehearsed = await newTask({ rehearsal: true });
  await transition(rehearsed.id, { to: "RUNNING", reason: "claimed", actor: "check" });
  await transition(rehearsed.id, { to: "BLOCKED", reason: "asked", actor: "runner" });

  const open = await openEscalations();
  const mine = open.filter((entry) => entry.agentKey === AGENT_KEY);
  check("the waiting question is listed", mine.some((entry) => entry.id === waiting.id));
  // A rehearsal's questions are about a business nobody decided to write to.
  // Same reason they never post a card.
  check("a rehearsal's question is not", !mine.some((entry) => entry.id === rehearsed.id));
  check("the reason it stopped comes with it", mine[0]?.blockedReason === "Which of the two prices?", `${mine[0]?.blockedReason}`);
  check("and who asked", mine[0]?.agentName === "Escalation Check", `${mine[0]?.agentName}`);

  console.log("\nClosing one");
  const closed = await closeEscalation(waiting.id, { who: "Dan" }, "Waiting on the client to confirm the scope.");
  check("closing it succeeds", closed);
  check("it is recorded as closed", (await statusOf(waiting.id)) === "CLOSED");
  // The note is the one thing here nothing else can derive. An *answer* is
  // kept on the brief and in the conversation; a close leaves nothing at all,
  // and "why did nobody act on this" is the question the column exists for.
  const settled = await resolutionOf(waiting.id);
  check("what was decided is kept", settled.escalationNote === "Waiting on the client to confirm the scope.", `${settled.escalationNote}`);
  check("and when it was decided", settled.escalationResolvedAt !== null, `${settled.escalationResolvedAt}`);
  // Read and left is not answered. The task is still stopped; what changed is
  // that nobody needs reminding about it every week.
  const still = await prisma.agentTask.findUniqueOrThrow({ where: { id: waiting.id }, select: { status: true } });
  check("the task is still stopped", still.status === "BLOCKED", still.status);
  check("and it drops out of the listing", !(await openEscalations()).some((entry) => entry.id === waiting.id));
  check("closing it twice does nothing", !(await closeEscalation(waiting.id, { who: "Dan" })));

  const history = await prisma.agentTaskTransition.findMany({ where: { taskId: waiting.id }, orderBy: { at: "asc" } });
  check("who closed it is on the record", history.some((row) => row.reason.includes("closed by Dan")), history.map((r) => r.reason).join(" | "));
  check(
    "and so is what they said",
    history.some((row) => row.reason.includes("Waiting on the client")),
    history.map((r) => r.reason).join(" | "),
  );
}

console.log("\nA question raised before the column existed");
{
  // The migration that added `escalationStatus` did not backfill, and the
  // column is only ever written *during* a transition — so a task already
  // sitting in BLOCKED keeps a null for ever, and the next thing that happens
  // to it writes ANSWERED. The oldest questions in the system were the only
  // ones the digest could not see, while the Agents screen listed them the
  // whole time, because `blockedTasks()` reads `status` instead.
  //
  // The backfill fixes the rows; this fixes the reading, so the two roads
  // agree whatever order a database was migrated in.
  const legacy = await newTask();
  await transition(legacy.id, { to: "RUNNING", reason: "claimed", actor: "check" });
  await transition(legacy.id, {
    to: "BLOCKED",
    reason: "asked",
    actor: "runner",
    data: { blockedReason: "Do we take unregistered businesses?", finishedAt: new Date() },
  });
  await prisma.agentTask.update({ where: { id: legacy.id }, data: { escalationStatus: null } });

  const open = await openEscalations();
  check("it is listed even with nothing recorded", open.some((entry) => entry.id === legacy.id));

  // And it can be dealt with. A row the listing shows and the close endpoint
  // refuses is a question that cannot be taken off the wall.
  check("and it can be closed", await closeEscalation(legacy.id, { who: "Dan" }, "Answered in Slack at the time."));
  check("which records it as closed", (await statusOf(legacy.id)) === "CLOSED");
  check("and it leaves the listing", !(await openEscalations()).some((entry) => entry.id === legacy.id));

  // The other direction, and the half that stops this being a wildcard: a null
  // is only a question when the task is stopped. A queued task carrying
  // nothing has not asked anything.
  const quiet = await newTask();
  check("a task that never asked anything is not a question", !(await openEscalations()).some((entry) => entry.id === quiet.id));
}

console.log("\nThe digest");
{
  // Slack is not configured in a check, which is the branch worth exercising:
  // it must report the count it found and post nothing, rather than throwing
  // inside a scheduler tick.
  const digest = await postEscalationDigest();
  check("with no Slack it posts nothing", !digest.posted);
  check("and still says how many are waiting", digest.count >= 0, `${digest.count}`);
}

console.log("\nThe route is actually reachable");
{
  // `/escalations` is one segment on a router carrying `/:key`. Mounted after
  // it, every request answers "No such agent" — a defect that no test of the
  // handler in isolation can see, and the reason this section exists.
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use("/api", requireAuth);
  app.use("/api/agents", agentsRouter);
  app.use(errorHandler);
  const server = app.listen(PORT, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  const res = await fetch(`http://127.0.0.1:${PORT}/api/agents/escalations`);
  const body = (await res.json()) as { escalations?: unknown[]; error?: string };
  check("GET /agents/escalations answers", res.status === 200, `status ${res.status} — ${body.error ?? ""}`);
  check("and it is the listing, not an agent lookup", Array.isArray(body.escalations), JSON.stringify(body).slice(0, 120));

  const nope = await fetch(`http://127.0.0.1:${PORT}/api/agents/tasks/does-not-exist/escalation/close`, { method: "POST" });
  check("closing a question that is not waiting is refused", nope.status === 409, `status ${nope.status}`);

  // The note travels on the request body and is optional. Optional rather than
  // required on purpose: the button exists to take a dead question off the
  // wall quickly, and a field somebody has to fill in first is a button they
  // stop pressing.
  const asked = await newTask();
  await transition(asked.id, { to: "RUNNING", reason: "claimed", actor: "check" });
  await transition(asked.id, { to: "BLOCKED", reason: "asked", actor: "runner" });
  const viaRoute = await fetch(`http://127.0.0.1:${PORT}/api/agents/tasks/${asked.id}/escalation/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "Superseded by the new brief." }),
  });
  check("closing one over HTTP works", viaRoute.status === 200, `status ${viaRoute.status}`);
  const throughRoute = await resolutionOf(asked.id);
  check("and the note reaches the row", throughRoute.escalationNote === "Superseded by the new brief.", `${throughRoute.escalationNote}`);

  server.close();
}

await reset();
console.log(bad ? `\n${bad} PROBLEM(S)` : `\nA question is raised, listed, and settled.`);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
