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
 * **Why a manual loop rather than the SDK's tool runner.** Four things have to
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
 * 4. **It can be stopped and picked up again.** A run is minutes long and the
 *    process under it is a Railway container that gets redeployed; the loop
 *    hands its whole state out after every step that cannot be repeated
 *    cheaply, and can be handed one back to continue from. See below.
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

/**
 * Everything needed to carry on this conversation in another process.
 *
 * The shape is deliberately the API's own: `messages` is what would be sent
 * next, unmodified, so resuming is a matter of continuing rather than
 * reconstructing. Two of the fields describe the awkward case and are the
 * reason this exists at all —
 *
 * `pendingAssistant` is a turn the model has produced and whose tools have not
 * all run yet, and `pendingResults` are the ones inside it that already have.
 * They are held *outside* `messages` on purpose: an assistant turn asking for
 * three tools with only two results after it is not a valid conversation, so
 * keeping the half-finished turn separate means `messages` is always something
 * that can legally be sent. A resume replays neither the turn nor the calls
 * already answered — which matters most for the tools whose second run is not
 * free, and worst for the ones whose second run is a second email.
 */
export interface AgentCheckpointState {
  /** Model turns already paid for. The iteration cap counts across resumes. */
  iteration: number;
  messages: Anthropic.Beta.BetaMessageParam[];
  narration: string[];
  pendingAssistant: Anthropic.Beta.BetaContentBlockParam[] | null;
  pendingResults: Anthropic.Beta.BetaToolResultBlockParam[] | null;
  /**
   * A tool inside the pending turn has already asked the loop to stop.
   *
   * Kept because `escalate` is answered like any other tool and only *then*
   * ends the run: without this, a process dying in the gap between the two
   * would resume, see the escalation already answered, skip it, and carry on
   * turning — spending a model call to rediscover that it should have stopped.
   */
  pendingStop: boolean;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string | null;
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
  stoppedBecause: "finished" | "stopped-by-tool" | "iteration-cap" | "refusal" | "truncated" | "interrupted";
  /**
   * Where it got to. Worth keeping only when `stoppedBecause` is
   * "interrupted" — every other ending is a conversation nobody will rejoin.
   */
  state: AgentCheckpointState;
}

/**
 * A run is capped rather than trusted to end. An agent that loops calling the
 * same read tool is a real failure mode, and the cost of one is paid per
 * iteration — so the ceiling is low enough that a stuck run is cheap and high
 * enough that real work with a dozen tool calls finishes.
 *
 * Counted across resumes, never per run: a task interrupted five times must
 * not get five times the budget.
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
  /**
   * Where a previous run of this same task got to. Null starts from the brief.
   */
  resume?: AgentCheckpointState | null;
  /**
   * Save the state. Called after every model turn and after **every single
   * tool call**, because the tool call is the expensive, irreversible half:
   * losing the turn costs a few cents, and losing the knowledge that an email
   * already went out costs a prospect two identical letters.
   *
   * Never allowed to end the run — a checkpoint that cannot be written is
   * logged by the caller and the work carries on.
   */
  onCheckpoint?: (state: AgentCheckpointState) => Promise<void>;
  /**
   * Asked between iterations and between tool calls: should this stop?
   *
   * Checked at those two points and nowhere else, and that is the whole design
   * — they are the moments when the conversation is whole and the checkpoint
   * is valid, so a stop here is a pause rather than a wound. A tool that has
   * started is always allowed to finish.
   */
  shouldStop?: () => Promise<boolean> | boolean;
}

/**
 * Turns the loop until the model is done, a tool stops it, somebody asks it to
 * stop, or the cap is hit.
 *
 * Every exit records what it spent. A run that fails after ten tool calls has
 * cost real money and the ledger has to say so — and on a resumed task the
 * ledger gets **this run's** spend while the result reports the task's total,
 * because the first run's tokens were already billed by the first run.
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

  const resumed = request.resume ?? null;
  const messages: Anthropic.Beta.BetaMessageParam[] = resumed?.messages
    ? [...resumed.messages]
    : [{ role: "user", content: request.prompt }];
  const narration: string[] = resumed?.narration ? [...resumed.narration] : [];
  let pendingAssistant = resumed?.pendingAssistant ?? null;
  let pendingResults: Anthropic.Beta.BetaToolResultBlockParam[] | null = resumed?.pendingResults ?? null;
  let pendingStop = resumed?.pendingStop ?? false;

  // Carried in from earlier runs. These are the *task's* totals; the `run`
  // ones below are this process's, and only those reach the ledger.
  let toolCalls = resumed?.toolCalls ?? 0;
  let inputTokens = resumed?.inputTokens ?? 0;
  let outputTokens = resumed?.outputTokens ?? 0;
  let costUsd = resumed?.costUsd ?? 0;

  let runInputTokens = 0;
  let runOutputTokens = 0;
  let runCacheReadTokens = 0;
  let runCacheCreationTokens = 0;
  let runCostUsd = 0;

  let servedBy = resumed?.model ?? model;
  let stoppedBecause: AgentRunResult["stoppedBecause"] = "iteration-cap";
  let iteration = resumed?.iteration ?? 0;

  const state = (): AgentCheckpointState => ({
    iteration,
    messages: [...messages],
    narration: [...narration],
    pendingAssistant,
    pendingResults,
    pendingStop,
    toolCalls,
    inputTokens,
    outputTokens,
    costUsd,
    model: servedBy,
  });

  /** Never fatal. A checkpoint is insurance, not the work. */
  const checkpoint = async () => {
    if (!request.onCheckpoint) return;
    try {
      await request.onCheckpoint(state());
    } catch (err) {
      console.error(`[agent] checkpoint failed for ${request.purpose}:`, (err as Error).message);
    }
  };

  const stopWanted = async (): Promise<boolean> => {
    if (!request.shouldStop) return false;
    try {
      return await request.shouldStop();
    } catch {
      // A failed check is not a reason to abandon work in flight.
      return false;
    }
  };

  const finish = async (ok: boolean, error?: string): Promise<AgentRunResult> => {
    await recordLlmCall({
      purpose: request.purpose,
      model: servedBy,
      inputTokens: runInputTokens,
      outputTokens: runOutputTokens,
      cacheReadTokens: runCacheReadTokens,
      cacheCreationTokens: runCacheCreationTokens,
      costUsd: runCostUsd,
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
      state: state(),
    };
  };

  /** Stopped on request, with its place kept. Not a failure and not an error. */
  const interrupted = async (): Promise<AgentRunResult> => {
    stoppedBecause = "interrupted";
    await checkpoint();
    return finish(true, "interrupted");
  };

  while (iteration < MAX_ITERATIONS) {
    if (await stopWanted()) return interrupted();

    // Two ways into a turn: a fresh one from the model, or the half-finished
    // one a previous process left behind. The second skips the model call —
    // that turn has already been paid for once.
    let assistantContent: Anthropic.Beta.BetaContentBlockParam[];

    if (pendingAssistant) {
      assistantContent = pendingAssistant;
    } else {
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
        // The conversation up to here is intact and worth keeping: a rate limit
        // is a task that resumes in five minutes, not one that starts again.
        await checkpoint();
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
      runInputTokens += usage.inputTokens;
      runOutputTokens += usage.outputTokens;
      runCacheReadTokens += usage.cacheReadTokens;
      runCacheCreationTokens += usage.cacheCreationTokens;
      const turnCost = costOf(rate, usage);
      runCostUsd += turnCost;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      costUsd += turnCost;

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
      // A complete turn, so it goes straight into the conversation.
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        iteration += 1;
        await checkpoint();
        continue;
      }

      assistantContent = response.content;

      if (assistantContent.filter((block) => block.type === "tool_use").length === 0) {
        // No tools and not end_turn — nothing further will happen.
        stoppedBecause = "finished";
        return finish(true);
      }
    }

    const wanted = assistantContent.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");

    // The turn is now in flight. Held here rather than pushed into `messages`
    // until its results are complete, so what is checkpointed is always a
    // conversation that could legally be sent.
    pendingAssistant = assistantContent;
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [...(pendingResults ?? [])];
    pendingResults = results;
    const alreadyAnswered = new Set(results.map((result) => result.tool_use_id));
    await checkpoint();

    let stopAfterThisTurn = pendingStop;

    for (const call of wanted) {
      // Answered by an earlier run of this task. Not called again — this is
      // the line that stops a resume re-sending an email.
      if (alreadyAnswered.has(call.id)) continue;
      if (await stopWanted()) return interrupted();

      const tool = byName.get(call.name);
      toolCalls += 1;

      if (!tool) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: `There is no tool called ${call.name} available to you.`,
        });
        await checkpoint();
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
      if (outcome.stop) {
        stopAfterThisTurn = true;
        pendingStop = true;
      }
      // The expensive half is behind us. Written before the next call starts.
      await checkpoint();
    }

    // Every result in one user message. Splitting them across messages trains
    // the model out of asking for tools in parallel.
    messages.push({ role: "assistant", content: assistantContent });
    messages.push({ role: "user", content: results });
    pendingAssistant = null;
    pendingResults = null;
    pendingStop = false;
    // Counted here rather than in a loop header: the turn is over, so what a
    // resume from this point would do next is the *next* turn, and a
    // checkpoint that says otherwise hands the task a free iteration every
    // time it is interrupted.
    iteration += 1;
    await checkpoint();

    if (stopAfterThisTurn) {
      stoppedBecause = "stopped-by-tool";
      return finish(true);
    }
  }

  return finish(true, "hit the iteration cap");
}
