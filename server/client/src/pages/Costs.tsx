import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Card, EmptyState, PageHeader, StatTile, Table } from "../components/ui";
import type { BudgetAction, BudgetPeriod, BudgetRow, BudgetScope, CostReport, DaySpend, Outcome, SpendRow } from "../lib/types";

/**
 * What the workforce spends, and what it got for it.
 *
 * `lib/llmLedger.ts` has said since the day it was written that the question
 * the ledger exists to answer is "what did this month cost and which feature
 * spent it". Nothing answered it. Every model call in this app has been priced
 * and attributed for months — by feature, by agent, by task, by trace — and the
 * only way to read any of it was one task at a time in the agent drawer.
 *
 * Two things on this page are worth more than the totals.
 *
 * **The cache tile.** The prompt cache went missing once for a month: nothing
 * broke, no check failed, every answer was right, and the bill was the only
 * symptom. A cache-hit rate on screen is the cheap way to notice it happening
 * again — a workforce reading none of its instructions from cache is paying
 * full rate to re-send the same playbook a dozen times a run.
 *
 * **The model table.** "Are we paying the headline rate for work that has a
 * right answer" is the question that found the routing defect this screen
 * shipped alongside — mail triage asking for the cheap model in so many words
 * and being served the expensive one on every message that arrived.
 */

const WINDOWS = [7, 30, 90] as const;

const usd = (amount: number) =>
  amount === 0
    ? "$0"
    : amount < 0.01
      ? `$${amount.toFixed(4)}`
      : `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const tokens = (count: number) => (count >= 1000 ? `${Math.round(count / 1000).toLocaleString()}k` : String(count));

export function Costs() {
  const [days, setDays] = useState<number>(30);

  const { data, isLoading } = useQuery({
    queryKey: ["costs", days],
    queryFn: () => api.get<CostReport>(`/costs?days=${days}`),
  });

  const summary = data?.summary;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Agents"
        title="Costs"
        subtitle="Every model call and every tool call this app has paid for, priced at the moment it was made. Spend is recorded against the feature, the agent and the run that caused it."
        action={
          <div className="flex gap-1.5">
            {WINDOWS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDays(option)}
                className={`rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[.12em] transition ${
                  days === option ? "border-blue bg-blue text-white" : "border-line text-ink/55 hover:border-ink/30"
                }`}
              >
                {option} days
              </button>
            ))}
          </div>
        }
      />

      {isLoading || !summary || !data ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label={`Spent · ${summary.windowDays} days`}
              value={usd(summary.totalUsd)}
              sub={`${usd(summary.modelUsd)} models · ${usd(summary.toolUsd)} tools`}
            />
            <StatTile
              label="Calls"
              value={(summary.modelCalls + summary.toolCalls).toLocaleString()}
              sub={`${summary.modelCalls.toLocaleString()} model · ${summary.toolCalls.toLocaleString()} tool`}
            />
            <CacheTile
              rate={summary.cacheHitRate}
              read={summary.cacheReadTokens}
              input={summary.inputTokens}
              written={summary.cacheCreationTokens}
            />
            <FailureTile calls={summary.failedCalls} cost={summary.failedUsd} refused={summary.refusedCalls} dryRun={summary.dryRunCalls} />
          </div>

          <DailyChart days={data.daily} />

          <div className="space-y-8">
            <SpendTable
              heading="By feature"
              note="The `purpose` on each call — which piece of the app asked for it."
              rows={data.byPurpose}
              keyHeading="Purpose"
            />
            <SpendTable
              heading="By model"
              note="The model that actually served each call, as the API reported it. Expensive rates on routine work show up here first."
              rows={data.byModel}
              keyHeading="Model"
            />
            <SpendTable
              heading="By agent"
              note="Only calls made inside a task carry an agent. The writers, the audit and the mail room run without one."
              rows={data.byAgent}
              keyHeading="Agent"
            />
            <SpendTable
              heading="By tool"
              note="Scraping, screenshots, rendering, messaging — priced from what the vendor charged, not from a table in the code. Tools that cost nothing are listed too: how often a tool is called is worth seeing even when the call is free."
              rows={data.byTool}
              keyHeading="Tool"
              tokensColumn={false}
            />
          </div>

          <Outcomes outcomes={data.outcomes.outcomes} totalUsd={data.outcomes.totalUsd} days={summary.windowDays} />

          <Budgets agentKeys={data.byAgent.map((row) => row.key)} toolKeys={data.byTool.map((row) => row.key)} />
        </>
      )}
    </div>
  );
}

/**
 * The cache tile.
 *
 * The denominator is everything that went in — uncached input, cache writes and
 * cache reads are three separate numbers on every row and all three are input.
 * Dividing by `inputTokens` alone would report a healthy rate on a run that
 * cached nothing.
 */
function CacheTile({ rate, read, input, written }: { rate: number | null; read: number; input: number; written: number }) {
  if (rate === null) {
    return <StatTile label="Read from cache" value="—" sub="no model calls in this window" />;
  }
  const percent = Math.round(rate * 100);
  return (
    <StatTile
      label="Read from cache"
      value={`${percent}%`}
      sub={
        read === 0 ? (
          // Not decoration. This is what a broken prompt cache looks like, and
          // it is the only place in the app it would show.
          <span className="text-amber-700">
            nothing cached — every run is paying full rate to re-send its own instructions
          </span>
        ) : (
          `${tokens(read)} read · ${tokens(input)} fresh · ${tokens(written)} written`
        )
      }
    />
  );
}

/**
 * What went wrong, and what it cost anyway.
 *
 * A refusal and a dry run are not failures and are counted apart from one: both
 * are the gate working. They are here because a night when nothing happened
 * looks identical to a night when nothing was allowed to.
 */
function FailureTile({ calls, cost, refused, dryRun }: { calls: number; cost: number; refused: number; dryRun: number }) {
  const held = [refused > 0 ? `${refused} refused` : null, dryRun > 0 ? `${dryRun} prepared` : null].filter(Boolean).join(" · ");
  return (
    <StatTile
      label="Failed calls"
      value={calls.toLocaleString()}
      sub={
        <>
          {calls > 0 ? `${usd(cost)} paid for nothing` : "nothing failed"}
          {held && <span className="text-ink/40"> · {held}</span>}
        </>
      }
    />
  );
}

/**
 * Spend per day, bars.
 *
 * Deliberately not a charting library — this is one series of small numbers and
 * the app has no chart dependency. Empty days are rendered as empty days: a
 * chart that closes over a silent week makes a spike look like a trend.
 */
function DailyChart({ days }: { days: DaySpend[] }) {
  const peak = Math.max(...days.map((day) => day.modelUsd + day.toolUsd), 0);
  if (peak === 0) {
    return (
      <Card>
        <Heading>Day by day</Heading>
        <p className="mt-3 text-sm text-ink/50">Nothing was spent in this window.</p>
      </Card>
    );
  }

  return (
    <Card>
      <Heading>Day by day</Heading>
      <div className="mt-4 flex h-32 items-end gap-[3px]">
        {days.map((day) => {
          const total = day.modelUsd + day.toolUsd;
          const height = total === 0 ? 0 : Math.max(2, Math.round((total / peak) * 100));
          return (
            <div
              key={day.day}
              className="flex-1 rounded-t-sm bg-blue/70 transition hover:bg-blue"
              style={{ height: `${height}%` }}
              title={`${day.day} — ${usd(total)} (${usd(day.modelUsd)} models, ${usd(day.toolUsd)} tools)`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] uppercase tracking-[.12em] text-ink/35">
        <span>{days[0]?.day}</span>
        <span>peak {usd(peak)}</span>
        <span>{days.at(-1)?.day}</span>
      </div>
    </Card>
  );
}

function SpendTable({
  heading,
  note,
  rows,
  keyHeading,
  tokensColumn = true,
}: {
  heading: string;
  note: string;
  rows: SpendRow[];
  keyHeading: string;
  tokensColumn?: boolean;
}) {
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0);

  return (
    <section className="space-y-3">
      <div>
        <Heading>{heading}</Heading>
        <p className="mt-1 text-sm text-ink/50">{note}</p>
      </div>
      {rows.length === 0 ? (
        <EmptyState message="Nothing in this window." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">
              <th className="px-4 py-2.5 font-normal">{keyHeading}</th>
              <th className="px-4 py-2.5 text-right font-normal">Calls</th>
              {tokensColumn && <th className="px-4 py-2.5 text-right font-normal">Tokens</th>}
              <th className="px-4 py-2.5 text-right font-normal">Cost</th>
              <th className="px-4 py-2.5 text-right font-normal">Each</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-2.5">
                  <span className="font-mono text-xs">{row.key}</span>
                  {row.failed > 0 && (
                    <span className="ml-2 align-middle">
                      <Badge tone="warn">{row.failed} failed</Badge>
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink/70">{row.calls.toLocaleString()}</td>
                {tokensColumn && (
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink/55">{tokens(row.inputTokens + row.outputTokens)}</td>
                )}
                <td className="px-4 py-2.5 text-right tabular-nums">{usd(row.costUsd)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink/55">{usd(row.calls > 0 ? row.costUsd / row.calls : 0)}</td>
              </tr>
            ))}
            <tr className="bg-cream/40">
              <td className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">
                {rows.length} row{rows.length === 1 ? "" : "s"}
              </td>
              <td />
              {tokensColumn && <td />}
              <td className="px-4 py-2.5 text-right font-medium tabular-nums">{usd(total)}</td>
              <td />
            </tr>
          </tbody>
        </Table>
      )}
    </section>
  );
}

/**
 * Cost per successful outcome.
 *
 * The blueprint's primary unit metric, and the reason the numbers here do not
 * add up to the total: the whole window's spend is divided by each outcome in
 * turn. That is deliberate and it is stated on the page, because attributing
 * every model call to the one business outcome it eventually contributed to is
 * a much harder problem than it looks — a research call feeds an email, an
 * audit and a proposal — and a made-up allocation is worse than an honest
 * ratio, because it looks precise.
 *
 * A window with none of something prints that it had none. Not a zero, not a
 * dash, and never a ratio: "£0 per proposal" in a week with no proposals is a
 * false statement, and the house rule is that a metric which cannot be sourced
 * is labelled rather than optimised.
 */
function Outcomes({ outcomes, totalUsd, days }: { outcomes: Outcome[]; totalUsd: number; days: number }) {
  return (
    <section className="space-y-3">
      <div>
        <Heading>What it bought</Heading>
        <p className="mt-1 max-w-3xl text-sm text-ink/50">
          The whole {days}-day spend of {usd(totalUsd)} against each finished thing the business produced in the same window. Each line
          divides the <em>same</em> total, so these do not add up and are not meant to — a single research call feeds an email, an audit
          and a proposal, and splitting it between them would be a guess that looked like a measurement. Read them month against month.
        </p>
      </div>
      <Table>
        <thead>
          <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">
            <th className="px-4 py-2.5 font-normal">Outcome</th>
            <th className="px-4 py-2.5 font-normal">Counted as</th>
            <th className="px-4 py-2.5 text-right font-normal">Count</th>
            <th className="px-4 py-2.5 text-right font-normal">Spend each</th>
          </tr>
        </thead>
        <tbody>
          {outcomes.map((outcome) => (
            <tr key={outcome.key} className="border-b border-line/60 last:border-0">
              <td className="px-4 py-2.5">{outcome.label}</td>
              <td className="px-4 py-2.5 text-xs text-ink/45">{outcome.countedAs}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{outcome.count.toLocaleString()}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {outcome.costEachUsd === null ? (
                  <span className="text-ink/35">none in this window</span>
                ) : (
                  usd(outcome.costEachUsd)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">{children}</h2>;
}

// --- Ceilings ---------------------------------------------------------------

const ACTION_TONE: Record<BudgetAction, "default" | "positive" | "muted" | "warn"> = {
  none: "muted",
  warn: "default",
  downgrade: "warn",
  approve: "warn",
  pause: "warn",
};

const ACTION_SAYS: Record<BudgetAction, string> = {
  none: "under half",
  warn: "warning",
  downgrade: "on the cheap model",
  approve: "preparing, not doing",
  pause: "stopped",
};

const money = (value: string | null) => (value === null ? null : Number(value));

/**
 * Ceilings, set here rather than under Settings.
 *
 * The moment somebody wants to change a ceiling is the moment they are looking
 * at what was spent — so the form sits under the tables, and the agent and tool
 * boxes are completed from the rows above it. The things worth capping are
 * exactly the things already spending, and asking somebody to go and find an
 * agent key is how a useful ceiling never gets set.
 */
function Budgets({ agentKeys, toolKeys }: { agentKeys: string[]; toolKeys: string[] }) {
  const client = useQueryClient();
  const { data } = useQuery({
    queryKey: ["costs", "budgets"],
    queryFn: () => api.get<{ budgets: BudgetRow[] }>("/costs/budgets"),
  });
  const budgets = data?.budgets ?? [];

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["costs"] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ budgets: BudgetRow[] }>(`/costs/budgets/${id}`),
    onSuccess: refresh,
  });

  return (
    <section className="space-y-3">
      <div>
        <Heading>Ceilings</Heading>
        <p className="mt-1 max-w-3xl text-sm text-ink/50">
          What a scope may spend before the app stops itself. Nothing is capped until you set one. At half the ceiling this page says
          so; at three quarters the workforce keeps going on the cheaper model; at ninety per cent it prepares outward and spending work
          for your decision instead of doing it; at the ceiling it starts nothing new. A read is never held — an agent that cannot look
          something up is blind, not thrifty.
        </p>
      </div>

      {budgets.length === 0 ? (
        <EmptyState message="No ceilings set. Every model and tool call is currently unlimited." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">
              <th className="px-4 py-2.5 font-normal">Scope</th>
              <th className="px-4 py-2.5 font-normal">Period</th>
              <th className="px-4 py-2.5 text-right font-normal">Spent</th>
              <th className="px-4 py-2.5 text-right font-normal">Warn at</th>
              <th className="px-4 py-2.5 text-right font-normal">Ceiling</th>
              <th className="px-4 py-2.5 font-normal">State</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {budgets.map((budget) => {
              const hard = money(budget.hardLimitUsd);
              const soft = money(budget.softLimitUsd);
              return (
                <tr key={budget.id} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-xs">{budget.scopeType === "GLOBAL" ? "everything" : budget.scopeId}</span>
                    {!budget.enabled && (
                      <span className="ml-2 align-middle">
                        <Badge tone="muted">off</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-ink/60">{budget.period === "DAY" ? "each day" : "each month"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{usd(budget.spentUsd)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink/55">{soft === null ? "—" : usd(soft)}</td>
                  {/* Zero is a real setting and must not render as "no ceiling",
                      or the one person who typed it on purpose cannot see that
                      it took. */}
                  <td className="px-4 py-2.5 text-right tabular-nums">{hard === null ? "no ceiling" : usd(hard)}</td>
                  <td className="px-4 py-2.5">
                    {budget.enabled ? (
                      <Badge tone={ACTION_TONE[budget.action]}>{ACTION_SAYS[budget.action]}</Badge>
                    ) : (
                      <span className="text-ink/35">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => remove.mutate(budget.id)}
                      disabled={remove.isPending}
                      className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40 hover:text-ink/70"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <BudgetForm agentKeys={agentKeys} toolKeys={toolKeys} onSaved={refresh} />
    </section>
  );
}

function BudgetForm({ agentKeys, toolKeys, onSaved }: { agentKeys: string[]; toolKeys: string[]; onSaved: () => void }) {
  const [scopeType, setScopeType] = useState<BudgetScope>("GLOBAL");
  const [scopeId, setScopeId] = useState("");
  const [period, setPeriod] = useState<BudgetPeriod>("MONTH");
  const [soft, setSoft] = useState("");
  const [hard, setHard] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api.put<{ budgets: BudgetRow[] }>("/costs/budgets", {
        scopeType,
        scopeId: scopeType === "GLOBAL" ? undefined : scopeId.trim(),
        period,
        // Blank means unset; "0" means zero, which is a real ceiling. Parsing
        // with `Number(x) || null` would collapse the two and quietly turn
        // "stop everything" into "no limit at all".
        softLimitUsd: soft.trim() === "" ? null : Number(soft),
        hardLimitUsd: hard.trim() === "" ? null : Number(hard),
      }),
    onSuccess: () => {
      setSoft("");
      setHard("");
      setScopeId("");
      onSaved();
    },
  });

  const options = scopeType === "AGENT" ? agentKeys : scopeType === "TOOL" ? toolKeys : [];

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[.12em] text-ink/45">Applies to</label>
          <select
            value={scopeType}
            onChange={(event) => {
              setScopeType(event.target.value as BudgetScope);
              setScopeId("");
            }}
            className="input mt-1 w-40"
          >
            <option value="GLOBAL">Everything</option>
            <option value="AGENT">One agent</option>
            <option value="TOOL">One tool</option>
          </select>
        </div>

        {scopeType !== "GLOBAL" && (
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-[.12em] text-ink/45">Which one</label>
            <input
              list="costs-scope-options"
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
              placeholder={scopeType === "AGENT" ? "outreach.writer" : "capture.run"}
              className="input mt-1 w-52"
            />
            {/* Completed from what is actually spending above. A key somebody
                has to go and look up is a ceiling that never gets set. */}
            <datalist id="costs-scope-options">
              {options.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          </div>
        )}

        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[.12em] text-ink/45">Period</label>
          <select value={period} onChange={(event) => setPeriod(event.target.value as BudgetPeriod)} className="input mt-1 w-36">
            <option value="MONTH">Each month</option>
            <option value="DAY">Each day</option>
          </select>
        </div>

        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[.12em] text-ink/45">Warn at ($)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={soft}
            onChange={(event) => setSoft(event.target.value)}
            placeholder="optional"
            className="input mt-1 w-32"
          />
        </div>

        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[.12em] text-ink/45">Ceiling ($)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={hard}
            onChange={(event) => setHard(event.target.value)}
            placeholder="optional"
            className="input mt-1 w-32"
          />
        </div>

        <Button onClick={() => save.mutate()} disabled={save.isPending || (scopeType !== "GLOBAL" && !scopeId.trim())}>
          {save.isPending ? "Saving…" : "Set ceiling"}
        </Button>
      </div>

      <p className="mt-3 text-xs text-ink/45">
        Leave a box empty for no limit of that kind. A ceiling of <span className="font-mono">0</span> is a real setting and stops all
        spend on that scope — it is not read as "unset".
      </p>

      {save.error && <p className="mt-3 text-sm text-red-700">{(save.error as Error).message}</p>}
    </Card>
  );
}
