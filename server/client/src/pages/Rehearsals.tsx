import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type {
  AgentStepKind,
  AgentTaskStatus,
  RehearsalDetail,
  RehearsalScenario,
  RehearsalScenarioList,
  RehearsalStep,
  RehearsalSummary,
} from "../lib/types";
import { STEP_LABEL, STEP_STYLE } from "../components/AgentWork";
import { Badge, Button, Card, EmptyState, Eyebrow, Field, PageHeader, RelativeTime, StatTile, StatusDot } from "../components/ui";

/**
 * The rehearsal room.
 *
 * Everywhere else in this app an agent is watched one at a time: you open a
 * card, read its timeline, and close it. That is the right shape for asking
 * *what is this agent doing* and the wrong shape for the question this screen
 * exists to answer, which is **what happens to a business when the whole floor
 * gets hold of it**. A chain of six agents read six drawers at a time is six
 * tabs and no sense of order — you cannot see that the letter was written
 * before anybody had looked at the site, because the two facts are in
 * different windows.
 *
 * So the timeline here is *merged*: every step from every agent in the run, in
 * the order it actually happened, grouped by whoever was speaking. It reads
 * like the transcript of a meeting, and the handovers are visible as handovers.
 *
 * Nothing on this screen can reach a client. Every tool call in a rehearsal is
 * forced to a preview at the gate, which is stated at the top rather than left
 * to be trusted.
 */

const STATUS_TONE: Record<AgentTaskStatus, "live" | "ok" | "warn" | "bad" | "idle"> = {
  RUNNING: "live",
  QUEUED: "idle",
  NEEDS_APPROVAL: "warn",
  BLOCKED: "warn",
  DONE: "ok",
  FAILED: "bad",
  CANCELLED: "idle",
};

/**
 * The filters over the merged stream.
 *
 * "Reasoning" is the one people reach for. It is what the agents said on the
 * way — the sentences between the tool calls — and until Aug 2026 the runtime
 * collected it, paid for it and showed it to nobody.
 */
const LENSES = {
  all: { label: "Everything", kinds: null as AgentStepKind[] | null },
  reasoning: { label: "Reasoning", kinds: ["THOUGHT", "FINISHED", "BLOCKED"] as AgentStepKind[] },
  tools: { label: "Tools", kinds: ["TOOL_CALL", "PREPARED", "REFUSED"] as AgentStepKind[] },
  handovers: { label: "Handovers", kinds: ["DELEGATED", "HANDED_OFF", "CONSULTED", "GAP_RAISED"] as AgentStepKind[] },
  memory: { label: "What it kept", kinds: ["REMEMBERED", "NOTED"] as AgentStepKind[] },
  // Which model served each agent, and every handover between them. Its own
  // lens because it answers a different question from the rest: not what the
  // workforce decided, but what it cost and who was actually asked.
  models: { label: "Models", kinds: ["SERVING"] as AgentStepKind[] },
} as const;

type Lens = keyof typeof LENSES;

/**
 * The run lives at its own address rather than in component state.
 *
 * A rehearsal is minutes long and worth coming back to: refreshing the page,
 * pressing the browser's back button, or sending somebody the link should all
 * work, and none of them does when "which run am I looking at" is a `useState`.
 */
export function Rehearsals() {
  const { id } = useParams();
  const navigate = useNavigate();
  return id ? (
    <RunView id={id} onBack={() => navigate("/rehearsals")} />
  ) : (
    <StartScreen onOpen={(next) => navigate(`/rehearsals/${next}`)} />
  );
}

// --- Starting one -----------------------------------------------------------

function StartScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const [website, setWebsite] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [note, setNote] = useState("");
  // A string rather than a number, because the field has to be allowed to be
  // empty while somebody retypes it, and an empty number input is NaN.
  const [budget, setBudget] = useState("3");
  const [scenario, setScenario] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: catalogue } = useQuery({
    queryKey: ["rehearsal-scenarios"],
    queryFn: () => api.get<RehearsalScenarioList>("/rehearsals/scenarios"),
  });

  const { data } = useQuery({
    queryKey: ["rehearsals"],
    queryFn: () => api.get<{ rehearsals: RehearsalSummary[] }>("/rehearsals"),
    // One of them running means the list is changing. Polled gently: the run
    // view is where the second-by-second detail lives.
    refetchInterval: (query) => (query.state.data?.rehearsals.some((row) => row.status === "RUNNING") ? 10_000 : false),
  });

  const start = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/rehearsals", {
        website: website.trim(),
        scenario,
        businessName: businessName.trim() || null,
        note: note.trim() || null,
        // Blank means "use the shipped ceiling", which is not the same as 0 —
        // 0 is somebody deliberately asking for no ceiling at all.
        budgetUsd: budget.trim() === "" ? null : Number(budget),
      }),
    onSuccess: (result) => {
      setNotice(null);
      void qc.invalidateQueries({ queryKey: ["rehearsals"] });
      onOpen(result.id);
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const blocked = (catalogue?.scenarios ?? []).filter((entry) => !entry.available);
  const chosen = catalogue?.scenarios.find((entry) => entry.key === scenario) ?? null;
  const ready = website.trim().length > 3 && Boolean(chosen?.available) && !start.isPending;

  return (
    <div>
      <PageHeader
        eyebrow="Rehearsal room"
        title="Put a real website through the workforce"
        subtitle="Give it an address and choose what you want to see happen. The agents work it exactly as they would a real prospect — same prompts, same tools, same arguments with each other."
      />

      {catalogue && (
        <p className="mb-6 rounded-2xl border border-blue/25 bg-blue/[.04] px-4 py-3 text-sm text-ink">
          <span className="font-semibold">Nothing leaves the building.</span> {catalogue.guarantee}
        </p>
      )}

      <Card className="mb-8">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Their website" hint="Anything this can open — dakyworld.com or the full address.">
            <input
              className="input"
              autoFocus
              placeholder="kwameautoparts.com"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />
          </Field>
          <Field label="What they are called" hint="Optional. Left blank, the run works it out from the site.">
            <input className="input" placeholder="Kwame Auto Parts" value={businessName} onChange={(event) => setBusinessName(event.target.value)} />
          </Field>
        </div>

        <div className="mt-7">
          <Eyebrow>What to put them through</Eyebrow>
          {/* Every specialist and most of the board seed as a draft, and a
              draft picks nothing up. Rather than five greyed-out cards and an
              errand, the run switches on what it needs — so what this says is
              what will happen, not what you have to do first. */}
          {chosen && chosen.wouldWake > 0 && (
            <p className="mt-3 rounded-xl border border-blue/25 bg-blue/[.04] px-3 py-2 text-sm text-ink">
              Starting this switches on {chosen.wouldWake} agent{chosen.wouldWake === 1 ? "" : "s"} that {chosen.wouldWake === 1 ? "has" : "have"}{" "}
              never been switched on
              {chosen.wouldWakeNames.length > 0 && (
                <> — {chosen.wouldWakeNames.join(", ")}{chosen.wouldWake > chosen.wouldWakeNames.length ? " and others" : ""}</>
              )}
              . They go back to drafts when the run ends. Anyone you have deliberately paused stays paused.
            </p>
          )}
          {blocked.length > 0 && (
            <p className="mt-3 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
              {blocked.length === 1
                ? `“${blocked[0].name}” cannot start: ${blocked[0].unavailableBecause}`
                : `${blocked.length} of these cannot start — the agent each begins with is paused or retired, and a rehearsal will not undo that.`}
            </p>
          )}
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {(catalogue?.scenarios ?? []).map((entry) => (
              <ScenarioCard key={entry.key} scenario={entry} chosen={scenario === entry.key} onChoose={() => setScenario(entry.key)} />
            ))}
            {!catalogue && <p className="text-sm text-muted">Loading the workflows…</p>}
          </div>
        </div>

        <div className="mt-7 grid gap-5 sm:grid-cols-[minmax(0,1fr)_180px]">
          <Field
            label="Anything you want watched"
            full
            hint="Optional, and it goes into the brief as your words. “I want to see whether anybody checks their opening hours” is a perfectly good instruction."
          >
            <textarea rows={2} className="input" value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <Field
            label="Stop it at"
            hint="Real research on real models costs real money. The run stops itself here and says so. 0 means no ceiling."
          >
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted">$</span>
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
              />
            </div>
          </Field>
        </div>

        {notice && <p className="mt-5 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{notice}</p>}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-5">
          <p className="max-w-xl text-xs leading-relaxed text-muted">
            {chosen
              ? `Starts with ${chosen.startAgentName}. Everything after that is theirs to decide — who to ask, what to look at, who to hand it to. That is the part worth watching.`
              : "Pick a workflow. Each one starts with a different person and fans out from there, switching on whoever it needs along the way."}
          </p>
          <Button variant="accent" disabled={!ready} onClick={() => start.mutate()}>
            {start.isPending ? "Starting…" : "Start the rehearsal"}
          </Button>
        </div>
      </Card>

      <Eyebrow>Runs</Eyebrow>
      <div className="mt-3">
        {!data ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : data.rehearsals.length === 0 ? (
          <EmptyState message="No rehearsals yet. Put a website through one above — a real one you know something about, so you can tell whether what the agents conclude is true." />
        ) : (
          <div className="space-y-2">
            {data.rehearsals.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => onOpen(row.id)}
                className="flex w-full flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-white px-4 py-3 text-left transition hover:border-ink/30"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <StatusDot tone={row.status === "RUNNING" ? "live" : row.status === "STOPPED" ? "idle" : "ok"} />
                    <span className="truncate text-sm font-semibold">{row.businessName || row.host}</span>
                    <Badge tone="muted">{row.scenarioName}</Badge>
                  </span>
                  <span className="mt-1 block font-mono text-[10px] uppercase tracking-[.1em] text-muted">
                    {row.host} · {row.taskCount} agent task{row.taskCount === 1 ? "" : "s"} · {row.toolCalls} tool call
                    {row.toolCalls === 1 ? "" : "s"}
                    {row.preparedCalls > 0 && ` · ${row.preparedCalls} prepared`} · <RelativeTime value={row.startedAt} />
                  </span>
                </span>
                <span className="font-mono text-[11px] text-muted">${row.costUsd.toFixed(3)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ScenarioCard({ scenario, chosen, onChoose }: { scenario: RehearsalScenario; chosen: boolean; onChoose: () => void }) {
  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={!scenario.available}
      className={`rounded-2xl border px-4 py-3.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
        chosen ? "border-blue bg-blue/[.05]" : "border-line bg-white hover:border-ink/30"
      }`}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="text-sm font-semibold">{scenario.name}</span>
        {scenario.reach === "wide" && <Badge tone="warn">wide</Badge>}
      </span>
      <span className="mt-1 block text-xs leading-relaxed text-muted">{scenario.purpose}</span>
      <span className="mt-2 block font-mono text-[10px] uppercase tracking-[.1em] text-muted">
        starts with {scenario.startAgentName}
        {scenario.available && scenario.wouldWake > 0 && ` · wakes ${scenario.wouldWake}`}
      </span>
      {scenario.unavailableBecause && <span className="mt-2 block text-xs text-warn-text">{scenario.unavailableBecause}</span>}
      {chosen && (
        <span className="mt-3 block border-t border-blue/20 pt-2.5">
          <span className="font-mono text-[10px] uppercase tracking-[.1em] text-muted">What this shows you</span>
          <span className="mt-1 block space-y-0.5">
            {scenario.exercises.map((line) => (
              <span key={line} className="block text-xs leading-relaxed text-muted">
                · {line}
              </span>
            ))}
          </span>
        </span>
      )}
    </button>
  );
}

// --- Watching one -----------------------------------------------------------

function RunView({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const [lens, setLens] = useState<Lens>("all");
  const [onlyAgent, setOnlyAgent] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const tail = useRef<HTMLDivElement | null>(null);

  const { data: run } = useQuery({
    queryKey: ["rehearsal", id],
    queryFn: () => api.get<RehearsalDetail>(`/rehearsals/${id}`),
    // This poll is also what advances the run — see routes/rehearsals.ts. Two
    // seconds is chosen so a chain of agents reads as a chain rather than as a
    // still screen followed by a wall of finished work.
    refetchInterval: (query) => (query.state.data?.status === "RUNNING" ? 2000 : false),
  });

  const act = useMutation<{ message?: string; note?: string }, Error, "stop" | "delete">({
    mutationFn: (what) =>
      what === "stop"
        ? api.post<{ message: string }>(`/rehearsals/${id}/stop`)
        : api.delete<{ note: string }>(`/rehearsals/${id}`),
    onSuccess: (result, what) => {
      void qc.invalidateQueries({ queryKey: ["rehearsals"] });
      if (what === "delete") return onBack();
      void qc.invalidateQueries({ queryKey: ["rehearsal", id] });
      // Stopping is a request the running task honours at its next safe point,
      // so the reply is a sentence rather than a finished run. Saying nothing
      // here would look like the button did nothing.
      setNotice(result.message ?? null);
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const shown = useMemo(() => {
    if (!run) return [];
    const kinds = LENSES[lens].kinds;
    return run.timeline.filter((step) => (!kinds || kinds.includes(step.kind)) && (!onlyAgent || step.agentKey === onlyAgent));
  }, [run, lens, onlyAgent]);

  useEffect(() => {
    if (follow && run?.status === "RUNNING") tail.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [shown.length, follow, run?.status]);

  if (!run) return <p className="text-sm text-muted">Loading the run…</p>;

  const live = run.status === "RUNNING";

  return (
    <div>
      <PageHeader
        eyebrow={run.scenarioName}
        title={run.businessName || run.host}
        subtitle={`${run.website} · ${run.movement}`}
        action={
          <div className="flex gap-2">
            {live ? (
              <Button variant="secondary" onClick={() => act.mutate("stop")} disabled={act.isPending}>
                Stop it
              </Button>
            ) : (
              <Button variant="danger" onClick={() => act.mutate("delete")} disabled={act.isPending}>
                Throw it away
              </Button>
            )}
          </div>
        }
      />

      {notice && <p className="mb-5 rounded-xl border border-line bg-cream px-3 py-2 text-sm text-ink">{notice}</p>}

      {/* Waking a draft is the one thing a rehearsal changes outside its own
          tree, so it is said out loud in both states. While it runs, so nobody
          is surprised to find an agent switched on; after it ends, so "it put
          them back" is something you can read rather than trust. */}
      {run.woke.length > 0 ? (
        <p className="mb-5 rounded-xl border border-blue/25 bg-blue/[.04] px-3 py-2 text-sm text-ink">
          This run switched on {run.woke.length} agent{run.woke.length === 1 ? "" : "s"} that had never been switched on —{" "}
          {run.woke.join(", ")}. They go back to drafts when it ends.
        </p>
      ) : (
        !live && <p className="mb-5 text-xs text-muted">Any agents this run switched on have been put back.</p>
      )}

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Spent"
          value={`$${run.spend.costUsd.toFixed(3)}`}
          sub={
            run.budgetUsd && run.budgetUsd > 0
              ? `of $${run.budgetUsd.toFixed(2)} · ${run.spend.modelCalls} model run${run.spend.modelCalls === 1 ? "" : "s"}`
              : `${run.spend.modelCalls} model run${run.spend.modelCalls === 1 ? "" : "s"}`
          }
        />
        <StatTile label="Agents on it" value={run.agents.length} sub={`${run.agents.reduce((sum, agent) => sum + agent.tasks.length, 0)} tasks`} />
        <StatTile label="Tool calls" value={run.spend.toolCalls} sub={run.spend.refusedCalls > 0 ? `${run.spend.refusedCalls} refused` : "none refused"} />
        <StatTile
          label="Prepared, not done"
          value={run.spend.preparedCalls}
          sub={run.spend.preparedCalls > 0 ? "would need your approval" : "nothing outward yet"}
        />
        <StatTile
          label="Tokens"
          value={`${Math.round((run.spend.inputTokens + run.spend.cacheReadTokens + run.spend.outputTokens) / 1000)}k`}
          // The cached share is the part worth watching. Every turn of an agent
          // re-sends the ones before it, so a run whose cache reads dwarf its
          // fresh input is one that paid for its instructions once instead of
          // a dozen times — and one where they are zero is a run that did not.
          sub={
            run.spend.cacheReadTokens > 0
              ? `${run.spend.cacheReadTokens.toLocaleString()} from cache · ${run.spend.inputTokens.toLocaleString()} fresh · ${run.spend.outputTokens.toLocaleString()} out`
              : `${run.spend.inputTokens.toLocaleString()} in · ${run.spend.outputTokens.toLocaleString()} out`
          }
        />
      </div>

      <div className="grid gap-8 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-8">
          <TheFloor run={run} onlyAgent={onlyAgent} onPick={setOnlyAgent} />
          <Produced run={run} />
        </div>

        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <Eyebrow>What happened, in order</Eyebrow>
            <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.1em] text-muted">
              <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} className="accent-[#3157FF]" />
              Follow along
            </label>
          </div>

          <div className="mb-4 flex flex-wrap gap-1.5">
            {(Object.keys(LENSES) as Lens[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setLens(key)}
                className={`rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[.1em] transition ${
                  lens === key ? "bg-ink text-white" : "border border-line text-muted hover:border-ink/40 hover:text-ink"
                }`}
              >
                {LENSES[key].label}
              </button>
            ))}
            {onlyAgent && (
              <button
                type="button"
                onClick={() => setOnlyAgent(null)}
                className="rounded-full border border-blue/40 bg-blue/[.06] px-3 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-blue"
              >
                {run.agents.find((agent) => agent.key === onlyAgent)?.name ?? onlyAgent} ×
              </button>
            )}
          </div>

          <Timeline steps={shown} live={live} />
          <div ref={tail} />

          {run.prepared.length > 0 && <Prepared run={run} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Who worked on it, and who reached whom.
 *
 * The tree is built from the handover steps rather than from a separate
 * record: an agent appears under another because it wrote DELEGATED or
 * HANDED_OFF in its own timeline, which is the only evidence that actually
 * exists. A consult is drawn as a leaf, because nothing was handed over — an
 * opinion was asked for and the work stayed put.
 */
function TheFloor({ run, onlyAgent, onPick }: { run: RehearsalDetail; onlyAgent: string | null; onPick: (key: string | null) => void }) {
  const byKey = new Map(run.agents.map((agent) => [agent.key, agent]));
  const childrenOf = new Map<string, Array<{ to: string; kind: AgentStepKind }>>();
  const hasParent = new Set<string>();

  for (const edge of run.edges) {
    const list = childrenOf.get(edge.from) ?? [];
    if (!list.some((entry) => entry.to === edge.to && entry.kind === edge.kind)) list.push({ to: edge.to, kind: edge.kind });
    childrenOf.set(edge.from, list);
    // A consult creates no task, so the colleague is not "under" anybody — it
    // still shows as a leaf, but it must not stop them appearing as a root.
    if (edge.kind !== "CONSULTED") hasParent.add(edge.to);
  }

  const roots = run.agents.filter((agent) => !hasParent.has(agent.key));

  const render = (key: string, kind: AgentStepKind | null, depth: number, seen: Set<string>): JSX.Element | null => {
    if (seen.has(key) || depth > 6) return null;
    const next = new Set(seen).add(key);
    const agent = byKey.get(key);
    const consultOnly = kind === "CONSULTED";

    return (
      <div key={`${key}-${depth}-${kind ?? "root"}`} className={depth > 0 ? "ml-3 border-l border-line pl-3" : ""}>
        {kind && (
          <span className="mb-0.5 block font-mono text-[9px] uppercase tracking-[.12em] text-muted">
            {kind === "DELEGATED" ? "delegated to" : kind === "HANDED_OFF" ? "handed to" : "asked"}
          </span>
        )}
        <button
          type="button"
          onClick={() => onPick(onlyAgent === key ? null : key)}
          className={`block w-full rounded-xl border px-3 py-2 text-left transition ${
            onlyAgent === key ? "border-blue bg-blue/[.06]" : "border-line bg-white hover:border-ink/30"
          }`}
        >
          <span className="flex items-center gap-2">
            {agent ? <StatusDot tone={STATUS_TONE[agent.status]} /> : <StatusDot tone="idle" />}
            <span className="truncate text-sm font-medium">{agent?.name ?? key}</span>
          </span>
          {(agent ? agent.title !== agent.name : true) && (
            <span className="mt-0.5 block truncate text-xs text-muted">{agent?.title ?? (consultOnly ? "asked for an opinion" : "not reached")}</span>
          )}
          {agent && (
            <span className="mt-1 block font-mono text-[9px] uppercase tracking-[.1em] text-muted">
              {agent.steps} step{agent.steps === 1 ? "" : "s"} · {agent.toolCalls} tool
              {agent.preparedCalls > 0 && ` · ${agent.preparedCalls} prepared`} · ${agent.costUsd.toFixed(3)}
            </span>
          )}
        </button>
        {!consultOnly && (
          <div className="mt-1.5 space-y-1.5">{(childrenOf.get(key) ?? []).map((child) => render(child.to, child.kind, depth + 1, next))}</div>
        )}
      </div>
    );
  };

  return (
    <section>
      <Eyebrow>Who it went to</Eyebrow>
      <p className="mb-3 mt-2 text-xs leading-relaxed text-muted">
        Built from what each agent recorded doing. Click one to read only their part of the timeline.
      </p>
      <div className="space-y-2">{roots.map((agent) => render(agent.key, null, 0, new Set()))}</div>
    </section>
  );
}

/**
 * The merged stream, grouped by whoever is speaking.
 *
 * Grouping is what makes it read as a flow. Ungrouped, forty rows each labelled
 * with an agent name is a log; grouped, a change of name is a visible handover
 * and you can see where the work moved.
 */
function Timeline({ steps, live }: { steps: RehearsalStep[]; live: boolean }) {
  if (steps.length === 0) {
    return (
      <p className="rounded-2xl border border-line bg-cream px-4 py-4 text-sm text-muted">
        {live ? "Nothing here yet — it is thinking." : "Nothing in this run matched that filter."}
      </p>
    );
  }

  const groups: Array<{ agentKey: string; agentName: string; taskTitle: string; steps: RehearsalStep[] }> = [];
  for (const step of steps) {
    const last = groups.at(-1);
    if (last && last.agentKey === step.agentKey && last.taskTitle === step.taskTitle) last.steps.push(step);
    else groups.push({ agentKey: step.agentKey, agentName: step.agentName, taskTitle: step.taskTitle, steps: [step] });
  }

  return (
    <div className="space-y-4">
      {groups.map((group, index) => (
        <div key={`${group.agentKey}-${index}`} className="rounded-2xl border border-line bg-white">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-2.5">
            <span className="text-sm font-semibold">{group.agentName}</span>
            <span className="truncate font-mono text-[10px] uppercase tracking-[.1em] text-muted">{group.taskTitle}</span>
          </div>
          <ol className="divide-y divide-line/60">
            {group.steps.map((step) => (
              <Step key={step.id} step={step} />
            ))}
          </ol>
        </div>
      ))}
      {live && <p className="pl-1 text-sm text-muted">…still going.</p>}
    </div>
  );
}

function Step({ step }: { step: RehearsalStep }) {
  const [open, setOpen] = useState(false);
  const style = STEP_STYLE[step.kind] ?? STEP_STYLE.THOUGHT;
  const detail = step.data ? JSON.stringify(step.data, null, 2) : null;

  return (
    <li className="px-4 py-2.5">
      <div className="flex gap-3">
        <span className={`mt-0.5 shrink-0 font-mono text-xs ${style.tone}`} aria-hidden>
          {style.mark}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={`whitespace-pre-wrap text-sm leading-relaxed ${
              step.kind === "THOUGHT" ? "text-ink" : step.kind === "REFUSED" || step.kind === "FAILED" ? "text-danger-text" : "text-ink"
            }`}
          >
            {step.message}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-[.1em] text-muted">
            <span className={style.tone}>{STEP_LABEL[step.kind] ?? step.kind.toLowerCase()}</span>
            {step.tool && <code className="text-muted">{step.tool}</code>}
            {step.dryRun && <span className="text-warn-text">not carried out</span>}
            <RelativeTime value={step.at} />
            {detail && (
              <button type="button" onClick={() => setOpen(!open)} className="text-blue transition hover:underline">
                {open ? "hide what it sent" : "what it sent and got back"}
              </button>
            )}
          </div>
          {open && detail && (
            <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-sunken p-3 text-[11px] leading-relaxed text-ink">{detail}</pre>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Everything the gate stopped, the case the agent made for it, and — the part
 * that was missing — which gate.
 *
 * This used to say every one of these would have left the building, which is
 * only true of the outward half. The rest are calls an agent was not allowed to
 * make: research and site audits held by its own autonomy level or a spending
 * ceiling, nothing to do with the rehearsal. Reading the second as the first is
 * how a run where the Website Auditor could not run either of its own two tools
 * looked like the guarantee working.
 */
function Prepared({ run }: { run: RehearsalDetail }) {
  const held = run.prepared.filter((action) => !action.outward).length;
  return (
    <section className="mt-8">
      <Eyebrow>Prepared, and not carried out</Eyebrow>
      <p className="mb-3 mt-2 text-xs leading-relaxed text-muted">
        Each of these stopped at a preview. Most would have left the building, and in a rehearsal those always stop here — that is the list you
        would be approving one by one if this were real.
        {held > 0 && (
          <>
            {" "}
            <strong className="font-medium text-ink">
              {held} of them stopped for a different reason: the agent was not allowed to make the call at all.
            </strong>{" "}
            Those say so underneath, and they are a fact about that agent&rsquo;s settings rather than about this run.
          </>
        )}
      </p>
      <div className="space-y-2">
        {run.prepared.map((action) => (
          <div
            key={action.id}
            className={
              action.outward
                ? "rounded-2xl border border-warn-line bg-warn-surface/60 px-4 py-3"
                : "rounded-2xl border border-line bg-sunken px-4 py-3"
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <code className={action.outward ? "font-mono text-[11px] text-warn-text" : "font-mono text-[11px] text-ink"}>{action.tool}</code>
              <span
                className={
                  action.outward
                    ? "font-mono text-[9px] uppercase tracking-[.1em] text-warn-text"
                    : "font-mono text-[9px] uppercase tracking-[.1em] text-muted"
                }
              >
                {run.agents.find((agent) => agent.key === action.agentKey)?.name ?? action.agentKey}
              </span>
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-ink">{action.wouldDo}</p>
            {action.heldBecause && (
              <p className={action.outward ? "mt-1 text-xs leading-relaxed text-warn-text/70" : "mt-1 text-xs leading-relaxed text-muted"}>
                {action.outward ? "Held: " : "Not allowed: "}
                {action.heldBecause}
              </p>
            )}
            {action.status === "EXECUTED" && (
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[.1em] text-danger-text">
                Carried out for real — cost ${action.costUsd.toFixed(4)}. This should have stayed a preview.
              </p>
            )}
            {action.why && (
              <dl className="mt-2 space-y-1 border-t border-warn-line pt-2 text-xs leading-relaxed text-muted">
                <div>
                  <dt className="inline font-mono text-[9px] uppercase tracking-[.1em] text-warn-text">Why </dt>
                  <dd className="inline">{action.why}</dd>
                </div>
                <div>
                  <dt className="inline font-mono text-[9px] uppercase tracking-[.1em] text-warn-text">Gains </dt>
                  <dd className="inline">{action.gain}</dd>
                </div>
                <div>
                  <dt className="inline font-mono text-[9px] uppercase tracking-[.1em] text-warn-text">Risk </dt>
                  <dd className="inline">{action.risk}</dd>
                </div>
              </dl>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * What the run left behind.
 *
 * Read off the records rather than off the timeline, because "the audit team
 * ran" and a review you can open are different claims and only the second is
 * evidence. This is the section that answers whether the work is actually
 * there, as opposed to whether an agent said it did it.
 */
function Produced({ run }: { run: RehearsalDetail }) {
  const made = run.produced;
  const nothing =
    made.audits.length + made.demos.length + made.proposals.length + made.emails.length + made.notes + made.memories === 0 && !made.research;

  return (
    <section>
      <Eyebrow>What it produced</Eyebrow>
      {nothing ? (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Nothing on the record yet. A run that finishes with nothing here did a lot of reasoning and made nothing — which is worth knowing.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm text-ink">
          {made.research && (
            <li>
              · Researched and looked at, <RelativeTime value={made.research.ranAt} />
            </li>
          )}
          {made.audits.map((audit) => (
            <li key={audit.id}>
              · Website review — <span className="font-medium">{audit.verdict}</span>
              {audit.overallScore > 0 && ` (${audit.overallScore}/100)`}
              {audit.pdfFileId && (
                <>
                  {" "}
                  <a className="text-blue hover:underline" href={`/api/audits/${audit.id}/pdf`} target="_blank" rel="noreferrer">
                    open the PDF
                  </a>
                </>
              )}
            </li>
          ))}
          {made.demos.map((demo) => (
            <li key={demo.id}>
              · Demo page —{" "}
              <a className="text-blue hover:underline" href={`/demos/${demo.slug}`} target="_blank" rel="noreferrer">
                {demo.title}
              </a>{" "}
              <span className="text-muted">({demo.status.toLowerCase()})</span>
            </li>
          ))}
          {made.proposals.map((proposal) => (
            <li key={proposal.id}>
              · Proposal — {proposal.title} · {proposal.currency} {proposal.price}
            </li>
          ))}
          {made.emails.map((email) => (
            <li key={email.id}>
              · {email.purpose.toLowerCase().replace(/_/g, " ")} — “{email.subject}” <span className="text-muted">({email.status.toLowerCase()})</span>
            </li>
          ))}
          {made.notes > 0 && <li>· {made.notes} entries added to the company's history</li>}
          {made.memories > 0 && <li>· {made.memories} things the agents kept for next time</li>}
        </ul>
      )}

      {run.lead && (
        <p className="mt-3 rounded-xl border border-line bg-cream px-3 py-2 text-xs leading-relaxed text-muted">
          Working on a scratch lead scored {run.lead.leadScore}/100
          {run.lead.tags.length > 0 && `, tagged ${run.lead.tags.slice(0, 4).join(", ")}`}. It is kept out of the pipeline and goes when you
          throw the rehearsal away.
        </p>
      )}
    </section>
  );
}
