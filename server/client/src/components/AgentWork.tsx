import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type {
  AgentDetail,
  AgentMemory,
  AgentMemoryList,
  AgentStepKind,
  AgentTask,
  AgentTaskDetail,
  AgentTaskStatus,
  AgentWork as AgentWorkData,
} from "../lib/types";
import { Badge, Button, Drawer, Field, RelativeTime, StatusDot } from "./ui";

/**
 * What an agent is doing, has done, and remembers.
 *
 * The roster answered "who could do this" and the toolkit answered "what are
 * they allowed to do". Neither answered the question anybody actually asks of
 * a workforce — *what is happening right now* — and this is the panel that
 * does. It is the reason the agent drawer is worth opening.
 *
 * A running task polls. Everything else does not: a queue that refetches every
 * two seconds while nothing is running is a request per second per open drawer
 * for no information at all.
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

const STATUS_LABEL: Record<AgentTaskStatus, string> = {
  RUNNING: "working",
  QUEUED: "queued",
  NEEDS_APPROVAL: "ready to approve",
  BLOCKED: "stopped and asked",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

/**
 * The glyph and colour for each kind of step. Read down the left of a timeline.
 *
 * Six kinds were missing until Aug 2026 and fell through to the THOUGHT glyph —
 * including CONSULTED and HANDED_OFF, which are the two steps where one agent
 * reaches another. The most interesting line in any timeline was drawn as an
 * anonymous grey dot.
 */
export const STEP_STYLE: Record<AgentStepKind, { mark: string; tone: string }> = {
  STARTED: { mark: "▸", tone: "text-muted" },
  THOUGHT: { mark: "·", tone: "text-muted" },
  TOOL_CALL: { mark: "•", tone: "text-blue" },
  PREPARED: { mark: "◇", tone: "text-warn-text" },
  REFUSED: { mark: "×", tone: "text-danger-text" },
  DELEGATED: { mark: "↳", tone: "text-blue" },
  CONSULTED: { mark: "?", tone: "text-blue" },
  HANDED_OFF: { mark: "⇢", tone: "text-blue" },
  GAP_RAISED: { mark: "◦", tone: "text-warn-text" },
  REMEMBERED: { mark: "✱", tone: "text-muted" },
  NOTED: { mark: "✎", tone: "text-muted" },
  BLOCKED: { mark: "!", tone: "text-warn-text" },
  FINISHED: { mark: "✓", tone: "text-positive-text" },
  FAILED: { mark: "×", tone: "text-danger-text" },
  INTERRUPTED: { mark: "‖", tone: "text-muted" },
  RESUMED: { mark: "▸", tone: "text-muted" },
  SERVING: { mark: "◐", tone: "text-muted" },
};

/** Shared with the rehearsal room, which shows the same kinds interleaved across agents. */
export const STEP_LABEL: Record<AgentStepKind, string> = {
  STARTED: "started",
  THOUGHT: "thinking",
  TOOL_CALL: "used a tool",
  PREPARED: "prepared, not done",
  REFUSED: "refused",
  DELEGATED: "delegated",
  CONSULTED: "asked a colleague",
  HANDED_OFF: "handed over",
  GAP_RAISED: "nobody can do this",
  REMEMBERED: "remembered",
  NOTED: "added to the record",
  BLOCKED: "stopped and asked",
  FINISHED: "finished",
  FAILED: "failed",
  INTERRUPTED: "paused, kept its place",
  RESUMED: "carried on",
  SERVING: "model",
};

export function AgentWork({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient();
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [giving, setGiving] = useState(false);

  const { data } = useQuery({
    queryKey: ["agent-work", agent.key],
    queryFn: () => api.get<AgentWorkData>(`/agents/${agent.key}/tasks`),
    // Only while something is turning. A still board does not need polling.
    refetchInterval: (query) => ((query.state.data?.running.length ?? 0) > 0 ? 3000 : false),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["agent-work", agent.key] });
    void qc.invalidateQueries({ queryKey: ["agent", agent.key] });
    void qc.invalidateQueries({ queryKey: ["agents"] });
  };

  const running = data?.running ?? [];
  const queued = data?.queued ?? [];
  const waiting = data?.waiting ?? [];
  const finished = data?.finished ?? [];

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">What it is working on</h3>
          {data && (
            <p className="mt-1 text-sm text-muted">
              {running.length > 0 ? `${running.length} in flight · ` : ""}
              {queued.length} queued · {waiting.length} waiting on you · {data.summary.done} done
              {data.summary.spendUsd > 0 && ` · $${data.summary.spendUsd.toFixed(2)} in 30 days`}
            </p>
          )}
        </div>
        <Button size="sm" onClick={() => setGiving(true)}>
          Give it a task
        </Button>
      </div>

      {agent.status !== "ACTIVE" && (
        <p className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
          {agent.name} is a {agent.status.toLowerCase()}. You can queue work for it now, but it will not pick anything up until you set it to
          Active.
        </p>
      )}

      {!data ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : running.length + queued.length + waiting.length + finished.length === 0 ? (
        <p className="rounded-xl border border-line bg-cream px-3 py-3 text-sm text-muted">
          Nothing yet. Give it something to do — describe the job the way you would to a person, and it will use the tools it has been
          granted to work it out.
        </p>
      ) : (
        <div className="space-y-4">
          {running.length > 0 && <Group tasks={running} onOpen={setOpenTask} live />}
          {waiting.length > 0 && <Group label="Waiting on you" tasks={waiting} onOpen={setOpenTask} />}
          {queued.length > 0 && <Group label="Queued" tasks={queued} onOpen={setOpenTask} />}
          {finished.length > 0 && <Group label="Finished" tasks={finished} onOpen={setOpenTask} muted />}
        </div>
      )}

      <TaskDrawer taskId={openTask} onClose={() => setOpenTask(null)} onChanged={refresh} />
      <GiveTaskDrawer agent={agent} open={giving} onClose={() => setGiving(false)} onCreated={refresh} />
    </section>
  );
}

function Group({
  label,
  tasks,
  onOpen,
  live,
  muted,
}: {
  label?: string;
  tasks: AgentTask[];
  onOpen: (id: string) => void;
  live?: boolean;
  muted?: boolean;
}) {
  return (
    <div>
      {label && <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[.12em] text-muted">{label}</p>}
      <div className="space-y-1.5">
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            onClick={() => onOpen(task.id)}
            className={`block w-full border px-3 py-2.5 text-left transition ${
              live ? "border-blue/40 bg-blue/[.04]" : muted ? "border-line bg-white hover:bg-sunken" : "border-line bg-white hover:bg-sunken"
            }`}
          >
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <StatusDot tone={STATUS_TONE[task.status]} />
                  <span className="truncate text-sm font-medium">{task.title}</span>
                </span>
                {(task.pausedBecause || task.summary || task.blockedReason || task.error) && (
                  <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-muted">
                    {task.pausedBecause ?? task.blockedReason ?? task.error ?? task.summary}
                  </span>
                )}
                <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10px] uppercase tracking-[.1em] text-muted">
                  {/* Paused reads instead of "queued", not beside it. The
                      status is the same and the news is not: this one is
                      waiting on a vendor and will start itself. */}
                  <span className={task.paused ? "text-warn-text" : undefined}>
                    {task.paused ? "paused" : STATUS_LABEL[task.status]}
                  </span>
                  {task.paused && task.pausedUntil && (
                    <span className="text-warn-text">
                      back <RelativeTime value={task.pausedUntil} />
                    </span>
                  )}
                  {task.toolCalls > 0 && <span>{task.toolCalls} tool call{task.toolCalls === 1 ? "" : "s"}</span>}
                  {task.dryRunCalls > 0 && <span className="text-warn-text">{task.dryRunCalls} prepared</span>}
                  {task.delegated > 0 && <span>{task.delegated} delegated</span>}
                  <RelativeTime value={task.finishedAt ?? task.startedAt ?? task.createdAt} />
                </span>
              </span>
              {task.origin !== "OWNER" && <Badge tone="muted">{task.origin.toLowerCase()}</Badge>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One task, and everything it did.
 *
 * The timeline is the point. It is written as the run happens, so a task that
 * is still turning shows what it has done so far rather than a spinner — and
 * a task that finished shows exactly which calls took effect, which were
 * prepared, and which the policy refused.
 */
function TaskDrawer({ taskId, onClose, onChanged }: { taskId: string | null; onClose: () => void; onChanged: () => void }) {
  const [answer, setAnswer] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const { data: task } = useQuery({
    queryKey: ["agent-task", taskId],
    queryFn: () => api.get<AgentTaskDetail>(`/agents/tasks/${taskId}`),
    enabled: Boolean(taskId),
    refetchInterval: (query) => (query.state.data?.status === "RUNNING" ? 2000 : false),
  });

  const act = useMutation({
    mutationFn: ({ what, body }: { what: string; body?: unknown }) =>
      api.post<{ asked?: boolean; message?: string; resuming?: boolean; resumingFrom?: number }>(
        `/agents/tasks/${taskId}/${what}`,
        body,
      ),
    onSuccess: (result) => {
      // Stopping a running task is a request the run honours at its next safe
      // point, so the reply is a sentence rather than a finished task. Saying
      // nothing here would look like the button did nothing.
      setNotice(
        result?.message ??
          (result?.resuming ? `Carrying on from step ${result.resumingFrom ?? 0} — it does not start again.` : null),
      );
      setAnswer("");
      onChanged();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const about = task?.about;
  const linked = about
    ? [
        about.lead && { label: "Lead", text: about.lead.companyName ?? about.lead.contactName },
        about.client && { label: "Client", text: about.client.name },
        about.project && { label: "Project", text: about.project.name },
        about.proposal && { label: "Proposal", text: about.proposal.title },
        about.invoice && { label: "Invoice", text: about.invoice.invoiceNumber },
      ].filter(Boolean)
    : [];

  return (
    <Drawer
      open={Boolean(taskId)}
      onClose={() => {
        setNotice(null);
        onClose();
      }}
      wide
      title={task?.title ?? "Task"}
      subtitle={task ? `${task.agent.name} · ${STATUS_LABEL[task.status]}` : undefined}
      footer={
        task && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[.1em] text-muted">
              {task.toolCalls} tool call{task.toolCalls === 1 ? "" : "s"} · ${task.costUsd.toFixed(4)}
              {task.attempts > 1 && ` · attempt ${task.attempts}`}
              {task.resumesFrom && ` · saved at step ${task.resumesFrom.steps}`}
            </span>
            <div className="flex gap-2">
              {task.status === "NEEDS_APPROVAL" && (
                <Button onClick={() => act.mutate({ what: "approve" })} disabled={act.isPending}>
                  Approve
                </Button>
              )}
              {(task.status === "QUEUED" || task.status === "BLOCKED" || task.status === "FAILED" || task.status === "CANCELLED") && (
                <Button onClick={() => act.mutate({ what: "run", body: { answer } })} disabled={act.isPending}>
                  {task.status === "BLOCKED" ? "Answer and continue" : task.resumesFrom ? "Carry on" : "Run now"}
                </Button>
              )}
              {task.status !== "DONE" && (task.status !== "CANCELLED" || Boolean(task.resumesFrom)) && (
                <Button
                  variant="ghost"
                  onClick={() => act.mutate({ what: "cancel" })}
                  disabled={act.isPending || task.stopRequested}
                >
                  {task.status === "RUNNING" ? (task.stopRequested ? "Stopping…" : "Stop") : "Cancel"}
                </Button>
              )}
            </div>
          </div>
        )
      }
    >
      {!task ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-6">
          {notice && <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{notice}</p>}

          {task.status === "BLOCKED" && (
            <div className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5">
              <p className="font-mono text-[10px] uppercase tracking-[.12em] text-warn-text">It stopped and asked</p>
              <p className="mt-1.5 text-sm text-warn-text">{task.blockedReason}</p>
              <div className="mt-3">
                <Field label="Your answer" hint="Added to the brief. What it was originally asked stays on the record." full>
                  <textarea rows={2} className="input" value={answer} onChange={(event) => setAnswer(event.target.value)} />
                </Field>
              </div>
            </div>
          )}

          {task.status === "NEEDS_APPROVAL" && (
            <p className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
              {task.dryRunCalls} action{task.dryRunCalls === 1 ? " was" : "s were"} prepared and not carried out — {task.agent.name} is in dry
              run or below the autonomy those tools need. Read the timeline, then approve it. To stop being asked, raise its autonomy on its
              own card.
            </p>
          )}

          {task.error && <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{task.error}</p>}

          {task.summary && (
            <section>
              <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-muted">What it says it did</h4>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{task.summary}</p>
            </section>
          )}

          <section>
            <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-muted">What it was asked</h4>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{task.brief}</p>
            {linked.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {linked.map((entry, index) => (
                  <span key={index} className="rounded-xl border border-line bg-cream px-2 py-0.5 text-xs text-muted">
                    <span className="font-mono text-[9px] uppercase tracking-[.1em] text-muted">{entry!.label}</span> {entry!.text}
                  </span>
                ))}
              </div>
            )}
          </section>

          <RunCost task={task} />

          <section>
            <h4 className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-muted">
              What it did{task.status === "RUNNING" && <span className="ml-2 text-blue">· still going</span>}
            </h4>
            <ol className="space-y-1.5">
              {task.steps.map((step) => {
                const style = STEP_STYLE[step.kind] ?? STEP_STYLE.THOUGHT;
                return (
                  <li key={step.id} className="flex gap-2.5 border-l border-line pl-3">
                    <span className={`mt-0.5 shrink-0 font-mono text-xs ${style.tone}`} aria-hidden>
                      {style.mark}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm leading-relaxed text-ink">{step.message}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-[.1em] text-muted">
                        <span className={style.tone}>{step.kind.toLowerCase().replace("_", " ")}</span>
                        {step.tool && <code className="text-muted">{step.tool}</code>}
                        <RelativeTime value={step.createdAt} />
                      </span>
                    </span>
                  </li>
                );
              })}
              {task.status === "RUNNING" && task.steps.length === 0 && <li className="text-sm text-muted">Thinking…</li>}
            </ol>
          </section>

          {task.children.length > 0 && (
            <section>
              <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-muted">Handed to others</h4>
              <ul className="space-y-1 text-sm text-muted">
                {task.children.map((child) => (
                  <li key={child.id}>
                    · {child.agent.name} — {child.title}{" "}
                    <span className="text-muted">({STATUS_LABEL[child.status]})</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {task.parent && (
            <p className="text-xs text-muted">
              Handed to {task.agent.name} by {task.parent.agent.name}, as part of “{task.parent.title}”.
            </p>
          )}
        </div>
      )}
    </Drawer>
  );
}

/**
 * What this run has cost, and what is going to happen to it without anybody
 * doing anything.
 *
 * `GET /agents/tasks/:id` has answered all of this since the ceilings shipped —
 * the money summed from the `LlmCall` ledger, the tokens, the point where the
 * run finishes on the cheaper model and the point where it stops — and nothing
 * in the client had ever read it. The footer showed a dollar figure with
 * nothing to compare it against, which is the one number that cannot be acted
 * on: an Owner deciding whether to raise a ceiling needs to see the ceiling.
 *
 * **The two forward-looking lines are the point.** Easing off and stopping are
 * things the run does to itself, and a person who learns about them afterwards
 * reads them as a fault — a task that "went quiet" or "came back worse" — which
 * is exactly how the economy-model switch was reported before it was visible.
 *
 * A task with no ceiling gets the tokens and nothing else. Drawing an empty
 * meter for the common case would teach people to ignore the one that matters,
 * and there is no fraction to draw: `budget.fraction` is null and inventing a
 * denominator from the spend so far would show every run at 100%.
 */
function RunCost({ task }: { task: AgentTaskDetail }) {
  const { budget, spend } = task;
  const tokens = spend.inputTokens + spend.outputTokens;
  const fraction = budget.fraction === null ? null : Math.min(1, budget.fraction);
  const overCeiling = budget.remainingUsd !== null && budget.remainingUsd <= 0;

  return (
    <section>
      <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-muted">What it is costing</h4>
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-medium text-ink">${budget.spentUsd.toFixed(4)}</span>
        <span className="text-muted">
          {budget.ceilingUsd !== null ? `of a $${budget.ceilingUsd.toFixed(2)} ceiling` : "on this task"}
          {tokens > 0 && ` · ${tokens.toLocaleString()} tokens over ${spend.modelCalls} model call${spend.modelCalls === 1 ? "" : "s"}`}
        </span>
        {budget.easedOff && <Badge tone="muted">on the cheaper model</Badge>}
      </div>

      {fraction !== null && (
        <div className="mt-1.5 h-1 w-full max-w-sm bg-line">
          <div
            className={`h-1 ${overCeiling ? "bg-danger" : fraction > 0.8 ? "bg-warn" : "bg-ink"}`}
            style={{ width: `${Math.max(2, fraction * 100)}%` }}
          />
        </div>
      )}

      {budget.ceilingUsd !== null && (
        <p className="mt-1.5 text-xs text-muted">
          {overCeiling
            ? "It is at its ceiling, so it stops rather than starting anything else. Raise the ceiling on the task to let it carry on."
            : budget.easedOff
              ? `Past four fifths of its ceiling, so it is finishing on the economy model. It stops at $${budget.ceilingUsd.toFixed(2)}.`
              : `It moves to the economy model at $${(budget.willEaseOffAt ?? 0).toFixed(2)} and stops at $${budget.ceilingUsd.toFixed(2)}.`}
          {budget.estimatedToFinishUsd !== null &&
            ` About $${budget.estimatedToFinishUsd.toFixed(2)} more at the rate so far, if it uses every turn it has left.`}
        </p>
      )}
    </section>
  );
}

/** Giving an agent a job, in the words you would use with a person. */
function GiveTaskDrawer({
  agent,
  open,
  onClose,
  onCreated,
}: {
  agent: AgentDetail;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [priority, setPriority] = useState(2);
  const [notice, setNotice] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ task: AgentTask; note: string | null }>(`/agents/${agent.key}/tasks`, {
        title: title.trim(),
        brief: brief.trim(),
        priority,
        runNow: agent.status === "ACTIVE",
      }),
    onSuccess: () => {
      setTitle("");
      setBrief("");
      setNotice(null);
      onCreated();
      onClose();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const ready = title.trim().length > 2 && brief.trim().length > 9;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`Give ${agent.name} a task`}
      subtitle={agent.title}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!ready || create.isPending}>
            {create.isPending ? "Queueing…" : agent.status === "ACTIVE" ? "Give it" : "Queue it"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {notice && <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{notice}</p>}

        <Field label="What is it" full hint="One line, for the board.">
          <input className="input" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>

        <Field
          label="The brief"
          full
          hint="Write it as you would to a person who was not in the room. It can read the records and use its tools; what it cannot do is guess what you meant."
        >
          <textarea rows={7} className="input" value={brief} onChange={(event) => setBrief(event.target.value)} />
        </Field>

        <Field label="Priority" hint="Drives the order it picks work up in.">
          <select className="input" value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
            <option value={1}>Urgent — before anything else</option>
            <option value={2}>Normal</option>
            <option value={3}>Whenever there is room</option>
          </select>
        </Field>

        <p className="rounded-xl border border-line bg-cream px-3 py-2 text-xs leading-relaxed text-muted">
          It has {agent.toolkit.length} tool{agent.toolkit.length === 1 ? "" : "s"} and is at level {agent.autonomyLevel}
          {agent.dryRun ? " with dry run on" : ""}. Anything it cannot carry out at that setting it will prepare instead, and the task will
          come back to you to approve.
        </p>
      </div>
    </Drawer>
  );
}

/**
 * What it remembers.
 *
 * Filed against the thing it is about, so an agent picking up a task about a
 * lead is handed what it previously concluded about *that* lead and nothing
 * about anybody else. A memory nothing has ever recalled is worth removing —
 * the recall budget is finite and junk crowds out what matters.
 */
export function AgentMemories({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["agent-memory", agent.key],
    queryFn: () => api.get<AgentMemoryList>(`/agents/${agent.key}/memory`),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["agent-memory", agent.key] });

  const add = useMutation({
    mutationFn: () => api.post<AgentMemory>(`/agents/${agent.key}/memory`, { content: adding.trim() }),
    onSuccess: () => {
      setAdding("");
      setNotice(null);
      void refresh();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/agents/${agent.key}/memory/${id}`),
    onSuccess: () => void refresh(),
  });

  const memories = data?.memories ?? [];

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">What it remembers</h3>
        {data && (
          <p className="mt-1 text-sm text-muted">
            {data.summary.total} across {data.summary.subjects} subject{data.summary.subjects === 1 ? "" : "s"}
            {data.summary.neverUsed > 0 && ` · ${data.summary.neverUsed} never recalled`}
            {agent.sharedMemories > 0 && ` · including ${agent.sharedMemories} the whole company holds`}
          </p>
        )}
      </div>

      {memories.length === 0 ? (
        <p className="rounded-xl border border-line bg-cream px-3 py-2.5 text-sm text-muted">
          Nothing yet. It writes these itself as it works — a decision and why, what came of it, something it learnt about a client. You can
          also tell it something directly below.
        </p>
      ) : (
        <div className="space-y-1.5">
          {memories.map((memory) => (
            <div
              key={memory.id}
              className={`flex items-start justify-between gap-3 border px-3 py-2 ${
                memory.scope === "SHARED" ? "border-blue/25 bg-blue/5" : "border-line bg-white"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm leading-relaxed text-ink">{memory.content}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-[.1em] text-muted">
                  {/* Marked, because these are the company's rather than this
                      agent's — and forgetting one would take it away from all
                      of them, which is why this row doesn't offer to. */}
                  {memory.scope === "SHARED" && <span className="text-blue">every agent</span>}
                  <span>{memory.kind.toLowerCase()}</span>
                  <code className="text-muted">{memory.subject}</code>
                  <span>importance {memory.importance}</span>
                  <span className={memory.useCount === 0 ? "text-warn-text" : ""}>
                    {memory.useCount === 0 ? "never recalled" : `recalled ${memory.useCount}×`}
                  </span>
                </span>
              </span>
              {memory.scope === "SHARED" ? (
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[.1em] text-muted" title="Shared with every agent — manage it on the Agents screen">
                  shared
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => remove.mutate(memory.id)}
                  className="shrink-0 font-mono text-[10px] uppercase tracking-[.1em] text-muted transition hover:text-ink"
                >
                  Forget
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-line pt-3">
        <Field label="Tell it something" full hint="Filed as a standing preference — it is shown on every task, not just one subject.">
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Always check the domain's mail authentication before promising deliverability."
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
            />
            <Button variant="secondary" disabled={adding.trim().length < 8 || add.isPending} onClick={() => add.mutate()}>
              Keep
            </Button>
          </div>
        </Field>
        {notice && <p className="mt-2 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{notice}</p>}
      </div>
    </section>
  );
}
