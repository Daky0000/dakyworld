/**
 * A commissioned agent works a real task. What actually happens?
 *
 * Every other file here asserts one mechanism. This is the sentence the founder
 * cares about, end to end, with nothing stubbed but the model: an agent that is
 * switched on picks up work, does the internal part for real, stops short of
 * anything that leaves the building, files that for a decision, posts it to
 * Slack, and finishes in a state that says a person is owed something.
 *
 * It matters because those are five separate mechanisms — the claim, the gate,
 * the approval queue, the card and the finishing state — and each is green in
 * isolation while the run they make up could still be wrong. `checks/spine.ts`
 * makes exactly this argument about the run context and `spineEndToEnd.ts` is
 * its answer; this is the same argument about commissioning.
 *
 * The model is a local stub over the Anthropic wire — the same shape
 * `spineEndToEnd.ts` uses — so the loop is the real loop, the tools are the
 * real tools and the gate is the real gate, with no key and no network. Slack
 * is a local express playing an incoming webhook, so the card is really built
 * and really posted.
 *
 * The two assertions worth stating plainly:
 *
 *   - **The internal work really happened.** A commissioned agent that could
 *     only prepare things would be no better than the draft it replaced, and
 *     the symptom is identical from every screen.
 *   - **The outward work really did not.** A run that sent the letter would
 *     make the whole approval queue decoration.
 *
 * A database and nothing else. No API key, no network.
 *   npx tsx checks/commissionedRun.ts
 */
import http from "node:http";
import express from "express";
import { prisma } from "../src/lib/prisma.js";
import { SETTING, clearSettingsCache, deleteSetting, setSetting } from "../src/lib/settings.js";
import { runTask } from "../src/services/agents/runner.js";
import { COMMISSIONED_AUTONOMY } from "../src/services/agentRegistry.js";
import { listRequests } from "../src/services/approvals.js";

const AGENT_KEY = "tmp.commissionedrun";
const MODEL_PORT = 4602;
const SLACK_PORT = 4603;

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

/**
 * Reads a record, then tries to write to somebody outside the company, then
 * finishes. One turn of each, which is the shape of most real work here.
 */
/** The drafted letter the agent will try to send. Filled in before the run. */
let DRAFT: { id: string } = { id: "" };

function modelStub() {
  let turn = 0;
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      const reply = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && url.includes("/v1/models/")) return reply(200, { id: url.split("/").pop(), display_name: "Stub" });
      if (!url.includes("/v1/messages")) return reply(404, { error: { message: `no stub route for ${url}` } });

      turn += 1;
      const say = (content: unknown[], stop: string) =>
        reply(200, { id: `msg_${turn}`, type: "message", role: "assistant", model: "claude-opus-5", content, stop_reason: stop, usage: { input_tokens: 500, output_tokens: 100 } });

      // Catalogue keys carry dots; the tool name is the key with `__` in their place.
      if (turn === 1) return say([{ type: "tool_use", id: "call_1", name: "lead__read", input: { limit: 5 } }], "tool_use");
      if (turn === 2) {
        return say(
          [
            {
              type: "tool_use",
              id: "call_2",
              name: "email__send",
              input: {
                // A real drafted message, made below. `email.send` sends one
                // that already exists rather than composing on the spot.
                messageId: DRAFT.id,
                why: "They asked to hear from us and nobody has written.",
                gain: "A reply from a prospect who is already warm.",
                risk: "They may have replied to somebody else already.",
              },
            },
          ],
          "tool_use",
        );
      }
      return say([{ type: "text", text: "I read the leads and prepared one letter. It is waiting for you to approve." }], "end_turn");
    });
  });
}

async function reset() {
  const tasks = await prisma.agentTask.findMany({ where: { agentKey: AGENT_KEY }, select: { id: true } });
  const ids = tasks.map((task) => task.id);
  if (ids.length > 0) {
    await prisma.actionRequest.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskCheckpoint.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.llmCall.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.toolCall.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.actionRequest.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.llmCall.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.toolCall.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.emailMessage.deleteMany({ where: { toEmail: "someone@example.test" } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
  for (const key of [SETTING.SLACK_WEBHOOK_URL, SETTING.SMTP_HOST, SETTING.SMTP_USER, SETTING.SMTP_PASSWORD, SETTING.MAIL_FROM_EMAIL, SETTING.MAIL_TRANSPORT]) {
    await deleteSetting(key);
  }
  clearSettingsCache();
}

async function main() {
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${MODEL_PORT}`;
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "stub";
  const model = modelStub();
  await new Promise<void>((resolve) => model.listen(MODEL_PORT, "127.0.0.1", resolve));

  await reset();

  // Email has to look connected or the gate refuses `email.send` on readiness
  // before the autonomy level is ever read — which would pass this file for
  // entirely the wrong reason.
  await setSetting(SETTING.SMTP_HOST, "smtp.harness.test");
  await setSetting(SETTING.SMTP_USER, "harness@dakyworld.test");
  await setSetting(SETTING.SMTP_PASSWORD, "harness", { secret: true });
  await setSetting(SETTING.MAIL_FROM_EMAIL, "harness@dakyworld.test");
  await setSetting(SETTING.MAIL_TRANSPORT, "SMTP");

  const slack = express();
  const posted: { text: string; blocks: unknown[] }[] = [];
  slack.post("/hook", express.json(), (req, res) => {
    posted.push(req.body as { text: string; blocks: unknown[] });
    res.status(200).send("ok");
  });
  const slackServer = slack.listen(SLACK_PORT, "127.0.0.1");
  await new Promise((resolve) => slackServer.once("listening", resolve));
  await setSetting(SETTING.SLACK_WEBHOOK_URL, `http://127.0.0.1:${SLACK_PORT}/hook`, { secret: true });
  clearSettingsCache();

  // Exactly the card `commissionWorkforce` puts an agent on. Not a card chosen
  // to make this pass — the constant is imported, so if commissioning ever
  // moves to a level that lets a letter out, this file fails.
  await prisma.agent.create({
    data: {
      key: AGENT_KEY,
      name: "Commissioned Harness",
      title: "Harness",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      autonomyLevel: COMMISSIONED_AUTONOMY,
      dryRun: false,
      mission: "Read the leads and write to one of them.",
      toolkit: ["lead.read", "email.send"],
      prompt: {
        role: "You are a harness.",
        mission: "Read leads, then write to one.",
        scope: "Nothing else.",
        dataRules: "",
        tools: "lead.read, email.send",
        policy: "",
        process: "Read the leads. Then send one letter. Then finish.",
        escalateWhen: "Never.",
        output: "One sentence.",
        memory: "",
      },
    },
  });

  DRAFT = await prisma.emailMessage.create({
    data: {
      toEmail: "someone@example.test",
      subject: "About your website",
      bodyHtml: "<p>A short letter.</p>",
      bodyText: "A short letter.",
      status: "DRAFT",
      purpose: "COLD_OUTREACH",
    },
    select: { id: true },
  });

  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Write to a warm lead", brief: "Read the leads and write to the one who asked to hear from us.", origin: "OWNER" },
  });

  const outcome = await runTask(task.id);

  console.log("\nWhat the run did");
  const calls = await prisma.toolCall.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } });
  const read = calls.find((call) => call.tool === "lead.read");
  const send = calls.find((call) => call.tool === "email.send");

  for (const call of calls) console.log(`    ${call.tool} — ${call.dryRun ? "prepared" : "carried out"}${call.ok ? "" : ` (failed: ${call.error})`}`);
  check("the agent picked the work up and ran", calls.length >= 2, `${calls.length} tool call(s)`);
  check("the internal read really happened", read?.dryRun === false && read?.ok === true, `dryRun ${read?.dryRun}, ok ${read?.ok}`);
  check("the letter did not", send?.dryRun === true, `dryRun ${send?.dryRun}`);
  check("and it was not recorded as a refusal — it is prepared work", send?.ok === true, `ok ${send?.ok}`);

  console.log("\nWhat is waiting for a person");
  const waiting = await listRequests("PENDING");
  const mine = waiting.find((row) => row.taskId === task.id);
  check("the letter is in the approval queue", Boolean(mine), `${waiting.length} waiting`);
  check("with the agent's own case for it", (mine?.why ?? "").includes("asked to hear from us"), mine?.why);
  check("and what it would do, in words a person can decide on", (mine?.wouldDo ?? "").length > 0, mine?.wouldDo?.slice(0, 80));
  check("naming the gate that held it rather than leaving it blank", Boolean(mine?.heldBecause), String(mine?.heldBecause));

  console.log("\nWhat reached Slack");
  const untilPosted = Date.now() + 4000;
  while (posted.length === 0 && Date.now() < untilPosted) await new Promise((resolve) => setTimeout(resolve, 100));
  check("a card was posted without anybody asking for one", posted.length > 0, `${posted.length} posted`);
  const cardJson = JSON.stringify(posted[0]?.blocks ?? []);
  check("carrying an Approve button", cardJson.includes("dky_action_approve"));
  check("and the agent's reason", cardJson.includes("asked to hear from us"), cardJson.slice(0, 140));

  console.log("\nHow the task finished");
  const finished = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  check("it did not finish DONE over work that never happened", finished.status !== "DONE", finished.status);
  check("it finished asking for a decision", finished.status === "NEEDS_APPROVAL", finished.status);
  check("the outcome the runner reports agrees", outcome.status === "NEEDS_APPROVAL", outcome.status);
  check("and the summary says so rather than claiming the letter went", (outcome.summary ?? "").length > 0 && !(outcome.summary ?? "").toLowerCase().includes("sent the letter"), (outcome.summary ?? "").slice(0, 90));
  const prepared = await prisma.agentTaskStep.findFirst({ where: { taskId: task.id, kind: "PREPARED" } });
  check("the timeline records it as prepared, with the reason on the step", Boolean(prepared) && JSON.stringify(prepared?.data ?? {}).includes("heldBecause"));

  slackServer.close();
  model.close();
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
