import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import type { Proposal } from "../lib/types";
import { Badge, Button, Card, EmptyState, Money, PageHeader, Table } from "../components/ui";

export function Proposals() {
  const qc = useQueryClient();
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
  const generatePdf = useMutation({
    mutationFn: (id: string) => api.post<Proposal>(`/proposals/${id}/generate-pdf`),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["proposals"] });
      if (updated?.pdfUrl) window.open(updated.pdfUrl, "_blank");
    },
  });

  return (
    <div>
      <PageHeader title="Proposal & Negotiation" subtitle="Generate, track, and close proposals — the middle of the funnel." />

      {isLoading ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : !proposals || proposals.length === 0 ? (
        <EmptyState message="No proposals yet. Create one from a lead's detail, or via the API." />
      ) : (
        <div className="space-y-4">
          {proposals.map((p) => (
            <Card key={p.id}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-serif text-lg">{p.title}</h3>
                    <StatusBadge status={p.status} />
                  </div>
                  <div className="mt-1 text-sm text-ink/60">
                    {p.client?.name ?? p.lead?.contactName ?? "Unassigned"} · {p.serviceType}
                  </div>
                  <div className="mt-2 text-sm">
                    <Money amount={p.priceAmount} currency={p.currency} />
                    {p.priceTier && <span className="text-ink/50"> · {p.priceTier}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => generatePdf.mutate(p.id)}>
                    PDF
                  </Button>
                  {p.status === "DRAFT" && (
                    <Button variant="secondary" onClick={() => send.mutate(p.id)}>
                      Send
                    </Button>
                  )}
                  {(p.status === "SENT" || p.status === "VIEWED") && (
                    <>
                      <Button onClick={() => accept.mutate(p.id)}>Accept → Project</Button>
                      <Button variant="secondary" onClick={() => reject.mutate(p.id)}>
                        Reject
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === "WON" ? "gold" : status === "LOST" ? "muted" : "default";
  return <Badge tone={tone}>{status}</Badge>;
}
