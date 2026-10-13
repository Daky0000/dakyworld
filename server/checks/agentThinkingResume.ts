/**
 * Does a resumed Claude run keep its reasoning valid?
 *
 * Claude's newer models (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5) sign each
 * thinking block against everything sent before it — the system prompt, the
 * set of tools and every earlier message — and when the block comes back the
 * API recomputes that record from the request and requires a match. On an
 * account created since 31 Aug 2026 a mismatch is a 400, and a 400 in the
 * agent loop hands the run to another paid vendor or fails it.
 *
 * The loop's own trims already stop at the last thinking block. What this
 * covers is everything *around* the loop that rebuilt the prefix between two
 * runs of one conversation:
 *
 *  1. **A new memory.** The claim calls `recall()` and `systemPrompt()` again,
 *     so a `remember` in the first run changed the system prompt of the second.
 *  2. **A spent consult.** `workflowAvailability()` drops `consult` once the
 *     allowance is gone, which changes the tool set and the prompt.
 *  3. **A checkpoint past 3 MB.** `trimToFit` rewrote tool results above a
 *     thinking block in the stored copy.
 *  4. **A checkpoint written before the prefix was kept** has nothing to reuse,
 *     so the reasoning is stripped once, deliberately, and said so.
 *  5. **The backstop**: a binding 400 the runner did not prevent is stripped
 *     and retried once on Claude rather than handed to another vendor.
 *
 * Against a fake Anthropic that enforces the binding the way the API does:
 * every thinking block it hands out is signed against a digest of the
 * canonical prefix (cache markers dropped, keys sorted, tools as a name-keyed
 * set), and a request replaying a block whose prefix no longer matches gets
 * the API's own 400. The negatives matter as much: a conversation with no
 * thinking in it must resume on the *fresh* prompt (nothing to protect, and a
 * new memory is worth having), and a strip must happen once, not on every turn.
 *
 * A database and a local fake. No API key and no network.
 *   npx tsx checks/agentThinkingResume.ts
 */
import { createHash } from "node:crypto";
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

// --- The binding, as the API applies it ---------------------------------------

/** Sorted keys, no cache markers, a bare string read as one text block. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === "cache_control") continue;
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function asBlocks(content: unknown): unknown[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : ((content as unknown[]) ?? []);
}

function digest(system: unknown, tools: unknown, messages: { role: string; content: unknown }[]): string {
  const prefix = {
    system: asBlocks(system),
    tools: [...((tools as { name: string }[]) ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    messages: messages.map((message) => ({ role: message.role, content: asBlocks(message.content) })),
  };
  return createHash("sha256").update(JSON.stringify(canonical(prefix))).digest("hex").slice(0, 16);
}

const isThinking = (block: { type?: string }) => block?.type === "thinking" || block?.type === "redacted_thinking";

/** signature → the prefix it was produced against. */
const bound = new Map<string, string>();
let minted = 0;

/**
 * The 400 the API returns for the first replayed block whose prefix moved, or
 * null when every block still matches.
 */
function bindingError(body: Record<string, any>): string | null {
  const messages: { role: string; content: unknown }[] = body.messages ?? [];
  for (let i = 0; i < messages.length; i += 1) {
    const blocks = asBlocks(messages[i].content) as { type?: string; signature?: string }[];
    for (let j = 0; j < blocks.length; j += 1) {
      if (!isThinking(blocks[j])) continue;
      // Everything before the block: the earlier messages, and the blocks ahead
      // of it in its own turn when there are any.
      const before = j === 0 ? messages.slice(0, i) : [...messages.slice(0, i), { role: messages[i].role, content: blocks.slice(0, j) }];
      const expected = bound.get(String(blocks[j].signature));
      if (expected !== digest(body.system, body.tools, before)) {
        return (
          `messages.${i}.content.${j}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. ` +
          "Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \"drop_block\". " +
          "That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header."
        );
      }
    }
  }
  return null;
}

/** A thinking block signed against this request's whole conversation, as the API mints one. */
function think(body: Record<string, any>, text: string) {
  minted += 1;
  const signature = `sig_check_${minted}`;
  bound.set(signature, digest(body.system, body.tools, body.messages ?? []));
  return { type: "thinking", thinking: text, signature };
}

// --- The fake ---------------------------------------------------------------------

type Answer = { status: number; payload: unknown };
type Seen = { body: Record<string, any>; loop: boolean; rejected: string | null };

const seen: Seen[] = [];
let script: (turn: number, body: Record<string, any>) => Answer = () => message("end_turn", [{ type: "text", text: "Done." }]);
let loopTurns = 0;

function message(stop: string, content: unknown[], model = "claude-sonnet-5-5"): Answer {
  return {
    status: 200,
    payload: {
      id: `msg_thinking_${seen.length}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}
const rateLimited: Answer = { status: 429, payload: { type: "error", error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit." } } };
const done = (body: Record<string, any>) => message("end_turn", [{ type: "text", text: "Done." }], body.model);
const call = (body: Record<string, any>, reasoning: string, name: string, input: Record<string, unknown>) =>
  message("tool_use", [think(body, reasoning), { type: "text", text: `Calling ${name}.` }, { type: "tool_use", id: `toolu_thinking_${seen.length}`, name, input }], body.model);

function fakeAnthropic(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body: Record<string, any> = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          body = {};
        }
        // The loop's own turns carry the tools; a consult's colleague and any
        // other one-shot writer do not, and gets a plain structured answer.
        const loop = Array.isArray(body.tools) && body.tools.length > 0;
        const rejected = bindingError(body);
        seen.push({ body, loop, rejected });
        let answer: Answer;
        if (rejected) answer = { status: 400, payload: { type: "error", error: { type: "invalid_request_error", message: rejected } } };
        else if (loop) answer = script(loopTurns++, body);
        else answer = message("end_turn", [{ type: "text", text: JSON.stringify({ answer: "Yes, lead with it.", confident: true, wouldNeed: "" }) }], body.model);
        // The SDK would otherwise retry a 429 itself, and each retry is a turn
        // the script did not plan.
        res.writeHead(answer.status, { "content-type": "application/json", "x-should-retry": "false" });
        res.end(JSON.stringify(answer.payload));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

const AGENT_KEY = "check.thinkingResume.agent";
const COLLEAGUE_KEY = "check.thinkingResume.colleague";
const PURPOSE = "check.thinkingResume";

const thinkingIn = (body: Record<string, any>) =>
  (body.messages ?? []).flatMap((m: any) => asBlocks(m.content).filter((block: any) => isThinking(block)).map((block: any) => block.signature as string));
const systemText = (body: Record<string, any>) => asBlocks(body.system).map((block: any) => block.text).join("");
const toolNames = (body: Record<string, any>) => (body.tools ?? []).map((tool: any) => tool.name).sort().join(",");

async function main() {
  const { prisma } = await import("../src/lib/prisma.js");
  const { SETTING, clearSettingsCache, setSetting } = await import("../src/lib/settings.js");
  const { runAgentLoop } = await import("../src/lib/claudeAgent.js");
  const { runTask } = await import("../src/services/agents/runner.js");
  const { trimToFit } = await import("../src/services/agents/checkpoint.js");

  const since = new Date();
  const SETTINGS = [
    SETTING.ANTHROPIC_KEY,
    SETTING.ANTHROPIC_MODEL,
    SETTING.ANTHROPIC_MODEL_ECONOMY,
    SETTING.OPENAI_KEY,
    SETTING.GEMINI_KEY,
    SETTING.NVIDIA_KEY,
    SETTING.NVIDIA_FREE_MODELS,
    SETTING.PERPLEXITY_KEY,
    SETTING.MODEL_ROUTES,
    SETTING.MODEL_TIER_MODELS,
    SETTING.CONSULT_PRIORITY_LIMITS,
  ];
  const ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "NVIDIA_API_KEY", "PERPLEXITY_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_MODEL_ECONOMY"];
  const BASES = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GEMINI_BASE_URL", "NVIDIA_BASE_URL", "PERPLEXITY_BASE_URL"];
  const savedRows = await prisma.appSetting.findMany({ where: { key: { in: SETTINGS } } });
  const savedEnv = Object.fromEntries([...ENV, ...BASES].map((name) => [name, process.env[name]]));

  const KEYS = [AGENT_KEY, COLLEAGUE_KEY];
  const reset = async () => {
    await prisma.llmCall.deleteMany({ where: { createdAt: { gte: since }, OR: [{ purpose: { startsWith: PURPOSE } }, { agentKey: { in: KEYS } }, { purpose: { startsWith: `consult.${COLLEAGUE_KEY}` } }] } });
    await prisma.toolCall.deleteMany({ where: { agentKey: { in: KEYS } } });
    await prisma.agentTaskStep.deleteMany({ where: { task: { agentKey: { in: KEYS } } } });
    await prisma.agentTaskTransition.deleteMany({ where: { task: { agentKey: { in: KEYS } } } });
    await prisma.agentTaskCheckpoint.deleteMany({ where: { task: { agentKey: { in: KEYS } } } });
    await prisma.agentMemory.deleteMany({ where: { agentKey: { in: KEYS } } });
    await prisma.agentTask.deleteMany({ where: { agentKey: { in: KEYS } } });
    await prisma.agent.deleteMany({ where: { key: { in: KEYS } } });
  };
  const restore = async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: SETTINGS } } });
    for (const row of savedRows) await prisma.appSetting.create({ data: { key: row.key, value: row.value, secret: row.secret } });
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    clearSettingsCache();
  };

  // Claude alone, pointed at the fake: every vendor off in the database and the
  // environment, so nothing here can reach a real one, and no free models, so
  // a turn Claude refuses has nowhere quiet to go.
  await prisma.appSetting.deleteMany({ where: { key: { in: SETTINGS } } });
  for (const name of ENV) delete process.env[name];
  const fake = await fakeAnthropic();
  for (const name of BASES) process.env[name] = fake.url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
  await setSetting(SETTING.NVIDIA_FREE_MODELS, JSON.stringify({ agent: [], routing: [] }));
  // One consult on a priority-3 task, so a single one spends the allowance.
  await setSetting(SETTING.CONSULT_PRIORITY_LIMITS, JSON.stringify({ 3: 1 }));
  clearSettingsCache();

  const begin = (next: typeof script) => {
    seen.length = 0;
    loopTurns = 0;
    script = next;
  };

  /**
   * Two claims of one task: the first thinks, calls a tool and is then paused
   * by a rate limit; the second is a fresh `runTask`, exactly what the next
   * tick does. `between` runs in the gap, for the scenario that needs one.
   */
  async function pauseAndResume(title: string, brief: string, first: (body: Record<string, any>) => Answer, between?: (taskId: string) => Promise<void>) {
    const task = await prisma.agentTask.create({ data: { agentKey: AGENT_KEY, title, brief, levelOverride: "COMPLEX", priority: 3 } });
    begin((turn, body) => (turn === 0 ? first(body) : rateLimited));
    const one = await runTask(task.id);
    const firstRun = seen.filter((entry) => entry.loop);
    await between?.(task.id);
    begin((_turn, body) => done(body));
    const two = await runTask(task.id);
    const secondRun = seen.filter((entry) => entry.loop);
    const row = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    const steps = await prisma.agentTaskStep.findMany({ where: { taskId: task.id }, orderBy: { seq: "asc" } });
    return { task, one, two, row, firstRun, secondRun, steps };
  }

  try {
    await reset();
    await prisma.agent.create({
      data: { key: AGENT_KEY, name: "Thinking Check", title: "Thinking Check", tier: "SUB_AGENT", department: "TECHNOLOGY", status: "ACTIVE", mission: "Exists for one test run.", custom: true },
    });
    await prisma.agent.create({
      data: { key: COLLEAGUE_KEY, name: "Thinking Colleague", title: "Colleague", tier: "SUB_AGENT", department: "TECHNOLOGY", status: "ACTIVE", mission: "Answers a consult.", custom: true },
    });

    console.log("\nThe fake refuses an edited prefix, as the API does");
    {
      const body = { system: [{ type: "text", text: "S" }], tools: [{ name: "a", description: "d", input_schema: {} }], messages: [{ role: "user", content: "hi" }] };
      const block = think(body, "r");
      const honest = { ...body, messages: [...body.messages, { role: "assistant", content: [block] }, { role: "user", content: "more" }] };
      check("an honest replay passes", bindingError(honest) === null);
      check("a cache marker is not an edit", bindingError({ ...honest, system: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }] }) === null);
      check("a changed system prompt is refused", bindingError({ ...honest, system: [{ type: "text", text: "S2" }] }) !== null);
      check("a changed tool set is refused", bindingError({ ...honest, tools: [] }) !== null);
      check("a changed earlier message is refused", bindingError({ ...honest, messages: [{ role: "user", content: "hello" }, ...honest.messages.slice(1)] }) !== null);
    }

    console.log("\nResumed after it remembered something");
    let rememberedSystem = "";
    {
      const r = await pauseAndResume("Thinking: remembers, pauses, resumes", "Note one thing about yourself, then finish.", (body) =>
        call(body, "Worth keeping for next time.", "remember", { kind: "LESSON", content: "Check the record before writing anything down.", about: "myself", importance: 3 }),
      );
      const memory = await prisma.agentMemory.findFirst({ where: { agentKey: AGENT_KEY, content: { contains: "Check the record before" } } });
      check("the first run wrote a memory and was paused", Boolean(memory) && r.one.status === "QUEUED", `${Boolean(memory)} / ${r.one.status}`);
      check("and its conversation kept a thinking block", r.firstRun.length >= 1 && thinkingIn(r.secondRun[0]?.body ?? {}).length === 1, String(thinkingIn(r.secondRun[0]?.body ?? {}).length));
      check("the resumed request was not refused", r.secondRun.every((entry) => entry.rejected === null), r.secondRun.map((entry) => entry.rejected?.slice(0, 120)).join(" | "));
      check("the task finished on Claude", r.row.status === "DONE" && r.secondRun.every((entry) => String(entry.body.model).startsWith("claude-")), `${r.row.status} ${r.row.error ?? ""}`);
      check("in one turn, with its reasoning still in the conversation", r.secondRun.length === 1 && thinkingIn(r.secondRun[0].body).length === 1, `${r.secondRun.length} turn(s)`);
      check(
        "sending the system prompt and tools the conversation started with",
        systemText(r.secondRun[0]?.body ?? {}) === systemText(r.firstRun[0].body) && toolNames(r.secondRun[0]?.body ?? {}) === toolNames(r.firstRun[0].body),
      );
      check("still with a breakpoint on the last tool and on the system prompt", Boolean(r.secondRun[0]?.body.tools?.at(-1)?.cache_control) && Boolean(r.secondRun[0]?.body.system?.at(-1)?.cache_control));
      // The kept tools are the stored ones, so the marker has to be put back on
      // them rather than travel in from the checkpoint — and never a fifth.
      const marks = JSON.stringify(r.secondRun[0]?.body ?? {}).split('"cache_control"').length - 1;
      check("and four breakpoints at most, one of them on the tools only", marks <= 4 && (r.secondRun[0]?.body.tools ?? []).filter((tool: any) => tool.cache_control).length === 1, String(marks));
      rememberedSystem = systemText(r.firstRun[0].body);
    }

    console.log("\nA conversation with no reasoning in it resumes on the fresh prompt");
    {
      const r = await pauseAndResume("Thinking: no reasoning to protect", "Note another thing, then finish.", (body) =>
        message("tool_use", [{ type: "text", text: "Writing it down." }, { type: "tool_use", id: `toolu_plain_${seen.length}`, name: "remember", input: { kind: "LESSON", content: "Say what changed, not what stayed.", about: "myself", importance: 3 } }], body.model),
      );
      check("it finished", r.row.status === "DONE", `${r.row.status} ${r.row.error ?? ""}`);
      check("and the second claim's prompt carries the memory the first one wrote", systemText(r.secondRun[0]?.body ?? {}).includes("Say what changed, not what stayed."), "the prompt was frozen with nothing to protect");
      check("and the memory from the scenario before it", systemText(r.secondRun[0]?.body ?? {}).includes("Check the record before") && !rememberedSystem.includes("Say what changed"));
    }

    console.log("\nResumed after the consult allowance was spent");
    {
      const r = await pauseAndResume("Thinking: consults, pauses, resumes", "Ask the colleague one question, then finish.", (body) =>
        call(body, "A colleague should judge this.", "consult", { agentKey: COLLEAGUE_KEY, question: "Is a certificate finding worth leading an email on?", priority: "high" }),
      );
      const consulted = r.steps.some((s) => s.kind === "CONSULTED" && s.ok);
      check("the first run spent its one consult and was paused", consulted && r.one.status === "QUEUED", `${consulted} / ${r.one.status}`);
      check("the first run offered consult", toolNames(r.firstRun[0].body).split(",").includes("consult"));
      check("the resumed request was not refused", r.secondRun.every((entry) => entry.rejected === null), r.secondRun.map((entry) => entry.rejected?.slice(0, 120)).join(" | "));
      check("the task finished on Claude, with its reasoning", r.row.status === "DONE" && r.secondRun.length === 1 && thinkingIn(r.secondRun[0].body).length === 1, `${r.row.status} ${r.row.error ?? ""}`);
      check("the tool set did not change under the conversation", toolNames(r.secondRun[0]?.body ?? {}) === toolNames(r.firstRun[0].body), toolNames(r.secondRun[0]?.body ?? {}));
    }

    console.log("\nResumed from a checkpoint past 3 MB");
    {
      // The brief alone is past the ceiling, so every save has to decide what
      // to do about it; two thinking turns put a tool result above a block.
      const big = `${"A long brief that keeps going. ".repeat(105_000)}`;
      let turn = 0;
      const task = await prisma.agentTask.create({ data: { agentKey: AGENT_KEY, title: "Thinking: a checkpoint past 3 MB", brief: big, levelOverride: "COMPLEX", priority: 3 } });
      begin((_t, body) => {
        turn += 1;
        if (turn === 1) return call(body, "Who does this?", "findAgent", { need: "write a cold email" });
        if (turn === 2) return call(body, "And who checks it?", "findAgent", { need: "check a website" });
        return rateLimited;
      });
      const one = await runTask(task.id);
      const saved = await prisma.agentTaskCheckpoint.findUniqueOrThrow({ where: { taskId: task.id } });
      const savedJson = JSON.stringify(saved.messages);
      check("the conversation is past the checkpoint ceiling", savedJson.length > 3_000_000 && one.status === "QUEUED", `${savedJson.length} / ${one.status}`);
      check("the saved copy did not rewrite a tool result above a thinking block", !savedJson.includes("trimmed to keep the run's checkpoint small"));
      begin((_t, body) => done(body));
      await runTask(task.id);
      const row = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
      const second = seen.filter((entry) => entry.loop);
      check("the resumed request was not refused", second.every((entry) => entry.rejected === null), second.map((entry) => entry.rejected?.slice(0, 120)).join(" | "));
      check("the task finished on Claude, with both blocks", row.status === "DONE" && thinkingIn(second[0]?.body ?? {}).length === 2, `${row.status} ${row.error ?? ""}`);

      // The unit half: without a thinking block, trimming is as it was.
      const plain = [
        { role: "user", content: big },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "an answer" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "x", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "the newest answer" }] },
      ];
      check("a conversation with no thinking in it is still trimmed", JSON.stringify(trimToFit(plain as never)).includes("trimmed to keep"));

      // Above, at and below the boundary: a result before the thinking turn,
      // one after it that the model has read, and the newest it has not.
      const answer = (id: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `answer ${id}` }] });
      const use = (id: string, thinking: boolean) => ({
        role: "assistant",
        content: [...(thinking ? [{ type: "thinking", thinking: "r", signature: "s" }] : []), { type: "tool_use", id, name: "x", input: {} }],
      });
      const mixed = [{ role: "user", content: big }, use("a", false), answer("a"), use("b", true), answer("b"), use("c", false), answer("c")];
      const kept = trimToFit(mixed as never) as unknown as typeof mixed;
      const results = kept.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result").map((b: any) => String(b.content)) : []));
      check("nothing above the last thinking block is trimmed", JSON.stringify(kept.slice(0, 4)) === JSON.stringify(mixed.slice(0, 4)), results.join(" | "));
      check("a read answer below it still is", results[1].startsWith("[This result was trimmed"), results[1]);
      check("and the newest, unread answer never is", results[2] === "answer c", results[2]);
    }

    console.log("\nA checkpoint from before the prefix was kept");
    {
      const r = await pauseAndResume(
        "Thinking: an older checkpoint",
        "Note a third thing, then finish.",
        (body) => call(body, "Keep this.", "remember", { kind: "LESSON", content: "Name the record a finding came from.", about: "myself", importance: 3 }),
        async (taskId) => {
          // What a deploy before this change wrote: tallies, and no prefix.
          const row = await prisma.agentTaskCheckpoint.findUniqueOrThrow({ where: { taskId } });
          const { prefix: _gone, ...rest } = row.counters as Record<string, unknown>;
          await prisma.agentTaskCheckpoint.update({ where: { taskId }, data: { counters: rest as never } });
        },
      );
      check("the resumed request was not refused", r.secondRun.every((entry) => entry.rejected === null), r.secondRun.map((entry) => entry.rejected?.slice(0, 120)).join(" | "));
      check("the task finished on Claude", r.row.status === "DONE", `${r.row.status} ${r.row.error ?? ""}`);
      check("its old reasoning was taken out once, before the first request", r.secondRun.length === 1 && thinkingIn(r.secondRun[0].body).length === 0, `${r.secondRun.length} turn(s)`);
      check("on the fresh prompt, which now carries the memory", systemText(r.secondRun[0]?.body ?? {}).includes("Name the record a finding came from."));
      check("and the timeline says so", r.steps.some((s) => s.kind === "NOTED" && /reasoning/i.test(s.message)), r.steps.map((s) => s.kind).join(","));
    }

    console.log("\nThe backstop: a binding 400 is stripped and retried once, on Claude");
    {
      let saved: { messages: unknown[] } | null = null;
      begin((_t, body) => done(body));
      const forged = {
        iteration: 1,
        messages: [
          { role: "user", content: "Look one thing up." },
          { role: "assistant", content: [{ type: "thinking", thinking: "Bound elsewhere.", signature: "sig_from_another_conversation" }, { type: "tool_use", id: "toolu_forged", name: "look_up", input: { what: "x" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_forged", content: "Nothing new." }] },
        ],
        narration: [],
        pendingAssistant: null,
        pendingResults: null,
        pendingStop: false,
        toolCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        model: null,
      };
      const notes: string[] = [];
      const result = await runAgentLoop({
        purpose: `${PURPOSE}.backstop`,
        system: "You are a check.",
        prompt: "unused",
        tools: [{ name: "look_up", description: "Looks something up.", inputSchema: { type: "object", properties: { what: { type: "string" } } }, run: async () => ({ content: "Nothing." }) }],
        effort: "medium",
        resume: forged as never,
        onServing: async (note) => {
          notes.push(note);
        },
        onCheckpoint: async (state) => {
          saved = state as never;
        },
      });
      const requests = seen.filter((entry) => entry.loop);
      check("the first request was refused for the block", requests.length === 2 && requests[0].rejected !== null, `${requests.length} request(s)`);
      check("the retry went to Claude without any thinking in it", thinkingIn(requests[1]?.body ?? {}).length === 0 && requests[1]?.rejected === null);
      check("and the run finished", result.stoppedBecause === "finished", result.stoppedBecause);
      check("the strip was saved, so no later turn sends the refused block again", saved !== null && !JSON.stringify((saved as unknown as { messages: unknown[] }).messages).includes("sig_from_another_conversation"));
      check("and said on the timeline", notes.some((note) => /reasoning/i.test(note)), notes.join(" | "));

      // A 400 that stripping does not cure is reported as the request's shape,
      // which `retry.ts` asks a person about, never as "could not reach" —
      // which it would pause and replay six times over two hours.
      begin(() => ({ status: 400, payload: { type: "error", error: { type: "invalid_request_error", message: "messages.0: something else is wrong" } } }));
      const thrown = await runAgentLoop({
        purpose: `${PURPOSE}.shape`,
        system: "You are a check.",
        prompt: "Look one thing up.",
        tools: [{ name: "look_up", description: "Looks something up.", inputSchema: { type: "object", properties: {} }, run: async () => ({ content: "Nothing." }) }],
        effort: "medium",
        resume: forged as never,
      }).then(
        () => null,
        (err: Error) => err,
      );
      const shapeRequests = seen.filter((entry) => entry.loop);
      check("an uncurable 400 is tried twice at most, not looped", shapeRequests.length === 2, `${shapeRequests.length} request(s)`);
      check("and named as the request's shape", Boolean(thrown?.message.includes("refused the request shape")) && !thrown?.message.includes("Could not reach"), thrown?.message);
    }
  } catch (err) {
    failures.push(`the run stopped: ${(err as Error).message}`);
    console.log(`\n  THREW  ${(err as Error).stack ?? (err as Error).message}`);
  } finally {
    fake.server.close();
    await reset().catch(() => undefined);
    await restore().catch(() => undefined);
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      for (const name of failures) console.log(`  - ${name}`);
      process.exitCode = 1;
    }
    await prisma.$disconnect();
  }
}

void main().catch(async (err) => {
  console.error(`\n  THREW  ${(err as Error).stack ?? (err as Error).message}`);
  process.exitCode = 1;
  const { prisma } = await import("../src/lib/prisma.js");
  await prisma.$disconnect();
});
