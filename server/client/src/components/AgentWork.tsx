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

/** The glyph and colour for each kind of step. Read down the left of a timeline. */
const STEP_STYLE: Record<AgentStepKind, { mark: string; tone: string }> = {
  STARTED: { mark: "▸", tone: "text-ink/40" },
  THOUGHT: { mark: "·", tone: "text-ink/45" },
  TOOL_CALL: { mark: "•", tone: "text-blue" },
  PREPARED: { mark: "◇", tone: "text-amber-600" },
  REFUSED: { mark: "×", tone: "text-red-600" },
  DELEGATED: { mark: "↳", tone: "text-blue" },
  REMEMBERED: { mark: "✱", tone: "text-ink/50" },
  BLOCKED: { mark: "!", tone: "text-amber-600" },
  FINISHED: { mark: "✓", tone: "text-emerald-600" },
  FAILED: { mark: "×", tone: "text-red-600" },
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
          <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">What it is working on</h3>
          {data && (
            <p className="mt-1 text-sm text-ink/55">
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
        <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {agent.name} is a {agent.status.toLowerCase()}. You can queue work for it now, but it will not pick anything up until you set it to
          Active.
        </p>
      )}

      {!data ? (
        <p className="text-sm text-ink/50">Loading…</p>
      ) : running.length + queued.length + waiting.length + finished.length === 0 ? (
        <p className="border border-line bg-cream px-3 py-3 text-sm text-ink/55">
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
      {label && <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[.12em] text-ink/35">{label}</p>}
      <div className="space-y-1.5">
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            onClick={() => onOpen(task.id)}
            className={`block w-full border px-3 py-2.5 text-left transition ${
              live ? "border-blue/40 bg-blue/[.04]" : muted ? "border-line bg-white hover:bg-ink/[.02]" : "border-line bg-white hover:bg-ink/[.02]"
            }`}
          >
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <StatusDot tone={STATUS_TONE[task.status]} />
                  <span className="truncate text-sm font-medium">{task.title}</span>
                </span>
                {(task.summary || task.blockedReason || task.error) && (
                  <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-ink/55">
                    {task.blockedReason ?? task.error ?? task.summary}
                  </span>
                )}
                <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10px] uppercase tracking-[.1em] text-ink/35">
                  <span>{STATUS_LABEL[task.status]}</span>
                  {task.toolCalls > 0 && <span>{task.toolCalls} tool call{task.toolCalls === 1 ? "" : "s"}</span>}
                  {task.dryRunCalls > 0 && <span className="text-amber-700">{task.dryRunCalls} prepared</span>}
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
            <span className="font-mono text-[10px] uppercase tracking-[.1em] text-ink/40">
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
        <p className="text-sm text-ink/50">Loading…</p>
      ) : (
        <div className="space-y-6">
          {notice && <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p>}

          {task.status === "BLOCKED" && (
            <div className="border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="font-mono text-[10px] uppercase tracking-[.12em] text-amber-800">It stopped and asked</p>
              <p className="mt-1.5 text-sm text-amber-900">{task.blockedReason}</p>
              <div className="mt-3">
                <Field label="Your answer" hint="Added to the brief. What it was originally asked stays on the record." full>
                  <textarea rows={2} className="input" value={answer} onChange={(event) => setAnswer(event.target.value)} />
                </Field>
              </div>
            </div>
          )}

          {task.status === "NEEDS_APPROVAL" && (
            <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {task.dryRunCalls} action{task.dryRunCalls === 1 ? " was" : "s were"} prepared and not carried out — {task.agent.name} is in dry
              run or below the autonomy those tools need. Read the timeline, then approve it. To stop being asked, raise its autonomy on its
              own card.
            </p>
          )}

          {task.error && <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{task.error}</p>}

          {task.summary && (
            <section>
              <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">What it says it did</h4>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink/75">{task.summary}</p>
            </section>
          )}

          <section>
            <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">What it was asked</h4>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink/65">{task.brief}</p>
            {linked.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {linked.map((entry, index) => (
                  <span key={index} className="rounded-lg border border-line bg-cream px-2 py-0.5 text-xs text-ink/60">
                    <span className="font-mono text-[9px] uppercase tracking-[.1em] text-ink/40">{entry!.label}</span> {entry!.text}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section>
            <h4 className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">
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
                      <span className="block text-sm leading-relaxed text-ink/75">{step.message}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-[.1em] text-ink/35">
                        <span className={style.tone}>{step.kind.toLowerCase().replace("_", " ")}</span>
                        {step.tool && <code className="text-ink/40">{step.tool}</code>}
                        <RelativeTime value={step.createdAt} />
                      </span>
                    </span>
                  </li>
                );
              })}
              {task.status === "RUNNING" && task.steps.length === 0 && <li className="text-sm text-ink/45">Thinking…</li>}
            </ol>
          </section>

          {task.children.length > 0 && (
            <section>
              <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Handed to others</h4>
              <ul className="space-y-1 text-sm text-ink/65">
                {task.children.map((child) => (
                  <li key={child.id}>
                    · {child.agent.name} — {child.title}{" "}
                    <span className="text-ink/40">({STATUS_LABEL[child.status]})</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {task.parent && (
            <p className="text-xs text-ink/45">
              Handed to {task.agent.name} by {task.parent.agent.name}, as part of “{task.parent.title}”.
            </p>
          )}
        </div>
      )}
    </Drawer>
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
        {notice && <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p>}

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

        <p className="border border-line bg-cream px-3 py-2 text-xs leading-relaxed text-ink/55">
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
        <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">What it remembers</h3>
        {data && (
          <p className="mt-1 text-sm text-ink/55">
            {data.summary.total} across {data.summary.subjects} subject{data.summary.subjects === 1 ? "" : "s"}
            {data.summary.neverUsed > 0 && ` · ${data.summary.neverUsed} never recalled`}
            {agent.sharedMemories > 0 && ` · including ${agent.sharedMemories} the whole company holds`}
          </p>
        )}
      </div>

      {memories.length === 0 ? (
        <p className="border border-line bg-cream px-3 py-2.5 text-sm text-ink/55">
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
                <span className="block text-sm leading-relaxed text-ink/75">{memory.content}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-[.1em] text-ink/35">
                  {/* Marked, because these are the company's rather than this
                      agent's — and forgetting one would take it away from all
                      of them, which is why this row doesn't offer to. */}
                  {memory.scope === "SHARED" && <span className="text-blue">every agent</span>}
                  <span>{memory.kind.toLowerCase()}</span>
                  <code className="text-ink/40">{memory.subject}</code>
                  <span>importance {memory.importance}</span>
                  <span className={memory.useCount === 0 ? "text-amber-700" : ""}>
                    {memory.useCount === 0 ? "never recalled" : `recalled ${memory.useCount}×`}
                  </span>
                </span>
              </span>
              {memory.scope === "SHARED" ? (
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[.1em] text-ink/25" title="Shared with every agent — manage it on the Agents screen">
                  shared
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => remove.mutate(memory.id)}
                  className="shrink-0 font-mono text-[10px] uppercase tracking-[.1em] text-ink/35 transition hover:text-ink"
                >
                  Forget
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-ink/10 pt-3">
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
        {notice && <p className="mt-2 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p>}
      </div>
    </section>
  );
}
