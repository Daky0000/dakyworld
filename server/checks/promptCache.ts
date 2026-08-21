/**
 * Is the prompt cache actually switched on?
 *
 * An agent turn re-sends everything that came before it — the system prompt,
 * every tool definition, the brief, and every tool result so far. That is how
 * the API works and it is not avoidable. Paying full input rate for it is, and
 * for a month this app did: `cache_control` appeared nowhere, while the ledger
 * dutifully recorded `cacheReadTokens: 0` on every row and the pricing table
 * kept a cache multiplier that nothing ever multiplied.
 *
 * The reason that lasted a month is that it is **invisible**. Nothing breaks.
 * No test fails. Every answer is correct. The only symptom is the bill, and by
 * the time the bill arrives nobody can say which run spent it. So the fix needs
 * a check that fails the moment somebody drops the breakpoints — because the
 * next person to tidy that file will not know they were load-bearing.
 *
 * It drives the real `runAgentLoop` against a fake Anthropic on localhost and
 * reads what actually went over the wire. Asserting on the request body rather
 * than on the helper, because a perfectly correct `withCacheBreakpoints()` that
 * nothing calls is exactly the bug that was here.
 *
 * The negatives matter as much as the positives:
 *   - **At most four breakpoints.** The API rejects a fifth, and it rejects it
 *     at request time — so a fifth added carelessly is not a slightly worse
 *     bill, it is every agent in the company failing at once.
 *   - **Two inside the conversation, not one.** Marking only the newest turn
 *     writes a cache entry every turn and never reads one: the expensive half
 *     of caching with none of the saving.
 *   - **Nothing marked is left on the checkpoint.** `messages` is what gets
 *     saved and resumed, and a breakpoint frozen wherever the last process
 *     happened to stop would land in the wrong place on the next run.
 *
 * No API key and no network — the fake serves both turns.
 *   npx tsx checks/promptCache.ts
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

/** Every request body the loop sent, in order. */
const sent: Record<string, any>[] = [];

function reply(turn: number) {
  // Turn one asks for a tool; turn two, having seen the result, finishes.
  const content =
    turn === 0
      ? [
          { type: "text", text: "Looking that up." },
          { type: "tool_use", id: "toolu_check_1", name: "look_up", input: { what: "anything" } },
        ]
      : [{ type: "text", text: "Done." }];
  return {
    id: `msg_check_${turn}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content,
    stop_reason: turn === 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: turn === 0 ? 0 : 90,
      cache_creation_input_tokens: turn === 0 ? 90 : 5,
    },
  };
}

function fakeAnthropic(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        sent.push(JSON.parse(body || "{}"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply(sent.length - 1)));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** Every cache_control in a request, wherever it is. Counted the way the API counts it. */
function breakpoints(body: Record<string, any>): number {
  let total = 0;
  for (const tool of body.tools ?? []) if (tool.cache_control) total += 1;
  for (const block of Array.isArray(body.system) ? body.system : []) if (block.cache_control) total += 1;
  for (const message of body.messages ?? []) {
    if (typeof message.content === "string") continue;
    for (const block of message.content ?? []) if (block.cache_control) total += 1;
  }
  return total;
}

/** Which messages carry a breakpoint, by index. */
function markedMessages(body: Record<string, any>): number[] {
  const at: number[] = [];
  (body.messages ?? []).forEach((message: any, index: number) => {
    if (typeof message.content === "string") return;
    if ((message.content ?? []).some((block: any) => block.cache_control)) at.push(index);
  });
  return at;
}

async function main() {
  const { server, url } = await fakeAnthropic();
  // Set before the SDK is imported: it reads its environment at construction,
  // and a value assigned after the import has happened is one nothing sees.
  process.env.ANTHROPIC_BASE_URL = url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";

  const { runAgentLoop, clipToolResult, TOOL_RESULT_MAX_CHARS } = await import("../src/lib/claudeAgent.js");
  const { prisma } = await import("../src/lib/prisma.js");

  let savedMessages: unknown[] = [];
  const result = await runAgentLoop({
    purpose: "check.promptCache",
    // Long enough to be worth caching, which is the case that matters.
    system: "You are a check. ".repeat(400),
    prompt: "Look something up, then say you are done.",
    tools: [
      {
        name: "look_up",
        description: "Looks something up.",
        inputSchema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
        run: async () => ({ content: "It is a Tuesday." }),
      },
      {
        name: "put_down",
        description: "Writes something down.",
        inputSchema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
        run: async () => ({ content: "Written." }),
      },
    ],
    effort: "medium",
    onCheckpoint: async (state) => {
      savedMessages = state.messages;
    },
  });

  server.close();

  check("the loop ran both turns", sent.length === 2, `sent ${sent.length}`);
  check("it finished", result.stoppedBecause === "finished", result.stoppedBecause);

  const [first, second] = sent;

  // --- The tools ------------------------------------------------------------
  const toolMarks = (first.tools ?? []).filter((tool: any) => tool.cache_control).length;
  check("the tool definitions carry exactly one breakpoint", toolMarks === 1, `${toolMarks}`);
  check(
    "it is on the last tool, so it caches all of them",
    Boolean(first.tools?.[first.tools.length - 1]?.cache_control),
    "a breakpoint above the last tool leaves the ones below it uncached",
  );

  // --- The system prompt ----------------------------------------------------
  check("the system prompt is sent as blocks, not a bare string", Array.isArray(first.system), typeof first.system);
  check("the system prompt is cached", Boolean((first.system ?? []).at(-1)?.cache_control), "system carries no cache_control");

  // --- The conversation -----------------------------------------------------
  check("turn one marks the brief", markedMessages(first).includes(0), JSON.stringify(markedMessages(first)));
  check(
    "turn two marks two turns, not one",
    markedMessages(second).length === 2,
    `marked ${JSON.stringify(markedMessages(second))} — one alone writes the cache every turn and never reads it`,
  );
  check(
    "and they are the two most recent user turns",
    JSON.stringify(markedMessages(second)) === JSON.stringify([0, 2]),
    JSON.stringify(markedMessages(second)),
  );

  // --- The API's own limit --------------------------------------------------
  check("turn one is inside the four-breakpoint limit", breakpoints(first) <= 4, `${breakpoints(first)}`);
  check("turn two is inside it too", breakpoints(second) <= 4, `${breakpoints(second)}`);

  // --- The checkpoint -------------------------------------------------------
  const saved = JSON.stringify(savedMessages);
  check("nothing marked is written to the checkpoint", !saved.includes("cache_control"), "a saved breakpoint resumes in the wrong place");

  // --- The ledger -----------------------------------------------------------
  const row = await prisma.llmCall.findFirst({ where: { purpose: "check.promptCache" }, orderBy: { createdAt: "desc" } });
  check("the run was recorded with its cache reads", (row?.cacheReadTokens ?? 0) === 90, `cacheReadTokens=${row?.cacheReadTokens}`);
  check("and its cache writes", (row?.cacheCreationTokens ?? 0) === 95, `cacheCreationTokens=${row?.cacheCreationTokens}`);

  // --- What a tool is allowed to put into the conversation -------------------
  //
  // Second only to caching as a way to waste a run: a tool result is not paid
  // for once, it is re-sent with every turn after it.
  const long = clipToolResult("x".repeat(TOOL_RESULT_MAX_CHARS * 3));
  check("an oversized tool result is cut", long.length < TOOL_RESULT_MAX_CHARS * 1.2, `${long.length} chars`);
  check(
    "and says it was cut, rather than looking complete",
    long.includes("Cut off here"),
    "a silent slice hands the model half a record that reads as all of it",
  );
  check("a short one is left alone", clipToolResult("fine") === "fine");

  // --- The one-shot writers -------------------------------------------------
  //
  // Half the spend in this app is not the agent loop at all: it is fifty
  // writers each asking one question against a long system prompt — a
  // playbook, an audit rubric, a brand brief. Those repeat within a run, so
  // the prompt is worth caching there too. Gated on length, because below
  // Anthropic's floor a marked prompt is not cached and a write costs a
  // quarter more than sending it plainly.
  const { callClaude } = await import("../src/lib/claude.js");
  const oneShot = await fakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = oneShot.url;
  sent.length = 0;

  const answer = () => ({
    id: "msg_check_oneshot",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 90 },
  });
  oneShot.server.removeAllListeners("request");
  oneShot.server.on("request", (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      sent.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer()));
    });
  });

  const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
  await callClaude<{ ok: boolean }>({
    purpose: "check.promptCache.long",
    system: "A playbook paragraph. ".repeat(400),
    prompt: () => "Answer.",
    schema,
  });
  await callClaude<{ ok: boolean }>({
    purpose: "check.promptCache.short",
    system: "Be brief.",
    prompt: () => "Answer.",
    schema,
  });
  oneShot.server.close();

  const [longPrompt, shortPrompt] = sent;
  check("a long writer prompt is cached", Array.isArray(longPrompt?.system) && Boolean(longPrompt.system[0].cache_control), JSON.stringify(longPrompt?.system)?.slice(0, 120));
  check(
    "a short one is left as a plain string",
    typeof shortPrompt?.system === "string",
    "marking a prompt under the 1,024-token floor pays the write premium for a cache that is never made",
  );

  await prisma.llmCall.deleteMany({ where: { purpose: { startsWith: "check.promptCache" } } });
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
