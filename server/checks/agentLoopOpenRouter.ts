/**
 * Does an agent turn really run on ox-alpha — and does it fall back to Claude?
 *
 * Agent turns used to be the one corner of the system the routing never
 * reached: every routed job moved to ox-alpha the day its key was pasted,
 * while the conversation loop itself kept speaking to Anthropic directly. The
 * symptom was a rehearsal dying on "Your credit balance is too low to access
 * the Anthropic API" to somebody who had changed every dropdown to ox-alpha
 * and reasonably expected that to be the whole story.
 *
 * The fix translates at the wire rather than keeping a second loop: the
 * loop's internal state stays Anthropic-shaped (so every existing checkpoint
 * resumes), and `openRouterTurn()` speaks OpenAI chat-completions on the way
 * out and back. This check drives the real `runAgentLoop` against a fake
 * OpenRouter on localhost and asserts on **what went over the wire**, because
 * a translator that is never exercised is precisely the kind of code that
 * rots silently.
 *
 * Three things are pinned here:
 *
 * - **The wire shape.** Tools go out as `functions`, results come back as
 *   `role: "tool"` messages keyed by call id, and the effort rides as
 *   `reasoning_effort` mapped onto what ox-alpha accepts (its default is max;
 *   leaving it unset would put headline-depth reasoning under economy runs).
 * - **The checkpoint stays Anthropic-shaped.** A run that starts on ox-alpha
 *   must leave behind a state Claude can resume, and vice versa — the whole
 *   point of translating at the edge. If `"role":"tool"` ever appears inside
 *   a saved checkpoint, the wire has leaked into the state.
 * - **A refused key hands the run to Claude.** ox-alpha is prepaid; a 402 is
 *   a balance, not a bug. With Claude connected the run finishes anyway, the
 *   failed vendor sits out a cooldown so the resumes behind it start on
 *   Claude too, and only a deployment with neither key connected may fail.
 *
 * No API key and no network — both fakes serve their turns locally.
 *   npx tsx checks/agentLoopOpenRouter.ts
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

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

/** One OpenAI-shaped chat completion. */
function openRouterReply(turn: number) {
  return turn === 0
    ? {
        id: "chatcmpl_check_1",
        object: "chat.completion",
        model: "stealth/ox-alpha",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Looking that up.",
              tool_calls: [
                { id: "call_check_1", type: "function", function: { name: "look_up", arguments: '{"what":"anything"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 15 },
      }
    : {
        id: "chatcmpl_check_2",
        object: "chat.completion",
        model: "stealth/ox-alpha",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
        usage: { prompt_tokens: 30, completion_tokens: 5 },
      };
}

/** One Anthropic-shaped message, the same shape checks/promptCache.ts serves. */
function anthropicReply(turn: number) {
  return {
    id: `msg_check_${turn}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: turn === 0 ? [{ type: "text", text: "Looking that up." }] : [{ type: "text", text: "Done." }],
    stop_reason: turn === 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    // Turn one asks for a tool through the same catalogue entry, so the loop
    // exercises the same path either wire takes.
    ...(turn === 0
      ? {}
      : {}),
  };
}

/** An Anthropic reply whose first turn asks for the tool. */
function anthropicToolTurn(turn: number) {
  if (turn === 0) {
    return {
      ...anthropicReply(0),
      content: [
        { type: "text", text: "Looking that up." },
        { type: "tool_use", id: "toolu_check_1", name: "look_up", input: { what: "anything" } },
      ],
      stop_reason: "tool_use",
    };
  }
  return anthropicReply(1);
}

function httpServer(handle: (body: unknown, send: (status: number, payload: unknown) => void) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          parsed = {};
        }
        handle(parsed, (status, payload) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
        });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const lookUpTool = {
  name: "look_up",
  description: "Looks something up.",
  inputSchema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
  run: async (input: Record<string, unknown>) => {
    seenInput = input;
    return { content: "It is a Tuesday." };
  },
};
let seenInput: Record<string, unknown> | null = null;

async function main() {
  const { prisma } = await import("../src/lib/prisma.js");
  const { clearSettingsCache, SETTING } = await import("../src/lib/settings.js");
  const { runAgentLoop, reasoningEffortFor, clearOpenRouterCooldown } = await import("../src/lib/claudeAgent.js");
  const { PROVIDERS } = await import("../src/lib/models/registry.js");

  // --- Isolation ---------------------------------------------------------------
  //
  // Rule one of this directory: a database and nothing else — and certainly no
  // real vendor on the other end of it. getSetting prefers the environment but
  // falls back to the AppSetting rows, and a dev database holds whatever keys
  // were pasted while testing; a scenario that wants a vendor unconnected must
  // remove the row as well as the variable, or the run quietly reaches the
  // real API through a stored key. Snapshot first, restored at the end: nothing
  // here outlives the process.
  const VENDOR_SETTINGS = [
    SETTING.ANTHROPIC_KEY,
    SETTING.ANTHROPIC_MODEL,
    SETTING.ANTHROPIC_MODEL_ECONOMY,
    SETTING.OPENROUTER_KEY,
    SETTING.OPENROUTER_MODEL,
  ];
  const savedSettings = await prisma.appSetting.findMany({ where: { key: { in: VENDOR_SETTINGS } } });
  await prisma.appSetting.deleteMany({ where: { key: { in: VENDOR_SETTINGS } } });
  clearSettingsCache();

  // --- The effort mapping ----------------------------------------------------
  //
  // ox-alpha offers low/high/max and defaults to max. Our medium must not
  // become max by omission, and our high must not fall through to low.
  check("low stays low", reasoningEffortFor("low") === "low");
  check("medium steps up to high, not the model's max default", reasoningEffortFor("medium") === "high");
  check("high rides at max", reasoningEffortFor("high") === "max");
  check("xhigh rides at max", reasoningEffortFor("xhigh") === "max");
  check("max rides at max", reasoningEffortFor("max") === "max");

  // --- Scenario A: ox-alpha alone, happy path --------------------------------

  const orBodies: Record<string, any>[] = [];
  const orServer = await httpServer((_body, send) => {
    orBodies.push(_body as Record<string, any>);
    send(200, openRouterReply(orBodies.length - 1));
  });

  // Set before anything reads them; getSetting falls back to these live.
  process.env.OPENROUTER_API_KEY = "sk-or-check-not-a-real-key";
  process.env.OPENROUTER_BASE_URL = orServer.url;
  // Claude must stay unconnected, or the selection never reaches ox-alpha.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  clearSettingsCache();

  let savedState: unknown = null;
  const result = await runAgentLoop({
    purpose: "check.agentLoop.openrouter",
    system: "You are a check.",
    prompt: "Look something up, then say you are done.",
    tools: [lookUpTool],
    effort: "medium",
    onCheckpoint: async (state) => {
      savedState = state;
    },
  });

  check("the loop ran both turns against OpenRouter", orBodies.length === 2, `sent ${orBodies.length}`);
  check("it finished", result.stoppedBecause === "finished", result.stoppedBecause);
  check("the summary came back", result.text === "Done.", result.text);

  const [first, second] = orBodies;

  // --- The wire shape --------------------------------------------------------
  // Read from the registry rather than pinned to a slug. The stealth listing
  // this shipped on was retired without notice on 26 Aug 2026, and a check that
  // hard-codes the model fails on the swap itself rather than on anything being
  // wrong — which trains somebody to edit the assertion instead of reading it.
  check("the shipped slug is what goes out", first?.model === PROVIDERS.openrouter.defaultModel, String(first?.model));
  check("the effort rides as reasoning_effort", first?.reasoning_effort === "high", String(first?.reasoning_effort));
  check("the token ceiling travels as max_tokens", first?.max_tokens === 16_000, String(first?.max_tokens));
  check(
    "no Anthropic-only fields leak onto this wire",
    !JSON.stringify(first).includes('"thinking"') && !JSON.stringify(first).includes("cache_control"),
    "cache breakpoints and thinking blocks do not exist on OpenRouter",
  );

  check("the system prompt leads as its own message", first?.messages?.[0]?.role === "system", JSON.stringify(first?.messages?.[0]));
  check("the brief follows as a plain user turn", first?.messages?.[1]?.role === "user" && first?.messages?.[1]?.content === "Look something up, then say you are done.");

  const tool = first?.tools?.[0];
  check("tools go out as functions", tool?.type === "function" && tool?.function?.name === "look_up", JSON.stringify(tool)?.slice(0, 120));
  check("the schema rides along as parameters", tool?.function?.parameters?.type === "object", JSON.stringify(tool?.function?.parameters));

  // --- The tool round trip ---------------------------------------------------
  const assistantTurn = (second?.messages ?? []).find((m: any) => m.role === "assistant");
  const toolMessage = (second?.messages ?? []).find((m: any) => m.role === "tool");
  check(
    "the assistant turn carries its tool call",
    assistantTurn?.tool_calls?.[0]?.id === "call_check_1" && assistantTurn?.tool_calls?.[0]?.function?.name === "look_up",
    JSON.stringify(assistantTurn)?.slice(0, 160),
  );
  check(
    "the answer comes back keyed to the call it answers",
    toolMessage?.tool_call_id === "call_check_1" && toolMessage?.content === "It is a Tuesday.",
    JSON.stringify(toolMessage),
  );
  check("the arguments arrived parsed, not as a string", JSON.stringify(seenInput) === '{"what":"anything"}', JSON.stringify(seenInput));
  check("one tool call was counted", result.toolCalls === 1, String(result.toolCalls));

  // --- The checkpoint stays Anthropic-shaped ---------------------------------
  const saved = JSON.stringify(savedState);
  check(
    "the checkpoint holds tool_use blocks, not wire shapes",
    saved.includes('"type":"tool_use"') && saved.includes('"type":"tool_result"'),
    "a checkpoint the Anthropic half cannot resume breaks every mixed-vendor resume",
  );
  check(
    "and no OpenAI wire shape leaked into it",
    !saved.includes('"role":"tool"') && !saved.includes("tool_calls"),
    'a saved "role":"tool" message is unreadable on the Anthropic wire',
  );

  // --- The ledger ------------------------------------------------------------
  const row = await prisma.llmCall.findFirst({ where: { purpose: "check.agentLoop.openrouter" }, orderBy: { createdAt: "desc" } });
  check("the run was recorded under the model that served it", row?.model === "stealth/ox-alpha", String(row?.model));
  check("both turns' tokens landed", row?.inputTokens === 150 && row?.outputTokens === 20, `in=${row?.inputTokens} out=${row?.outputTokens}`);
  check("it recorded as a success", row?.ok === true, String(row?.ok));

  // --- Scenario B: a refused key hands the run to Claude ----------------------

  const anthBodies: Record<string, any>[] = [];
  const anthServer = await httpServer((_body, send) => {
    anthBodies.push(_body as Record<string, any>);
    send(200, anthropicToolTurn(anthBodies.length - 1));
  });

  const refusedBodies: unknown[] = [];
  const refusedServer = await httpServer((_body, send) => {
    refusedBodies.push(_body);
    // Prepaid and empty: the exact sentence a drained balance produces.
    send(402, "Insufficient credits");
  });

  process.env.OPENROUTER_BASE_URL = refusedServer.url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
  process.env.ANTHROPIC_BASE_URL = anthServer.url;
  // Scenario A cached these keys' answers; the new environment must be read.
  clearSettingsCache();

  const fallback = await runAgentLoop({
    purpose: "check.agentLoop.fallback",
    system: "You are a check.",
    prompt: "Look something up, then say you are done.",
    tools: [lookUpTool],
    effort: "medium",
  });

  check("the refused vendor was asked exactly once", refusedBodies.length === 1, String(refusedBodies.length));
  check("Claude took the run over and finished it", fallback.stoppedBecause === "finished" && fallback.model.startsWith("claude"), `${fallback.stoppedBecause} / ${fallback.model}`);
  check("Claude served both turns of it", anthBodies.length === 2, String(anthBodies.length));
  check("the work still got done", fallback.text === "Done.", fallback.text);

  // --- Scenario C: the cooldown holds for the runs behind it ------------------
  //
  // A task interrupted mid-rehearsal resumes within minutes. Each resume must
  // start on Claude while the refusal is fresh, not pay another call into the
  // same empty balance first.
  const before = refusedBodies.length;
  const again = await runAgentLoop({
    purpose: "check.agentLoop.cooldown",
    system: "You are a check.",
    prompt: "Look something up, then say you are done.",
    tools: [lookUpTool],
    effort: "medium",
  });
  check("the cooldown skipped the refused vendor entirely", refusedBodies.length === before, `${refusedBodies.length - before} extra call(s) into a dead balance`);
  check("and the run still finished on Claude", again.stoppedBecause === "finished" && again.model.startsWith("claude"), `${again.stoppedBecause} / ${again.model}`);

  // --- Scenario D: a model OpenRouter no longer lists ------------------------
  //
  // The one that actually happened. On 26 Aug 2026 OpenRouter retired the
  // `stealth/ox-alpha` slug and answered 404 with a body naming its
  // replacement. 404 was not in the loop's failover list — only the key-level
  // 401/402/403 were — so a live Chief Executive task died on its first turn
  // with the whole conversation intact and Claude connected and unasked. A
  // model that no longer exists tells us nothing about the request, which is
  // the same thing a drained balance tells us.
  const goneBodies: unknown[] = [];
  const goneServer = await httpServer((_body, send) => {
    goneBodies.push(_body);
    send(404, "Thank you for participating in the Stealth Ox Alpha testing period. This model was ZAI\u2019s GLM-5.3 Flash.");
  });

  process.env.OPENROUTER_BASE_URL = goneServer.url;
  clearSettingsCache();
  // Scenario C left ox-alpha inside its cooldown, which would skip the vendor
  // before the 404 could be reached and make this a test of nothing.
  clearOpenRouterCooldown();

  const anthBefore = anthBodies.length;
  const retired = await runAgentLoop({
    purpose: "check.agentLoop.retiredModel",
    system: "You are a check.",
    prompt: "Look something up, then say you are done.",
    tools: [lookUpTool],
    effort: "medium",
  });

  check("the retired model was tried once", goneBodies.length === 1, String(goneBodies.length));
  check(
    "a 404 hands the run to Claude rather than killing it",
    retired.stoppedBecause === "finished" && retired.model.startsWith("claude"),
    `${retired.stoppedBecause} / ${retired.model}`,
  );
  check("and Claude actually served the turns", anthBodies.length > anthBefore, `${anthBodies.length - anthBefore} turn(s)`);
  check("the work still got done", retired.text === "Done.", retired.text);

  goneServer.server.close();
  orServer.server.close();
  anthServer.server.close();
  refusedServer.server.close();

  await prisma.llmCall.deleteMany({ where: { purpose: { startsWith: "check.agentLoop" } } });
  // Put back exactly what was here: same rows, same encrypted values.
  if (savedSettings.length > 0) await prisma.appSetting.createMany({ data: savedSettings });
  clearSettingsCache();
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log(failures.map((name) => `  - ${name}`).join("\n"));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});