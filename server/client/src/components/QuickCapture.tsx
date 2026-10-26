import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Badge, Button, Card } from "./ui";
import type {
  CaptureEstimate,
  CaptureIntent,
  CaptureRunResult,
  CaptureTargetKind,
  CaptureTaskInfo,
  InstantCaptureResult,
} from "../lib/types";

const KIND_LABEL: Record<CaptureTargetKind, string> = {
  WEBSITE: "Website",
  MAPS_SEARCH: "Google Maps",
  LINKEDIN_COMPANY: "LinkedIn",
  FACEBOOK_PAGE: "Facebook",
  INSTAGRAM: "Instagram",
};

const EXAMPLES = [
  "restaurantlogic.com",
  "kessben.com",
  "dental clinics in Kumasi",
  "luxury aesthetic clinics in Dubai",
  "b2b freight logistics in Amsterdam",
  "commercial HVAC contractors in Sydney",
  "instagram.com/adjeidental",
  "scrape their LinkedIn for contact details",
];

function detectInputType(raw: string): {
  kind: "WEBSITE" | "MAPS_SEARCH" | "LINKEDIN" | "FACEBOOK" | "INSTAGRAM" | "SEARCH" | null;
  label: string;
  isUrl: boolean;
  cleanUrl: string | null;
} {
  let trimmed = raw.trim();
  // Strip enclosing quotes, brackets, and trailing commas/periods
  trimmed = trimmed
    .replace(/^[<("'[]+/, "")
    .replace(/[>)"'\]]+$/, "")
    .replace(/[,;:!?]+$/, "")
    .trim();

  if (!trimmed) return { kind: null, label: "", isUrl: false, cleanUrl: null };

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL | null = null;
  try {
    if (/^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/|$|\?|#)/i.test(trimmed)) {
      url = new URL(withScheme);
      url.hostname = url.hostname.replace(/[,.:;!?'"<>]+$/, "");
    }
  } catch {
    url = null;
  }

  if (url) {
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host.includes("linkedin.com")) return { kind: "LINKEDIN", label: "LinkedIn Company", isUrl: true, cleanUrl: url.href };
    if (host.includes("facebook.com") || host.includes("fb.com")) return { kind: "FACEBOOK", label: "Facebook Page", isUrl: true, cleanUrl: url.href };
    if (host.includes("instagram.com")) return { kind: "INSTAGRAM", label: "Instagram Profile", isUrl: true, cleanUrl: url.href };
    if (host.includes("google.") && (url.pathname.includes("/maps") || url.hostname.startsWith("maps."))) {
      return { kind: "MAPS_SEARCH", label: "Google Maps Place", isUrl: true, cleanUrl: url.href };
    }
    return { kind: "WEBSITE", label: "Website", isUrl: true, cleanUrl: url.href };
  }

  return { kind: "SEARCH", label: "Search query", isUrl: false, cleanUrl: null };
}

export function QuickCapture() {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [intent, setIntent] = useState<CaptureIntent | null>(null);
  const [done, setDone] = useState<CaptureRunResult | null>(null);
  const [instantResult, setInstantResult] = useState<InstantCaptureResult | null>(null);
  const [manual, setManual] = useState<CaptureTargetKind | null>(null);
  const [useAdvanced, setUseAdvanced] = useState(false);

  const detected = useMemo(() => detectInputType(text), [text]);

  const { data: taskList } = useQuery({
    queryKey: ["capture-tasks"],
    queryFn: ({ signal }) => api.get<{ tasks: CaptureTaskInfo[] }>("/capture/tasks", signal),
    staleTime: 5 * 60_000,
  });
  const tasks = taskList?.tasks ?? [];

  // Instant local website scraper
  const instantCapture = useMutation({
    mutationFn: (url: string) => api.post<InstantCaptureResult>("/capture/instant", { url }),
    onSuccess: (data) => {
      setInstantResult(data);
      setIntent(null);
      setDone(null);
      setText("");
      void qc.invalidateQueries({ queryKey: ["leads"] });
      void qc.invalidateQueries({ queryKey: ["scraper-runs"] });
      void qc.invalidateQueries({ queryKey: ["scraper-overview"] });
    },
  });

  // Apify multi-target interpret
  const read = useMutation({
    mutationFn: (value: string) => api.post<CaptureIntent>("/capture/interpret", { text: value }),
    onSuccess: (data) => {
      setIntent(data);
      setDone(null);
      setManual(null);
      setInstantResult(null);
    },
  });

  const retask = (index: number, kind: CaptureTargetKind) => {
    setIntent((current) =>
      current
        ? {
            ...current,
            targets: current.targets.map((target, i) =>
              i === index ? { ...target, kind, why: `Set by hand to ${KIND_LABEL[kind]}.` } : target,
            ),
          }
        : current,
    );
  };

  const targetsKey = intent ? intent.targets.map((target) => `${target.kind}:${target.value}`).join("|") : "";
  const { data: estimate } = useQuery({
    queryKey: ["capture-estimate", targetsKey],
    queryFn: () =>
      api.post<CaptureEstimate>("/capture/estimate", {
        targets: intent?.targets.map(({ kind, value }) => ({ kind, value })) ?? [],
      }),
    enabled: Boolean(intent?.targets.length),
    staleTime: 60_000,
  });

  const run = useMutation({
    mutationFn: (targets: CaptureIntent["targets"]) =>
      api.post<CaptureRunResult>("/capture/run", { targets: targets.map(({ kind, value }) => ({ kind, value })) }),
    onSuccess: (result) => {
      setDone(result);
      setIntent(null);
      setText("");
      void qc.invalidateQueries({ queryKey: ["scraper-runs"] });
      void qc.invalidateQueries({ queryKey: ["scraper-overview"] });
    },
  });

  const handlePrimaryAction = () => {
    const rawVal = text.trim();
    if (!rawVal) return;

    const cleaned =
      detected.cleanUrl ||
      rawVal
        .replace(/^[<("'[]+/, "")
        .replace(/[>)"'\]]+$/, "")
        .replace(/[,;:!?]+$/, "")
        .trim();

    // Direct Website URL: run instant local extraction for ~1s results with $0 cost
    if (detected.kind === "WEBSITE" && !useAdvanced) {
      instantCapture.mutate(cleaned);
    } else {
      read.mutate(cleaned);
    }
  };

  const busy = instantCapture.isPending || read.isPending || run.isPending;
  const error = (instantCapture.error ?? read.error ?? run.error) as Error | null;

  return (
    <Card className="relative overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h2 className="font-display text-xl tracking-[-.02em]">Quick Lead Capture</h2>
          <p className="mt-1 text-sm text-muted">
            Paste any website link (e.g. <span className="font-mono text-ink">restaurantlogic.com</span>), a Google Maps
            place, or a search term. Contact info and leads are extracted directly into your pipeline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {detected.kind && (
            <span className="rounded-full border border-blue/30 bg-blue/10 px-2.5 py-0.5 font-sans text-[11px] font-medium uppercase tracking-[.06em] text-blue">
              {detected.kind === "WEBSITE" ? "🌐 Website" : detected.label}
            </span>
          )}
          <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">instant & automated</span>
        </div>
      </div>

      <div className="mt-4">
        <div className="relative">
          <textarea
            className="input min-h-[84px] resize-y pr-24 font-mono text-sm leading-relaxed"
            placeholder="Paste a website link (e.g. https://www.restaurantlogic.com/ or restaurantlogic.com) or search term..."
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) {
                instantCapture.reset();
                read.reset();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && text.trim() && !busy) {
                e.preventDefault();
                handlePrimaryAction();
              }
            }}
          />

          <div className="absolute bottom-2.5 right-2.5 flex items-center gap-2">
            <Button
              variant="accent"
              onClick={handlePrimaryAction}
              disabled={!text.trim() || busy}
            >
              {instantCapture.isPending
                ? "Extracting…"
                : read.isPending
                  ? "Analyzing…"
                  : detected.kind === "WEBSITE" && !useAdvanced
                    ? "Capture Lead"
                    : "Analyze & Run"}
            </Button>
          </div>
        </div>

        {/* Quick Example Suggestions */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted mr-1">Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setText(example);
                setInstantResult(null);
                setIntent(null);
              }}
              className="rounded-full border border-line bg-cream/40 px-2.5 py-0.5 font-mono text-[11px] text-muted transition hover:border-blue/40 hover:bg-white hover:text-ink"
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mt-3 flex items-start justify-between rounded-xl border border-danger-line bg-danger-surface p-3 text-sm text-danger-text">
          <div>
            <span className="font-semibold">Capture error: </span>
            {error.message}
          </div>
          <button
            type="button"
            onClick={() => {
              instantCapture.reset();
              read.reset();
            }}
            className="text-xs uppercase hover:underline ml-2"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 🟢 Instant Local Capture Result Card */}
      {instantResult && (
        <div className="mt-5 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5 transition-all">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-600 font-bold text-xs">
                ✓
              </span>
              <span className="font-sans text-xs font-semibold uppercase tracking-[.06em] text-emerald-800">
                Lead Captured & Saved to Pipeline!
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-muted">
                Crawled in {instantResult.extracted.durationMs ?? 0}ms • Score {instantResult.lead.leadScore}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setInstantResult(null)}>
                Clear
              </Button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-emerald-500/15 pb-4">
            <div className="min-w-0">
              <h3 className="font-display text-xl font-medium tracking-tight text-ink truncate">
                {instantResult.extracted.companyName || instantResult.lead.companyName || instantResult.extracted.domain}
              </h3>
              <a
                href={instantResult.extracted.website}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-blue hover:underline"
              >
                {instantResult.extracted.website} ↗
              </a>
            </div>

            <Link
              to={`/leads?search=${encodeURIComponent(instantResult.extracted.domain)}`}
              className="rounded-full inline-flex items-center gap-1.5 border border-line-strong bg-white px-4 py-2 font-sans text-xs font-semibold uppercase tracking-[.06em] text-ink shadow-sm transition hover:border-ink hover:bg-cream"
            >
              Open Lead in CRM →
            </Link>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* Emails */}
            <div className="rounded-xl border border-line/60 bg-white/90 p-3.5 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">Emails</span>
                <span className="font-mono text-[11px] text-muted">{instantResult.extracted.emails.length} found</span>
              </div>
              {instantResult.extracted.emails.length > 0 ? (
                <div className="mt-2 space-y-1.5">
                  {instantResult.extracted.emails.map((email) => (
                    <div key={email} className="flex items-center justify-between gap-2 font-mono text-xs text-ink">
                      <a href={`mailto:${email}`} className="truncate hover:text-blue hover:underline" title={email}>
                        {email}
                      </a>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(email)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-muted transition hover:bg-cream hover:text-ink"
                        title="Copy email address"
                      >
                        Copy
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted">No public email found</p>
              )}
            </div>

            {/* Phone Numbers */}
            <div className="rounded-xl border border-line/60 bg-white/90 p-3.5 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">Phone Numbers</span>
                <span className="font-mono text-[11px] text-muted">{instantResult.extracted.phones.length} found</span>
              </div>
              {instantResult.extracted.phones.length > 0 ? (
                <div className="mt-2 space-y-1.5">
                  {instantResult.extracted.phones.map((phone) => (
                    <div key={phone} className="flex items-center justify-between gap-2 font-mono text-xs text-ink">
                      <a href={`tel:${phone}`} className="truncate hover:text-blue hover:underline" title={phone}>
                        {phone}
                      </a>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(phone)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-muted transition hover:bg-cream hover:text-ink"
                        title="Copy phone number"
                      >
                        Copy
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted">No public phone found</p>
              )}
            </div>

            {/* Social Links */}
            <div className="rounded-xl border border-line/60 bg-white/90 p-3.5 shadow-sm sm:col-span-2 lg:col-span-1">
              <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">Social Media</span>
              {Object.keys(instantResult.extracted.socialLinks).length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(instantResult.extracted.socialLinks).map(([network, link]) => (
                    <a
                      key={network}
                      href={link}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-full border border-line bg-cream/40 px-2.5 py-1 font-sans text-[11px] uppercase tracking-[.06em] text-ink transition hover:border-blue hover:text-blue"
                    >
                      {network} ↗
                    </a>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted">No social links detected</p>
              )}
            </div>
          </div>

          {instantResult.extracted.description && (
            <p className="mt-3 text-xs leading-relaxed text-muted line-clamp-2">
              <span className="font-medium text-ink">Description: </span>
              {instantResult.extracted.description}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-emerald-500/15 pt-3">
            <span className="font-sans text-[11px] text-muted">
              Auto-tagged with <Badge tone="positive">quick-capture</Badge>
            </span>
            <Button size="sm" onClick={() => setInstantResult(null)}>
              Capture Another
            </Button>
          </div>
        </div>
      )}

      {/* Manual Task Picker fallback */}
      {read.isError && (
        <TaskPicker
          tasks={tasks}
          chosen={manual}
          onChoose={setManual}
          busy={busy}
          seed={text}
          onRun={(kind, value) => run.mutate([{ kind, value, why: "" }])}
        />
      )}

      {/* Multi-Target Plan Confirmation (for searches, multi-URLs, Apify crawls) */}
      {intent && (
        <div className="mt-5 border-t border-line pt-5">
          {intent.summary && <p className="text-sm font-medium text-ink">{intent.summary}</p>}

          {intent.targets.length > 0 && (
            <>
              <h3 className="mt-4 font-sans text-[11px] uppercase tracking-[.06em] text-muted">
                Targets identified — review before starting run
              </h3>
              <ul className="mt-2 space-y-2">
                {intent.targets.map((target, i) => (
                  <li key={`${target.value}-${i}`} className="flex items-start gap-2.5 rounded-xl border border-line bg-cream/20 p-2.5">
                    <select
                      className="rounded-full shrink-0 border border-line bg-white px-2 py-1 font-sans text-[11px] uppercase tracking-[.06em] text-ink"
                      value={target.kind}
                      onChange={(event) => retask(i, event.target.value as CaptureTargetKind)}
                      aria-label="What to run this as"
                    >
                      {(tasks.length ? tasks.map((t) => t.kind) : (Object.keys(KIND_LABEL) as CaptureTargetKind[])).map((kind) => (
                        <option key={kind} value={kind}>
                          {KIND_LABEL[kind] ?? kind}
                        </option>
                      ))}
                    </select>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{target.value}</p>
                      {target.why && <p className="text-xs text-muted">{target.why}</p>}
                    </div>
                  </li>
                ))}
              </ul>

              {estimate && <CostNote estimate={estimate} />}

              <div className="mt-4 flex items-center gap-2">
                <Button variant="accent" onClick={() => run.mutate(intent.targets)} disabled={busy}>
                  {run.isPending ? "Starting Run…" : `Start Capture Run (${intent.targets.length})`}
                </Button>
                <Button variant="ghost" onClick={() => setIntent(null)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </>
          )}

          {intent.question && (
            <p className="mt-3 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
              {intent.question}
            </p>
          )}

          {intent.targets.length === 0 && (
            <TaskPicker
              tasks={tasks}
              chosen={manual}
              onChoose={setManual}
              busy={busy}
              seed={text}
              onRun={(kind, value) => run.mutate([{ kind, value, why: "" }])}
            />
          )}
        </div>
      )}

      {/* Done notification for background runs */}
      {done && (
        <div className="mt-5 rounded-2xl border border-blue/30 bg-blue/5 p-4">
          {done.started.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-ink">
                  Started {done.started.length} background capture run{done.started.length === 1 ? "" : "s"}.
                </p>
                <p className="text-xs text-muted mt-0.5">
                  The crawler is active on Apify. Incoming leads will be scored and saved directly into your pipeline.
                </p>
              </div>
              <Link
                to="/leads"
                className="rounded-full inline-flex items-center gap-1 border border-line bg-white px-3.5 py-1.5 font-sans text-xs uppercase tracking-[.06em] text-ink hover:border-ink shadow-sm"
              >
                Go to Leads →
              </Link>
            </div>
          )}
          {done.failed.map((f, i) => (
            <p key={`${f.kind}-${i}`} className="mt-2 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2 text-sm text-warn-text">
              {KIND_LABEL[f.kind as CaptureTargetKind] ?? f.kind}: {f.reason}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

function TaskPicker({
  tasks,
  chosen,
  onChoose,
  onRun,
  busy,
  seed,
}: {
  tasks: CaptureTaskInfo[];
  chosen: CaptureTargetKind | null;
  onChoose: (kind: CaptureTargetKind | null) => void;
  onRun: (kind: CaptureTargetKind, value: string) => void;
  busy: boolean;
  seed: string;
}) {
  const [value, setValue] = useState("");
  const task = tasks.find((t) => t.kind === chosen) ?? null;

  if (!tasks.length) return null;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <h3 className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">Or choose specific target kind</h3>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {tasks.map((entry) => (
          <button
            key={entry.kind}
            type="button"
            onClick={() => {
              onChoose(entry.kind);
              setValue(seed.trim().split("\n")[0] ?? "");
            }}
            className={`rounded-full border px-2.5 py-1 font-sans text-[11px] uppercase tracking-[.06em] transition ${
              chosen === entry.kind ? "border-ink bg-ink text-cream" : "border-line text-muted hover:border-blue/40 hover:text-ink"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {task && (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) onRun(task.kind, value.trim());
          }}
        >
          <p className="text-xs text-muted">{task.takes}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              className="input max-w-md flex-1"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={task.example}
              autoFocus
            />
            <Button variant="accent" type="submit" disabled={busy || !value.trim()}>
              {busy ? "Starting…" : `Run as ${task.label}`}
            </Button>
          </div>
          <p className="mt-1.5 font-mono text-[11px] text-muted">runs actor {task.actorId}</p>
        </form>
      )}
    </div>
  );
}

function CostNote({ estimate }: { estimate: CaptureEstimate }) {
  const waste = estimate.tasks.flatMap((task) => task.estimate.waste);

  return (
    <div className="rounded-xl mt-3 border border-line bg-sunken px-3.5 py-2.5">
      <p className="text-sm text-ink">
        {estimate.totalUsd == null ? (
          "Apify wouldn't quote a price for this, so it can't be costed in advance."
        ) : (
          <>
            Estimated cost: <strong>${estimate.totalUsd.toFixed(2)}</strong>
            {estimate.partial && " for the parts that could be priced"} on Apify.
          </>
        )}
      </p>
      {estimate.tasks.length > 1 && (
        <ul className="mt-1 space-y-0.5">
          {estimate.tasks.map((task) => (
            <li key={task.kind} className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">
              {task.label} × {task.count} —{" "}
              {task.estimate.totalUsd == null ? "not priced" : `$${task.estimate.totalUsd.toFixed(2)}`}
            </li>
          ))}
        </ul>
      )}
      {waste.map((line) => (
        <p key={line} className="mt-1.5 text-xs text-warn-text">
          {line}
        </p>
      ))}
    </div>
  );
}
