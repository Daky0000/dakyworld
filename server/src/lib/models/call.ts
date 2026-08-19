import { AnalystError, callClaude, type Effort, type FailureKind, type PromptImage } from "../claude.js";
import { costOf, rateFor, type ModelRate } from "../claudePricing.js";
import { recordLlmCall } from "../llmLedger.js";
import { SETTING, getSetting } from "../settings.js";
import {
  JOBS,
  PROVIDERS,
  PROVIDER_PRICING,
  imageModel,
  providerKey,
  providerModel,
  requestFee,
  routeFor,
  type ModelJob,
  type ProviderKey,
} from "./registry.js";

/**
 * One way to call a model, whoever is serving it.
 *
 * `callClaude` already answers "ask a question, get structured data back" and
 * this deliberately keeps the same shape — a caller that swaps `callClaude`
 * for `callModel` changes one word and a `job`. What it adds is that the
 * vendor is no longer part of the call: the caller names the *job* and the
 * routing decides who does it, so moving every piece of writing in the system
 * from one vendor to another is a settings change rather than a diff.
 *
 * **Every provider is spoken to over `fetch`, not an SDK.** Three more SDKs
 * would be three more dependency trees, three more release cadences and three
 * more ways for a transitive package to break a deploy, in exchange for
 * wrapping one HTTP POST each. The one exception is Anthropic, which keeps its
 * SDK because the agent loop needs streaming, tool use and thinking blocks —
 * things worth a dependency.
 *
 * **Structured output is the contract, not a hope.** All three vendors support
 * a JSON schema on the response, in three different shapes; each adapter below
 * translates the one schema the caller wrote into the shape its vendor wants.
 * A caller never sees the difference.
 */

/** The base URLs, overridable so the whole layer can be pointed at a local stub. */
const BASE = {
  openai: process.env.OPENAI_BASE_URL?.replace(/\/$/, "") || "https://api.openai.com/v1",
  gemini: process.env.GEMINI_BASE_URL?.replace(/\/$/, "") || "https://generativelanguage.googleapis.com/v1beta",
  perplexity: process.env.PERPLEXITY_BASE_URL?.replace(/\/$/, "") || "https://api.perplexity.ai",
};

/** Long enough for a page of HTML, short enough that a hung vendor doesn't hold a task open. */
const TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOKENS = 8000;

/**
 * Perplexity's floor. Asking for fewer is a 400, not a short answer.
 *
 * Nothing this app asks for is anywhere near it, but a caller is free to pass
 * `maxTokens`, and a limit that turns into "that provider rejected the API
 * key" is the worst possible way to find out.
 */
const PERPLEXITY_MIN_TOKENS = 16;

const DEFAULT_MESSAGES: Record<FailureKind, string> = {
  noKey: "No model is connected for this. Add a key under Settings → AI models.",
  auth: "That model provider rejected the API key. Check it under Settings → AI models.",
  rate: "The model provider is rate-limiting this key. Try again in a minute.",
  refusal: "The model declined this request. Rephrase it, or do this one by hand.",
  empty: "The model returned nothing. Try again.",
  truncated: "The model ran out of room before finishing. Try again.",
  parse: "The model's reply could not be read. Try again.",
};

export interface ModelRequest {
  /** Cost attribution: "content.draft", "proposal.write", "content.humanise". */
  purpose: string;
  /** What is being asked for. The routing turns this into a vendor. */
  job: ModelJob;
  system: string;
  /** A function, so nothing is assembled before the key check — same as callClaude. */
  prompt: () => string;
  /** JSON Schema. Closed (`additionalProperties: false`) and fully `required`. */
  schema: Record<string, unknown>;
  effort?: Effort;
  maxTokens?: number;
  /** Overrides the routing for one call. Rarely wanted — the point is not to name a vendor. */
  provider?: ProviderKey;
  messages?: Partial<Record<FailureKind, string>>;
  /** Perplexity only: how recent a source has to be to count. */
  recency?: "day" | "week" | "month" | "year";
  /**
   * Perplexity only: the domains it may search, at most ten.
   *
   * This is what turns "find some design inspiration" into "find it on these
   * four sites" — a question answered from the whole web comes back with
   * whatever a content farm wrote about web design in 2019, and the entire
   * point of naming sources is that a person chose them.
   */
  searchDomains?: string[];
  /**
   * Pictures to look at alongside the prompt — job `vision`, in practice.
   *
   * Only the vendors that declare `vision` are ever routed a job that sends
   * these, so an adapter that ignores them is not a silent downgrade: it is
   * unreachable. Perplexity's is, deliberately.
   */
  images?: PromptImage[];
}

export type { PromptImage };

export interface ModelResult<T> {
  data: T;
  /** Who actually served it — which is not always who was asked. */
  provider: ProviderKey;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /**
   * What it read, when the vendor searched. Present on Perplexity and empty
   * everywhere else — a claim checked against nothing is not checked.
   */
  sources: { title: string; url: string; date?: string | null }[];
  /** Set when the chosen vendor was unavailable and something else stepped in. */
  fallbackNote: string | null;
}

// --- Pricing ----------------------------------------------------------------

function readOverrides(raw: string | null): Record<string, ModelRate> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[models] models.pricing is not valid JSON — using the built-in rates.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: Record<string, ModelRate> = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { inputPerMTok, outputPerMTok } = value as Record<string, unknown>;
    if (typeof inputPerMTok !== "number" || typeof outputPerMTok !== "number") continue;
    if (!Number.isFinite(inputPerMTok) || !Number.isFinite(outputPerMTok)) continue;
    if (inputPerMTok < 0 || outputPerMTok < 0) continue;
    out[model] = { inputPerMTok, outputPerMTok };
  }
  return out;
}

/**
 * The rate for any model from any vendor.
 *
 * Falls through to the Claude table last, which also supplies the "unknown
 * model costs the most we have ever seen" floor — an unpriced model reading as
 * free is how a budget ceiling gets bypassed without anybody choosing to.
 */
export async function rateForModel(model: string): Promise<ModelRate> {
  const overrides = readOverrides(await getSetting(SETTING.MODEL_PRICING));
  return overrides[model] ?? PROVIDER_PRICING[model] ?? rateFor(model);
}

// --- HTTP -------------------------------------------------------------------

interface HttpFailure {
  status: number;
  kind: FailureKind;
  detail: string;
}

class ProviderError extends Error {
  failure: HttpFailure;
  constructor(failure: HttpFailure) {
    super(failure.detail);
    this.failure = failure;
  }
}

/**
 * One POST, with the four failures a caller cares about separated out.
 *
 * A 401 and a 429 mean completely different things to whoever is reading the
 * message — one is "check the key you pasted", the other is "wait a minute" —
 * so they are told apart here rather than in each adapter.
 */
async function post(url: string, headers: Record<string, string>, body: unknown, vendor: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    throw new ProviderError({
      status: aborted ? 504 : 502,
      kind: aborted ? "empty" : "empty",
      detail: aborted ? `${vendor} did not answer in time.` : `Could not reach ${vendor}: ${(err as Error).message}`,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    // Vendors put the useful sentence in different places; the raw body is the
    // one thing all three definitely have.
    const detail = extractError(text) ?? text.slice(0, 300);
    throw new ProviderError({
      status: response.status,
      kind: response.status === 401 || response.status === 403 ? "auth" : response.status === 429 ? "rate" : "empty",
      detail: `${vendor} returned ${response.status}: ${detail}`,
    });
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderError({ status: 502, kind: "parse", detail: `${vendor} returned something that was not JSON.` });
  }
}

function extractError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    /* not JSON — the caller falls back to the raw body */
  }
  return null;
}

// --- What every adapter returns ---------------------------------------------

interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  sources: { title: string; url: string; date?: string | null }[];
  /** True when the vendor stopped because it hit the token cap. */
  truncated: boolean;
}

// --- OpenAI -----------------------------------------------------------------

/**
 * Chat completions rather than the newer Responses API.
 *
 * Both work; this one has the settled shape for strict JSON schema output and
 * reports usage in the same two fields it has for years, which is what the
 * ledger needs. There is nothing this app asks a model for that Responses can
 * do and this cannot.
 */
async function callOpenAI(apiKey: string, model: string, request: ModelRequest): Promise<Completion> {
  const body = await post(
    `${BASE.openai}/chat/completions`,
    { authorization: `Bearer ${apiKey}` },
    {
      model,
      max_completion_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: openAiContent(request) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", strict: true, schema: request.schema },
      },
    },
    "OpenAI",
  );

  const choice = (body.choices as { message?: { content?: string }; finish_reason?: string }[] | undefined)?.[0];
  const usage = (body.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
  return {
    text: choice?.message?.content ?? "",
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    sources: [],
    truncated: choice?.finish_reason === "length",
  };
}

/**
 * A user turn for OpenAI: a bare string when there is nothing to look at, and
 * the parts array when there is. Both are valid; the string keeps the common
 * case reading the way it always has.
 */
function openAiContent(request: ModelRequest): unknown {
  if (!request.images?.length) return request.prompt();
  return [
    ...request.images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
    })),
    { type: "text", text: request.prompt() },
  ];
}

// --- Gemini -----------------------------------------------------------------

/**
 * Gemini takes the system prompt as its own field and the schema as
 * `responseSchema`, and it is stricter than the other two about what a schema
 * may contain: `additionalProperties` is rejected outright rather than
 * ignored, so it is stripped on the way in. The schema the caller wrote stays
 * exactly as written — this is a translation, not an edit.
 */
async function callGemini(apiKey: string, model: string, request: ModelRequest): Promise<Completion> {
  const body = await post(
    `${BASE.gemini}/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": apiKey },
    {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [
        {
          role: "user",
          parts: [
            ...(request.images ?? []).map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.base64 } })),
            { text: request.prompt() },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        responseMimeType: "application/json",
        responseSchema: forGemini(request.schema),
      },
    },
    "Gemini",
  );

  const candidate = (body.candidates as { content?: { parts?: { text?: string }[] }; finishReason?: string }[] | undefined)?.[0];
  const usage = (body.usageMetadata ?? {}) as { promptTokenCount?: number; candidatesTokenCount?: number };
  return {
    text: candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "",
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    sources: [],
    truncated: candidate?.finishReason === "MAX_TOKENS",
  };
}

/** Drops the keywords Gemini's schema dialect rejects. Recursive, and non-destructive. */
function forGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(forGemini);
  if (!schema || typeof schema !== "object") return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties" || key === "$schema" || key === "definitions" || key === "$defs") continue;
    out[key] = forGemini(value);
  }
  return out;
}

// --- Perplexity -------------------------------------------------------------

/**
 * Perplexity searches the live web on every call, which is the entire reason
 * it is here: "is this claim still true" and "does this page still say what we
 * quoted" are questions no offline model can answer, however good it is.
 *
 * What comes back with the answer matters as much as the answer — `citations`
 * and `search_results` are what turn "this is out of date" into something a
 * person can check, so they are carried all the way out to the caller rather
 * than summarised into prose.
 */
async function callPerplexity(apiKey: string, model: string, request: ModelRequest): Promise<Completion> {
  const body = await post(
    `${BASE.perplexity}/v1/sonar`,
    { authorization: `Bearer ${apiKey}` },
    {
      model,
      max_tokens: Math.max(request.maxTokens ?? DEFAULT_MAX_TOKENS, PERPLEXITY_MIN_TOKENS),
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt() },
      ],
      response_format: { type: "json_schema", json_schema: { schema: request.schema } },
      ...(request.recency ? { search_recency_filter: request.recency } : {}),
      // Ten is the API's ceiling; beyond that the rest are ignored silently,
      // which is the worst way to find out.
      ...(request.searchDomains?.length ? { search_domain_filter: request.searchDomains.slice(0, 10) } : {}),
    },
    "Perplexity",
  );

  const choice = (body.choices as { message?: { content?: string }; finish_reason?: string }[] | undefined)?.[0];
  const usage = (body.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };

  // Two shapes for the same thing depending on the model: a list of bare URLs,
  // or objects with a title and a date. Both are normalised here so a caller
  // never has to know which one it got.
  const results = (body.search_results as { title?: string; url?: string; date?: string }[] | undefined) ?? [];
  const citations = (body.citations as string[] | undefined) ?? [];
  const sources = results.length
    ? results.map((result) => ({ title: result.title ?? result.url ?? "", url: result.url ?? "", date: result.date ?? null }))
    : citations.map((url) => ({ title: url, url, date: null }));

  return {
    text: choice?.message?.content ?? "",
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    sources: sources.filter((source) => source.url),
    truncated: choice?.finish_reason === "length",
  };
}

// --- The one entry point ----------------------------------------------------

/**
 * Asks whoever serves this job, and returns structured data.
 *
 * Anthropic goes through `callClaude` rather than being reimplemented here:
 * the fallback beta, the refusal handling and the effort setting all live
 * there and are worth having.
 */
export async function callModel<T>(request: ModelRequest): Promise<ModelResult<T>> {
  const say = (kind: FailureKind) => request.messages?.[kind] ?? DEFAULT_MESSAGES[kind];

  const route = request.provider
    ? { chosen: request.provider, serving: request.provider, model: "", ready: true, note: null as string | null, job: request.job }
    : await routeFor(request.job);
  const serving = route.serving;

  if (serving === "anthropic") {
    const result = await callClaude<T>({
      purpose: request.purpose,
      system: request.system,
      prompt: request.prompt,
      schema: request.schema,
      effort: request.effort,
      maxTokens: request.maxTokens,
      images: request.images,
      messages: request.messages,
    });
    return {
      data: result.data,
      provider: "anthropic",
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      sources: [],
      fallbackNote: route.ready ? null : route.note,
    };
  }

  const apiKey = await providerKey(serving);
  if (!apiKey) throw new AnalystError(503, route.note ?? say("noKey"));

  const model = route.model || (await providerModel(serving));
  const startedAt = Date.now();

  const fail = async (status: number, message: string) => {
    await recordLlmCall({
      purpose: request.purpose,
      model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      effort: request.effort,
      ok: false,
      error: message,
    });
    return new AnalystError(status, message);
  };

  let completion: Completion;
  try {
    completion =
      serving === "openai"
        ? await callOpenAI(apiKey, model, request)
        : serving === "gemini"
          ? await callGemini(apiKey, model, request)
          : await callPerplexity(apiKey, model, request);
  } catch (err) {
    if (err instanceof ProviderError) {
      const kind = err.failure.kind;
      // The caller's own wording for a rate limit, which is the one failure
      // where the vendor's sentence adds nothing and the advice is always
      // "wait". Everything else keeps the vendor's own words: a 400 about a
      // schema is only useful verbatim, and a 401 mid-run has to name what it
      // actually was — Perplexity answers 401 for an account out of credits
      // as readily as for a wrong key, and "check the key" sends somebody to
      // regenerate one that was never the problem.
      const message =
        kind === "rate"
          ? say("rate")
          : kind === "auth"
            ? describeRejection(serving, err.failure.status, err.failure.detail)
            : err.failure.detail;
      throw await fail(err.failure.status, message);
    }
    throw await fail(502, `${PROVIDERS[serving].name} failed: ${(err as Error).message}`);
  }

  // Everything below here has been paid for, so it is priced before the answer
  // is judged usable.
  const rate = await rateForModel(model);
  const costUsd =
    costOf(rate, { inputTokens: completion.inputTokens, outputTokens: completion.outputTokens }) + requestFee(model);

  const spent = (ok: boolean, error?: string) =>
    recordLlmCall({
      purpose: request.purpose,
      model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      costUsd,
      durationMs: Date.now() - startedAt,
      effort: request.effort,
      ok,
      error,
    });

  const rejected = async (status: number, message: string) => {
    await spent(false, message);
    return new AnalystError(status, message);
  };

  // Hitting the cap leaves valid-looking JSON cut off mid-string, which would
  // otherwise surface as an unexplained parse failure.
  if (completion.truncated) throw await rejected(502, say("truncated"));
  if (!completion.text.trim()) throw await rejected(502, say("empty"));

  let data: T;
  try {
    data = JSON.parse(stripFence(completion.text)) as T;
  } catch {
    throw await rejected(502, say("parse"));
  }

  await spent(true);
  return {
    data,
    provider: serving,
    model,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    costUsd,
    sources: completion.sources,
    fallbackNote: route.ready ? null : route.note,
  };
}

/**
 * Takes a ```json fence off a reply.
 *
 * Every one of these vendors is asked for raw JSON and every one of them
 * occasionally wraps it in a markdown fence anyway. Six lines here beats a
 * parse failure the Owner reads as "the model returned nothing".
 */
function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

// --- Images -----------------------------------------------------------------

export interface ImageRequest {
  purpose: string;
  prompt: string;
  /** `1024x1024`, `1536x1024`, `1024x1536`, or `auto`. */
  size?: string;
  count?: number;
  quality?: "low" | "medium" | "high" | "auto";
}

export interface ImageResult {
  provider: ProviderKey;
  model: string;
  /** Data URLs. The vendor returns base64 for these models, not links. */
  images: string[];
  costUsd: number;
}

/**
 * Draws a picture.
 *
 * Separate from `callModel` because an image is not a completion in any shape
 * the text path could carry: no schema, no tokens in the sense the ledger
 * means, and bytes rather than a reply. The routing is the same idea though —
 * the caller asks for a picture and the settings decide who draws it.
 *
 * The bytes come back as base64 and go out as data URLs rather than being
 * written to disk: Railway's filesystem is ephemeral, so a file written at
 * runtime reverts on the next deploy and *looks like it worked*.
 */
export async function generateImage(request: ImageRequest): Promise<ImageResult> {
  const route = await routeFor("image");
  if (route.serving !== "openai") {
    throw new AnalystError(
      503,
      route.note ?? `Images are routed to ${PROVIDERS[route.chosen].name}, which this app cannot ask for a picture.`,
    );
  }

  const apiKey = await providerKey("openai");
  if (!apiKey) throw new AnalystError(503, "No ChatGPT key is set. Add one under Settings → AI models.");

  const model = await imageModel();
  const startedAt = Date.now();

  let body: Record<string, unknown>;
  try {
    body = await post(
      `${BASE.openai}/images/generations`,
      { authorization: `Bearer ${apiKey}` },
      {
        model,
        prompt: request.prompt,
        n: Math.min(Math.max(request.count ?? 1, 1), 4),
        size: request.size ?? "1024x1024",
        ...(request.quality && request.quality !== "auto" ? { quality: request.quality } : {}),
      },
      "OpenAI",
    );
  } catch (err) {
    const failure = err instanceof ProviderError ? err.failure : { status: 502, detail: (err as Error).message };
    await recordLlmCall({
      purpose: request.purpose,
      model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: failure.detail,
    });
    throw new AnalystError(failure.status, failure.detail);
  }

  const data = (body.data as { b64_json?: string; url?: string }[] | undefined) ?? [];
  const usage = (body.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  const rate = await rateForModel(model);
  const costUsd = costOf(rate, { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 });

  await recordLlmCall({
    purpose: request.purpose,
    model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    costUsd,
    durationMs: Date.now() - startedAt,
    ok: data.length > 0,
    error: data.length > 0 ? undefined : "The image service returned no pictures.",
  });

  return {
    provider: "openai",
    model,
    images: data
      .map((entry) => (entry.b64_json ? `data:image/png;base64,${entry.b64_json}` : (entry.url ?? "")))
      .filter(Boolean),
    costUsd,
  };
}

// --- Verifying a key --------------------------------------------------------

/**
 * Checks a key works before it is stored, the same way the Apify token and the
 * Anthropic key are. A key that is saved and then fails on first use is a
 * support conversation; one that is refused at the moment it is pasted is a
 * typo the Owner fixes in ten seconds.
 */
export async function verifyProviderKey(provider: ProviderKey, apiKey: string): Promise<{ model: string }> {
  const definition = PROVIDERS[provider];
  const model = definition.defaultModel;

  if (provider === "anthropic") {
    const { verifyKey } = await import("../claude.js");
    return verifyKey(apiKey);
  }

  try {
    if (provider === "openai") {
      // The model list is the cheapest authenticated call there is — no tokens,
      // no charge, and it fails on exactly the thing being checked.
      const response = await fetch(`${BASE.openai}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!response.ok) throw new ProviderError({ status: response.status, kind: "auth", detail: await response.text() });
      return { model: (await providerModel(provider)) || model };
    }
    if (provider === "gemini") {
      const response = await fetch(`${BASE.gemini}/models`, { headers: { "x-goog-api-key": apiKey } });
      if (!response.ok) throw new ProviderError({ status: response.status, kind: "auth", detail: await response.text() });
      return { model: (await providerModel(provider)) || model };
    }
    // Perplexity has no free listing endpoint, so the check is the smallest
    // real request it will accept. It costs a fraction of a cent and is the
    // only way to find out whether the key works.
    //
    // `max_tokens` is 16 because that is Perplexity's floor — asking for 1
    // is a 400 ("max_tokens must be at least 16"), which the caller then reads
    // as a rejected key. `disable_search` keeps it off the per-search fee,
    // which is the part of a Perplexity call that actually costs money.
    const response = await fetch(`${BASE.perplexity}/v1/sonar`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: PERPLEXITY_MIN_TOKENS,
        disable_search: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    if (!response.ok) throw new ProviderError({ status: response.status, kind: "auth", detail: await response.text() });
    return { model: (await providerModel(provider)) || model };
  } catch (err) {
    if (err instanceof ProviderError) {
      const status = err.failure.status;
      const rejected = status === 401 || status === 403;
      throw new AnalystError(rejected ? 400 : status, describeRejection(provider, status, err.failure.detail));
    }
    throw new AnalystError(502, `Could not reach ${definition.vendor}: ${(err as Error).message}`);
  }
}

/**
 * What to tell the Owner when a vendor turned a key away.
 *
 * This started as `${vendor} rejected that API key.` and threw the response
 * body away, which was wrong in the one place being precise matters most: a
 * 401 does not only mean "wrong key". **Perplexity is prepaid** — it answers
 * 401 for a key that is perfectly valid on an account with no credits left, so
 * a flat "rejected that API key" sends somebody to regenerate a key that was
 * never the problem.
 *
 * So the vendor's own sentence is always carried through, and the two vendors
 * with a common non-obvious cause get that named as well. A guess is offered,
 * never asserted: what is stated as fact is only ever what the vendor said.
 */
function describeRejection(provider: ProviderKey, status: number, body: string): string {
  const definition = PROVIDERS[provider];
  const said = extractError(body)?.trim();

  if (status !== 401 && status !== 403) {
    return `${definition.vendor} returned ${status}: ${(said ?? body).slice(0, 300)}`;
  }

  // The likely cause, where one vendor has a well-known one that is not a bad key.
  const hint =
    provider === "perplexity"
      ? "Perplexity is prepaid, so it answers this for a valid key on an account with no credits as well as for a wrong one — check the balance on the API billing page before regenerating anything."
      : provider === "openai"
        ? "Check the key is from the right project, and that the project has credit."
        : null;

  return [
    `${definition.vendor} would not accept that key.`,
    said ? `It said: ${said.slice(0, 300)}` : null,
    hint,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Re-exported so callers need one import rather than two. */
export { type ModelJob, type ProviderKey } from "./registry.js";
