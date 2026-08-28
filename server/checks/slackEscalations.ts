/**
 * Can a person actually decide from Slack, and does deciding anywhere show?
 *
 * Three things this pins down, all of which shipped broken or missing:
 *
 * 1. **An agent that stops and asks is heard.** `escalate` wrote BLOCKED to a
 *    row and nothing else. The question reached no channel, no inbox and no
 *    notification, so an escalation was indistinguishable from an agent that
 *    simply stopped. The card is best-effort — it is not what this asserts —
 *    but *answering* has to work from Slack, and it has to leave the task in
 *    the state the button promised.
 *
 * 2. **One answer, everywhere.** The browser and Slack used to be two copies
 *    of "append to the brief, rejoin the conversation, requeue". They are one
 *    path now, and the thing that would silently rot is the Slack card never
 *    being rewritten — which is exactly what "I decided and nothing happened
 *    in Slack" felt like.
 *
 * 3. **A rehearsal's prepared work is a specimen, not a proposal.** A rehearsal
 *    holds outward calls at a preview and files each one so the rehearsal
 *    screen can read them back. Each of those was landing in the live approval
 *    queue with a working Approve button on it, and approving one would have
 *    re-invoked the tool for real against the company being rehearsed against.
 *
 * The signature is computed here with the app's own secret, so this drives the
 * real router over real HTTP with a payload Slack would have sent — no network,
 * no key, no Slack.
 *
 * Database only:
 *   npx tsx checks/slackEscalations.ts
 */
import crypto from "node:crypto";
import express from "express";
import { prisma } from "../src/lib/prisma.js";
import { SETTING, clearSettingsCache, deleteSetting, setSetting } from "../src/lib/settings.js";
import { slackInbound } from "../src/lib/slack.js";
import { slackRouter } from "../src/routes/slack.js";
import { TASK_ACTIONS, postTaskCard } from "../src/services/agents/escalationCards.js";
import { blockedTasks } from "../src/services/agents/escalations.js";
import { countPending, listRequests } from "../src/services/approvals.js";
import { approve } from "../src/services/approvals.js";
import { recordCreated, transition } from "../src/services/agents/state.js";
import { step } from "../src/services/agents/runner.js";

const AGENT_KEY = "tmp.slackescalation";
const SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
const SLACK_USER = "U0HARNESS1";
const PORT = 4599;

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
  const ids = tasks.map((task) => task.id);
  if (ids.length > 0) {
    await prisma.actionRequest.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.actionRequest.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
  // Deleted rather than blanked. A harness that tidies up by writing "" leaves
  // a row behind, and the next run reading with `??` gets an empty secret
  // instead of none — which is a different code path from the one it meant.
  await deleteSetting(SETTING.SLACK_SIGNING_SECRET);
  await deleteSetting(SETTING.SLACK_WEBHOOK_URL);
  await deleteSetting(SETTING.SLACK_APPROVERS);
  await deleteSetting(SETTING.SLACK_INBOUND_OK_AT);
  await deleteSetting(SETTING.SLACK_INBOUND_OK_KIND);
  await deleteSetting(SETTING.SLACK_INBOUND_REFUSED_AT);
  await deleteSetting(SETTING.SLACK_INBOUND_REFUSED_REASON);
  clearSettingsCache();
}

/** A request signed exactly as Slack signs one. */
function signed(body: string, secret = SIGNING_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": `v0=${crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`,
  };
}

function actionBody(actionId: string, value: string, userId = SLACK_USER) {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: userId, name: "harness" },
      actions: [{ action_id: actionId, value }],
    }),
  }).toString();
}

/** The router acknowledges in three seconds and works afterwards. */
async function settles(predicate: () => Promise<boolean>, ms = 4000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function main() {
  await reset();
  await setSetting(SETTING.SLACK_SIGNING_SECRET, SIGNING_SECRET, { secret: true });

  await prisma.agent.create({
    data: {
      key: AGENT_KEY,
      name: "Escalation Harness",
      title: "Harness",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      mission: "Exists for one test run.",
      toolkit: ["email.send"],
    },
  });

  const app = express();
  // Mounted exactly as index.ts mounts it — above any JSON parser, because the
  // signature covers the bytes Slack sent and a parsed body is not those bytes.
  // A harness that parses first makes every signature fail with a message that
  // reads like a wrong secret.
  app.use("/api/slack", express.raw({ type: "*/*", limit: "128kb" }), slackRouter);
  // A Slack incoming webhook, played locally. This is what makes the *outbound*
  // half testable with no network and no credential: `sendSlackBlocks` posts to
  // whatever URL is configured, and the webhook transport is the one that
  // reports back neither a channel nor a message id — the case a card's
  // bookkeeping is easiest to get wrong on.
  const posted: { text: string; blocks: unknown[] }[] = [];
  app.post("/hook", express.json(), (req, res) => {
    posted.push(req.body as { text: string; blocks: unknown[] });
    res.status(200).send("ok");
  });
  const server = app.listen(PORT, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  await setSetting(SETTING.SLACK_WEBHOOK_URL, `http://127.0.0.1:${PORT}/hook`, { secret: true });

  const postTo = (path: string, body: string, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${PORT}/api/slack/${path}`, { method: "POST", headers, body });

  // A second task holds the agent, so answering requeues instead of starting a
  // run — which is the branch that must not reach a model in a check, and is
  // also the branch whose wording used to claim the work had already started.
  const busy = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Already working", brief: "Occupies the agent.", origin: "OWNER", status: "RUNNING" },
  });
  await recordCreated(busy.id, busy.traceId, "QUEUED", { reason: "Harness.", actor: "check" });

  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Price the retainer", brief: "Quote the monthly support plan.", origin: "OWNER" },
  });
  await recordCreated(task.id, task.traceId, task.status, { reason: "Harness.", actor: "check" });
  await transition(task.id, { to: "RUNNING", reason: "Claimed.", actor: "check" });
  await step(task.id, "BLOCKED", "Should this be quoted in cedis or dollars?", { data: { options: ["Cedis", "Dollars"] } });
  await transition(task.id, {
    to: "BLOCKED",
    reason: "Stopped and asked.",
    actor: "check",
    data: { blockedReason: "Should this be quoted in cedis or dollars?", finishedAt: new Date() },
  });

  console.log("\nThe question reaches the channel");
  const cardPosted = await postTaskCard(task.id);
  check("a task that stopped and asked posts a card", cardPosted);
  const card = posted.at(-1);
  check("the card carries the question", (card?.text ?? "").includes("cedis or dollars"), card?.text);
  const buttons = JSON.stringify(card?.blocks ?? []);
  check("with the agent's own choices on it as buttons", buttons.includes("Cedis") && buttons.includes("Dollars"));
  check("and a way to type something else", buttons.includes(TASK_ACTIONS.answer));
  const marked = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { slackChannel: true } });
  check(
    "a webhook post is still recorded as posted, though it reports no channel and no message id",
    marked?.slackChannel === "webhook",
    String(marked?.slackChannel),
  );

  console.log("\nA rehearsal asks nobody");
  const quiet = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Rehearsed question", brief: "A rehearsal.", origin: "OWNER", rehearsal: true, status: "BLOCKED", blockedReason: "Which one?" },
  });
  await recordCreated(quiet.id, quiet.traceId, "QUEUED", { reason: "Harness.", actor: "check" });
  const before = posted.length;
  check("a rehearsal's question posts nothing", (await postTaskCard(quiet.id)) === false);
  check("and puts nothing in the channel", posted.length === before);
  await prisma.agentTask.delete({ where: { id: quiet.id } });

  console.log("\nThe question, as a person sees it");
  const waiting = await blockedTasks(20);
  const mine = waiting.find((row) => row.id === task.id);
  check("a stopped task is listed as waiting on a person", Boolean(mine), `${waiting.length} waiting`);
  check("the choices the agent offered come back with it", mine?.options.join("|") === "Cedis|Dollars", mine?.options.join("|"));

  console.log("\nAn inbound request that is not signed");
  const unsigned = await postTo("actions", actionBody(TASK_ACTIONS.option, `${task.id}::1`), {
    "content-type": "application/x-www-form-urlencoded",
  });
  check("is refused", unsigned.status === 401, `got ${unsigned.status}`);
  const afterRefusal = await slackInbound();
  check("and is written down, so the Settings screen can say why", Boolean(afterRefusal.lastRefusedReason), String(afterRefusal.lastRefusedReason));
  const untouched = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { status: true } });
  check("and changes nothing", untouched?.status === "BLOCKED", String(untouched?.status));

  console.log("\nA request signed with the wrong secret");
  const wrongBody = actionBody(TASK_ACTIONS.option, `${task.id}::1`);
  const wrong = await postTo("actions", wrongBody, signed(wrongBody, "ffffffffffffffffffffffffffffffff"));
  check("is refused", wrong.status === 401, `got ${wrong.status}`);
  const stillBlocked = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { status: true } });
  check("and changes nothing", stillBlocked?.status === "BLOCKED", String(stillBlocked?.status));

  console.log("\nSomebody who is not on the approver list");
  await setSetting(SETTING.SLACK_APPROVERS, "USOMEBODYELSE");
  const strangerBody = actionBody(TASK_ACTIONS.option, `${task.id}::1`, "UNOTALLOWED");
  const stranger = await postTo("actions", strangerBody, signed(strangerBody));
  check("is acknowledged, because Slack retries anything it does not hear from", stranger.status === 200, `got ${stranger.status}`);
  // Given a moment: the refusal happens behind the acknowledgement, so a task
  // that moves late would pass a check made immediately.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const notMoved = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { status: true } });
  check("but decides nothing", notMoved?.status === "BLOCKED", String(notMoved?.status));
  await deleteSetting(SETTING.SLACK_APPROVERS);

  console.log("\nThe Owner taps one of the agent's own choices");
  const body = actionBody(TASK_ACTIONS.option, `${task.id}::1`);
  const answered = await postTo("actions", body, signed(body));
  check("Slack is answered inside its three seconds", answered.status === 200, `got ${answered.status}`);
  const moved = await settles(async () => {
    const row = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { status: true } });
    return row?.status === "QUEUED";
  });
  check("the task goes back in the queue", moved);

  const resumed = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { brief: true, blockedReason: true } });
  check("the answer is on the brief, where the record keeps it", resumed?.brief.includes("Dollars") ?? false, resumed?.brief.slice(-80));
  check("and the question is cleared", resumed?.blockedReason === null, String(resumed?.blockedReason));

  const history = await prisma.agentTaskTransition.findMany({ where: { taskId: task.id }, orderBy: { at: "asc" } });
  check("the history says Slack decided it", history.at(-1)?.actor === "slack", String(history.at(-1)?.actor));

  const proof = await slackInbound();
  check("a verified request is recorded, which is the only proof the wiring works", Boolean(proof.lastOkAt), String(proof.lastOkAt));

  // The half that "I decided and nothing happened in Slack" was actually about.
  const settled = posted.at(-1);
  check("the channel is told the question has been answered", (settled?.text ?? "").startsWith("Answered"), settled?.text?.slice(0, 60));
  check(
    "and the answered card has no live buttons left on it",
    !JSON.stringify(settled?.blocks ?? []).includes(TASK_ACTIONS.option),
  );
  const cleared = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { slackChannel: true, slackTs: true } });
  check(
    "the card reference is cleared, so stopping again asks a new question rather than editing the old answer",
    cleared?.slackChannel === null && cleared?.slackTs === null,
    `${cleared?.slackChannel} / ${cleared?.slackTs}`,
  );

  console.log("\nAnswering the same question twice");
  const again = await postTo("actions", body, signed(body));
  check("is acknowledged rather than erroring", again.status === 200, `got ${again.status}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const notReblocked = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { status: true } });
  check("and leaves the task where it is", notReblocked?.status === "QUEUED", String(notReblocked?.status));

  console.log("\nA run that failed");
  const broke = await prisma.agentTask.create({
    data: {
      agentKey: AGENT_KEY,
      title: "Audit their site",
      brief: "Look at the homepage.",
      origin: "OWNER",
      status: "FAILED",
      error: "The model provider refused the key.",
      finishedAt: new Date(),
    },
  });
  await recordCreated(broke.id, broke.traceId, "QUEUED", { reason: "Harness.", actor: "check" });
  check("posts a card", await postTaskCard(broke.id));
  const failureCard = posted.at(-1);
  check("that says what went wrong", (failureCard?.text ?? "").includes("refused the key"), failureCard?.text?.slice(0, 80));
  check("with a way to run it again", JSON.stringify(failureCard?.blocks ?? []).includes(TASK_ACTIONS.retry));

  const retryBody = actionBody(TASK_ACTIONS.retry, broke.id);
  const retried = await postTo("actions", retryBody, signed(retryBody));
  check("and the button is acknowledged", retried.status === 200, `got ${retried.status}`);
  const requeued = await settles(async () => {
    const row = await prisma.agentTask.findUnique({ where: { id: broke.id }, select: { status: true } });
    return row?.status === "QUEUED";
  });
  check("the task goes back in the queue", requeued);
  const cleanedError = await prisma.agentTask.findUnique({ where: { id: broke.id }, select: { error: true } });
  check("with the old error cleared rather than carried into the new run", cleanedError?.error === null, String(cleanedError?.error));

  console.log("\nA run of failures at once");
  // Five more, all inside the window, standing in for a vendor going down.
  const storm = [];
  for (let index = 0; index < 5; index += 1) {
    const row = await prisma.agentTask.create({
      data: {
        agentKey: AGENT_KEY,
        title: `Storm ${index}`,
        brief: "Harness.",
        origin: "OWNER",
        status: "FAILED",
        error: "The model provider refused the key.",
        finishedAt: new Date(),
      },
    });
    await recordCreated(row.id, row.traceId, "QUEUED", { reason: "Harness.", actor: "check" });
    storm.push(row.id);
  }
  const beforeStorm = posted.length;
  check("the card for the next one is held rather than posted", (await postTaskCard(storm[0])) === false);
  check("and nothing more reaches the channel", posted.length === beforeStorm);

  console.log("\nAnd a question raised during that run of failures");
  const urgent = await prisma.agentTask.create({
    data: {
      agentKey: AGENT_KEY,
      title: "Quote this",
      brief: "Harness.",
      origin: "OWNER",
      status: "BLOCKED",
      blockedReason: "Do we discount for a two-year commitment?",
      finishedAt: new Date(),
    },
  });
  await recordCreated(urgent.id, urgent.traceId, "QUEUED", { reason: "Harness.", actor: "check" });
  check("is still posted — a failure cap must never silence an escalation", await postTaskCard(urgent.id));

  console.log("\nA rehearsal's prepared work");
  const rehearsed = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Rehearsal", brief: "A rehearsal.", origin: "OWNER", rehearsal: true, status: "NEEDS_APPROVAL" },
  });
  await recordCreated(rehearsed.id, rehearsed.traceId, "QUEUED", { reason: "Harness.", actor: "check" });
  const specimen = await prisma.actionRequest.create({
    data: {
      agentKey: AGENT_KEY,
      taskId: rehearsed.id,
      tool: "email.send",
      input: { to: "nobody@example.com" } as never,
      wouldDo: "Send a first email to a company we are only rehearsing against.",
      why: "harness",
      gain: "harness",
      risk: "none",
      rehearsal: true,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  const queue = await listRequests("PENDING", 100);
  check("stays out of the approval queue", !queue.some((row) => row.id === specimen.id));
  const pendingBefore = await countPending();
  const real = await prisma.actionRequest.create({
    data: {
      agentKey: AGENT_KEY,
      taskId: null,
      tool: "email.send",
      input: { to: "nobody@example.com" } as never,
      wouldDo: "Send a real first email.",
      why: "harness",
      gain: "harness",
      risk: "none",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const pendingAfter = await countPending();
  check("is not in the pending count, while a real one is", pendingAfter === pendingBefore + 1, `${pendingBefore} -> ${pendingAfter}`);
  check("and is still readable, because the rehearsal screen reads it back", Boolean(await prisma.actionRequest.findUnique({ where: { id: specimen.id } })));

  let refused = "";
  try {
    await approve(specimen.id, { userId: null, note: "harness" });
  } catch (err) {
    refused = (err as Error).message;
  }
  check("and approving it is refused outright", refused.includes("rehearsal"), refused || "it was approved");
  const untouchedSpecimen = await prisma.actionRequest.findUnique({ where: { id: specimen.id }, select: { status: true } });
  check("leaving it PENDING rather than half-approved", untouchedSpecimen?.status === "PENDING", String(untouchedSpecimen?.status));

  await prisma.actionRequest.deleteMany({ where: { id: { in: [specimen.id, real.id] } } });

  console.log("\nThe slash command");
  const tasksCommand = new URLSearchParams({ text: "tasks", user_id: SLACK_USER, user_name: "harness" }).toString();
  const listed = await postTo("commands", tasksCommand, signed(tasksCommand));
  const listedBody = (await listed.json()) as { text?: string };
  check("answers inline", listed.status === 200, `got ${listed.status}`);
  check("lists what is still waiting", (listedBody.text ?? "").includes("two-year commitment"), listedBody.text?.slice(0, 120));
  check(
    "with the command to answer it, id filled in — the only road that works on every setup",
    (listedBody.text ?? "").includes(`/dakyworld answer ${urgent.id}`),
    listedBody.text?.slice(0, 200),
  );

  // Answering in words, which is what a webhook-only workspace has instead of
  // a dialog. The answer keeps its capitals: lowercasing the command's text to
  // match the topic would hand the agent a mangled instruction.
  const answerCommand = new URLSearchParams({
    text: `answer ${urgent.id} Yes — 10% for Two years, never more.`,
    user_id: SLACK_USER,
    user_name: "harness",
  }).toString();
  const answered2 = await postTo("commands", answerCommand, signed(answerCommand));
  const answered2Body = (await answered2.json()) as { text?: string };
  check("answering by command is accepted", (answered2Body.text ?? "").includes("Answered"), answered2Body.text?.slice(0, 80));
  const urgentAfter = await prisma.agentTask.findUnique({ where: { id: urgent.id }, select: { status: true, brief: true } });
  check("the task is requeued", urgentAfter?.status === "QUEUED", String(urgentAfter?.status));
  check(
    "and the answer reaches the brief exactly as it was typed",
    urgentAfter?.brief.includes("Yes — 10% for Two years, never more.") ?? false,
    urgentAfter?.brief.slice(-80),
  );

  await prisma.agentTask.deleteMany({ where: { id: { in: [...storm, urgent.id] } } });

  const pingCommand = new URLSearchParams({ text: "ping", user_id: SLACK_USER, user_name: "harness" }).toString();
  const ping = await postTo("commands", pingCommand, signed(pingCommand));
  const pingBody = (await ping.json()) as { text?: string };
  check("ping proves the inbound half end to end", (pingBody.text ?? "").includes("can reach Dakyworld OS"), pingBody.text?.slice(0, 80));
  check(
    "and reports the outbound half as well",
    (pingBody.text ?? "").includes("incoming webhook"),
    pingBody.text?.slice(0, 200),
  );
  check(
    "and warns that anybody in the channel can decide, because nobody is named",
    (pingBody.text ?? "").includes("Nobody is named"),
    pingBody.text?.slice(0, 300),
  );

  console.log("\nWith no signing secret at all");
  await deleteSetting(SETTING.SLACK_SIGNING_SECRET);
  clearSettingsCache();
  const orphan = await postTo("actions", body, signed(body));
  check(
    "everything inbound is refused, rather than trusted because nothing was configured",
    orphan.status === 503,
    `got ${orphan.status}`,
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
