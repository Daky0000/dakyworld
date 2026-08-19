import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, api, apiUrl } from "../lib/api";
import { AUDIT_DISCIPLINE_NAMES, type AuditDisciplineReport, type AuditFindingDetail, type Lead, type WebsiteAudit } from "../lib/types";
import { Badge, Button, RelativeTime } from "./ui";

/**
 * The website audit team, on the lead.
 *
 * Four reviewers go over one site — UI/UX, speed and findability, content,
 * security — and this is where their answer lands: one score, four sections,
 * the homepage with the problems drawn on it, and the two files. The PDF is
 * the thing to read; the Markdown is what the cold lead writer argues from.
 *
 * The picture is here rather than only in the PDF for the same reason the
 * screenshot is on the scan: it is the fastest way for a person to *disagree*
 * with the review. One glance says whether the box round the hero is fair, and
 * a founder who can overrule the model in a second trusts the parts they do
 * not overrule.
 */
export function LeadAuditSection({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const audits = lead.websiteAudits ?? [];
  const latest = audits[0] ?? null;

  const run = useMutation({
    mutationFn: () => api.post<{ auditId: string }>("/audits/run", { leadId: lead.id }),
    onMutate: () => setError(null),
    onSuccess: onDone,
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : "The review did not finish"),
  });

  return (
    <section>
      <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">Website review</h3>

      {!latest ? (
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-sm text-ink/60">
            Four reviewers go over their site — <strong>UI/UX</strong>, <strong>speed and findability</strong>, <strong>content</strong> and{" "}
            <strong>security</strong> — and what they find is compiled into one report: a PDF to read, and a Markdown copy the email is
            written from. The homepage comes back with the design problems boxed and numbered on it.
          </p>
          <p className="mt-2 text-[11px] text-ink/45">
            Slow, and it spends: two screenshots and three model calls. It runs on its own whenever you look at a business, so this button is
            for a second opinion after something has changed.
          </p>
          {!lead.website && (
            <p className="mt-2 text-[11px] text-amber-900">
              There is no website on this lead, so there is nothing to review. For a business with no site at all that absence is the whole
              argument — build them a demo page instead.
            </p>
          )}
          <div className="mt-3">
            <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending || !lead.website}>
              {run.isPending ? "Reviewing…" : "Run the audit team"}
            </Button>
          </div>
          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        </div>
      ) : (
        <AuditDetail auditId={latest.id} olderCount={audits.length - 1} onRunAgain={() => run.mutate()} pending={run.isPending} error={error} />
      )}
    </section>
  );
}

function AuditDetail({
  auditId,
  olderCount,
  onRunAgain,
  pending,
  error,
}: {
  auditId: string;
  olderCount: number;
  onRunAgain: () => void;
  pending: boolean;
  error: string | null;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["audit", auditId],
    queryFn: () => api.get<WebsiteAudit>(`/audits/${auditId}`),
  });

  if (isLoading) return <div className="rounded-2xl border border-line bg-white p-4 text-sm text-ink/50">Reading the review…</div>;
  if (!data) return <div className="rounded-2xl border border-line bg-white p-4 text-sm text-ink/50">The review could not be read.</div>;

  const report = data.report;
  const shots = data.screenshots ?? [];
  // The same rule the PDF and the Markdown apply: a number is shown only when
  // enough of the site was examined to mean one. Rows written before that gate
  // existed carry no flag, and are read under the rule in force when they were
  // written rather than judged by a newer one.
  const scored = report.scored ?? report.disciplines.some((discipline) => discipline.scored);

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-line bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-3xl leading-none text-ink">{scored ? data.overallScore : "—"}</span>
              {scored && <span className="font-mono text-xs text-ink/40">/100</span>}
              <span className="ml-1 text-sm font-semibold text-ink">{scored ? data.verdict : "Not scored"}</span>
            </div>
            {!scored && <p className="mt-1 text-[11px] text-ink/45">Too little of the site could be examined to put one number on it. The sections below are what did run.</p>}
            <p className="mt-1 text-[11px] text-ink/45">
              {data.website ?? "no address"} · reviewed <RelativeTime value={data.ranAt} />
              {olderCount > 0 && ` · ${olderCount} earlier review${olderCount === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.pdfFileId && (
              <a
                className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:border-blue hover:text-blue"
                href={apiUrl(`/audits/${data.id}/pdf`)}
                target="_blank"
                rel="noreferrer"
              >
                Open the PDF
              </a>
            )}
            <a
              className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:border-blue hover:text-blue"
              href={apiUrl(`/audits/${data.id}/markdown`)}
              target="_blank"
              rel="noreferrer"
            >
              Markdown
            </a>
            <Button size="sm" variant="ghost" onClick={onRunAgain} disabled={pending}>
              {pending ? "Reviewing…" : "Review again"}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {report.disciplines.map((discipline) => (
            <div key={discipline.discipline}>
              <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">{AUDIT_DISCIPLINE_NAMES[discipline.discipline]}</p>
              <p className="mt-0.5 font-mono text-lg leading-none text-ink">{discipline.scored ? discipline.score : "—"}</p>
              <span className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
                {/* An empty track for a section that did not run. A full bar over
                    "nobody read the writing" is a number contradicting a sentence. */}
                {discipline.scored && (
                  <span
                    className={`block h-full rounded-full ${discipline.score >= 70 ? "bg-lime" : discipline.score >= 40 ? "bg-blue" : "bg-ink/60"}`}
                    style={{ width: `${Math.max(4, discipline.score)}%` }}
                  />
                )}
              </span>
              <p className="mt-1 text-[10px] text-ink/40">{discipline.reviewer}</p>
            </div>
          ))}
        </div>

        {report.synthesis && (
          <>
            <p className="mt-4 whitespace-pre-line text-sm text-ink/70">{report.synthesis.executiveSummary}</p>
            <div className="mt-3 rounded-xl border border-blue/25 bg-blue/5 p-3">
              <p className="font-mono text-[10px] uppercase tracking-[.12em] text-blue">Do this first</p>
              <p className="mt-1 text-sm text-ink/80">{report.synthesis.theOneThing}</p>
            </div>
          </>
        )}

        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      </div>

      {shots.length > 0 && (
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">Their homepage, marked up</p>
          <p className="mt-1 text-[11px] text-ink/45">
            The numbered boxes mark roughly where each UI/UX point applies — the area, not the pixel. Open one to see it full size.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {shots
              .filter((shot) => shot.annotated)
              .concat(shots.filter((shot) => shot.annotated).length ? [] : shots)
              .map((shot) => (
                <a
                  key={`${shot.view}-${String(shot.annotated)}`}
                  href={apiUrl(`/audits/${data.id}/screenshot/${shot.view}${shot.annotated ? "-marked" : ""}.png`)}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-xl border border-line transition hover:border-blue"
                >
                  <img
                    src={apiUrl(`/audits/${data.id}/screenshot/${shot.view}${shot.annotated ? "-marked" : ""}.png`)}
                    alt={`${shot.view === "mobile" ? "Phone" : "Desktop"} view of the homepage`}
                    className="block max-h-64 w-full object-cover object-top"
                  />
                  <p className="border-t border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">
                    {shot.view === "mobile" ? "On a phone" : "On a desktop"}
                  </p>
                </a>
              ))}
          </div>
        </div>
      )}

      {report.disciplines.map((discipline) => (
        <DisciplineCard key={discipline.discipline} discipline={discipline} />
      ))}

      {report.notes.length > 0 && (
        <details className="rounded-2xl border border-line bg-white">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink">What this review did not check</summary>
          <div className="border-t border-line px-4 py-3">
            <p className="mb-2 text-[11px] text-ink/45">
              None of this is a fault, and none of it may be written to them as one. A check that did not run is not a finding.
            </p>
            <ul className="space-y-1 text-sm text-ink/60">
              {report.notes.map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
          </div>
        </details>
      )}

      {report.synthesis && (
        <details className="rounded-2xl border border-amber-200 bg-amber-50/60">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-amber-900">The brief for the email — internal</summary>
          <div className="space-y-2 border-t border-amber-200 px-4 py-3 text-sm text-ink/75">
            <p>
              <span className="font-semibold">Open on:</span> {report.synthesis.emailBrief.openOn}
            </p>
            <p>
              <span className="font-semibold">What it costs them:</span> {report.synthesis.emailBrief.consequence}
            </p>
            <p>
              <span className="font-semibold">The ask:</span>{" "}
              {report.synthesis.emailBrief.ask === "DEMO"
                ? "offer to build them a demo page"
                : report.synthesis.emailBrief.ask === "FIX"
                  ? "offer the fix and ask for fifteen minutes"
                  : "write nothing — there is no honest case here"}{" "}
              — {report.synthesis.emailBrief.whyThatAsk}
            </p>
            {report.synthesis.emailBrief.doNotSay.length > 0 && (
              <div>
                <p className="font-semibold">Do not claim:</p>
                <ul className="mt-1 space-y-1">
                  {report.synthesis.emailBrief.doNotSay.map((entry) => (
                    <li key={entry}>· {entry}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function DisciplineCard({ discipline }: { discipline: AuditDisciplineReport }) {
  const problems = discipline.findings.filter((finding) => finding.severity !== "GOOD");
  const good = discipline.findings.filter((finding) => finding.severity === "GOOD");

  return (
    <details className="rounded-2xl border border-line bg-white">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3">
        <span className="text-sm font-semibold text-ink">{AUDIT_DISCIPLINE_NAMES[discipline.discipline]}</span>
        <span className="font-mono text-xs text-ink/40">{discipline.scored ? `${discipline.score}/100` : "not scored"}</span>
        <span className="flex-1 truncate text-sm text-ink/55">{discipline.headline}</span>
        {problems.length > 0 && <Badge tone="muted">{problems.length}</Badge>}
      </summary>
      <div className="space-y-3 border-t border-line px-4 py-3">
        <p className="text-[11px] text-ink/40">
          Reviewed by the {discipline.reviewer} · {discipline.reviewedBy}
        </p>
        {!discipline.scored && (
          <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
            This section did not run, so it has no score and is left out of the overall. What follows is only what could be counted.
          </p>
        )}
        <p className="whitespace-pre-line text-sm text-ink/70">{discipline.summary}</p>

        {problems.map((finding) => (
          <FindingRow key={finding.id} finding={finding} />
        ))}

        {good.length > 0 && (
          <div className="rounded-xl border border-lime/40 bg-lime/10 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">What is right here</p>
            <ul className="mt-1.5 space-y-1 text-sm text-ink/70">
              {good.map((finding) => (
                <li key={finding.id}>
                  <span className="font-semibold">{finding.title}.</span> {finding.observed}
                </li>
              ))}
            </ul>
          </div>
        )}

        {discipline.checked.length > 0 && (
          <details>
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">What was examined</summary>
            <ul className="mt-1.5 space-y-1 text-[12px] text-ink/55">
              {discipline.checked.map((entry) => (
                <li key={entry}>· {entry}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-ink/35">Anything not on this list was not examined, which is not the same as it being sound.</p>
          </details>
        )}
      </div>
    </details>
  );
}

/**
 * Severity is carried by weight rather than by colour temperature: the brand
 * has no red, and amber is the warning state everywhere in this UI.
 */
function severityTone(severity: AuditFindingDetail["severity"]): "default" | "warn" | "muted" | "positive" {
  if (severity === "CRITICAL" || severity === "HIGH") return "default";
  if (severity === "GOOD") return "positive";
  return "muted";
}

function FindingRow({ finding }: { finding: AuditFindingDetail }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={severityTone(finding.severity)}>{finding.severity === "LOW" ? "MINOR" : finding.severity}</Badge>
        <span className="text-sm font-semibold text-ink">{finding.title}</span>
        {finding.marker != null && <span className="font-mono text-[10px] text-ink/40">box {finding.marker}</span>}
      </div>
      <p className="mt-1.5 text-sm text-ink/70">{finding.observed}</p>
      <p className="mt-1.5 text-sm text-ink/55">
        <span className="font-semibold text-ink/70">What it costs them.</span> {finding.impact}
      </p>
      <p className="mt-1.5 rounded-lg bg-ink/5 px-2.5 py-1.5 text-sm text-ink/75">
        <span className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">Say it like this</span>
        <br />
        {finding.plainly}
      </p>
      {finding.recommendation && (
        <p className="mt-1.5 text-sm text-ink/55">
          <span className="font-semibold text-ink/70">The fix.</span> {finding.recommendation}
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-ink/35">{finding.evidence}</p>
    </div>
  );
}
