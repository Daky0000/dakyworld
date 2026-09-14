import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * Whether the thing that was published is actually on the live site.
 *
 * The editor used to say "Published" and mean "committed", which is true and is
 * not what anybody asked. The gap between the two is a static host rebuilding,
 * usually under a minute and occasionally never, and until now the two were
 * indistinguishable from this side — so every slow rebuild looked like a broken
 * publish and every broken one looked like a slow rebuild.
 *
 * The server watches the public page and settles it. This asks, slowly, until it
 * has an answer, and then stops.
 */

export type PublishJobStatus = {
  id: string;
  state: "QUEUED" | "VALIDATING" | "COMMITTING" | "COMMITTED" | "DEPLOYING" | "VERIFYING" | "COMPLETED" | "CONFLICT" | "COMMIT_FAILED" | "DEPLOY_FAILED" | "VERIFY_FAILED" | "RECONCILIATION_REQUIRED";
  label: string;
  /** True when a source file was committed and the host has to build it first. */
  fromSource?: boolean;
  verifyUrl: string | null;
  deployedInSeconds: number | null;
  attempts: number;
  lastError: string | null;
};

const WAITING = new Set(["QUEUED", "VALIDATING", "COMMITTING", "COMMITTED", "DEPLOYING", "VERIFYING"]);

export function PublishStatus({ siteId, jobId }: { siteId: string; jobId: string }) {
  const job = useQuery({
    queryKey: ["website", "publish-job", jobId],
    queryFn: () => api.get<PublishJobStatus>(`/website/sites/${siteId}/publish-jobs/${jobId}`),
    // The server checks on its own minute tick and backs off; this only has to
    // catch up with it, so a slow poll is the polite one.
    refetchInterval: (query) => (query.state.data && WAITING.has(query.state.data.state) ? 15_000 : false),
  });

  if (job.isError) return <p role="alert" className="mt-2 text-sm text-warn-text">Unable to check publishing status. <button type="button" className="underline" onClick={() => void job.refetch()}>Retry status check</button>. Avoid publishing again until you have checked the live site.</p>;
  if (!job.data) return <p role="status" className="mt-2 text-sm text-muted">Loading publishing status…</p>;
  return <PublishProgress status={job.data} />;
}

export function PublishProgress({ status }: { status: PublishJobStatus }) {
  const waiting = WAITING.has(status.state);
  const complete = status.state === "COMPLETED";
  const checking = ["COMMITTED", "DEPLOYING", "VERIFYING", "VERIFY_FAILED", "DEPLOY_FAILED"].includes(status.state);
  const active = complete ? 3 : checking ? 2 : 1;
  const guidance: Partial<Record<PublishJobStatus["state"], string>> = {
    CONFLICT: "The source changed. Reopen the page, resolve the conflict and review again.",
    COMMIT_FAILED: "The changes could not be sent. Ask your website manager to check the repository connection, then review again.",
    DEPLOY_FAILED: "The host could not deploy the change. Ask your website manager to inspect the build log.",
    VERIFY_FAILED: status.fromSource
      ? "The change is committed, but the built site still shows the old version. Check the build on your host — it may have failed, or still be running."
      : "The live update could not be confirmed. Open the website and check your change; your manager can check the host build and cache.",
    RECONCILIATION_REQUIRED: "The result needs checking. Ask your website manager to inspect the recorded commit before retrying, to avoid sending the change twice.",
  };
  let liveUrl: string | null = null;
  try { const url = new URL(status.verifyUrl ?? ""); if (["https:", "http:"].includes(url.protocol)) liveUrl = url.href; } catch { /* No public address. */ }
  return <section aria-label="Publishing progress" className="mt-3 rounded-xl border border-line bg-white p-3">
    <ol className="flex flex-wrap gap-3 text-sm">{["Draft saved", "Publishing", "Checking live site", "Live"].map((label, index) => <li key={label} aria-current={index === active ? "step" : undefined} className={index <= active ? "font-semibold text-ink" : "text-muted"}><span aria-hidden>{index < active || complete ? "✓ " : `${index + 1}. `}</span>{label}</li>)}</ol>
    <p role="status" aria-live="polite" className="mt-2 text-sm">{complete ? "Your changes are live." : waiting ? checking ? status.fromSource ? "Changes committed. Your host is building the site — this usually takes a few minutes." : "Changes sent. Waiting for the live website to update…" : "Sending the reviewed changes…" : guidance[status.state] ?? status.label}</p>
    {!waiting && !complete && status.lastError && <details className="mt-2 text-xs text-muted"><summary>Details for your website manager</summary><p>{status.lastError}</p></details>}
    {liveUrl && <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm text-blue underline">Open live website</a>}
  </section>;
}
