import type { Budget, BudgetPeriod, BudgetScope } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * What the app may spend before it stops itself.
 *
 * Lead capture has had a ceiling since the day it could spend money and a
 * rehearsal has had one since it could fan out across nine agents. The four
 * model vendors had none. So the one part of this system that spends without
 * anybody pressing a button — on a schedule, all night, across a workforce of
 * forty-nine — was the part with nothing above it, and the only symptom of a
 * runaway would be an invoice at the end of the month.
 *
 * **Four actions, not one.** A ceiling that can only stop work is a ceiling
 * nobody dares set low enough to be useful, so the interesting behaviour is in
 * the middle of the range:
 *
 *   50%  warn      say so on screen, change nothing
 *   75%  downgrade keep working, on the cheap model
 *   90%  approve   prepare outward and spending work, do not carry it out
 *   100% pause     start nothing new
 *
 * `downgrade` and `approve` are the two that matter. Between them the workforce
 * spends the last quarter of its budget doing the same work more cheaply and
 * more carefully, rather than falling off a cliff at the end of the month —
 * and both reuse machinery that already exists, the economy model and the
 * dry-run preview, rather than inventing a third way for work to be held.
 *
 * **A missing budget is not a zero budget.** Nothing here is enforced until the
 * Owner sets a limit; `stateFor` returns `none` when no row applies. Shipping a
 * default ceiling would stop a working business on the day it deployed.
 */

/** What happens at this level of a budget. In increasing order of severity. */
export type BudgetAction = "none" | "warn" | "downgrade" | "approve" | "pause";

const ORDER: BudgetAction[] = ["none", "warn", "downgrade", "approve", "pause"];

/** The worse of two actions. Several budgets can apply at once and the strictest wins. */
export function stricter(a: BudgetAction, b: BudgetAction): BudgetAction {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

/**
 * The blueprint's starting thresholds, as fractions of the hard limit.
 *
 * Starting points and not universal rules — its own words — so they are one
 * constant rather than four numbers spread through the file.
 */
export const THRESHOLDS: Array<{ at: number; action: BudgetAction }> = [
  { at: 1.0, action: "pause" },
  { at: 0.9, action: "approve" },
  { at: 0.75, action: "downgrade" },
  { at: 0.5, action: "warn" },
];

export interface BudgetScopeRef {
  scopeType: BudgetScope;
  /** Empty for GLOBAL. The agent key or tool key otherwise. */
  scopeId?: string;
}

export interface BudgetState {
  scopeType: BudgetScope;
  scopeId: string;
  period: BudgetPeriod;
  spentUsd: number;
  softLimitUsd: number | null;
  hardLimitUsd: number | null;
  /** Spend ÷ hard limit. Null when there is no hard limit to divide by. */
  fraction: number | null;
  action: BudgetAction;
  /** One sentence a person can act on. Null when nothing is happening. */
  note: string | null;
}

/**
 * A budget stop is a setting somebody can change, not an accident.
 *
 * Thrown with a sentence written for the person reading it, and named alongside
 * `CaptureBudgetError`, `AnalystError` and `ApifyError` — the classes whose
 * message the error handler in `index.ts` passes through rather than flattening
 * into "Something went wrong". That flattening was a real defect once: building
 * a demo with no model connected threw a 503 saying exactly what to do about
 * it, and the Owner was shown nothing useful.
 */
export class BudgetExceeded extends Error {
  constructor(
    readonly state: BudgetState,
    message?: string,
  ) {
    super(message ?? describe(state));
    this.name = "BudgetExceeded";
  }
}

const num = (value: { toString(): string } | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value.toString());

// --- Reading ----------------------------------------------------------------

/**
 * Where the period started, in UTC.
 *
 * UTC and not the capture timezone, deliberately. A monthly ceiling that rolls
 * over at a different instant from the one the Costs screen totals against
 * would have the two disagree for a few hours every month, and the report is
 * what somebody uses to decide whether the ceiling was right.
 */
export function periodStart(period: BudgetPeriod, now = new Date()): Date {
  if (period === "DAY") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * What this scope has spent this period, models and tools together.
 *
 * Summed from the ledgers rather than read off a counter — see the note on the
 * `Budget` model. Both tables are indexed on the columns used here, so this is
 * two index scans over one period rather than anything expensive.
 */
export async function spentIn(scope: BudgetScopeRef, period: BudgetPeriod, now = new Date()): Promise<number> {
  const since = { gte: periodStart(period, now) };

  if (scope.scopeType === "TOOL") {
    // A tool ceiling covers what that tool charged. The model calls a tool's
    // handler makes are attributed to the *agent* and to the feature, not to
    // the tool, so counting them here would bill the same dollar twice.
    const spent = await prisma.toolCall.aggregate({ where: { tool: scope.scopeId ?? "", createdAt: since }, _sum: { costUsd: true } });
    return num(spent._sum.costUsd) ?? 0;
  }

  const where = scope.scopeType === "AGENT" ? { agentKey: scope.scopeId ?? "" } : {};
  const [models, tools] = await Promise.all([
    prisma.llmCall.aggregate({ where: { ...where, createdAt: since }, _sum: { costUsd: true } }),
    prisma.toolCall.aggregate({ where: { ...where, createdAt: since }, _sum: { costUsd: true } }),
  ]);
  return (num(models._sum.costUsd) ?? 0) + (num(tools._sum.costUsd) ?? 0);
}

function actionFor(spent: number, hardLimitUsd: number | null, softLimitUsd: number | null): BudgetAction {
  // A hard limit of zero is a real setting: stop everything on this scope. The
  // usual `> 0` guard would read it as unset, which is the opposite of what the
  // person typing it meant — the same trap `Rehearsal.budgetUsd` documents.
  if (hardLimitUsd !== null) {
    if (hardLimitUsd === 0) return "pause";
    const fraction = spent / hardLimitUsd;
    for (const threshold of THRESHOLDS) if (fraction >= threshold.at) return threshold.action;
  }
  // A soft limit on its own is a line somebody wants to watch and not be
  // stopped by, so it can only ever warn.
  if (softLimitUsd !== null && spent >= softLimitUsd) return "warn";
  return "none";
}

function describe(state: BudgetState): string {
  const where =
    state.scopeType === "GLOBAL"
      ? "This deployment"
      : state.scopeType === "AGENT"
        ? `The agent ${state.scopeId}`
        : `The tool ${state.scopeId}`;
  const per = state.period === "DAY" ? "today" : "this month";
  const spent = `$${state.spentUsd.toFixed(2)}`;

  if (state.action === "pause") {
    return `${where} has spent ${spent} ${per}, which is at or past its ceiling of $${(state.hardLimitUsd ?? 0).toFixed(2)}. Nothing new will start until the ceiling is raised or the period rolls over.`;
  }
  if (state.action === "approve") {
    return `${where} has spent ${spent} ${per}, which is over 90% of its $${(state.hardLimitUsd ?? 0).toFixed(2)} ceiling. Outward and spending work is being prepared for a decision rather than carried out.`;
  }
  if (state.action === "downgrade") {
    return `${where} has spent ${spent} ${per}, which is over three quarters of its $${(state.hardLimitUsd ?? 0).toFixed(2)} ceiling. Work is carrying on, on the cheaper model.`;
  }
  if (state.action === "warn") {
    const against = state.hardLimitUsd ?? state.softLimitUsd ?? 0;
    return `${where} has spent ${spent} ${per}, against $${against.toFixed(2)}.`;
  }
  return `${where} has spent ${spent} ${per}.`;
}

function stateOf(budget: Budget, spentUsd: number): BudgetState {
  const hardLimitUsd = num(budget.hardLimitUsd);
  const softLimitUsd = num(budget.softLimitUsd);
  const action = actionFor(spentUsd, hardLimitUsd, softLimitUsd);
  const state: BudgetState = {
    scopeType: budget.scopeType,
    scopeId: budget.scopeId,
    period: budget.period,
    spentUsd,
    softLimitUsd,
    hardLimitUsd,
    fraction: hardLimitUsd !== null && hardLimitUsd > 0 ? spentUsd / hardLimitUsd : null,
    action,
    note: null,
  };
  state.note = action === "none" ? null : describe(state);
  return state;
}

// --- The cache --------------------------------------------------------------

/**
 * Budget state, cached briefly in process.
 *
 * A `groupBy` on every model call would cost more than the ceiling saves, and a
 * ceiling checked once a night is not a ceiling. Thirty seconds is the
 * compromise: the most a runaway can overshoot is thirty seconds of work, which
 * on a workforce with a concurrency ceiling of two is a few calls.
 *
 * Per process, like the settings cache and with the same caveat: two instances
 * hold two copies. That is acceptable here in a way it is not for a permission,
 * because the error is bounded and self-correcting — both copies converge on
 * the same ledger within the window.
 */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; state: BudgetState | null }>();

const cacheKey = (scope: BudgetScopeRef, period: BudgetPeriod) => `${scope.scopeType}:${scope.scopeId ?? ""}:${period}`;

/**
 * Is any budget set at all?
 *
 * Cached on the same clock, and checked before anything else, because the
 * shipped state of this feature is *off*: no budget rows, nothing enforced.
 * Without this gate the Tools screen — which asks `permissionFor` once per
 * agent to draw its can/cannot roster — would fire a hundred primary-key
 * lookups to establish that nobody has set a ceiling. With it, a deployment
 * that never uses budgets pays one query every thirty seconds for the whole
 * feature.
 */
let anyBudget: { at: number; value: boolean } | null = null;

async function budgetsExist(): Promise<boolean> {
  if (anyBudget && Date.now() - anyBudget.at < CACHE_MS) return anyBudget.value;
  const value = (await prisma.budget.count({ where: { enabled: true } })) > 0;
  anyBudget = { at: Date.now(), value };
  return value;
}

/** Drops the cache. Called whenever a budget is written, and by the checks. */
export function forgetBudgets(): void {
  cache.clear();
  anyBudget = null;
}

/**
 * What one budget says right now, or null when no budget covers this scope.
 *
 * Null is the shipped state and means "unlimited", not "zero". Nothing in this
 * module is enforced until the Owner sets a limit.
 */
export async function stateFor(scope: BudgetScopeRef, period: BudgetPeriod, now = new Date()): Promise<BudgetState | null> {
  if (!(await budgetsExist())) return null;

  const key = cacheKey(scope, period);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.state;

  const budget = await prisma.budget.findUnique({
    where: { scopeType_scopeId_period: { scopeType: scope.scopeType, scopeId: scope.scopeId ?? "", period } },
  });

  const state = !budget || !budget.enabled ? null : stateOf(budget, await spentIn(scope, period, now));
  cache.set(key, { at: Date.now(), state });
  return state;
}

/**
 * Everything that applies to a piece of work, and the strictest thing any of
 * them says.
 *
 * Both periods of every scope given, because a daily ceiling and a monthly one
 * answer different questions — one stops a bad night, the other protects the
 * month — and a run must obey whichever is tighter right now.
 */
export async function check(scopes: BudgetScopeRef[], now = new Date()): Promise<{ action: BudgetAction; states: BudgetState[]; note: string | null }> {
  const states: BudgetState[] = [];
  for (const scope of scopes) {
    for (const period of ["DAY", "MONTH"] as BudgetPeriod[]) {
      const state = await stateFor(scope, period, now);
      if (state) states.push(state);
    }
  }

  let action: BudgetAction = "none";
  for (const state of states) action = stricter(action, state.action);

  // The sentence comes from whichever budget is actually causing the action, so
  // "nothing is running" names the ceiling that stopped it rather than the
  // first one in the list.
  const cause = states.find((state) => state.action === action && action !== "none");
  return { action, states, note: cause?.note ?? null };
}

/** The scopes that apply to a piece of work an agent is doing. */
export function scopesForAgent(agentKey: string | null | undefined): BudgetScopeRef[] {
  const scopes: BudgetScopeRef[] = [{ scopeType: "GLOBAL", scopeId: "" }];
  if (agentKey) scopes.push({ scopeType: "AGENT", scopeId: agentKey });
  return scopes;
}

/** The scopes that apply to one tool call. */
export function scopesForTool(tool: string, agentKey: string | null | undefined): BudgetScopeRef[] {
  return [...scopesForAgent(agentKey), { scopeType: "TOOL", scopeId: tool }];
}

// --- Writing ----------------------------------------------------------------

export interface BudgetInput {
  scopeType: BudgetScope;
  scopeId?: string;
  period: BudgetPeriod;
  softLimitUsd?: number | null;
  hardLimitUsd?: number | null;
  enabled?: boolean;
  note?: string | null;
}

export async function setBudget(input: BudgetInput): Promise<Budget> {
  const scopeId = input.scopeType === "GLOBAL" ? "" : (input.scopeId ?? "").trim();
  if (input.scopeType !== "GLOBAL" && !scopeId) {
    throw new Error("A budget on an agent or a tool needs to say which one.");
  }

  const data = {
    softLimitUsd: input.softLimitUsd ?? null,
    hardLimitUsd: input.hardLimitUsd ?? null,
    enabled: input.enabled ?? true,
    note: input.note ?? null,
  };

  const budget = await prisma.budget.upsert({
    where: { scopeType_scopeId_period: { scopeType: input.scopeType, scopeId, period: input.period } },
    create: { scopeType: input.scopeType, scopeId, period: input.period, ...data },
    update: data,
  });

  forgetBudgets();
  return budget;
}

export async function removeBudget(id: string): Promise<void> {
  await prisma.budget.delete({ where: { id } });
  forgetBudgets();
}

/** Every budget, with what it has spent — what the Costs screen shows. */
export async function listBudgets(now = new Date()): Promise<Array<Budget & { spentUsd: number; action: BudgetAction; fraction: number | null }>> {
  const budgets = await prisma.budget.findMany({ orderBy: [{ scopeType: "asc" }, { scopeId: "asc" }, { period: "asc" }] });

  return Promise.all(
    budgets.map(async (budget) => {
      const spentUsd = await spentIn({ scopeType: budget.scopeType, scopeId: budget.scopeId }, budget.period, now);
      const state = stateOf(budget, spentUsd);
      return { ...budget, spentUsd, action: state.action, fraction: state.fraction };
    }),
  );
}
