import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./prisma.js";
import { SETTING, getSetting } from "./settings.js";
import { costOf, defaultModel, rateFor } from "./claudePricing.js";

/**
 * One way to call Claude.
 *
 * Three features ask Claude for structured judgement — reading a lead
 * spreadsheet, drafting an email, writing a proposal — and each grew its own
 * copy of the same forty lines: construct a client, name the model, map four
 * kinds of error, check for a refusal, pull the text block out, parse it. The
 * copies had already drifted (one asked for `medium` effort, one for `high`,
 * one allowed half the output tokens of the others), and none of them recorded
 * what the call cost, because there was nowhere to record it.
 *
 * This is that shared middle. Callers keep their own prompts, their own
 * schemas and — deliberately — their own error wording, because "the drafter
 * declined to write this one" and "the analyst declined to read this file"
 * belong to the feature, not to the transport.
 *
 * Every call is written to LlmCall whether it succeeded or not: a burst of
 * rate-limit failures costs nothing and is exactly the thing you want to see.
 */

/** How hard to think. `high` is the API default; callers pick per job. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Opus 5 thinks by default, and `max_tokens` caps thinking *plus* the reply,
 * so a budget sized for the answer alone truncates mid-sentence. 8000 leaves
 * room for both on the short structured outputs this app asks for.
 */
const DEFAULT_MAX_TOKENS = 8000;

/**
 * Opus 5's safety classifiers decline a small number of legitimate requests —
 * a proposal that catalogues what is wrong with a company's TLS and DNS is
 * exactly the shape that trips them. This re-serves a declined request on
 * Anthropic's recommended fallback inside the same call, which is the
 * difference between a working draft and "the writer declined this one".
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Turned off for the rest of the process if Anthropic rejects the beta. A key
 * whose organisation can't use server-side fallbacks must degrade to a plain
 * call — losing the retry is a small thing, and losing the drafter, the
 * proposal writer and the sheet analyst all at once is not.
 */
let fallbacksAvailable = true;

function rejectedTheBeta(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  const message = err.message.toLowerCase();
  return message.includes("fallback") || message.includes("beta");
}

/** The six failures a caller may want to phrase in its own words. */
export type FailureKind = "noKey" | "auth" | "rate" | "refusal" | "empty" | "truncated" | "parse";

const DEFAULT_MESSAGES: Record<FailureKind, string> = {
  noKey: "No Anthropic API key is set. Add one under Settings → AI analyst.",
  auth: "Anthropic rejected the API key. Check it under Settings → AI analyst.",
  rate: "Anthropic is rate-limiting this key. Try again in a minute.",
  refusal: "Claude declined this request. Rephrase it, or do this one by hand.",
  empty: "Claude returned nothing. Try again.",
  truncated: "Claude ran out of room before finishing. Try again.",
  parse: "Claude's reply could not be read. Try again.",
};

export interface ClaudeRequest {
  /** Cost attribution: "email.draft", "proposal.write", "sheet.analyse". */
  purpose: string;
  system: string;
  /**
   * Passed as a function so nothing is assembled before the key check. A
   * missing key is a sentence the Owner can act on; a crash inside prompt
   * building on the way to discovering there's no key is not.
   */
  prompt: () => string;
  /** JSON Schema. Must be closed (`additionalProperties: false`) and fully `required`. */
  schema: Record<string, unknown>;
  effort?: Effort;
  maxTokens?: number;
  /** Overrides the configured default. Rarely needed. */
  model?: string;
  /** Per-caller wording for the failures a person will read. */
  messages?: Partial<Record<FailureKind, string>>;
}

export interface ClaudeResult<T> {
  data: T;
  /** The model that actually served this, which a fallback can change. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Kept as `AnalystError` rather than renamed: it is thrown through five routes
 * that read `.status`, and the name is not worth a churn commit.
 */
export class AnalystError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AnalystError";
    this.status = status;
  }
}

export async function analystKey(): Promise<string | null> {
  return getSetting(SETTING.ANTHROPIC_KEY);
}

export async function analystConfigured(): Promise<boolean> {
  return Boolean(await analystKey());
}

/** Records the call. Never throws — accounting must not fail the feature. */
async function record(entry: {
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  effort?: string;
  stopReason?: string | null;
  ok: boolean;
  error?: string;
}) {
  try {
    await prisma.llmCall.create({
      data: {
        purpose: entry.purpose,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheCreationTokens: entry.cacheCreationTokens,
        costUsd: entry.costUsd.toFixed(6),
        durationMs: entry.durationMs,
        effort: entry.effort ?? null,
        stopReason: entry.stopReason ?? null,
        ok: entry.ok,
        error: entry.error ?? null,
      },
    });
  } catch (err) {
    console.error("[claude] could not record spend:", (err as Error).message);
  }
}

export async function callClaude<T>(request: ClaudeRequest): Promise<ClaudeResult<T>> {
  const say = (kind: FailureKind) => request.messages?.[kind] ?? DEFAULT_MESSAGES[kind];

  const apiKey = await analystKey();
  if (!apiKey) throw new AnalystError(503, say("noKey"));

  const model = request.model ?? (await defaultModel());
  const effort = request.effort ?? "medium";
  const startedAt = Date.now();

  // Failures are recorded too, so every exit below goes through this.
  const fail = async (status: number, message: string, stopReason?: string | null) => {
    await record({
      purpose: request.purpose,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      effort,
      stopReason,
      ok: false,
      error: message,
    });
    return new AnalystError(status, message);
  };

  const client = new Anthropic({ apiKey });
  const prompt = request.prompt();

  const send = (withFallbacks: boolean) =>
    client.beta.messages.create({
      model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: request.system,
      output_config: {
        effort,
        format: { type: "json_schema", schema: request.schema },
      },
      ...(withFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      messages: [{ role: "user", content: prompt }],
    });

  let response;
  try {
    try {
      response = await send(fallbacksAvailable);
    } catch (err) {
      if (!fallbacksAvailable || !rejectedTheBeta(err)) throw err;
      // One wasted request, once per process, and then never again.
      fallbacksAvailable = false;
      console.warn(`[claude] server-side fallbacks unavailable on this key — continuing without them: ${(err as Error).message}`);
      response = await send(false);
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw await fail(400, say("auth"));
    if (err instanceof Anthropic.RateLimitError) throw await fail(429, say("rate"));
    if (err instanceof Anthropic.APIError) {
      throw await fail(err.status ?? 502, `${request.purpose} failed: ${err.message}`);
    }
    throw await fail(502, `Could not reach Anthropic: ${(err as Error).message}`);
  }

  // Everything from here on cost money, so price it before deciding whether
  // the answer is usable.
  const usage = response.usage;
  const rate = await rateFor(response.model);
  const tokens = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
  const costUsd = costOf(rate, tokens);

  const spent = async (ok: boolean, error?: string) =>
    record({
      purpose: request.purpose,
      model: response.model,
      ...tokens,
      costUsd,
      durationMs: Date.now() - startedAt,
      effort,
      stopReason: response.stop_reason,
      ok,
      error,
    });

  const rejected = async (status: number, message: string) => {
    await spent(false, message);
    return new AnalystError(status, message);
  };

  // A refusal is a 200 with nothing usable in it — check before reading.
  if (response.stop_reason === "refusal") throw await rejected(422, say("refusal"));

  // Reaching the token cap leaves valid-looking JSON cut off mid-string, which
  // would otherwise surface as an unexplained parse failure.
  if (response.stop_reason === "max_tokens") throw await rejected(502, say("truncated"));

  const text = response.content.find((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")?.text ?? "";
  if (!text.trim()) throw await rejected(502, say("empty"));

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw await rejected(502, say("parse"));
  }

  await spent(true);
  return { data, model: response.model, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, costUsd };
}

/** Checks a key works before it is stored, the same way the Apify token is. */
export async function verifyKey(apiKey: string): Promise<{ model: string }> {
  const client = new Anthropic({ apiKey });
  const id = await defaultModel();
  try {
    const model = await client.models.retrieve(id);
    return { model: model.display_name ?? model.id };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AnalystError(400, "Anthropic rejected that API key.");
    if (err instanceof Anthropic.APIError) throw new AnalystError(err.status ?? 502, err.message);
    throw new AnalystError(502, `Could not reach Anthropic: ${(err as Error).message}`);
  }
}
