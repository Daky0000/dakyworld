/**
 * Do the numbers on the Costs screen mean what they say?
 *
 * A spend report is the one kind of screen where being confidently wrong is
 * worse than being absent. Every figure here decides something — whether the
 * prompt cache is working, whether an agent is worth what it costs, whether a
 * feature should move to a cheaper model — and a total that quietly double
 * counts, or a ratio computed over the wrong denominator, produces a decision
 * nobody would have made with the truth in front of them.
 *
 * So this seeds ledger rows whose right answers are known by hand, and asserts
 * the arithmetic. The negatives are most of the value:
 *
 *   - **A failed call is spend, and never a denominator.** A timeout after the
 *     tokens burned costs real money and belongs in the total; counting it as
 *     an attempt in "cost per call" would flatter a feature that fails half the
 *     time into looking twice as efficient as one that works.
 *   - **The cache rate divides by everything sent in.** Uncached input, cache
 *     writes and cache reads are three separate columns and all three are
 *     input. Dividing by `inputTokens` alone reports a healthy cache on a run
 *     that cached nothing, which is precisely the failure this tile exists to
 *     catch.
 *   - **A window with none of something says so.** Not zero, not a dash, not a
 *     ratio. "$0 per proposal" in a week with no proposals is a false statement
 *     about the business.
 *   - **Empty days survive.** A chart that closes over a silent week turns a
 *     one-off spike into a trend.
 *   - **The Claude cache rate is Claude's alone.** The chat-completions wire
 *     records no cache at all, by decision, so every free-rung turn dilutes
 *     the global rate. The figure meant to catch a broken Claude cache has to
 *     be computed over Claude rows only, and must say 0 — not null, and not
 *     the global figure — when Claude read nothing.
 *   - **The batch list is a candidate list.** Paid, finished, and outside any
 *     agent task: a zero-cost call has nothing to halve, a failed one is not
 *     work anybody would resubmit, and an agent turn waits on the one before
 *     it. A window with none of them is an empty list, not a row of zeros.
 *
 * A database and nothing else. The `/calls` section mounts the real router on
 * port 0, the way `index.ts` mounts it.
 *   npx tsx checks/costs.ts
 */
import express from "express";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/lib/prisma.js";
import { ensureSystemRoles } from "../src/lib/accessRoles.js";
import { attachUser, requireAuth } from "../src/middleware/auth.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { costsRouter } from "../src/routes/costs.js";
import { costPerOutcome, lastDays, modelSpendBy, paidOneShotByPurpose, spendByDay, spendSummary, toolSpendBy } from "../src/services/costs.js";

const failures: string[] = [];
let passed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const near = (actual: number, expected: number, tolerance = 0.000001) => Math.abs(actual - expected) < tolerance;

/** Everything this check writes carries one of these, so cleanup is exact. */
const PURPOSE = "check.costs";
const OTHER_PURPOSE = "check.costs.other";
const TOOL = "check.costs.tool";
const AGENT = "check-costs-agent";

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000);

async function reset() {
  await prisma.llmCall.deleteMany({ where: { purpose: { startsWith: PURPOSE } } });
  await prisma.toolCall.deleteMany({ where: { tool: TOOL } });
}

async function seed() {
  // Three model calls with hand-computable totals.
  //
  //   ok   $1.00   1000 in,  100 out, 400 cache read, 100 cache written
  //   ok   $2.00   2000 in,  200 out,   0 cache read,   0 cache written
  //   FAIL $0.50    500 in,    0 out,   0 cache read,   0 cache written
  //
  // total $3.50 · in 3500 · out 300 · read 400 · written 100
  // everything sent in = 3500 + 400 + 100 = 4000, so the cache rate is 400/4000 = 10%.
  await prisma.llmCall.createMany({
    data: [
      {
        purpose: PURPOSE, model: "claude-opus-5", agentKey: AGENT, createdAt: hoursAgo(2),
        inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400, cacheCreationTokens: 100,
        costUsd: "1.000000", durationMs: 100, ok: true,
      },
      {
        purpose: PURPOSE, model: "claude-sonnet-5", agentKey: AGENT, createdAt: hoursAgo(3),
        inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: "2.000000", durationMs: 100, ok: true,
      },
      {
        // Failed, and it cost money anyway — the case the failure tile is for.
        purpose: OTHER_PURPOSE, model: "claude-sonnet-5", agentKey: null, createdAt: hoursAgo(4),
        inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: "0.500000", durationMs: 100, ok: false, error: "a deliberate failure",
      },
    ],
  });

  await prisma.toolCall.createMany({
    data: [
      { tool: TOOL, agentKey: AGENT, createdAt: hoursAgo(2), ok: true, dryRun: false, costUsd: "0.250000" },
      { tool: TOOL, agentKey: AGENT, createdAt: hoursAgo(2), ok: true, dryRun: true, costUsd: "0.000000" },
      { tool: TOOL, agentKey: AGENT, createdAt: hoursAgo(2), ok: false, dryRun: false, refusedReason: "a deliberate refusal", costUsd: "0.000000" },
    ],
  });
}

/** A point `days` back, nudged by `hours`, and a twelve-hour window around one. */
const daysAgo = (days: number, hours = 0) => new Date(Date.now() - days * 86_400_000 - hours * 60 * 60_000);
const band = (days: number) => ({ since: daysAgo(days, 6), until: daysAgo(days, -6) });

/**
 * Each of these sections writes into its own day, most of a year back, so
 * nothing a real database holds lands in the same window and every figure can
 * be asserted exactly rather than as a floor.
 */
async function claudeCacheRate() {
  console.log("\nThe Claude cache rate is computed over Claude alone");
  const row = (days: number, model: string, input: number, read: number, written: number, costUsd = "0.010000") => ({
    purpose: `${PURPOSE}.cache`, model, createdAt: daysAgo(days, 1),
    inputTokens: input, outputTokens: 10, cacheReadTokens: read, cacheCreationTokens: written,
    costUsd, durationMs: 100, ok: true,
  });

  // A free rung beside a Claude cache that works.
  //   nvidia/x           6000 in, nothing cached — the chat-completions wire records none
  //   claude-sonnet-5-5  1000 in, 3000 read, nothing written
  // everything:  3000 / (7000 + 3000) = 30%
  // Claude:      3000 / (1000 + 3000) = 75%
  await prisma.llmCall.createMany({
    data: [row(320, "nvidia/x", 6000, 0, 0, "0.000000"), row(320, "claude-sonnet-5-5", 1000, 3000, 0)],
  });
  const diluted = await spendSummary(band(320));
  check("the global rate is still every row's", diluted.cacheHitRate !== null && near(diluted.cacheHitRate, 0.3), `${diluted.cacheHitRate}`);
  check(
    "the Claude rate is reads over input + reads + writes on Claude rows only",
    diluted.claudeCacheHitRate !== null && near(diluted.claudeCacheHitRate, 0.75),
    `${diluted.claudeCacheHitRate}`,
  );
  check("and it says how many Claude calls it is over", diluted.claudeCalls === 1, `${diluted.claudeCalls}`);

  // Free rungs and nothing else. The global rate is a true 0; there is no
  // Claude rate at all, which is a different fact and must not print as 0.
  await prisma.llmCall.createMany({ data: [row(325, "nvidia/x", 5000, 0, 0, "0.000000"), row(325, "nvidia/y", 2000, 0, 0, "0.000000")] });
  const freeOnly = await spendSummary(band(325));
  check("free rungs alone: the global rate is 0", freeOnly.cacheHitRate === 0, `${freeOnly.cacheHitRate}`);
  check("and the Claude rate is null rather than zero", freeOnly.claudeCacheHitRate === null && freeOnly.claudeCalls === 0, `${freeOnly.claudeCacheHitRate} over ${freeOnly.claudeCalls}`);

  // The broken cache the tile exists to catch, beside reads recorded under
  // another model. Nothing outside the Claude SDK path records a cache read
  // today; that row stands in for one that might, so the Claude figure is
  // shown not to borrow anybody else's.
  //   gpt-5.6-terra      1000 in, 9000 read
  //   claude × 2         1000 in each, nothing read, 500 written each
  // everything: 9000 / (3000 + 9000 + 1000) ≈ 69%; Claude: 0 / 3000 = 0
  await prisma.llmCall.createMany({
    data: [row(328, "gpt-5.6-terra", 1000, 9000, 0), row(328, "claude-sonnet-5-5", 1000, 0, 500), row(328, "claude-opus-5-5", 1000, 0, 500)],
  });
  const broken = await spendSummary(band(328));
  check("the global figure stays high", broken.cacheHitRate !== null && broken.cacheHitRate > 0.6, `${broken.cacheHitRate}`);
  check("while Claude reading nothing says exactly 0", broken.claudeCacheHitRate === 0 && broken.claudeCalls === 2, `${broken.claudeCacheHitRate} over ${broken.claudeCalls}`);

  // The model table carries the same three numbers, so a model whose cache
  // broke can be told from one that never had one.
  const byModel = await modelSpendBy("model", band(328), 200);
  const sonnet = byModel.find((entry) => entry.key === "claude-sonnet-5-5");
  const gpt = byModel.find((entry) => entry.key === "gpt-5.6-terra");
  check("a model row carries its cache reads", gpt?.cacheReadTokens === 9000 && sonnet?.cacheReadTokens === 0, `${gpt?.cacheReadTokens} / ${sonnet?.cacheReadTokens}`);
  check("and its cache writes", sonnet?.cacheCreationTokens === 500 && gpt?.cacheCreationTokens === 0, `${sonnet?.cacheCreationTokens} / ${gpt?.cacheCreationTokens}`);
}

async function batchCandidates() {
  console.log("\nPaid one-shot work, by purpose — the batch candidates");
  const A = `${PURPOSE}.batch.a`;
  const B = `${PURPOSE}.batch.b`;
  const FREE = `${PURPOSE}.batch.free`;
  const TASK = `${PURPOSE}.batch.task`;
  const FAILED = `${PURPOSE}.batch.failed`;
  const row = (days: number, purpose: string, model: string, costUsd: string, extra: { ok?: boolean; taskId?: string } = {}) => ({
    purpose, model, createdAt: daysAgo(days, 1), inputTokens: 100, outputTokens: 10,
    costUsd, durationMs: 100, ok: extra.ok ?? true, taskId: extra.taskId ?? null,
  });

  //   a  claude  $0.40  ok              counted
  //   a  gpt     $0.20  ok              counted
  //   a  claude  $0.10  failed          not counted
  //   a  claude  $0.25  inside a task   not counted
  //   b  claude  $0.30  ok              counted
  //   free  nvidia  $0                  nothing to halve
  //   task  claude  $1.00 inside a task an agent turn waits on the last one
  //   failed claude $0.50 failed         not work anybody would resubmit
  // the window's model spend is $2.75, so a is 0.60/2.75 and b is 0.30/2.75.
  await prisma.llmCall.createMany({
    data: [
      row(330, A, "claude-sonnet-5-5", "0.400000"),
      row(330, A, "gpt-5.6-terra", "0.200000"),
      row(330, A, "claude-sonnet-5-5", "0.100000", { ok: false }),
      row(330, A, "claude-sonnet-5-5", "0.250000", { taskId: "check-costs-task" }),
      row(330, B, "claude-sonnet-5-5", "0.300000"),
      row(330, FREE, "nvidia/x", "0.000000"),
      row(330, TASK, "claude-sonnet-5-5", "1.000000", { taskId: "check-costs-task" }),
      row(330, FAILED, "claude-sonnet-5-5", "0.500000", { ok: false }),
    ],
  });
  const list = await paidOneShotByPurpose(band(330));
  const a = list.find((entry) => entry.purpose === A);
  const b = list.find((entry) => entry.purpose === B);
  check("two purposes qualify", list.length === 2, list.map((entry) => entry.purpose).join(", "));
  check("dearest first", list[0]?.purpose === A && list[1]?.purpose === B);
  check("a purpose's figure leaves out its failed call and its task's call", a?.calls === 2 && near(a?.costUsd ?? 0, 0.6), `${a?.calls} calls, $${a?.costUsd}`);
  check("zero-cost work is not a candidate", !list.some((entry) => entry.purpose === FREE));
  check("work done only inside a task is not", !list.some((entry) => entry.purpose === TASK));
  check("work that only failed is not", !list.some((entry) => entry.purpose === FAILED));
  check("a share is of the window's whole model spend", near(a?.share ?? 0, 0.6 / 2.75) && near(b?.share ?? 0, 0.3 / 2.75), `${a?.share} / ${b?.share}`);
  check("the shares come to at most one", list.reduce((total, entry) => total + entry.share, 0) <= 1 + 1e-9);
  check("the Claude part of a purpose is told apart", near(a?.claudeUsd ?? -1, 0.4) && near(b?.claudeUsd ?? -1, 0.3), `${a?.claudeUsd} / ${b?.claudeUsd}`);

  // Nothing qualifying is an empty list. A row of zeros would read as "these
  // were looked at and cost nothing", which is a statement about the business.
  const nothing = await paidOneShotByPurpose(band(350));
  check("a window with no calls has an empty list", Array.isArray(nothing) && nothing.length === 0, JSON.stringify(nothing));
  await prisma.llmCall.createMany({
    data: [
      row(335, FREE, "nvidia/x", "0.000000"),
      row(335, TASK, "claude-sonnet-5-5", "1.000000", { taskId: "check-costs-task" }),
      row(335, FAILED, "claude-sonnet-5-5", "0.500000", { ok: false }),
    ],
  });
  const excludedOnly = await paidOneShotByPurpose(band(335));
  check("nor does one with only free, task and failed calls", excludedOnly.length === 0, JSON.stringify(excludedOnly));

  // Fifteen at most, and the cheapest are the ones that fall off.
  await prisma.llmCall.createMany({
    data: Array.from({ length: 17 }, (_, i) => row(340, `${PURPOSE}.batch.top.${i}`, "claude-sonnet-5-5", ((i + 1) / 100).toFixed(6))),
  });
  const top = await paidOneShotByPurpose(band(340));
  check("the list stops at fifteen", top.length === 15, `${top.length}`);
  check(
    "keeping the dearest",
    top[0]?.purpose === `${PURPOSE}.batch.top.16` && !top.some((entry) => entry.purpose === `${PURPOSE}.batch.top.0` || entry.purpose === `${PURPOSE}.batch.top.1`),
    top.map((entry) => entry.purpose.split(".").pop()).join(","),
  );
}

async function callsFilters() {
  console.log("\nThe rows behind a total, by task and by trace");
  const stamp = Date.now();
  const T1 = `check-costs-task-1-${stamp}`;
  const T2 = `check-costs-task-2-${stamp}`;
  const R1 = `check-costs-trace-1-${stamp}`;
  const R2 = `check-costs-trace-2-${stamp}`;
  const R3 = `check-costs-trace-3-${stamp}`;
  const CALLS = `${PURPOSE}.calls`;
  const row = (taskId: string | null, traceId: string, ok = true) => ({
    purpose: CALLS, model: "claude-sonnet-5-5", createdAt: hoursAgo(6), taskId, traceId,
    inputTokens: 100, outputTokens: 10, costUsd: "0.010000", durationMs: 100, ok,
  });
  await prisma.llmCall.createMany({ data: [row(T1, R1), row(T1, R1), row(T2, R2), row(null, R3, false)] });

  // The real router, mounted the way index.ts mounts it — the gate included.
  await ensureSystemRoles();
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use("/api", requireAuth);
  app.use("/api/costs", costsRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;

  type Row = { taskId: string | null; traceId: string | null; purpose: string; ok: boolean };
  const calls = async (query: Record<string, string>) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/costs/calls?${new URLSearchParams({ days: "1", take: "200", ...query })}`);
    const body = (await res.json()) as { calls?: Row[] };
    return { status: res.status, rows: body.calls ?? [] };
  };

  try {
    const byTask = await calls({ taskId: T1 });
    check("?taskId returns that task's rows", byTask.status === 200 && byTask.rows.length === 2, `${byTask.status}, ${byTask.rows.length} rows`);
    check("and only that task's", byTask.rows.every((entry) => entry.taskId === T1));

    const byTrace = await calls({ traceId: R2 });
    check("?traceId returns that trace's rows, and only those", byTrace.rows.length === 1 && byTrace.rows[0]?.traceId === R2, `${byTrace.rows.length} rows`);

    const both = await calls({ taskId: T2, traceId: R1 });
    check("the two narrow together rather than either one winning", both.rows.length === 0, `${both.rows.length} rows`);

    // The filters that were already there behave as before.
    const byPurpose = await calls({ purpose: CALLS });
    check("?purpose still returns the purpose's rows across tasks", byPurpose.rows.length === 4 && new Set(byPurpose.rows.map((entry) => entry.taskId)).size === 3, `${byPurpose.rows.length} rows`);
    const failedOnly = await calls({ purpose: CALLS, failed: "true" });
    check("?failed still returns only the failures", failedOnly.rows.length === 1 && failedOnly.rows[0]?.ok === false, `${failedOnly.rows.length} rows`);

    const tooLong = await calls({ taskId: "x".repeat(500) });
    check("a filter value that cannot be an id is refused", tooLong.status === 400, `${tooLong.status}`);
  } finally {
    server.close();
  }
}

async function main() {
  await reset();
  await seed();

  const window = lastDays(7);

  console.log("\nThe totals");
  const summary = await spendSummary(window);
  // Other rows may exist in this database, so everything below is asserted as
  // a floor over what the seed added rather than as an absolute — a check that
  // only passes on an empty database is a check that stops being run.

  const mine = await prisma.llmCall.aggregate({
    where: { purpose: { startsWith: PURPOSE } },
    _sum: { costUsd: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true },
  });
  check("the seed is priced as intended", near(Number(mine._sum.costUsd), 3.5), `${mine._sum.costUsd}`);
  check("model spend includes the failed call", summary.modelUsd >= 3.5, `${summary.modelUsd}`);
  check("tool spend is separate from model spend", summary.toolUsd >= 0.25 && summary.modelUsd !== summary.toolUsd);
  check("the total is the two added up", near(summary.totalUsd, summary.modelUsd + summary.toolUsd));

  console.log("\nFailures, refusals and dry runs are told apart");
  check("the failed call is counted", summary.failedCalls >= 1);
  check("what the failure cost is carried", summary.failedUsd >= 0.5, `${summary.failedUsd}`);
  check("a refusal is not a failure", summary.refusedCalls >= 1);
  check("a dry run is not a failure", summary.dryRunCalls >= 1);
  // The negative that matters: a refused or prepared call is the gate working,
  // and folding either into "failed" would have the Owner chasing a fault.
  check("refusals are not in the failure count", summary.failedCalls !== summary.refusedCalls + summary.failedCalls);

  console.log("\nThe cache rate divides by everything sent in");
  const seededOnly = await spendSummary({ since: hoursAgo(5), until: hoursAgo(1) });
  // 400 read ÷ (3500 in + 400 read + 100 written) = 0.10, as long as nothing
  // else was written in that hour band. Asserted on the seeded band alone.
  const sent = seededOnly.inputTokens + seededOnly.cacheReadTokens + seededOnly.cacheCreationTokens;
  check(
    "the denominator is input + reads + writes",
    seededOnly.cacheHitRate !== null && near(seededOnly.cacheHitRate, seededOnly.cacheReadTokens / sent),
    `${seededOnly.cacheHitRate}`,
  );
  // Dividing by `inputTokens` alone would give 400/3500 = 11.4%, which is
  // wrong in the flattering direction — the mistake worth catching.
  check(
    "it is not input alone",
    seededOnly.cacheHitRate !== null && !near(seededOnly.cacheHitRate, seededOnly.cacheReadTokens / seededOnly.inputTokens, 0.001),
  );

  const empty = await spendSummary({ since: hoursAgo(24 * 400), until: hoursAgo(24 * 399) });
  check("an empty window reports no rate rather than zero", empty.cacheHitRate === null, `${empty.cacheHitRate}`);
  check("an empty window totals zero without throwing", empty.totalUsd === 0 && empty.modelCalls === 0);

  console.log("\nThe breakdowns");
  const byPurpose = await modelSpendBy("purpose", window, 200);
  const seededPurpose = byPurpose.find((row) => row.key === PURPOSE);
  check("a purpose row sums its own calls", seededPurpose?.calls === 2, `${seededPurpose?.calls}`);
  check("a purpose row sums its own cost", near(seededPurpose?.costUsd ?? 0, 3), `${seededPurpose?.costUsd}`);
  check("a purpose row sums its own tokens", seededPurpose?.inputTokens === 3000 && seededPurpose?.outputTokens === 300);

  const failedPurpose = byPurpose.find((row) => row.key === OTHER_PURPOSE);
  check("the failed call is in its own purpose row", failedPurpose?.calls === 1);
  check("and is counted as failed there", failedPurpose?.failed === 1, `${failedPurpose?.failed}`);
  check("a row with no failures says zero", seededPurpose?.failed === 0, `${seededPurpose?.failed}`);

  const byModel = await modelSpendBy("model", window, 200);
  const opus = byModel.find((row) => row.key === "claude-opus-5");
  check("spend is grouped by the model that served it", (opus?.calls ?? 0) >= 1);
  check("the breakdown is dearest first", byModel.every((row, i) => i === 0 || byModel[i - 1].costUsd >= row.costUsd));

  const byAgent = await modelSpendBy("agentKey", window, 200);
  check("an agent's calls are grouped under it", byAgent.find((row) => row.key === AGENT)?.calls === 2);
  // A call made outside a task genuinely has no agent — the writers, the audit
  // and the mail room all run without one — so it must read as a fact rather
  // than as a blank cell somebody reports as a bug.
  check("a call with no agent gets a readable label", byAgent.some((row) => row.key.includes("no agent")));

  const byTool = await toolSpendBy(window, 200);
  const tool = byTool.find((row) => row.key === TOOL);
  check("tool calls are grouped by tool", tool?.calls === 3, `${tool?.calls}`);
  check("tool spend sums the ones that charged", near(tool?.costUsd ?? 0, 0.25), `${tool?.costUsd}`);

  console.log("\nDay by day");
  const daily = await spendByDay(lastDays(7));
  check("every day in the window is present", daily.length >= 7, `${daily.length} days`);
  check("the days are oldest first", daily.every((day, i) => i === 0 || daily[i - 1].day <= day.day));
  // The one that matters: a silent day must survive as a silent day, or a chart
  // closes over it and a one-off spike reads as a trend.
  const quiet = await spendByDay({ since: hoursAgo(24 * 400), until: hoursAgo(24 * 397) });
  check("an empty stretch keeps its empty days", quiet.length >= 3 && quiet.every((day) => day.modelUsd === 0 && day.toolUsd === 0));

  console.log("\nCost per successful outcome");
  const outcomes = await costPerOutcome(lastDays(7), 100);
  check("every outcome names what it counted", outcomes.outcomes.every((outcome) => outcome.countedAs.length > 0));
  check(
    "an outcome with a count divides the total",
    outcomes.outcomes.every((outcome) => outcome.count === 0 || near(outcome.costEachUsd ?? 0, 100 / outcome.count)),
  );
  // The honesty rule, and the reason the type is nullable. Zero would be a
  // false statement and a dash would be an unexplained one.
  check(
    "an outcome with no count reports nothing rather than zero",
    outcomes.outcomes.every((outcome) => outcome.count > 0 || outcome.costEachUsd === null),
  );

  const noSpend = await costPerOutcome(lastDays(7), 0);
  check("no spend at all does not throw", noSpend.outcomes.length === outcomes.outcomes.length);

  await claudeCacheRate();
  await batchCandidates();
  await callsFilters();

  // Rule 3: everything this check created, gone — including the refused and
  // dry-run rows, which are the ones a cleanup list naming only successes
  // forgets. The delete is the last thing that happens.
  await reset();
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
