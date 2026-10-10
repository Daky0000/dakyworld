/**
 * The Website Builder agent runs on the models the OS agents run on.
 *
 * callModel with agentChain, against stub vendors and no database.
 *
 * NVIDIA refuses every free rung and Claude answers. The free rungs must be
 * the "agent" ladder and the paid model the one set for the task level.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const asked: string[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const json = body ? JSON.parse(body) : {};
    if (req.url?.includes("/nvidia/")) {
      asked.push(`nvidia:${json.model}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "busy" } }));
      return;
    }
    if (req.url?.includes("/v1/messages")) {
      asked.push(`anthropic:${json.model}`);
      const plan = { explanation: "Made it bold.", intent: "page_edits", editorCommand: "none", escalationReason: "", escalationCategory: "none", parsedOperation: { from: "", to: "", property: "" }, structuralActions: [], pages: [{ pageId: "p1", changes: [{ fieldId: "f1", operation: "set_style", property: "font-weight", value: "700" }] }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: json.model, content: [{ type: "text", text: JSON.stringify(plan) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
      return;
    }
    asked.push(`other:${req.url}`);
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.NVIDIA_API_KEY = "nv-test";
process.env.NVIDIA_BASE_URL = `${base}/nvidia/v1`;
process.env.ANTHROPIC_API_KEY = "sk-ant-test";
process.env.ANTHROPIC_BASE_URL = base;
for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_MODEL_ECONOMY"]) delete process.env[key];

// No database here: every stored setting reads as unset.
const { prisma } = await import("../src/lib/prisma.js");
Object.defineProperty(prisma, "appSetting", { value: { findUnique: async () => null, findMany: async () => [] } });
Object.defineProperty(prisma, "llmCall", { value: { create: async () => ({}), findFirst: async () => null } });

const { callModel } = await import("../src/lib/models/call.js");
const { FREE_LADDER_BY_JOB, TIER_MODELS } = await import("../src/lib/models/registry.js");
const { AI_PLAN_JSON_SCHEMA, builderTaskLevel, planFromModel } = await import("../src/services/websiteBuilderAgent.js");

try {
  assert.equal(builderTaskLevel("make this heading bold", 0), "standard");
  assert.equal(builderTaskLevel("change the font on every page", 0), "complex");
  assert.equal(builderTaskLevel("use this photo as the hero", 1), "complex");
  assert.equal(builderTaskLevel("change the font across the whole site", 0, true), "standard", "a spend ceiling holds it at standard");
  for (const level of ["standard", "complex"] as const) {
    asked.length = 0;
    const result = await callModel<unknown>({
      purpose: "check.websiteAgentChain",
      job: "html",
      agentChain: { level },
      system: "Return the plan.",
      prompt: () => "Make the selected heading bold.",
      schema: AI_PLAN_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 500,
    });
    const free = asked.filter((a) => a.startsWith("nvidia:")).map((a) => a.slice(7));
    assert.deepEqual(free, FREE_LADDER_BY_JOB.agent, `${level}: the free rungs are the agents' ladder`);
    assert.equal(asked.at(-1), `anthropic:${TIER_MODELS.anthropic[level]}`, `${level}: Claude serves the ${level} model`);
    assert.equal(result.provider, "anthropic");
    assert.equal(planFromModel(result.data).pages[0]?.changes[0]?.value, "700");
    assert.ok(result.fallbackNote?.includes("so Claude answered"), result.fallbackNote ?? "no note");
    console.log(`${level}: ${asked.join(" → ")}`);
  }
  console.log("websiteAgentChain: sized like the agents, free agent ladder first, then Claude at the task level's model — passed");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

