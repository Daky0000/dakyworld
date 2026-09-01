import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Card, EmptyState, RelativeTime } from "./ui";

/**
 * The workforce hiring itself, where a person can see it.
 *
 * Slack is the *convenient* place to answer a hiring card — it arrives on a
 * phone at the moment it matters, which is the whole reason the button exists.
 * It must not be the only place. A workspace nobody has connected, a signing
 * secret nobody has pasted, an app somebody removed: each would otherwise mean
 * the Agent Creator files proposals that nothing on earth can approve, and the
 * symptom would be an agent that appears not to work.
 *
 * The panel hides itself when there is nothing happening. A permanent empty
 * "Hiring" box on the roster is a box that stops being read, and then the day
 * it has something in it, it still is not read.
 */

interface HirePolicy {
  policy: "ASK" | "AUTO";
  pending: number;
  slackConnected: boolean;
  explanation: string;
  note?: string;
}

interface Overlap {
  key: string;
  name: string;
  score: number;
  shared: string[];
}

interface HireRequest {
  id: string;
  key: string;
  name: string;
  title: string;
  department: string;
  managerKey: string;
  mission: string;
  deliverable: string;
  skills: string[];
  toolkit: string[];
  rationale: string;
  overlaps: Overlap[];
  proposedByKey: string;
  createdAt: string;
}

interface Gap {
  id: string;
  skillNeeded: string;
  reason: string;
  timesRequested: number;
  status: string;
  createdAt: string;
}

export function AgentHiring() {
  const client = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);

  const policy = useQuery({ queryKey: ["hiring", "policy"], queryFn: () => api.get<HirePolicy>("/agents/hiring/policy") });
  const requests = useQuery({
    queryKey: ["hiring", "requests"],
    queryFn: () => api.get<{ requests: HireRequest[] }>("/agents/hiring/requests?status=PENDING"),
  });
  const gaps = useQuery({ queryKey: ["hiring", "gaps"], queryFn: () => api.get<{ gaps: Gap[] }>("/agents/hiring/gaps") });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["hiring"] });
    void client.invalidateQueries({ queryKey: ["agents"] });
  };

  const setPolicy = useMutation({
    mutationFn: (next: "ASK" | "AUTO") => api.put("/agents/hiring/policy", { policy: next }),
    onSuccess: refresh,
  });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "decline" }) => api.post(`/agents/hiring/requests/${id}/${action}`),
    onSuccess: refresh,
  });

  const waiting = requests.data?.requests ?? [];
  const openGaps = gaps.data?.gaps ?? [];
  const auto = policy.data?.policy === "AUTO";

  // Nothing to say, and no reason to take up the top of the screen saying it.
  if (waiting.length === 0 && openGaps.length === 0 && !auto) return null;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-mono text-[10px] uppercase tracking-[.16em] text-muted">Hiring</h2>
        <p className="mt-0.5 text-xs text-muted">
          When an agent hits work no craft here covers, it says so. The Agent Creator decides whether that needs somebody new.
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-xl">
            <div className="flex items-center gap-2">
              <span className="font-display text-lg tracking-[-.02em]">{auto ? "Hiring automatically" : "Asking you first"}</span>
              {auto && <Badge tone="warn">auto</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted">{policy.data?.explanation}</p>
            {policy.data?.note && <p className="mt-1 text-sm text-warn-text">{policy.data.note}</p>}
            {policy.data?.slackConnected && (
              <p className="mt-1 text-xs text-muted">
                Also answerable in Slack — the card carries the same buttons, and <code>/dakyworld hiring auto</code> changes this setting.
              </p>
            )}
          </div>
          <Button variant="secondary" onClick={() => setPolicy.mutate(auto ? "ASK" : "AUTO")} disabled={setPolicy.isPending}>
            {auto ? "Ask me first" : "Hire without asking"}
          </Button>
        </div>
      </Card>

      {waiting.map((request) => (
        <Card key={request.id}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-display text-lg tracking-[-.02em]">{request.name}</span>
                <code className="font-mono text-[11px] text-muted">{request.key}</code>
                <Badge tone="muted">proposed by {request.proposedByKey}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted">{request.mission}</p>
              <p className="mt-1 text-sm text-muted">
                Produces: {request.deliverable} · reports to <code className="font-mono text-[11px]">{request.managerKey}</code>
              </p>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => decide.mutate({ id: request.id, action: "approve" })} disabled={decide.isPending}>
                Approve
              </Button>
              <Button variant="secondary" onClick={() => decide.mutate({ id: request.id, action: "decline" })} disabled={decide.isPending}>
                Decline
              </Button>
            </div>
          </div>

          {/* The one line that stops a roster becoming forty agents doing a
              third of each other's jobs. Loud on purpose. */}
          {request.overlaps.length > 0 && (
            <p className="mt-3 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
              Overlaps agents you already have:{" "}
              {request.overlaps.map((overlap) => `${overlap.name} (${Math.round(overlap.score * 100)}%)`).join(", ")}
            </p>
          )}

          <button type="button" className="mt-3 text-xs text-blue underline-offset-2 hover:underline" onClick={() => setOpen(open === request.id ? null : request.id)}>
            {open === request.id ? "Hide the argument" : "Why a new agent rather than existing work?"}
          </button>
          {open === request.id && (
            <div className="mt-2 space-y-2 border-t border-line pt-3 text-sm text-muted">
              <p>{request.rationale}</p>
              {request.skills.length > 0 && <p className="text-muted">Good at: {request.skills.join(", ")}</p>}
              <p className="text-muted">Asks for: {request.toolkit.length > 0 ? request.toolkit.join(", ") : "no tools"}</p>
              <p className="text-muted">
                Approving employs it at level 1 with dry run on — it prepares work and nothing it decides takes effect until you raise that.
              </p>
            </div>
          )}
        </Card>
      ))}

      {openGaps.length > 0 && (
        <Card>
          <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">Crafts nobody here has</p>
          <ul className="mt-2 space-y-2">
            {openGaps.map((gap) => (
              <li key={gap.id} className="text-sm">
                <span className="text-ink">{gap.skillNeeded}</span>{" "}
                <span className="text-muted">
                  — asked for by {gap.timesRequested} agent{gap.timesRequested === 1 ? "" : "s"} · {gap.status.toLowerCase().replace("_", " ")} ·{" "}
                  <RelativeTime value={gap.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {waiting.length === 0 && openGaps.length === 0 && auto && (
        <EmptyState message="No gaps open and nothing waiting. Anything the Agent Creator proposes will be hired as soon as it proposes it." />
      )}
    </section>
  );
}
