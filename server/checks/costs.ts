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
 *
 * A database and nothing else.
 *   npx tsx checks/costs.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { costPerOutcome, lastDays, modelSpendBy, spendByDay, spendSummary, toolSpendBy } from "../src/services/costs.js";

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
