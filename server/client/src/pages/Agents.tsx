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

/**
 * Whether an agent picks work up at all.
 *
 * Separate from autonomy and often confused with it: status is "is it
 * working", autonomy is "how much may it do while working". An ACTIVE agent at
 * level 1 with dry run on is exactly what every agent here ships as once it is
 * switched on — it takes tasks and prepares everything for a person.
 */
const STATUSES = [
  { value: "DRAFT" as const, label: "Draft", means: "On the roster and taking nothing. Work queued against it waits." },
  { value: "ACTIVE" as const, label: "Active", means: "Picks up its queue. What it may do while working is the ceiling below." },
  { value: "PAUSED" as const, label: "Paused", means: "Stopped by you. A rehearsal will not wake it and nothing will start." },
  { value: "RETIRED" as const, label: "Retired", means: "Finished with. It cannot be delegated to or consulted." },
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
  /**
   * Agents ticked for a batch change.
   *
   * The roster is fifty-one and every specialist ships as a draft, so the
   * ordinary first act here — switch on the ones I want working — was
   * fifty-one visits to a drawer.
   */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<AgentList>("/agents"),
  });

  const setStatus = useMutation({
    mutationFn: (body: { keys: string[]; status: string }) =>
      api.patch<{ updated: number; queuedNowStartable: number }>("/agents/bulk", body),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      setPicked(new Set());
      setBatchNote(
        `${result.updated} agent${result.updated === 1 ? "" : "s"} updated.` +
          (result.queuedNowStartable
            ? ` ${result.queuedNowStartable} queued task${result.queuedNowStartable === 1 ? "" : "s"} can now start.`
            : ""),
      );
    },
    onError: (err: Error) => setBatchNote(err.message),
  });
  const [batchNote, setBatchNote] = useState<string | null>(null);

  const agents = data?.agents ?? [];
  const drafts = agents.filter((agent) => agent.status === "DRAFT");
  const byTier = TIER_ORDER.map((tier) => [tier, agents.filter((a) => a.tier === tier)] as const).filter(([, list]) => list.length > 0);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Workforce"
        title="Agents"
        subtitle="Every agent is a job with a mission, a manager and a ceiling on what it may do unasked. Nothing here acts on its own until you raise it."
        action={
          <div className="flex items-center gap-2">
            <StartTheDay />
            <Button onClick={() => setHiring(true)}>Hire a specialist</Button>
          </div>
        }
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

      {batchNote && (
        <p className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink">
          {batchNote}{" "}
          <button type="button" onClick={() => setBatchNote(null)} className="text-blue hover:underline">
            Dismiss
          </button>
        </p>
      )}

      {/*
        Switching a batch on. Status only — autonomy and dry run decide whether
        software may act on a client unasked, and a bulk control over those
        would be one click that widened the whole workforce. Activating an
        agent only lets it pick up the queue it already has, at the level it
        already holds, which for everything here is 1 with dry run on.
      */}
      {(picked.size > 0 || drafts.length > 0) && (
        <div className="overflow-hidden rounded-2xl flex flex-wrap items-center gap-3 border border-ink bg-ink px-4 py-3 text-cream">
          <span className="font-mono text-[11px] uppercase tracking-[.14em]">
            {picked.size > 0 ? `${picked.size} picked` : `${drafts.length} draft${drafts.length === 1 ? "" : "s"} on the roster`}
          </span>
          {picked.size === 0 ? (
            <button
              type="button"
              onClick={() => setPicked(new Set(drafts.map((agent) => agent.key)))}
              className="rounded-full border border-cream/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em] text-cream hover:bg-cream/10"
            >
              Pick every draft
            </button>
          ) : (
            <>
              {(["ACTIVE", "PAUSED", "DRAFT"] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  disabled={setStatus.isPending}
                  onClick={() => setStatus.mutate({ keys: [...picked], status })}
                  className="rounded-full border border-cream/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em] text-cream hover:bg-cream/10 disabled:text-cream/40"
                >
                  {status === "ACTIVE" ? "Set active" : status === "PAUSED" ? "Pause" : "Back to draft"}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPicked(new Set())}
                className="font-mono text-[10px] uppercase tracking-[.14em] text-cream/60 hover:text-cream"
              >
                Clear
              </button>
            </>
          )}
          <span className="font-mono text-[10px] uppercase tracking-[.1em] text-cream/50">
            Status only — what each may do unasked stays where it is
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : agents.length === 0 ? (
        <EmptyState message="No agents have been seeded yet. They're created on server start — restart the API and they'll appear." />
      ) : (
        byTier.map(([tier, list]) => (
          <section key={tier} className="space-y-3">
            <div>
              <h2 className="font-mono text-[10px] uppercase tracking-[.16em] text-muted">{TIER_LABEL[tier] ?? tier}</h2>
              {TIER_BLURB[tier] && <p className="mt-0.5 text-xs text-muted">{TIER_BLURB[tier]}</p>}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {list.map((agent) => (
                <div key={agent.key} className="relative">
                  {/* Beside the card rather than inside it: the card is itself a
                      button, and a checkbox nested in one is neither clickable
                      nor valid. */}
                  <label
                    className="absolute right-3 top-3 z-10 flex cursor-pointer items-center gap-1 rounded-xl border border-line bg-white/90 px-1.5 py-0.5"
                    title="Pick for a batch change"
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(agent.key)}
                      onChange={() =>
                        setPicked((current) => {
                          const next = new Set(current);
                          if (next.has(agent.key)) next.delete(agent.key);
                          else next.add(agent.key);
                          return next;
                        })
                      }
                    />
                  </label>
                <button type="button" onClick={() => setOpenKey(agent.key)} className="w-full text-left">
                  <Card className="h-full transition hover:border-blue/40">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <StatusDot tone={toneFor(agent)} />
                          {agent.avatar && <span aria-hidden className="text-muted">{agent.avatar}</span>}
                          <span className="font-display text-lg tracking-[-.02em]">{agent.name}</span>
                          {agent.custom && <Badge tone="muted">yours</Badge>}
                        </div>
                        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[.12em] text-muted">
                          {DEPARTMENTS[agent.department] ?? agent.department}
                          {agent.managerName ? ` · reports to ${agent.managerName}` : ""}
                        </p>
                      </div>
                      <Badge tone={agent.autonomyLevel > 2 || !agent.dryRun ? "default" : "muted"}>
                        L{agent.autonomyLevel} {LEVELS[agent.autonomyLevel]?.name}
                      </Badge>
                    </div>
                    <p className="mt-3 text-sm text-muted">{agent.mission}</p>
                    {agent.skills.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1">
                        {agent.skills.slice(0, 4).map((skill) => (
                          <span key={skill} className="rounded-xl border border-line bg-cream px-1.5 py-0.5 text-[11px] text-muted">
                            {skill}
                          </span>
                        ))}
                        {agent.skills.length > 4 && <span className="px-1 py-0.5 text-[11px] text-muted">+{agent.skills.length - 4}</span>}
                      </div>
                    )}
                    {(agent.work?.running || agent.work?.queued || agent.work?.waiting) ? (
                      <p className="mt-3 flex flex-wrap items-center gap-x-3 font-mono text-[10px] uppercase tracking-[.12em]">
                        {agent.work.running > 0 && <span className="text-blue">working on {agent.work.running}</span>}
                        {agent.work.queued > 0 && <span className="text-muted">{agent.work.queued} queued</span>}
                        {agent.work.waiting > 0 && <span className="text-warn-text">{agent.work.waiting} waiting on you</span>}
                      </p>
                    ) : agent.dryRun ? (
                      <p className="mt-3 font-mono text-[10px] uppercase tracking-[.12em] text-muted">Dry run · nothing takes effect</p>
                    ) : null}
                  </Card>
                </button>
                </div>
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
        {notice && <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{notice}</p>}

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

        <p className="rounded-xl border border-line bg-cream px-3 py-2 text-xs text-muted">
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
    mutationFn: (
      patch: Partial<
        Pick<
          Agent,
          | "autonomyLevel"
          | "dryRun"
          | "status"
          | "toolkit"
          | "skills"
          | "kpis"
          | "maxTasksPerDay"
          | "maxTasksPerWeek"
          | "maxTasksPerMonth"
        >
      >,
    ) =>
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
        <div className="text-sm text-muted">Loading…</div>
      ) : (
        <div className="space-y-7">
          <p className="text-sm text-ink">{agent.mission}</p>

          {notice && <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{notice}</p>}

          {/* First, because "what is it doing" outranks "how is it configured"
              every time somebody opens this. */}
          <AgentWork agent={agent} />

          {/*
            Whether it picks work up at all — and until Aug 2026 there was no
            control for it anywhere on this screen. Every specialist and most of
            the board seed as a DRAFT and `runDueTasks` only starts a task for
            an ACTIVE agent, so a queue against a draft was real work waiting on
            a switch that did not exist in the interface. The boot log has been
            saying "N queued task(s) belong to agents that are not Active" the
            whole time.

            Above autonomy on purpose: "is it working" comes before "how much
            may it do while working".
          */}
          <section className="space-y-3">
            <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">Whether it works</h3>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map((option) => (
                <Button
                  key={option.value}
                  size="sm"
                  variant={agent.status === option.value ? "primary" : "secondary"}
                  disabled={save.isPending}
                  onClick={() => save.mutate({ status: option.value })}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <p className="text-sm text-muted">{STATUSES.find((option) => option.value === agent.status)?.means}</p>
            {agent.status !== "ACTIVE" && agent.work.queued > 0 && (
              <p className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
                {agent.work.queued} task{agent.work.queued === 1 ? "" : "s"} {agent.work.queued === 1 ? "is" : "are"} queued against this
                agent and none will start until it is Active.
              </p>
            )}
          </section>

          <AgentPace agent={agent} onSave={save.mutate} saving={save.isPending} />

          <section className="space-y-3">
            <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">What it may do unasked</h3>
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
            <p className="text-sm text-muted">{LEVELS[agent.autonomyLevel]?.means}</p>
            <div className="pt-1">
              <Toggle
                checked={agent.dryRun}
                onChange={(next) => save.mutate({ dryRun: next })}
                label="Dry run — it decides, but nothing takes effect"
              />
            </div>
            {(!agent.dryRun || agent.autonomyLevel > 2) && (
              <p className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
                This agent can act without asking you. That is deliberate only if you set it.
              </p>
            )}

            <WhyItOnlyPrepares agentKey={agent.key} />
          </section>

          {agent.skills.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">What it knows</h3>
              <div className="flex flex-wrap gap-1.5">
                {agent.skills.map((skill) => (
                  <span key={skill} className="rounded-xl border border-line bg-cream px-2 py-0.5 text-xs text-muted">
                    {skill}
                  </span>
                ))}
              </div>
              <p className="text-xs text-muted">
                Skills are what it is asked for. Tools are what it can reach — the two are separate, and only the second is a permission.
              </p>
            </section>
          )}

          <ToolGrants agent={agent} onToggle={(toolkit) => save.mutate({ toolkit })} saving={save.isPending} />

          <AgentMemories agent={agent} />

          {agent.kpis.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">Judged on</h3>
              <ul className="space-y-1 text-sm text-ink">
                {agent.kpis.map((k) => <li key={k}>· {k}</li>)}
              </ul>
            </section>
          )}

          {agent.reports.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">Reports to it</h3>
              <p className="text-sm text-ink">{agent.reports.map((r) => r.name).join(", ")}</p>
            </section>
          )}

          <AgentPromptEditor agent={agent} />
        </div>
      )}
    </Drawer>
  );
}

/**
 * How often this agent may pick work up.
 *
 * A different ceiling from the spending one and needed beside it: a budget
 * says how much may be spent and nothing at all about how often, so an agent
 * on cheap work can run all day inside its budget and still act far more than
 * anybody meant. This is the pace.
 *
 * **The counts show whether or not a ceiling is set.** "12 today, no limit" is
 * the number somebody needs in order to pick a limit, and a panel that only
 * counted once a limit existed could not help them choose one.
 *
 * Blank means no ceiling and **0 means none at all** — which is the obvious way
 * to stop an agent taking work without retiring it. They are text boxes rather
 * than `<input type="number">` for the same reason the style panel's are: a
 * spinner sitting on 0 reads as a limit somebody set, and blank has to be
 * distinguishable from zero here more than anywhere else on this screen.
 */
function AgentPace({
  agent,
  onSave,
  saving,
}: {
  agent: AgentDetail;
  onSave: (patch: { maxTasksPerDay?: number | null; maxTasksPerWeek?: number | null; maxTasksPerMonth?: number | null }) => void;
  saving: boolean;
}) {
  const FIELDS = [
    { key: "maxTasksPerDay" as const, period: "DAY" as const, label: "a day" },
    { key: "maxTasksPerWeek" as const, period: "WEEK" as const, label: "a week" },
    { key: "maxTasksPerMonth" as const, period: "MONTH" as const, label: "a month" },
  ];

  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((field) => [field.key, agent[field.key] === null ? "" : String(agent[field.key])])),
  );

  const commit = (key: (typeof FIELDS)[number]["key"]) => {
    const raw = draft[key]?.trim() ?? "";
    // Blank clears the ceiling; anything that is not a whole number is not a
    // ceiling and is put back rather than guessed at.
    const next = raw === "" ? null : Number(raw);
    if (next !== null && (!Number.isInteger(next) || next < 0)) {
      setDraft((current) => ({ ...current, [key]: agent[key] === null ? "" : String(agent[key]) }));
      return;
    }
    if (next === agent[key]) return;
    onSave({ [key]: next });
  };

  return (
    <section className="space-y-3">
      <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">How often it may work</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        {FIELDS.map((field) => {
          const usage = agent.pace?.find((row) => row.period === field.period);
          return (
            <div key={field.key} className="space-y-1">
              <label className="block font-mono text-[10px] uppercase tracking-[.1em] text-muted">
                Tasks in {field.label}
              </label>
              <input
                value={draft[field.key] ?? ""}
                disabled={saving}
                placeholder="no limit"
                onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                onBlur={() => commit(field.key)}
                onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                className="w-full rounded-xl border border-line bg-white px-2 py-1 text-sm text-ink"
              />
              <p className="text-xs text-muted">
                {usage ? `${usage.started} started` : "—"}
                {usage?.limit === 0 ? " · taking none" : usage?.limit != null ? ` of ${usage.limit}` : " · no limit"}
              </p>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted">
        A ceiling on how often, not on how much — spending has its own under Costs. A task held by one of these stays queued and
        starts when the period rolls over. Leave blank for no limit; 0 stops it taking work without retiring it.
      </p>
    </section>
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
        <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">Tools it may use</h3>
        <p className="mt-1 text-sm text-muted">
          {granted.length} of {tools.length} granted
          {granted.some((tool) => !tool.ready) && " · some need a key before they will do anything"}
        </p>
      </div>

      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group}>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[.12em] text-muted">{group}</p>
            <div className="space-y-1">
              {tools
                .filter((tool) => tool.group === group)
                .map((tool) => (
                  <label
                    key={tool.key}
                    className={`flex cursor-pointer items-start gap-2.5 border px-2.5 py-2 transition-colors ${
                      tool.granted ? "border-blue/30 bg-blue/[.04]" : "border-line bg-white hover:bg-sunken"
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
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted">{tool.purpose}</span>
                      {tool.granted && !tool.ready && tool.blockedReason && (
                        <span className="mt-1 block text-xs text-warn-text">{tool.blockedReason}</span>
                      )}
                      {tool.granted && tool.ready && tool.permissionNote && (
                        <span className={`mt-1 block text-xs ${tool.allowed ? "text-muted" : "text-warn-text"}`}>
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

// --- Why an Active agent still only prepares -------------------------------

interface Gate {
  key: string;
  name: string;
  scope: string;
  spends: boolean;
  outward: boolean;
  state: "does" | "prepares" | "refused";
  because: string | null;
}

interface Gates {
  agent: { key: string; name: string; status: string; dryRun: boolean; autonomyLevel: number };
  verdict: string;
  blockers: Array<{ switch: string; is: string; means: string; fix: string }>;
  counts: { does: number; prepares: number; refused: number };
  tools: Gate[];
}

/**
 * "I set it to Active and nothing happens for real."
 *
 * Active and live are two different switches and always have been. `status`
 * decides whether the agent is given work at all; `dryRun` decides whether
 * anything it decides leaves the building; `autonomyLevel` decides how far.
 * Every agent ships Active-able with dry run **on** and autonomy **1**, so an
 * agent switched to Active does exactly what the design says: it prepares
 * everything and carries out none of it, and the work piles up under Approvals.
 *
 * That is correct and it was invisible — three fields on one card, none of
 * which says what the other two do to it. This asks the server, which asks the
 * real gate (`permissionFor`, the same function the runner goes through on
 * every call) once per tool the agent holds. Nothing here re-implements the
 * rules, so it cannot drift from them: if this is wrong, the runner is wrong.
 */
function WhyItOnlyPrepares({ agentKey }: { agentKey: string }) {
  const queryClient = useQueryClient();
  const [level, setLevel] = useState(3);
  const gates = useQuery({ queryKey: ["agent-gates", agentKey], queryFn: () => api.get<Gates>(`/agents/${agentKey}/gates`) });

  const goLive = useMutation({
    mutationFn: () => api.post<{ nowAllowed: string[] }>(`/agents/${agentKey}/go-live`, { level }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["agent", agentKey] });
      void queryClient.invalidateQueries({ queryKey: ["agent-gates", agentKey] });
    },
  });

  if (!gates.data) return null;
  const { verdict, blockers, counts, tools } = gates.data;
  const preparing = tools.filter((tool) => tool.state === "prepares");

  return (
    <div className="mt-3 space-y-3 rounded border border-line bg-cream/60 p-3">
      <p className="text-sm text-ink">{verdict}</p>

      {blockers.length > 0 && (
        <ul className="space-y-2 text-sm">
          {blockers.map((blocker, at) => (
            <li key={`${blocker.switch}-${at}`}>
              <span className="font-medium">
                {blocker.switch}: {blocker.is}
              </span>
              <span className="text-muted"> — {blocker.means}</span>
              <span className="block text-muted">{blocker.fix}</span>
            </li>
          ))}
        </ul>
      )}

      {preparing.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">
            {counts.does} of its tools run for real, {counts.prepares} only prepare
            {counts.refused > 0 && `, ${counts.refused} are refused outright`}
          </summary>
          <ul className="mt-2 space-y-1">
            {tools.map((tool) => (
              <li key={tool.key} className="flex items-start gap-2 text-xs">
                <span className="w-20 shrink-0 font-mono text-muted">
                  {tool.state === "does" ? "does" : tool.state === "prepares" ? "prepares" : "refused"}
                </span>
                <span className="min-w-0">
                  <span className="font-mono text-ink">{tool.key}</span>
                  {tool.because && <span className="text-muted"> — {tool.because}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {blockers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <span className="text-xs text-muted">Set it live at level</span>
          {[2, 3, 4].map((option) => (
            <Button key={option} size="sm" variant={level === option ? "primary" : "secondary"} onClick={() => setLevel(option)}>
              {option}
            </Button>
          ))}
          <Button size="sm" variant="danger" disabled={goLive.isPending} onClick={() => goLive.mutate()}>
            {goLive.isPending ? "Setting live…" : "Active, out of dry run"}
          </Button>
        </div>
      )}

      {goLive.data && (
        <ul className="space-y-1 text-sm text-ink">
          {goLive.data.nowAllowed.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {goLive.error && <p className="text-sm text-danger-text">{(goLive.error as Error).message}</p>}
    </div>
  );
}

// --- Start the day ---------------------------------------------------------

interface DayStarted {
  raised: number;
  woken: number;
  started: number;
  hunts: number;
  asleep: string[];
  summary: string;
}

/**
 * The clock, brought forward by hand.
 *
 * Standing work comes round at 08:00 and a hunt at 07:30, which is the right
 * way for this to run and the wrong way to watch it. Somebody who has just set
 * an agent live wants to see what it does, and the honest answer today is
 * "wait until tomorrow morning".
 *
 * It moves the time, not the rules — a draft agent stays asleep, every ceiling
 * still applies, and a slot brought forward is spent rather than added. The
 * reply says what actually happened, including who was left asleep and why,
 * because "started: true" for a floor of drafts is the reply that wastes an
 * afternoon.
 *
 * Hunts are a separate tick-box on purpose: standing work costs model tokens,
 * and a hunt starts an Apify capture and audits five businesses.
 */
function StartTheDay() {
  const queryClient = useQueryClient();
  const [withHunts, setWithHunts] = useState(false);
  const [result, setResult] = useState<DayStarted | null>(null);

  const start = useMutation({
    mutationFn: () => api.post<DayStarted>("/agents/start-the-day", { hunts: withHunts }),
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["agent-tasks"] });
    },
  });

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted" title="A hunt starts an Apify capture and audits five businesses. That costs money.">
          <input type="checkbox" checked={withHunts} onChange={(event) => setWithHunts(event.target.checked)} />
          hunts too
        </label>
        <Button variant="accent" disabled={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? "Starting…" : "Run agents now"}
        </Button>
      </div>

      {(result || start.error) && (
        <div className="rounded-xl absolute right-0 z-10 mt-2 w-80 border border-line bg-white p-3 text-sm shadow-lg">
          {start.error ? (
            <p className="text-danger-text">{(start.error as Error).message}</p>
          ) : (
            <p className="text-ink">{result?.summary}</p>
          )}
          <button className="mt-2 text-xs text-muted hover:text-ink" onClick={() => setResult(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
