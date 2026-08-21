/**
 * One real run through `runTask`, then the question the whole pass exists for:
 * can one id gather everything that happened?
 *
 * `spine.ts` asserts each mechanism in isolation, which is the right
 * shape for a regression check and is not evidence that the runner wires them
 * together — the run context in particular is set in exactly one place, and a
 * refactor that moves the `withRunContext` wrapper an inch too high or too low
 * would leave every isolated check green.
 *
 * It runs its own stub rather than `tmp/vendorStub.ts`, because that one fills
 * a JSON schema and never asks for a tool — and a tool call is precisely what
 * has to happen for `AgentTaskStep.toolCallId` to be exercised.
 *
 * Needs a database and nothing else:
 *   npx tsx checks/spineEndToEnd.ts
 */
import http from "node:http";
import { prisma } from "../src/lib/prisma.js";
import { runTask } from "../src/services/agents/runner.js";
import { historyOf } from "../src/services/agents/state.js";

const AGENT_KEY = "tmp.spine2e";
const PORT = 4598;

/** Asks for one real tool on the first turn, then finishes. */
function stub() {
  let turn = 0;
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      const reply = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && url.includes("/v1/models/")) return reply(200, { id: url.split("/").pop(), display_name: "Stub" });
      if (!url.includes("/v1/messages")) return reply(404, { error: { message: `no stub route for ${url}` } });

      turn += 1;
      if (turn === 1) {
        // Catalogue keys carry dots; the Anthropic tool name is the same key
        // with `__` in their place, which is what the runner registered.
        return reply(200, {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "tool_use", id: "call_1", name: "lead__read", input: { limit: 1 } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 900, output_tokens: 200 },
        });
      }
      return reply(200, {
        id: `msg_${turn}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "Read the leads. Nothing else needed." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 300, output_tokens: 400 },
      });
    });
  });
}

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
  await prisma.llmCall.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.toolCall.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
}

async function main() {
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PORT}`;
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "stub";
  const server = stub();
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  await reset();

  await prisma.agent.create({
    data: {
      key: AGENT_KEY,
      name: "Spine End To End",
      title: "Harness",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      mission: "Read a lead and say what it says.",
      autonomyLevel: 2,
      dryRun: false,
      toolkit: ["lead.read"],
      prompt: {
        role: "You are a harness.",
        mission: "Call lead.read once, then stop.",
        scope: "Nothing else.",
        dataRules: "",
        tools: "lead.read",
        policy: "",
        process: "Call lead.read. Then finish.",
        escalateWhen: "Never.",
        output: "One sentence.",
        memory: "",
      },
    },
  });

  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Read a lead", brief: "Call lead.read once and report what you saw.", origin: "OWNER" },
  });
  console.log(`task    ${task.id}`);
  console.log(`trace   ${task.traceId}\n`);

  const outcome = await runTask(task.id);
  console.log(`ended   ${outcome.status}\n`);

  const trace = task.traceId;
  const [tools, models, moves, steps, finished] = await Promise.all([
    prisma.toolCall.findMany({ where: { traceId: trace }, select: { id: true, tool: true, ok: true, dryRun: true } }),
    prisma.llmCall.findMany({ where: { traceId: trace }, select: { purpose: true, inputTokens: true, outputTokens: true } }),
    historyOf(task.id),
    prisma.agentTaskStep.findMany({ where: { taskId: task.id }, select: { kind: true, tool: true, toolCallId: true } }),
    prisma.agentTask.findUnique({ where: { id: task.id }, select: { inputTokens: true, outputTokens: true, costUsd: true, status: true } }),
  ]);

  console.log(`tool calls on the trace : ${tools.length}`);
  for (const t of tools) console.log(`   ${t.tool.padEnd(20)} ok=${t.ok} dryRun=${t.dryRun}`);
  console.log(`model calls on the trace: ${models.length}`);
  for (const m of models) console.log(`   ${m.purpose.padEnd(20)} ${m.inputTokens} in / ${m.outputTokens} out`);
  console.log(`status history          : ${moves.map((m) => `${m.from ?? "-"}>${m.to}`).join("  ")}`);
  console.log(`tokens kept on the task : ${finished?.inputTokens} in / ${finished?.outputTokens} out, $${finished?.costUsd}`);

  const toolSteps = steps.filter((s) => s.tool);
  const joined = toolSteps.filter((s) => s.toolCallId);
  console.log(`tool steps joined       : ${joined.length} of ${toolSteps.length}`);

  const problems: string[] = [];
  if (models.length === 0) problems.push("no model call was attributed to the trace");
  if (toolSteps.length !== joined.length) problems.push("a tool step has no ToolCall behind it");
  if (moves.length < 2) problems.push("the status history is missing entries");
  if ((finished?.inputTokens ?? 0) === 0) problems.push("no tokens were kept on the finished task");

  console.log(problems.length === 0 ? "\nOK — one id gathers the whole run." : `\nPROBLEMS:\n  ${problems.join("\n  ")}`);
  if (problems.length > 0) process.exitCode = 1;

  await reset();
  server.close();
  await prisma.$disconnect();
}

void main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exitCode = 1;
});
