import {
  ApifyError,
  ApifyNotConfiguredError,
  getDatasetItems,
  getRun,
  runCost,
  startRun,
  type ApifyRun,
  type ApifyRunStatus,
  type StartRunOptions,
} from "../lib/apify.js";

/**
 * Start one actor, wait for it, hand back its rows.
 *
 * This existed twice before it existed once. `scraperRunner.pollUntilDone`
 * polls a run and ingests it into leads; `siteShot.captureHomepages` had its
 * own inline start-poll-read loop for screenshots, with its own timeout, its
 * own idea of which statuses are terminal, and its own retry story (none).
 * Adding a third copy for the agent-facing capture tools would have made the
 * lifecycle three things that have to be corrected in three places — and the
 * two that existed already disagreed: the screenshot loop treated `ABORTING`
 * and `TIMING-OUT` as finished, so a run being killed was reported to the
 * caller as a run that failed for an unknown reason.
 *
 * So this is the one place a bare actor run happens. It is deliberately *only*
 * the run: no leads, no pictures, no cost policy, no database. Those belong to
 * the callers, which is why `scraperRunner` still owns ingestion and
 * `siteShot` still owns cropping.
 *
 * ## It does not throw
 *
 * Every failure comes back as a value with a code, because every caller has to
 * say something specific about it and an exception makes that a `catch` with a
 * string match in it. The codes are the vocabulary the agent-facing tools
 * report — see `ACTOR_ERRORS` in `services/captureOnDemand.ts`.
 *
 * ## What it retries, and what it must not
 *
 * Only the *start*, and only when the failure is transient — a network error,
 * a 5xx, or a 429. Apify rejecting the input is a permanent answer about the
 * input; a bad token is a permanent answer about the token; and retrying
 * either wastes a person's time in exchange for the same refusal. A run that
 * has already started is never restarted whatever happens next: it may have
 * been billed, and a second run would be billed again.
 */

export type ActorRunCode =
  /** No token at all. */
  | "APIFY_NOT_CONFIGURED"
  /** A token that Apify rejected. */
  | "APIFY_AUTH_ERROR"
  /** Apify refused to start the run — usually the input, sometimes the actor id. */
  | "ACTOR_START_FAILED"
  /** The run started and ended badly. */
  | "ACTOR_FAILED"
  /** Somebody or something stopped it. */
  | "ACTOR_ABORTED"
  /** Apify's own timeout fired. */
  | "ACTOR_TIMEOUT"
  /** Our patience ran out. The run itself is still going and may still succeed. */
  | "STILL_RUNNING"
  /** Apify could not be reached, or stopped answering mid-poll. */
  | "APIFY_UNREACHABLE"
  /** The run succeeded and its dataset could not be read. */
  | "DATASET_RETRIEVAL_FAILED"
  | "RATE_LIMITED";

export interface ActorRunSuccess {
  ok: true;
  runId: string;
  datasetId: string;
  items: Record<string, unknown>[];
  /** True when there were more rows than `maxItemsRead` and the rest were left. */
  truncated: boolean;
  /** What Apify billed, when it says. Null is "not reported", never "free". */
  costUsd: number | null;
  durationMs: number;
}

export interface ActorRunFailure {
  ok: false;
  code: ActorRunCode;
  /** One sentence, safe to show a person. Never carries a credential. */
  message: string;
  /** Set once the run exists, so a caller can collect it later or abort it. */
  runId: string | null;
  status: ApifyRunStatus | null;
  /** A run that failed part-way through has usually still been charged for. */
  costUsd: number | null;
}

export type ActorRunResult = ActorRunSuccess | ActorRunFailure;

/** Poll quickly at first — most short runs finish inside the first minute. */
const POLL_FAST_MS = 3_000;
const POLL_SLOW_MS = 10_000;
const POLL_FAST_WINDOW_MS = 60_000;

const TERMINAL: ApifyRunStatus[] = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"];

/** How many rows one call reads back by default. Past this it is a dataset, not an answer. */
export const DEFAULT_MAX_ITEMS_READ = 500;

export interface RunActorOptions extends StartRunOptions {
  /** How long to wait before giving up on *waiting*. The run carries on. */
  waitMs?: number;
  /** Rows to read from the dataset. */
  maxItemsRead?: number;
  /** Transient start failures to ride out. Zero disables retrying entirely. */
  startRetries?: number;
}

const fail = (
  code: ActorRunCode,
  message: string,
  extra: Partial<Pick<ActorRunFailure, "runId" | "status" | "costUsd">> = {},
): ActorRunFailure => ({ ok: false, code, message, runId: null, status: null, costUsd: null, ...extra });

/**
 * Which failures are worth a second attempt.
 *
 * A 429 is here because Apify rate-limits per account and a scheduled hunt
 * plus a person pressing Capture is a genuinely momentary collision. 401/403
 * is not: a token is either right or wrong, and retrying a wrong one three
 * times is three ways of saying the same thing more slowly.
 */
function transient(err: unknown): boolean {
  if (err instanceof ApifyNotConfiguredError) return false;
  if (err instanceof ApifyError) return err.status === 429 || err.status >= 500 || err.status === 502 || err.status === 504;
  return true; // A thrown network error rather than an answer from Apify.
}

function startFailure(err: unknown): ActorRunFailure {
  if (err instanceof ApifyNotConfiguredError) return fail("APIFY_NOT_CONFIGURED", err.message);
  if (err instanceof ApifyError) {
    if (err.status === 401 || err.status === 403) return fail("APIFY_AUTH_ERROR", err.message);
    if (err.status === 429) return fail("RATE_LIMITED", "Apify is rate-limiting this account. Try again shortly.");
    if (err.status === 504 || err.status === 502) return fail("APIFY_UNREACHABLE", err.message);
    return fail("ACTOR_START_FAILED", err.message);
  }
  return fail("ACTOR_START_FAILED", (err as Error).message ?? "Apify would not start the run.");
}

/**
 * Starts a run and hands back its record, or says why not.
 *
 * Split out from `runActor` because `scraperRunner` needs exactly this half:
 * it writes its own `ScraperRun` row from the result and does its own polling
 * in a detached task, so that an HTTP request never waits for a scrape.
 */
export async function beginActorRun(
  actorId: string,
  input: unknown,
  options: RunActorOptions = {},
): Promise<{ ok: true; run: ApifyRun } | ActorRunFailure> {
  const attempts = Math.max(0, options.startRetries ?? 2);
  let last: unknown = null;

  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      const run = await startRun(actorId, input, options);
      return { ok: true, run };
    } catch (err) {
      last = err;
      // A permanent answer is permanent on the first attempt. Anything else
      // gets a widening pause — long enough to outlast a rate-limit window,
      // short enough that a person waiting does not give up first.
      if (!transient(err) || attempt === attempts) break;
      await wait(1_000 * 2 ** attempt);
    }
  }
  return startFailure(last);
}

/**
 * Waits for a run that has already started.
 *
 * `STILL_RUNNING` is not an error about the run — it is this function saying
 * it stopped watching. The run id comes back with it precisely so the caller
 * can collect the result later rather than treating a slow scrape as a lost
 * one, which is the whole of the asynchronous story: nothing here abandons
 * work that has been paid for.
 */
export async function awaitActorRun(
  runId: string,
  actorId: string,
  waitMs: number,
): Promise<{ ok: true; run: ApifyRun; costUsd: number | null } | ActorRunFailure> {
  const startedWaiting = Date.now();
  const giveUpAt = startedWaiting + waitMs;
  let run: ApifyRun | null = null;

  for (;;) {
    try {
      run = await getRun(runId);
    } catch (err) {
      if (err instanceof ApifyNotConfiguredError) return fail("APIFY_NOT_CONFIGURED", err.message, { runId });
      // One unanswered poll is not a failed run. Keep waiting while there is
      // time left; only a poll that fails with no time left gives up, and it
      // still names the run so it can be collected afterwards.
      if (Date.now() < giveUpAt) {
        await wait(POLL_SLOW_MS);
        continue;
      }
      return fail("APIFY_UNREACHABLE", `Apify stopped answering about this run: ${(err as Error).message}`, { runId });
    }

    if (TERMINAL.includes(run.status)) break;

    if (Date.now() >= giveUpAt) {
      const cost = await runCost(run, actorId).catch(() => ({ totalUsd: null, events: null }));
      return fail(
        "STILL_RUNNING",
        `The run was still going after ${Math.round(waitMs / 1000)} seconds. It has not been stopped — collect it by its run id.`,
        { runId, status: run.status, costUsd: cost.totalUsd },
      );
    }
    const elapsed = Date.now() - startedWaiting;
    await wait(elapsed < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS);
  }

  const cost = await runCost(run, actorId).catch(() => ({ totalUsd: null, events: null }));
  if (run.status === "SUCCEEDED") return { ok: true, run, costUsd: cost.totalUsd };

  const code: ActorRunCode =
    run.status === "TIMED-OUT" ? "ACTOR_TIMEOUT" : run.status === "ABORTED" ? "ACTOR_ABORTED" : "ACTOR_FAILED";
  const said = run.statusMessage?.trim() ? ` ${run.statusMessage.trim()}` : "";
  return fail(code, `The run ${run.status.toLowerCase().replace("-", " ")}.${said}`, {
    runId,
    status: run.status,
    costUsd: cost.totalUsd,
  });
}

/** Reads a finished run's dataset. Separate so a caller can collect a run it did not start. */
export async function readActorDataset(
  datasetId: string,
  maxItemsRead = DEFAULT_MAX_ITEMS_READ,
): Promise<{ ok: true; items: Record<string, unknown>[]; truncated: boolean } | ActorRunFailure> {
  try {
    // One row over the ceiling, so "there were more" is a fact rather than a
    // guess from the count landing exactly on the limit.
    const items = await getDatasetItems(datasetId, maxItemsRead + 1);
    const truncated = items.length > maxItemsRead;
    return { ok: true, items: truncated ? items.slice(0, maxItemsRead) : items, truncated };
  } catch (err) {
    if (err instanceof ApifyNotConfiguredError) return fail("APIFY_NOT_CONFIGURED", err.message);
    return fail("DATASET_RETRIEVAL_FAILED", `The run finished but its results could not be read: ${(err as Error).message}`);
  }
}

/**
 * The whole of it: start, wait, read.
 *
 * For a caller that genuinely wants to block — a screenshot a person is
 * waiting for, a capability call inside an agent's turn. Anything scheduled
 * or unattended should use `beginActorRun` and poll on its own record instead,
 * which is what `scraperRunner` does.
 */
export async function runActor(actorId: string, input: unknown, options: RunActorOptions = {}): Promise<ActorRunResult> {
  const startedAt = Date.now();
  const begun = await beginActorRun(actorId, input, options);
  if (!begun.ok) return begun;

  const waited = await awaitActorRun(begun.run.id, actorId, options.waitMs ?? 10 * 60_000);
  if (!waited.ok) return waited;

  const dataset = await readActorDataset(waited.run.defaultDatasetId, options.maxItemsRead ?? DEFAULT_MAX_ITEMS_READ);
  if (!dataset.ok) return { ...dataset, runId: waited.run.id, status: waited.run.status, costUsd: waited.costUsd };

  return {
    ok: true,
    runId: waited.run.id,
    datasetId: waited.run.defaultDatasetId,
    items: dataset.items,
    truncated: dataset.truncated,
    costUsd: waited.costUsd,
    durationMs: Date.now() - startedAt,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
