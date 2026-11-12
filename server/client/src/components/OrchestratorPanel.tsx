import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Field, StatusDot } from "./ui";
import type { Agent, AgentTask, TaskLevel } from "../lib/types";

/**
 * The one agent, and the place a task is given to it.
 *
 * In orchestrator mode the Owner does not pick who does the work: a task is
 * written here, the orchestrator matches it to a skill, grades its strength
 * (low, medium or high — which decides the model) and runs it. Everything
 * below this panel on the screen is a skill it holds.
 *
 * The same panel carries the switch back to the roster, because the moment
 * somebody wants the old shape is the moment they are looking at the new one.
 */
const STRENGTH_OPTIONS: Array<{ value: "auto" | TaskLevel; label: string }> = [
  { value: "auto", label: "Grade it for me" },
  { value: "simple", label: "Low — the small model" },
  { value: "standard", label: "Medium — the workhorse model" },
  { value: "complex", label: "High — the top model" },
];

export function OrchestratorPanel({
  mode,
  orchestrator,
  skillCount,
  activeSkills,
  onOpen,
}: {
  mode: "orchestrator" | "roster";
  orchestrator: Agent | null;
  skillCount: number;
  activeSkills: number;
  onOpen: (key: string) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [level, setLevel] = useState<"auto" | TaskLevel>("auto");
  const [notice, setNotice] = useState<string | null>(null);

  const give = useMutation({
    mutationFn: () =>
      api.post<{ task: AgentTask; note: string | null }>(`/agents/${orchestrator?.key}/tasks`, {
        title: title.trim(),
        brief: brief.trim(),
        priority: 2,
        level,
        runNow: orchestrator?.status === "ACTIVE",
      }),
    onSuccess: (result) => {
      setTitle("");
      setBrief("");
      setNotice(result.note ?? "Given to the Orchestrator. It is choosing the skill now — open it to watch the task.");
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const switchMode = useMutation({
    mutationFn: (next: "orchestrator" | "roster") => api.put<{ mode: string }>("/agents/mode", { mode: next }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["agents"] }),
    onError: (err: Error) => setNotice(err.message),
  });

  if (mode === "roster") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white px-5 py-4">
        <p className="min-w-0 text-sm text-ink/80">
          The workforce is running as a <strong>roster</strong>: each agent has its own memory and you choose who gets a task.
        </p>
        <Button variant="ghost" onClick={() => switchMode.mutate("orchestrator")} disabled={switchMode.isPending}>
          Switch to one Orchestrator
        </Button>
      </div>
    );
  }

  const ready = title.trim().length >= 3 && brief.trim().length >= 10 && Boolean(orchestrator);
  const stopped = orchestrator && (orchestrator.status === "PAUSED" || orchestrator.status === "RETIRED");

  return (
    <section className="rounded-2xl border border-ink bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot tone={stopped ? "warn" : orchestrator?.work && orchestrator.work.running > 0 ? "live" : "ok"} />
            <h2 className="font-display text-xl font-medium tracking-tight text-ink">Orchestrator</h2>
            <Badge tone="muted">
              {activeSkills} of {skillCount} skills on
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink/80">
            One agent with every skill and one memory of every lead, client and project. Give it a task: it chooses the skill, grades the
            task low, medium or high strength to pick the model, and uses that skill's tools.
          </p>
          {stopped && (
            <p className="mt-2 text-sm text-warn-text">
              It is {orchestrator?.status.toLowerCase()}, so no skill starts any work. Open it and set it to Active to resume.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {orchestrator && (
            <Button variant="ghost" onClick={() => onOpen(orchestrator.key)}>
              Open
            </Button>
          )}
          <Button variant="ghost" onClick={() => switchMode.mutate("roster")} disabled={switchMode.isPending}>
            Back to roster
          </Button>
        </div>
      </div>

      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !give.isPending) give.mutate();
        }}
      >
        <Field label="Task">
          <input className="input" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="Write a follow-up to the Accra plumbing lead" />
        </Field>
        <Field label="Strength" hint="Decides which paid model takes over when the free ones cannot.">
          <select className="input" value={level} onChange={(event) => setLevel(event.target.value as "auto" | TaskLevel)}>
            {STRENGTH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Brief" full>
          <textarea
            className="input min-h-[88px]"
            value={brief}
            maxLength={4000}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="What finished looks like, and anything it should know. It reads the record itself."
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={!ready || give.isPending}>
            {give.isPending ? "Giving…" : "Give to the Orchestrator"}
          </Button>
          {notice && <p className="min-w-0 text-sm text-muted">{notice}</p>}
        </div>
      </form>
    </section>
  );
}
