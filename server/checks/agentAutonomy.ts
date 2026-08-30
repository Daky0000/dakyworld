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
import { SETTING, clearSettingsCache, setSetting } from "../src/lib/settings.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const AGENT_KEY = "check.autonomy.agent";
const PORT = 4599;

async function reset() {
  await prisma.actionRequest.deleteMany({ where: { agentKey: AGENT_KEY } });
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

console.log("\nWork already waiting holds up a rise");
{
  // An agent at level 1 with dry run on has been *preparing* all along — that
  // is what dry run is for — and every one of those is a decision nobody has
  // made. Raising the level does not carry them out; it means the next one
  // like them happens without being asked, which is worth a look first.
  const prepared = async (createdAt: Date) =>
    prisma.actionRequest.create({
      data: {
        agentKey: AGENT_KEY,
        tool: "email.send",
        input: {},
        wouldDo: "Send a first email to Adom Clinic",
        why: "Their certificate expired.",
        gain: "The strongest opening we have.",
        risk: "Their host may have caused it.",
        createdAt,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });

  await prisma.agent.update({ where: { key: AGENT_KEY }, data: { autonomyLevel: 1, dryRun: true } });
  const old = await prepared(new Date(Date.now() - 50 * 3_600_000));

  const held = await patch({ autonomyLevel: 3 });
  check("raising autonomy over undecided work is held up", held.status === 409, `status ${held.status}`);
  const body = (await held.json()) as { error: string; pending: { waitingHours: number }[] };
  check("the refusal says how long it has been waiting", body.error.includes("50 hour"), body.error.slice(0, 140));
  check("and hands back what is waiting", body.pending?.length === 1, `${body.pending?.length}`);
  const unmoved = await prisma.agent.findUniqueOrThrow({ where: { key: AGENT_KEY } });
  check("nothing was changed", unmoved.autonomyLevel === 1, `${unmoved.autonomyLevel}`);
  check("and no history was written for a change that did not happen", (await history()).length === 2, `${(await history()).length}`);

  // Never refuses twice. It is an acknowledgement, not a permission.
  const through = await patch({ autonomyLevel: 3, acknowledgePending: true, autonomyReason: "Read the queue; it is fine." });
  check("acknowledging it goes through", through.status === 200, `status ${through.status}`);
  const moved = await prisma.agent.findUniqueOrThrow({ where: { key: AGENT_KEY } });
  check("and the agent really moves", moved.autonomyLevel === 3, `${moved.autonomyLevel}`);

  // The safe direction is never held up. Somebody putting an agent *back* into
  // dry run while work waits is doing the cautious thing, and making them
  // acknowledge a queue to do it would be the guard working against itself.
  await prepared(new Date());
  const down = await patch({ autonomyLevel: 1, dryRun: true });
  check("lowering autonomy is never held up", down.status === 200, `status ${down.status}`);

  // A rehearsal's prepared actions are specimens, not proposals — the same
  // reason they stay out of the badge and out of Slack.
  await prisma.actionRequest.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.actionRequest.create({
    data: {
      agentKey: AGENT_KEY,
      tool: "email.send",
      input: {},
      wouldDo: "A rehearsed letter",
      why: "x",
      gain: "x",
      risk: "x",
      rehearsal: true,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  const rehearsed = await patch({ autonomyLevel: 2 });
  check("a rehearsal's specimens do not hold anything up", rehearsed.status === 200, `status ${rehearsed.status}`);

  // An expired card is a re-ask nobody has made.
  await prisma.actionRequest.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.actionRequest.create({
    data: {
      agentKey: AGENT_KEY,
      tool: "email.send",
      input: {},
      wouldDo: "A letter nobody answered",
      why: "x",
      gain: "x",
      risk: "x",
      expiresAt: new Date(Date.now() - 3_600_000),
    },
  });
  await prisma.agent.update({ where: { key: AGENT_KEY }, data: { autonomyLevel: 1 } });
  const expired = await patch({ autonomyLevel: 2 });
  check("an expired card does not hold anything up", expired.status === 200, `status ${expired.status}`);

  // And the flag turns the whole read off.
  await prisma.actionRequest.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.actionRequest.create({
    data: {
      agentKey: AGENT_KEY,
      tool: "email.send",
      input: {},
      wouldDo: "waiting",
      why: "x",
      gain: "x",
      risk: "x",
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  await prisma.agent.update({ where: { key: AGENT_KEY }, data: { autonomyLevel: 1 } });
  await setSetting(SETTING.ENABLE_PENDING_REVIEW, "false");
  clearSettingsCache();
  const off = await patch({ autonomyLevel: 2 });
  check("switching the guard off skips it entirely", off.status === 200, `status ${off.status}`);
  await prisma.appSetting.deleteMany({ where: { key: SETTING.ENABLE_PENDING_REVIEW } });
  clearSettingsCache();
  void old;
}

console.log("\nActivating a batch");
{
  // Every specialist ships as a draft and the roster is fifty-one, so the
  // ordinary first act on this screen is fifty-one visits to a drawer.
  const KEYS = ["check.bulk.a", "check.bulk.b"];
  await prisma.agent.deleteMany({ where: { key: { in: KEYS } } });
  for (const key of KEYS) {
    await prisma.agent.create({
      data: {
        key,
        name: key,
        title: key,
        tier: "SUB_AGENT",
        department: "TECHNOLOGY",
        status: "DRAFT",
        mission: "Exists for one test run.",
        custom: true,
        boundaryViolations: 2,
      },
    });
  }

  const res = await fetch(`http://127.0.0.1:${PORT}/api/agents/bulk`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys: KEYS, status: "ACTIVE" }),
  });
  check("a batch can be switched on", res.status === 200, `status ${res.status}`);
  const body = (await res.json()) as { updated: number };
  check("and it says how many moved", body.updated === 2, `${body.updated}`);
  const rows = await prisma.agent.findMany({ where: { key: { in: KEYS } } });
  check("they really are active", rows.every((row) => row.status === "ACTIVE"), rows.map((r) => r.status).join(","));
  // Being set to Active *is* the human review the strikes were counting up to,
  // exactly as on the single-agent route.
  check("and their boundary strikes are cleared", rows.every((row) => row.boundaryViolations === 0), rows.map((r) => r.boundaryViolations).join(","));

  // Status only. A bulk control over autonomy would be one click that widened
  // the whole workforce, which is the thing this system is built not to have.
  const widening = await fetch(`http://127.0.0.1:${PORT}/api/agents/bulk`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys: KEYS, status: "ACTIVE", autonomyLevel: 4, dryRun: false }),
  });
  check("autonomy cannot be set in bulk", widening.status === 200, `status ${widening.status}`);
  const unchanged = await prisma.agent.findMany({ where: { key: { in: KEYS } } });
  check("the level did not move", unchanged.every((row) => row.autonomyLevel === 1), unchanged.map((r) => r.autonomyLevel).join(","));
  check("and dry run stayed on", unchanged.every((row) => row.dryRun), unchanged.map((r) => r.dryRun).join(","));

  // `/bulk` is one segment on a router carrying `/:key`. Mounted after it,
  // every request would be read as an agent called "bulk".
  check("it was not read as an agent key", body.updated !== undefined);

  await prisma.agent.deleteMany({ where: { key: { in: KEYS } } });
}

await reset();
server.close();
console.log(bad ? `\n${bad} PROBLEM(S)` : `\nAutonomy changes are recorded and the evidence adds up.`);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
