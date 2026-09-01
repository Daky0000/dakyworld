/**
 * When an agent prepares something that leaves the building, can the founder
 * approve it from Slack — and does approving it actually do the thing?
 *
 * This is the whole promise of commissioning the workforce. Every agent runs at
 * an autonomy below `EXECUTE_LEVEL`, so nothing outward and nothing that spends
 * happens on its own; each of those calls is prepared, filed as an
 * `ActionRequest`, and posted to Slack with an Approve button. If that button
 * does not carry the work out, the workforce is not gated — it is stopped, and
 * the difference is invisible from the Agents screen.
 *
 * `checks/slackEscalations.ts` already covers the *question* half — an agent
 * that stops and asks. This is the other half, and it was the one with no
 * committed check at all: the approval card, its buttons, and what pressing
 * one does.
 *
 * The tool under test is `sequence.enrol`, chosen because it is genuinely
 * outward — it starts a run of letters at a prospect — and because **its
 * effect can be seen**: it writes an `EmailEnrollment`, so "the work really
 * happened" is a row that exists rather than a status column this check wrote
 * itself. A tool whose execution could not be observed would let a broken
 * approve path pass by writing EXECUTED over work that never ran, which is the
 * exact shape of the defect this file exists to catch. It is also the right
 * example on the merits: a sequence starting against a real prospect without
 * anybody saying so is the thing the gate exists to prevent.
 *
 * The negatives are half the file, and each is a way the queue could betray
 * somebody: an unsigned click must decide nothing, somebody who is not an
 * approver must decide nothing, Slack's own retry must not do the work twice,
 * a declined action must not run, and a rehearsal's specimen must never be
 * carried out against a real company.
 *
 * The signature is computed here with the app's own secret, so this drives the
 * real router over real HTTP with the payload Slack would have sent — no
 * network, no key, no Slack.
 *
 * Database only:
 *   npx tsx checks/slackApprovals.ts
 */
import crypto from "node:crypto";
import express from "express";
import { prisma } from "../src/lib/prisma.js";
import { SETTING, clearSettingsCache, deleteSetting, setSetting } from "../src/lib/settings.js";
import { slackRouter } from "../src/routes/slack.js";
import { APPROVAL_ACTIONS } from "../src/services/approvalCards.js";
import { countPending, listRequests } from "../src/services/approvals.js";
import { invokeTool } from "../src/services/tools/invoke.js";
import { COMMISSIONED_AUTONOMY } from "../src/services/agentRegistry.js";
import { recordCreated } from "../src/services/agents/state.js";

const AGENT_KEY = "tmp.slackapproval";
const SIGNING_SECRET = "fedcba9876543210fedcba9876543210";
const SLACK_USER = "U0APPROVER1";
const STRANGER = "U0STRANGER9";
const PORT = 4601;

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
  await prisma.emailEnrollment.deleteMany({ where: { sequence: { name: "Approval harness sequence" } } });
  await prisma.emailSequenceStep.deleteMany({ where: { sequence: { name: "Approval harness sequence" } } });
  await prisma.emailSequence.deleteMany({ where: { name: "Approval harness sequence" } });
  await prisma.lead.deleteMany({ where: { contactEmail: { in: ["ama@harness.test", "kofi@harness.test"] } } });
  await prisma.actionRequest.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.toolCall.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
  // Deleted rather than blanked, for the reason the escalation harness gives:
  // a row holding "" is a different code path from no row at all.
  for (const key of [SETTING.SLACK_SIGNING_SECRET, SETTING.SLACK_WEBHOOK_URL, SETTING.SLACK_APPROVERS, SETTING.SMTP_HOST]) {
    await deleteSetting(key);
  }
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

  // The card an agent lands on when the workforce is commissioned. Asserted
  // through the real gate rather than set up by hand, so this file fails if
  // that level ever stops holding an outward call.
  await prisma.agent.create({
    data: {
      key: AGENT_KEY,
      name: "Approval Harness",
      title: "Harness",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      autonomyLevel: COMMISSIONED_AUTONOMY,
      dryRun: false,
      mission: "Exists for one test run.",
      toolkit: ["sequence.enrol"],
    },
  });

  const app = express();
  // Mounted exactly as index.ts mounts it — above any JSON parser, because the
  // signature covers the bytes Slack sent and a parsed body is not those bytes.
  app.use("/api/slack", express.raw({ type: "*/*", limit: "128kb" }), slackRouter);

  const posted: { text: string; blocks: unknown[] }[] = [];
  app.post("/hook", express.json(), (req, res) => {
    posted.push(req.body as { text: string; blocks: unknown[] });
    res.status(200).send("ok");
  });

  // What "the work really happened" means here. Nothing else in this file
  // writes to it, so a request in this array is the tool having run.
  const server = app.listen(PORT, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  await setSetting(SETTING.SLACK_WEBHOOK_URL, `http://127.0.0.1:${PORT}/hook`, { secret: true });

  const postTo = (path: string, body: string, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${PORT}/api/slack/${path}`, { method: "POST", headers, body });

  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Follow up the Harness Ltd enquiry", brief: "They asked to hear more. Start the follow-up run.", origin: "OWNER" },
  });
  await recordCreated(task.id, task.traceId, task.status, { reason: "Harness.", actor: "check" });

  // What the agent is preparing: putting a real prospect into a real run of
  // letters. Everything it needs is made here rather than assumed, so the tool
  // genuinely succeeds when approved and genuinely does nothing when not.
  await setSetting(SETTING.SMTP_HOST, "smtp.harness.test");
  await setSetting(SETTING.SMTP_PORT, "587");
  await setSetting(SETTING.SMTP_USER, "harness@dakyworld.test");
  await setSetting(SETTING.SMTP_PASSWORD, "harness", { secret: true });
  // `readMailerConfig` needs a from-address as well as the four SMTP fields,
  // and returns null without one — which reaches the gate as "Email isn't
  // connected" and refuses the tool before the autonomy level is ever read.
  await setSetting(SETTING.MAIL_FROM_EMAIL, "harness@dakyworld.test");
  await setSetting(SETTING.MAIL_TRANSPORT, "SMTP");
  clearSettingsCache();

  const sequence = await prisma.emailSequence.create({
    data: { name: "Approval harness sequence", steps: { create: [{ position: 0, delayDays: 0, subject: "Hello", bodyHtml: "<p>A first letter.</p>" }] } },
  });
  const lead = await prisma.lead.create({
    data: { contactName: "Ama Boateng", companyName: "Harness Ltd", contactEmail: "ama@harness.test", source: "REFERRAL" },
  });
  const secondLead = await prisma.lead.create({
    data: { contactName: "Kofi Mensah", companyName: "Harness Two", contactEmail: "kofi@harness.test", source: "REFERRAL" },
  });

  /** How many letters this check has actually started. Nothing else writes these. */
  const enrolments = (leadId: string) => prisma.emailEnrollment.count({ where: { leadId, sequenceId: sequence.id } });

  const dispatch = (leadId: string) =>
    invokeTool(
      "sequence.enrol",
      { sequenceId: sequence.id, leadId },
      {
        agentKey: AGENT_KEY,
        userId: null,
        dryRun: false,
        taskId: task.id,
        rationale: { why: "They asked to hear more and nobody has followed up.", gain: "The follow-up happens on its own schedule.", risk: "Writing to somebody who has already replied." },
      },
    );

  // --- 1. An outward call, prepared rather than done --------------------------
  console.log("\nAn agent prepares something that leaves the building");

  const prepared = await dispatch(lead.id);
  check("the call is held rather than carried out", prepared.dryRun === true, JSON.stringify(prepared.error ?? prepared.refusedReason ?? ""));
  check("nobody has been enrolled in anything", (await enrolments(lead.id)) === 0);
  check("it says why it was held, naming the autonomy level", (prepared.refusedReason ?? "").includes("autonomy"), prepared.refusedReason);
  check("and it filed something a person can act on", Boolean(prepared.actionRequestId));

  const requestId = prepared.actionRequestId!;
  const filed = await prisma.actionRequest.findUniqueOrThrow({ where: { id: requestId } });
  check("the agent's case for it is on the record", filed.why.includes("asked to hear more") && filed.gain.includes("own schedule"), `${filed.why} / ${filed.gain}`);
  check("it is in the queue a person reads", (await listRequests("PENDING")).some((row) => row.id === requestId));
  check("and in the count that drives the badge", (await countPending()) > 0);

  // --- 2. The card ------------------------------------------------------------
  console.log("\nThe card that reaches Slack");

  // Not posted by hand. `fileActionRequest` fires the card itself, without
  // waiting, the moment the action is filed — so the thing worth asserting is
  // that it arrives on its own, which is the path an agent mid-loop actually
  // takes. Posting one here would test the builder and skip the wiring.
  const arrived = await settles(async () => posted.length > 0);
  check("a card reaches the channel on its own, with nobody asking for one", arrived, `${posted.length} posted`);
  const card = posted[0];
  const cardJson = JSON.stringify(card?.blocks ?? []);
  check("it says what would happen, naming who it is about", `${card?.text ?? ""}${cardJson}`.includes("Ama Boateng"), card?.text?.slice(0, 110));
  check("it carries the agent's reason", cardJson.includes("asked to hear more"), cardJson.slice(0, 160));
  check("with an Approve button on it", cardJson.includes(APPROVAL_ACTIONS.approve));
  check("and a way to decline", cardJson.includes(APPROVAL_ACTIONS.decline));
  check("and a way to decline with a reason", cardJson.includes(APPROVAL_ACTIONS.declineWithReason));

  // --- 3. The refusals, before the one that works -----------------------------
  console.log("\nWho may press it");

  const unsignedBody = actionBody(APPROVAL_ACTIONS.approve, requestId);
  const unsigned = await postTo("actions", unsignedBody, { "content-type": "application/x-www-form-urlencoded" });
  check("an unsigned click is refused", unsigned.status === 401, `got ${unsigned.status}`);
  check("and carries nothing out", (await enrolments(lead.id)) === 0);

  const wrongSecret = await postTo("actions", unsignedBody, signed(unsignedBody, "0000000000000000000000000000dead"));
  check("a click signed with the wrong secret is refused", wrongSecret.status === 401, `got ${wrongSecret.status}`);
  check("and carries nothing out", (await enrolments(lead.id)) === 0);

  // A signature proves it came from Slack, not that the clicker may decide.
  await setSetting(SETTING.SLACK_APPROVERS, SLACK_USER);
  clearSettingsCache();
  const strangerBody = actionBody(APPROVAL_ACTIONS.approve, requestId, STRANGER);
  const stranger = await postTo("actions", strangerBody, signed(strangerBody));
  check("somebody not on the approver list is acknowledged", stranger.status === 200, `got ${stranger.status}`);
  check("but decides nothing", (await enrolments(lead.id)) === 0);
  const untouched = await prisma.actionRequest.findUnique({ where: { id: requestId } });
  check("and the action is still waiting", untouched?.status === "PENDING", String(untouched?.status));

  // --- 4. Approving it --------------------------------------------------------
  console.log("\nApproving it");

  posted.length = 0;
  const approveBody = actionBody(APPROVAL_ACTIONS.approve, requestId);
  const pressed = await postTo("actions", approveBody, signed(approveBody));
  check("Slack is answered inside its three seconds", pressed.status === 200, `got ${pressed.status}`);

  const ran = await settles(async () => (await enrolments(lead.id)) > 0);
  check("the work is actually carried out — the prospect really is enrolled", ran);
  check("exactly as prepared, against the lead the card named", (await prisma.emailEnrollment.findFirst({ where: { leadId: lead.id } }))?.sequenceId === sequence.id);
  check("it happens once, not twice", (await enrolments(lead.id)) === 1, String(await enrolments(lead.id)));

  const executed = await prisma.actionRequest.findUniqueOrThrow({ where: { id: requestId } });
  check("the request is recorded as carried out", executed.status === "EXECUTED", executed.status);
  check("with who decided it", executed.decidedBySlackUser === SLACK_USER, String(executed.decidedBySlackUser));
  check("and it leaves the pending queue", !(await listRequests("PENDING")).some((row) => row.id === requestId));

  // The half that used to rot silently: deciding somewhere must show everywhere.
  const settled = await settles(async () => posted.some((entry) => (entry.text ?? "").startsWith("Done")));
  check("the channel is told, rather than leaving a live Approve button up", settled, posted.map((p) => p.text?.slice(0, 40)).join(" | "));
  check("and the settled card has no Approve button left on it", !JSON.stringify(posted.at(-1)?.blocks ?? []).includes(APPROVAL_ACTIONS.approve));

  // --- 5. Slack's own retry ---------------------------------------------------
  console.log("\nSlack re-delivering the same click");

  const again = await postTo("actions", approveBody, signed(approveBody));
  check("is acknowledged rather than erroring", again.status === 200, `got ${again.status}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  check("and does not do the work a second time", (await enrolments(lead.id)) === 1, String(await enrolments(lead.id)));

  // --- 6. Declining -----------------------------------------------------------
  console.log("\nDeclining");

  const second = await dispatch(secondLead.id);
  const declineId = second.actionRequestId!;
  await settles(async () => posted.some((entry) => JSON.stringify(entry.blocks ?? []).includes(declineId)));
  const before = await enrolments(secondLead.id);
  const declineBody = actionBody(APPROVAL_ACTIONS.decline, declineId);
  const declined = await postTo("actions", declineBody, signed(declineBody));
  check("the click is accepted", declined.status === 200, `got ${declined.status}`);
  const settledDecline = await settles(async () => (await prisma.actionRequest.findUnique({ where: { id: declineId } }))?.status === "DECLINED");
  check("the action is recorded as declined", settledDecline);
  check("and nothing was carried out — nobody was enrolled", (await enrolments(secondLead.id)) === before);
  const declinedRow = await prisma.actionRequest.findUniqueOrThrow({ where: { id: declineId } });
  check("with who declined it", declinedRow.decidedBySlackUser === SLACK_USER, String(declinedRow.decidedBySlackUser));

  // --- 7. A rehearsal's specimen ----------------------------------------------
  console.log("\nA rehearsal's prepared work");

  const specimen = await invokeTool(
    "sequence.enrol",
    { sequenceId: sequence.id, leadId: secondLead.id },
    { agentKey: AGENT_KEY, userId: null, dryRun: true, rehearsal: true, taskId: task.id, rationale: { why: "A rehearsal.", gain: "None.", risk: "None." } },
  );
  const specimenId = specimen.actionRequestId ?? "";
  check("is still filed, because the rehearsal screen reads it back", Boolean(specimenId), `dryRun ${specimen.dryRun}, ${specimen.refusedReason ?? specimen.error ?? "no reason given"}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  check("posts no card at all", !posted.some((p) => JSON.stringify(p.blocks ?? []).includes(specimenId)));
  check("and stays out of the queue a person reads", !(await listRequests("PENDING")).some((row) => row.id === specimenId));

  const beforeSpecimen = await enrolments(secondLead.id);
  const specimenBody = actionBody(APPROVAL_ACTIONS.approve, specimenId);
  const pressedSpecimen = await postTo("actions", specimenBody, signed(specimenBody));
  check("approving one is acknowledged", pressedSpecimen.status === 200, `got ${pressedSpecimen.status}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  check("but refused outright — nobody is enrolled against a rehearsal", (await enrolments(secondLead.id)) === beforeSpecimen);
  const stillPending = specimenId ? await prisma.actionRequest.findUnique({ where: { id: specimenId } }) : null;
  check("leaving it PENDING rather than half-approved", stillPending?.status === "PENDING", String(stillPending?.status));

  server.close();
  await reset();
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
