import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Card } from "./ui";
import type { CaptureEstimate, CaptureIntent, CaptureRunResult, CaptureTargetKind, CaptureTaskInfo } from "../lib/types";

/**
 * Paste a link, or say what you want.
 *
 * The old way to capture one company was to add a permanent source, pick a
 * template and hand-edit `startUrls` inside a JSON box. This is the same
 * machinery with the ritual removed.
 *
 * It reads before it runs, always. Five pay-per-event actors sit behind this,
 * so what it understood is shown back first and a person presses the button.
 *
 * **And the reading can be overruled.** Every target carries the task it was
 * read as, as a dropdown: "no, that is their Facebook Page, not their site."
 * When the words could not be read at all, the same list is offered directly —
 * pick the task, give it the input it wants, run it. Reading is a convenience,
 * never the only way in. See services/captureActors.ts for what sits behind
 * each task and what each one accepts.
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
  /** Set when the task is being named by hand rather than read out of the text. */
  const [manual, setManual] = useState<CaptureTargetKind | null>(null);

  const { data: taskList } = useQuery({
    queryKey: ["capture-tasks"],
    queryFn: () => api.get<{ tasks: CaptureTaskInfo[] }>("/capture/tasks"),
    staleTime: 5 * 60_000,
  });
  const tasks = taskList?.tasks ?? [];

  const read = useMutation({
    mutationFn: (value: string) => api.post<CaptureIntent>("/capture/interpret", { text: value }),
    onSuccess: (data) => {
      setIntent(data);
      setDone(null);
      setManual(null);
    },
  });

  /** Re-reads one target as a different task, without touching the others. */
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

  /**
   * What this paste will cost, at Apify's published rates, before the button
   * that spends it is pressed. Re-asked whenever a target's task is changed,
   * because the actor behind each task charges differently — running the same
   * URL as a website sweep rather than a Facebook Page is a different bill.
   */
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

      {/* Reading it failed — no Anthropic key, or a request the model would not
          guess at. That is precisely when naming the task by hand matters, so
          the picker appears here rather than leaving a dead end. */}
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
                  <li key={`${target.value}-${i}`} className="flex items-start gap-2.5">
                    {/* The task is a choice, not a verdict — reading it wrong
                        should cost a click, not a wasted paid run. */}
                    <select
                      className="shrink-0 border border-line bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-ink/70"
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
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink">{target.value}</p>
                      {target.why && <p className="text-xs text-ink/45">{target.why}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              {estimate && <CostNote estimate={estimate} />}

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

          {/* Nothing came out of the words: say what it is instead of rewording
              it until the reader agrees. */}
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

      {done && (
        <div className="mt-5 border-t border-line pt-5">
          {done.started.length > 0 && (
            <p className="text-sm text-ink/70">
              Started {done.started.length} run{done.started.length === 1 ? "" : "s"}. Leads appear below as they land.
            </p>
          )}
          {done.failed.map((f, i) => (
            <p key={`${f.kind}-${i}`} className="mt-2 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {KIND_LABEL[f.kind as CaptureTargetKind] ?? f.kind}: {f.reason}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Naming the task by hand. Each one says what it takes, because the whole
 * reason to be here is that the guess was wrong or there was nothing to guess
 * from — a second wrong guess helps nobody.
 */
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
      <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Or say what it is</h3>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {tasks.map((entry) => (
          <button
            key={entry.kind}
            type="button"
            onClick={() => {
              onChoose(entry.kind);
              // The words already typed are usually the input itself.
              setValue(seed.trim().split("\n")[0] ?? "");
            }}
            className={`rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.1em] transition ${
              chosen === entry.kind ? "border-ink bg-ink text-cream" : "border-line text-ink/50 hover:border-blue/40 hover:text-ink"
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
          <p className="text-xs text-ink/50">{task.takes}</p>
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
          <p className="mt-1.5 font-mono text-[10px] text-ink/35">runs {task.actorId}</p>
        </form>
      )}
    </div>
  );
}

/**
 * What the run will cost, said before it is spent.
 *
 * Every actor behind quick capture bills per event, and the events are not the
 * results: a Maps search is charged per place *and* per filter applied to each
 * place *and* per site crawled for an email. Nothing in the app said so until
 * the bill arrived, so a "$0.42" here is the difference between a considered
 * click and a surprise at the end of the month.
 *
 * A price that couldn't be read is said out loud rather than shown as zero.
 */
function CostNote({ estimate }: { estimate: CaptureEstimate }) {
  const waste = estimate.tasks.flatMap((task) => task.estimate.waste);

  return (
    <div className="mt-3 border border-line bg-ink/[.02] px-3 py-2">
      <p className="text-sm text-ink/70">
        {estimate.totalUsd == null ? (
          "Apify wouldn't quote a price for this, so it can't be costed in advance."
        ) : (
          <>
            About <strong>${estimate.totalUsd.toFixed(2)}</strong>
            {estimate.partial && " for the parts that could be priced"} on Apify.
          </>
        )}
      </p>
      {estimate.tasks.length > 1 && (
        <ul className="mt-1 space-y-0.5">
          {estimate.tasks.map((task) => (
            <li key={task.kind} className="font-mono text-[10px] uppercase tracking-[.1em] text-ink/40">
              {task.label} × {task.count} —{" "}
              {task.estimate.totalUsd == null ? "not priced" : `$${task.estimate.totalUsd.toFixed(2)}`}
            </li>
          ))}
        </ul>
      )}
      {waste.map((line) => (
        <p key={line} className="mt-1.5 text-xs text-amber-700">
          {line}
        </p>
      ))}
    </div>
  );
}
