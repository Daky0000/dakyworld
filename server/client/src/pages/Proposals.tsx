import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import type { Proposal } from "../lib/types";
import { Badge, Button, Card, EmptyState, Money, PageHeader } from "../components/ui";
import { EmailComposer, type ComposerTarget } from "../components/EmailComposer";
import { ProposalWriter } from "../components/ProposalWriter";
import { ProposalPreview } from "../components/ProposalPreview";

export function Proposals() {
  const qc = useQueryClient();
  const [emailing, setEmailing] = useState<ComposerTarget | null>(null);
  const [writing, setWriting] = useState(false);
  const [previewing, setPreviewing] = useState<Proposal | null>(null);
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

  return (
    <div>
      <PageHeader
        title="Proposal & Negotiation"
        subtitle="Generate, track, and close proposals — the middle of the funnel."
        action={<Button onClick={() => setWriting(true)}>Draft a proposal</Button>}
      />

      {isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : !proposals || proposals.length === 0 ? (
        <EmptyState
          message="No proposals yet. Pick a lead and the writer will check their site and their domain, then argue from what it finds."
          action={<Button onClick={() => setWriting(true)}>Draft your first proposal</Button>}
        />
      ) : (
        <div className="space-y-4">
          {proposals.map((p) => (
            <Card key={p.id}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-display text-lg">{p.title}</h3>
                    <StatusBadge status={p.status} />
                    {p.body && <Badge tone="muted">drafted from {p.body.findings.length} findings</Badge>}
                    {p.confidence != null && p.confidence < 0.55 && <Badge tone="muted">low confidence</Badge>}
                  </div>
                  <div className="mt-1 text-sm text-muted">
                    {p.client?.name ?? p.lead?.companyName ?? p.lead?.contactName ?? "Unassigned"} · {p.serviceType}
                  </div>
                  <div className="mt-2 text-sm">
                    <Money amount={p.priceAmount} currency={p.currency} />
                    {p.priceTier && <span className="text-muted"> · {p.priceTier}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button onClick={() => setPreviewing(p)}>Preview</Button>
                  {/* The proposal PDF renders at send time, so a change made
                      after the draft was written still reaches the client. */}
                  <Button
                    variant="secondary"
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

      <ProposalWriter open={writing} onClose={() => setWriting(false)} />
      <ProposalPreview proposal={previewing} open={previewing !== null} onClose={() => setPreviewing(null)} />
      <EmailComposer target={emailing} open={emailing !== null} onClose={() => setEmailing(null)} />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === "WON" ? "positive" : status === "LOST" ? "muted" : "default";
  return <Badge tone={tone}>{status}</Badge>;
}
