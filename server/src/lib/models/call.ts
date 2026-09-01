import { AnalystError, callClaude, forStructuredOutput, type Effort, type FailureKind, type PromptImage } from "../claude.js";
import { costOf, rateFor, type ModelRate } from "../claudePricing.js";
import { recordLlmCall } from "../llmLedger.js";
import { SETTING, getSetting, setSetting } from "../settings.js";
import {
  FREE_MODELS,
  JOBS,
  freeLadderFor,
  imageFunctionUrl,
  imageModelInfo,
  imageStatusUrl,
  nvidiaImageModel,
  PROVIDERS,
  PROVIDER_PRICING,
  freeModel,
  imageModel,
  isFreeModel,
  modelForJob,
  nvidiaAttempts,
  providerKey,
  providerModel,
  readFreeLadders,
  reasoningEffortFor,
  requestFee,
  routeFor,
  serveChain,
  tokensWithReasoning,
  vendorBase,
  type LadderKey,
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

/**
 * Where each vendor lives, read **per call** rather than captured at import.
 *
 * It was an object built once at module load, which is the same fact the agent
 * loop reads per call — and the two halves of the model layer disagreeing about
 * the same environment variable is the bug this shape prevents. A harness that
 * repoints a vendor between scenarios got a frozen address here and a live one
 * there, so the same fake served the agent loop and was silently bypassed by
 * the one-shot path, which then reached whatever the default host is. That is a
 * check that passes while testing nothing, and on a machine with a real key it
 * is a check that spends money.
 *
 * Now **one** function, in `registry.ts`, imported by both halves. Two correct
 * copies of the same fact is one copy away from two different facts, and this
 * pair has already been there once.
 */
const base = vendorBase;

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
  /**
   * The model whose unfinished answer this one was handed, when there was one.
   *
   * Null on the ordinary path, which is almost always. It is set when an
   * earlier attempt wrote something and then failed — cut off at the token
   * ceiling, or unreadable — and the model that eventually answered was given
   * that draft to finish rather than starting again. Surfaced rather than kept
   * internal for the same reason `fallbackNote` is: a handover nobody can see
   * is one nobody can price or fix.
   */
  continuedFrom: string | null;
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
  if (overrides[model]) return overrides[model];
  // A rung on the free ladder costs nothing, and has to be *known* to cost
  // nothing: an unpriced model falls through to the floor below, which is
  // deliberately the dearest rate we have ever seen. Left to that, a day's
  // work on free models would read on the costs screen as the most expensive
  // day this company has ever had, and every budget ceiling would trip on
  // money nobody spent. See `isFreeModel` for why the stored list is the
  // authority rather than the shape of the id.
  if (await isFreeModel(model)) return { inputPerMTok: 0, outputPerMTok: 0 };
  return PROVIDER_PRICING[model] ?? rateFor(model);
}

// --- HTTP -------------------------------------------------------------------

interface HttpFailure {
  status: number;
  kind: FailureKind;
  detail: string;
  /** What the vendor's own `Retry-After` asked for, when it sent one. */
  retryAfterMs?: number | null;
}

class ProviderError extends Error {
  failure: HttpFailure;
  constructor(failure: HttpFailure) {
    super(failure.detail);
    this.failure = failure;
  }
}

/**
 * How many times a request is worth repeating, and how long to wait.
 *
 * A rate limit is not a failure, it is a queue — and until this existed, one
 * 429 threw away a whole demo build: the design lookup that had already been
 * paid for, the page, the lot, with "try again in a minute" put in front of
 * somebody who then had to. The large requests are exactly the ones most
 * likely to be limited and most expensive to lose.
 */
const MAX_ATTEMPTS = 4;
/** Never hold a caller longer than this in total waiting for a queue to clear. */
const MAX_BACKOFF_TOTAL_MS = 90_000;
const BACKOFF_MS = [2000, 6000, 15_000];

/**
 * How a free attempt differs from a paid one, and why it has to.
 *
 * Everything above is written for a vendor that is the *only* one who can do
 * this: a queue is worth waiting out, because the alternative is losing work
 * already paid for upstream. A rung on the free ladder is the opposite case.
 * There is another free model one line down, so waiting ninety seconds for a
 * shared endpoint to clear — and then possibly failing anyway — spends the one
 * thing a free model was chosen to save, which is nobody's money and
 * everybody's afternoon.
 *
 * So a rung gets **one attempt and a short clock**. A 429 is not queued for,
 * it is a reason to try the next model now; and a free endpoint that has said
 * nothing in a minute is not thinking, it is busy.
 *
 * The paid floor keeps the patient behaviour, because by the time the ladder
 * is exhausted there genuinely is nowhere else to go.
 */
const FREE_ATTEMPTS = 1;
const FREE_TIMEOUT_MS = 60_000;

/** A 429 or a 5xx is worth repeating. A 400 or a 401 will say the same thing again. */
function worthRetrying(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * How long the vendor asked us to wait, when it says.
 *
 * `Retry-After` is either a number of seconds or an HTTP date, and honouring it
 * matters more than any backoff we invent: it is the only number that knows
 * when the window actually resets.
 */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One POST, with the four failures a caller cares about separated out, and a
 * queue waited out rather than reported.
 *
 * A 401 and a 429 mean completely different things to whoever is reading the
 * message — one is "check the key you pasted", the other is "wait a minute" —
 * so they are told apart here rather than in each adapter. The difference now
 * is that nobody has to read the second one unless waiting did not help.
 */
async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  vendor: string,
  /**
   * Overrides for a call that is one of several attempts rather than the only
   * one. See `FREE_TIMEOUT_MS`: waiting out a queue is right when there is
   * nowhere else to go and wrong when the next rung of the ladder is free too.
   */
  limits?: { attempts?: number; timeoutMs?: number },
): Promise<Record<string, unknown>> {
  let waited = 0;
  const maxAttempts = limits?.attempts ?? MAX_ATTEMPTS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await postOnce(url, headers, body, vendor, limits?.timeoutMs);
    } catch (err) {
      const last = attempt >= maxAttempts - 1;
      if (last || !(err instanceof ProviderError) || !worthRetrying(err.failure.status)) throw err;

      const asked = err.failure.retryAfterMs;
      const delay = asked ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      if (waited + delay > MAX_BACKOFF_TOTAL_MS) throw err;

      waited += delay;
      console.warn(`[models] ${vendor} answered ${err.failure.status}; waiting ${Math.round(delay / 1000)}s and trying again.`);
      await pause(delay);
    }
  }
}

async function postOnce(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  vendor: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
      retryAfterMs: retryAfterMs(response),
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
    `${base("openai")}/chat/completions`,
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
        // Same restriction as Anthropic's structured outputs, same 400 when a
        // schema carries `maxItems` — strict mode compiles the schema rather
        // than validating against it.
        json_schema: { name: "result", strict: true, schema: forStructuredOutput(request.schema) },
      },
    },
    "OpenAI",
  );

  const choice = (body.choices as { message?: unknown; finish_reason?: string }[] | undefined)?.[0];
  const usage = (body.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
  return {
    text: assistantText(choice?.message),
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

/**
 * The assistant's words, whatever shape they arrived in.
 *
 * A plain string is what the chat-completions spec says and what ChatGPT
 * always sends. NVIDIA serves arbitrary open models and some of them answer
 * with the parts array instead, which used to reach `completion.text.trim()`
 * as an array and throw a `TypeError` — an uncaught one, so it skipped every
 * failover path below and surfaced to the Owner as "Something went wrong"
 * about a spreadsheet they were looking at.
 *
 * A reasoning model's own thinking is deliberately not read here even when the
 * vendor returns it. It is not the answer, and a schema-shaped reply parsed out
 * of a train of thought is a guess wearing the API's clothes.
 */
function assistantText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
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
    `${base("gemini")}/models/${encodeURIComponent(model)}:generateContent`,
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

/**
 * Drops the keywords Gemini's schema dialect rejects. Recursive, and
 * non-destructive.
 *
 * Exported because the agent loop needs the same translation for a different
 * schema: a *tool declaration*. Gemini rejects `additionalProperties` with a
 * 400 rather than ignoring it, and every tool schema in this app is closed —
 * so without this, handing an agent turn to Gemini would fail on the tool
 * definitions before the model saw a word of the task.
 */
export function forGemini(schema: unknown): unknown {
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
    `${base("perplexity")}/v1/sonar`,
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

// --- NVIDIA -----------------------------------------------------------------

/**
 * The answer's shape, said in the prompt rather than only in the request.
 *
 * Every caller in this app describes what it wants **entirely in its JSON
 * schema** — the field names, the enums, the sentinels, and a `description` on
 * each field carrying the real instruction. The sheet analyst is the clearest
 * case: its system prompt says "return a plan" and never once says what a plan
 * looks like, because `headerRow`, `firstDataRow`, the -1 sentinel and the list
 * of valid field targets all live in the schema.
 *
 * That is exactly right when the schema is compiled into a grammar, and it is
 * nothing at all when it is dropped on the floor — which is what a model that
 * merely *accepts* `json_schema` does with it. The model is then asked for "a
 * plan" with no description of one anywhere in the request, and it guesses at
 * the field names. `normalizePlan` drops what it cannot recognise, and the
 * Owner sees an analyst that has got worse for no visible reason.
 *
 * So where the schema will not be enforced, it is stated. Compact rather than
 * indented — a model reads minified JSON Schema perfectly well and the
 * descriptions are the expensive half either way.
 */
function schemaContract(schema: unknown): string {
  return [
    "",
    "---",
    "",
    "# The shape of your answer",
    "",
    "Reply with a single JSON object and nothing else: no sentence before it, no sentence after it, no markdown fence.",
    "",
    "It must match this JSON Schema exactly — every required field present, every enum value one of the strings listed, no field invented and none left out. Each field's `description` is an instruction about what belongs in it.",
    "",
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * NVIDIA speaks the OpenAI chat-completions shape, so this is `callOpenAI`
 * with a different base URL and three differences that each have a live error
 * behind them.
 *
 * **`max_tokens`, not `max_completion_tokens`.** NVIDIA's NIM front end
 * normalises to the older field name across every model it serves; sending the
 * newer one is accepted by some models and ignored by others, which is a
 * silent way for a page build to come back cut in half.
 *
 * **`reasoning_effort` is low / medium / high, and only for a model that takes
 * it at all.** `openai/gpt-oss-*` answers a flat 400 to anything else, and
 * `moonshotai/kimi-k3` rejects `reasoning_budget` by name. So the effort rides
 * only where `FreeModel.reasoning` says it is understood — a parameter a model
 * ignores is free, and one it rejects costs the whole request. See
 * `reasoningEffortFor`.
 *
 * **The schema is sent in the shape the model will take, and said in words
 * whenever it will not be enforced.** Three models, three answers: a strict
 * schema compiled properly, a strict schema accepted and quietly ignored, and
 * a model that 500s on a strict schema and wants `json_object`. `FreeModel.schema`
 * carries which, because NVIDIA's catalogue does not — it returns `id`,
 * `object`, `created` and `owned_by` and nothing else, so unlike the vendor
 * this replaced there is no runtime capability lookup to make.
 */
async function callNvidia(apiKey: string, model: string, request: ModelRequest, free = false): Promise<Completion> {
  // The same default `callClaude` applies when a caller names no effort, so a
  // job moving between vendors does not quietly change how hard it is thought
  // about.
  const effort = request.effort ?? "medium";
  const schema = forStructuredOutput(request.schema);

  // Null for a model the Owner typed in that this app has never probed. Treated
  // as the cautious answer on every axis: the schema is stated in words as well
  // as sent, and no effort is put on the wire. Both are free when they turn out
  // to be unnecessary and both are the difference between working and a 400
  // when they are not.
  const known = freeModel(model);
  const enforced = known?.schema === "enforced";
  const objectOnly = known?.schema === "object";

  const system = enforced ? request.system : `${request.system}\n${schemaContract(schema)}`;

  const body = await post(
    `${base("nvidia")}/chat/completions`,
    { authorization: `Bearer ${apiKey}` },
    {
      model,
      max_tokens: tokensWithReasoning(request.maxTokens ?? DEFAULT_MAX_TOKENS, effort),
      messages: [
        { role: "system", content: system },
        { role: "user", content: openAiContent(request) },
      ],
      ...(known?.reasoning === false ? {} : { reasoning_effort: reasoningEffortFor(effort) }),
      response_format: objectOnly
        ? { type: "json_object" }
        : { type: "json_schema", json_schema: { name: "result", strict: true, schema } },
    },
    "NVIDIA",
    free ? { attempts: FREE_ATTEMPTS, timeoutMs: FREE_TIMEOUT_MS } : undefined,
  );

  const choice = (body.choices as { message?: unknown; finish_reason?: string }[] | undefined)?.[0];
  const usage = (body.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
  return {
    text: assistantText(choice?.message),
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    sources: [],
    truncated: choice?.finish_reason === "length",
  };
}

// --- Carrying an unfinished answer to the next model ------------------------

/**
 * What one model managed to produce before it stopped, handed to the next one.
 *
 * The Owner's instruction was that a paid model taking over from a free one
 * "should not start the process all over, but continue from where it left".
 * The agent loop has always done that — the conversation, the tool results and
 * the checkpoint all survive a handover, so a run can start on a free rung and
 * finish on Gemini with nothing repeated. This is the other half of the model
 * layer, the one-shot `callModel` path, where until now every attempt started
 * from an empty page.
 *
 * It only ever applies to a failure that **produced something**: a reply cut
 * off at the token ceiling, or one that came back as prose the parser could
 * not read. A vendor that was rate-limited, refused the key or timed out has
 * produced nothing, and there is nothing to carry — the next attempt is a
 * fresh one, exactly as before.
 *
 * The partial is passed as *work to finish*, not as an answer to trust. A
 * truncated JSON object is by definition invalid, so the next model is asked
 * to keep what is usable and complete the rest; it is not asked to agree with
 * it. That distinction matters because the alternative — pasting a half-answer
 * in and saying "continue" — gets a model to append to broken JSON and hands
 * the parser something worse than it started with.
 */
interface Carry {
  /** Who produced it, so the sentence a person reads names a model. */
  model: string;
  /** What it managed to write. Never empty — an empty carry is not a carry. */
  partial: string;
  /** Why it stopped, in the words that go into the brief. */
  why: string;
}

/**
 * How much of a partial answer is worth passing on.
 *
 * A truncated reply is by definition as long as the token ceiling allowed, and
 * pasting all of it into the next model's system prompt would spend that
 * model's context on the last one's failure. The head is the useful part: it
 * holds the opening of the object and the fields that were completed, which is
 * everything the next model needs to avoid redoing the work.
 */
const CARRY_MAX_CHARS = 12_000;

function carryFrom(model: string, text: string, why: string): Carry | null {
  const partial = text.trim();
  if (!partial) return null;
  return { model, partial: partial.slice(0, CARRY_MAX_CHARS), why };
}

/**
 * The brief that turns a second attempt into a continuation.
 *
 * Appended to the system prompt rather than sent as a prior assistant turn, on
 * purpose: an assistant turn holding invalid JSON is a message the next model
 * is being asked to agree with, and half of them will simply continue the
 * broken string. As part of the instructions it is what it actually is —
 * somebody else's unfinished draft, and a reason not to start from nothing.
 *
 * Applied to **every** vendor, not only the paid floor. A second free rung
 * benefits from the first rung's work exactly as much as Claude does, and the
 * rule "do not start over" reads oddly if it only holds once money is involved.
 */
function continuationBrief(carry: Carry): string {
  return [
    "",
    "---",
    "",
    "# Work already done on this",
    "",
    `Another model (${carry.model}) was asked this same question and ${carry.why}. Its unfinished answer is below.`,
    "",
    "Do not start again from nothing. Read it, keep every part of it that is correct and complete, and produce the whole finished answer — the same single JSON object described above, valid and complete this time. Where its work is wrong, unfinished or cut off mid-value, replace that part rather than continuing the broken text.",
    "",
    "Your reply must still be one complete JSON object on its own. Do not refer to the draft, do not explain what you changed, and do not append to it.",
    "",
    "```",
    carry.partial,
    "```",
  ].join("\n");
}

// --- The one entry point ----------------------------------------------------

/**
 * Asks whoever serves this job, and returns structured data.
 *
 * Anthropic goes through `callClaude` rather than being reimplemented here:
 * the fallback beta, the refusal handling and the effort setting all live
 * there and are worth having.
 */
/**
 * One vendor's attempt failed, and whether it is worth asking the next one.
 *
 * The distinction is the whole safety story of the failover below. A vendor
 * that is busy, rejected, out of credits, timing out or returning something
 * unparseable has told us nothing about the request — asking somebody else is
 * obviously right. A vendor that *declined the content* has, and asking a
 * second model until one says yes is shopping for a yes. So a 422 is carried
 * straight out and never retried anywhere.
 */
class AttemptFailed extends Error {
  constructor(
    readonly error: AnalystError,
    readonly failover: boolean,
    /** A few words for the note a person reads: "rate-limited", "rejected the key". */
    readonly why: string,
    /**
     * What this attempt produced before it failed, when it produced anything.
     *
     * Only ever set for the two failures that leave real work behind — a reply
     * cut off at the ceiling, and one the parser could not read. Everything
     * else (rate limits, refused keys, timeouts) produced nothing, and a carry
     * of nothing is worse than none: it would put an empty block headed "work
     * already done" in front of the next model.
     */
    readonly carry: Carry | null = null,
  ) {
    super(error.message);
    this.name = "AttemptFailed";
  }
}

/** Short, human words for why one vendor did not answer. */
function whyFailed(status: number): string {
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "rejected the key";
  if (status === 503) return "not connected";
  if (status === 400) return "refused the request shape";
  return "failed";
}

/**
 * Asks whoever serves this job, and moves on to the next one that can if they
 * cannot.
 *
 * The routing chain used to run **only when a vendor had no key**, so a vendor
 * that was connected and then failed took the whole job down with it. That is
 * the expensive shape: a screenshot is paid for at Apify and then nobody looks
 * at it, a demo build pays for its design lookup and then never gets a page.
 * Both of those had a second vendor sitting connected and unasked.
 *
 * Four rules hold it honest:
 *
 * - **A named provider is never routed around.** A caller that passed
 *   `provider` meant that vendor, usually because it is comparing them.
 * - **Only vendors that declare the job are in the chain**, so a failing
 *   vision call never falls through to a model that cannot see.
 * - **A content refusal stops everything.** See `AttemptFailed`.
 * - **Nothing starts from an empty page twice.** When an attempt fails having
 *   already written something — cut off at the ceiling, or unreadable — that
 *   draft is handed to the next model as work to finish. See `Carry`.
 *
 * What comes back says who actually answered, and whose work they continued. A
 * fallback that is invisible is a fallback nobody can price or fix.
 */
export async function callModel<T>(request: ModelRequest): Promise<ModelResult<T>> {
  const say = (kind: FailureKind) => request.messages?.[kind] ?? DEFAULT_MESSAGES[kind];

  const tried: string[] = [];
  // An array rather than a `let`, so that what the last vendor said survives
  // being written from inside `askVendor` below — a variable only ever
  // assigned in a closure reads as never-assigned at the throw.
  const failures: AnalystError[] = [];

  /**
   * The most recent unfinished answer, carried forward across every attempt.
   *
   * Deliberately not reset between vendors: the whole instruction is that a
   * paid model picks up where a free one stopped, and a free rung's draft is
   * every bit as useful to Claude as it was to the next free rung. Overwritten
   * rather than accumulated, because two half-answers to the same question are
   * not more useful than the later one — they are two things to reconcile.
   */
  let carry: Carry | null = null;

  /**
   * Every model this vendor should be asked for, in order.
   *
   * One for everybody except NVIDIA, which has a ladder of free models **per
   * job** — and the whole point of a ladder is that a rung failing is an
   * ordinary event rather than the vendor failing. See `nvidiaAttempts`.
   */
  const modelsFor = async (serving: ProviderKey): Promise<(string | undefined)[]> =>
    serving === "nvidia" ? await nvidiaAttempts(request.job) : [undefined];

  /**
   * Asks one vendor, down its whole ladder, and gives up on it only when every
   * rung has failed in a way worth failing over.
   *
   * Returns null when the vendor is exhausted; throws for a refusal, which
   * must stop the search entirely rather than shop for a second opinion.
   */
  const askVendor = async (serving: ProviderKey): Promise<ModelResult<T> | null> => {
    for (const model of await modelsFor(serving)) {
      try {
        return await attemptProvider<T>(serving, request, say, model, carry);
      } catch (err) {
        if (!(err instanceof AttemptFailed)) throw err;
        if (!err.failover) throw err.error;
        if (err.carry) carry = err.carry;
        // Named by model where there was a choice of them, because "NVIDIA
        // failed" three times over is a note that hides which rungs were tried
        // and reads as one thing going wrong three times.
        tried.push(model ? `${model} ${err.why}` : `${PROVIDERS[serving].name} ${err.why}`);
        failures.push(err.error);
      }
    }
    return null;
  };

  /** Whose unfinished work the model that answered was handed, if anybody's. */
  const continuedFrom = () => carry?.model ?? null;

  if (request.provider) {
    const result = await askVendor(request.provider);
    if (result) return { ...result, continuedFrom: continuedFrom() };
    throw failures.at(-1) ?? new AnalystError(502, say("empty"));
  }

  const { chosen, chain } = await serveChain(request.job);
  if (chain.length === 0) {
    const route = await routeFor(request.job);
    throw new AnalystError(503, route.note ?? say("noKey"));
  }

  for (const serving of chain) {
    const result = await askVendor(serving);
    if (result) {
      return {
        ...result,
        continuedFrom: continuedFrom(),
        fallbackNote: handoverNote(request.job, chosen, serving, tried, carry),
      };
    }
  }

  // Everyone who could do this job was asked and none of them answered. The
  // sentence names all of them, because "the model failed" sends somebody to
  // check one key when the answer is that four vendors are unreachable or one
  // request is malformed for all of them.
  const last = failures.at(-1);
  throw new AnalystError(
    last?.status ?? 502,
    `${JOBS[request.job].phrase} could not be done. ${tried.join("; ")}. Last error: ${last?.message ?? "unknown"}`,
  );
}

/** Who answered, when it was not the first choice, and whose draft they finished. */
function handoverNote(job: ModelJob, chosen: ProviderKey, serving: ProviderKey, tried: string[], carry: Carry | null): string | null {
  const finished = carry ? ` It carried on from ${carry.model}'s unfinished answer rather than starting again.` : "";
  if (serving === chosen && tried.length === 0) return null;
  if (tried.length === 0) {
    return `${PROVIDERS[chosen].name} isn't connected, so ${PROVIDERS[serving].name} is doing ${JOBS[job].phrase} for now. Add a ${PROVIDERS[chosen].name} key under Settings → AI models.`;
  }
  return `${tried.join("; ")}, so ${PROVIDERS[serving].name} did ${JOBS[job].phrase} instead.${finished}`;
}

async function attemptProvider<T>(
  serving: ProviderKey,
  request: ModelRequest,
  say: (kind: FailureKind) => string,
  /** One rung of the free ladder, when this attempt is one of several. */
  modelOverride?: string,
  /** An earlier attempt's unfinished answer, to be finished rather than redone. */
  carry?: Carry | null,
): Promise<ModelResult<T>> {
  // The continuation rides in the system prompt, so it reaches every vendor
  // through the one field they all have — including Claude, which does not go
  // through the adapters below. See `continuationBrief` for why it is not sent
  // as a prior assistant turn.
  const asked: ModelRequest = carry ? { ...request, system: `${request.system}\n${continuationBrief(carry)}` } : request;

  if (serving === "anthropic") {
    try {
      const result = await callClaude<T>({
        purpose: asked.purpose,
        system: asked.system,
        prompt: asked.prompt,
        schema: asked.schema,
        effort: asked.effort,
        // Named rather than left to `callClaude`, so both halves of the model
        // layer honour one answer. Left unset, the job's tier and the Owner's
        // per-job choice would apply to the three fetch vendors and silently
        // not to Claude — which is the vendor most jobs actually fall back to.
        model: await modelForJob(asked.job, "anthropic"),
        maxTokens: asked.maxTokens,
        images: asked.images,
        messages: asked.messages,
      });
      return {
        data: result.data,
        provider: "anthropic",
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        sources: [],
        fallbackNote: null,
        continuedFrom: null,
      };
    } catch (err) {
      // `callClaude` already prices and records its own failures, so this only
      // classifies. 422 is its refusal — carried out untouched, never retried
      // on a second vendor.
      if (err instanceof AnalystError) {
        throw new AttemptFailed(err, err.status !== 422, whyFailed(err.status));
      }
      throw err;
    }
  }

  const apiKey = await providerKey(serving);
  if (!apiKey) throw new AttemptFailed(new AnalystError(503, say("noKey")), true, "not connected");

  const model = modelOverride ?? (await modelForJob(asked.job, serving));
  // A rung is asked once and given a short clock. See `FREE_TIMEOUT_MS`.
  //
  // **What makes it a rung is that there is another one below it**, not what
  // it costs. This was written as "is this model priced at zero", which is a
  // different question and gave the wrong answer twice: a rung the Owner
  // picked from the unprobed half of NVIDIA's catalogue got the patient
  // four-attempt path with ninety seconds of backoff, so a busy free endpoint
  // held a person for a minute and a half before the *next free model* was
  // asked — which is the one thing the ladder exists to avoid.
  const free = serving === "nvidia" && modelOverride !== undefined;
  const startedAt = Date.now();

  const fail = async (status: number, message: string) => {
    await recordLlmCall({
      purpose: asked.purpose,
      model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      effort: asked.effort,
      ok: false,
      error: message,
    });
    return new AttemptFailed(new AnalystError(status, message), status !== 422, whyFailed(status));
  };

  let completion: Completion;
  try {
    completion =
      serving === "openai"
        ? await callOpenAI(apiKey, model, asked)
        : serving === "gemini"
          ? await callGemini(apiKey, model, asked)
          : serving === "perplexity"
            ? await callPerplexity(apiKey, model, asked)
            : await callNvidia(apiKey, model, asked, free);
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
            : withVendorHint(serving, err.failure.status, err.failure.detail);
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
      purpose: asked.purpose,
      model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      costUsd,
      durationMs: Date.now() - startedAt,
      effort: asked.effort,
      ok,
      error,
    });

  // Truncated, empty and unparseable are all "this vendor produced nothing
  // usable", which is exactly the case another vendor may well handle — a
  // schema one model chokes on is routine for the next.
  //
  // Two of the three leave real work behind, though, and that work is handed
  // on: what came back is passed to the next attempt as a draft to finish. The
  // empty case is the one that carries nothing, because there is nothing.
  const rejected = async (status: number, message: string, produced: Carry | null = null) => {
    await spent(false, message);
    return new AttemptFailed(new AnalystError(status, message), true, "returned nothing usable", produced);
  };

  // Hitting the cap leaves valid-looking JSON cut off mid-string, which would
  // otherwise surface as an unexplained parse failure.
  if (completion.truncated) {
    throw await rejected(502, say("truncated"), carryFrom(model, completion.text, "ran out of room before it finished"));
  }
  if (!completion.text.trim()) throw await rejected(502, say("empty"));

  const parsed = readJson<T>(completion.text);
  if (parsed === undefined) {
    throw await rejected(502, say("parse"), carryFrom(model, completion.text, "answered with something that could not be read as the JSON object asked for"));
  }
  const data = parsed;

  await spent(true);
  return {
    data,
    provider: serving,
    model,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    costUsd,
    sources: completion.sources,
    fallbackNote: null,
    continuedFrom: null,
  };
}

/**
 * Adds the one vendor-specific note worth carrying on a mid-run failure.
 *
 * NVIDIA answers **429** when the account's free allowance for the day is
 * spent, and the raw sentence reads like a busy endpoint rather than a limit
 * that will not clear for hours — so a person waits for something that is not
 * coming. It is the same trap Perplexity's 401 is, and the OpenRouter 402 this
 * replaced: a status whose obvious reading is the wrong one.
 *
 * Said as a possibility rather than a fact, because a 429 genuinely is a busy
 * model some of the time and the vendor does not distinguish the two.
 */
function withVendorHint(provider: ProviderKey, status: number, detail: string): string {
  if (provider === "nvidia" && status === 429) {
    return `${detail} NVIDIA's free models share one allowance per account, so this can be the day's allowance rather than a busy model — the ladder moves to the next model either way, and the paid floor finishes the work if all three are out.`;
  }
  return detail;
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

/**
 * The object out of a reply, however it was wrapped. `undefined` when there
 * isn't one.
 *
 * Two attempts, in order of trust. The plain parse is what a vendor enforcing
 * a schema always gives. The second is for a model that was *asked* for JSON
 * rather than held to it — which is now a supported case rather than an
 * accident, because two of the free NVIDIA models do not compile a schema (see
 * `FreeModel.schema`) — and which answers with
 * a sentence of preamble often enough to be worth six lines here. The
 * alternative is a rejected reply, a second vendor paid to redo the work, and
 * "the analyst's plan could not be read" put in front of the Owner.
 *
 * Deliberately not a repair: it slices out the outermost braces and parses
 * them, so malformed JSON still fails. Guessing at what a truncated object
 * meant is how a plan arrives with boundaries nobody chose.
 */
function readJson<T>(text: string): T | undefined {
  const body = stripFence(text);
  try {
    return JSON.parse(body) as T;
  } catch {
    /* fall through to the second attempt */
  }

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
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
  /** Set when the chosen vendor could not draw and something else did. */
  fallbackNote: string | null;
}

/** What one vendor's attempt produced, before it is priced and recorded. */
interface Drawing {
  /** Data URLs, ready to put in an `<img src>`. */
  images: string[];
  inputTokens: number;
  outputTokens: number;
}

/**
 * Draws a picture, asking whoever serves the `image` job and moving on to the
 * next one that can if they cannot.
 *
 * Separate from `callModel` because an image is not a completion in any shape
 * the text path could carry: no schema, no tokens in the sense the ledger
 * means, and bytes rather than a reply. The routing is the same idea though —
 * the caller asks for a picture and the settings decide who draws it.
 *
 * **This used to be one vendor with no chain, and that was a fact about this
 * app rather than about the world.** It spoke OpenAI's images API and refused
 * everything else outright, so the routing had to name ChatGPT and only
 * ChatGPT or it would have offered a route that never served. The result was
 * that the one job in the system costing real money on every single call was
 * also the one job with no free option and no fallback: no ChatGPT key meant
 * no pictures at all, and a rate-limited ChatGPT meant an ad concept lost
 * with nothing else to ask.
 *
 * There are two wires now — OpenAI's `/images/generations`, and NVIDIA's Cloud
 * Functions, which are free — and the rules are the ones `callModel` already
 * uses: only vendors that declare the job are in the chain, a content refusal
 * is carried straight out and never retried on a second vendor, and the result
 * says who actually drew it.
 *
 * The bytes come back as base64 and go out as data URLs rather than being
 * written to disk: Railway's filesystem is ephemeral, so a file written at
 * runtime reverts on the next deploy and *looks like it worked*.
 */
export async function generateImage(request: ImageRequest): Promise<ImageResult> {
  const { chosen, chain } = await serveChain("image");
  if (chain.length === 0) {
    const route = await routeFor("image");
    throw new AnalystError(503, route.note ?? "No model is connected for images. Add an NVIDIA or ChatGPT key under Settings → AI models.");
  }

  const tried: string[] = [];
  const failures: AnalystError[] = [];

  for (const serving of chain) {
    // Every model this vendor should be asked for. NVIDIA has a ladder; ChatGPT
    // has the one image model its own setting names.
    const models = serving === "nvidia" ? await freeLadderFor("image") : [await imageModel()];
    // A ladder switched off deliberately still leaves the vendor's own model,
    // exactly as the text path does.
    const attempts = models.length > 0 ? models : [await nvidiaImageModel()];

    for (const model of attempts) {
      const startedAt = Date.now();
      try {
        const drawn = serving === "nvidia" ? await drawWithNvidia(model, request) : await drawWithOpenAI(model, request);
        if (drawn.images.length === 0) throw new AttemptFailed(new AnalystError(502, "The image service returned no pictures."), true, "returned nothing usable");

        const rate = await rateForModel(model);
        const costUsd = costOf(rate, { inputTokens: drawn.inputTokens, outputTokens: drawn.outputTokens });
        await recordLlmCall({
          purpose: request.purpose,
          model,
          inputTokens: drawn.inputTokens,
          outputTokens: drawn.outputTokens,
          costUsd,
          durationMs: Date.now() - startedAt,
          ok: true,
        });
        return {
          provider: serving,
          model,
          images: drawn.images,
          costUsd,
          fallbackNote: tried.length > 0 ? `${tried.join("; ")}, so ${PROVIDERS[serving].name} drew it instead.` : null,
        };
      } catch (err) {
        const failed =
          err instanceof AttemptFailed
            ? err
            : err instanceof ProviderError
              ? new AttemptFailed(new AnalystError(err.failure.status, err.failure.detail), err.failure.status !== 422, whyFailed(err.failure.status))
              : new AttemptFailed(new AnalystError(502, `${PROVIDERS[serving].name} failed: ${(err as Error).message}`), true, "failed");

        await recordLlmCall({
          purpose: request.purpose,
          model,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          durationMs: Date.now() - startedAt,
          ok: false,
          error: failed.error.message,
        });

        // A vendor that declined the *content* has told us something about the
        // request, and asking a second model until one says yes is shopping
        // for a yes. Everything else is worth handing on.
        if (!failed.failover) throw failed.error;
        tried.push(`${model} ${failed.why}`);
        failures.push(failed.error);
      }
    }
  }

  const last = failures.at(-1);
  throw new AnalystError(
    last?.status ?? 502,
    `The picture could not be drawn. ${tried.join("; ")}. Last error: ${last?.message ?? "unknown"}`,
  );
}

/** ChatGPT's images API. Costs money and is the floor under the free ones. */
async function drawWithOpenAI(model: string, request: ImageRequest): Promise<Drawing> {
  const apiKey = await providerKey("openai");
  if (!apiKey) throw new AttemptFailed(new AnalystError(503, "No ChatGPT key is set. Add one under Settings → AI models."), true, "not connected");

  const body = await post(
    `${base("openai")}/images/generations`,
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

  const data = (body.data as { b64_json?: string; url?: string }[] | undefined) ?? [];
  const usage = (body.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  return {
    images: data.map((entry) => (entry.b64_json ? `data:image/png;base64,${entry.b64_json}` : (entry.url ?? ""))).filter(Boolean),
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

/**
 * NVIDIA's free image models, which are Cloud Functions rather than an API.
 *
 * Four things about this wire that each cost an experiment to find, and each
 * of which looks like a working request until you check the picture:
 *
 * - **The address is a function id, not a slug.** The documented friendly path
 *   (`ai.api.nvidia.com/v1/genai/black-forest-labs/…`) either holds the
 *   connection open indefinitely or answers "Not found for account". The NVCF
 *   id works. That is why an image model this app does not know is refused
 *   rather than attempted: on the text wire a slug is the address, and here
 *   the address is a UUID nobody can guess.
 * - **`width` and `height` are honoured; `aspect_ratio` is accepted and
 *   ignored.** `aspect_ratio: "3:2"` returns 200 and a 1024x1024 image, while
 *   `"16:9"` is a 422 — so the parameter that looks like it works is the one
 *   that does not. The caller's `size` is translated to width and height, and
 *   `aspect_ratio` is never sent.
 * - **Nothing else may be sent.** `steps`, `cfg_scale`, `mode`, `n` and the
 *   OpenAI-shaped fields are each a 422 whose entire body is "Inference
 *   error", with no field named. The body is deliberately the smallest one
 *   that works.
 * - **One picture per call**, so a caller asking for four gets four calls.
 *   Capped low, because each is a real request against shared free capacity.
 *
 * A queued request answers **202** with an `nvcf-reqid` and is polled. That is
 * the ordinary path under load rather than an error, and treating it as one
 * would read as "the free model failed" every time it was busy.
 */
async function drawWithNvidia(model: string, request: ImageRequest): Promise<Drawing> {
  const apiKey = await providerKey("nvidia");
  if (!apiKey) throw new AttemptFailed(new AnalystError(503, "No NVIDIA key is set. Add one under Settings → AI models — it is where the free image models live."), true, "not connected");

  const url = imageFunctionUrl(model);
  if (!url) {
    // Named rather than attempted. See the note above about the address.
    throw new AttemptFailed(
      new AnalystError(400, `“${model}” is not an NVIDIA image model this app knows how to reach. Pick one from Settings → AI models → Free AI models → Images.`),
      true,
      "has no known endpoint",
    );
  }

  const { width, height } = imageSize(request.size);
  const images: string[] = [];
  const wanted = Math.min(Math.max(request.count ?? 1, 1), NVIDIA_IMAGE_MAX);

  for (let index = 0; index < wanted; index++) {
    const artifact = await drawOne(url, apiKey, { prompt: request.prompt, width, height });
    if (artifact) images.push(artifact);
  }

  // No token usage on this wire at all, which is correct rather than missing:
  // there are none, and it is free. `isFreeModel` prices it at zero so the
  // ledger records a real row for a real call rather than nothing.
  return { images, inputTokens: 0, outputTokens: 0 };
}

/** How many pictures one call may ask a free endpoint for, one at a time. */
const NVIDIA_IMAGE_MAX = 4;

/** How long to wait for a queued NVCF request before giving up on this rung. */
const NVCF_POLL_ATTEMPTS = 12;
const NVCF_POLL_MS = 5000;

async function drawOne(url: string, apiKey: string, body: Record<string, unknown>): Promise<string | null> {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
    // Asks the gateway to hold the request open rather than queue it, which
    // turns most calls into a single round trip.
    "nvcf-poll-seconds": "60",
  };

  let response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });

  // 202 is "queued", not "failed" — the ordinary answer under load.
  let requestId = response.headers.get("nvcf-reqid");
  for (let attempt = 0; response.status === 202 && requestId && attempt < NVCF_POLL_ATTEMPTS; attempt++) {
    await pause(NVCF_POLL_MS);
    response = await fetch(imageStatusUrl(requestId), { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new ProviderError({
      status: response.status,
      kind: response.status === 401 || response.status === 403 ? "auth" : response.status === 429 ? "rate" : "empty",
      // The body is "Inference error" and nothing else on a 422 here, so the
      // sentence has to carry what this app knows that the vendor did not say.
      detail:
        response.status === 422
          ? `NVIDIA could not draw that (422). Its own message is only "Inference error"; on this wire that is usually the prompt being declined rather than anything being broken.`
          : `NVIDIA returned ${response.status}: ${(extractError(text) ?? text).slice(0, 300)}`,
      retryAfterMs: retryAfterMs(response),
    });
  }

  let payload: { artifacts?: { base64?: unknown; finishReason?: unknown }[] };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new ProviderError({ status: 502, kind: "parse", detail: "NVIDIA returned something that was not JSON." });
  }

  const artifact = payload.artifacts?.[0];
  // A declined prompt comes back 200 with a finish reason rather than an
  // error, which would otherwise be read as "the model produced nothing" and
  // handed to a paid vendor to be declined again.
  const finish = typeof artifact?.finishReason === "string" ? artifact.finishReason : "SUCCESS";
  if (finish !== "SUCCESS") {
    throw new ProviderError({ status: 422, kind: "refusal", detail: `NVIDIA declined to draw this (${finish}). Rephrase the prompt.` });
  }
  if (typeof artifact?.base64 !== "string" || !artifact.base64) return null;
  // JPEG, not PNG — the prefix has to match the bytes or every browser shows a
  // broken image for a picture that arrived perfectly well.
  return `data:image/jpeg;base64,${artifact.base64}`;
}

/**
 * The caller's `size` as the two numbers this wire wants.
 *
 * `auto` and anything unparseable become a square, which is what every caller
 * in this app asks for anyway. Clamped to what the model will accept: it
 * refuses sizes it does not like with the same unhelpful 422 as everything
 * else, so the clamp is what stops a caller's typo reading as a dead endpoint.
 */
function imageSize(size: string | undefined): { width: number; height: number } {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec((size ?? "").trim());
  if (!match) return { width: 1024, height: 1024 };
  const clamp = (value: number) => Math.min(Math.max(Math.round(value / 64) * 64, 512), 1536);
  return { width: clamp(Number(match[1])), height: clamp(Number(match[2])) };
}

// --- Verifying a key --------------------------------------------------------

/**
 * Checks a key works before it is stored, the same way the Apify token and the
 * Anthropic key are. A key that is saved and then fails on first use is a
 * support conversation; one that is refused at the moment it is pasted is a
 * typo the Owner fixes in ten seconds.
 */
export interface NvidiaModel {
  id: string;
  /** What it is called on screen. The catalogue has no name field, so this is ours. */
  name: string;
  /** Who built it, which is all `owned_by` actually tells us. */
  house: string;
  /** NVIDIA's own one-line description, for the models this app has probed. */
  blurb: string;
  /** True when NVIDIA is currently listing it. */
  listed: boolean;
  /**
   * True for everything NVIDIA serves on this endpoint — which is the point of
   * the vendor. Kept as a field rather than assumed, so the picker reads the
   * same as the one it replaced and a future paid NIM does not silently
   * inherit a zero price.
   */
  free: boolean;
  /** Whether it can be asked for tools — an agent turn needs this. */
  tools: boolean;
  /** Whether it can look at a picture. Three of them can. */
  vision: boolean;
  /** How it takes a JSON schema, if at all. See `FreeModel.schema`. */
  schema: "enforced" | "accepted" | "object" | null;
  /** Set when this app has probed the endpoint and it would not serve. */
  down: string | null;
  /** True when this app has verified what this model can do. */
  known: boolean;
}

/**
 * Everything NVIDIA will serve this account, joined to what this app knows
 * about each one.
 *
 * The listing endpoint is free and authenticated, which is what makes it the
 * right thing to build a picker on: no tokens are spent to find out what is
 * available, and whether a model is still listed is the account's own answer
 * rather than a list written down here that goes stale the week one is
 * retired.
 *
 * **But it is only half the answer, and that is the difference from the vendor
 * this replaced.** NVIDIA's `/v1/models` returns `id`, `object`, `created` and
 * `owned_by` — no pricing, no `supported_parameters`, nothing about tools,
 * schemas or vision. OpenRouter published all of it, which is why the old
 * picker could be built entirely from the catalogue. Here the capabilities
 * come from `FREE_MODELS`, where every flag was proved against the endpoint on
 * a recorded date, and the catalogue contributes exactly one fact: is this
 * still listed.
 *
 * A model NVIDIA lists that this app has never probed comes back with
 * `known: false` and its capabilities null. It can still be typed into a
 * ladder — the layer treats an unknown model cautiously, stating the schema in
 * words and sending no reasoning effort — but the screen says plainly that
 * nobody has checked it.
 */
export async function listNvidiaModels(apiKey: string): Promise<NvidiaModel[]> {
  const response = await fetch(`${base("nvidia")}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) {
    throw new AnalystError(response.status === 401 || response.status === 403 ? 400 : 502, describeRejection("nvidia", response.status, await response.text()));
  }
  const payload = (await response.json().catch(() => null)) as { data?: { id?: unknown; owned_by?: unknown }[] } | null;

  const listed = new Set<string>();
  const houses = new Map<string, string>();
  for (const entry of payload?.data ?? []) {
    if (typeof entry?.id !== "string" || !entry.id) continue;
    listed.add(entry.id);
    if (typeof entry.owned_by === "string") houses.set(entry.id, entry.owned_by);
  }

  // Everything this app has verified first, in the order the catalogue file
  // declares it — which is roughly best-first and is the order the picker
  // should read in.
  const models: NvidiaModel[] = FREE_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    house: model.house,
    blurb: model.blurb,
    listed: listed.has(model.id),
    free: true,
    tools: model.tools,
    vision: model.vision,
    schema: model.schema,
    down: model.down ?? null,
    known: true,
  }));

  // Then everything else NVIDIA lists, unverified and marked as such. Offered
  // rather than hidden: the catalogue is eighty models deep and the Owner may
  // well want one this app has not got round to.
  for (const id of [...listed].sort()) {
    if (freeModel(id)) continue;
    const house = houses.get(id) ?? id.split("/")[0] ?? id;
    models.push({
      id,
      name: id,
      house,
      blurb: "Listed by NVIDIA. This app has not checked what it can do — pick it and it will be asked cautiously: the answer's shape stated in words, and no reasoning effort on the wire.",
      listed: true,
      free: true,
      tools: false,
      vision: false,
      schema: null,
      down: null,
      known: false,
    });
  }

  return models;
}

/**
 * Drops from the stored ladders anything NVIDIA no longer lists, at boot.
 *
 * This is what is left of `ensureFreeLadder`, and what is left is the honest
 * half. The old one picked a whole ladder out of OpenRouter's catalogue at the
 * first boot with a key, because that catalogue said which models were free
 * and which took tools — so it could choose better than a source file could.
 * NVIDIA's says neither. A ladder picked from it would be three ids nobody has
 * ever called, and the shipped ladders are the opposite of that: every rung
 * was probed by hand, and the assignment is the point of the feature.
 *
 * So nothing is ever *chosen* here. What this does is remove a rung the vendor
 * has stopped listing, which is the one thing the catalogue can prove and the
 * one failure a written-down list cannot survive — a retired id answers 404,
 * and while that costs only one fast call, a ladder quietly two rungs long is
 * a ladder that stops being what the Owner configured.
 *
 * **Only ever touches a ladder the Owner stored.** A job using the shipped
 * ladder is left alone: writing a pruned copy into settings would turn a
 * default that tracks the code into a frozen snapshot of today's catalogue,
 * which is the exact trap `readRoutes` and `readFreeLadders` are shaped to
 * avoid. A stored *empty* ladder — free models deliberately off — is left
 * alone too.
 *
 * Never fatal. NVIDIA being unreachable at boot is not a reason to fail a
 * deploy; the ladders stand and a dead rung costs one 404.
 */
export async function pruneFreeLadders(): Promise<{ dropped: Record<string, string[]> } | null> {
  const stored = await readFreeLadders();
  const keys = Object.keys(stored) as LadderKey[];
  if (keys.length === 0) return null;

  const apiKey = await providerKey("nvidia");
  if (!apiKey) return null;

  let listed: Set<string>;
  try {
    listed = new Set((await listNvidiaModels(apiKey)).filter((model) => model.listed).map((model) => model.id));
  } catch (err) {
    console.warn(`[models] could not read NVIDIA's catalogue to check the free ladders — they stand as stored: ${(err as Error).message}`);
    return null;
  }
  // An empty or unreadable catalogue must not empty every ladder the Owner
  // configured. "We could not tell" and "none of them exist" are the same
  // shape here and completely different facts.
  if (listed.size === 0) return null;

  const next: Partial<Record<LadderKey, string[]>> = { ...stored };
  const dropped: Record<string, string[]> = {};
  for (const key of keys) {
    const ladder = stored[key] ?? [];
    if (ladder.length === 0) continue;
    const kept = ladder.filter((id) => listed.has(id));
    if (kept.length === ladder.length) continue;
    // Every rung gone is not "free models off" — it is a ladder that has
    // rotted, and storing `[]` would read as a deliberate switch-off forever
    // after. The key is removed instead, which puts that job back on the
    // shipped ladder.
    if (kept.length === 0) delete next[key];
    else next[key] = kept;
    dropped[key] = ladder.filter((id) => !listed.has(id));
  }

  if (Object.keys(dropped).length === 0) return null;
  await setSetting(SETTING.NVIDIA_FREE_MODELS, JSON.stringify(next));
  for (const [key, ids] of Object.entries(dropped)) {
    console.warn(`[models] NVIDIA no longer lists ${ids.join(", ")} — dropped from the ${key} ladder.`);
  }
  return { dropped };
}

export async function verifyProviderKey(provider: ProviderKey, apiKey: string, modelChoice?: string): Promise<{ model: string }> {
  const definition = PROVIDERS[provider];
  const model = definition.defaultModel;

  if (provider === "anthropic") {
    const { verifyKey } = await import("../claude.js");
    return verifyKey(apiKey);
  }

  try {
    if (provider === "nvidia") {
      // The model list is free and authenticated, so it proves the key without
      // spending anything — and it carries every id the account can ask for,
      // which makes it the one place a wrong model slug can be caught before
      // it becomes a month of calls that quietly failed over to somebody else.
      const response = await fetch(`${base("nvidia")}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!response.ok) throw new ProviderError({ status: response.status, kind: "auth", detail: await response.text() });

      // The id being saved with the key, when the form sent one — checking the
      // stored value instead would miss a slug corrected in the same submit.
      const wanted = (modelChoice?.trim() || (await providerModel(provider)) || model).trim();
      const payload = (await response.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
      const ids = (payload?.data ?? []).map((entry) => (typeof entry?.id === "string" ? entry.id : "")).filter(Boolean);
      if (ids.length > 0 && !ids.includes(wanted)) {
        const matches = ids.filter((id) => id.toLowerCase().includes(wanted.toLowerCase())).slice(0, 5);
        throw new AnalystError(
          400,
          [
            `That key works, but NVIDIA has no model called “${wanted}”.`,
            matches.length > 0 ? `Closest ids on NVIDIA: ${matches.join(", ")}.` : null,
            "Find the exact id at build.nvidia.com and put it in the model field, then save again.",
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
      return { model: wanted };
    }
    if (provider === "openai") {
      // The model list is the cheapest authenticated call there is — no tokens,
      // no charge, and it fails on exactly the thing being checked.
      const response = await fetch(`${base("openai")}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!response.ok) throw new ProviderError({ status: response.status, kind: "auth", detail: await response.text() });
      return { model: (await providerModel(provider)) || model };
    }
    if (provider === "gemini") {
      const response = await fetch(`${base("gemini")}/models`, { headers: { "x-goog-api-key": apiKey } });
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
    const response = await fetch(`${base("perplexity")}/v1/sonar`, {
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
 * So the vendor's own sentence is always carried through, and the vendors with
 * a common non-obvious cause get that named as well. A guess is offered, never
 * asserted: what is stated as fact is only ever what the vendor said.
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
        : provider === "nvidia"
          ? "An NVIDIA key is issued from a model's page in the console but works for every model on the account, so this is the key itself rather than the model it was made on. Keys also expire — check the date next to it at build.nvidia.com."
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
