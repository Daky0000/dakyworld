import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Card, EmptyState, Loading, PageHeader, RelativeTime, StatGrid, StatTile } from "../components/ui";

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
  const [filter, setFilter] = useState<string>("ALL");

  const { data, isLoading } = useQuery({
    queryKey: ["concepts"],
    queryFn: () => api.get<ListResponse>("/concepts?open=true"),
  });

  const setAuto = useMutation({
    mutationFn: (enabled: boolean) => api.post("/concepts/pilot/auto-redesign", { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["concepts"] }),
  });

  const concepts = data?.concepts ?? [];

  // Summary Metrics
  const stats = useMemo(() => {
    let needsReview = 0;
    let approved = 0;
    let inBuilding = 0;
    let failingChecks = 0;

    for (const c of concepts) {
      if (c.stage === "NEEDS_REVIEW" || c.stage === "PREVIEW_CHECKED") needsReview++;
      else if (c.stage === "APPROVED" || c.stage === "EMAIL_READY") approved++;
      else if (c.stage === "BUILDING") inBuilding++;
      if (c.checksPassed === false) failingChecks++;
    }

    return {
      total: concepts.length,
      needsReview,
      approved,
      inBuilding,
      failingChecks,
    };
  }, [concepts]);

  // Filtered concepts
  const filtered = useMemo(() => {
    if (filter === "ALL") return concepts;
    if (filter === "REVIEW") {
      return concepts.filter((c) => c.stage === "NEEDS_REVIEW" || c.stage === "PREVIEW_CHECKED");
    }
    if (filter === "APPROVED") {
      return concepts.filter((c) => c.stage === "APPROVED" || c.stage === "EMAIL_READY" || c.stage === "SENT");
    }
    if (filter === "BUILDING") {
      return concepts.filter((c) => c.stage === "BUILDING" || c.stage === "AUDIT_COMPLETE");
    }
    return concepts.filter((c) => c.stage === filter);
  }, [concepts, filter]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Concept Review"
        subtitle="Leads with a homepage concept in progress. Nothing here reaches a prospect until the page has been checked and the letter approved."
        action={
          <div className="flex items-center gap-2">
            <Badge tone={data?.autoRedesign ? "info" : "muted"}>
              {data?.autoRedesign ? "Auto Pilot On" : "Auto Pilot Off"}
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAuto.mutate(!data?.autoRedesign)}
              disabled={setAuto.isPending}
            >
              {data?.autoRedesign ? "Disable Auto Pilot" : "Enable Auto Pilot"}
            </Button>
          </div>
        }
      />

      {/* Metrics Seam Grid */}
      <StatGrid columns={4}>
        <StatTile
          label="In Concept Pipeline"
          value={stats.total}
          sub="Total active concept flows"
        />
        <StatTile
          label="Awaiting Human Review"
          value={stats.needsReview}
          sub={stats.needsReview > 0 ? "Requires page inspection" : "All current"}
        />
        <StatTile
          label="Ready to Send"
          value={stats.approved}
          sub="Approved & queued outreach"
        />
        <StatTile
          label="Automated QA Checks"
          value={stats.failingChecks > 0 ? `${stats.failingChecks} failing` : "100% passed"}
          sub={stats.failingChecks > 0 ? "Fix before approving" : "All previews verified"}
        />
      </StatGrid>

      {/* Status Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
        {[
          ["ALL", "All Concepts", concepts.length],
          ["REVIEW", "Needs Review", stats.needsReview],
          ["APPROVED", "Approved", stats.approved],
          ["BUILDING", "In Generation", stats.inBuilding],
        ].map(([key, label, count]) => {
          const isActive = filter === key;
          return (
            <button
              key={key as string}
              type="button"
              onClick={() => setFilter(key as string)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition  ${
                isActive
                  ? "bg-ink text-white"
                  : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
              }`}
            >
              <span>{label as string}</span>
              <span
                className={`rounded-full px-1.5 py-0.2 text-[11px] font-mono ${
                  isActive ? "bg-white/20 text-white" : "bg-sunken text-muted"
                }`}
              >
                {count as number}
              </span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <Loading label="Loading concept queue" rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState message="Nothing is currently part-way through the concept workflow." />
      ) : (
        <div className="space-y-3.5">
          {filtered.map((concept) => {
            const isExpanded = open === concept.leadId;
            return (
              <Card key={concept.id} interactive className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-base font-medium text-ink">
                        {concept.lead.companyName ?? concept.lead.contactName}
                      </h3>
                      <Badge tone={STAGE_TONE[concept.stage] ?? "default"}>
                        {STAGE_LABEL[concept.stage] ?? concept.stage}
                      </Badge>
                      <Badge tone="muted">{concept.kind === "REDESIGN" ? "Redesign" : "First site"}</Badge>
                      {concept.redesignScore !== null && (
                        <Badge tone="muted">{concept.redesignScore}/100 design score</Badge>
                      )}
                      {concept.sendUncertain && <Badge tone="danger">Send unresolved</Badge>}
                    </div>

                    {concept.reason && <p className="mt-1.5 text-xs text-muted max-w-3xl">{concept.reason}</p>}

                    <p className="mt-2 text-xs text-muted">
                      Updated <RelativeTime value={concept.updatedAt} />
                      {concept.checksPassed === false && (
                        <span className="text-danger font-semibold">
                          {" "}· {concept.checksFailed} automated check{concept.checksFailed === 1 ? "" : "s"} failing
                        </span>
                      )}
                      {concept.previewVersion !== null &&
                        concept.checkedVersion !== null &&
                        concept.previewVersion !== concept.checkedVersion && (
                          <span className="text-warn-text"> · rebuilt since checked</span>
                        )}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {concept.previewUrl && (
                      <a
                        href={concept.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink transition hover:border-ink/40 hover:bg-sunken"
                      >
                        Open Page
                      </a>
                    )}
                    <Button
                      size="sm"
                      variant={isExpanded ? "secondary" : "primary"}
                      onClick={() => setOpen(isExpanded ? null : concept.leadId)}
                    >
                      <span>{isExpanded ? "Close" : "Review Concept"}</span>

                    </Button>
                  </div>
                </div>

                {isExpanded && <ConceptDetail leadId={concept.leadId} />}
              </Card>
            );
          })}
        </div>
      )}
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

  if (isLoading || !data) return <p className="mt-4 text-xs text-muted">Loading detail…</p>;

  const allTicked = data.reviewerChecks.every((entry) => confirmed.includes(entry.id));

  return (
    <div className="mt-5 space-y-5 border-t border-line/60 pt-5">
      <div className="grid gap-5 md:grid-cols-2">
        <section className="rounded-xl border border-line/60 bg-sunken/40 p-4">
          <h4 className="font-display text-xs font-medium text-ink">What they have now</h4>
          {data.lead.website ? (
            <a className="mt-1 block text-xs text-blue underline" href={data.lead.website} target="_blank" rel="noreferrer">
              {data.lead.website}
            </a>
          ) : (
            <p className="mt-1 text-xs text-muted">No website on file — the concept is the whole argument.</p>
          )}
          {data.audit ? (
            <p className="mt-2 text-xs text-muted">
              Audited <RelativeTime value={data.audit.ranAt} />: <span className="font-semibold text-ink">{data.audit.overallScore}/100</span>, {data.audit.verdict}.
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted">No website review on file.</p>
          )}
        </section>

        <section className="rounded-xl border border-line/60 bg-sunken/40 p-4">
          <h4 className="font-display text-xs font-medium text-ink">The concept</h4>
          {data.preview ? (
            <div className="mt-1 text-xs text-muted">
              <a className="font-medium text-blue underline" href={data.preview.url} target="_blank" rel="noreferrer">
                {data.preview.url}
              </a>
              <div className="mt-1">
                Version {data.preview.version} · Opened {data.preview.views} time{data.preview.views === 1 ? "" : "s"}.
              </div>
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted">Nothing built yet.</p>
          )}
        </section>
      </div>

      <section className="rounded-xl border border-line/60 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="font-display text-xs font-medium text-ink">Automated QA Checks</h4>
          <Button size="sm" variant="secondary" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
            {recheck.isPending ? "Rechecking…" : "Run QA Recheck"}
          </Button>
        </div>
        {data.checks ? (
          <div className="space-y-2">
            {data.checks.checks.map((c) => (
              <div key={c.id} className="flex items-center justify-between text-xs">
                <span className={c.ok ? "text-ink" : "font-semibold text-danger"}>
                  {c.ok ? "Passed:" : "Needs review:"} {c.label}
                </span>
                {c.detail && <span className="text-muted font-mono text-[11px]">{c.detail}</span>}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">No checks recorded yet.</p>
        )}
      </section>

      <section className="rounded-xl border border-line bg-white p-4">
        <h4 className="font-display text-xs font-medium text-ink mb-2">Reviewer Checklist</h4>
        <div className="space-y-2">
          {data.reviewerChecks.map((rc) => {
            const isChecked = confirmed.includes(rc.id);
            return (
              <label key={rc.id} className="flex items-center gap-2 text-xs text-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={(e) => {
                    if (e.target.checked) setConfirmed([...confirmed, rc.id]);
                    else setConfirmed(confirmed.filter((id) => id !== rc.id));
                  }}
                  className="rounded"
                />
                <span>{rc.label}</span>
              </label>
            );
          })}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => review.mutate("pass")}
            disabled={!allTicked || review.isPending}
          >
            Sign off page
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => review.mutate("reject")}
            disabled={review.isPending}
          >
            Reject concept
          </Button>
          {data.concept.stage === "NEEDS_REVIEW" && (
            <Button
              size="sm"
              variant="accent"
              onClick={() => approve.mutate()}
              disabled={approve.isPending || !data.gate.ok}
            >
              Approve for Outreach
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
