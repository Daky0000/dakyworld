import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Card, Drawer, EmptyState, Field, PageHeader, StatTile, StatusDot, Toggle } from "../components/ui";
import type { Agent, AgentDetail, AgentList } from "../lib/types";
import { AgentMemories, AgentWork } from "../components/AgentWork";
import { AgentPromptEditor } from "../components/AgentPrompt";
import { SharedMemoryPanel } from "../components/SharedMemory";
import { AgentHiring } from "../components/AgentHiring";

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

/**
 * The tier above SUB_AGENT is management: an agent whose output is a decision,
 * a priority or a brief. Specialists are the ones who make things, so their
 * section is grouped under whoever they report to — "who do I ask for a video
 * edit" is answered by looking under the CMO, not by reading nine cards.
 */
const TIER_BLURB: Record<string, string> = {
  BOARD: "Recommends. Never executes.",
  EXECUTIVE: "Sets priorities and owns a department.",
  FUNCTIONAL: "Can block anything, and manages the agents themselves.",
  OPERATIONAL: "Runs one workflow end to end.",
  SUB_AGENT: "One craft each. These are the ones that make things.",
};

function toneFor(agent: Agent): "live" | "ok" | "warn" | "idle" | "bad" {
  // A task actually turning outranks every configured state: the dot is there
  // to say what is happening, not what was set.
  if (agent.work && agent.work.running > 0) return "live";
  if (agent.status === "PAUSED") return "warn";
  if (agent.status === "RETIRED") return "bad";
  if (agent.status === "ACTIVE") return agent.dryRun ? "ok" : "live";
  return "idle";
}

export function Agents() {
  // The open agent lives in the URL, the same way an open lead does — so a
  // specific agent's drawer can be linked to, which is what you want when
  // telling somebody which one to look at.
  const [searchParams, setSearchParams] = useSearchParams();
  const openKey = searchParams.get("agent");
  const setOpenKey = (key: string | null) =>
    setSearchParams(
      (params) => {
        if (key) params.set("agent", key);
        else params.delete("agent");
        return params;
      },
      { replace: true },
    );
  const [hiring, setHiring] = useState(false);

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
        action={<Button onClick={() => setHiring(true)}>Hire a specialist</Button>}
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
        <StatTile
          label="Working now"
          value={data?.summary.working ?? "—"}
          sub={data?.summary.waiting ? `${data.summary.waiting} waiting on you` : "nothing in flight"}
        />
      </div>

      {/* Above the roster, because a proposal waiting on a decision is the one
          thing on this screen that is blocking work rather than describing it. */}
      <AgentHiring />

      {isLoading ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : agents.length === 0 ? (
        <EmptyState message="No agents have been seeded yet. They're created on server start — restart the API and they'll appear." />
      ) : (
        byTier.map(([tier, list]) => (
          <section key={tier} className="space-y-3">
            <div>
              <h2 className="font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">{TIER_LABEL[tier] ?? tier}</h2>
              {TIER_BLURB[tier] && <p className="mt-0.5 text-xs text-ink/40">{TIER_BLURB[tier]}</p>}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {list.map((agent) => (
                <button key={agent.key} type="button" onClick={() => setOpenKey(agent.key)} className="text-left">
                  <Card className="h-full transition hover:border-blue/40">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <StatusDot tone={toneFor(agent)} />
                          {agent.avatar && <span aria-hidden className="text-ink/50">{agent.avatar}</span>}
                          <span className="font-display text-lg tracking-[-.02em]">{agent.name}</span>
                          {agent.custom && <Badge tone="muted">yours</Badge>}
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
                    {agent.skills.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1">
                        {agent.skills.slice(0, 4).map((skill) => (
                          <span key={skill} className="rounded-lg border border-line bg-cream px-1.5 py-0.5 text-[11px] text-ink/55">
                            {skill}
                          </span>
                        ))}
                        {agent.skills.length > 4 && <span className="px-1 py-0.5 text-[11px] text-ink/35">+{agent.skills.length - 4}</span>}
                      </div>
                    )}
                    {(agent.work?.running || agent.work?.queued || agent.work?.waiting) ? (
                      <p className="mt-3 flex flex-wrap items-center gap-x-3 font-mono text-[10px] uppercase tracking-[.12em]">
                        {agent.work.running > 0 && <span className="text-blue">working on {agent.work.running}</span>}
                        {agent.work.queued > 0 && <span className="text-ink/45">{agent.work.queued} queued</span>}
                        {agent.work.waiting > 0 && <span className="text-amber-700">{agent.work.waiting} waiting on you</span>}
                      </p>
                    ) : agent.dryRun ? (
                      <p className="mt-3 font-mono text-[10px] uppercase tracking-[.12em] text-ink/35">Dry run · nothing takes effect</p>
                    ) : null}
                  </Card>
                </button>
              ))}
            </div>
          </section>
        ))
      )}

      {/* After the roster rather than before it: the roster is what somebody
          came here for, and this is the thing they reach for once they notice
          they are about to type the same instruction into four agents. */}
      <SharedMemoryPanel />

      <AgentDrawer agentKey={openKey} onClose={() => setOpenKey(null)} />
      <HireDrawer open={hiring} onClose={() => setHiring(false)} agents={agents} onHired={(key) => setOpenKey(key)} />
    </div>
  );
}

/**
 * Hiring a specialist.
 *
 * The nine shipped specialists are the crafts Dakyworld already sells. They
 * will not be the last — the next one is a 3D artist, a bookkeeper, a
 * translator — and every one of those needing a deploy would make the roster a
 * developer's list rather than the Owner's.
 *
 * It arrives at level 1 with dry run on, exactly as the built-in ones do, and
 * this form cannot say otherwise: hiring somebody and handing them the company
 * card are two decisions. The autonomy controls appear once it exists.
 */
function HireDrawer({
  open,
  onClose,
  agents,
  onHired,
}: {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  onHired: (key: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [key, setKey] = useState("");
  const [avatar, setAvatar] = useState("");
  const [managerKey, setManagerKey] = useState("");
  const [department, setDepartment] = useState("TECHNOLOGY");
  const [mission, setMission] = useState("");
  const [skills, setSkills] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // Only somebody with people under them can be a manager, which in practice
  // means the executive and functional tiers. A specialist reporting to a
  // specialist has nowhere to escalate.
  const managers = agents.filter((agent) => agent.tier !== "SUB_AGENT" && agent.status !== "RETIRED");

  useEffect(() => {
    if (!open) return;
    setName("");
    setTitle("");
    setKey("");
    setAvatar("");
    setManagerKey(managers.find((agent) => agent.key === "cto")?.key ?? managers[0]?.key ?? "");
    setDepartment("TECHNOLOGY");
    setMission("");
    setSkills("");
    setNotice(null);
    // Reset when it opens, not on every roster change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A key is derived rather than typed: it appears in every audit row and in
  // every grant, so it should be predictable and it should not be fiddly.
  const derivedKey =
    key ||
    `${department.toLowerCase().slice(0, 4)}.${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 20)}`;

  const hire = useMutation({
    mutationFn: () =>
      api.post<Agent>("/agents", {
        key: derivedKey,
        name: name.trim(),
        title: title.trim() || name.trim(),
        department,
        managerKey,
        mission: mission.trim(),
        skills: skills
          .split(/[\n,]/)
          .map((skill) => skill.trim())
          .filter(Boolean),
        avatar: avatar.trim() || null,
        toolkit: [],
      }),
    onSuccess: (agent) => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      onClose();
      onHired(agent.key);
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const ready = name.trim().length > 1 && mission.trim().length > 9 && Boolean(managerKey);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Hire a specialist"
      subtitle="One craft, one manager, and nothing it may do unasked"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => hire.mutate()} disabled={!ready || hire.isPending}>
            {hire.isPending ? "Hiring…" : "Hire"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {notice && <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="What you would call the role. '3D Artist', 'Bookkeeper'.">
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </Field>
          <Field label="Job title" hint="Leave blank to use the name.">
            <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="Reports to" hint="Where its escalations go. A specialist with nobody above it has nowhere to stop and ask.">
            <select className="input" value={managerKey} onChange={(event) => setManagerKey(event.target.value)}>
              {managers.map((agent) => (
                <option key={agent.key} value={agent.key}>
                  {agent.name} — {agent.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Department">
            <select className="input" value={department} onChange={(event) => setDepartment(event.target.value)}>
              {Object.entries(DEPARTMENTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Mission" full hint="One or two sentences: what this one is for, and what it is not for.">
          <textarea rows={3} className="input" value={mission} onChange={(event) => setMission(event.target.value)} />
        </Field>

        <Field label="Skills" full hint="One per line, or comma-separated. In a client's words, not tool names.">
          <textarea
            rows={4}
            className="input"
            placeholder={"Product photography\nRetouching\nColour grading"}
            value={skills}
            onChange={(event) => setSkills(event.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Glyph" hint="One character for the roster. Optional.">
            <input className="input" maxLength={4} value={avatar} onChange={(event) => setAvatar(event.target.value)} placeholder="◆" />
          </Field>
          <Field label="Key" hint="Appears in every audit row. Derived from the name unless you set one.">
            <input className="input font-mono text-xs" value={key} onChange={(event) => setKey(event.target.value)} placeholder={derivedKey} />
          </Field>
        </div>

        <p className="border border-line bg-cream px-3 py-2 text-xs text-ink/55">
          It starts at level 1 with dry run on and no tools, like every other agent here. Grant it tools and raise its autonomy from its own
          card once you have seen what it produces.
        </p>
      </div>
    </Drawer>
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
    mutationFn: (patch: Partial<Pick<Agent, "autonomyLevel" | "dryRun" | "status" | "toolkit" | "skills" | "kpis">>) =>
      api.patch<Agent>(`/agents/${agentKey}`, patch),
    onSuccess: () => {
      setNotice(null);
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["agent", agentKey] });
    },
    onError: (err: Error) => setNotice(err.message),
  });

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

          {/* First, because "what is it doing" outranks "how is it configured"
              every time somebody opens this. */}
          <AgentWork agent={agent} />

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

          {agent.skills.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">What it knows</h3>
              <div className="flex flex-wrap gap-1.5">
                {agent.skills.map((skill) => (
                  <span key={skill} className="rounded-lg border border-line bg-cream px-2 py-0.5 text-xs text-ink/60">
                    {skill}
                  </span>
                ))}
              </div>
              <p className="text-xs text-ink/40">
                Skills are what it is asked for. Tools are what it can reach — the two are separate, and only the second is a permission.
              </p>
            </section>
          )}

          <ToolGrants agent={agent} onToggle={(toolkit) => save.mutate({ toolkit })} saving={save.isPending} />

          <AgentMemories agent={agent} />

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

          <AgentPromptEditor agent={agent} />
        </div>
      )}
    </Drawer>
  );
}

/**
 * What this agent may actually call.
 *
 * The toolkit stopped being decoration when the tool layer landed: it is the
 * allow-list the invoker checks before every call, so a tick here is a real
 * capability and clearing one takes it away immediately.
 *
 * Three things can stop a granted tool from firing and all three are shown,
 * because they need three different fixes: the integration isn't connected
 * (paste a key), the agent's autonomy is too low (raise it), or dry run is on
 * (that one is usually deliberate).
 */
function ToolGrants({
  agent,
  onToggle,
  saving,
}: {
  agent: AgentDetail;
  onToggle: (toolkit: string[]) => void;
  saving: boolean;
}) {
  const tools = agent.tools ?? [];
  if (tools.length === 0) return null;

  const granted = tools.filter((tool) => tool.granted);
  const groups = [...new Set(tools.map((tool) => tool.group))];

  const toggle = (key: string) => {
    const next = agent.toolkit.includes(key)
      ? agent.toolkit.filter((existing) => existing !== key)
      : [...agent.toolkit, key];
    onToggle(next);
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Tools it may use</h3>
        <p className="mt-1 text-sm text-ink/55">
          {granted.length} of {tools.length} granted
          {granted.some((tool) => !tool.ready) && " · some need a key before they will do anything"}
        </p>
      </div>

      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group}>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[.12em] text-ink/35">{group}</p>
            <div className="space-y-1">
              {tools
                .filter((tool) => tool.group === group)
                .map((tool) => (
                  <label
                    key={tool.key}
                    className={`flex cursor-pointer items-start gap-2.5 border px-2.5 py-2 transition-colors ${
                      tool.granted ? "border-blue/30 bg-blue/[.04]" : "border-line bg-white hover:bg-ink/[.02]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={tool.granted}
                      disabled={saving}
                      onChange={() => toggle(tool.key)}
                      className="mt-1 accent-blue"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">{tool.name}</span>
                        {tool.spends && <Badge>$</Badge>}
                        {tool.outward && <Badge tone="muted">outward</Badge>}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-ink/55">{tool.purpose}</span>
                      {tool.granted && !tool.ready && tool.blockedReason && (
                        <span className="mt-1 block text-xs text-amber-700">{tool.blockedReason}</span>
                      )}
                      {tool.granted && tool.ready && tool.permissionNote && (
                        <span className={`mt-1 block text-xs ${tool.allowed ? "text-ink/45" : "text-amber-700"}`}>
                          {tool.allowed ? "" : "Cannot right now — "}
                          {tool.permissionNote}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
