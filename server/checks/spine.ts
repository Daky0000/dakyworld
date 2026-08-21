/**
 * Does the execution spine hold?
 *
 * Six claims, each of which was false before this pass and each of which is
 * easy to make false again by accident:
 *
 *  1. A task's status can only move where the table says it may.
 *  2. Every move that happens is written down, with a reason and an actor.
 *  3. One trace gathers a task, its tool calls and its model calls.
 *  4. A tool step carries the id of the `ToolCall` it produced.
 *  5. An outward call with an idempotency key runs once, however often it is
 *     asked for.
 *
 * A sixth — that a finished run keeps its token counts — is asserted in
 * `spineEndToEnd.ts` instead. It was here, simulating by hand the sequence
 * `finishTask` performs, and that is a check which goes on passing after the
 * code stops working that way: the counts come from the `LlmCall` ledger now
 * rather than from the checkpoint, and the simulation would never have noticed.
 *
 * Number five is the one that matters most and the one most likely to pass for
 * the wrong reason, so it is asserted as a **count of gate crossings** rather
 * than a count of effects: a tool that dedupes its own writes would otherwise
 * make this green while the gate let both calls through. That is the trap
 * `tmp/approvalFlow.ts` documented and it applies here for the same reason.
 *
 * Database only. No API key, no network, no Docker beyond Postgres itself.
 *   npx tsx checks/spine.ts
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import { withRunContext } from "../src/lib/runContext.js";
import { recordLlmCall } from "../src/lib/llmLedger.js";
import { invokeTool } from "../src/services/tools/invoke.js";
import { canTransition, historyOf, IllegalTransition, recordCreated, transition } from "../src/services/agents/state.js";
import { step } from "../src/services/agents/runner.js";

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

const AGENT_KEY = "check.spine";
const MARK = "spinecheck";

/**
 * Deletes everything this run made.
 *
 * Called at the start and at the end, and the final call must be the
 * delete-only half — a reset that also creates would re-make on the way out
 * exactly what it was meant to remove, which is a leftover two earlier
 * harnesses shipped with.
 */
async function reset() {
  const tasks = await prisma.agentTask.findMany({ where: { agentKey: AGENT_KEY }, select: { id: true } });
  const ids = tasks.map((t) => t.id);
  if (ids.length > 0) {
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskCheckpoint.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.llmCall.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.toolCall.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.toolCall.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.actionRequest.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
  await prisma.lead.deleteMany({ where: { contactName: { startsWith: MARK } } });
}

async function makeAgent(overrides: { autonomyLevel?: number; dryRun?: boolean; toolkit?: string[] } = {}) {
  return prisma.agent.create({
    data: {
      key: AGENT_KEY,
      name: "Spine Check",
      title: "Harness",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      mission: "Exists for the duration of one test run.",
      autonomyLevel: overrides.autonomyLevel ?? 4,
      dryRun: overrides.dryRun ?? false,
      toolkit: overrides.toolkit ?? ["lead.read"],
    },
  });
}

async function makeTask(title: string) {
  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title, brief: "Nothing. This is a harness.", origin: "OWNER" },
  });
  await recordCreated(task.id, task.traceId, task.status, { reason: "Raised by the harness.", actor: "check" });
  return task;
}

// --- 1 & 2. The state machine -------------------------------------------------

async function statesAreGuardedAndLogged() {
  console.log("\nThe state machine");
  const task = await makeTask("guarded");

  check("a legal move is allowed", canTransition("QUEUED", "RUNNING"));
  check("a terminal state cannot reach another directly", !canTransition("FAILED", "DONE"));
  check("a second claim on a running task is illegal", !canTransition("RUNNING", "RUNNING"));

  const claimed = await transition(task.id, { to: "RUNNING", reason: "Claimed by the harness", actor: "check" });
  check("the claim moved it", claimed.moved && claimed.from === "QUEUED");

  // The row is RUNNING now, so a claim expecting QUEUED must lose rather than
  // throw: that is a race being handled, not a programming mistake.
  const raced = await transition(task.id, {
    to: "RUNNING",
    reason: "A second process trying the same claim",
    actor: "check",
    expect: ["QUEUED"],
  });
  check("a lost race returns moved:false rather than throwing", !raced.moved && raced.lostTo === "RUNNING");

  await transition(task.id, { to: "FAILED", reason: "Pretending to fail", actor: "check" });

  let threw: unknown = null;
  try {
    await transition(task.id, { to: "DONE", reason: "Rewriting an outcome in place", actor: "check" });
  } catch (err) {
    threw = err;
  }
  check("an illegal move throws IllegalTransition", threw instanceof IllegalTransition);

  const after = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { status: true } });
  check("the illegal move did not touch the row", after?.status === "FAILED");

  const history = await historyOf(task.id);
  check("every move is on the history", history.length === 3, `${history.length} entries`);
  check("the first entry has no prior state", history[0]?.from === null && history[0]?.to === "QUEUED");
  check("each entry carries a reason and an actor", history.every((h) => h.reason.length > 0 && h.actor.length > 0));
  check("each entry carries the trace", history.every((h) => h.traceId === task.traceId));
}

// --- 3 & 4. The trace ----------------------------------------------------------

async function oneTraceGathersTheRun() {
  console.log("\nThe trace");
  const task = await makeTask("traced");

  // What the runner does: everything inside the task's own context, so a
  // record written with no idea which task it belongs to is attributed anyway.
  await withRunContext({ taskId: task.id, traceId: task.traceId, agentKey: AGENT_KEY }, async () => {
    const result = await invokeTool("lead.read", { limit: 1 }, { agentKey: AGENT_KEY, userId: null, dryRun: false });
    check("the tool result carries the id of its own audit row", Boolean(result.callId), JSON.stringify(result.error ?? ""));
    await step(task.id, "TOOL_CALL", "lead.read", { tool: "lead.read", toolCallId: result.callId, ok: true });

    // A model call four frames from anything holding a task id. Nothing is
    // passed: the point is that the ambient context supplies it.
    await recordLlmCall({
      purpose: `agent.${AGENT_KEY}`,
      model: "harness",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
      durationMs: 5,
      ok: true,
    });
  });

  const calls = await prisma.toolCall.findMany({ where: { taskId: task.id } });
  check("the tool call joins back to its task", calls.length === 1, `${calls.length} rows`);
  check("the tool call carries the trace", calls[0]?.traceId === task.traceId);

  const models = await prisma.llmCall.findMany({ where: { taskId: task.id } });
  check("the model call joins back to its task with no caller passing it", models.length === 1, `${models.length} rows`);
  check("the model call carries the agent and the trace", models[0]?.agentKey === AGENT_KEY && models[0]?.traceId === task.traceId);

  const steps = await prisma.agentTaskStep.findMany({ where: { taskId: task.id, kind: "TOOL_CALL" } });
  check("the step names the ToolCall row it produced", steps[0]?.toolCallId === calls[0]?.id, String(steps[0]?.toolCallId));

  // The whole point: one id, everything it caused.
  const [byTraceTools, byTraceModels, byTraceMoves] = await Promise.all([
    prisma.toolCall.count({ where: { traceId: task.traceId } }),
    prisma.llmCall.count({ where: { traceId: task.traceId } }),
    prisma.agentTaskTransition.count({ where: { traceId: task.traceId } }),
  ]);
  check("one trace gathers the tool calls, the model calls and the history", byTraceTools === 1 && byTraceModels === 1 && byTraceMoves === 1);

  // Outside the context, nothing is attributed — which is what stops an
  // approval executing months later inheriting whatever is running now.
  await recordLlmCall({
    purpose: "unattributed",
    model: "harness",
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
    durationMs: 1,
    ok: true,
  });
  const stray = await prisma.llmCall.findFirst({ where: { purpose: "unattributed" }, orderBy: { createdAt: "desc" } });
  check("a call outside any run is attributed to no task", stray?.taskId === null);
  if (stray) await prisma.llmCall.delete({ where: { id: stray.id } });
}

// --- 6. Idempotency ------------------------------------------------------------

async function anOutwardCallHappensOnce() {
  console.log("\nAsking twice");
  const task = await makeTask("idempotent");

  // `webhook.dispatch` is outward and refuses plain http, so it can never
  // reach a local listener — which is fine here, because what is under test is
  // the gate in front of it rather than the delivery behind it. A URL that
  // resolves to nothing gives a failed first call, and a failed call must NOT
  // be replayed: that is half the contract.
  const failing = { url: "https://localhost:9/never", event: MARK, payload: { n: 1 } };
  const key = `${task.id}:webhook.dispatch:${randomUUID()}`;

  await withRunContext({ taskId: task.id, traceId: task.traceId, agentKey: AGENT_KEY }, async () => {
    await prisma.agent.update({ where: { key: AGENT_KEY }, data: { toolkit: ["lead.read", "webhook.dispatch"] } });

    const first = await invokeTool("webhook.dispatch", failing, {
      agentKey: AGENT_KEY,
      userId: null,
      dryRun: false,
      taskId: task.id,
      idempotencyKey: key,
      rationale: { why: "harness", gain: "harness", risk: "none" },
    });
    const second = await invokeTool("webhook.dispatch", failing, {
      agentKey: AGENT_KEY,
      userId: null,
      dryRun: false,
      taskId: task.id,
      idempotencyKey: key,
      rationale: { why: "harness", gain: "harness", risk: "none" },
    });

    check("a call that failed is not replayed as a success", !first.ok && !second.replayed, `first.ok=${first.ok} replayed=${second.replayed}`);
  });

  // Now the other half, with a call that succeeded. `lead.read` is not outward,
  // so the guard must ignore it entirely — writing that down because widening
  // the guard to every tool would turn a repeated lookup into a stale answer.
  const readKey = `${task.id}:lead.read:${randomUUID()}`;
  await invokeTool("lead.read", { limit: 1 }, { agentKey: AGENT_KEY, userId: null, dryRun: false, taskId: task.id, idempotencyKey: readKey });
  await invokeTool("lead.read", { limit: 1 }, { agentKey: AGENT_KEY, userId: null, dryRun: false, taskId: task.id, idempotencyKey: readKey });
  const reads = await prisma.toolCall.count({ where: { idempotencyKey: readKey, ok: true } });
  const replayedRead = await prisma.toolCall.count({ where: { idempotencyKey: readKey, output: { path: ["replayed"], equals: true } } });
  check("a read tool is never held back by the guard", reads === 2 && replayedRead === 0, `${reads} calls, ${replayedRead} replayed`);

  // And the case the guard exists for: an outward call that genuinely
  // succeeded. Faked as a recorded row, because no outward tool in the
  // catalogue can succeed without reaching somebody else's server.
  const sentKey = `${task.id}:webhook.dispatch:${randomUUID()}`;
  await prisma.toolCall.create({
    data: {
      tool: "webhook.dispatch",
      agentKey: AGENT_KEY,
      taskId: task.id,
      traceId: task.traceId,
      idempotencyKey: sentKey,
      ok: true,
      dryRun: false,
      output: { status: 200 } as never,
    },
  });
  const again = await invokeTool(
    "webhook.dispatch",
    { url: "https://localhost:9/never", event: MARK, payload: { n: 2 } },
    {
      agentKey: AGENT_KEY,
      userId: null,
      dryRun: false,
      taskId: task.id,
      idempotencyKey: sentKey,
      rationale: { why: "harness", gain: "harness", risk: "none" },
    },
  );
  check("an outward call already carried out is not carried out again", again.replayed === true, JSON.stringify(again.error ?? again.refusedReason ?? ""));
  check("the replay reports the first call's own result", (again.output as { status?: number } | null)?.status === 200);

  // The crossing count, not the effect count. A tool that deduped its own
  // writes would pass an effect count while the gate let both through.
  // Filtered here rather than in the query: `equals: undefined` on a JSON path
  // is not a Prisma filter, it is Prisma being told nothing about that field.
  const rows = await prisma.toolCall.findMany({ where: { idempotencyKey: sentKey, ok: true, dryRun: false }, select: { output: true } });
  const crossings = rows.filter((r) => !(r.output as { replayed?: boolean } | null)?.replayed).length;
  check("the gate was crossed once", crossings === 1, `${crossings} crossings of ${rows.length} rows`);
}

async function main() {
  console.log("Execution spine\n===============");
  await reset();
  await makeAgent();

  await statesAreGuardedAndLogged();
  await oneTraceGathersTheRun();
  await anOutwardCallHappensOnce();

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
