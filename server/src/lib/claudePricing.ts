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
}

/** The default model for every call that doesn't name one. */
export const MODEL_DEFAULT = "claude-opus-5";

/**
 * The model for work that does not need the headline one.
 *
 * Sonnet 5 is 40% cheaper than Opus on both halves and does the reading,
 * filling-in and checking that most of an agent run actually consists of.
 * Overridable through `anthropic.model.economy`; see the setting for where the
 * line is drawn.
 */
export const MODEL_ECONOMY = "claude-sonnet-5";

export const MODEL_PRICING: Record<string, ModelRate> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  // Sonnet 5 is on introductory pricing ($2/$10) until 31 Aug 2026. The
  // standard rate is used deliberately: a ceiling that overestimates holds
  // when the introduction ends, and one that underestimates quietly stops
  // holding on a date nobody is watching for.
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
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

/** Cache reads are a tenth of the input rate; writes are a quarter more than it. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

function readOverrides(raw: string | null): Record<string, ModelRate> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[claude] anthropic.pricing is not valid JSON — using the built-in rates.");
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

/** The rate for one model, honouring an AppSetting override. */
export async function rateFor(model: string): Promise<ModelRate> {
  const overrides = readOverrides(await getSetting(SETTING.ANTHROPIC_PRICING));
  return overrides[model] ?? MODEL_PRICING[model] ?? FALLBACK;
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
  const input = tokens.inputTokens * rate.inputPerMTok;
  const output = tokens.outputTokens * rate.outputPerMTok;
  const cacheRead = (tokens.cacheReadTokens ?? 0) * rate.inputPerMTok * CACHE_READ_MULTIPLIER;
  const cacheWrite = (tokens.cacheCreationTokens ?? 0) * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER;
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
