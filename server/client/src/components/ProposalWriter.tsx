import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postForBlob } from "../lib/api";
import type { AuditFinding, CompanyAudit, Lead, Proposal, ProposalDraftResponse } from "../lib/types";
import { Badge, Button, Drawer, Field } from "./ui";

/**
 * Drafting a proposal about one specific company.
 *
 * The screen is arranged around the thing that makes the proposal worth
 * sending: the evidence. What was actually observed sits above the argument
 * built on it, each finding beside the URL or DNS record it came from, so the
 * Owner can check a claim in ten seconds rather than take it on trust. A
 * proposal that asserts something false about a prospect's website is worse
 * than no proposal, and the only defence is that a person looked first.
 *
 * Nothing here saves on its own. The draft is read, the price is set by the
 * Owner — the writer may only quote published prices — and then it becomes an
 * ordinary proposal that the existing PDF and email flow can carry.
 */

type Stage = "setup" | "review";

const SEVERITY_TONE: Record<AuditFinding["severity"], string> = {
  CRITICAL: "border-danger-line bg-danger-surface text-danger-text",
  HIGH: "border-warn-line bg-warn-surface text-warn-text",
  MEDIUM: "border-line-strong bg-cream text-ink",
  LOW: "border-line bg-white text-muted",
  GOOD: "border-positive-line bg-positive-surface text-positive-text",
};

export function ProposalWriter({
  open,
  lead,
  onClose,
}: {
  open: boolean;
  /** Pre-selected when opened from a lead; otherwise the Owner picks one. */
  lead?: Pick<Lead, "id" | "contactName" | "companyName" | "website"> | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>("setup");
  const [leadId, setLeadId] = useState<string>(lead?.id ?? "");
  const [search, setSearch] = useState("");
  const [brief, setBrief] = useState("");
  const [result, setResult] = useState<ProposalDraftResponse | null>(null);
  const [audit, setAudit] = useState<CompanyAudit | null>(null);

  // Editable before saving — the writer proposes, the Owner prices.
  const [title, setTitle] = useState("");
  const [serviceType, setServiceType] = useState("");
  const [price, setPrice] = useState(0);
  const [priceTier, setPriceTier] = useState("");

  useEffect(() => {
    if (!open) return;
    setStage("setup");
    setLeadId(lead?.id ?? "");
    setResult(null);
    setAudit(null);
    setBrief("");
  }, [open, lead?.id]);

  const { data: leads } = useQuery({
    queryKey: ["proposal-lead-picker", search],
    queryFn: () => api.get<{ items: Lead[] }>(`/leads?take=25${search ? `&q=${encodeURIComponent(search)}` : ""}`),
    enabled: open && !lead,
  });

  const check = useMutation({
    mutationFn: () => api.post<CompanyAudit>("/proposals/audit", { leadId }),
    onSuccess: setAudit,
  });

  const write = useMutation({
    mutationFn: () => api.post<ProposalDraftResponse>("/proposals/draft", { leadId, brief: brief.trim() || undefined }),
    onSuccess: (response) => {
      setResult(response);
      setAudit(response.audit);
      setTitle(response.draft.title);
      setServiceType(response.draft.serviceType);
      setPrice(response.draft.investment.total);
      setPriceTier("");
      setStage("review");
    },
  });

  /**
   * Renders the unsaved draft through the same renderer the saved proposal
   * uses, so the Owner can see the real document on the letterhead before
   * committing to it — rather than approving an HTML summary and finding out
   * what it looks like afterwards.
   */
  const preview = useMutation({
    mutationFn: async () => {
      if (!result) throw new Error("Nothing to preview");
      const blob = await postForBlob("/proposals/document/preview.pdf", {
        title,
        clientName: result.subject.companyName,
        serviceType,
        scopeSummary: result.draft.headline,
        priceAmount: price,
        currency: "GHS",
        priceTier: priceTier || null,
        body: result.draft,
      });
      return URL.createObjectURL(blob);
    },
    onSuccess: (url) => {
      window.open(url, "_blank", "noopener");
      // The tab has the bytes by now; holding the object URL only leaks memory.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });

  const save = useMutation({
    mutationFn: () => {
      if (!result) throw new Error("Nothing to save");
      const { draft, subject } = result;
      return api.post<Proposal>("/proposals", {
        leadId: subject.leadId,
        clientId: subject.clientId,
        title,
        serviceType,
        // The one-line summary the list view and older PDFs show; the full
        // argued document goes in `body`.
        scopeSummary: [draft.headline, ...draft.scope.map((phase) => `${phase.phase}: ${phase.deliverables.join(", ")}`)].join("\n\n"),
        priceAmount: price,
        priceTier: priceTier || undefined,
        currency: "GHS",
        body: draft,
        audit: result.audit,
        generatedBy: result.model,
        confidence: draft.confidence,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["proposals"] });
      onClose();
    },
  });

  const subjectName = lead?.companyName ?? lead?.contactName ?? result?.subject.companyName ?? "a company";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      wide
      title={stage === "setup" ? "Draft a proposal" : `Draft for ${subjectName}`}
      subtitle={
        stage === "setup"
          ? "Checks their site and their domain, then writes a proposal about what it finds"
          : `Written from ${result?.audit.findings.length ?? 0} observations · ${result?.model ?? ""}`
      }
      footer={
        stage === "setup" ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => write.mutate()} disabled={!leadId || write.isPending}>
              {write.isPending ? "Checking them and writing…" : "Check them and write it"}
            </Button>
            <Button variant="secondary" onClick={() => check.mutate()} disabled={!leadId || check.isPending}>
              {check.isPending ? "Checking…" : "Just check them"}
            </Button>
            {write.isPending && <span className="text-xs text-muted">Fetching their site, asking DNS, then drafting — up to a minute.</span>}
            {(write.error || check.error) && (
              <span className="text-xs text-danger-text">{((write.error ?? check.error) as Error).message}</span>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => save.mutate()} disabled={save.isPending || !title}>
              {save.isPending ? "Saving…" : "Save as a draft proposal"}
            </Button>
            <Button variant="secondary" onClick={() => preview.mutate()} disabled={preview.isPending}>
              {preview.isPending ? "Rendering…" : "Preview the document"}
            </Button>
            <Button variant="secondary" onClick={() => setStage("setup")}>
              Back
            </Button>
            <Button variant="ghost" onClick={() => write.mutate()} disabled={write.isPending}>
              {write.isPending ? "Rewriting…" : "Write it again"}
            </Button>
            {save.isError && <span className="text-xs text-danger-text">{(save.error as Error).message}</span>}
          </div>
        )
      }
    >
      {stage === "setup" ? (
        <div className="space-y-6">
          {!lead && (
            <section>
              <SectionTitle>Which business</SectionTitle>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search leads by name, company or city…"
                className="input mb-3"
              />
              <div className="max-h-72 overflow-y-auto rounded-2xl border border-line">
                {leads?.items.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setLeadId(entry.id)}
                    className={`flex w-full items-baseline justify-between gap-3 border-b border-line px-3 py-2 text-left text-sm transition last:border-0 ${
                      leadId === entry.id ? "bg-ink text-cream" : "hover:bg-cream"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{entry.companyName ?? entry.contactName}</span>
                      <span className={`block truncate text-xs ${leadId === entry.id ? "text-cream/60" : "text-muted"}`}>
                        {entry.website ?? "no website"} · {entry.city ?? "no city"}
                      </span>
                    </span>
                    <span className={`shrink-0 font-mono text-[10px] ${leadId === entry.id ? "text-cream/60" : "text-muted"}`}>
                      {entry.leadScore}
                    </span>
                  </button>
                ))}
                {leads?.items.length === 0 && <p className="px-3 py-4 text-sm text-muted">No leads match that.</p>}
              </div>
            </section>
          )}

          <section>
            <SectionTitle>Anything you want it to lead with</SectionTitle>
            <p className="mb-2 text-xs text-muted">
              Optional. Use it when you know something the check can&rsquo;t see — what they said on a call, a budget, a deadline.
              It overrides the writer&rsquo;s own judgement on angle and scope.
            </p>
            <textarea
              rows={3}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="They mentioned losing bookings at weekends. Keep it to the website and email — no automation yet."
              className="input"
            />
          </section>

          {audit && !result && <AuditPanel audit={audit} />}
        </div>
      ) : (
        result && <Review result={result} title={title} setTitle={setTitle} serviceType={serviceType} setServiceType={setServiceType} price={price} setPrice={setPrice} priceTier={priceTier} setPriceTier={setPriceTier} />
      )}
    </Drawer>
  );
}

// --- Evidence --------------------------------------------------------------

function AuditPanel({ audit }: { audit: CompanyAudit }) {
  return (
    <section>
      <SectionTitle>What we can see about them</SectionTitle>
      {audit.site && (
        <p className="mb-3 font-mono text-[11px] text-muted">
          {audit.site.reachable
            ? `${audit.site.finalUrl} · ${audit.site.status} · ${audit.site.responseMs}ms${audit.site.platform ? ` · ${audit.site.platform}` : ""}`
            : `${audit.site.requested} — did not load`}
        </p>
      )}
      <div className="grid gap-2">
        {audit.findings.map((finding) => (
          <div key={finding.id} className={`border px-3 py-2 text-sm ${SEVERITY_TONE[finding.severity]}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[9px] uppercase tracking-[.12em]">{finding.severity}</span>
              <span className="font-mono text-[9px] uppercase tracking-[.12em] opacity-60">{finding.area}</span>
            </div>
            <p className="mt-1">{finding.observed}</p>
            <p className="mt-1 font-mono text-[10px] opacity-70">{finding.evidence}</p>
          </div>
        ))}
        {audit.findings.length === 0 && (
          <p className="text-sm text-muted">
            Nothing specific found. Worth a call before writing anything — a proposal with no observations behind it is a brochure.
          </p>
        )}
      </div>
      {audit.notes.length > 0 && (
        <p className="mt-3 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-xs text-warn-text">{audit.notes.join(" ")}</p>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[.12em] text-muted">
          What was checked ({audit.checked.length})
        </summary>
        <ul className="mt-2 space-y-1 text-xs text-muted">
          {audit.checked.map((entry) => (
            <li key={entry}>· {entry}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

// --- The draft -------------------------------------------------------------

function Review({
  result,
  title,
  setTitle,
  serviceType,
  setServiceType,
  price,
  setPrice,
  priceTier,
  setPriceTier,
}: {
  result: ProposalDraftResponse;
  title: string;
  setTitle: (value: string) => void;
  serviceType: string;
  setServiceType: (value: string) => void;
  price: number;
  setPrice: (value: number) => void;
  priceTier: string;
  setPriceTier: (value: string) => void;
}) {
  const { draft } = result;
  const weak = draft.confidence < 0.55;

  return (
    <div className="space-y-8">
      {weak && (
        <p className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
          The writer rates its own confidence at {Math.round(draft.confidence * 100)}% — there wasn&rsquo;t much to go on. Have the
          call before sending this.
        </p>
      )}

      <section>
        <SectionTitle>The document</SectionTitle>
        <div className="rounded-2xl border border-line bg-white p-5">
          <h3 className="font-display text-xl leading-snug">{draft.headline}</h3>
          <p className="mt-3 whitespace-pre-wrap text-sm text-ink">{draft.situation}</p>

          <h4 className="mt-6 font-mono text-[10px] uppercase tracking-[.16em] text-muted">What we found</h4>
          <div className="mt-2 space-y-4">
            {draft.findings.map((finding, index) => (
              <div key={index} className="border-l-2 border-blue pl-3">
                <p className="font-medium">{finding.observed}</p>
                <p className="mt-1 text-sm text-ink">{finding.costsThem}</p>
                <p className="mt-1 font-mono text-[10px] text-muted">Checked: {finding.evidence}</p>
                <p className="mt-1 text-sm">
                  <span className="text-muted">What we would do: </span>
                  {finding.fix}
                </p>
              </div>
            ))}
          </div>

          <h4 className="mt-6 font-mono text-[10px] uppercase tracking-[.16em] text-muted">What they get</h4>
          <div className="mt-2 space-y-3">
            {draft.scope.map((phase, index) => (
              <div key={index}>
                <p className="font-medium">{phase.phase}</p>
                <ul className="mt-1 space-y-0.5 text-sm text-ink">
                  {phase.deliverables.map((item) => (
                    <li key={item}>· {item}</li>
                  ))}
                </ul>
                <p className="mt-1 text-sm italic text-muted">{phase.outcome}</p>
              </div>
            ))}
          </div>

          <h4 className="mt-6 font-mono text-[10px] uppercase tracking-[.16em] text-muted">Investment</h4>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {draft.investment.lineItems.map((item, index) => (
                <tr key={index} className="border-b border-line last:border-0">
                  <td className="py-1.5 pr-3">{item.description}</td>
                  <td className="py-1.5 text-right whitespace-nowrap">
                    {item.amount > 0 ? (
                      <>
                        GHS {item.amount.toLocaleString("en-GB")}
                        {item.billing === "MONTHLY" && <span className="text-muted">/mo</span>}
                        {!item.firm && <span className="ml-1 text-muted">est.</span>}
                      </>
                    ) : (
                      <span className="text-muted">after the call</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">{draft.investment.basis}</p>

          <h4 className="mt-6 font-mono text-[10px] uppercase tracking-[.16em] text-muted">Timeline</h4>
          <p className="mt-1 text-sm text-ink">{draft.timeline}</p>

          <h4 className="mt-6 font-mono text-[10px] uppercase tracking-[.16em] text-muted">Why Dakyworld</h4>
          <p className="mt-1 text-sm text-ink">{draft.whyUs}</p>

          {draft.assumptions.length > 0 && (
            <>
              <h4 className="mt-6 font-mono text-[10px] uppercase tracking-[.16em] text-muted">What this assumes</h4>
              <ul className="mt-1 space-y-0.5 text-sm text-muted">
                {draft.assumptions.map((entry) => (
                  <li key={entry}>· {entry}</li>
                ))}
              </ul>
            </>
          )}

          <p className="mt-6 border-t border-line pt-4 font-medium">{draft.nextStep}</p>
        </div>
      </section>

      {draft.thinFacts.length > 0 && (
        <section>
          <SectionTitle>Ask these on the call</SectionTitle>
          <p className="mb-2 text-xs text-muted">What the writer wanted to know and couldn&rsquo;t see from outside.</p>
          <ul className="space-y-1 text-sm text-ink">
            {draft.thinFacts.map((entry) => (
              <li key={entry}>· {entry}</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <SectionTitle>Before you save it</SectionTitle>
        <p className="mb-3 text-xs text-muted">
          The writer may only quote prices Dakyworld publishes, so anything it couldn&rsquo;t price is left at zero. The number
          that goes on the proposal is yours.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" full>
            <input value={title} onChange={(event) => setTitle(event.target.value)} className="input" />
          </Field>
          <Field label="Service">
            <input value={serviceType} onChange={(event) => setServiceType(event.target.value)} className="input" />
          </Field>
          <Field label="Price (GHS)" hint={draft.investment.totalIsFirm ? "From the published catalogue." : "Estimated — check this."}>
            <input type="number" min={0} value={price} onChange={(event) => setPrice(Number(event.target.value))} className="input" />
          </Field>
          <Field label="Tier" hint="Optional — Foundation, Growth, Transformation.">
            <input value={priceTier} onChange={(event) => setPriceTier(event.target.value)} className="input" />
          </Field>
        </div>
      </section>

      <AuditPanel audit={result.audit} />

      <details>
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[.12em] text-muted">
          Everything the writer was told ({result.facts.length} facts)
        </summary>
        <ul className="mt-2 space-y-1 text-xs text-muted">
          {result.facts.map((fact, index) => (
            <li key={index}>· {fact}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">
          It was told these are the only facts it may use. Anything in the draft that isn&rsquo;t traceable to this list or to the
          evidence above is a mistake worth reporting.
        </p>
      </details>

      <p className="text-xs text-muted">
        {result.usage.inputTokens.toLocaleString()} in / {result.usage.outputTokens.toLocaleString()} out ·{" "}
        <Badge tone="muted">confidence {Math.round(draft.confidence * 100)}%</Badge>
      </p>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[.16em] text-muted">{children}</h3>;
}
