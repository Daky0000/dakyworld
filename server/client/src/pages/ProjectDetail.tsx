import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Badge, Button, Card, EmptyState, Loading, Money, PageHeader, StatGrid, StatTile } from "../components/ui";

interface ProjectDetailData {
  id: string;
  name: string;
  serviceType: string;
  scopeSummary: string;
  status: string;
  budgetAmount?: string | null;
  actualHours: string;
  client: { id: string; name: string; email?: string | null };
  milestones: { id: string; title: string; dueDate?: string | null; completedAt?: string | null }[];
  tasks: { id: string; title: string; status: string; assignee?: { name: string } | null }[];
}

const TASK_STATUSES = ["TODO", "IN_PROGRESS", "REVIEW", "DONE"] as const;

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
    mutationFn: ({ taskId, status }: { taskId: string; status: string }) =>
      api.patch(`/projects/tasks/${taskId}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects", id] }),
  });

  const addMilestone = useMutation({
    mutationFn: (title: string) => api.post(`/projects/${id}/milestones`, { title }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects", id] });
      setMilestoneTitle("");
    },
  });

  // Derived progress
  const progress = useMemo(() => {
    if (!project) return { milestonesDone: 0, tasksDone: 0, milestonePct: 0, taskPct: 0 };
    const milestonesDone = project.milestones.filter((m) => Boolean(m.completedAt)).length;
    const tasksDone = project.tasks.filter((t) => t.status === "DONE").length;
    const milestonePct = project.milestones.length > 0 ? Math.round((milestonesDone / project.milestones.length) * 100) : 0;
    const taskPct = project.tasks.length > 0 ? Math.round((tasksDone / project.tasks.length) * 100) : 0;
    return { milestonesDone, tasksDone, milestonePct, taskPct };
  }, [project]);

  if (isLoading) return <Loading label="Loading project scopes" rows={4} />;
  if (!project) {
    return (
      <EmptyState
        message="Project not found."
        action={
          <Link to="/projects">
            <Button variant="secondary">Back to Projects</Button>
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={project.name}
        subtitle={`${project.client.name} · ${project.serviceType}`}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={project.status === "DELIVERED" ? "positive" : "info"}>{project.status}</Badge>
            <Link to={`/clients/${project.client.id}`}>
              <Button variant="secondary" size="sm">
                Client Profile
              </Button>
            </Link>
          </div>
        }
      />

      {/* Metrics Seam Grid */}
      <StatGrid columns={4}>
        <StatTile
          label="Budget"
          value={project.budgetAmount ? <Money amount={project.budgetAmount} /> : "—"}
          sub="Contracted amount"
        />
        <StatTile
          label="Tracked Engineering Hours"
          value={`${Number(project.actualHours).toFixed(1)}h`}
          sub="Recorded capacity"
        />
        <StatTile
          label="Milestone Progress"
          value={`${progress.milestonesDone}/${project.milestones.length}`}
          sub={`${progress.milestonePct}% deliverables completed`}
        />
        <StatTile
          label="Tasks Completed"
          value={`${progress.tasksDone}/${project.tasks.length}`}
          sub={`${progress.taskPct}% work orders finished`}
        />
      </StatGrid>

      {/* Scope Overview Card */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <span className="text-[11px] font-sans uppercase tracking-wider text-muted block">Contract Scope</span>
            <p className="mt-1 text-sm text-ink max-w-3xl leading-relaxed">
              {project.scopeSummary || "Custom project delivery scope without a written summary."}
            </p>
          </div>
          <div className="text-right text-xs">
            <span className="text-[11px] font-sans uppercase tracking-wider text-muted block">Client Partner</span>
            <Link to={`/clients/${project.client.id}`} className="font-semibold text-blue hover:underline mt-0.5 block">
              {project.client.name}
            </Link>
          </div>
        </div>
      </Card>

      {/* Milestones and Tasks Dual Grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Milestones */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-medium text-ink">
              Milestones ({project.milestones.length})
            </h3>
            <span className="font-mono text-xs text-muted font-semibold">
              {progress.milestonePct}% Done
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
            <div
              className="h-full bg-lime transition-all duration-300 rounded-full"
              style={{ width: `${progress.milestonePct}%` }}
            />
          </div>

          <div className="space-y-2 pt-1">
            {project.milestones.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between rounded-xl border border-line bg-white px-4 py-3 text-xs shadow-xs"
              >
                <div className="flex items-center gap-2 min-w-0">

                  <span className={`truncate font-medium ${m.completedAt ? "line-through text-muted" : "text-ink"}`}>
                    {m.title}
                  </span>
                </div>
                <Badge tone={m.completedAt ? "positive" : m.dueDate ? "default" : "muted"}>
                  {m.completedAt ? "Done" : m.dueDate ? new Date(m.dueDate).toLocaleDateString() : "No date"}
                </Badge>
              </div>
            ))}
            {project.milestones.length === 0 && (
              <div className="rounded-xl border border-dashed border-line p-5 text-center text-xs text-muted">
                No delivery milestones recorded yet.
              </div>
            )}
          </div>

          <form
            className="flex gap-2 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (milestoneTitle.trim()) addMilestone.mutate(milestoneTitle.trim());
            }}
          >
            <input
              value={milestoneTitle}
              onChange={(e) => setMilestoneTitle(e.target.value)}
              placeholder="New milestone name…"
              className="flex-1 rounded-xl border border-line bg-white px-3.5 py-1.5 text-xs text-ink outline-none focus:border-blue"
            />
            <Button type="submit" size="sm" disabled={addMilestone.isPending}>
              Add Milestone
            </Button>
          </form>
        </div>

        {/* Tasks */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-medium text-ink">
              Work Orders & Tasks ({project.tasks.length})
            </h3>
            <span className="font-mono text-xs text-muted font-semibold">
              {progress.taskPct}% Done
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
            <div
              className="h-full bg-blue transition-all duration-300 rounded-full"
              style={{ width: `${progress.taskPct}%` }}
            />
          </div>

          <div className="space-y-2 pt-1">
            {project.tasks.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white px-4 py-3 text-xs shadow-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className={`font-medium truncate ${t.status === "DONE" ? "line-through text-muted" : "text-ink"}`}>
                    {t.title}
                  </div>
                  {t.assignee && (
                    <div className="text-[11px] text-muted font-mono mt-0.5">Assigned to {t.assignee.name}</div>
                  )}
                </div>
                <select
                  value={t.status}
                  onChange={(e) => updateTaskStatus.mutate({ taskId: t.id, status: e.target.value })}
                  className="rounded-full border border-line bg-white px-2.5 py-1 font-sans text-[11px] uppercase tracking-[.06em] text-ink outline-none focus:border-blue"
                >
                  {TASK_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            {project.tasks.length === 0 && (
              <div className="rounded-xl border border-dashed border-line p-5 text-center text-xs text-muted">
                No individual work tasks assigned yet.
              </div>
            )}
          </div>

          <form
            className="flex gap-2 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (taskTitle.trim()) addTask.mutate(taskTitle.trim());
            }}
          >
            <input
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="New task title…"
              className="flex-1 rounded-xl border border-line bg-white px-3.5 py-1.5 text-xs text-ink outline-none focus:border-blue"
            />
            <Button type="submit" size="sm" disabled={addTask.isPending}>
              Add Task
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
