/** HTTP regressions for agent permissions and Slack's asynchronous replies. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { prisma } from "../src/lib/prisma.js";
import { SETTING, setSetting, deleteSetting } from "../src/lib/settings.js";
import { mayDecideFromSlack, replyToInteraction, sendSlack, sendSlackBlocks, settleSlackMessage } from "../src/lib/slack.js";
import { agentsRouter } from "../src/routes/agents.js";
import { slackRouter } from "../src/routes/slack.js";
import { ANSWER_VIEW, TASK_ACTIONS } from "../src/services/agents/escalationCards.js";
import { DECLINE_VIEW } from "../src/services/approvalCards.js";
import { answerTask } from "../src/services/agents/escalations.js";

const key = "check.slackcommunications";
const secret = "offline-communications-signature";
const settings = [SETTING.SLACK_SIGNING_SECRET, SETTING.SLACK_BOT_TOKEN, SETTING.SLACK_DEFAULT_CHANNEL,
  SETTING.SLACK_WEBHOOK_URL, SETTING.SLACK_APPROVERS, SETTING.SLACK_INBOUND_OK_AT,
  SETTING.SLACK_INBOUND_OK_KIND, SETTING.SLACK_INBOUND_REFUSED_AT, SETTING.SLACK_INBOUND_REFUSED_REASON];
const previous = await prisma.appSetting.findMany({ where: { key: { in: settings } } });
const oldBase = process.env.SLACK_BASE_URL;
const replies: Array<{ text: string }> = [];
const updates: Array<{ view_id: string; view: unknown }> = [];
const posted: Array<{ channel: string; text: string }> = [];
let opened = false;
const app = express();
app.use("/api/slack", express.raw({ type: "*/*" }), slackRouter);
app.use(express.json());
app.post("/slack/views.open", async (_req, res) => {
  await new Promise((resolve) => setTimeout(resolve, 3200));
  opened = true;
  res.json({ ok: true });
});
app.post("/slack/views.update", (req, res) => { updates.push(req.body); res.json({ ok: true }); });
app.post("/slack/chat.postMessage", (req, res) => {
  posted.push(req.body);
  res.json({ ok: true, channel: "C_CANONICAL", ts: "123.456" });
});
app.post("/slack/chat.update", (_req, res) => res.json({ ok: false, error: "message_not_found" }));
app.post("/reply", (req, res) => { replies.push(req.body); res.send("ok"); });
app.post("/refuse-reply", (_req, res) => res.status(500).send("unavailable"));
app.use("/agents", (req, _res, next) => {
  req.dbUser = { id: "check-user" } as NonNullable<typeof req.dbUser>;
  req.permissions = new Set(String(req.headers["x-check-permissions"] ?? "").split(","));
  next();
}, agentsRouter);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(400).json({ error: err.message });
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.SLACK_BASE_URL = `${base}/slack`;

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(predicate(), "background Slack work completed");
}
async function signed(path: string, fields: Record<string, string>) {
  const body = new URLSearchParams(fields).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  return fetch(`${base}/api/slack/${path}`, { method: "POST", body, headers: {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`,
  } });
}
async function start(permissions: string, body: unknown) {
  return fetch(`${base}/agents/start-the-day`, { method: "POST", headers: {
    "content-type": "application/json", "x-check-permissions": permissions,
  }, body: JSON.stringify(body) });
}
try {
  assert.equal((await start("agents.view,agents.hire", {})).status, 403);
  assert.equal((await start("agents.view,agents.run", { hunts: true })).status, 403);
  // Invalid input reaches validation only if agents.run is sufficient; hiring is unrelated.
  assert.equal((await start("agents.view,agents.run", { hunts: "invalid" })).status, 400);
  console.log("  ok    Start the day requires run permission and hunts require source permission");

  await setSetting(SETTING.SLACK_SIGNING_SECRET, secret, { secret: true });
  await setSetting(SETTING.SLACK_BOT_TOKEN, "offline-token", { secret: true });
  await setSetting(SETTING.SLACK_DEFAULT_CHANNEL, "C_CHECK");
  await setSetting(SETTING.SLACK_APPROVERS, "");
  assert.equal(await mayDecideFromSlack(null), false);
  await assert.rejects(replyToInteraction(`${base}/refuse-reply`, "Test"), /could not deliver/);
  assert.equal((await sendSlack({ text: "Alert", channel: "#alerts" })).channel, "C_CANONICAL");
  assert.equal((await sendSlackBlocks({ text: "Card", blocks: [], channel: "#alerts" })).channel, "C_CANONICAL");
  await settleSlackMessage("C_CANONICAL", "123.456", { text: "Settled", blocks: [] });
  assert.equal(posted.at(-1)?.text, "Settled");
  assert.equal(posted.at(-1)?.channel, "C_CANONICAL");
  console.log("  ok    Cards retain Slack's channel ID and a failed edit posts the outcome");
  console.log("  ok    Missing Slack identity is refused and failed replies are observable");

  const opening = await signed("actions", { payload: JSON.stringify({ type: "block_actions",
    user: { id: "U_CHECK" }, trigger_id: "trigger", response_url: `${base}/reply`,
    actions: [{ action_id: TASK_ACTIONS.answer, value: "task" }],
  }) });
  assert.equal(opening.status, 200);
  assert.equal(opened, false, "ACK does not wait for slow views.open");
  await until(() => opened);
  console.log("  ok    Slow modal API does not delay the interaction acknowledgment");

  await prisma.agent.create({ data: { key, name: "Communications check", title: "Check", tier: "SUB_AGENT",
    department: "TECHNOLOGY", mission: "Offline check", status: "ACTIVE" } });
  await prisma.agentTask.create({ data: { agentKey: key, title: "Busy", brief: "Occupies the agent", status: "RUNNING" } });
  const task = await prisma.agentTask.create({ data: { agentKey: key, title: "Question", brief: "Original", status: "BLOCKED" } });
  for (let i = 0; i < 6; i++) await prisma.agentTask.create({ data: { agentKey: key, title: `Question ${i}`, brief: "Original", status: "BLOCKED" } });
  const total = await prisma.agentTask.count({ where: { status: "BLOCKED", rehearsal: false } });
  const command = await signed("commands", { text: "status", user_id: "U_CHECK", response_url: `${base}/reply` });
  assert.equal(command.status, 200);
  assert.equal(await command.text(), "", "commands acknowledge before sending results");
  await until(() => replies.some((reply) => reply.text.includes(`*${total}* task(s) stopped`)));
  console.log("  ok    Status reports the whole blocked queue, not only the five examples");

  const submit = (viewId: string, taskId: string, callback: { callbackId: string; blockId: string; actionId: string } = ANSWER_VIEW) => signed("actions", {
    payload: JSON.stringify({ type: "view_submission", user: { id: "U_CHECK" }, view: {
      id: viewId, callback_id: callback.callbackId, private_metadata: taskId,
      state: { values: { [callback.blockId]: { [callback.actionId]: { value: "Use GHS, not USD." } } } },
    } }),
  });
  const submitted = await submit("V_ANSWER", task.id);
  assert.equal((await submitted.json()).response_action, "update");
  await until(() => updates.some((update) => update.view_id === "V_ANSWER"));
  assert.match(JSON.stringify(updates.find((update) => update.view_id === "V_ANSWER")), /queued/);
  const answered = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(answered.status, "QUEUED");
  assert.match(answered.brief, /Use GHS, not USD\./);
  await assert.rejects(answerTask(task.id, "Stale answer", { slackUserId: "U_CHECK" }), /no longer waiting/);
  assert.equal((await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } })).brief, answered.brief);
  const failed = await prisma.agentTask.create({ data: { agentKey: key, title: "Failed", brief: "Original", status: "FAILED", error: "Old error" } });
  assert.equal((await answerTask(failed.id, "Try the corrected input", { slackUserId: "U_CHECK" })).queued, true);
  const retry = await prisma.agentTask.findUniqueOrThrow({ where: { id: failed.id } });
  assert.equal(retry.status, "QUEUED");
  assert.equal(retry.error, null);
  console.log("  ok    Modal answers are saved and stale answers cannot change queued work");

  await submit("V_MISSING", "missing-task");
  await until(() => updates.some((update) => update.view_id === "V_MISSING"));
  assert.match(JSON.stringify(updates.find((update) => update.view_id === "V_MISSING")), /No such task/);
  await submit("V_DECLINE", "missing-approval", DECLINE_VIEW);
  await until(() => updates.some((update) => update.view_id === "V_DECLINE"));
  assert.match(JSON.stringify(updates.find((update) => update.view_id === "V_DECLINE")), /No such/i);
  console.log("  ok    Refused modal answers and declines show the actual error");
} finally {
  await prisma.agentTask.deleteMany({ where: { agentKey: key } });
  await prisma.agent.deleteMany({ where: { key } });
  for (const setting of settings) await deleteSetting(setting);
  for (const row of previous) await prisma.appSetting.create({ data: row });
  if (oldBase === undefined) delete process.env.SLACK_BASE_URL;
  else process.env.SLACK_BASE_URL = oldBase;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}
