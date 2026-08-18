import Anthropic from "@anthropic-ai/sdk";
import { recordLlmCall } from "./llmLedger.js";
import { AnalystError, analystKey, type Effort } from "./claude.js";
import { costOf, defaultModel, rateFor } from "./claudePricing.js";

/**
 * The agent loop.
 *
 * `claude.ts` answers one question and returns a structured answer — that is
 * the right shape for drafting an email or reading a spreadsheet, and the
 * wrong shape for doing a job. A job is: look at the record, decide, call
 * something, look at what came back, decide again, and stop when it is done or
 * when it needs a person. That is a conversation with tools in it, and it is
 * what this file runs.
 *
 * **Why a manual loop rather than the SDK's tool runner.** Three things have to
 * happen between the model asking for a tool and getting its answer, and none
 * of them fit inside a `run()` function:
 *
 * 1. Every call goes through `invokeTool`, which may **refuse** it, or
 *    **downgrade it to a preview** because the agent's autonomy is too low.
 *    The model has to be told which of the three happened, in words, because
 *    "prepared, not sent" changes what it should do next.
 * 2. Each call is written to the task's timeline *as it happens*, so the
 *    drawer shows progress on a task that is still running rather than a
 *    result at the end.
 * 3. The loop has a hard ceiling on iterations and a running cost total, and
 *    it stops on the agent's own `escalate` rather than on `end_turn` alone.
 *
 * Everything the model may call is supplied by the caller. This file knows
 * nothing about the catalogue, the permission model, or agents — it turns a
 * system prompt plus a set of executable tools into a finished conversation,
 * and reports what it cost.
 */

/** How hard the model works. Passed through to `output_config.effort`. */
export type { Effort };

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Converted from the catalogue's Zod schema. */
  inputSchema: Record<string, unknown>;
  /**
   * Runs it. Returns what the model should be told — including, deliberately,
   * the text of a refusal. A tool that was refused is information the model
   * needs, not an error that should end the run.
   */
  run: (input: Record<string, unknown>) => Promise<AgentToolOutcome>;
}

export interface AgentToolOutcome {
  /** What goes back to the model as the tool result. */
  content: string;
  /** True when the tool failed or was refused — sets `is_error` on the result block. */
  isError?: boolean;
  /** Ends the loop after this result is delivered. Used by `escalate`. */
  stop?: boolean;
}

export interface AgentRunResult {
  /** The last thing the model said. The task summary.  */
  text: string;
  /** Every text block it produced along the way, in order. */
  narration: string[];
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  /** Why the loop ended. */
  stoppedBecause: "finished" | "stopped-by-tool" | "iteration-cap" | "refusal" | "truncated";
}

/**
 * A run is capped rather than trusted to end. An agent that loops calling the
 * same read tool is a real failure mode, and the cost of one is paid per
 * iteration — so the ceiling is low enough that a stuck run is cheap and high
 * enough that real work with a dozen tool calls finishes.
 */
const MAX_ITERATIONS = 16;
/** Under the SDK's HTTP timeout for a non-streaming call. */
const MAX_TOKENS = 16_000;
/** See claude.ts — the same beta, for the same reason. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
let fallbacksAvailable = true;

function rejectedTheBeta(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  const message = err.message.toLowerCase();
  return message.includes("fallback") || message.includes("beta");
}


export interface AgentRunRequest {
  /** Cost attribution: the agent key, so spend per agent is answerable. */
  purpose: string;
  system: string;
  /** The task, as the first thing the agent is told. */
  prompt: string;
  tools: AgentTool[];
  effort?: Effort;
  /** Called as each turn completes, so a running task shows progress. */
  onText?: (text: string) => Promise<void>;
  onToolCall?: (call: { name: string; input: Record<string, unknown>; outcome: AgentToolOutcome }) => Promise<void>;
}

/**
 * Turns the loop until the model is done, a tool stops it, or the cap is hit.
 *
 * Every exit records what it spent. A run that fails after ten tool calls has
 * cost real money and the ledger has to say so.
 */
export async function runAgentLoop(request: AgentRunRequest): Promise<AgentRunResult> {
  const apiKey = await analystKey();
  if (!apiKey) {
    throw new AnalystError(503, "No Anthropic API key is set. Add one under Settings → AI analyst before an agent can work.");
  }

  const client = new Anthropic({ apiKey });
  const model = await defaultModel();
  const effort = request.effort ?? "medium";
  const startedAt = Date.now();

  const byName = new Map(request.tools.map((tool) => [tool.name, tool]));
  const definitions: Anthropic.Beta.BetaToolUnion[] = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Beta.BetaTool["input_schema"],
  }));

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: request.prompt }];
  const narration: string[] = [];
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let costUsd = 0;
  let servedBy = model;
  let stoppedBecause: AgentRunResult["stoppedBecause"] = "iteration-cap";

  const finish = async (ok: boolean, error?: string): Promise<AgentRunResult> => {
    await recordLlmCall({
      purpose: request.purpose,
      model: servedBy,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costUsd,
      durationMs: Date.now() - startedAt,
      effort,
      ok,
      error,
    });
    return {
      text: narration.at(-1) ?? "",
      narration,
      toolCalls,
      inputTokens,
      outputTokens,
      costUsd,
      model: servedBy,
      stoppedBecause,
    };
  };

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const send = (withFallbacks: boolean) =>
      client.beta.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: request.system,
        // Opus 5 thinks by default; asked for explicitly so the setting is
        // visible here rather than inherited. Summarised, because the
        // reasoning is worth showing on a task somebody is watching.
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort },
        tools: definitions,
        messages,
        ...(withFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      });

    let response: Anthropic.Beta.BetaMessage;
    try {
      try {
        response = await send(fallbacksAvailable);
      } catch (err) {
        if (!fallbacksAvailable || !rejectedTheBeta(err)) throw err;
        // One wasted request, once per process, then never again.
        fallbacksAvailable = false;
        console.warn(`[agent] server-side fallbacks unavailable on this key: ${(err as Error).message}`);
        response = await send(false);
      }
    } catch (err) {
      const message =
        err instanceof Anthropic.AuthenticationError
          ? "Anthropic rejected the API key. Check it under Settings → AI analyst."
          : err instanceof Anthropic.RateLimitError
            ? "Anthropic is rate-limiting this key. The task will be picked up again."
            : `Could not reach Anthropic: ${(err as Error).message}`;
      await finish(false, message);
      throw new AnalystError(err instanceof Anthropic.RateLimitError ? 429 : 502, message);
    }

    // Priced before the answer is judged: everything from here has been paid for.
    servedBy = response.model;
    const rate = await rateFor(response.model);
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheCreationTokens += usage.cacheCreationTokens;
    costUsd += costOf(rate, usage);

    if (response.stop_reason === "refusal") {
      stoppedBecause = "refusal";
      narration.push("Claude declined this task. Rephrase the brief, or do this one by hand.");
      return finish(false, "refusal");
    }
    if (response.stop_reason === "max_tokens") {
      stoppedBecause = "truncated";
      narration.push("The reply ran out of room before finishing.");
      return finish(false, "truncated");
    }

    // What it said this turn, before any tool it wants to call.
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        narration.push(block.text.trim());
        await request.onText?.(block.text.trim());
      }
    }

    if (response.stop_reason === "end_turn") {
      stoppedBecause = "finished";
      return finish(true);
    }

    // A server-side tool paused mid-turn: hand the turn back and continue.
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const wanted = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
    if (wanted.length === 0) {
      // No tools and not end_turn — nothing further will happen.
      stoppedBecause = "finished";
      return finish(true);
    }

    // The whole assistant turn goes back, thinking blocks included: on the
    // same model they must be echoed unchanged.
    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.Beta.BetaContentBlockParam[] = [];
    let stopAfterThisTurn = false;

    for (const call of wanted) {
      const tool = byName.get(call.name);
      toolCalls += 1;

      if (!tool) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: `There is no tool called ${call.name} available to you.`,
        });
        continue;
      }

      let outcome: AgentToolOutcome;
      try {
        outcome = await tool.run((call.input ?? {}) as Record<string, unknown>);
      } catch (err) {
        outcome = { content: `That call failed: ${(err as Error).message}`, isError: true };
      }

      await request.onToolCall?.({ name: call.name, input: (call.input ?? {}) as Record<string, unknown>, outcome });

      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        ...(outcome.isError ? { is_error: true } : {}),
        content: outcome.content.slice(0, 20_000),
      });
      if (outcome.stop) stopAfterThisTurn = true;
    }

    // Every result in one user message. Splitting them across messages trains
    // the model out of asking for tools in parallel.
    messages.push({ role: "user", content: results });

    if (stopAfterThisTurn) {
      stoppedBecause = "stopped-by-tool";
      return finish(true);
    }
  }

  return finish(true, "hit the iteration cap");
}
