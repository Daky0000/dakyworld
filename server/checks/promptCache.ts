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

/**
 * The messages as the API's prefix match sees them. Breakpoints do not count,
 * and nor does the difference between a bare string and a single text block —
 * the brief goes out as one when a breakpoint is on it and as the other when
 * not, and the API reads both as the same content.
 */
function unmarked(messages: any[]): string {
  return JSON.stringify(
    messages.map((message) => (typeof message.content === "string" ? { ...message, content: [{ type: "text", text: message.content }] } : message)),
    (key, value) => (key === "cache_control" ? undefined : value),
  );
}

/**
 * A fake Anthropic that answers from a script and keeps every request with its
 * headers, alongside whatever the run said between them — so a request can be
 * matched to the trim that was announced just before it.
 */
function scriptedAnthropic(
  events: ({ kind: "request"; body: Record<string, any>; beta: string } | { kind: "note"; text: string })[],
  answer: (turn: number) => Record<string, unknown>,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    let turn = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        events.push({ kind: "request", body: JSON.parse(body || "{}"), beta: String(req.headers["anthropic-beta"] ?? "") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer(turn)));
        turn += 1;
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  const { server, url } = await fakeAnthropic();
  // Set before the SDK is imported: it reads its environment at construction,
  // and a value assigned after the import has happened is one nothing sees.
  process.env.ANTHROPIC_BASE_URL = url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";

  const { runAgentLoop, clipToolResult, TOOL_RESULT_MAX_CHARS } = await import("../src/lib/claudeAgent.js");
  const { prisma } = await import("../src/lib/prisma.js");
  // Every ledger row this file writes is created after this and carries a
  // `check.promptCache` purpose, and only those are read or deleted.
  const since = new Date();

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
  //
  // One row per turn, so the run's figures are the sum of its rows — and the
  // per-turn split is what makes a broken cache visible at all: turn one writes,
  // turn two reads, and a run that only ever writes is the failure this file is
  // here to catch.
  const rows = await prisma.llmCall.findMany({ where: { purpose: "check.promptCache", createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  check("each turn has its own ledger row", rows.length === 2, `${rows.length} rows`);
  const reads = rows.reduce((sum, row) => sum + row.cacheReadTokens, 0);
  const writes = rows.reduce((sum, row) => sum + row.cacheCreationTokens, 0);
  check("the run's cache reads add up", reads === 90, `cacheReadTokens=${reads}`);
  check("and its cache writes", writes === 95, `cacheCreationTokens=${writes}`);
  check("the second turn is the one that read", rows[1]?.cacheReadTokens === 90 && rows[0]?.cacheReadTokens === 0, rows.map((row) => row.cacheReadTokens).join(", "));

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

  // --- The turn the model paused half-way through ---------------------------
  //
  // `pause_turn` pushes a lone assistant turn, which puts the user/assistant
  // alternation out by one and can leave a **thinking block last**. The API
  // refuses to let a breakpoint sit on one, and it refuses at request time —
  // so getting this wrong is not a slightly worse bill, it is the agent
  // failing outright on its next turn.
  const paused = await fakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = paused.url;
  sent.length = 0;

  let pausedTurn = 0;
  paused.server.removeAllListeners("request");
  paused.server.on("request", (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      sent.push(JSON.parse(body || "{}"));
      const first = pausedTurn === 0;
      pausedTurn += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_check_paused",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: first
            ? [
                { type: "text", text: "Half way." },
                { type: "thinking", thinking: "Still working it out.", signature: "sig_check" },
              ]
            : [{ type: "text", text: "Done." }],
          stop_reason: first ? "pause_turn" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      );
    });
  });

  await runAgentLoop({
    purpose: "check.promptCache.paused",
    system: "You are a check. ".repeat(400),
    prompt: "Pause, then finish.",
    tools: [
      {
        name: "look_up",
        description: "Looks something up.",
        inputSchema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
        run: async () => ({ content: "unused" }),
      },
    ],
    effort: "medium",
  });
  paused.server.close();

  const afterPause = sent[1];
  const assistantTurn = afterPause?.messages?.[1];
  const thinkingBlock = (assistantTurn?.content ?? []).find((block: any) => block.type === "thinking");
  check("the paused turn is re-sent", Boolean(thinkingBlock), "no thinking block came back round");
  check("no breakpoint is put on a thinking block", !thinkingBlock?.cache_control, "the API rejects the whole request for this");
  check(
    "it lands on the last block that can carry one instead",
    Boolean((assistantTurn?.content ?? []).find((block: any) => block.type === "text")?.cache_control),
    "skipping the thinking block must not mean skipping the turn",
  );

  // --- A longer run: does the prefix actually hold still? --------------------
  //
  // Breakpoints in the right places are worth nothing if the text in front of
  // them changes. The cache is an exact prefix match, and the conversation is
  // trimmed in place as it grows: the shortening of older answers used to run
  // on every turn, rewriting the very user turn the previous request had put a
  // breakpoint on, so from about the fourth turn every request missed and paid
  // the write premium for the conversation instead of the read rate. Eight
  // turns of two 2,000-character answers each is enough to cross the soft
  // ceiling once, which is the point: between trims, each request must send
  // exactly what the last one sent, plus the new turn.
  const rollingTurns = 8;
  const longAnswer = (what: unknown) => `${String(what)}: ${"The record says nothing new here. ".repeat(60)}`.slice(0, 2_000);
  const rollingTools = [
    {
      name: "look_up",
      description: "Looks something up.",
      inputSchema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
      run: async (input: Record<string, unknown>) => ({ content: longAnswer(input.what) }),
    },
  ];
  const turnOf = (thinking: boolean) => (turn: number) => ({
    id: `msg_rolling_${turn}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content:
      turn < rollingTurns - 1
        ? [
            ...(thinking ? [{ type: "thinking", thinking: `Turn ${turn}: which two records next.`, signature: `sig_rolling_${turn}` }] : []),
            { type: "text", text: `Turn ${turn}.` },
            { type: "tool_use", id: `toolu_rolling_${turn}_a`, name: "look_up", input: { what: `a${turn}` } },
            { type: "tool_use", id: `toolu_rolling_${turn}_b`, name: "look_up", input: { what: `b${turn}` } },
          ]
        : [{ type: "text", text: "Done." }],
    stop_reason: turn < rollingTurns - 1 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });

  type Event = { kind: "request"; body: Record<string, any>; beta: string } | { kind: "note"; text: string };
  async function rollingRun(purpose: string, thinking: boolean) {
    const events: Event[] = [];
    const stub = await scriptedAnthropic(events, turnOf(thinking));
    process.env.ANTHROPIC_BASE_URL = stub.url;
    let saved: unknown[] = [];
    const result = await runAgentLoop({
      purpose,
      system: "You are a check. ".repeat(400),
      prompt: "Look up two records a turn until told to stop, then say you are done.",
      tools: rollingTools,
      effort: "medium",
      onServing: async (text) => {
        events.push({ kind: "note", text });
      },
      onCheckpoint: async (state) => {
        saved = state.messages;
      },
    });
    stub.server.close();

    // Each request, with whether a trim was announced since the one before.
    const requests: { body: Record<string, any>; beta: string; trimmed: boolean }[] = [];
    let trimmedSince = false;
    for (const event of events) {
      if (event.kind === "note") {
        if (/^(Shortened|Let go of) \d+ older tool answer/.test(event.text)) trimmedSince = true;
        continue;
      }
      requests.push({ body: event.body, beta: event.beta, trimmed: trimmedSince });
      trimmedSince = false;
    }
    return { result, requests, saved };
  }

  {
    const { result, requests, saved } = await rollingRun("check.promptCache.rolling", false);
    check("the long run took all eight turns", requests.length === rollingTurns && result.stoppedBecause === "finished", `${requests.length} / ${result.stoppedBecause}`);

    const trims = requests.map((request, index) => (request.trimmed ? index : -1)).filter((index) => index >= 0);
    check("it crossed the soft ceiling, so there was a trim to survive", trims.length >= 1, "none — this scenario proves nothing without one");
    check(
      "a trim happens at most once in any three consecutive turns",
      trims.every((at, i) => i === 0 || at - trims[i - 1] >= 3),
      `trims before requests ${trims.map((at) => at + 1).join(", ")}`,
    );

    let held = 0;
    const moved: string[] = [];
    for (let n = 1; n < requests.length; n += 1) {
      const previous = requests[n - 1].body.messages ?? [];
      const current = requests[n].body.messages ?? [];
      // Request n-1's newest breakpoint is on its last message, so everything
      // up to and including it is the prefix this request should read back.
      const newest = Math.max(...markedMessages(requests[n - 1].body));
      check(`request ${n + 1} reads where request ${n} wrote`, markedMessages(requests[n].body).includes(newest), JSON.stringify(markedMessages(requests[n].body)));
      if (requests[n].trimmed) continue;
      if (unmarked(current.slice(0, newest + 1)) === unmarked(previous.slice(0, newest + 1))) held += 1;
      else moved.push(String(n + 1));
    }
    check(
      "between trims, every request re-sends exactly the prefix the last one cached",
      moved.length === 0 && held === rollingTurns - 1 - trims.length,
      `prefix moved before request(s) ${moved.join(", ")}; ${held} held`,
    );
    check("never more than four breakpoints", requests.every((request) => breakpoints(request.body) <= 4), requests.map((request) => breakpoints(request.body)).join(", "));
    check("and none of them reach the checkpoint", !JSON.stringify(saved).includes("cache_control"));
  }

  // --- The same run, with Claude thinking on every turn ---------------------
  //
  // Claude's newer models sign each thinking block against everything sent
  // before it, and a rewrite above one invalidates that reasoning and, on an
  // account created since 31 Aug 2026, fails the request outright. The loop's answer is
  // to keep the conversation append-only once Claude has thought in it — so
  // the same eight turns, over the same ceiling, must never rewrite anything,
  // and the decision not to paper over edits with `drop_block` is pinned here
  // so that changing it is a deliberate act rather than a side effect.
  {
    const { result, requests, saved } = await rollingRun("check.promptCache.thinking", true);
    check("the thinking run took all eight turns", requests.length === rollingTurns && result.stoppedBecause === "finished", `${requests.length} / ${result.stoppedBecause}`);
    const last = requests.at(-1)?.body.messages ?? [];
    check("it went past the soft ceiling as well", JSON.stringify(last).length > 24_000, String(JSON.stringify(last).length));
    check("and nothing was trimmed", requests.every((request) => !request.trimmed));

    const rewritten: string[] = [];
    for (let n = 1; n < requests.length; n += 1) {
      const previous = requests[n - 1].body.messages ?? [];
      const current = requests[n].body.messages ?? [];
      if (unmarked(current.slice(0, previous.length)) !== unmarked(previous)) rewritten.push(String(n + 1));
    }
    check("every request is the last one plus the new turn, nothing rewritten", rewritten.length === 0, `rewritten before request(s) ${rewritten.join(", ")}`);
    const signatures = last.flatMap((message: any) =>
      Array.isArray(message.content) ? message.content.filter((block: any) => block.type === "thinking").map((block: any) => block.signature) : [],
    );
    check(
      "every thinking block goes back with its own signature",
      JSON.stringify(signatures) === JSON.stringify(Array.from({ length: rollingTurns - 1 }, (_, turn) => `sig_rolling_${turn}`)),
      signatures.join(", "),
    );
    check(
      "thinking is asked for with no block_binding override",
      requests.every((request) => request.body.thinking !== undefined && request.body.thinking.block_binding === undefined),
      JSON.stringify(requests[0]?.body.thinking),
    );
    check("and no thinking-binding beta header", requests.every((request) => !request.beta.includes("thinking-binding")), requests[0]?.beta);
    check("the checkpoint carries the reasoning but no breakpoint", JSON.stringify(saved).includes("sig_rolling_0") && !JSON.stringify(saved).includes("cache_control"));
  }

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

  await prisma.llmCall.deleteMany({ where: { purpose: { startsWith: "check.promptCache" }, createdAt: { gte: since } } });
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
