import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Badge, Button, Card, Money, PageHeader } from "../components/ui";

interface ProjectDetailData {
  id: string;
  name: string;
  serviceType: string;
  scopeSummary: string;
  status: string;
  budgetAmount?: string | null;
  actualHours: string;
  client: { id: string; name: string };
  milestones: { id: string; title: string; dueDate?: string | null; completedAt?: string | null }[];
  tasks: { id: string; title: string; status: string; assignee?: { name: string } | null }[];
}

const TASK_STATUSES = ["TODO", "IN_PROGRESS", "REVIEW", "DONE"];

export function ProjectDetail() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [taskTitle, setTaskTitle] = useState("");
  const [milestoneTitle, setMilestoneTitle] = useState("");

  const { data: project, isLoading } = useQuery({
    queryKey: ["projects", id],
    queryFn: () => api.get<ProjectDetailData>(`/projects/${id}`),
  });

  const addTask = useMutation({
    mutationFn: (title: string) => api.post(`/projects/${id}/tasks`, { title }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects", id] });
      setTaskTitle("");
    },
  });
  const updateTaskStatus = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: string }) => api.patch(`/projects/tasks/${taskId}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects", id] }),
  });
  const addMilestone = useMutation({
    mutationFn: (title: string) => api.post(`/projects/${id}/milestones`, { title }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects", id] });
      setMilestoneTitle("");
    },
  });

  if (isLoading || !project) return <div className="text-sm text-muted">Loading…</div>;

  return (
    <div>
      <PageHeader title={project.name} subtitle={`${project.client.name} · ${project.serviceType}`} action={<Badge>{project.status}</Badge>} />

      <div className="grid gap-8 lg:grid-cols-3">
        <Card>
          <div className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">Budget</div>
          <div className="mt-2 font-display text-2xl">{project.budgetAmount ? <Money amount={project.budgetAmount} /> : "—"}</div>
        </Card>
        <Card>
          <div className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">Hours logged</div>
          <div className="mt-2 font-display text-2xl">{Number(project.actualHours).toFixed(1)}h</div>
        </Card>
        <Card>
          <div className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">Scope</div>
          <div className="mt-2 text-sm text-ink">{project.scopeSummary}</div>
        </Card>
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <div>
          <h2 className="mb-4 font-display text-xl">Milestones</h2>
          <div className="space-y-2">
            {project.milestones.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-xl border border-line bg-white px-4 py-3 text-sm">
                <span>{m.title}</span>
                <Badge tone={m.completedAt ? "positive" : "muted"}>{m.completedAt ? "Done" : m.dueDate ? new Date(m.dueDate).toLocaleDateString() : "No date"}</Badge>
              </div>
            ))}
            {project.milestones.length === 0 && <div className="text-sm text-muted">No milestones yet.</div>}
          </div>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (milestoneTitle.trim()) addMilestone.mutate(milestoneTitle.trim());
            }}
          >
            <input value={milestoneTitle} onChange={(e) => setMilestoneTitle(e.target.value)} placeholder="New milestone" className="input" />
            <Button type="submit">Add</Button>
          </form>
        </div>

        <div>
          <h2 className="mb-4 font-display text-xl">Tasks</h2>
          <div className="space-y-2">
            {project.tasks.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded-xl border border-line bg-white px-4 py-3 text-sm">
                <div>
                  <div>{t.title}</div>
                  {t.assignee && <div className="text-xs text-muted">{t.assignee.name}</div>}
                </div>
                <select
                  value={t.status}
                  onChange={(e) => updateTaskStatus.mutate({ taskId: t.id, status: e.target.value })}
                  className="rounded-full border border-line-strong bg-white px-2 py-1 font-mono text-xs uppercase tracking-[.08em]"
                >
                  {TASK_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            {project.tasks.length === 0 && <div className="text-sm text-muted">No tasks yet.</div>}
          </div>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (taskTitle.trim()) addTask.mutate(taskTitle.trim());
            }}
          >
            <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="New task" className="input" />
            <Button type="submit">Add</Button>
          </form>
        </div>
      </div>
    </div>
  );
}
