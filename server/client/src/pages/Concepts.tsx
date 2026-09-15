import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Card, EmptyState, PageHeader, RelativeTime } from "../components/ui";

/**
 * The review queue: every lead part-way through the concept workflow, and the
 * two decisions that let one move.
 *
 * The screen is built around the fact that **approving the page and approving
 * the outreach are different judgements**. The first is about a thing carrying
 * somebody else's business name — are these their services, does it claim
 * anything we cannot support, does it hold up on a phone. The second is about a
 * letter going to a person. One button standing for both would mean a page
 * signed off by somebody who never read the email.
 *
 * Nothing here can be ticked from the list. Both decisions open the lead's own
 * file first, because the only honest way to sign off a page is to have opened
 * it.
 */

interface ConceptRow {
  id: string;
  leadId: string;
  lead: { id: string; companyName: string | null; contactName: string; contactEmail: string | null; website: string | null; city: string | null };
  stage: string;
  kind: "NEW_SITE" | "REDESIGN";
  reason: string | null;
  redesignCall: string | null;
  redesignScore: number | null;
  previewUrl: string | null;
  previewVersion: number | null;
  checkedVersion: number | null;
  views: number;
  checksPassed: boolean | null;
  checksFailed: number | null;
  reviewedAt: string | null;
  approvedAt: string | null;
  proposalId: string | null;
  emailMessageId: string | null;
  sentAt: string | null;
  sendUncertain: boolean;
  updatedAt: string;
}

interface ReviewerCheck {
  id: string;
  label: string;
}

interface ListResponse {
  concepts: ConceptRow[];
  reviewerChecks: ReviewerCheck[];
  autoRedesign: boolean;
}

interface PreviewCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string | null;
}

interface DetailResponse {
  concept: ConceptRow & { reviewNotes: string | null; history: { stage: string; at: string; reason: string | null }[] };
  lead: { id: string; companyName: string | null; contactName: string; website: string | null };
  preview: { id: string; url: string; version: number; views: number; title: string } | null;
  audit: { id: string; overallScore: number; verdict: string; markdown: string; ranAt: string } | null;
  proposal: { id: string; title: string; priceAmount: string; currency: string; scopeSummary: string } | null;
  email: { id: string; subject: string; bodyHtml: string; toEmail: string; status: string } | null;
  checks: { passed: boolean; ranAt: string; checks: PreviewCheck[] } | null;
  reviewerChecks: ReviewerCheck[];
  gate: { ok: boolean; reason: string | null };
}

const STAGE_LABEL: Record<string, string> = {
  QUALIFIED: "Qualified",
  AUDIT_COMPLETE: "Audit complete",
  BUILDING: "Building",
  NEEDS_REVIEW: "Needs review",
  PREVIEW_CHECKED: "Preview checked",
  PROPOSAL_READY: "Proposal ready",
  EMAIL_READY: "Email ready",
  APPROVED: "Approved",
  SENDING: "Sending",
  SENT: "Sent",
  SKIPPED: "Skipped",
  FAILED: "Failed",
};

const STAGE_TONE: Record<string, "default" | "positive" | "muted" | "warn" | "danger" | "info"> = {
  NEEDS_REVIEW: "warn",
  PREVIEW_CHECKED: "info",
  APPROVED: "info",
  SENT: "positive",
  SKIPPED: "muted",
  FAILED: "danger",
  SENDING: "info",
};

export function Concepts() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["concepts"],
    queryFn: () => api.get<ListResponse>("/concepts?open=true"),
  });

  const setAuto = useMutation({
    mutationFn: (enabled: boolean) => api.post("/concepts/pilot/auto-redesign", { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["concepts"] }),
  });

  const concepts = data?.concepts ?? [];

  return (
    <div>
      <PageHeader
        title="Concept review"
        subtitle="Leads with a homepage concept in progress. Nothing here reaches a prospect until the page has been checked and the letter approved."
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge tone={data?.autoRedesign ? "info" : "muted"}>{data?.autoRedesign ? "Automatic redesigns on" : "Automatic redesigns off"}</Badge>
        <Button variant="secondary" size="sm" onClick={() => setAuto.mutate(!data?.autoRedesign)}>
          {data?.autoRedesign ? "Switch automatic redesigns off" : "Switch automatic redesigns on"}
        </Button>
        <p className="text-sm text-muted">
          While this is off, a lead with a poor site is recorded as eligible and left alone — pages are built by hand, one at a time.
        </p>
      </div>

      {isLoading ? <p className="text-sm text-muted">Loading…</p> : null}

      {!isLoading && concepts.length === 0 ? <EmptyState message="Nothing is part-way through the concept workflow." /> : null}

      <div className="space-y-3">
        {concepts.map((concept) => (
          <Card key={concept.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-base font-medium text-ink">{concept.lead.companyName ?? concept.lead.contactName}</h3>
                  <Badge tone={STAGE_TONE[concept.stage] ?? "default"}>{STAGE_LABEL[concept.stage] ?? concept.stage}</Badge>
                  <Badge tone="muted">{concept.kind === "REDESIGN" ? "Redesign" : "First site"}</Badge>
                  {concept.redesignScore !== null ? <Badge tone="muted">{concept.redesignScore}/100 on how it looks</Badge> : null}
                  {concept.sendUncertain ? <Badge tone="danger">Send unresolved</Badge> : null}
                </div>
                {concept.reason ? <p className="mt-2 max-w-3xl text-sm text-muted">{concept.reason}</p> : null}
                <p className="mt-2 text-xs text-muted">
                  Updated <RelativeTime value={concept.updatedAt} />
                  {concept.checksPassed === false ? ` · ${concept.checksFailed} automated check${concept.checksFailed === 1 ? "" : "s"} failing` : ""}
                  {concept.previewVersion !== null && concept.checkedVersion !== null && concept.previewVersion !== concept.checkedVersion
                    ? " · rebuilt since it was checked"
                    : ""}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {concept.previewUrl ? (
                  <a
                    className="rounded-full border border-line px-3 py-1.5 text-sm text-ink hover:bg-sunken"
                    href={concept.previewUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open the page
                  </a>
                ) : null}
                <Button size="sm" onClick={() => setOpen(open === concept.leadId ? null : concept.leadId)}>
                  {open === concept.leadId ? "Close" : "Review"}
                </Button>
              </div>
            </div>

            {open === concept.leadId ? <ConceptDetail leadId={concept.leadId} /> : null}
          </Card>
        ))}
      </div>
    </div>
  );
}

function ConceptDetail({ leadId }: { leadId: string }) {
  const qc = useQueryClient();
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [notes, setNotes] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["concept", leadId],
    queryFn: () => api.get<DetailResponse>(`/concepts/${leadId}`),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["concept", leadId] });
    void qc.invalidateQueries({ queryKey: ["concepts"] });
  };

  const recheck = useMutation({ mutationFn: () => api.post(`/concepts/${leadId}/recheck`, {}), onSuccess: invalidate });
  const review = useMutation({
    mutationFn: (decision: "pass" | "reject") => api.post(`/concepts/${leadId}/review`, { decision, confirmed, notes }),
    onSuccess: invalidate,
  });
  const approve = useMutation({
    mutationFn: () => api.post(`/concepts/${leadId}/approve`, { emailMessageId: data?.email?.id, proposalId: data?.proposal?.id }),
    onSuccess: invalidate,
  });

  if (isLoading || !data) return <p className="mt-4 text-sm text-muted">Loading…</p>;

  const allTicked = data.reviewerChecks.every((entry) => confirmed.includes(entry.id));

  return (
    <div className="mt-6 space-y-6 border-t border-line pt-6">
      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h4 className="mb-2 text-sm font-medium text-ink">What they have now</h4>
          {data.lead.website ? (
            <a className="text-sm text-ink underline" href={data.lead.website} target="_blank" rel="noreferrer">
              {data.lead.website}
            </a>
          ) : (
            <p className="text-sm text-muted">No website on file — the page is the whole argument.</p>
          )}
          {data.audit ? (
            <p className="mt-2 text-sm text-muted">
              Reviewed <RelativeTime value={data.audit.ranAt} />: {data.audit.overallScore}/100, {data.audit.verdict}.
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted">No website review on file.</p>
          )}
        </section>

        <section>
          <h4 className="mb-2 text-sm font-medium text-ink">The concept</h4>
          {data.preview ? (
            <p className="text-sm text-muted">
              <a className="text-ink underline" href={data.preview.url} target="_blank" rel="noreferrer">
                {data.preview.url}
              </a>
              {" — "}version {data.preview.version}, opened {data.preview.views} time{data.preview.views === 1 ? "" : "s"}.
            </p>
          ) : (
            <p className="text-sm text-muted">Nothing built yet.</p>
          )}
        </section>
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-medium text-ink">Automated checks</h4>
          <Button size="sm" variant="secondary" onClick={() => recheck.mutate()}>
            Run them again
          </Button>
        </div>
        {data.checks ? (
          <ul className="space-y-1">
            {data.checks.checks.map((entry) => (
              <li key={entry.id} className="text-sm">
                <span className={entry.ok ? "text-positive-text" : "text-danger-text"}>{entry.ok ? "✓" : "✗"}</span>{" "}
                <span className="text-ink">{entry.label}</span>
                {entry.detail ? <span className="text-muted"> — {entry.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Not checked yet.</p>
        )}
      </section>

      <section>
        <h4 className="mb-2 text-sm font-medium text-ink">What only you can check</h4>
        <ul className="space-y-2">
          {data.reviewerChecks.map((entry) => (
            <li key={entry.id} className="flex items-start gap-2 text-sm text-ink">
              <input
                id={`${leadId}-${entry.id}`}
                type="checkbox"
                className="mt-1"
                checked={confirmed.includes(entry.id)}
                onChange={(event) =>
                  setConfirmed((current) => (event.target.checked ? [...current, entry.id] : current.filter((id) => id !== entry.id)))
                }
              />
              <label htmlFor={`${leadId}-${entry.id}`}>{entry.label}</label>
            </li>
          ))}
        </ul>
        <textarea
          className="mt-3 w-full rounded-xl border border-line p-3 text-sm"
          rows={3}
          placeholder="Notes — required if you are sending it back."
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={!allTicked || !data.checks?.passed} onClick={() => review.mutate("pass")}>
            The page is fit to be seen
          </Button>
          <Button size="sm" variant="secondary" onClick={() => review.mutate("reject")}>
            Send it back
          </Button>
        </div>
        {!data.checks?.passed ? (
          <p className="mt-2 text-sm text-muted">The automated checks have to pass before the page can be signed off.</p>
        ) : null}
      </section>

      <section>
        <h4 className="mb-2 text-sm font-medium text-ink">The outreach</h4>
        {data.proposal ? (
          <p className="text-sm text-muted">
            Proposal: {data.proposal.title} — {data.proposal.currency} {data.proposal.priceAmount}
          </p>
        ) : (
          <p className="text-sm text-muted">No proposal attached.</p>
        )}
        {data.email ? (
          <div className="mt-2 rounded-xl border border-line p-3">
            <p className="text-sm text-ink">
              To {data.email.toEmail} — <strong>{data.email.subject}</strong>
            </p>
            <div className="mt-2 max-h-64 overflow-auto text-sm text-muted" dangerouslySetInnerHTML={{ __html: data.email.bodyHtml }} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">No letter drafted yet.</p>
        )}
        <div className="mt-3">
          <Button size="sm" variant="accent" disabled={!data.gate.ok || !data.email} onClick={() => approve.mutate()}>
            Approve this exact page, proposal and letter
          </Button>
        </div>
        {!data.gate.ok ? <p className="mt-2 text-sm text-muted">{data.gate.reason}</p> : null}
        <p className="mt-2 text-xs text-muted">
          Editing any of them afterwards voids this approval — the send compares what is about to go with what you signed off.
        </p>
      </section>

      <section>
        <h4 className="mb-2 text-sm font-medium text-ink">How it got here</h4>
        <ol className="space-y-1">
          {data.concept.history.map((entry, index) => (
            <li key={`${entry.stage}-${index}`} className="text-sm text-muted">
              <span className="text-ink">{STAGE_LABEL[entry.stage] ?? entry.stage}</span> · <RelativeTime value={entry.at} />
              {entry.reason ? ` — ${entry.reason}` : ""}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
