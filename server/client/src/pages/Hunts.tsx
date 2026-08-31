import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Card, EmptyState, Eyebrow, PageHeader, RelativeTime, StatTile, StatusDot } from "../components/ui";

/**
 * The hunts — why Dakyworld goes looking for anybody.
 *
 * The Capture screen answers *how* a search runs: which actor, which town,
 * what it costs. It has never answered *why that search*, and without a why
 * there is nothing to judge a result against — a run either returned rows or it
 * did not, which is how a pipeline fills with businesses nobody can explain the
 * presence of.
 *
 * So this screen leads with the argument rather than with the machinery. Each
 * card opens on the reason the target is worth money, and the search, the
 * schedule and the cost are underneath it. The tests that decide whether one
 * particular business fits are shown as they will actually be applied —
 * **checked by the audit** for nothing, or **read by a model**, which costs
 * something — because that difference is what a hunt costs to run and it
 * should be visible while somebody is writing one rather than discoverable
 * from the bill.
 *
 * The two facts that need to be impossible to miss are stated on every card:
 * how many businesses a day this looks at, and that anything that fails is
 * deleted.
 */

interface Line {
  line: string;
  signal: string | null;
  says: string;
  checkedBy: "the audit" | "a model";
}

interface HuntRun {
  id: string;
  status: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  captured: number;
  audited: number;
  qualified: number;
  rejected: number;
  skipped: number;
  routed: number;
  costUsd: number;
  summary: string | null;
  error: string | null;
}

interface Verdict {
  id: string;
  companyName: string | null;
  website: string | null;
  city: string | null;
  verdict: "QUALIFIED" | "REJECTED" | "UNDECIDED";
  score: number;
  reason: string;
  deleted: boolean;
  leadId: string | null;
  createdAt: string;
}

interface Thesis {
  id: string;
  key: string;
  name: string;
  target: string;
  rationale: string;
  offer: string;
  qualifiers: Line[];
  disqualifiers: Line[];
  minScore: number;
  leadsPerRun: number;
  runTimes: string[];
  timezone: string;
  routeAgentKey: string | null;
  deleteRejected: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  custom: boolean;
  edited: boolean;
  perDay: number;
  source: { id: string; name: string; actorId: string; enabled: boolean } | null;
  judged: number;
  qualified: number;
  rejected: number;
  undecided: number;
  lastHunt: { id: string; at: string; status: string; summary: string | null; costUsd: number } | null;
}

interface HuntList {
  theses: Thesis[];
  summary: { total: number; running: number; leadsPerDay: number };
}

type Detail = Thesis & { hunts: HuntRun[]; verdicts: Verdict[] };

const VERDICT_TONE: Record<Verdict["verdict"], "ok" | "warn" | "bad" | "idle"> = {
  QUALIFIED: "ok",
  REJECTED: "bad",
  UNDECIDED: "warn",
};

export function Hunts() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["hunts"], refetchInterval: 20_000, queryFn: () => api.get<HuntList>("/hunts") });
  const detail = useQuery({
    queryKey: ["hunt", open],
    enabled: Boolean(open),
    refetchInterval: 15_000,
    queryFn: () => api.get<Detail>(`/hunts/${open}`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["hunts"] });
    void queryClient.invalidateQueries({ queryKey: ["hunt"] });
  };

  const setEnabled = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      api.post<{ note: string }>(`/hunts/${key}/enabled`, { enabled }),
    onSuccess: (result) => {
      setNote(result.note);
      invalidate();
    },
    onError: (err: Error) => setNote(err.message),
  });

  const runNow = useMutation({
    mutationFn: (key: string) => api.post<{ note: string }>(`/hunts/${key}/run`),
    onSuccess: (result) => {
      setNote(result.note);
      invalidate();
    },
    onError: (err: Error) => setNote(err.message),
  });

  const theses = list.data?.theses ?? [];
  const summary = list.data?.summary;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Leads"
        title="Hunts"
        subtitle="The reasons Dakyworld goes looking for anybody. Each hunt searches, looks properly at what it finds, and keeps or drops each business against tests written down in advance."
      />

      {note && (
        <Card className="border-blue/40 bg-blue/5">
          <div className="flex items-start justify-between gap-4">
            <p className="text-sm">{note}</p>
            <button className="text-xs text-ink/50 hover:text-ink" onClick={() => setNote(null)}>
              Dismiss
            </button>
          </div>
        </Card>
      )}

      {summary && (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile label="Hunts written" value={summary.total} sub={`${summary.running} running`} />
          <StatTile
            label="Businesses looked at a day"
            value={summary.leadsPerDay}
            sub={summary.leadsPerDay === 0 ? "Nothing is running" : "Every one of them audited"}
          />
          <StatTile
            label="Judged so far"
            value={theses.reduce((sum, thesis) => sum + thesis.judged, 0)}
            sub={`${theses.reduce((sum, thesis) => sum + thesis.qualified, 0)} kept`}
          />
        </div>
      )}

      {list.isLoading && <Card>Loading…</Card>}
      {!list.isLoading && theses.length === 0 && (
        <EmptyState message="No hunts are written yet. The shipped ones arrive on the next deploy, switched off." />
      )}

      <div className="space-y-4">
        {theses.map((thesis) => (
          <Card key={thesis.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <StatusDot tone={thesis.enabled ? "live" : "idle"} />
                  <h3 className="text-base font-medium">{thesis.name}</h3>
                  {thesis.custom && <Badge tone="muted">yours</Badge>}
                  {thesis.edited && <Badge tone="muted">edited</Badge>}
                </div>
                <p className="mt-1 text-sm text-ink/70">{thesis.target}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setOpen(open === thesis.key ? null : thesis.key)}
                >
                  {open === thesis.key ? "Close" : "Open"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={runNow.isPending || !thesis.source}
                  onClick={() => runNow.mutate(thesis.key)}
                >
                  Run once
                </Button>
                <Button
                  variant={thesis.enabled ? "ghost" : "primary"}
                  disabled={setEnabled.isPending}
                  onClick={() => setEnabled.mutate({ key: thesis.key, enabled: !thesis.enabled })}
                >
                  {thesis.enabled ? "Stop" : "Start hunting"}
                </Button>
              </div>
            </div>

            {/* The reason, which is the whole point of a thesis. */}
            <p className="mt-4 text-sm leading-relaxed text-ink/80">{thesis.rationale}</p>
            <p className="mt-2 text-sm text-ink/60">
              <span className="font-medium text-ink/80">What we would sell them:</span> {thesis.offer}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink/60">
              <span>
                <span className="font-medium text-ink/80">{thesis.leadsPerRun}</span> a run ·{" "}
                <span className="font-medium text-ink/80">{thesis.runTimes.length || "no"}</span> run
                {thesis.runTimes.length === 1 ? "" : "s"} a day
                {thesis.runTimes.length > 0 && ` (${thesis.runTimes.join(", ")} ${thesis.timezone})`}
              </span>
              <span>
                = <span className="font-medium text-ink/80">{thesis.perDay}</span> audited a day
              </span>
              <span>kept at {thesis.minScore}+</span>
              <span className={thesis.deleteRejected ? "text-red-600" : undefined}>
                {thesis.deleteRejected ? "rejected leads are deleted" : "rejected leads are kept, marked disqualified"}
              </span>
              {thesis.source ? (
                <span>searches with “{thesis.source.name}”</span>
              ) : (
                <span className="text-red-600">no search attached — nothing to run</span>
              )}
              {thesis.enabled && thesis.nextRunAt && (
                <span>
                  next <RelativeTime value={thesis.nextRunAt} />
                </span>
              )}
            </div>

            {thesis.judged > 0 && (
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Badge tone="positive">{thesis.qualified} fit</Badge>
                <Badge tone="default">{thesis.rejected} did not</Badge>
                {thesis.undecided > 0 && <Badge tone="warn">{thesis.undecided} undecided</Badge>}
              </div>
            )}

            {thesis.lastHunt?.summary && (
              <p className="mt-3 border-l-2 border-ink/10 pl-3 text-xs text-ink/60">{thesis.lastHunt.summary}</p>
            )}

            {open === thesis.key && (
              <div className="mt-5 space-y-5 border-t border-ink/10 pt-5">
                <Lines title="Fits when" lines={thesis.qualifiers} empty="Nothing — every business it finds would be undecided." />
                <Lines title="Ruled out by" lines={thesis.disqualifiers} empty="Nothing rules a business out outright." />

                {detail.data && detail.data.key === thesis.key && (
                  <>
                    <Verdicts verdicts={detail.data.verdicts} />
                    <Runs hunts={detail.data.hunts} />
                  </>
                )}
                {detail.isLoading && <p className="text-xs text-ink/50">Loading what it has decided…</p>}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

/**
 * The tests, with how each one is answered.
 *
 * The badge is not decoration. A line answered by the audit costs nothing and
 * gives the same answer every time; a line a model has to read costs money per
 * business and is a judgement. Somebody writing a thesis should be able to see
 * which they have written without running one.
 */
function Lines({ title, lines, empty }: { title: string; lines: Line[]; empty: string }) {
  return (
    <div>
      <Eyebrow>{title}</Eyebrow>
      {lines.length === 0 ? (
        <p className="mt-2 text-sm text-ink/50">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {lines.map((line) => {
            const defining = line.line.trim().startsWith("!");
            return (
              <li key={line.line} className="flex items-start gap-2 text-sm">
                <Badge tone={line.checkedBy === "the audit" ? "muted" : "warn"}>
                  {line.checkedBy === "the audit" ? "checked free" : "read by a model"}
                </Badge>
                <span className="flex-1 text-ink/75">
                  {line.says}
                  {defining && <span className="ml-2 text-xs text-ink/50">— must be true, not just weighed</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Verdicts({ verdicts }: { verdicts: Verdict[] }) {
  if (verdicts.length === 0) return <p className="text-sm text-ink/50">Nothing judged yet.</p>;
  return (
    <div>
      <Eyebrow>What it decided, and why</Eyebrow>
      <ul className="mt-2 space-y-2">
        {verdicts.slice(0, 20).map((verdict) => (
          <li key={verdict.id} className="rounded border border-ink/10 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusDot tone={VERDICT_TONE[verdict.verdict]} />
              <span className="font-medium">{verdict.companyName ?? "Unnamed"}</span>
              <span className="text-xs text-ink/50">{verdict.score}</span>
              {verdict.website && <span className="text-xs text-ink/50">{verdict.website}</span>}
              {verdict.deleted && <Badge tone="muted">deleted from the pipeline</Badge>}
              {!verdict.deleted && verdict.leadId === null && verdict.verdict === "REJECTED" && (
                <Badge tone="muted">gone, kept as a record</Badge>
              )}
            </div>
            <p className="mt-1 text-ink/70">{verdict.reason}</p>
          </li>
        ))}
      </ul>
      {verdicts.length > 20 && <p className="mt-2 text-xs text-ink/50">…and {verdicts.length - 20} more.</p>}
    </div>
  );
}

function Runs({ hunts }: { hunts: HuntRun[] }) {
  if (hunts.length === 0) return null;
  return (
    <div>
      <Eyebrow>Cycles</Eyebrow>
      <ul className="mt-2 space-y-1 text-xs text-ink/60">
        {hunts.slice(0, 8).map((run) => (
          <li key={run.id} className="flex flex-wrap items-center gap-2">
            <RelativeTime value={run.startedAt} />
            <Badge tone={run.status === "FAILED" ? "warn" : "muted"}>{run.status.toLowerCase()}</Badge>
            <span>
              looked at {run.audited}, kept {run.qualified}, dropped {run.rejected}
              {run.skipped > 0 && `, skipped ${run.skipped} already judged`}
            </span>
            <span>${run.costUsd.toFixed(2)}</span>
            {run.error && <span className="text-red-600">{run.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
