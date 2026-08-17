import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Card } from "./ui";
import type { CaptureIntent, CaptureRunResult, CaptureTargetKind } from "../lib/types";

/**
 * Paste a link, or say what you want.
 *
 * The old way to capture one company was to add a permanent source, pick a
 * template and hand-edit `startUrls` inside a JSON box. This is the same
 * machinery with the ritual removed.
 *
 * It reads before it runs, always. Five pay-per-event actors sit behind this,
 * so what it understood is shown back first and a person presses the button.
 */

const KIND_LABEL: Record<CaptureTargetKind, string> = {
  WEBSITE: "Website",
  MAPS_SEARCH: "Google Maps",
  LINKEDIN_COMPANY: "LinkedIn",
  FACEBOOK_PAGE: "Facebook",
  INSTAGRAM: "Instagram",
};

const EXAMPLES = [
  "kessben.com",
  "dental clinics in Kumasi",
  "instagram.com/adjeidental",
  "scrape their LinkedIn for contact details",
];

export function QuickCapture() {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [intent, setIntent] = useState<CaptureIntent | null>(null);
  const [done, setDone] = useState<CaptureRunResult | null>(null);

  const read = useMutation({
    mutationFn: (value: string) => api.post<CaptureIntent>("/capture/interpret", { text: value }),
    onSuccess: (data) => {
      setIntent(data);
      setDone(null);
    },
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

  const busy = read.isPending || run.isPending;
  const error = (read.error ?? run.error) as Error | null;

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-xl tracking-[-.02em]">Quick capture</h2>
        <span className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/35">no setup needed</span>
      </div>
      <p className="mt-1.5 text-sm text-ink/60">
        Paste a link — a website, a Google Maps place, a LinkedIn company, a Facebook Page, an Instagram account — or just
        say what you're after. Rows copied from a spreadsheet go to the importer instead.
      </p>

      <textarea
        className="input mt-4 min-h-[92px] resize-y"
        placeholder={"kessben.com\ndental clinics in Kumasi"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim()) read.mutate(text);
        }}
      />

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => setText(example)}
            className="rounded-full border border-line px-2.5 py-1 font-mono text-[10px] text-ink/45 transition hover:border-blue/40 hover:text-ink"
          >
            {example}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => read.mutate(text)} disabled={!text.trim() || busy}>
          {read.isPending ? "Reading…" : "Read this"}
        </Button>
        {intent && !intent.free && (
          <span className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/35">interpreted by Claude</span>
        )}
      </div>

      {error && <p className="mt-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error.message}</p>}

      {intent && (
        <div className="mt-5 border-t border-line pt-5">
          {intent.summary && <p className="text-sm text-ink/70">{intent.summary}</p>}

          {intent.targets.length > 0 && (
            <>
              <h3 className="mt-4 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">
                About to capture — nothing has run yet
              </h3>
              <ul className="mt-2 space-y-2">
                {intent.targets.map((target, i) => (
                  <li key={`${target.kind}-${target.value}-${i}`} className="flex items-start gap-2.5">
                    <Badge tone="muted">{KIND_LABEL[target.kind] ?? target.kind}</Badge>
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink">{target.value}</p>
                      {target.why && <p className="text-xs text-ink/45">{target.why}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex items-center gap-2">
                {/* The one lime action on this screen: it's what spends money. */}
                <Button variant="accent" onClick={() => run.mutate(intent.targets)} disabled={busy}>
                  {run.isPending ? "Starting…" : `Capture ${intent.targets.length}`}
                </Button>
                <Button variant="ghost" onClick={() => setIntent(null)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </>
          )}

          {intent.question && (
            <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{intent.question}</p>
          )}
        </div>
      )}

      {done && (
        <div className="mt-5 border-t border-line pt-5">
          {done.started.length > 0 && (
            <p className="text-sm text-ink/70">
              Started {done.started.length} run{done.started.length === 1 ? "" : "s"}. Leads appear below as they land.
            </p>
          )}
          {done.failed.map((f) => (
            <p key={f.kind} className="mt-2 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {KIND_LABEL[f.kind as CaptureTargetKind] ?? f.kind}: {f.reason}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}
