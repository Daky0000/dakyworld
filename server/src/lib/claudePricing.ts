import type { Effort } from "./claude.js";
import { SETTING, getSetting } from "./settings.js";

/**
 * What a Claude call costs.
 *
 * The app spends real money every time it drafts an email or writes a
 * proposal, and until now nothing recorded it. You could see the Apify bill
 * coming — `capture.monthlyBudgetUsd` stops a scrape mid-month — but the
 * Anthropic bill only arrived at the end of the month with no way to ask which
 * feature spent it.
 *
 * Rates are per million tokens, published at
 * https://platform.claude.com/docs/en/pricing. They live in code because
 * they're a fact about the world rather than a preference, and they're
 * overridable from AppSetting because a price change must not need a redeploy
 * — the same reasoning as every integration key.
 */

export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * What reading the prompt cache costs, where it is not the usual tenth of
   * the input rate.
   *
   * Opus 5.5 reads its cache at a twentieth of input and Fable 5.1 at a
   * fortieth. The flat tenth this file applied to every model would bill a
   * long agent run on either at two or four times what its cache reads really
   * cost — the safe direction for a ceiling, and the wrong number on the one
   * tile of the costs screen that exists to say whether the cache is paying
   * for itself. Unset means the tenth.
   */
  cacheReadPerMTok?: number;
  /**
   * A dearer rate card for a long prompt, chosen by the prompt's length.
   *
   * Haiku 5.5 is billed on two cards: one up to `aboveTokens` of prompt and a
   * dearer one past it, and the card applies to **the whole call** — every
   * input and output token — not only to the tokens over the line. The prompt
   * counts cache reads and writes as well as fresh input, because all three are
   * prompt. Cache reads on this card are a tenth of its input rate.
   */
  longPrompt?: { aboveTokens: number; inputPerMTok: number; outputPerMTok: number };
}

/** The default model for every call that doesn't name one. */
export const MODEL_DEFAULT = "claude-opus-5-5";

/**
 * The model for work that does not need the headline one.
 *
 * Sonnet 5.5 is half Opus 5.5's rate on both halves and does the reading,
 * filling-in and checking that most of an agent run actually consists of.
 * Overridable through `anthropic.model.economy`; see the setting for where the
 * line is drawn.
 */
export const MODEL_ECONOMY = "claude-sonnet-5-5";

/**
 * Published rates, from the Claude API reference as it stood on 6 Oct 2026.
 *
 * **The current family is the first four.** The task levels and the two
 * constants above point at Haiku 5.5, Sonnet 5.5 and Opus 5.5. Fable 5.1 is
 * here so the Owner can choose it for a level or a job, and nothing ships on
 * it: it is the dearest model on the list, and paying for it should be a
 * decision somebody made rather than a default nobody noticed.
 *
 * **Every older id stays.** The ledger holds months of calls they served, a
 * deployment that pinned one under `anthropic.model` keeps its pin, and a
 * model that drops out of this table is billed at `FALLBACK` the next time it
 * answers — which would read as a sudden price rise on a model nobody changed.
 */
export const MODEL_PRICING: Record<string, ModelRate> = {
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5, longPrompt: { aboveTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 } },

  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  // Stored at $3/$15 until Oct 2026, on the reasoning that $2/$10 was an
  // introduction ending on 31 Aug and a ceiling that overestimates still holds
  // when it does. The reference after that date still lists $2/$10 — the
  // price Sonnet 5.5 launched at "the same as" — so the introduction became
  // the price, and the stored figure was overstating every call by half.
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
};

/**
 * An unknown model is priced at the most expensive rate we know of, not at
 * zero. A model this table has never heard of is exactly the case where a
 * budget ceiling matters most, and "unpriced" reading as "free" is how a
 * ceiling gets bypassed without anyone choosing to bypass it.
 */
const FALLBACK: ModelRate = { inputPerMTok: 10, outputPerMTok: 50 };

/**
 * Cache reads are a tenth of the input rate unless the model says otherwise;
 * writes are a quarter more than it. Every write this app makes is the
 * five-minute kind — nothing asks for the hour-long one, which costs double.
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * The one reader of a rate override setting — `models.pricing` and the older
 * `anthropic.pricing` alike.
 *
 * There were two, an identical copy each in this file and in `models/call.ts`,
 * and two correct copies of one rule are one edit away from two different
 * rules. `setting` only names the row in the warning.
 */
export function readOverrides(raw: string | null, setting: string): Record<string, ModelRate> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[models] ${setting} is not valid JSON — using the built-in rates.`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: Record<string, ModelRate> = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { inputPerMTok, outputPerMTok } = value as Record<string, unknown>;
    // A negative or non-numeric override would make calls look cheaper than
    // free, so it's dropped rather than clamped: a typo shouldn't silently
    // become a policy.
    if (typeof inputPerMTok !== "number" || typeof outputPerMTok !== "number") continue;
    if (!Number.isFinite(inputPerMTok) || !Number.isFinite(outputPerMTok)) continue;
    if (inputPerMTok < 0 || outputPerMTok < 0) continue;
    out[model] = { inputPerMTok, outputPerMTok };
  }
  return out;
}

/**
 * Every rate the Owner has declared, from both settings that can hold one.
 *
 * `models.pricing` wins where both name the same id: it is the one the
 * Settings screen writes, so it is the more recent decision. A declared rate
 * is also what admits a model the code has never heard of — see
 * `isPricedModelAsync` in `models/registry.ts`.
 */
export async function declaredRates(): Promise<Record<string, ModelRate>> {
  const [models, anthropic] = await Promise.all([getSetting(SETTING.MODEL_PRICING), getSetting(SETTING.ANTHROPIC_PRICING)]);
  return { ...readOverrides(anthropic, SETTING.ANTHROPIC_PRICING), ...readOverrides(models, SETTING.MODEL_PRICING) };
}

/**
 * One entry of a rate table, or undefined.
 *
 * `table[model]` on a plain object answers for "constructor" and "toString"
 * too — a function, which `costOf` then turns into NaN dollars. An id is
 * whatever a vendor or a person typed, so only the table's own keys count.
 */
export function ownRate(table: Record<string, ModelRate>, model: string): ModelRate | undefined {
  return Object.hasOwn(table, model) ? table[model] : undefined;
}

/** The rate for one model, honouring a declared override. */
export async function rateFor(model: string): Promise<ModelRate> {
  return ownRate(await declaredRates(), model) ?? ownRate(MODEL_PRICING, model) ?? FALLBACK;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * Dollars for one call. `inputTokens` from the API is already the uncached
 * remainder — cached tokens are reported separately and priced separately —
 * so the three are added rather than one being subtracted from another.
 */
export function costOf(rate: ModelRate, tokens: TokenCounts): number {
  const reads = tokens.cacheReadTokens ?? 0;
  const writes = tokens.cacheCreationTokens ?? 0;
  const prompt = tokens.inputTokens + reads + writes;
  const card: ModelRate =
    rate.longPrompt && prompt > rate.longPrompt.aboveTokens
      ? { inputPerMTok: rate.longPrompt.inputPerMTok, outputPerMTok: rate.longPrompt.outputPerMTok }
      : rate;
  const input = tokens.inputTokens * card.inputPerMTok;
  const output = tokens.outputTokens * card.outputPerMTok;
  const cacheRead = reads * (card.cacheReadPerMTok ?? card.inputPerMTok * CACHE_READ_MULTIPLIER);
  const cacheWrite = writes * card.inputPerMTok * CACHE_WRITE_MULTIPLIER;
  return (input + output + cacheRead + cacheWrite) / 1_000_000;
}

/** The model every call uses unless it asks for another. */
export async function defaultModel(): Promise<string> {
  const configured = (await getSetting(SETTING.ANTHROPIC_MODEL))?.trim();
  return configured || MODEL_DEFAULT;
}

/**
 * Which model an agent turn runs on, given how hard the work is.
 *
 * "high" is the runner's word for an agent that either sits on the board or
 * writes something a stranger will read — the two places where the better
 * model is worth what it costs. Everything else is a sub-agent doing a job
 * with a right answer, and pays the economy rate for it.
 */
export async function modelForEffort(effort: Effort): Promise<string> {
  // Named the cheap way round on purpose: a new effort level added above
  // "high" must default to the better model, not quietly fall through to the
  // cheaper one because nobody remembered to list it.
  if (effort !== "low" && effort !== "medium") return defaultModel();
  const configured = (await getSetting(SETTING.ANTHROPIC_MODEL_ECONOMY))?.trim();
  return configured || MODEL_ECONOMY;
}
