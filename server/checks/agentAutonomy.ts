/**
 * Autonomy is a decision, and now it leaves a record.
 *
 * The autonomy level and the dry-run flag together decide whether software may
 * act on a client without a person seeing it first. They are the two most
 * consequential fields on the whole agents router, they have always been gated
 * behind a permission — and until Aug 2026 changing either left no trace at
 * all. "Who turned dry run off, and when, and why" had no answer anywhere in
 * the system.
 *
 * Driven over **real HTTP through the real router**, mounted exactly as
 * `index.ts` mounts it. That matters for the same reason it matters in
 * `tmp/accessOverHttp.ts`: the history write lives inside the handler, after
 * the permission gate and after the update, and calling the function directly
 * would prove nothing about whether a request actually reaches it.
 *
 * Needs a database and nothing else. `checks/run.ts` sets `DEV_NO_AUTH=true`,
 * so `attachUser` resolves a real Owner row with real permissions rather than
 * the harness inventing one.
 */
import express from "express";
import { attachUser, requireAuth } from "../src/middleware/auth.js";
import { agentsRouter } from "../src/routes/agents.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const AGENT_KEY = "check.autonomy.agent";
const PORT = 4599;

async function reset() {
  await prisma.agentAutonomyChange.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agentTaskTransition.deleteMany({ where: { task: { agentKey: AGENT_KEY } } });
  await prisma.toolCall.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
}

await reset();
await prisma.agent.create({
  data: {
    key: AGENT_KEY,
    name: "Autonomy Check",
    title: "Autonomy Check",
    tier: "SUB_AGENT",
    department: "TECHNOLOGY",
    status: "ACTIVE",
    mission: "Exists for one test run.",
    toolkit: ["lead.read"],
    custom: true,
    autonomyLevel: 1,
    dryRun: true,
  },
});

const app = express();
app.use(express.json());
app.use(attachUser);
app.use("/api", requireAuth);
app.use("/api/agents", agentsRouter);
app.use(errorHandler);
const server = app.listen(PORT, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));

const patch = (body: unknown) =>
  fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_KEY}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const history = () => prisma.agentAutonomyChange.findMany({ where: { agentKey: AGENT_KEY }, orderBy: { at: "asc" } });

console.log("\nA change with a reason");
{
  const res = await patch({ autonomyLevel: 2, autonomyReason: "It has drafted twenty proposals and none needed correcting." });
  check("the change is accepted", res.status === 200, `status ${res.status}`);
  const rows = await history();
  check("one entry was written", rows.length === 1, `${rows.length} entries`);
  check("it records where it came from", rows[0]?.fromLevel === 1, `from ${rows[0]?.fromLevel}`);
  check("and where it went", rows[0]?.toLevel === 2, `to ${rows[0]?.toLevel}`);
  check("the Owner's own words are kept", rows[0]?.reason.includes("twenty proposals") === true, rows[0]?.reason);
  check("and who did it", rows[0]?.actor === "owner" && Boolean(rows[0]?.actorId), `${rows[0]?.actor} / ${rows[0]?.actorId}`);
  // `autonomyReason` is not a column on Agent. Left in the spread it would take
  // the whole update down, which is the failure this line exists to catch.
  const agent = await prisma.agent.findUniqueOrThrow({ where: { key: AGENT_KEY } });
  check("the agent really moved", agent.autonomyLevel === 2, `level ${agent.autonomyLevel}`);
}

console.log("\nA change with no reason");
{
  await patch({ dryRun: false });
  const rows = await history();
  check("dry run coming off is recorded", rows.length === 2, `${rows.length} entries`);
  check("only the flag is recorded, not a level that did not move", rows[1]?.toLevel === null, `toLevel ${rows[1]?.toLevel}`);
  check("the flag's move is recorded", rows[1]?.fromDryRun === true && rows[1]?.toDryRun === false);
  // Never blank and never "changed". A history of unexplained rows is a list.
  check(
    "the reason describes the move rather than being empty",
    rows[1]?.reason.includes("dry run switched off") === true,
    rows[1]?.reason,
  );
}

console.log("\nWhat is not a change");
{
  // The commonest PATCH on this router by far is a wording edit, and it must
  // not fill the history with rows saying nothing happened.
  await patch({ mission: "Still exists for one test run." });
  await patch({ autonomyLevel: 2 });
  const rows = await history();
  check("editing a mission writes no autonomy history", rows.length === 2, `${rows.length} entries`);
  check("setting a level to what it already is writes nothing", rows.length === 2, `${rows.length} entries`);
}

console.log("\nThe evidence behind a decision");
{
  const done = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "finished", brief: "finished", status: "DONE", toolCalls: 4, dryRunCalls: 1 },
  });
  await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "failed", brief: "failed", status: "FAILED", toolCalls: 2, dryRunCalls: 2 },
  });
  // Counted off the transition, not the task's current status: a task that
  // stopped to ask and was later answered and finished must still read as
  // having escalated once.
  await prisma.agentTaskTransition.create({ data: { taskId: done.id, from: "RUNNING", to: "BLOCKED", reason: "asked", actor: "check" } });
  // A rehearsal is a test of the workforce, not evidence about it.
  await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "rehearsed", brief: "rehearsed", status: "DONE", rehearsal: true, toolCalls: 90, dryRunCalls: 90 },
  });

  const res = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_KEY}/autonomy`);
  const body = (await res.json()) as {
    history: unknown[];
    evidence: { successRate: number | null; toolCalls: number; preparedShare: number | null; escalations: number };
  };
  check("the endpoint answers", res.status === 200, `status ${res.status}`);
  check("it returns the history", body.history.length === 2, `${body.history.length} entries`);
  check("one done, one failed is a half success rate", body.evidence.successRate === 0.5, `${body.evidence.successRate}`);
  check("a rehearsal is not evidence about the agent", body.evidence.toolCalls === 6, `${body.evidence.toolCalls} tool calls`);
  check("prepared share is read from the same ledger", body.evidence.preparedShare === 0.5, `${body.evidence.preparedShare}`);
  check("an answered escalation still counts as one", body.evidence.escalations === 1, `${body.evidence.escalations}`);
}

console.log("\nNo evidence is not a zero");
{
  // The rule the costs screen states: a window with none of something is not
  // zero and is not a dash, it is a thing we have no evidence about. An agent
  // nobody has given work to must not read as one that fails everything.
  const EMPTY = "check.autonomy.empty";
  await prisma.agent.deleteMany({ where: { key: EMPTY } });
  await prisma.agent.create({
    data: {
      key: EMPTY,
      name: "Never Worked",
      title: "Never Worked",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "DRAFT",
      mission: "Has never been given anything.",
      custom: true,
    },
  });
  const res = await fetch(`http://127.0.0.1:${PORT}/api/agents/${EMPTY}/autonomy`);
  const body = (await res.json()) as { evidence: { successRate: number | null; preparedShare: number | null } };
  check("an agent with no finished tasks has no success rate", body.evidence.successRate === null, `${body.evidence.successRate}`);
  check("and no prepared share", body.evidence.preparedShare === null, `${body.evidence.preparedShare}`);
  await prisma.agent.deleteMany({ where: { key: EMPTY } });
}

await reset();
server.close();
console.log(bad ? `\n${bad} PROBLEM(S)` : `\nAutonomy changes are recorded and the evidence adds up.`);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
