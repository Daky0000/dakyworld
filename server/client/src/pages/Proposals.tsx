import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Proposal } from "../lib/types";
import { Badge, Button, Card, CopyButton, EmptyState, Loading, Money, PageHeader, StatGrid, StatTile } from "../components/ui";
import { EmailComposer, type ComposerTarget } from "../components/EmailComposer";
import { ProposalWriter } from "../components/ProposalWriter";
import { ProposalPreview } from "../components/ProposalPreview";

type StatusFilter = "ALL" | "DRAFT" | "SENT" | "VIEWED" | "WON" | "LOST";

export function Proposals() {
  const qc = useQueryClient();
  const [emailing, setEmailing] = useState<ComposerTarget | null>(null);
  const [writing, setWriting] = useState(false);
  const [previewing, setPreviewing] = useState<Proposal | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [search, setSearch] = useState("");

  const { data: proposals, isLoading } = useQuery({
    queryKey: ["proposals"],
    queryFn: () => api.get<Proposal[]>("/proposals"),
  });

  const send = useMutation({
    mutationFn: (id: string) => api.post(`/proposals/${id}/send`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proposals"] }),
  });
  const accept = useMutation({
    mutationFn: (id: string) => api.post(`/proposals/${id}/accept`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const reject = useMutation({
    mutationFn: (id: string) => api.post(`/proposals/${id}/reject`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proposals"] }),
  });

  const all = proposals ?? [];

  // Summary Metrics
  const stats = useMemo(() => {
    let pipelineValue = 0;
    let inFlightCount = 0;
    let wonValue = 0;
    let wonCount = 0;
    let lostCount = 0;

    for (const p of all) {
      const amt = Number(p.priceAmount) || 0;
      if (p.status === "WON") {
        wonCount++;
        wonValue += amt;
      } else if (p.status === "LOST") {
        lostCount++;
      } else {
        inFlightCount++;
        pipelineValue += amt;
      }
    }

    const closedTotal = wonCount + lostCount;
    const winRate = closedTotal > 0 ? Math.round((wonCount / closedTotal) * 100) : null;

    return {
      total: all.length,
      pipelineValue,
      inFlightCount,
      wonValue,
      wonCount,
      winRate,
    };
  }, [all]);

  // Filtered List
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((p) => {
      const clientName = p.client?.name ?? p.lead?.companyName ?? p.lead?.contactName ?? "";
      const matchSearch =
        !q ||
        p.title.toLowerCase().includes(q) ||
        clientName.toLowerCase().includes(q) ||
        p.serviceType.toLowerCase().includes(q);
      const matchStatus = statusFilter === "ALL" || p.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [all, search, statusFilter]);

  const currency = all[0]?.currency ?? "GHS";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Proposal & Negotiation"
        subtitle="Generate, track, and close commercial proposals — the high-conviction middle of the funnel."
        action={
          <Button variant="accent" onClick={() => setWriting(true)}>
            Draft a proposal
          </Button>
        }
      />

      {/* Metrics Seam Grid */}
      <StatGrid columns={4}>
        <StatTile
          label="Active Pipeline"
          value={<Money amount={stats.pipelineValue} currency={currency} />}
          sub={`${stats.inFlightCount} proposal${stats.inFlightCount === 1 ? "" : "s"} in negotiation`}
        />
        <StatTile
          label="In-Flight"
          value={stats.inFlightCount}
          sub="Drafted, sent, or viewed"
        />
        <StatTile
          label="Closed Revenue"
          value={<Money amount={stats.wonValue} currency={currency} />}
          sub={`${stats.wonCount} won deal${stats.wonCount === 1 ? "" : "s"}`}
        />
        <StatTile
          label="Win Rate"
          value={stats.winRate !== null ? `${stats.winRate}%` : "—"}
          sub={stats.winRate !== null ? "Closed proposals ratio" : "No closed proposals yet"}
        />
      </StatGrid>

      {/* Search and Status Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <input
            type="search"
            placeholder="Search by proposal, client, or service…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-line bg-white px-3.5 py-1.5 text-xs text-ink outline-none transition focus:border-blue focus:ring-2 focus:ring-blue/15"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(["ALL", "DRAFT", "SENT", "VIEWED", "WON", "LOST"] as const).map((st) => {
            const count = st === "ALL" ? all.length : all.filter((p) => p.status === st).length;
            const isActive = statusFilter === st;
            return (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition  ${
                  isActive
                    ? "bg-ink text-white"
                    : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
                }`}
              >
                <span>{st === "ALL" ? "All" : st.charAt(0) + st.slice(1).toLowerCase()}</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[11px] font-mono ${
                    isActive ? "bg-white/20 text-white" : "bg-sunken text-muted"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {isLoading ? (
        <Loading label="Loading proposals" rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          message={
            all.length === 0
              ? "No proposals yet. Pick a lead and the writer will check their site and their domain, then argue from what it finds."
              : "No proposals match your search or status filter."
          }
          action={all.length === 0 ? <Button onClick={() => setWriting(true)}>Draft your first proposal</Button> : undefined}
        />
      ) : (
        <div className="space-y-3.5">
          {filtered.map((p) => {
            const recipient = p.client?.name ?? p.lead?.companyName ?? p.lead?.contactName ?? "Unassigned";
            return (
              <Card key={p.id} interactive className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-base font-medium text-ink">{p.title}</h3>
                      <StatusBadge status={p.status} />
                      {p.body && (
                        <Badge tone="muted">
                          {p.body.findings.length} finding{p.body.findings.length === 1 ? "" : "s"}
                        </Badge>
                      )}
                      {p.confidence != null && p.confidence < 0.55 && (
                        <Badge tone="warn">low confidence</Badge>
                      )}
                    </div>

                    <div className="mt-1 text-xs text-muted">
                      <span className="font-semibold text-ink">{recipient}</span>
                      <span className="mx-1.5">·</span>
                      <span>{p.serviceType}</span>
                      {p.priceTier && (
                        <>
                          <span className="mx-1.5">·</span>
                          <span className="font-mono">{p.priceTier}</span>
                        </>
                      )}
                    </div>

                    <div className="mt-3 flex items-baseline gap-2">
                      <span className="font-display text-lg font-medium text-ink">
                        <Money amount={p.priceAmount} currency={p.currency} />
                      </span>
                      {p.scopeSummary && (
                        <span className="truncate text-xs text-muted max-w-lg">
                          — {p.scopeSummary}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setPreviewing(p)}>
                      Preview
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setEmailing({
                          clientId: p.client?.id,
                          leadId: p.client ? undefined : p.lead?.id,
                          purpose: "PROPOSAL_COVER",
                          proposalId: p.id,
                          attachments: [{ kind: "proposal", proposalId: p.id, name: `${p.title}.pdf` }],
                        })
                      }
                    >
                      Email
                    </Button>
                    {p.status === "DRAFT" && (
                      <Button variant="secondary" size="sm" onClick={() => send.mutate(p.id)} disabled={send.isPending}>
                        Send
                      </Button>
                    )}
                    {(p.status === "SENT" || p.status === "VIEWED") && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => accept.mutate(p.id)}
                          disabled={accept.isPending}
                        >
                          Accept → Project
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => reject.mutate(p.id)}
                          disabled={reject.isPending}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ProposalWriter open={writing} onClose={() => setWriting(false)} />
      <ProposalPreview proposal={previewing} open={previewing !== null} onClose={() => setPreviewing(null)} />
      <EmailComposer target={emailing} open={emailing !== null} onClose={() => setEmailing(null)} />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "WON"
      ? "positive"
      : status === "LOST"
      ? "danger"
      : status === "SENT" || status === "VIEWED"
      ? "info"
      : "muted";
  return <Badge tone={tone}>{status}</Badge>;
}
