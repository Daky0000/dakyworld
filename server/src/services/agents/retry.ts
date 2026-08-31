import { AnalystError } from "../../lib/claude.js";

/**
 * What to do when a run stops because something outside it went wrong.
 *
 * Before this, one error was treated as temporary — a 429 from the model
 * provider — and everything else failed the task for good. That was defensible
 * when every job ran on a paid Claude key. It stopped being defensible the day
 * free models went to the top of every routing chain: a free tier answers 429
 * when the day's allowance is gone, 503 when the model is busy, and 502 when a
 * provider behind it is having a moment. None of those are facts about the
 * task, and none of them should end one.
 *
 * So the question this file answers is not "did it fail" but **"is this the
 * task's fault"**, and there are three honest answers:
 *
 * - `wait` — nothing is wrong here except the time. Put the run down, keep its
 *   checkpoint, and pick it up again in a few minutes. This is what a rate
 *   limit, a busy model, a gateway error and a timeout all are.
 * - `ask` — something is wrong that waiting will not fix, but a person can:
 *   no key, no credit, a model that refuses the request shape. That is a
 *   question, not a failure, so the task **blocks** and says what to do. It is
 *   still alive, still has its conversation, and carries on the moment the
 *   answer arrives.
 * - `fail` — the run itself is broken. Rare, and the only one that ends a task.
 *
 * **`wait` never ends in `fail`.** A run that has waited its whole budget out
 * ends at `ask`: after two hours of a provider being down, the useful thing on
 * screen is a question naming the vendor, not a dead task whose conversation
 * has been thrown away.
 */

export type Remedy = "wait" | "ask" | "fail";

export interface RetryPlan {
  remedy: Remedy;
  /** Minutes to wait before the next attempt. Only meaningful for `wait`. */
  waitMinutes: number;
  /** What to put in front of a person, in their words rather than the vendor's. */
  reason: string;
}

/**
 * How long a run waits, by how many times it has already waited.
 *
 * Five minutes first, because that is the Owner's instruction and because it is
 * the right number for the case this exists for: an OpenRouter free-tier limit
 * that clears on its own. It then doubles to an hour and stays there — a
 * provider that has been down for an hour is not going to be fixed by asking
 * more often, and a run polling a dead vendor every five minutes for a day is
 * a log nobody can read.
 */
const BACKOFF_MINUTES = [5, 5, 10, 20, 40, 60];

/**
 * How many times a run may be put down for something outside it.
 *
 * Six waits is a little over two and a half hours of a provider being
 * unavailable. Past that it is not a blip and somebody should know.
 */
export const MAX_WAITS = BACKOFF_MINUTES.length;

export function waitMinutesFor(waitsSoFar: number): number {
  return BACKOFF_MINUTES[Math.min(waitsSoFar, BACKOFF_MINUTES.length - 1)];
}

/** Statuses that mean the far end is busy or broken rather than the request being wrong. */
const TEMPORARY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * Phrases that mean "the far end is not there right now", from the places this
 * app already writes them.
 *
 * Matched on text because the chain-exhausted error from `callModel` flattens
 * four vendors' failures into one sentence and keeps only the last status. A
 * run that tried five free models and got five rate limits deserves to wait,
 * and by the time the error reaches here the only thing carrying that fact is
 * the words.
 */
const TEMPORARY_PHRASES = [
  "rate-limited",
  "rate limit",
  "too many requests",
  "could not reach",
  "did not respond in time",
  "timed out",
  "timeout",
  "econnreset",
  "econnrefused",
  "etimedout",
  "enotfound",
  "socket hang up",
  "fetch failed",
  "network",
  "temporarily",
  "overloaded",
  "capacity",
  "try again",
  "service unavailable",
  "bad gateway",
  "not connected",
];

/**
 * Phrases that mean waiting will not help, but somebody with the Settings screen can.
 *
 * **`under settings` is the important one and it is deliberately broad.** This
 * codebase has one convention for "a person has to go and configure something":
 * the sentence names the screen. `lib/models/call.ts`, `registry.ts` and
 * `claudeAgent.ts` all say "Add a key under Settings → AI models", and all
 * three throw it as a **503** — a status that reads as temporary and means the
 * exact opposite. A live run found this: with no model key at all, the task
 * paused for five minutes instead of asking, and would have gone on doing that
 * for two and a half hours before blocking with the same sentence it had at the
 * start. Matching the words rather than the number is what makes the difference,
 * which is also why this list is consulted before the status.
 *
 * **But only where the status has not already answered the question.** These
 * match anywhere in the message, and the message carries the vendor's own prose
 * — `describeRejection` puts up to 300 characters of the response body into it.
 * Two of the three most likely failures in this deployment say one of these
 * words *inside a plain rate limit*: OpenRouter answers a free-tier day limit
 * with "Add 10 credits to unlock 1000 free model requests per day", and Google
 * answers one with "Quota exceeded for quota metric". Both were being read as
 * "the account is out of money", which blocked the task, posted an escalation
 * card and waited for a person — for a limit that clears on its own. See
 * `RATE_LIMITED_ANYWAY` below for the rule that stops it.
 */
const ANSWERABLE_PHRASES: Array<{ match: string; say: string }> = [
  { match: "no model is connected", say: "No model provider is connected, so nothing can run this. Add a key under Settings → AI models." },
  { match: "under settings", say: "This needs something set up before it can run." },
  { match: "no key", say: "No API key is set for the model that has to do this. Add one under Settings → AI models." },
  { match: "rejected the key", say: "A model provider rejected the key it was given. Check it under Settings → AI models." },
  { match: "insufficient", say: "The model provider says there is no credit left on the account." },
  { match: "credit", say: "The model provider says there is no credit left on the account." },
  { match: "quota", say: "The model provider says the account's quota is used up." },
  { match: "billing", say: "The model provider is asking about billing on the account." },
  { match: "declined", say: "The model declined this request. The brief may need rewording." },
  { match: "refused the request shape", say: "The model refused the shape of the request. This is a fault in the app, not in the task." },
];

/**
 * A 429 is a rate limit whoever said it and whatever else the body mentions.
 *
 * The one case where the status has to beat the words. Every other status this
 * file sees is ambiguous — a 503 is "busy" from one vendor and "no key" from
 * this codebase — which is why `ANSWERABLE_PHRASES` is consulted first. 429 is
 * not ambiguous: it means the far end is turning us away for asking too often,
 * and the fix for that is a clock, never a person. Reading a vendor's own
 * suggestion to buy credit as evidence the account is empty is how a limit that
 * clears in five minutes came to stop a task until somebody noticed it.
 */
function rateLimited(status: number | null, lower: string): boolean {
  if (status === 429) return true;
  return /rate.?limit|too many requests|requests per (?:day|minute|hour)/.test(lower);
}

export function planFor(err: unknown, waitsSoFar: number): RetryPlan {
  const message = ((err as Error)?.message ?? String(err)).trim();
  const lower = message.toLowerCase();
  const status = err instanceof AnalystError ? err.status : null;

  // Asked first, deliberately. "not connected" is a 503 in this codebase — a
  // status that reads as temporary and means "there is no key", which no amount
  // of waiting fixes. Reading the words before the number is what keeps a
  // missing key from being retried for two hours and then blocked anyway.
  //
  // Skipped entirely for a rate limit, because there the words are the vendor's
  // and the number is ours. See `rateLimited`.
  const answerable = rateLimited(status, lower) ? undefined : ANSWERABLE_PHRASES.find((entry) => lower.includes(entry.match));
  if (answerable) {
    return { remedy: "ask", waitMinutes: 0, reason: `${answerable.say} (${message})` };
  }

  const temporary =
    (status != null && TEMPORARY_STATUSES.has(status)) || TEMPORARY_PHRASES.some((phrase) => lower.includes(phrase));

  if (!temporary) return { remedy: "fail", waitMinutes: 0, reason: message };

  if (waitsSoFar >= MAX_WAITS) {
    return {
      remedy: "ask",
      waitMinutes: 0,
      reason:
        `Paused ${waitsSoFar} times over about ${totalMinutes(waitsSoFar)} minutes and the model providers are still not answering. ` +
        `Nothing is wrong with this task — it kept its place and will carry on the moment somebody says so. Last thing they said: ${message}`,
    };
  }

  const waitMinutes = waitMinutesFor(waitsSoFar);
  return {
    remedy: "wait",
    waitMinutes,
    reason: `${describe(status, message)} Paused for ${waitMinutes} minutes, then it carries on from where it stopped (pause ${waitsSoFar + 1} of ${MAX_WAITS}).`,
  };
}

/** The vendor's problem, said the way somebody reading the Agents screen would want it. */
function describe(status: number | null, message: string): string {
  if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
    return "The model provider is rate-limiting us — on a free tier that usually means the allowance for now is used up.";
  }
  if (status === 503 || /unavailable|overloaded|capacity/i.test(message)) return "The model is busy or unavailable.";
  if (status === 504 || /timed out|timeout|did not respond/i.test(message)) return "The model provider did not answer in time.";
  if (status === 502 || /bad gateway|could not reach|fetch failed|network/i.test(message)) {
    return "The model provider could not be reached.";
  }
  return message;
}

function totalMinutes(waits: number): number {
  let total = 0;
  for (let at = 0; at < waits; at += 1) total += waitMinutesFor(at);
  return total;
}

/** True when a QUEUED task is waiting on a clock rather than on capacity. */
export function isPaused(task: { status: string; scheduledFor: Date | null; retryReason: string | null }, now = new Date()): boolean {
  return task.status === "QUEUED" && Boolean(task.retryReason) && Boolean(task.scheduledFor && task.scheduledFor > now);
}
