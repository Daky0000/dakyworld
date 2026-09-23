import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ActionRequestRow, ActionRequestStatus } from "../lib/types";
import { Badge, Button, EmptyState, PageHeader, RelativeTime, StatGrid, StatTile } from "../components/ui";

/**
 * What the agents want to do, and what you have said about it.
 *
 * An agent below autonomy 3 — which is all of them, until you decide otherwise
 * — cannot send an email, spend money or touch anything outside the company. It
 * prepares the action instead, and the preparation lands here.
 *
 * **Approving carries it out.** That sentence is the whole feature. Until this
 * screen existed, approving a task marked it done and the prepared letter was
 * never sent, so "approve" meant "I have read this" and the work still had to
 * be done again by hand. Now the exact call the agent prepared — the same
 * validated input, not a second guess at it — is made when you say yes.
 *
 * Every card carries three things the agent had to state before it was allowed
 * to propose anything: why, what we gain, and what the risk is. They are
 * required fields on the tool call itself rather than a request in a prompt,
 * because a model cannot forget a required field.
 */

const STATUS_LABEL: Record<ActionRequestStatus, string> = {
  PENDING: "Waiting on you",
  APPROVED: "Approved",
  EXECUTED: "Done",
  FAILED: "Failed",
  DECLINED: "Declined",
  EXPIRED: "Expired",
};

const STATUS_TONE: Record<ActionRequestStatus, "default" | "positive" | "muted" | "warn"> = {
  PENDING: "default",
  APPROVED: "default",
  EXECUTED: "positive",
  FAILED: "warn",
  DECLINED: "muted",
  EXPIRED: "muted",
};

const FILTERS: Array<{ value: ActionRequestStatus | "ALL"; label: string }> = [
  { value: "PENDING", label: "Waiting" },
  { value: "EXECUTED", label: "Done" },
  { value: "DECLINED", label: "Declined" },
  { value: "FAILED", label: "Failed" },
  { value: "ALL", label: "Everything" },
];

export function Approvals() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<ActionRequestStatus | "ALL">("PENDING");

  const { data, isLoading } = useQuery({
    queryKey: ["approvals", filter],
    queryFn: () => api.get<{ requests: ActionRequestRow[]; pending: number; counts: Record<string, number> }>(`/approvals?status=${filter}`),
    // These arrive while you are looking at the page — an agent working in the
    // background is the normal case, not the exception.
    refetchInterval: 20_000,
  });

  const requests = data?.requests ?? [];

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Actions the agents have prepared and cannot carry out on their own. Approving one carries it out exactly as prepared — it does not ask the agent to do it again."
      />

      {data && (
        <div className="mb-6">
          <StatGrid columns={4}>
            <StatTile label="Waiting on you" value={data.pending} sub="actions paused at the gate" />
            <StatTile label="Carried out" value={data.counts?.EXECUTED ?? 0} sub="approved and executed" />
            <StatTile label="Declined" value={data.counts?.DECLINED ?? 0} sub="refused by you" />
            <StatTile label="Failed" value={data.counts?.FAILED ?? 0} sub="errored during execution" />
          </StatGrid>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            className={`rounded-full px-3 py-1 font-sans text-[11px] uppercase tracking-[.06em] transition active:scale-[0.96] ${
              filter === option.value
                ? "bg-ink font-semibold text-cream shadow-sm"
                : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
            }`}
          >
            {option.label}
            {option.value === "PENDING" && data?.pending ? ` (${data.pending})` : ""}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-muted">Reading the queue…</p>}

      {!isLoading && requests.length === 0 && (
        <EmptyState
          message={
            filter === "PENDING"
              ? "Nothing is waiting on you. When an agent prepares something that leaves the company or spends money, it appears here with its reasoning — nothing outward-facing happens without passing through this screen."
              : "Nothing here. Try another filter."
          }
        />
      )}

      <div className="space-y-4">
        {requests.map((request) => (
          <ApprovalCard key={request.id} request={request} onSettled={() => void qc.invalidateQueries({ queryKey: ["approvals"] })} />
        ))}
      </div>
    </div>
  );
}

function ApprovalCard({ request, onSettled }: { request: ActionRequestRow; onSettled: () => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: (verdict: "approve" | "decline") =>
      api.post<{ outcome: string }>(`/approvals/${request.id}/${verdict}`, { note: note.trim() || undefined }),
    onSuccess: (result) => {
      setError(null);
      setOutcome(result.outcome);
      onSettled();
    },
    onError: (err: Error) => setError(err.message),
  });

  const settled = request.status !== "PENDING";

  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-white  transition-all duration-200  hover:border-ink/20 hover:border-line-strong">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-cream/30 px-5 py-3.5">
        <span className="font-sans text-[11px] font-bold uppercase tracking-[.06em] text-ink">

          {request.agent.name}
        </span>
        <span className="font-semibold text-sm text-ink">{request.toolName}</span>
        {request.spends && (
          <Badge tone="warn">costs money</Badge>
        )}
        <Badge tone={STATUS_TONE[request.status]}>{STATUS_LABEL[request.status]}</Badge>
        <span className="flex-1" />
        {request.about && (
          <span className="rounded-full border border-line bg-white px-2.5 py-0.5 font-sans text-[11px] uppercase tracking-[.06em] text-muted">
            {request.about.name}
          </span>
        )}
        <span className="font-mono text-[11px] text-muted">
          <RelativeTime value={request.createdAt} />
        </span>
      </header>

      <div className="space-y-4 p-5">
        <div className="rounded-xl border border-line/60 bg-cream/40 p-3.5">
          <p className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">It would</p>
          <p className="mt-1 text-sm font-medium leading-relaxed text-ink">{request.wouldDo}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Reason label="Why" text={request.why} />
          <Reason label="What we gain" text={request.gain} />
          <Reason label="Risk" text={request.risk} />
        </div>

        {request.taskTitle && (
          <p className="text-[11px] text-muted">
            Prepared while working on <span className="font-medium text-ink">{request.taskTitle}</span>
            {request.heldBecause ? ` · ${request.heldBecause}` : ""}
          </p>
        )}

        {request.status === "EXECUTED" && (
          <p className="font-mono text-[11px] text-muted">
            Cost <span className="font-semibold text-ink">${Number(request.costUsd).toFixed(4)}</span>
          </p>
        )}

        {request.expired && request.status === "PENDING" && (
          <p className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
            This was prepared more than a week ago, so it can no longer be carried out. What the agent proposed then may not be
            right now — ask it to look again.
          </p>
        )}

        {request.error && (
          <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{request.error}</p>
        )}
        {error && <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{error}</p>}
        {outcome && <p className="rounded-xl border border-positive-line bg-positive-surface px-3.5 py-2.5 text-sm text-positive-text">{outcome}</p>}

        {!settled && !request.expired && (
          <div className="space-y-3 border-t border-line pt-3">
            <input
              className="input"
              placeholder="A note about your decision, if you want one on the record"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="accent" disabled={decide.isPending} onClick={() => decide.mutate("approve")}>
                {decide.isPending ? "Working…" : "Approve — do it"}
              </Button>
              <button
                type="button"
                disabled={decide.isPending}
                onClick={() => decide.mutate("decline")}
                className="font-sans text-[11px] uppercase tracking-[.06em] text-danger-text/70 transition hover:text-danger-text"
              >
                Decline
              </button>
              <span className="flex-1" />
              <span className="text-[11px] text-muted">Nothing has happened yet.</span>
            </div>
          </div>
        )}

        {settled && request.decisionNote && (
          <p className="border-t border-line pt-3 text-[11px] text-muted">Your note: {request.decisionNote}</p>
        )}
      </div>
    </article>
  );
}

function Reason({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-xl border border-line/60 bg-cream/30 p-3">
      <p className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">{label}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink">{text}</p>
    </div>
  );
}
