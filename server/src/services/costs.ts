import { prisma } from "../lib/prisma.js";

/**
 * What this month cost, and which feature spent it.
 *
 * That sentence is copied out of `lib/llmLedger.ts`, where it has described the
 * purpose of the ledger since the day it was written — and until this module
 * existed nothing in the app could answer it. `LlmCall` was read in exactly
 * three places: one task at a time in the task drawer, one run at a time in a
 * rehearsal, and as a single number inside the `analytics.read` tool. A year of
 * priced, attributed, indexed rows, and no way to ask them the question they
 * were collected for.
 *
 * Everything here is read-only aggregation over the two ledgers. It is grouped
 * by the columns those tables are already indexed on — `purpose`, `agentKey`,
 * `model`, `tool`, `createdAt` — so none of this needed a migration.
 *
 * **Two rules the numbers follow.**
 *
 * A failed call is spend. A burst of rate-limit failures costs nothing and a
 * timeout after the tokens were burned costs plenty; both are in the totals and
 * both are counted separately, because "what did we pay for nothing" is the
 * question that makes an unreliable vendor visible. It is never in a
 * *denominator* — dividing by attempts rather than by successes flatters a
 * feature that fails half the time.
 *
 * And a ratio with no denominator is not printed. Cost per proposal in a week
 * with no proposals is not zero and is not infinity; it is a thing we have no
 * evidence about, and the blueprint's own last rule is that a metric which
 * cannot be sourced is labelled uncertain rather than optimised.
 */

export interface Window {
  since: Date;
  until: Date;
}

/** A window of whole days ending now. */
export function lastDays(days: number): Window {
  const until = new Date();
  return { since: new Date(until.getTime() - days * 24 * 60 * 60_000), until };
}

const num = (value: { toString(): string } | null | undefined): number => (value === null || value === undefined ? 0 : Number(value.toString()));

export interface SpendSummary {
  windowDays: number;
  since: string;
  until: string;

  /** Model spend and tool spend, and the two added up. */
  modelUsd: number;
  toolUsd: number;
  totalUsd: number;

  modelCalls: number;
  toolCalls: number;

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;

  /**
   * The share of everything sent to a model that was read from cache.
   *
   * Uncached input, cache writes and cache reads are three separate numbers on
   * every row and they are all input — so the denominator is all three, not
   * `inputTokens` alone. Watching this is the only cheap way to notice the
   * prompt cache breaking again: it went missing once for a month, nothing
   * failed, every answer was right, and the bill was the only symptom.
   *
   * Null rather than zero when nothing was sent at all, because "no cache hits"
   * and "no calls" are different facts and only the first is a problem.
   */
  cacheHitRate: number | null;

  /** Calls that failed, and what they cost anyway. */
  failedCalls: number;
  failedUsd: number;
  /** Tool calls the gate refused. Free, and worth seeing — see `refusedNote`. */
  refusedCalls: number;
  /** Tool calls prepared and deliberately not carried out. */
  dryRunCalls: number;
}

export async function spendSummary(window: Window): Promise<SpendSummary> {
  const range = { gte: window.since, lte: window.until };

  const [models, failures, tools, refused, dryRun] = await Promise.all([
    prisma.llmCall.aggregate({
      where: { createdAt: range },
      _sum: { costUsd: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true },
      _count: true,
    }),
    prisma.llmCall.aggregate({ where: { createdAt: range, ok: false }, _sum: { costUsd: true }, _count: true }),
    prisma.toolCall.aggregate({ where: { createdAt: range }, _sum: { costUsd: true }, _count: true }),
    prisma.toolCall.count({ where: { createdAt: range, refusedReason: { not: null } } }),
    prisma.toolCall.count({ where: { createdAt: range, dryRun: true } }),
  ]);

  const inputTokens = models._sum.inputTokens ?? 0;
  const cacheReadTokens = models._sum.cacheReadTokens ?? 0;
  const cacheCreationTokens = models._sum.cacheCreationTokens ?? 0;
  const sentIn = inputTokens + cacheReadTokens + cacheCreationTokens;

  const modelUsd = num(models._sum.costUsd);
  const toolUsd = num(tools._sum.costUsd);

  return {
    windowDays: Math.round((window.until.getTime() - window.since.getTime()) / 86_400_000),
    since: window.since.toISOString(),
    until: window.until.toISOString(),

    modelUsd,
    toolUsd,
    totalUsd: modelUsd + toolUsd,

    modelCalls: models._count,
    toolCalls: tools._count,

    inputTokens,
    outputTokens: models._sum.outputTokens ?? 0,
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRate: sentIn > 0 ? cacheReadTokens / sentIn : null,

    failedCalls: failures._count,
    failedUsd: num(failures._sum.costUsd),
    refusedCalls: refused,
    dryRunCalls: dryRun,
  };
}

// --- Breakdowns -------------------------------------------------------------

export interface SpendRow {
  /** The grouping value. Null becomes a readable stand-in, never an empty cell. */
  key: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls in this row that failed. A row that is mostly failures is the point. */
  failed: number;
}

export type ModelDimension = "purpose" | "agentKey" | "model";

/**
 * Model spend grouped one way, dearest first.
 *
 * `purpose` answers "which feature", `agentKey` answers "which colleague", and
 * `model` answers "are we paying the headline rate for work that has a right
 * answer" — which is the question that found the routing defect this module
 * shipped alongside.
 */
export async function modelSpendBy(dimension: ModelDimension, window: Window, limit = 40): Promise<SpendRow[]> {
  const where = { createdAt: { gte: window.since, lte: window.until } };

  const [grouped, failures] = await Promise.all([
    prisma.llmCall.groupBy({
      by: [dimension],
      where,
      _sum: { costUsd: true, inputTokens: true, outputTokens: true },
      _count: true,
    }),
    prisma.llmCall.groupBy({ by: [dimension], where: { ...where, ok: false }, _count: true }),
  ]);

  const failedBy = new Map(failures.map((row) => [String(row[dimension] ?? ""), row._count]));

  return grouped
    .map((row) => {
      const raw = row[dimension];
      return {
        // A call made outside a task has no agent, which is a true and common
        // answer — the writers, the audit and the mail room all run without
        // one. Blank would read as a bug in the table.
        key: raw === null || raw === undefined || raw === "" ? unattributed(dimension) : String(raw),
        calls: row._count,
        costUsd: num(row._sum.costUsd),
        inputTokens: row._sum.inputTokens ?? 0,
        outputTokens: row._sum.outputTokens ?? 0,
        failed: failedBy.get(String(raw ?? "")) ?? 0,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls)
    .slice(0, limit);
}

function unattributed(dimension: ModelDimension): string {
  if (dimension === "agentKey") return "no agent (a writer or a person)";
  if (dimension === "model") return "model not recorded";
  return "no purpose recorded";
}

/** Tool spend grouped by tool, dearest first. Only the tools that spend appear. */
export async function toolSpendBy(window: Window, limit = 40): Promise<SpendRow[]> {
  const where = { createdAt: { gte: window.since, lte: window.until } };

  const [grouped, failures] = await Promise.all([
    prisma.toolCall.groupBy({ by: ["tool"], where, _sum: { costUsd: true }, _count: true }),
    prisma.toolCall.groupBy({ by: ["tool"], where: { ...where, ok: false }, _count: true }),
  ]);

  const failedBy = new Map(failures.map((row) => [row.tool, row._count]));

  return grouped
    .map((row) => ({
      key: row.tool,
      calls: row._count,
      costUsd: num(row._sum.costUsd),
      inputTokens: 0,
      outputTokens: 0,
      failed: failedBy.get(row.tool) ?? 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls)
    .slice(0, limit);
}

// --- Over time --------------------------------------------------------------

export interface DaySpend {
  /** `YYYY-MM-DD`, in UTC. */
  day: string;
  modelUsd: number;
  toolUsd: number;
}

/**
 * Spend per day, oldest first, with the empty days present.
 *
 * The gaps matter: a chart that closes over a silent week makes a spike look
 * like a trend. Grouped in JavaScript rather than in SQL because Prisma cannot
 * `groupBy` a truncated date without raw SQL, and the row counts here are small
 * enough that it is not worth leaving the type checker behind for.
 */
export async function spendByDay(window: Window): Promise<DaySpend[]> {
  const range = { gte: window.since, lte: window.until };

  const [models, tools] = await Promise.all([
    prisma.llmCall.findMany({ where: { createdAt: range }, select: { createdAt: true, costUsd: true } }),
    prisma.toolCall.findMany({ where: { createdAt: range }, select: { createdAt: true, costUsd: true } }),
  ]);

  const days = new Map<string, DaySpend>();
  for (let at = startOfDay(window.since); at <= window.until; at = new Date(at.getTime() + 86_400_000)) {
    days.set(dayKey(at), { day: dayKey(at), modelUsd: 0, toolUsd: 0 });
  }

  for (const row of models) {
    const day = days.get(dayKey(row.createdAt));
    if (day) day.modelUsd += num(row.costUsd);
  }
  for (const row of tools) {
    const day = days.get(dayKey(row.createdAt));
    if (day) day.toolUsd += num(row.costUsd);
  }

  return [...days.values()];
}

const dayKey = (at: Date) => at.toISOString().slice(0, 10);
const startOfDay = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

// --- Cost per successful outcome --------------------------------------------

export interface Outcome {
  key: string;
  /** What was counted, in the Owner's words. */
  label: string;
  /** What makes one of these count. Printed, because a ratio without it is a rumour. */
  countedAs: string;
  count: number;
  /** Total spend ÷ count. Null when the count is zero — see the note at the top. */
  costEachUsd: number | null;
}

/**
 * The blueprint's primary unit metric: spend ÷ accepted, completed outcomes.
 *
 * Every denominator here is something that *finished* — a lead that got past
 * the first sift, a proposal that went out, an invoice that was paid, a letter
 * that actually left. Counting attempts instead would make a feature that fails
 * half the time look twice as efficient as one that works.
 *
 * **These share one numerator on purpose, and it is not a cost allocation.**
 * The whole window's spend is divided by each outcome in turn, so the columns
 * do not add up to the total and are not meant to. Attributing every model call
 * to the one business outcome it eventually contributed to is a much harder
 * problem than it looks — a lead research call feeds an email, an audit and a
 * proposal — and a made-up allocation is worse than an honest ratio, because it
 * looks precise. What this answers is "we spent this much and got these things",
 * which is the comparison worth making month against month.
 */
export async function costPerOutcome(window: Window, totalUsd: number): Promise<{ totalUsd: number; outcomes: Outcome[] }> {
  const range = { gte: window.since, lte: window.until };

  const [qualified, proposalsSent, proposalsWon, invoicesPaid, emailsSent, audits, demos] = await Promise.all([
    // Past NEW, which is where a scrape drops one. Getting a row out of the
    // first sift is the first thing in this pipeline that took judgement.
    prisma.lead.count({ where: { createdAt: range, rehearsal: false, status: { notIn: ["NEW", "DISQUALIFIED"] } } }),
    prisma.proposal.count({ where: { sentAt: range } }),
    prisma.proposal.count({ where: { sentAt: range, status: "ACCEPTED" } }),
    prisma.invoice.count({ where: { paidAt: range, status: "PAID" } }),
    prisma.emailMessage.count({ where: { sentAt: range, status: "SENT" } }),
    prisma.websiteAudit.count({ where: { createdAt: range } }),
    prisma.demo.count({ where: { createdAt: range } }),
  ]);

  const each = (count: number) => (count > 0 ? totalUsd / count : null);

  return {
    totalUsd,
    outcomes: [
      { key: "qualifiedLead", label: "Leads past the first sift", countedAs: "created in this window and no longer NEW or DISQUALIFIED", count: qualified, costEachUsd: each(qualified) },
      { key: "proposalSent", label: "Proposals sent", countedAs: "sentAt falls in this window", count: proposalsSent, costEachUsd: each(proposalsSent) },
      { key: "proposalWon", label: "Proposals accepted", countedAs: "sent in this window and now ACCEPTED", count: proposalsWon, costEachUsd: each(proposalsWon) },
      { key: "invoicePaid", label: "Invoices paid", countedAs: "paidAt falls in this window", count: invoicesPaid, costEachUsd: each(invoicesPaid) },
      { key: "emailSent", label: "Emails that left the building", countedAs: "status SENT, sentAt in this window", count: emailsSent, costEachUsd: each(emailsSent) },
      { key: "audit", label: "Website reviews produced", countedAs: "a WebsiteAudit row created in this window", count: audits, costEachUsd: each(audits) },
      { key: "demo", label: "Demo pages built", countedAs: "a Demo row created in this window", count: demos, costEachUsd: each(demos) },
    ],
  };
}

// --- The whole picture ------------------------------------------------------

export interface CostReport {
  summary: SpendSummary;
  byPurpose: SpendRow[];
  byAgent: SpendRow[];
  byModel: SpendRow[];
  byTool: SpendRow[];
  daily: DaySpend[];
  outcomes: { totalUsd: number; outcomes: Outcome[] };
}

export async function costReport(days: number): Promise<CostReport> {
  const window = lastDays(days);

  const [summary, byPurpose, byAgent, byModel, byTool, daily] = await Promise.all([
    spendSummary(window),
    modelSpendBy("purpose", window),
    modelSpendBy("agentKey", window),
    modelSpendBy("model", window),
    toolSpendBy(window),
    spendByDay(window),
  ]);

  return { summary, byPurpose, byAgent, byModel, byTool, daily, outcomes: await costPerOutcome(window, summary.totalUsd) };
}
