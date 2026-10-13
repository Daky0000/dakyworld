import { withModelCapacity } from "./modelCapacity.js";
import { beforeWebsiteExternalAction, currentWebsiteWork } from "./websiteWorkContext.js";
import Anthropic from "@anthropic-ai/sdk";
import { recordLlmCall } from "./llmLedger.js";
import { AnalystError, analystKey, type Effort } from "./claude.js";
import { costOf, modelForEffort, type ModelRate } from "./claudePricing.js";
import {
  PAID_AGENT_CHAIN,
  PROVIDERS,
  PROVIDER_PRICING,
  TASK_LEVELS,
  effortForLevel,
  freeLadderFor,
  freeModel,
  levelForEffort,
  modelForLevel,
  providerConfigured,
  providerKey,
  providerModel,
  reasoningEffortFor,
  requestFee,
  vendorBase,
  type PaidProvider,
  type TaskLevel,
} from "./models/registry.js";
import { forGemini, rateForModel } from "./models/call.js";

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
  run: (input: Record<string, unknown>, meta?: AgentToolCallMeta) => Promise<AgentToolOutcome>;
}

/**
 * What the loop knows about this call that the arguments cannot say.
 *
 * One field, and it exists for one window. A checkpoint is written after every
 * tool call, so a process that dies between the call landing and the write
 * leaves a side effect on the record and no trace of it in the conversation.
 * The resumed run restores that same half-finished turn, finds the call
 * unanswered, and makes it again — which for a capture is a second Apify
 * charge, for `proposal.draft` a second document, and for `delegate` a second
 * agent doing the same work.
 *
 * `replay` is true only for the calls inside the turn a resume *restored*, and
 * only until that turn completes. Everything the model asks for afterwards is
 * a fresh decision and is never deduplicated, which is the distinction that
 * matters: an agent that photographs a page, changes it and photographs it
 * again is doing that deliberately, and a blanket "same arguments, same call"
 * rule would hand it the old picture.
 *
 * **Optional, and absent means not a replay.** The loop always passes it; what
 * does not is a harness or a route driving one tool directly, and a call made
 * from outside a resumed conversation cannot be a repeat of one. Defaulting
 * the other way would have a check's first call answered with some earlier
 * run's output.
 */
export interface AgentToolCallMeta {
  /** This call is one a previous process may already have made. */
  replay: boolean;
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
   * What Claude said about a refusal — the policy category and, sometimes, a
   * sentence of explanation. Only on a "refusal" ending, and only when the
   * vendor sent any: the card quotes it rather than guessing at a reason.
   */
  stopDetails?: { category: string | null; explanation: string | null } | null;
  /**
   * Where it got to. Worth keeping for any ending somebody may carry on from:
   * "interrupted" above all, and "iteration-cap", which the Owner can lift
   * once to let the same conversation finish. A conversation that finished,
   * or that a tool stopped, is not rejoined.
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
export const MAX_ITERATIONS = 16;
/** Under the SDK's HTTP timeout for a non-streaming call. */
const MAX_TOKENS = 16_000;

/**
 * The prompt cache, which this loop existed for a month without using.
 *
 * An agent turn re-sends everything that came before it: the system prompt,
 * every tool definition, the brief, and every tool result so far. Turn six of
 * a run pays for turn one's brief for the sixth time. Nothing about that is
 * avoidable — it is how the API works — but paying full price for it is,
 * because a prefix that has not changed can be read from Anthropic's cache at
 * a tenth of the input rate.
 *
 * The ledger has had `cacheReadTokens` and `cacheCreationTokens` columns, and
 * `costOf` has had the multipliers, since the day it shipped. Both were always
 * zero. This is the four lines that were missing.
 *
 * Four breakpoints is the API's limit and all four are used:
 *
 * 1. **The tools**, on the last definition — they are identical for every turn
 *    of a run, and on a well-equipped agent they are the largest single block.
 * 2. **The system prompt**, which is the agent's instruction, the brand, the
 *    voice and the house rules. Also identical for every turn.
 * 3 and 4. **A rolling pair inside the conversation**, on the last two user
 *    turns. The newest one writes the turn that just happened into the cache;
 *    the one behind it is what the *next* turn reads. Marking only the newest
 *    would write a cache entry every turn and never read one, which is the
 *    expensive half of caching with none of the saving.
 *
 * Entries live five minutes and every turn refreshes them, so a run only pays
 * the write premium once per block. A resumed task minutes later has gone cold
 * and pays it again — still cheaper than the alternative, which is what this
 * loop did before.
 */
const CACHE: Anthropic.Beta.BetaCacheControlEphemeral = { type: "ephemeral" };

/**
 * How much of a tool's answer the model is shown.
 *
 * A tool result is not paid for once. It goes into the conversation and is
 * re-sent with every turn after it, so a 16,000-character JSON blob on turn
 * two is still being billed on turn twelve — ten more times, at full input
 * rate for the part the cache has not reached. The old ceiling let eight tool
 * calls put 35,000 tokens of mostly-irrelevant JSON permanently into the
 * prompt.
 *
 * Six thousand characters is roughly a page and a half: enough for a lead, an
 * audit's findings, a page of search results. Anything genuinely longer is
 * something the agent should be reading a piece of, with a filter, rather than
 * being handed whole.
 */
export const TOOL_RESULT_MAX_CHARS = 6_000;

/**
 * Cuts an answer to that ceiling, and says so.
 *
 * The saying-so is the point. A silent `.slice()` hands the model half a JSON
 * object that looks complete, and an agent that concludes "there are four
 * communications on this lead" from a list that was cut at four has been
 * misled by its own tooling rather than by anything anybody wrote.
 *
 * **Safe to apply twice, and it is.** The runner clips a catalogue tool's
 * output and the loop clips every result again on the way into the
 * conversation, so an answer arrives here already cut — six thousand
 * characters plus the notice. Clipped a second time, that lost its own notice
 * and announced the *clipped* length as the original, so a 50,000-character
 * answer told the model it had been 6,237. An answer that already
 * ends with this notice, and fits under the ceiling without it, comes back as
 * it is; one cut at a larger ceiling is cut again, still naming the true size.
 */
const CUT_NOTICE = /\n\n\[Cut off here: this answer was ([\d,]+) characters and you have been shown the first [\d,]+\.[^\]]*\]$/;

export function clipToolResult(content: string, max = TOOL_RESULT_MAX_CHARS): string {
  const cut = CUT_NOTICE.exec(content);
  const body = cut ? content.slice(0, cut.index) : content;
  if (body.length <= max) return content;
  const original = cut ? Number(cut[1].replace(/,/g, "")) : content.length;
  return `${body.slice(0, max)}

[Cut off here: this answer was ${original.toLocaleString("en-GB")} characters and you have been shown the first ${max.toLocaleString("en-GB")}. There is more that you have not seen. Ask again with a narrower filter, a smaller limit or a specific id rather than assuming this is all of it.]`;
}

/**
 * How large the conversation may get before its oldest answers are let go.
 *
 * A turn re-sends everything before it, so a tool result read on turn two is
 * still being paid for on turn twelve. `clipToolResult` caps any single answer;
 * this caps the pile of them.
 *
 * **Two numbers, not one, and that is the whole design.** Trimming at a single
 * ceiling would trim on every turn once it was crossed — and the prompt cache is
 * keyed on an exact prefix, so rewriting the front of the conversation every
 * turn would mean paying full input rate for all of it, every turn. That is the
 * opposite of what this is for. So it fires at the ceiling and cuts back to
 * `TRIM_DOWN_TO`, which buys several turns of a stable prefix before it can
 * fire again.
 *
 * The ceiling is characters rather than tokens because that is what can be
 * measured here without a second API call, and roughly four characters to the
 * token makes 48,000 about 12,000 tokens of conversation — well inside every
 * vendor's window, and well past the point where old tool output is earning its
 * place.
 */
const CONVERSATION_MAX_CHARS = 48_000;
const TRIM_DOWN_TO = 24_000;

/** What an oldest answer says once it has been let go of. */
const RELEASED =
  "[This answer has been let go of to keep the conversation affordable. You read it at the time and acted on it; " +
  "what you concluded is in your own replies above. If you need the detail again, call the tool again.]";

/**
 * The gentler step before letting go: older answers cut to their first lines.
 *
 * It ran on every turn, unconditionally, and that made it the opposite of what
 * the two numbers above are for. Each turn a result aged past the protected
 * tail and was rewritten — on the very user turn that had carried the previous
 * request's cache breakpoint — so from about the fourth turn every request
 * re-paid the conversation from that point at the write premium. Now it waits
 * until the conversation is past `COMPACT_SOFT_CHARS` and then shortens
 * **everything** eligible at once, so the prefix holds still between those
 * moments rather than moving by one result every turn.
 *
 * Eligible means: older than the last four messages (the newest turn and the
 * one before it, which the model is still reasoning from), longer than
 * `COMPACT_TOOL_RESULT_THRESHOLD`, not an error (a refusal or a failure is
 * short, and the model needs to keep knowing it happened), and not already
 * shortened or released.
 */
const COMPACT_SOFT_CHARS = 24_000;
const COMPACT_TOOL_RESULT_THRESHOLD = 350;
const COMPACT_KEEP_CHARS = 260;
const COMPACT_PROTECTED_TAIL = 4;
const SHORTENED = "[Shortened from ";

/**
 * The first message either trim may rewrite.
 *
 * **Preserved thinking.** Claude's newer models — Fable 5.1, Opus 5.5,
 * Sonnet 5.5, Haiku 5.5 — sign each thinking block against everything sent
 * before it: the system prompt, the tools and every earlier message. When the
 * block comes back the API checks that record, so rewriting a tool result
 * *above* a thinking block invalidates that block and every one after it. On
 * an account created since 31 Aug 2026 replaying one is a 400 (older accounts
 * are let off for now, and the guidance is append-only regardless) — and in
 * this loop a 400 handed the run to the next paid vendor, or failed it, until
 * the backstop below (one strip and one retry on the same model) caught it.
 *
 * Anthropic's guidance for a harness that trims old tool results is to stop:
 * bound each result before it is first sent (`clipToolResult`) and never touch
 * it again, leaving any later clearing to the server. The alternative it
 * offers — `prefix_mismatch_behavior: "drop_block"` under a beta header —
 * keeps the request alive by throwing the same reasoning away, and is a
 * production setting to be chosen deliberately rather than a fix. So both
 * trims stop at the last thinking block. On a run Claude has thought in, the
 * conversation is append-only; that is also the cheaper choice on that wire,
 * because a rewrite restarts the prompt cache from the edit and pays the write
 * premium on everything after it. The free and chat-completions wires never
 * put a thinking block into the conversation, so nothing changes for them.
 */
export function editableFrom(messages: Anthropic.Beta.BetaMessageParam[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index].content;
    if (Array.isArray(content) && content.some(isThinkingBlock)) {
      return index + 1;
    }
  }
  return 0;
}

function isThinkingBlock(block: { type?: string }): boolean {
  return block?.type === "thinking" || block?.type === "redacted_thinking";
}

/**
 * The conversation with every thinking block taken out, and nothing else.
 *
 * Anthropic's one-time recovery for reasoning that no longer matches its
 * conversation: strip every `thinking` and `redacted_thinking` block, keep each
 * turn's text and tool calls, and carry on. The model answers the next turn
 * without the reasoning those blocks held. **All of them, never a selection**:
 * the API accepts a contiguous run of a conversation's blocks and nothing
 * else, so one removed from the middle fails the block after it. A turn that
 * held nothing but reasoning goes with it, because an empty assistant turn is
 * not a shape the API accepts. Returns a copy; the caller decides whether the
 * strip becomes the conversation, and must save it if it does — a strip that
 * is not written down sends the refused blocks again on the next resume.
 */
export function withoutThinking(messages: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  const kept: Anthropic.Beta.BetaMessageParam[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content) || !message.content.some(isThinkingBlock)) {
      kept.push(message);
      continue;
    }
    const content = message.content.filter((block) => !isThinkingBlock(block));
    if (content.length > 0) kept.push({ ...message, content });
  }
  return kept;
}

/**
 * Claude refused a replayed thinking block: its conversation changed since it
 * was written, or its signature does not belong to this one.
 *
 * Both are the same 400 opening — "Invalid `signature` in `thinking` block" —
 * and both are cured the same way, by sending the conversation without its
 * reasoning. Matched on that wording rather than on the status alone, because
 * every other 400 is a request this code built wrong, and stripping reasoning
 * out of a request that was wrong for some other reason fixes nothing.
 */
function thinkingBindingRefused(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  const message = err.message.toLowerCase();
  return message.includes("thinking") && message.includes("signature");
}

/**
 * Shortens older tool results once the conversation is past the soft ceiling.
 *
 * Mutates in place, for the same reason `releaseOldAnswers` does. The stub
 * says how long the answer was and what to do about it, and nothing more: the
 * one it replaced claimed the essential data "was extracted in assistant turn
 * above", which nothing here guarantees and the model has no way to check.
 *
 * `size` is the conversation's serialised length when the caller has already
 * measured it — the loop measures once and hands the number to both trims.
 * Returns how many it shortened; 0 is the ordinary case.
 */
export function compactOldToolResults(messages: Anthropic.Beta.BetaMessageParam[], size = JSON.stringify(messages).length): number {
  if (size <= COMPACT_SOFT_CHARS) return 0;
  const before = messages.length - COMPACT_PROTECTED_TAIL;
  let compacted = 0;

  for (let index = editableFrom(messages); index < before; index += 1) {
    const content = messages[index].content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; content?: unknown; is_error?: boolean }[]) {
      if (block?.type !== "tool_result" || block.is_error) continue;
      if (typeof block.content !== "string" || block.content.length <= COMPACT_TOOL_RESULT_THRESHOLD) continue;
      // The last prefix is the stub this one replaced, still sitting in
      // checkpoints written before it went.
      if (block.content === RELEASED || block.content.startsWith(SHORTENED) || block.content.startsWith("[Compacted tool output")) continue;

      block.content =
        `${SHORTENED}${block.content.length.toLocaleString("en-GB")} characters; first ${COMPACT_KEEP_CHARS} kept. ` +
        `Call the tool again for the rest.]\n${block.content.slice(0, COMPACT_KEEP_CHARS)}`;
      compacted += 1;
    }
  }
  return compacted;
}

/**
 * Lets go of the oldest tool results once the conversation is too big to keep
 * re-sending, and says what it did.
 *
 * **Only `tool_result` content, and only its text.** The block, its
 * `tool_use_id` and its position all survive — deleting a message would
 * separate a `tool_use` from its result and the next request would be rejected
 * outright. The same rule `saveCheckpoint`'s `trimToFit` follows, for the same
 * reason, and this is deliberately the same technique applied to what is sent
 * rather than to what is stored.
 *
 * Oldest first, because the recent turns are the ones the model is still
 * reasoning from — and **never the newest user turn**, which holds answers the
 * model has not read yet. Without that guard, a long brief and a few large
 * results could cross the ceiling on their own, and the results the model was
 * about to see were released with a note saying "you read it at the time",
 * which it had not. Mutates in place: what is sent and what is checkpointed
 * have to be the same conversation, or a resume would restore text this just
 * decided was not worth re-sending.
 *
 * Returns how many it released, or 0 when the conversation is small enough to
 * leave alone. Each release is subtracted from a running total rather than the
 * whole conversation being serialised again, which is how `trimToFit` does it.
 */
export function releaseOldAnswers(messages: Anthropic.Beta.BetaMessageParam[], size = JSON.stringify(messages).length): number {
  if (size <= CONVERSATION_MAX_CHARS) return 0;

  let unread = messages.length - 1;
  while (unread >= 0 && messages[unread].role !== "user") unread -= 1;
  const replacement = JSON.stringify(RELEASED).length;

  let released = 0;
  for (let index = editableFrom(messages); index < unread; index += 1) {
    const content = messages[index].content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; content?: unknown }[]) {
      if (block?.type !== "tool_result") continue;
      if (typeof block.content === "string" && block.content === RELEASED) continue;
      // What this block costs as it is serialised, which is the only measure
      // that matches the number being compared against.
      const was = JSON.stringify(block.content ?? null).length;
      block.content = RELEASED;
      released += 1;
      size -= was - replacement;
      if (size <= TRIM_DOWN_TO) return released;
    }
  }
  return released;
}

/**
 * The conversation, with the two rolling breakpoints on it.
 *
 * Returns a copy. The originals stay unmarked because `messages` is what goes
 * into the checkpoint, and a checkpoint carrying breakpoints from wherever the
 * last process happened to stop would put them in the wrong place on resume.
 */
function withCacheBreakpoints(messages: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  // Turns alternate, so the last message is the newest user turn and the one
  // three back is the user turn before it. `pause_turn` is the exception — it
  // pushes a lone assistant turn and puts the alternation out by one — so this
  // picks positions and then checks what is actually there rather than
  // assuming a role.
  const marks = new Set([messages.length - 1, messages.length - 3].filter((index) => index >= 0));

  return messages.map((message, index) => {
    if (!marks.has(index)) return message;
    const blocks: Anthropic.Beta.BetaContentBlockParam[] =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];

    // A breakpoint goes on the *last* block of the turn, because it marks the
    // end of the prefix rather than the start of anything — but **never on a
    // thinking block**, which the API refuses to let one sit on. That is not
    // hypothetical: a turn the model paused mid-way is pushed whole, reasoning
    // included, so a run that went through a server-side tool would 400 on its
    // very next turn. Failing at request time makes that the whole agent
    // rather than a slightly worse bill — the same reason the four-breakpoint
    // limit is guarded.
    // A plain backward scan rather than `findLastIndex`, which this tsconfig's
    // lib does not carry.
    let at = blocks.length - 1;
    while (at >= 0 && (blocks[at].type === "thinking" || blocks[at].type === "redacted_thinking")) at -= 1;
    if (at < 0) return message;

    blocks[at] = { ...blocks[at], cache_control: CACHE } as Anthropic.Beta.BetaContentBlockParam;
    return { ...message, content: blocks };
  });
}
/** See claude.ts — the same beta, for the same reason. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
let fallbacksAvailable = true;

function rejectedTheBeta(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  // The binding refusal names the `anthropic-beta` header in its advice, and
  // read as a refused fallback beta it switched server-side fallbacks off for
  // the life of the process and resent the same refused conversation.
  if (thinkingBindingRefused(err)) return false;
  const message = err.message.toLowerCase();
  return message.includes("fallback") || message.includes("beta");
}


// --- The wires --------------------------------------------------------------

/**
 * An agent turn over somebody other than Anthropic, translated at the edge.
 *
 * The loop's whole internal state — messages, checkpoints, tool calls — is
 * Anthropic-shaped, because that is the shape it was born in and the shape
 * every checkpoint already saved is in. Rather than a loop per vendor with a
 * state format per vendor (they drift, and a checkpoint written by one is
 * unreadable by the other), this translates at the wire: Anthropic blocks go
 * out in the vendor's shape, and what comes back comes back as Anthropic
 * blocks. A run can start on one vendor and finish on another without
 * anything between the two caring — which is the entire reason a free rung can
 * hand a half-finished conversation to a paid model and have it carry on.
 *
 * Three things are deliberately dropped on the chat-completions wire:
 *
 * - **Cache breakpoints.** Neither OpenRouter nor OpenAI exposes an
 *   equivalent, so marking nothing costs nothing.
 * - **Thinking blocks.** These models reason server-side and return only the
 *   answer, so they never enter the conversation here — and a conversation
 *   resumed from Claude carries them harmlessly, because they are skipped
 *   rather than sent.
 * - **`output_config.effort`.** Not an OpenAI parameter. The effort travels
 *   instead as `reasoning_effort`. See `reasoningEffortFor`, and the note
 *   there about `max` being one vendor's word rather than a standard one.
 */

/**
 * Who can run an agent turn.
 *
 * Four rather than two as of 28 Aug 2026. NVIDIA goes first and climbs the free
 * ladder picked for agent work; when every free rung has refused the work, the paid floor
 * finishes it, and the floor is now **the best of three** rather than
 * Anthropic alone. See `PAID_AGENT_CHAIN` in models/registry.ts for the order
 * and why it is that order.
 *
 * Perplexity is not here and never will be: it searches the live web and does
 * not take tool definitions, so an agent turn on it is a turn with no tools,
 * which is not an agent.
 */
export type AgentVendor = "nvidia" | "anthropic" | "openai" | "gemini";

/** The three that speak a wire this file writes by hand. Anthropic has an SDK. */
type FetchVendor = Exclude<AgentVendor, "anthropic">;

/**
 * The two vendors whose wire is OpenAI chat completions.
 *
 * One function serves both, and that is the point of putting ChatGPT on the
 * paid floor before Gemini: the step from a free NVIDIA rung to a paid OpenAI
 * model is a different base URL and a different key, and nothing else.
 */
type ChatCompletionsVendor = "nvidia" | "openai";

/**
 * The statuses that mean this vendor cannot serve this request at all.
 *
 * 401/402/403 are key-level — wrong key, out of credits, banned account.
 * **404 is the model**: a slug that OpenRouter no longer lists, which is how a
 * stealth listing ends. It belongs here for exactly the same reason the others
 * do — the vendor has told us nothing about the request, nothing has been
 * spent, and the floor underneath can do the work. Leaving it out cost a live
 * Chief Executive task on 26 Aug 2026: the run died on the first turn with the
 * whole conversation intact and Claude connected and unasked.
 *
 * 400 is here for the same reason `callModel` treats it as "refused the request
 * shape": a parameter one model will not take is routine for the next. This
 * matters more than it looks after a model swap — `reasoningEffortFor` sends
 * the shipped model's own `max`, which is not an OpenAI-standard effort, so a
 * replacement model that rejects it would have taken every high-effort task
 * down with it. It costs at most one extra call, and the sentence that comes
 * back then names both vendors instead of one.
 *
 * What is deliberately **not** here: 429, which has its own message and resumes
 * rather than quietly moving the bill to Anthropic on every rate limit; and a
 * content refusal, which in this loop comes back as an ordinary answer rather
 * than an error, and which must never be routed around — asking a second model
 * until one says yes is shopping for a yes.
 */
const CANNOT_SERVE_STATUSES = [400, 401, 402, 403, 404];

/**
 * How long a refused NVIDIA key sits out.
 *
 * Long enough that the resumes a failed run leaves behind start on Claude
 * instead of each paying one wasted call into the same refusal; short enough
 * that topping the account up is noticed without a redeploy. The same shape
 * as `fallbacksAvailable` above, with a clock on it.
 */
const NVIDIA_COOLDOWN_MS = 15 * 60 * 1000;
let nvidiaRefusedUntil = 0;

/**
 * Clears the cooldown. For checks only.
 *
 * The cooldown is the right behaviour and the reason it exists is sound — a
 * queue of resumes must not each pay a call into the same wall. It is also the
 * thing that makes a second failover scenario in one process a test of
 * nothing: the vendor is skipped before the failure being tested can happen,
 * and the assertion passes for the wrong reason.
 */
export function clearNvidiaCooldown(): void {
  nvidiaRefusedUntil = 0;
}

/**
 * Whether the free vendor is sitting out, and until when.
 *
 * The cooldown is right and it was **invisible**, which made it the best
 * available explanation for "I believed the free models were available and they
 * are not kicking in": a key-level refusal takes NVIDIA out of the chain for
 * fifteen minutes, every agent run in that window starts on a paid vendor, and
 * nothing on any screen said so. Reported by
 * `GET /api/settings/models/nvidia/free` so the answer is where somebody
 * would look for it.
 *
 * Process-local, like the cooldown itself. A restart clears it, which is worth
 * saying on the screen rather than leaving somebody to discover.
 */
export function nvidiaCooldown(): { cooling: boolean; until: string | null } {
  const cooling = Date.now() < nvidiaRefusedUntil;
  return { cooling, until: cooling ? new Date(nvidiaRefusedUntil).toISOString() : null };
}

/** As generous as the Anthropic SDK's own default for a non-streaming turn. */
const TURN_TIMEOUT_MS = 600_000;

/**
 * The same turn on a free rung, on a much shorter clock.
 *
 * Ten minutes is right for a paid model that is the only one who can do this:
 * an agent turn with a long conversation and a hard question behind it really
 * can take minutes, and giving up on one costs the whole run. A free rung is
 * the opposite case — there is another free model one line down — so a shared
 * endpoint that has said nothing in two minutes is not thinking, it is busy,
 * and the right answer is the next rung rather than eight more minutes of
 * waiting.
 *
 * Two minutes rather than the model layer's one, because a turn here carries
 * the whole conversation and every tool definition with it.
 */
const FREE_TURN_TIMEOUT_MS = 120_000;

/**
 * One finished model turn, in the loop's own vocabulary.
 *
 * Both wires produce this, so everything after the call — narration, tool
 * handling, pricing, checkpoints — is written once against it.
 */
interface WireTurn {
  model: string;
  // The SDK's own union, null included. Anything this loop does not
  // specifically handle falls through to the tool-use check and ends the run
  // as finished when there is nothing to call — which is the honest reading of
  // a stop reason nobody has heard of yet.
  stop_reason: Anthropic.Beta.BetaStopReason | null;
  /** Claude's account of a refusal. The other vendors never send one. */
  stop_details?: { category: string | null; explanation?: string | null } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  content: Anthropic.Beta.BetaContentBlockParam[];
}

/**
 * Our effort word onto the three the wire takes — low, medium, high. See the
 * block comment above, and `reasoningEffortFor` for the 400 behind it.
 *
 * It lives in `models/registry.ts` with the other vendor facts now, because
 * the one-shot half of the model layer needs the same answer and was sending
 * nothing at all — re-exported here so this loop and its check keep reading it
 * from the file that speaks the wire.
 */
export { reasoningEffortFor };

/**
 * The conversation as OpenAI chat messages.
 *
 * Tool calls ride on the assistant turn that asked for them (`tool_calls`),
 * and each result comes back as its own `tool` message keyed by the id it
 * answers — that pairing is how the wire knows which answer goes with which
 * call, and getting it wrong is how a model ends up reading another call's
 * answer as its own.
 */
function toOpenAiMessages(system: string, messages: Anthropic.Beta.BetaMessageParam[]): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (typeof message.content === "string") {
      wire.push({ role: message.role, content: message.content });
      continue;
    }

    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlockParam => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    const toolUses = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlockParam => block.type === "tool_use");
    const toolResults = message.content.filter((block): block is Anthropic.Beta.BetaToolResultBlockParam => block.type === "tool_result");

    if (message.role === "assistant") {
      // A turn carrying only thinking blocks says nothing on this wire — skip
      // it rather than sending an assistant message with nothing in it, which
      // some providers refuse outright.
      if (!text && toolUses.length === 0) continue;
      wire.push({
        role: "assistant",
        ...(text ? { content: text } : {}),
        ...(toolUses.length > 0
          ? {
              tool_calls: toolUses.map((block) => ({
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }

    for (const result of toolResults) {
      wire.push({
        role: "tool",
        tool_call_id: result.tool_use_id,
        content: typeof result.content === "string" ? result.content : JSON.stringify(result.content),
      });
    }
    if (text) wire.push({ role: "user", content: text });
  }

  return wire;
}

/**
 * A turn that did not happen, with the vendor's own status on it.
 *
 * One class for all three fetch vendors rather than one each. What the loop
 * does about a failure depends on the *status* and on what else is connected,
 * never on which company answered — a 402 is an empty balance whoever sent it,
 * and writing that decision out three times is how the three copies come to
 * disagree. `vendor` rides along so the sentence a person reads names who
 * refused.
 */
class WireError extends Error {
  constructor(
    readonly status: number,
    readonly vendor: FetchVendor,
    message: string,
  ) {
    super(message);
    this.name = "WireError";
  }
}

/**
 * One turn, out and back, over OpenAI chat completions.
 *
 * Errors are left typed rather than mapped here: whether a refusal means
 * "try the next model" or "lose the run" is the caller's decision, and it
 * depends on what else is connected.
 */
async function chatCompletionsTurnUnbounded(args: {
  vendor: ChatCompletionsVendor;
  apiKey: string;
  model: string;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: AgentTool[];
  effort: Effort;
  /** A rung of the free ladder: one short clock, and no waiting about. */
  free?: boolean;
}): Promise<WireTurn> {
  // The effort only where it is understood.
  //
  // ChatGPT takes `reasoning_effort` on every model this app asks for. NVIDIA
  // does not: `openai/gpt-oss-*` answers a flat 400 to a value outside
  // low/medium/high, and three of the models in `FREE_MODELS` do not take the
  // parameter at all. A model this app has never probed is treated as one of
  // those — a parameter a model ignores is free, and one it rejects costs the
  // whole turn, on the first turn, after the system prompt has been read.
  const takesEffort = args.vendor === "openai" || freeModel(args.model)?.reasoning !== false;
  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: MAX_TOKENS,
    messages: toOpenAiMessages(args.system, args.messages),
    ...(takesEffort ? { reasoning_effort: reasoningEffortFor(args.effort) } : {}),
  };
  if (args.tools.length > 0) {
    body.tools = args.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
  }

  let response: Response;
  try {
    response = await fetch(`${vendorBase(args.vendor)}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(args.free ? FREE_TURN_TIMEOUT_MS : TURN_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout and a dropped connection arrive here as a `DOMException` and a
    // `TypeError`, neither of which the caller can tell apart from a bug in
    // this file. Given a status they become what they are — *this model did
    // not answer* — which is the commonest thing a free rung does and the
    // exact case the ladder exists for. Left raw, a free model that hung took
    // the whole run down while two more sat unasked.
    throw new WireError(504, args.vendor, `${args.model} did not answer: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    // The allowance trap, said where it bites: NVIDIA's free models share one
    // allowance per account, so a 429 mid-run can be the day's limit rather
    // than a busy model — and those read identically. Offered as a
    // possibility, because the vendor does not distinguish them either.
    const hint =
      response.status === 429 && args.vendor === "nvidia"
        ? " NVIDIA's free models share one allowance per account, so this may be the day's allowance rather than a busy model. The ladder climbs either way."
        : "";
    throw new WireError(response.status, args.vendor, `${detail}${hint}`);
  }

  const payload = (await response.json().catch(() => null)) as {
    model?: unknown;
    choices?: { finish_reason?: unknown; message?: { content?: unknown; tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[] } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  } | null;

  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];

  if (typeof message?.content === "string" && message.content.trim()) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of message?.tool_calls ?? []) {
    let parsed: unknown = {};
    if (typeof call.function?.arguments === "string" && call.function.arguments.trim()) {
      try {
        parsed = JSON.parse(call.function.arguments);
      } catch {
        parsed = {};
      }
    }
    content.push({
      type: "tool_use",
      id: typeof call.id === "string" && call.id ? call.id : `call_${Math.random().toString(36).slice(2)}`,
      name: typeof call.function?.name === "string" ? call.function.name : "",
      input: (parsed ?? {}) as Record<string, unknown>,
    });
  }

  const wantsTools = content.some((block) => block.type === "tool_use");
  const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
  return {
    model: typeof payload?.model === "string" && payload.model ? payload.model : args.model,
    stop_reason: finish === "length" ? "max_tokens" : wantsTools ? "tool_use" : "end_turn",
    usage: {
      input_tokens: typeof payload?.usage?.prompt_tokens === "number" ? payload.usage.prompt_tokens : 0,
      output_tokens: typeof payload?.usage?.completion_tokens === "number" ? payload.usage.completion_tokens : 0,
    },
    content,
  };
}

// --- The Gemini wire --------------------------------------------------------

/**
 * The conversation as Gemini `contents`.
 *
 * Gemini is the one paid vendor on the floor whose shape is genuinely
 * different: roles are `user` and `model` rather than `user` and `assistant`,
 * a tool call is a `functionCall` part inside the model's own turn rather than
 * a sibling field, and a tool result is a `functionResponse` part in a **user**
 * turn rather than a message with a role of its own.
 *
 * **Tool results are matched by name, not by id**, because Gemini's function
 * calls carry no id. The loop's own state does carry ids, so the mapping is
 * made here and nowhere else: a result is emitted with the name of the call it
 * answers, in the order the calls were made. Where a turn calls the same tool
 * twice, order is what keeps the pairs straight — which is why these are built
 * in one pass over the conversation rather than gathered into a map first.
 */
/**
 * A `tool_use` block carrying the thought signature Gemini issued with it.
 *
 * Gemini 3 signs the reasoning behind a function call and **requires the
 * signature back** on the same part when that call reappears in the history:
 * without it the next turn is a `400 INVALID_ARGUMENT` naming the tool and its
 * position, not a degraded answer. So the signature has to survive from the
 * turn that produced it to every later turn — across a checkpoint, and across
 * a handover to another vendor and back.
 *
 * It rides on the loop's own Anthropic-shaped block rather than in a side map
 * for exactly that reason: a map does not survive `onCheckpoint`, and a
 * resumed run would 400 on its first Gemini turn with nothing in the record to
 * explain why. The cost is that this one field is not part of Anthropic's
 * schema, so it is stripped on the way to that wire — see
 * `withoutThoughtSignatures`. The OpenAI wire builds its messages from
 * scratch, so nothing leaks there.
 */
type SignedToolUse = Anthropic.Beta.BetaToolUseBlockParam & { thoughtSignature?: string };

/**
 * The same messages with Gemini's signatures taken back off.
 *
 * Anthropic rejects a content block carrying a field its schema does not
 * define, so a run that started on Gemini and handed to Claude would fail on
 * its first turn — the exact failure the handover exists to prevent.
 */
function withoutThoughtSignatures(messages: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    if (!message.content.some((block) => block.type === "tool_use" && (block as SignedToolUse).thoughtSignature)) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== "tool_use") return block;
        const { thoughtSignature: _dropped, ...rest } = block as SignedToolUse;
        return rest as Anthropic.Beta.BetaContentBlockParam;
      }),
    };
  });
}

function toGeminiContents(messages: Anthropic.Beta.BetaMessageParam[]): Record<string, unknown>[] {
  const contents: Record<string, unknown>[] = [];
  /** tool_use id → the name Gemini knows it by, filled as the calls go past. */
  const namesById = new Map<string, string>();

  for (const message of messages) {
    if (typeof message.content === "string") {
      contents.push({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] });
      continue;
    }

    const parts: Record<string, unknown>[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        parts.push({ text: block.text });
      } else if (block.type === "tool_use") {
        namesById.set(block.id, block.name);
        const signature = (block as SignedToolUse).thoughtSignature;
        parts.push({
          functionCall: { name: block.name, args: (block.input ?? {}) as Record<string, unknown> },
          // A sibling of `functionCall` on the part, which is where Gemini put
          // it and where it wants it back.
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      } else if (block.type === "tool_result") {
        const name = namesById.get(block.tool_use_id) ?? "unknown_tool";
        const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        // Gemini wants an object here, so the string is wrapped rather than
        // sent bare. `isError` is carried in the payload because there is no
        // `is_error` flag on this wire, and a tool that was refused is
        // information the model needs rather than a detail to drop.
        parts.push({ functionResponse: { name, response: { result: output, ...(block.is_error ? { error: true } : {}) } } });
      }
      // Thinking blocks are skipped, exactly as on the chat-completions wire.
    }

    if (parts.length === 0) continue;
    contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }

  return contents;
}

/**
 * One turn, out and back, over Gemini.
 *
 * Last on the paid floor and worth having: it is a third house, and the whole
 * argument for a floor of three is that the two above it can be rate-limited
 * or refused at the same moment. Everything it returns is translated into the
 * loop's Anthropic-shaped vocabulary here, so nothing downstream knows or
 * cares that this run finished on Gemini.
 */
async function geminiTurnUnbounded(args: {
  apiKey: string;
  model: string;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: AgentTool[];
  effort: Effort;
}): Promise<WireTurn> {
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: args.system }] },
    contents: toGeminiContents(args.messages),
    generationConfig: { maxOutputTokens: MAX_TOKENS },
  };
  if (args.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: args.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          // The closed schemas this app writes everywhere would 400 here. See
          // `forGemini`.
          parameters: forGemini(tool.inputSchema),
        })),
      },
    ];
  }

  let response: Response;
  try {
    response = await fetch(`${vendorBase("gemini")}/models/${encodeURIComponent(args.model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": args.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new WireError(504, "gemini", `${args.model} did not answer: ${(err as Error).message}`);
  }

  if (!response.ok) {
    throw new WireError(response.status, "gemini", (await response.text().catch(() => "")).slice(0, 500));
  }

  const payload = (await response.json().catch(() => null)) as {
    modelVersion?: unknown;
    candidates?: {
      finishReason?: unknown;
      content?: { parts?: { text?: unknown; thoughtSignature?: unknown; functionCall?: { name?: unknown; args?: unknown } }[] };
    }[];
    usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
  } | null;

  const candidate = payload?.candidates?.[0];
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  let wantsTools = false;

  for (const part of candidate?.content?.parts ?? []) {
    if (typeof part.text === "string" && part.text.trim()) {
      content.push({ type: "text", text: part.text });
    }
    if (part.functionCall && typeof part.functionCall.name === "string") {
      wantsTools = true;
      content.push({
        // An id of our own, because Gemini sends none. It never goes back on
        // this wire — `toGeminiContents` matches by name — but the loop's
        // state, its checkpoints and every other vendor are built on ids, and
        // a run that starts here can finish on Claude.
        type: "tool_use",
        id: `gemini_${Math.random().toString(36).slice(2)}`,
        name: part.functionCall.name,
        input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        // Kept verbatim. Gemini will not accept this call back without it.
        ...(typeof part.thoughtSignature === "string" ? { thoughtSignature: part.thoughtSignature } : {}),
      } as SignedToolUse);
    }
  }

  const finish = typeof candidate?.finishReason === "string" ? candidate.finishReason : "";
  return {
    model: typeof payload?.modelVersion === "string" && payload.modelVersion ? payload.modelVersion : args.model,
    stop_reason: finish === "MAX_TOKENS" ? "max_tokens" : wantsTools ? "tool_use" : "end_turn",
    usage: {
      input_tokens: typeof payload?.usageMetadata?.promptTokenCount === "number" ? payload.usageMetadata.promptTokenCount : 0,
      output_tokens: typeof payload?.usageMetadata?.candidatesTokenCount === "number" ? payload.usageMetadata.candidatesTokenCount : 0,
    },
    content,
  };
}

/** Which model serves an agent turn on this vendor — the Owner's choice, else the shipped default. */
async function modelForVendor(vendor: AgentVendor, effort: Effort, level: TaskLevel | null): Promise<string> {
  // A run the caller has sized picks its paid model from the task's level, on
  // all three paid vendors — see `TIER_MODELS`. NVIDIA is never tiered: its
  // ladder is free whatever the level, and replaces this answer anyway.
  if (level && vendor !== "nvidia") return modelForLevel(vendor, level);
  // A run nobody sized keeps the old split. Claude keeps the effort split: a
  // sub-agent checking a link is not billed at a director's rate. The other
  // three answer with whatever the Owner set for them, which for NVIDIA is
  // beside the point — the ladder replaces it — and for ChatGPT and Gemini is
  // a single model choice on the Settings screen.
  return vendor === "anthropic" ? modelForEffort(effort) : providerModel(vendor);
}

/**
 * A key-level refusal, told apart from a model-level one.
 *
 * The distinction did not matter while the free vendor meant one model. With a
 * ladder it decides whether the *next rung* is worth trying: a wrong key, a
 * banned account or an empty balance is true of every model on the account, so
 * climbing the ladder would be three calls into the same wall. A slug that no
 * longer exists, a parameter this model will not take, a rate limit or a
 * silence is true of that model and says nothing about the next one.
 */
const KEY_LEVEL_STATUSES = [401, 402, 403];

/**
 * The status behind a failed turn, whichever wire it came off.
 *
 * The loop decides what to do about a failure from the status and from what
 * else is connected, never from which company answered — so the four vendors'
 * four different error types are flattened here, once, rather than in four
 * branches that would each have to be kept in step with the others. 502 is the
 * honest answer for anything with no status on it at all: something went wrong
 * out there and we do not know what.
 */
function statusOf(err: unknown): number {
  if (err instanceof WireError) return err.status;
  if (err instanceof Anthropic.AuthenticationError) return 401;
  if (err instanceof Anthropic.RateLimitError) return 429;
  if (err instanceof Anthropic.APIError && typeof err.status === "number") return err.status;
  if (err instanceof AnalystError) return err.status;
  return 502;
}

/**
 * What a person is told when a vendor that could have done this failed.
 *
 * Names the vendor, because "the model failed" sends somebody to check the one
 * key they happen to remember. Names the *balance* on a 402, because a prepaid
 * account reads as a bug otherwise. Says "will be picked up again" only on a
 * rate limit, because that is the only one of these where waiting is the fix.
 *
 * `handedOn` is a failure the run moved past to another vendor. Its words end
 * up in the same sentence as the last vendor's, and `retry.ts` reads that
 * sentence whole, so they must not decide it on their own. Exported for
 * `checks/agentThinkingResume.ts`.
 */
export function describeTurnFailure(vendor: AgentVendor, status: number, model: string, err: unknown, handedOn = false): string {
  const who = PROVIDERS[vendor].name;
  const said = (err as Error)?.message ?? String(err);
  if (status === 429) return `${who} is rate-limiting this key. The task will be picked up again.`;
  if (status === 402) return `${who} has no credit left on this account. Top it up, or connect another model under Settings → AI models.`;
  if (KEY_LEVEL_STATUSES.includes(status)) return `${who} rejected the API key. Check it under Settings → AI models.`;
  // Gemini answers a key it does not recognise with a 400, not a 401. Read as
  // the request's shape, it sent the Owner looking for a fault in the app.
  if (status === 400 && /api key not valid|api_key_invalid|invalid api key/i.test(said)) {
    return `${who} rejected the API key. Check it under Settings → AI models.`;
  }
  // Our request, not their availability. "Could not reach" read as temporary
  // in `retry.ts`, so a 400 that fails identically every time was paused and
  // replayed six times over two hours before anybody was asked. The same words
  // `callModel` uses, which `retry.ts` already hands to a person.
  //
  // **Only when nobody took the run on after it.** "refused the request shape"
  // matches anywhere in the chain's sentence and is read before any status, so
  // a Claude 400 followed by a ChatGPT that was only briefly down made a task
  // that should have waited five minutes ask a person about a fault in the app.
  // A 400 the run moved past is said in words `retry.ts` does not act on, so
  // what decides is how the last vendor failed.
  if (status === 400) return handedOn ? `${who} would not take this request (400): ${said}` : `${who} refused the request shape: ${said}`;
  if (status === 404) {
    return (
      `${who} does not have the model “${model}”. Change it under Settings → AI models, ` +
      `or connect another vendor so work carries on when a model is retired.`
    );
  }
  return `Could not reach ${who}: ${(err as Error).message}`;
}

/** The rate for whichever model answered, from whichever table knows it, plus any per-request fee. */
async function priceOf(model: string): Promise<{ rate: ModelRate; fee: number }> {
  return {
    rate: model in PROVIDER_PRICING ? PROVIDER_PRICING[model] : await rateForModel(model),
    fee: requestFee(model),
  };
}


export interface AgentRunRequest {
  /** Cost attribution: the agent key, so spend per agent is answerable. */
  purpose: string;
  system: string;
  /** The task, as the first thing the agent is told. */
  prompt: string;
  tools: AgentTool[];
  effort?: Effort;
  /**
   * How demanding the task is, judged before the run by
   * `services/agents/complexity.ts`.
   *
   * When given it decides both halves of what a turn costs: the paid model on
   * every vendor of the floor (`TIER_MODELS`), and the effort, which follows
   * from it and overrides `effort`. When absent the run keeps the old answer —
   * Claude's model from the effort word, one model each on ChatGPT and Gemini —
   * which is what every caller that has not sized its work still gets.
   */
  level?: TaskLevel;
  /**
   * The least effort this run thinks at, whatever the level says. The runner
   * sets it on the first retry after a failed run — effort is raised before
   * the model is — and it only ever raises: a level whose own effort is higher
   * keeps it.
   */
  effortFloor?: Effort;
  /**
   * Asked between turns whether this run should carry on more cheaply.
   *
   * Returns the effort to drop to, or null to leave it alone. Checked where
   * `shouldStop` is checked — between turns, with the conversation whole —
   * because the effort decides which model serves the *next* turn and changing
   * it anywhere else would split one turn across two models.
   *
   * **It can only ever lower.** A callback that could raise the effort would be
   * a way to spend more than the caller budgeted for, decided by something
   * other than the caller.
   */
  easeOff?: () => Promise<Effort | null>;
  /** Called as each turn completes, so a running task shows progress. */
  onText?: (text: string) => Promise<void>;
  onToolCall?: (call: { name: string; input: Record<string, unknown>; outcome: AgentToolOutcome }) => Promise<void>;
  /**
   * Which model is serving, and every handover between them.
   *
   * These decisions were written to the server console and nowhere a person
   * could see. A run that climbs three free models and then moves through two
   * paid ones can spend minutes doing exactly that, and on the screen it is a
   * task sitting still -- until it finishes, or fails with a vendor error that
   * is the first thing anybody has been told about any vendor. Never allowed
   * to end the run: an account of the work is not the work.
   */
  onServing?: (note: string) => Promise<void>;
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
 * Every turn records what it spent the moment it is priced — one `LlmCall` row
 * per paid turn, not one per run. The single row at the end meant a run's own
 * ceiling, read from the ledger between turns, could not see a cent of what the
 * run was spending, and a process killed mid-run took every turn it had paid
 * for with it. The result still reports the task's total across resumes; each
 * turn is on the ledger once, written by the process that paid for it.
 */
export async function runAgentLoop(request: AgentRunRequest): Promise<AgentRunResult> {
  // The level, when there is one, and the effort that follows from it. Both
  // can only go down from here, once — see `easeOffIfAsked`.
  let level: TaskLevel | null = request.level ?? null;
  const efforts: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  const fromLevel = level ? effortForLevel(level) : (request.effort ?? "medium");
  let effort = request.effortFloor && efforts.indexOf(request.effortFloor) > efforts.indexOf(fromLevel) ? request.effortFloor : fromLevel;

  // Who runs this conversation, in the order they will be asked.
  //
  // **NVIDIA first**, because that is where the free models are and free
  // is the instruction: an agent turn is a job like any other, and every job
  // starts on something that costs nothing. Then the paid floor, which is the
  // best of Claude, ChatGPT and Gemini rather than one named vendor — see
  // `PAID_AGENT_CHAIN`. Only vendors with a key are in the list, so the chain
  // can only ever end at somebody who could actually have served it.
  //
  // A vendor whose key was refused recently sits its cooldown out rather than
  // costing every resume behind this one a wasted call against a dead balance.
  const candidates: AgentVendor[] = [];
  /**
   * Why the free vendor is not first, when it is not.
   *
   * Said out loud because the alternative is what actually happened on a live
   * Chief Executive run: the free vendor was absent, the line underneath announced
   * "starting on the first of 3 free model(s)", and the run then spent two paid
   * balances. Nothing anywhere said the free vendor had been skipped, so the
   * only reading available was that free models were configured and being
   * ignored.
   */
  let freeSkipped: string | null = null;
  if (!(await providerConfigured("nvidia"))) {
    freeSkipped = "No NVIDIA key is set, so there are no free models in this chain. Add one under Settings → AI models — it is where every free model lives.";
  } else if (Date.now() < nvidiaRefusedUntil) {
    const until = new Date(nvidiaRefusedUntil);
    freeSkipped =
      `NVIDIA rejected its key recently, so the free models are sitting out until ${until.toISOString().slice(11, 16)} UTC ` +
      `and this run starts on a paid vendor. Check the key under Settings → AI models.`;
  } else {
    candidates.push("nvidia");
  }
  for (const paid of PAID_AGENT_CHAIN) {
    if (await providerConfigured(paid)) candidates.push(paid);
  }
  if (candidates.length === 0) {
    throw new AnalystError(
      503,
      "No model is connected for running agents. Add an NVIDIA, Claude, ChatGPT or Gemini key under Settings → AI models — any one of them can do this.",
    );
  }
  let at = 0;
  let serving: AgentVendor = candidates[at];

  /**
   * What each vendor said on the way down the chain.
   *
   * Only the **last** vendor's failure used to reach the caller, and that is
   * how a run where Claude and ChatGPT both answered "no credit on this
   * account" and Gemini happened to be busy came out as "the model is busy" —
   * so `services/agents/retry.ts` read it as temporary and paused for five
   * minutes, six times, over a problem no amount of waiting fixes.
   *
   * The chain's own summary is the truth; the last rung is a detail of it.
   */
  const refusals: string[] = [];

  /** Set once the recovery below has been spent; a second refusal is a real failure. */
  let strippedThinking = false;

  /**
   * Say who is serving, to the console and to whoever is watching.
   *
   * One function so the two never drift apart: a handover the log knows about
   * and the timeline does not is the state this was written to end.
   */
  const saying = async (note: string) => {
    console.warn(`[agent] ${note}`);
    if (!request.onServing) return;
    try {
      await request.onServing(note);
    } catch (err) {
      console.error(`[agent] could not record who is serving: ${(err as Error).message}`);
    }
  };

  /**
   * The free models to climb, in order, and which rung we are on.
   *
   * **Three rungs ship by default**, so free-first is what happens on a
   * deployment nobody has configured. Empty only when somebody has turned free
   * models off deliberately, and then nothing below changes: the one NVIDIA
   * model is asked exactly as it always was, and a rate limit still requeues
   * the task rather than quietly moving the bill onto a paid vendor.
   *
   * With a ladder the rule is different and deliberately so. A free endpoint
   * that is busy, silent or rate-limited has not failed — it is free, and that
   * is what free capacity does at four in the afternoon. So a rung that does
   * not answer costs one short call and the next rung is asked; when the ladder
   * runs out, the paid floor finishes the run. That is the whole feature.
   */
  const ladder = await freeLadderFor("agent");
  let rung = 0;

  // Chosen from the effort rather than fixed, so a sub-agent checking a link
  // is not billed at the rate of a director deciding what to say to a
  // stranger. See `modelForVendor`.
  //
  // The first rung only when NVIDIA is the one starting. It was
  // unconditional, which was harmless while the ladder was an opt-in nobody
  // had opted into and wrong the moment it shipped switched on: a deployment
  // holding a Claude key and no NVIDIA key would open its ledger row with
  // the name of a free model it was never going to call.
  const model = serving === "nvidia" ? (ladder[0] ?? (await modelForVendor(serving, effort, level))) : await modelForVendor(serving, effort, level);

  let client: Anthropic | null = null;

  const byName = new Map(request.tools.map((tool) => [tool.name, tool]));
  const definitions: Anthropic.Beta.BetaToolUnion[] = request.tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Beta.BetaTool["input_schema"],
    // Breakpoint 1. On the last one, because it caches everything above it.
    ...(index === request.tools.length - 1 ? { cache_control: CACHE } : {}),
  }));

  // Breakpoint 2. A block rather than a bare string, because only a block can
  // carry one.
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: request.system, cache_control: CACHE }];

  const resumed = request.resume ?? null;
  const messages: Anthropic.Beta.BetaMessageParam[] = resumed?.messages
    ? [...resumed.messages]
    : [{ role: "user", content: request.prompt }];
  const narration: string[] = resumed?.narration ? [...resumed.narration] : [];
  let pendingAssistant = resumed?.pendingAssistant ?? null;
  let pendingResults: Anthropic.Beta.BetaToolResultBlockParam[] | null = resumed?.pendingResults ?? null;
  let pendingStop = resumed?.pendingStop ?? false;

  // The calls a previous process may already have made. Taken from the turn
  // being restored, before anything runs, and emptied as soon as that turn is
  // finished — see `AgentToolCallMeta`.
  const restoredCalls = new Set(
    (resumed?.pendingAssistant ?? [])
      .filter((block): block is Anthropic.Beta.BetaToolUseBlockParam => block.type === "tool_use")
      .map((block) => block.id),
  );

  // Carried in from earlier runs: these are the *task's* totals. The ledger is
  // written turn by turn, so it never needs them — an earlier process already
  // recorded the turns it paid for.
  let toolCalls = resumed?.toolCalls ?? 0;
  let inputTokens = resumed?.inputTokens ?? 0;
  let outputTokens = resumed?.outputTokens ?? 0;
  let costUsd = resumed?.costUsd ?? 0;

  let servedBy = resumed?.model ?? model;
  let stoppedBecause: AgentRunResult["stoppedBecause"] = "iteration-cap";
  let stopDetails: AgentRunResult["stopDetails"] = null;
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

  /**
   * Drops the effort for the rest of the run, once, when the caller says so.
   *
   * **It costs one cache miss and that is the trade.** The effort decides which
   * model serves a turn, and a different model is a different prompt cache — so
   * the turn after a downgrade re-pays for the whole conversation. That is
   * worth it because it happens at most once per run and every turn after it is
   * cheaper: a long task that changes model on turn nine pays one prefix and
   * saves eight. It would not be worth it per turn, which is why this only ever
   * moves in one direction and never moves back.
   */
  // The whole scale, not low to high: a retried run thinks at xhigh or max
  // (`effortFloor`), and a word missing from the list read as "already below
  // anything asked for", so the runs most likely to be near their ceiling were
  // the ones that never eased off.
  const easeOffIfAsked = async () => {
    if (!request.easeOff) return;
    let wanted: Effort | null = null;
    try {
      wanted = await request.easeOff();
    } catch {
      // A failed check is not a reason to change how a run is being paid for.
      return;
    }
    if (!wanted || efforts.indexOf(wanted) >= efforts.indexOf(effort)) return;
    // A sized run eases off a level rather than an effort word, so the model
    // and the thinking keep moving together.
    if (level) {
      const lower = levelForEffort(wanted);
      if (TASK_LEVELS.indexOf(lower) >= TASK_LEVELS.indexOf(level)) {
        // Same level, but a retry raised the thinking above the level's own:
        // give that back first. The level picks the model, so it stays put.
        const own = effortForLevel(level);
        if (efforts.indexOf(own) >= efforts.indexOf(effort)) return;
        const was = effort;
        effort = own;
        await saying(`Carrying on at ${own} effort rather than ${was} — this run is close to its ceiling.`);
        return;
      }
      const wasLevel = level;
      level = lower;
      effort = effortForLevel(lower);
      await saying(`Carrying on as a ${lower} task rather than ${wasLevel} — this run is close to its ceiling.`);
      return;
    }
    const was = effort;
    effort = wanted;
    await saying(`Carrying on at ${wanted} effort rather than ${was} — this run is close to its ceiling.`);
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

  // Records nothing. Every turn wrote its own row as it was priced, so an
  // ending — finished, stopped, capped or interrupted — has nothing left to add
  // to the ledger.
  const finish = (): AgentRunResult => {
    return {
      text: narration.at(-1) ?? "",
      narration,
      toolCalls,
      inputTokens,
      outputTokens,
      costUsd,
      model: servedBy,
      stoppedBecause,
      ...(stopDetails ? { stopDetails } : {}),
      state: state(),
    };
  };

  /** Stopped on request, with its place kept. Not a failure and not an error. */
  const interrupted = async (): Promise<AgentRunResult> => {
    stoppedBecause = "interrupted";
    await checkpoint();
    return finish();
  };

  // Said before the first turn rather than after it. The first model call is
  // where a run spends its longest silence -- a free rung can sit for two
  // minutes before it answers or gives up -- and "NVIDIA, on
  // <slug>" is the difference between a screen that is working and a screen
  // that has hung.
  // `serving === "nvidia"` is the whole of the guard, and it was missing.
  //
  // The ladder is a list of NVIDIA model ids. Announcing it while Anthropic
  // is serving is not a cosmetic slip: it is the sentence somebody reads when
  // they are trying to work out why a run cost money, and it says the opposite
  // of what happened. The `model` line three lines below has carried this exact
  // guard since the ladder shipped; this one did not.
  if (freeSkipped) await saying(freeSkipped);
  await saying(
    serving === "nvidia" && ladder.length > 0
      ? `${PROVIDERS[serving].name}, starting on the first of ${ladder.length} free model(s): ${ladder[0]}.`
      : `${PROVIDERS[serving].name}, on ${model}${level ? ` — the ${level} model` : ""}.`,
  );
  // What a sized run will cost if the free models cannot finish it, said
  // before it happens. Without it the first anybody hears of the level is a
  // handover line naming a model they did not expect.
  if (level && serving === "nvidia") {
    const paid = candidates.find((vendor): vendor is PaidProvider => vendor !== "nvidia");
    if (paid) {
      await saying(`Sized as a ${level} task, so if the free models cannot finish it, ${PROVIDERS[paid].name} takes over on ${await modelForLevel(paid, level)}.`);
    }
  }

  while (iteration < MAX_ITERATIONS) {
    if (await stopWanted()) return interrupted();
    // Between turns, beside the stop check and for the same reason: this is a
    // point where the conversation is whole.
    await easeOffIfAsked();

    // Before the turn is built, so what is sent and what is checkpointed are
    // the same conversation. Measured once and handed to both trims: the
    // shortening goes first because it is the gentler of the two, and letting
    // go only has work left when shortening could not bring the pile under its
    // own, higher ceiling. Neither runs for a turn restored half-way through —
    // that turn was sized when it was sent, and its own reasoning sits on top
    // of exactly the messages an edit would change.
    if (!pendingAssistant) {
      const size = JSON.stringify(messages).length;
      const shortened = compactOldToolResults(messages, size);
      if (shortened > 0) {
        await saying(`Shortened ${shortened} older tool answer(s) to their first lines to keep this conversation affordable — what was concluded from them is still in the replies.`);
      }
      const released = releaseOldAnswers(messages, shortened > 0 ? undefined : size);
      if (released > 0) {
        await saying(`Let go of ${released} older tool answer(s) to keep this conversation affordable — what was concluded from them is still in the replies.`);
      }
    }

    // Two ways into a turn: a fresh one from the model, or the half-finished
    // one a previous process left behind. The second skips the model call —
    // that turn has already been paid for once.
    let assistantContent: Anthropic.Beta.BetaContentBlockParam[];

    if (pendingAssistant) {
      assistantContent = pendingAssistant;
    } else {
      let response: WireTurn;
      // The wall clock of this one vendor call, for its ledger row — waiting
      // for capacity included, because that is part of what the turn took.
      const callStartedAt = Date.now();

      // One turn, from whoever is serving — and **one** place below that
      // decides what a failure means.
      //
      // It used to be two: OpenRouter had its own failover rules and Anthropic
      // had its own, and the two disagreed about which statuses are worth
      // routing around. That is how a live Chief Executive task died on a 404
      // with a connected Claude sitting unasked. With four vendors in the
      // chain, four copies of that decision would be four ways to be wrong, so
      // the wires differ and the judgement does not.
      try {
        if (serving === "anthropic") {
          if (!client) {
            const apiKey = await analystKey();
            if (!apiKey) {
              throw new AnalystError(503, "No Anthropic API key is set. Add one under Settings → AI models before an agent can work.");
            }
            client = new Anthropic({ apiKey, maxRetries: currentWebsiteWork() ? 0 : 2 });
          }
          const anth = client;
          // Resolved here, for this vendor, rather than taken from the `model`
          // the run started with.
          //
          // That was a real defect and an invisible one. `model` is decided
          // once from whoever is first in `candidates`, so on every handover —
          // a refused key, an empty balance, a retired slug, an exhausted free
          // ladder — Anthropic was being asked for a free OpenRouter id. The
          // whole point of the handover is to save a run, and it would have
          // failed at the first turn on the model name.
          //
          // It survived because the harness's fake Anthropic echoes a Claude
          // model whatever it is asked for, so the assertion "Claude finished
          // the run" passed while the request said otherwise.
          // `checks/agentLoopNvidia.ts` now reads the model out of the
          // *request body*, which is the only place the truth was.
          const claudeModel = await modelForVendor("anthropic", effort, level);
          const send = (withFallbacks: boolean) => withModelCapacity(async () => {
            await beforeWebsiteExternalAction();
            return anth.beta.messages.create({
              model: claudeModel,
              max_tokens: MAX_TOKENS,
              system,
              // Opus 5 thinks by default; asked for explicitly so the setting is
              // visible here rather than inherited. Summarised, because the
              // reasoning is worth showing on a task somebody is watching.
              thinking: { type: "adaptive", display: "summarized" },
              output_config: { effort },
              tools: definitions,
              messages: withCacheBreakpoints(withoutThoughtSignatures(messages)),
              ...(withFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
            });
          });

          try {
            response = await send(fallbacksAvailable);
          } catch (err) {
            if (!fallbacksAvailable || !rejectedTheBeta(err)) throw err;
            // One wasted request, once per process, then never again.
            fallbacksAvailable = false;
            console.warn(`[agent] server-side fallbacks unavailable on this key: ${(err as Error).message}`);
            response = await send(false);
          }
        } else if (serving === "gemini") {
          response = await geminiTurn({
            apiKey: (await providerKey("gemini")) ?? "",
            model: await modelForVendor("gemini", effort, level),
            system: request.system,
            messages,
            tools: request.tools,
            effort,
          });
        } else {
          response = await chatCompletionsTurn({
            vendor: serving,
            apiKey: (await providerKey(serving)) ?? "",
            // The rung when NVIDIA is climbing one; this vendor's own
            // model otherwise.
            model:
              serving === "nvidia"
                ? (ladder[rung] ?? (await modelForVendor("nvidia", effort, level)))
                : await modelForVendor(serving, effort, level),
            system: request.system,
            messages,
            tools: request.tools,
            effort,
            free: serving === "nvidia" && ladder.length > 0,
          });
        }
      } catch (err) {
        const status = statusOf(err);
        const climbing = serving === "nvidia" && ladder.length > 0;

        // Claude refused reasoning it wrote earlier in this conversation,
        // because something above it changed. The runner keeps the prompt and
        // tools a thinking conversation started with, and nothing here
        // rewrites above a thinking block, so this is the backstop for
        // whatever still slipped through. Handing it on would move the run to
        // a paid vendor for a fault in our own history, and a 400 retried as
        // it stands fails identically for ever. So: Anthropic's one-time
        // recovery — every thinking block out, the same model asked again,
        // once — and the strip saved at once, so no later turn or resume sends
        // the refused blocks back.
        if (serving === "anthropic" && !strippedThinking && thinkingBindingRefused(err)) {
          strippedThinking = true;
          const stripped = withoutThinking(messages);
          messages.splice(0, messages.length, ...stripped);
          await saying(
            "Claude would not accept this conversation's earlier reasoning — something above it changed since it was written — so it carries on without that reasoning, on the same model. Its text and tool calls are all still there.",
          );
          await checkpoint();
          continue;
        }

        // A rung that did not serve, with rungs left. Not a failure of
        // anything: the next free model is asked and the conversation is
        // untouched, because nothing was spent and nothing was said.
        //
        // Key-level statuses are excluded — a wrong key, a banned account or
        // an empty balance is true of every model on the account, so climbing
        // would be three calls into the same wall.
        if (climbing && !KEY_LEVEL_STATUSES.includes(status) && rung + 1 < ladder.length) {
          await saying(`${ladder[rung]} did not serve (${status}) — trying ${ladder[rung + 1]}.`);
          rung += 1;
          continue;
        }

        // Whoever is next, if anybody is. Three rules decide whether this
        // failure is worth handing on:
        //
        // 1. **An exhausted free ladder always hands on**, including on a 429.
        //    Three free models have said no; waiting out a queue is right when
        //    the vendor is the only one who can do this and wrong when a paid
        //    floor is sitting there connected.
        // 2. **NVIDIA with free models switched off keeps the old rule** —
        //    only a status that means it cannot serve the request at all moves
        //    the work, so a rate limit still requeues the task rather than
        //    quietly moving the bill onto a paid vendor. Somebody who turned
        //    free off did not thereby ask to spend more.
        // 3. **A paid vendor hands on for anything**, rate limits included.
        //    That is the whole point of a floor of three: the second is asked
        //    precisely because the first is busy. When there is nobody left, a
        //    429 still comes out as a 429 and the task resumes.
        const handsOn = climbing || serving !== "nvidia" || CANNOT_SERVE_STATUSES.includes(status);
        const next = handsOn ? candidates[at + 1] : undefined;

        if (next) {
          // A refused key sits its cooldown out, so the resumes queued behind
          // this run start at the floor instead of each paying one call into
          // the same wall.
          if (serving === "nvidia" && KEY_LEVEL_STATUSES.includes(status)) {
            nvidiaRefusedUntil = Date.now() + NVIDIA_COOLDOWN_MS;
          }
          refusals.push(`${PROVIDERS[serving].name}: ${describeTurnFailure(serving, status, climbing ? ladder[rung] : await modelForVendor(serving, effort, level), err, true)}`);
          await saying(
            climbing
              ? `every free model was tried (last: ${(err as Error).message}) — ${PROVIDERS[next].name} takes the rest of this run.`
              : `${PROVIDERS[serving].name} could not serve this (${(err as Error).message}) — ${PROVIDERS[next].name} takes the rest of this run.`,
          );
          at += 1;
          serving = next;
          continue;
        }

        const askedFor = climbing ? ladder[rung] : await modelForVendor(serving, effort, level);
        const last = describeTurnFailure(serving, status, askedFor, err);
        // Everybody who was asked, in one sentence, with the skipped free
        // vendor included. This is the string `retry.ts` classifies, and a
        // classification made on one rung of a four-rung chain is a guess.
        //
        // `freeSkipped` is deliberately **not** appended here, though it reads
        // as though it belongs. That advisory ends "under Settings → AI
        // models", which is this codebase's own signal to `retry.ts` that a
        // person must go and configure something — so gluing it onto every
        // failure would turn every genuine rate limit on a deployment with no
        // NVIDIA key into a blocked task instead of a five-minute pause.
        // It is said as its own line at the top of the run, which is where
        // somebody reads it.
        const message =
          refusals.length > 0
            ? `Every model connected for this was asked and none could serve it. ${[...refusals, `${PROVIDERS[serving].name}: ${last}`].join(" ")}`
            : last;
        // The conversation up to here is intact and worth keeping: a rate
        // limit is a task that resumes in five minutes, not one that starts
        // again.
        await checkpoint();
        // One row saying the run ended on a failure, at no cost: nothing was
        // paid for this call, and every turn before it already has its own
        // row, so a sum over the ledger still comes to what was spent and a
        // count of failed calls still sees this one.
        await recordLlmCall({
          purpose: request.purpose,
          model: askedFor,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          durationMs: Date.now() - callStartedAt,
          effort,
          ok: false,
          error: message,
        });
        throw new AnalystError(status === 429 ? 429 : status === 503 ? 503 : 502, message);
      }

      // Priced before the answer is judged: everything from here has been paid for.
      const durationMs = Date.now() - callStartedAt;
      servedBy = response.model;
      const { rate, fee } = await priceOf(response.model);
      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      };
      // The per-request fee rides along for the vendors that charge one; zero
      // everywhere else.
      const turnCost = costOf(rate, usage) + fee;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      costUsd += turnCost;

      const sawToolUse = response.content.some((block) => block.type === "tool_use");
      const sawText = response.content.some((block) => block.type === "text" && block.text.trim().length > 0);
      // Said nothing and asked for nothing. Includes a turn cut off at
      // `max_tokens` before it wrote a word — what a reasoning model does when
      // its thinking spends the whole budget — which is the same empty answer
      // as any other and is handled the same way, below.
      const empty = !sawText && !sawToolUse && response.stop_reason !== "pause_turn";

      // On the ledger now, before anything else can happen to the run: the
      // task's own ceiling reads this table between turns, and a process that
      // dies on the next line has still paid for this one. A turn that refused,
      // came back empty or was cut off is written as a failure with its own
      // cost — the money was spent whatever came back.
      const turnFailure =
        response.stop_reason === "refusal"
          ? "refusal"
          : empty
            ? `answered with nothing (stop_reason: ${response.stop_reason})`
            : response.stop_reason === "max_tokens"
              ? "truncated"
              : undefined;
      await recordLlmCall({
        purpose: request.purpose,
        model: response.model,
        ...usage,
        costUsd: turnCost,
        durationMs,
        effort,
        stopReason: response.stop_reason,
        ok: turnFailure === undefined,
        error: turnFailure,
      });

      if (response.stop_reason === "refusal") {
        stoppedBecause = "refusal";
        if (response.stop_details) {
          stopDetails = { category: response.stop_details.category ?? null, explanation: response.stop_details.explanation ?? null };
        }
        // Whoever declined, by name. Never routed around — see
        // `CANNOT_SERVE_STATUSES`.
        narration.push(`${PROVIDERS[serving].name} declined this task. Rephrase the brief, or do this one by hand.`);
        return finish();
      }

      // A turn that said nothing and asked for nothing is not a real answer —
      // it is what a busy or degraded model does instead of a clean error,
      // and this loop used to accept it as "finished" because nothing threw.
      // The result was a task that reports success while having done, and
      // said, nothing at all. Treated exactly like a rung or vendor that
      // failed: climb the ladder, then hand to the floor, and only give up
      // when nobody is left to ask.
      //
      // Before the `max_tokens` ending rather than after it. A free reasoning
      // rung that spent the flat token budget thinking answers
      // `finish_reason: "length"` with nothing in it, and that used to end the
      // run as "truncated" with two more rungs and a paid floor unasked. The
      // ceiling is not raised to avoid it: a model that rejects a larger
      // `max_tokens` answers 400, which climbs to a paid vendor instead.
      if (empty) {
        if (serving === "nvidia" && ladder.length > 0 && rung + 1 < ladder.length) {
          await saying(`${ladder[rung]} answered with nothing (stop_reason: ${response.stop_reason}) — trying ${ladder[rung + 1]}.`);
          rung += 1;
          continue;
        }
        // Handed on down the same chain a thrown failure uses, rather than
        // only from the free vendor to Claude. A paid vendor that answers with
        // nothing has failed exactly as one that throws has, and the reason
        // there are three of them is so the next one is asked.
        const nextAfterSilence = candidates[at + 1];
        if (nextAfterSilence) {
          await saying(
            `${PROVIDERS[serving].name} answered with nothing (stop_reason: ${response.stop_reason}) — ` +
              `${PROVIDERS[nextAfterSilence].name} takes the rest of this run.`,
          );
          at += 1;
          serving = nextAfterSilence;
          continue;
        }
        // Nobody left to ask. A quiet, empty "success" would be worse than
        // saying so: the conversation is kept, exactly as the other failures
        // above keep it, so running this again continues rather than starts over.
        // No second ledger row: this turn's own row is already the failure.
        const message = `The model finished this turn without saying anything or calling a tool (stop_reason: ${response.stop_reason}). Likely a busy or degraded model rather than a real answer.`;
        await checkpoint();
        throw new AnalystError(502, message);
      }

      // Cut off part-way through an answer or a tool call. Not handed on: what
      // was written is half of something, and the next model would be asked to
      // agree with it.
      if (response.stop_reason === "max_tokens") {
        stoppedBecause = "truncated";
        narration.push("The reply ran out of room before finishing.");
        return finish();
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
        return finish();
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

      if (!sawToolUse) {
        // Said something, but not end_turn and asked for no tool — nothing
        // further will happen. (The empty case — neither text nor a tool —
        // was already handled above.)
        stoppedBecause = "finished";
        return finish();
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
        outcome = await tool.run((call.input ?? {}) as Record<string, unknown>, { replay: restoredCalls.has(call.id) });
      } catch (err) {
        outcome = { content: `That call failed: ${(err as Error).message}`, isError: true };
      }

      await request.onToolCall?.({ name: call.name, input: (call.input ?? {}) as Record<string, unknown>, outcome });

      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        ...(outcome.isError ? { is_error: true } : {}),
        content: clipToolResult(outcome.content),
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
    // The restored turn is over, so nothing after this is a replay of it.
    restoredCalls.clear();
    // Counted here rather than in a loop header: the turn is over, so what a
    // resume from this point would do next is the *next* turn, and a
    // checkpoint that says otherwise hands the task a free iteration every
    // time it is interrupted.
    iteration += 1;
    await checkpoint();

    if (stopAfterThisTurn) {
      stoppedBecause = "stopped-by-tool";
      return finish();
    }
  }

  return finish();
}
async function chatCompletionsTurn(args: Parameters<typeof chatCompletionsTurnUnbounded>[0]): Promise<WireTurn> {
  return withModelCapacity(async () => { await beforeWebsiteExternalAction(); return chatCompletionsTurnUnbounded(args); });
}

async function geminiTurn(args: Parameters<typeof geminiTurnUnbounded>[0]): Promise<WireTurn> {
  return withModelCapacity(async () => { await beforeWebsiteExternalAction(); return geminiTurnUnbounded(args); });
}
