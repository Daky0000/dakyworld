import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, apiUrl } from "../lib/api";
import {
  AUDIT_DISCIPLINE_NAMES,
  type AuditDiscipline,
  type AuditDisciplineReport,
  type AuditFindingDetail,
  REDESIGN_ERA_NAMES,
  REDESIGN_NECESSITY_NAMES,
  REDESIGN_SEVERITY_NAMES,
  REDESIGN_WORTH_NAMES,
  normaliseRedesignCall,
  redesignCategoryName,
  redesignScoreBand,
  type Lead,
  type RedesignSeverity,
  type RedesignVerdict,
  type WebsiteAudit,
} from "../lib/types";
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
      <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[.16em] text-muted">Website review</h3>

      {!latest ? (
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-sm text-muted">
            Four reviewers go over their site — <strong>UI/UX</strong>, <strong>speed and findability</strong>, <strong>content</strong> and{" "}
            <strong>security</strong> — and what they find is compiled into one report: a PDF to read, and a Markdown copy the email is
            written from. The homepage comes back with the design problems boxed and numbered on it.
          </p>
          <p className="mt-2 text-[11px] text-muted">
            Slow, and it spends: two screenshots and three model calls. It runs on its own whenever you look at a business, so this button is
            for a second opinion after something has changed.
          </p>
          {!lead.website && (
            <p className="mt-2 text-[11px] text-warn-text">
              There is no website on this lead, so there is nothing to review. For a business with no site at all that absence is the whole
              argument — build them a demo page instead.
            </p>
          )}
          <div className="mt-3">
            <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending || !lead.website}>
              {run.isPending ? "Reviewing…" : "Run the audit team"}
            </Button>
          </div>
          {error && <p className="mt-3 text-sm text-danger-text">{error}</p>}
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
  const queryClient = useQueryClient();
  const [sectionError, setSectionError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["audit", auditId],
    queryFn: () => api.get<WebsiteAudit>(`/audits/${auditId}`),
  });

  /**
   * One reviewer, run again, into the same review.
   *
   * A section fails for reasons that are nothing to do with the site — no Apify
   * token when the pictures were due, no model that can look at one — and until
   * this existed the only way to fill that hole was to commission the whole
   * team again: four reviewers' worth of money to fix one, and three new
   * answers replacing three the Owner had already read.
   */
  const rerun = useMutation({
    mutationFn: (input: { discipline: AuditDiscipline; freshScreenshots?: boolean }) =>
      api.post<{ auditId: string }>(`/audits/${auditId}/rerun`, input),
    onMutate: () => setSectionError(null),
    // The review keeps its id, so the drawer stays where it is and only the
    // report underneath it is refetched.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["audit", auditId] }),
    onError: (err: unknown) => setSectionError(err instanceof ApiError ? err.message : "That section did not finish"),
  });

  if (isLoading) return <div className="rounded-2xl border border-line bg-white p-4 text-sm text-muted">Reading the review…</div>;
  if (!data) return <div className="rounded-2xl border border-line bg-white p-4 text-sm text-muted">The review could not be read.</div>;

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
              {scored && <span className="font-mono text-xs text-muted">/100</span>}
              <span className="ml-1 text-sm font-semibold text-ink">{scored ? data.verdict : "Not scored"}</span>
            </div>
            {!scored && <p className="mt-1 text-[11px] text-muted">Too little of the site could be examined to put one number on it. The sections below are what did run.</p>}
            <p className="mt-1 text-[11px] text-muted">
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
              <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">{AUDIT_DISCIPLINE_NAMES[discipline.discipline]}</p>
              <p className="mt-0.5 font-mono text-lg leading-none text-ink">{discipline.scored ? discipline.score : "—"}</p>
              <span className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-line">
                {/* An empty track for a section that did not run. A full bar over
                    "nobody read the writing" is a number contradicting a sentence. */}
                {discipline.scored && (
                  <span
                    className={`block h-full rounded-full ${discipline.score >= 70 ? "bg-lime" : discipline.score >= 40 ? "bg-blue" : "bg-ink/60"}`}
                    style={{ width: `${Math.max(4, discipline.score)}%` }}
                  />
                )}
              </span>
              <p className="mt-1 text-[10px] text-muted">{discipline.reviewer}</p>
            </div>
          ))}
        </div>

        {report.synthesis && (
          <>
            <p className="mt-4 whitespace-pre-line text-sm text-ink">{report.synthesis.executiveSummary}</p>
            <div className="mt-3 rounded-xl border border-blue/25 bg-blue/5 p-3">
              <p className="font-mono text-[10px] uppercase tracking-[.12em] text-blue">Do this first</p>
              <p className="mt-1 text-sm text-ink">{report.synthesis.theOneThing}</p>
            </div>
          </>
        )}

        {error && <p className="mt-3 text-sm text-danger-text">{error}</p>}
      </div>

      {shots.length > 0 && (
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="font-mono text-[10px] uppercase tracking-[.16em] text-muted">Their homepage, marked up</p>
          <p className="mt-1 text-[11px] text-muted">
            The numbered boxes mark roughly where each UI/UX point applies — the area, not the pixel. Open one to see it full size.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {/*
              The marked-up copy where there is one, the plain crop where there
              is not — and never the whole-page copy, which is a 12,000px strip
              and belongs behind the link below rather than in a grid.
            */}
            {shots
              .filter((shot) => shot.annotated)
              .concat(shots.filter((shot) => shot.annotated).length ? [] : shots.filter((shot) => !shot.full))
              .map((shot) => (
                <div key={`${shot.view}-${String(shot.annotated)}`} className="overflow-hidden rounded-xl border border-line">
                  <a
                    href={apiUrl(`/audits/${data.id}/screenshot/${shot.view}${shot.annotated ? "-marked" : ""}.png`)}
                    target="_blank"
                    rel="noreferrer"
                    className="block transition hover:opacity-90"
                  >
                    <img
                      src={apiUrl(`/audits/${data.id}/screenshot/${shot.view}${shot.annotated ? "-marked" : ""}.png`)}
                      alt={`${shot.view === "mobile" ? "Phone" : "Desktop"} view of the homepage`}
                      className="block max-h-64 w-full object-cover object-top"
                    />
                  </a>
                  <p className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.12em] text-muted">
                    <span>{shot.view === "mobile" ? "On a phone" : "On a desktop"}</span>
                    {shots.some((entry) => entry.full && entry.view === shot.view) && (
                      <a
                        href={apiUrl(`/audits/${data.id}/screenshot/${shot.view}-full.png`)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue underline-offset-2 hover:underline"
                      >
                        Whole page
                      </a>
                    )}
                  </p>
                </div>
              ))}
          </div>
        </div>
      )}

      {report.redesign && <RedesignCard call={report.redesign} />}

      {report.disciplines.map((discipline) => (
        <DisciplineCard
          key={discipline.discipline}
          discipline={discipline}
          hasPictures={shots.length > 0}
          onRerun={(freshScreenshots) => rerun.mutate({ discipline: discipline.discipline, freshScreenshots })}
          pending={rerun.isPending && rerun.variables?.discipline === discipline.discipline}
          // Another section being re-run must not leave four buttons live: the
          // report is rebuilt around whichever finishes, so two at once is two
          // rebuilds racing over one row.
          disabled={rerun.isPending}
          error={rerun.variables?.discipline === discipline.discipline ? sectionError : null}
        />
      ))}

      {report.notes.length > 0 && (
        <details className="rounded-2xl border border-line bg-white">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink">What this review did not check</summary>
          <div className="border-t border-line px-4 py-3">
            <p className="mb-2 text-[11px] text-muted">
              None of this is a fault, and none of it may be written to them as one. A check that did not run is not a finding.
            </p>
            <ul className="space-y-1 text-sm text-muted">
              {report.notes.map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
          </div>
        </details>
      )}

      {report.synthesis && (
        <details className="rounded-2xl border border-warn-line bg-warn-surface/60">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-warn-text">The brief for the email — internal</summary>
          <div className="space-y-2 border-t border-warn-line px-4 py-3 text-sm text-ink">
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

/** Ink for what matters, an outline for what does not. The palette has no red. */
function RedesignSeverityChip({ severity }: { severity: RedesignSeverity }) {
  const loud = severity === "CRITICAL" || severity === "HIGH";
  return (
    <span
      className={`rounded-[10px] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[.12em] ${
        loud ? "bg-ink text-cream" : "border border-line text-muted"
      }`}
    >
      {REDESIGN_SEVERITY_NAMES[severity]}
    </span>
  );
}

/**
 * The call on whether the page needs rebuilding, and the working behind it.
 *
 * Its own card above the four sections, because it is the answer the founder
 * is looking for when they open this drawer and the four scores are the
 * working behind it. The paragraph at the bottom is set apart and copyable in
 * one gesture: it is written to go into a proposal unedited, and a paragraph
 * somebody has to select by dragging is a paragraph that gets retyped and
 * quietly reworded.
 *
 * Everything below the scorecard is behind a disclosure. The card answers the
 * question in its first four lines and a reader who wants the ten headings,
 * the page top to bottom, the five-second test and the ranked faults opens
 * them — a card that prints all of it is a card nobody reaches the bottom of,
 * and the four discipline sections underneath stop being findable.
 */
function RedesignCard({ call }: { call: RedesignVerdict }) {
  const [copied, setCopied] = useState(false);
  const decision = normaliseRedesignCall(call.call);

  // Ink for a rebuild, blue for work in between, lime for a page that is fine.
  // The same weight-not-hue rule the PDF follows — the palette has no red.
  const tone =
    decision === "REBUILD"
      ? { chip: "bg-ink text-cream", label: "Build it again" }
      : decision === "REDESIGN"
        ? { chip: "bg-ink text-cream", label: "Needs redesigning" }
        : decision === "REFINE"
          ? { chip: "bg-blue text-cream", label: "Needs sharpening" }
          : { chip: "bg-lime text-ink", label: "No redesign needed" };

  return (
    <div className="rounded-2xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[.16em] text-muted">Does this page need a redesign?</p>
        <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.12em] ${tone.chip}`}>{tone.label}</span>
      </div>

      {typeof call.score === "number" && (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl bg-sunken px-3 py-2">
          <span className="font-mono text-2xl font-semibold text-ink">{call.score}</span>
          <span className="font-mono text-xs text-muted">/100</span>
          <span className="font-mono text-[10px] uppercase tracking-[.12em] text-blue">{redesignScoreBand(call.score)}</span>
          {/* Two numbers in one drawer is a contradiction unless it says which is which. */}
          <span className="w-full text-[11px] text-muted">How the page looks. The score below is the whole site, including three things no picture shows.</span>
        </div>
      )}

      <p className="mt-2 text-base font-semibold text-ink">{call.headline}</p>
      <p className="mt-1.5 whitespace-pre-line text-sm text-muted">{call.assessment}</p>

      {/* The decider overruled by its own arithmetic. Shown here and nowhere a
          client reads: it is a fact about how the report was made. */}
      {call.adjusted && <p className="mt-2 rounded-xl border border-line-strong bg-sunken p-2 text-[11px] text-muted">{call.adjusted}</p>}

      {call.scores && call.scores.length > 0 && (
        <details className="mt-3 rounded-xl border border-line">
          <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] text-muted">How the ten add up</summary>
          <ul className="space-y-2 border-t border-line px-3 py-2">
            {call.scores.map((row) => (
              <li key={row.category}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-semibold text-ink">{redesignCategoryName(row.category)}</span>
                  <span className="font-mono text-[11px] text-muted">
                    {row.score}/100 · {row.points.toFixed(1)} of {row.weight}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line">
                  <div className={`h-full rounded-full ${row.score >= 70 ? "bg-lime" : row.score >= 40 ? "bg-blue" : "bg-ink"}`} style={{ width: `${row.score}%` }} />
                </div>
                <p className="mt-0.5 text-[12px] text-muted">{row.reasoning}</p>
              </li>
            ))}
          </ul>
        </details>
      )}

      {call.issues.length > 0 && (
        <ul className="mt-3 space-y-2">
          {call.issues.map((issue, index) => (
            <li key={`${issue.category}-${index}`} className="border-l-2 border-line pl-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {issue.severity && <RedesignSeverityChip severity={issue.severity} />}
                <span className="text-sm font-semibold text-ink">{issue.title || redesignCategoryName(issue.category)}</span>
              </div>
              <p className="font-mono text-[10px] uppercase tracking-[.12em] text-blue">
                {redesignCategoryName(issue.category)} · {issue.view === "mobile" ? "phone" : "desktop"}
                {issue.necessity ? ` · ${REDESIGN_NECESSITY_NAMES[issue.necessity]}` : ""}
              </p>
              <p className="mt-0.5 text-sm text-ink">{issue.observed}</p>
              <p className="text-[12px] text-muted">{issue.costsThem}</p>
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        {[
          ["Trust", call.impact.trust],
          ["Finding things", call.impact.usability],
          ["Enquiries", call.impact.conversion],
          ["Landing on it", call.impact.howItFeels],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line p-2.5">
            <dt className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">{label}</dt>
            <dd className="mt-0.5 text-[13px] text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      {call.firstLook && (
        <div className="mt-3 rounded-xl border border-line p-3">
          <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">Five seconds on it — {call.firstLook.score}/100</p>
          <ul className="mt-1.5 space-y-1">
            {(
              [
                ["Whose website is this?", call.firstLook.whoTheyAre],
                ["What does the business do?", call.firstLook.whatTheyDo],
                ["Why should the visitor care?", call.firstLook.whyItMatters],
                ["Anything making them believable?", call.firstLook.whyBelieveThem],
                ["Obvious what to do next?", call.firstLook.whatToDoNext],
              ] as [string, boolean][]
            ).map(([question, had]) => (
              <li key={question} className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="text-muted">{question}</span>
                <span className={had ? "font-semibold text-ink" : "font-semibold text-blue"}>{had ? "Yes" : "No"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12px] text-muted">{call.firstLook.explanation}</p>
        </div>
      )}

      {(call.sections?.length || call.problems?.length || call.standing || call.age) && (
        <details className="mt-3 rounded-xl border border-line">
          <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] text-muted">The rest of the audit</summary>
          <div className="space-y-3 border-t border-line px-3 py-2">
            {call.sections && call.sections.length > 0 && (
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">The page, top to bottom</p>
                <ul className="mt-1 space-y-1.5">
                  {call.sections.map((part, index) => (
                    <li key={`${part.name}-${index}`} className="border-l-2 border-line pl-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <RedesignSeverityChip severity={part.severity} />
                        <span className="text-[13px] font-semibold text-ink">{part.name}</span>
                        {part.needsRebuilding && <span className="font-mono text-[9px] uppercase tracking-[.12em] text-blue">rebuild</span>}
                      </div>
                      {part.works && <p className="text-[12px] text-ink">{part.works}</p>}
                      {part.doesNotWork && <p className="text-[12px] text-muted">{part.doesNotWork}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {call.problems && call.problems.length > 0 && (
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">The biggest problems</p>
                <ol className="mt-1 space-y-1.5">
                  {call.problems.map((problem, index) => (
                    <li key={`${problem.problem}-${index}`} className="flex gap-2 text-[13px]">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-ink font-mono text-[10px] text-cream">{index + 1}</span>
                      <span>
                        <span className="font-semibold text-ink">{problem.problem}</span> <span className="text-muted">{problem.whyItMatters}</span>
                        <span className="block text-[12px] text-faint">Seen: {problem.evidence}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {call.standing?.assessment && (
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">
                  {call.standing.looksEstablished ? "It looks like a real firm" : "It does not look like a real firm"}
                </p>
                <p className="mt-0.5 text-[13px] text-ink">{call.standing.assessment}</p>
                {call.standing.whatUnderminesIt.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {call.standing.whatUnderminesIt.map((entry) => (
                      <li key={entry} className="text-[12px] text-muted">
                        — {entry}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {call.age?.why && (
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">How old it looks — {REDESIGN_ERA_NAMES[call.age.era]}</p>
                <p className="mt-0.5 text-[13px] text-ink">{call.age.why}</p>
              </div>
            )}
          </div>
        </details>
      )}

      {call.strengths && call.strengths.length > 0 && (
        <div className="mt-3 rounded-xl border border-lime/40 bg-lime/10 p-3">
          <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink">What is already good</p>
          <ul className="mt-1 space-y-1">
            {call.strengths.map((entry) => (
              <li key={entry.strength} className="text-[13px]">
                <span className="font-semibold text-ink">{entry.strength}</span> <span className="text-muted">{entry.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {call.direction.length > 0 && (
        <ol className="mt-3 space-y-1.5">
          {call.direction.map((step, index) => (
            <li key={step.change} className="flex gap-2 text-sm">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-ink font-mono text-[10px] text-cream">{index + 1}</span>
              <span>
                <span className="font-semibold text-ink">{step.change}</span> <span className="text-muted">{step.why}</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      {call.worthIt?.why && (
        <p className="mt-3 text-[13px] text-muted">
          <span className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">Worth paying for? {REDESIGN_WORTH_NAMES[call.worthIt.answer]}.</span>{" "}
          {call.worthIt.why}
        </p>
      )}

      {call.bottomLine?.recommendation && <p className="mt-2 text-sm font-semibold text-ink">{call.bottomLine.recommendation}</p>}

      <div className="mt-3 rounded-xl border border-blue/25 bg-blue/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-[.12em] text-blue">The paragraph for a proposal</p>
          <button
            type="button"
            className="font-mono text-[10px] uppercase tracking-[.12em] text-blue transition hover:text-ink"
            onClick={() => {
              void navigator.clipboard?.writeText(call.summary).then(
                () => setCopied(true),
                // A clipboard a browser will not give up is not an error worth
                // a red line in a review of somebody's website.
                () => setCopied(false),
              );
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="mt-1.5 text-sm text-ink">{call.summary}</p>
      </div>

      <p className="mt-2 text-[11px] text-muted">
        The {call.reviewer} made this call from the pictures and nothing else. {call.decidedBy}.
      </p>
    </div>
  );
}

function DisciplineCard({
  discipline,
  hasPictures,
  onRerun,
  pending,
  disabled,
  error,
}: {
  discipline: AuditDisciplineReport;
  /** Whether this review has pictures on file, which decides what UI/UX can reuse. */
  hasPictures: boolean;
  onRerun: (freshScreenshots?: boolean) => void;
  pending: boolean;
  disabled: boolean;
  error: string | null;
}) {
  const problems = discipline.findings.filter((finding) => finding.severity !== "GOOD");
  const good = discipline.findings.filter((finding) => finding.severity === "GOOD");
  // The one section that reads the pictures. Everything else re-runs on a fetch
  // of the page, which costs nothing but a model call.
  const readsPictures = discipline.discipline === "UX";

  return (
    <details className="rounded-2xl border border-line bg-white" open={!discipline.scored}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3">
        <span className="text-sm font-semibold text-ink">{AUDIT_DISCIPLINE_NAMES[discipline.discipline]}</span>
        <span className="font-mono text-xs text-muted">{discipline.scored ? `${discipline.score}/100` : "not scored"}</span>
        <span className="flex-1 truncate text-sm text-muted">{discipline.headline}</span>
        {problems.length > 0 && <Badge tone="muted">{problems.length}</Badge>}
      </summary>
      <div className="space-y-3 border-t border-line px-4 py-3">
        <p className="text-[11px] text-muted">
          Reviewed by the {discipline.reviewer} · {discipline.reviewedBy}
          {discipline.rerunAt && (
            <>
              {" · "}
              <span className="text-ink">
                this section run again <RelativeTime value={discipline.rerunAt} />
              </span>
            </>
          )}
        </p>
        {!discipline.scored && (
          <div className="rounded-xl bg-warn-surface px-2.5 py-2 text-[11px] text-warn-text">
            <p>This section did not run, so it has no score and is left out of the overall. What follows is only what could be counted.</p>
            <p className="mt-1.5">
              Once the reason is fixed — a token pasted, a model connected, a certificate replaced — run this one section again. The other
              three are left exactly as they are, and so is the report's date and its place in this lead's history.
            </p>
          </div>
        )}
        <p className="whitespace-pre-line text-sm text-ink">{discipline.summary}</p>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={discipline.scored ? "secondary" : "primary"} onClick={() => onRerun()} disabled={disabled}>
            {pending ? "Reviewing…" : `Run the ${AUDIT_DISCIPLINE_NAMES[discipline.discipline]} section again`}
          </Button>
          {readsPictures && hasPictures && (
            // Reusing the pictures is the default because the commonest reason
            // to re-run this section is that they were taken and nobody could
            // look at them — paying Apify again for the same two images buys
            // nothing. This is for a site that has actually changed.
            <button
              type="button"
              className="text-[11px] text-muted underline decoration-line underline-offset-2 transition hover:text-blue disabled:opacity-50"
              onClick={() => onRerun(true)}
              disabled={disabled}
            >
              …and photograph the site again
            </button>
          )}
          <span className="text-[11px] text-muted">
            {readsPictures
              ? hasPictures
                ? "Reuses the pictures already taken; the other three sections are not re-run."
                : "Photographs the site and reviews it. The other three sections are not re-run."
              : "Reads their page again and re-runs this reviewer only. No new pictures."}
          </span>
        </div>

        {error && <p className="text-sm text-danger-text">{error}</p>}

        {problems.map((finding) => (
          <FindingRow key={finding.id} finding={finding} />
        ))}

        {good.length > 0 && (
          <div className="rounded-xl border border-lime/40 bg-lime/10 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">What is right here</p>
            <ul className="mt-1.5 space-y-1 text-sm text-ink">
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
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[.12em] text-muted">What was examined</summary>
            <ul className="mt-1.5 space-y-1 text-[12px] text-muted">
              {discipline.checked.map((entry) => (
                <li key={entry}>· {entry}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-muted">Anything not on this list was not examined, which is not the same as it being sound.</p>
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
        {finding.marker != null && <span className="font-mono text-[10px] text-muted">box {finding.marker}</span>}
      </div>
      <p className="mt-1.5 text-sm text-ink">{finding.observed}</p>
      <p className="mt-1.5 text-sm text-muted">
        <span className="font-semibold text-ink">What it costs them.</span> {finding.impact}
      </p>
      <p className="mt-1.5 rounded-xl bg-sunken px-2.5 py-1.5 text-sm text-ink">
        <span className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">Say it like this</span>
        <br />
        {finding.plainly}
      </p>
      {finding.recommendation && (
        <p className="mt-1.5 text-sm text-muted">
          <span className="font-semibold text-ink">The fix.</span> {finding.recommendation}
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-muted">{finding.evidence}</p>
    </div>
  );
}
