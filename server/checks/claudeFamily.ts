/**
 * The current Claude family: what it costs, and that every request this app
 * sends it is one it will take.
 *
 * In Oct 2026 the three task levels, the default and the economy model moved
 * to Haiku 5.5, Sonnet 5.5 and Opus 5.5, with Fable 5.1 offered for the Owner
 * to choose and shipped on nothing. Two things can go wrong with a move like
 * that and neither breaks anything visibly:
 *
 *  1. **The bill.** Opus 5.5 reads its cache at a twentieth of input and Fable
 *     5.1 at a fortieth; Haiku 5.5 has two rate cards chosen by the prompt's
 *     length. A flat multiplier gets all three wrong, and a ceiling reading the
 *     wrong number fails silently.
 *  2. **The wire.** On this family a disabled thinking block, a thinking
 *     budget, a non-default temperature, a forced tool choice or an assistant
 *     prefill is a 400 — and a 400 is "refused the request shape", which both
 *     the agent loop and `callModel` read as a reason to hand the work to the
 *     next vendor. So a malformed request does not fail; it quietly moves every
 *     task to ChatGPT. The level this replaced was exactly that: Haiku 4.5
 *     takes no effort setting, every Claude request here carries one, and the
 *     simple level had been sending its work elsewhere since it shipped.
 *
 * The fake Anthropic here **enforces** those rules and answers 400 the way the
 * real API does, the same way the Gemini stub refuses `additionalProperties`.
 * A call that succeeds against it is evidence of the shape, and two negatives
 * prove the fake bites rather than waving everything through. Asserted on the
 * request body, per level, on both halves of the model layer: the one-shot
 * writers through `callModel`, and an agent turn through `runAgentLoop`.
 *
 * A database and a fake Anthropic on localhost. No API key and no network.
 *   npx tsx checks/claudeFamily.ts
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const near = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-9;

const FAMILY = new Set(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]);

/**
 * What the real API refuses, as far as this app could ever send it. Returns
 * the vendor's sentence, or null for a request it would take.
 */
function refusal(body: Record<string, any>): string | null {
  const model = String(body.model ?? "");
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : null;
  if (model === "claude-haiku-4-5") {
    if (body.output_config?.effort !== undefined) return "effort: This model does not support the effort parameter.";
    if (body.thinking?.type === "adaptive") return "thinking.type.adaptive is not supported for this model.";
    return null;
  }
  if (!FAMILY.has(model)) return null;
  if (body.thinking?.type === "disabled") return '"thinking.type.disabled" is not supported for this model.';
  if (body.thinking?.type === "enabled" || JSON.stringify(body.thinking ?? {}).includes("budget_tokens")) return '"thinking.type.enabled" is not supported for this model.';
  for (const sampling of ["temperature", "top_p", "top_k"]) if (sampling in body) return `${sampling}: non-default sampling parameters are not supported for this model.`;
  if (body.tool_choice && body.tool_choice.type !== "auto" && body.tool_choice.type !== "none") return 'tool_choice: type "tool" and "any" are not supported for this model.';
  if (last?.role === "assistant") return "This model does not support assistant message prefill. The conversation must end with a user message.";
  if (model === "claude-haiku-5-5" && Array.isArray(body.fallbacks)) return "fallbacks: there is no server-side fallback for this model.";
  return null;
}

/** Every request body the fake received, in order. */
const seen: Record<string, any>[] = [];

function fakeAnthropic(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        seen.push(body);
        const refused = refusal(body);
        if (refused) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: refused } }));
          return;
        }
        // A one-shot call asks for a schema and gets JSON; an agent turn asks
        // for nothing in particular and gets a sentence.
        const structured = body.output_config?.format?.type === "json_schema";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_check_family",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: structured ? JSON.stringify({ answer: "yes" }) : "Done." }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

/** The rules this app holds itself to on every Claude request, beyond what one model happens to forgive. */
function shapeProblems(body: Record<string, any>): string[] {
  const problems: string[] = [];
  const effort = body.output_config?.effort;
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) problems.push(`effort not sent explicitly (${JSON.stringify(effort)})`);
  if (body.thinking && body.thinking.type !== "adaptive") problems.push(`thinking ${JSON.stringify(body.thinking)}`);
  if (JSON.stringify(body).includes("budget_tokens")) problems.push("a thinking budget");
  for (const sampling of ["temperature", "top_p", "top_k"]) if (sampling in body) problems.push(sampling);
  if (body.tool_choice && !["auto", "none"].includes(body.tool_choice.type)) problems.push(`tool_choice ${body.tool_choice.type}`);
  if (body.messages?.at(-1)?.role !== "user") problems.push(`ends on ${body.messages?.at(-1)?.role}`);
  return problems;
}

const PURPOSE = "check.claudeFamily";
const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };

async function main() {
  const { server, url } = await fakeAnthropic();
  // Before the SDK is imported: it reads its environment at construction.
  const savedEnv = Object.fromEntries(
    ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY", "NVIDIA_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_MODEL_ECONOMY"].map((name) => [name, process.env[name]]),
  );
  process.env.ANTHROPIC_BASE_URL = url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
  // Every other vendor unconnected, so each call can only land on the wire
  // this check is reading.
  for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY", "NVIDIA_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_MODEL_ECONOMY"]) delete process.env[name];

  const { prisma } = await import("../src/lib/prisma.js");
  const { SETTING, clearSettingsCache, setSetting } = await import("../src/lib/settings.js");
  const { MODEL_DEFAULT, MODEL_ECONOMY, MODEL_PRICING, costOf } = await import("../src/lib/claudePricing.js");
  const { CLAUDE_WITHOUT_EFFORT, PROVIDERS, TASK_LEVELS, TIER_MODELS, effortForLevel, isShippedPricedModel, whyNotChoosable } = await import("../src/lib/models/registry.js");
  const { callModel } = await import("../src/lib/models/call.js");
  const { callClaude } = await import("../src/lib/claude.js");
  const { runAgentLoop } = await import("../src/lib/claudeAgent.js");

  const SETTINGS = [
    SETTING.ANTHROPIC_KEY,
    SETTING.ANTHROPIC_MODEL,
    SETTING.ANTHROPIC_MODEL_ECONOMY,
    SETTING.OPENAI_KEY,
    SETTING.GEMINI_KEY,
    SETTING.PERPLEXITY_KEY,
    SETTING.NVIDIA_KEY,
    SETTING.NVIDIA_FREE_MODELS,
    SETTING.MODEL_ROUTES,
    SETTING.MODEL_JOB_MODELS,
    SETTING.MODEL_TIER_MODELS,
    SETTING.MODEL_PRICING,
    SETTING.ANTHROPIC_PRICING,
  ];
  const savedRows = await prisma.appSetting.findMany({ where: { key: { in: SETTINGS } } });
  const startedAt = new Date();
  const removeLedger = () => prisma.llmCall.deleteMany({ where: { purpose: { startsWith: PURPOSE }, createdAt: { gte: startedAt } } });

  await prisma.appSetting.deleteMany({ where: { key: { in: SETTINGS } } });
  // Free models off for both halves, so the paid floor is what answers.
  await setSetting(SETTING.NVIDIA_FREE_MODELS, JSON.stringify({ agent: [], text: [], triage: [] }));
  clearSettingsCache();

  try {
    console.log("\nWhat ships, and what is only offered");
    {
      const levels = TIER_MODELS.anthropic;
      check(
        "the three levels are Haiku 5.5, Sonnet 5.5 and Opus 5.5",
        levels.simple === "claude-haiku-5-5" && levels.standard === "claude-sonnet-5-5" && levels.complex === "claude-opus-5-5",
        JSON.stringify(levels),
      );
      check("the default is Opus 5.5 and the economy model Sonnet 5.5", MODEL_DEFAULT === "claude-opus-5-5" && MODEL_ECONOMY === "claude-sonnet-5-5", `${MODEL_DEFAULT} / ${MODEL_ECONOMY}`);
      check(
        "the vendor's own defaults follow them",
        PROVIDERS.anthropic.defaultModel === MODEL_DEFAULT && PROVIDERS.anthropic.economyModel === MODEL_ECONOMY,
      );
      const shippedOn = new Set([...Object.values(levels), MODEL_DEFAULT, MODEL_ECONOMY]);
      check("Fable 5.1 ships on nothing", !shippedOn.has("claude-fable-5-1"));
      check("but is offered, priced and choosable", PROVIDERS.anthropic.models.includes("claude-fable-5-1") && (await whyNotChoosable("claude-fable-5-1")) === null);
      const everyClaudeId = [...shippedOn, ...PROVIDERS.anthropic.models];
      check("every Claude id shipped or offered is priced", everyClaudeId.every(isShippedPricedModel), everyClaudeId.filter((id) => !isShippedPricedModel(id)).join(", "));
      check(
        "and none of them is one the wire cannot ask",
        everyClaudeId.every((id) => !CLAUDE_WITHOUT_EFFORT.includes(id)),
        everyClaudeId.filter((id) => CLAUDE_WITHOUT_EFFORT.includes(id)).join(", "),
      );
      const older = ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"];
      check("the previous generation stays priced, for the calls it served", older.every(isShippedPricedModel), older.filter((id) => !isShippedPricedModel(id)).join(", "));
    }

    console.log("\nWhat each one costs");
    {
      const M = 1_000_000;
      const rate = (id: string) => MODEL_PRICING[id];
      check("Opus 5.5 is $4 in and $20 out", near(costOf(rate("claude-opus-5-5"), { inputTokens: M, outputTokens: M }), 24));
      check("and reads its cache at $0.20, a twentieth", near(costOf(rate("claude-opus-5-5"), { inputTokens: 0, outputTokens: 0, cacheReadTokens: M }), 0.2));
      check("and writes it at $5, a quarter more", near(costOf(rate("claude-opus-5-5"), { inputTokens: 0, outputTokens: 0, cacheCreationTokens: M }), 5));
      check("Fable 5.1 is $10 and $50", near(costOf(rate("claude-fable-5-1"), { inputTokens: M, outputTokens: M }), 60));
      check("and reads its cache at $0.25, a fortieth", near(costOf(rate("claude-fable-5-1"), { inputTokens: 0, outputTokens: 0, cacheReadTokens: M }), 0.25));
      check("and writes it at $12.50", near(costOf(rate("claude-fable-5-1"), { inputTokens: 0, outputTokens: 0, cacheCreationTokens: M }), 12.5));
      check("Sonnet 5.5 is $2 and $10, cache reads $0.20", near(costOf(rate("claude-sonnet-5-5"), { inputTokens: M, outputTokens: M, cacheReadTokens: M }), 12.2));
      // Haiku 5.5's two cards. The line is on the prompt — input plus cache —
      // and the card covers the whole call, output included.
      const haiku = rate("claude-haiku-5-5");
      check("Haiku 5.5 at exactly 100K of prompt is on the small card", near(costOf(haiku, { inputTokens: 100_000, outputTokens: 10_000 }), 0.015));
      check("one token over and the whole call is on the large one", near(costOf(haiku, { inputTokens: 100_001, outputTokens: 10_000 }), 0.0750005));
      check(
        "cache reads count toward the line, at a tenth of that card",
        near(costOf(haiku, { inputTokens: 60_000, outputTokens: 1_000, cacheReadTokens: 50_000 }), 0.035),
        String(costOf(haiku, { inputTokens: 60_000, outputTokens: 1_000, cacheReadTokens: 50_000 })),
      );
      check("and on the small card a read is a tenth of $0.10", near(costOf(haiku, { inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 50_000 }), 0.0001 + 0.0005));
      // The negatives: nothing that was right before moved.
      check("Opus 5 still reads its cache at a tenth", near(costOf(rate("claude-opus-5"), { inputTokens: 0, outputTokens: 0, cacheReadTokens: M }), 0.5));
      check("Haiku 4.5 is still $1 and $5", near(costOf(rate("claude-haiku-4-5"), { inputTokens: M, outputTokens: M }), 6));
      check("the small model costs less than the flagship", haiku.outputPerMTok < rate("claude-sonnet-5-5").outputPerMTok && rate("claude-sonnet-5-5").outputPerMTok < rate("claude-opus-5-5").outputPerMTok);
    }

    console.log("\nThe fake refuses what the real API refuses");
    {
      // Without these two, every positive below could be a fake that answers
      // 200 to anything.
      const raw = async (body: Record<string, unknown>) =>
        fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const disabled = await raw({ model: "claude-opus-5-5", max_tokens: 10, thinking: { type: "disabled" }, output_config: { effort: "low" }, messages: [{ role: "user", content: "hi" }] });
      check("thinking switched off on Opus 5.5 is a 400", disabled.status === 400, String(disabled.status));
      const prefill = await raw({ model: "claude-haiku-5-5", max_tokens: 10, output_config: { effort: "low" }, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "{" }] });
      check("a prefill on Haiku 5.5 is a 400", prefill.status === 400, String(prefill.status));
      // And the defect the move repaired: the request this app sends, asked of
      // the model the simple level used to name.
      let refusedOld = false;
      try {
        await callClaude({ purpose: `${PURPOSE}.haiku45`, system: "You are a check.", prompt: () => "Say yes.", schema: SCHEMA, effort: "low", model: "claude-haiku-4-5" });
      } catch (err) {
        refusedOld = (err as { status?: number }).status === 400;
      }
      check("Haiku 4.5 refuses the request this app sends it", refusedOld);
    }

    console.log("\nThe one-shot writers send each model a request it takes");
    {
      const ask = async (over: Record<string, unknown>) => {
        seen.length = 0;
        const result = await callModel<{ answer: string }>({ purpose: `${PURPOSE}.oneShot`, system: "You are a check.", prompt: () => "Say yes.", schema: SCHEMA, ...over } as never);
        return { result, body: seen.at(-1) ?? {} };
      };
      const economy = await ask({ job: "triage" });
      check("an economy job reaches Sonnet 5.5", economy.body.model === MODEL_ECONOMY && economy.result.provider === "anthropic", String(economy.body.model));
      check("in a shape the family takes", shapeProblems(economy.body).length === 0, shapeProblems(economy.body).join("; "));
      const standard = await ask({ job: "text", effort: "high" });
      check("a standard job reaches Opus 5.5", standard.body.model === MODEL_DEFAULT, String(standard.body.model));
      check("with the effort it asked for, said out loud", standard.body.output_config?.effort === "high" && shapeProblems(standard.body).length === 0, JSON.stringify(standard.body.output_config?.effort));
      const unsaid = await ask({ job: "text" });
      // Opus 5.5 defaults to medium and Sonnet 5.5 to high; a request that
      // left it out would run at whatever the model chose.
      check("and an effort nobody named is still sent", unsaid.body.output_config?.effort === "medium", JSON.stringify(unsaid.body.output_config));
      for (const level of TASK_LEVELS) {
        const borrowed = await ask({ job: "text", agentChain: { level }, effort: effortForLevel(level) });
        check(`a one-shot call on the ${level} chain reaches ${TIER_MODELS.anthropic[level]}`, borrowed.body.model === TIER_MODELS.anthropic[level] && borrowed.result.model === TIER_MODELS.anthropic[level], String(borrowed.body.model));
        check(`and the ${level} request is one it takes`, shapeProblems(borrowed.body).length === 0, shapeProblems(borrowed.body).join("; "));
      }
    }

    console.log("\nAn agent turn sends each level a request it takes");
    {
      const tool = {
        name: "look_up",
        description: "Looks something up.",
        inputSchema: { type: "object", properties: { what: { type: "string" } } },
        run: async () => ({ content: "Tuesday." }),
      };
      for (const level of TASK_LEVELS) {
        seen.length = 0;
        const result = await runAgentLoop({ purpose: `${PURPOSE}.loop`, system: "You are a check.", prompt: "Say you are done.", tools: [tool], level });
        const body = seen[0] ?? {};
        check(`a ${level} turn reaches ${TIER_MODELS.anthropic[level]}`, body.model === TIER_MODELS.anthropic[level], String(body.model));
        check(`and finishes there rather than being handed on`, seen.length === 1 && result.text.includes("Done"), `${seen.length} request(s): ${result.text}`);
        check(`with adaptive thinking and ${effortForLevel(level)} effort`, body.thinking?.type === "adaptive" && body.output_config?.effort === effortForLevel(level), `${JSON.stringify(body.thinking)} ${JSON.stringify(body.output_config)}`);
        check(`its tools offered, never forced`, Array.isArray(body.tools) && body.tools.length > 0 && shapeProblems(body).length === 0, shapeProblems(body).join("; "));
      }
    }
  } catch (err) {
    failures.push(`the run stopped: ${(err as Error).message}`);
    console.log(`\n  THREW  ${(err as Error).stack ?? (err as Error).message}`);
  } finally {
    server.close();
    // Rule 3: the ledger rows this run wrote, scoped to its own purpose and its
    // own start time, then every setting put back as it was.
    await removeLedger().catch(() => undefined);
    await prisma.appSetting.deleteMany({ where: { key: { in: SETTINGS } } }).catch(() => undefined);
    for (const row of savedRows) await prisma.appSetting.create({ data: { key: row.key, value: row.value, secret: row.secret } }).catch(() => undefined);
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    clearSettingsCache();
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      for (const name of failures) console.log(`  - ${name}`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
