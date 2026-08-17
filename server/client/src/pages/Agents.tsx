import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Card, Drawer, EmptyState, PageHeader, StatTile, StatusDot, Toggle } from "../components/ui";
import type { Agent, AgentDetail, AgentList } from "../lib/types";

/** What each level actually permits, in the Owner's terms rather than the blueprint's. */
const LEVELS = [
  { n: 0, name: "Observe", means: "Reads and reports. Takes no action at all." },
  { n: 1, name: "Draft", means: "Prepares work. Nothing leaves the building." },
  { n: 2, name: "Recommend", means: "Chooses an action and explains why. You decide." },
  { n: 3, name: "Execute", means: "Takes low-risk actions without asking — tasks, notes, statuses." },
  { n: 4, name: "Autonomous", means: "Runs whole routine workflows. Only escalations reach you." },
  { n: 5, name: "Delegated", means: "Material actions. Reserved for a recorded owner decision." },
];

const DEPARTMENTS: Record<string, string> = {
  EXECUTIVE: "Executive", REVENUE: "Revenue", DELIVERY: "Delivery", FINANCE: "Finance",
  MARKETING: "Marketing", TECHNOLOGY: "Technology", CLIENT: "Client Success", RISK: "Risk & Quality", PEOPLE: "Agent Ops",
};

const TIER_ORDER = ["BOARD", "EXECUTIVE", "FUNCTIONAL", "OPERATIONAL", "SUB_AGENT"];
const TIER_LABEL: Record<string, string> = {
  BOARD: "Board", EXECUTIVE: "Executive", FUNCTIONAL: "Risk & people", OPERATIONAL: "Operations", SUB_AGENT: "Specialists",
};

function toneFor(agent: Agent): "live" | "ok" | "warn" | "idle" | "bad" {
  if (agent.status === "PAUSED") return "warn";
  if (agent.status === "RETIRED") return "bad";
  if (agent.status === "ACTIVE") return agent.dryRun ? "ok" : "live";
  return "idle";
}

export function Agents() {
  const [openKey, setOpenKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<AgentList>("/agents"),
  });

  const agents = data?.agents ?? [];
  const byTier = TIER_ORDER.map((tier) => [tier, agents.filter((a) => a.tier === tier)] as const).filter(([, list]) => list.length > 0);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Workforce"
        title="Agents"
        subtitle="Every agent is a job with a mission, a manager and a ceiling on what it may do unasked. Nothing here acts on its own until you raise it."
      />

      {/* The only number that really matters is how much can act unattended. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="On the roster" value={data?.summary.total ?? "—"} />
        <StatTile label="Active" value={data?.summary.active ?? "—"} sub="the rest are drafts" />
        <StatTile
          label="Can act unattended"
          value={data?.summary.aboveDraft ?? "—"}
          sub={data?.summary.aboveDraft ? "review these" : "nothing yet"}
        />
        <StatTile label="Departments" value={new Set(agents.map((a) => a.department)).size || "—"} />
      </div>

      {isLoading ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : agents.length === 0 ? (
        <EmptyState message="No agents have been seeded yet. They're created on server start — restart the API and they'll appear." />
      ) : (
        byTier.map(([tier, list]) => (
          <section key={tier} className="space-y-3">
            <h2 className="font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">{TIER_LABEL[tier] ?? tier}</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {list.map((agent) => (
                <button key={agent.key} type="button" onClick={() => setOpenKey(agent.key)} className="text-left">
                  <Card className="h-full transition hover:border-blue/40">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <StatusDot tone={toneFor(agent)} />
                          <span className="font-display text-lg tracking-[-.02em]">{agent.name}</span>
                        </div>
                        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">
                          {DEPARTMENTS[agent.department] ?? agent.department}
                          {agent.managerName ? ` · reports to ${agent.managerName}` : ""}
                        </p>
                      </div>
                      <Badge tone={agent.autonomyLevel > 2 || !agent.dryRun ? "default" : "muted"}>
                        L{agent.autonomyLevel} {LEVELS[agent.autonomyLevel]?.name}
                      </Badge>
                    </div>
                    <p className="mt-3 text-sm text-ink/60">{agent.mission}</p>
                    {agent.dryRun && (
                      <p className="mt-3 font-mono text-[10px] uppercase tracking-[.12em] text-ink/35">Dry run · nothing takes effect</p>
                    )}
                  </Card>
                </button>
              ))}
            </div>
          </section>
        ))
      )}

      <AgentDrawer agentKey={openKey} onClose={() => setOpenKey(null)} />
    </div>
  );
}

// --- Detail ----------------------------------------------------------------

function AgentDrawer({ agentKey, onClose }: { agentKey: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const { data: agent } = useQuery({
    queryKey: ["agent", agentKey],
    queryFn: () => api.get<AgentDetail>(`/agents/${agentKey}`),
    enabled: Boolean(agentKey),
  });

  const save = useMutation({
    mutationFn: (patch: Partial<Pick<Agent, "autonomyLevel" | "dryRun" | "status">>) =>
      api.patch<Agent>(`/agents/${agentKey}`, patch),
    onSuccess: () => {
      setNotice(null);
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["agent", agentKey] });
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const prompt = (agent?.prompt ?? {}) as Record<string, string>;
  const layers = Object.entries(prompt).filter(([, v]) => typeof v === "string" && v);

  return (
    <Drawer
      open={Boolean(agentKey)}
      onClose={() => {
        setNotice(null);
        onClose();
      }}
      wide
      title={agent?.name ?? "Agent"}
      subtitle={agent ? `${agent.title} · ${DEPARTMENTS[agent.department] ?? agent.department}` : undefined}
    >
      {!agent ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : (
        <div className="space-y-7">
          <p className="text-sm text-ink/70">{agent.mission}</p>

          {notice && <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p>}

          <section className="space-y-3">
            <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">What it may do unasked</h3>
            <div className="flex flex-wrap gap-1.5">
              {LEVELS.map((level) => (
                <Button
                  key={level.n}
                  size="sm"
                  variant={agent.autonomyLevel === level.n ? "primary" : "secondary"}
                  disabled={save.isPending}
                  onClick={() => save.mutate({ autonomyLevel: level.n })}
                >
                  {level.n} · {level.name}
                </Button>
              ))}
            </div>
            <p className="text-sm text-ink/55">{LEVELS[agent.autonomyLevel]?.means}</p>
            <div className="pt-1">
              <Toggle
                checked={agent.dryRun}
                onChange={(next) => save.mutate({ dryRun: next })}
                label="Dry run — it decides, but nothing takes effect"
              />
            </div>
            {(!agent.dryRun || agent.autonomyLevel > 2) && (
              <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                This agent can act without asking you. That is deliberate only if you set it.
              </p>
            )}
          </section>

          {agent.escalationPolicy && (
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">When it must stop and ask</h3>
              <p className="text-sm text-ink/70">{agent.escalationPolicy}</p>
            </section>
          )}

          {agent.toolkit.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Tools it may use</h3>
              <div className="flex flex-wrap gap-1.5">
                {agent.toolkit.map((tool) => (
                  <Badge key={tool} tone="muted">{tool}</Badge>
                ))}
              </div>
            </section>
          )}

          {agent.kpis.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Judged on</h3>
              <ul className="space-y-1 text-sm text-ink/70">
                {agent.kpis.map((k) => <li key={k}>· {k}</li>)}
              </ul>
            </section>
          )}

          {agent.reports.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Reports to it</h3>
              <p className="text-sm text-ink/70">{agent.reports.map((r) => r.name).join(", ")}</p>
            </section>
          )}

          {layers.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Its instructions</h3>
              <div className="space-y-3">
                {layers.map(([name, body]) => (
                  <div key={name}>
                    <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/35">{name}</p>
                    <p className="mt-0.5 text-sm text-ink/70">{body}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
