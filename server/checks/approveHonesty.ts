/**
 * Does approving a task still close it while its letters wait?
 *
 * `POST /agents/tasks/:id/approve` predates the approval queue. Once the queue
 * existed the two disagreed: the route wrote DONE on the task while the actions
 * that task had prepared sat PENDING under Approvals, so the board said the
 * work was finished and the email had not been sent. Two records of one
 * decision, one of them wrong.
 *
 * Driven over real HTTP against the router as `index.ts` mounts it, because the
 * thing under test is the route rather than a service — and a check that calls
 * the service directly proves nothing about what the button does.
 *
 * Database only, no keys:
 *   npx tsx checks/approveHonesty.ts
 */
import express from "express";
import { prisma } from "../src/lib/prisma.js";
import { agentsRouter } from "../src/routes/agents.js";
import { attachUser, requireAuth } from "../src/middleware/auth.js";
import { recordCreated, transition } from "../src/services/agents/state.js";

const AGENT_KEY = "tmp.approvehonesty";
const PORT = 4597;

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

async function reset() {
  const tasks = await prisma.agentTask.findMany({ where: { agentKey: AGENT_KEY }, select: { id: true } });
  const ids = tasks.map((t) => t.id);
  if (ids.length > 0) {
    await prisma.actionRequest.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.actionRequest.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
}

async function main() {
  await reset();

  await prisma.agent.create({
    data: {
      key: AGENT_KEY,
      name: "Approve Honesty",
      title: "Harness",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      mission: "Exists for one test run.",
      toolkit: ["email.send"],
    },
  });

  const app = express();
  app.use(express.json());
  // Mounted the way index.ts mounts it. Without attachUser the router answers
  // 401 to everything and the check reports a defect in the route that is
  // really a defect in the harness.
  app.use(attachUser);
  app.use("/api", requireAuth);
  app.use("/api/agents", agentsRouter);
  const server = app.listen(PORT, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));

  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Write to somebody", brief: "Prepare a letter.", origin: "OWNER" },
  });
  await recordCreated(task.id, task.traceId, task.status, { reason: "Harness.", actor: "check" });
  await transition(task.id, { to: "RUNNING", reason: "Claimed.", actor: "check" });
  await transition(task.id, {
    to: "NEEDS_APPROVAL",
    reason: "Prepared one action.",
    actor: "check",
    data: { dryRunCalls: 1, finishedAt: new Date() },
  });

  const waiting = await prisma.actionRequest.create({
    data: {
      agentKey: AGENT_KEY,
      taskId: task.id,
      tool: "email.send",
      input: { to: "nobody@example.com" } as never,
      wouldDo: "Send a first email to nobody@example.com.",
      why: "harness",
      gain: "harness",
      risk: "none",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  const approve = () => fetch(`http://127.0.0.1:${PORT}/api/agents/tasks/${task.id}/approve`, { method: "POST" });

  console.log("\nWith a letter still waiting");
  const blocked = await approve();
  const blockedBody = (await blocked.json()) as { error?: string; pending?: unknown[] };
  check("the route refuses", blocked.status === 409, `got ${blocked.status}`);
  check("it says what is waiting", (blockedBody.pending ?? []).length === 1, JSON.stringify(blockedBody.pending));
  const still = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { status: true } });
  check("the task is still waiting on approval", still?.status === "NEEDS_APPROVAL", String(still?.status));

  console.log("\nOnce the letter has been decided");
  await prisma.actionRequest.update({ where: { id: waiting.id }, data: { status: "EXECUTED" } });
  const ok = await approve();
  check("the route accepts", ok.status === 200, `got ${ok.status}`);
  const done = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { status: true } });
  check("the task closes", done?.status === "DONE", String(done?.status));

  const history = await prisma.agentTaskTransition.findMany({ where: { taskId: task.id }, orderBy: { at: "asc" } });
  check(
    "the acceptance is on the history with a person as the actor",
    history.at(-1)?.to === "DONE" && history.at(-1)?.actor === "owner",
    `${history.at(-1)?.actor} -> ${history.at(-1)?.to}`,
  );

  server.close();
  await reset();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

void main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exitCode = 1;
});
