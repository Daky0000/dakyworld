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

  if (!job.data) return null;
  const status = job.data;

  if (status.state === "COMPLETED") {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-positive-text">
        <span aria-hidden>✓</span>
        <span>
          Live site updated
          {status.deployedInSeconds !== null && ` — ${status.deployedInSeconds < 90 ? `${status.deployedInSeconds} seconds` : `${Math.round(status.deployedInSeconds / 60)} minutes`} after publishing`}
        </span>
      </p>
    );
  }

  if (WAITING.has(status.state)) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
        <span aria-hidden className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue" />
        <span>Published to the repository. Waiting for the live site to update{status.attempts > 2 ? " — this one is taking longer than usual" : ""}…</span>
      </p>
    );
  }

  return (
    <p className="mt-1.5 text-xs text-warn-text">
      <span aria-hidden>⚠ </span>
      {status.state === "VERIFY_FAILED"
        ? "Published to the repository, but the live website has not updated. The host may not have rebuilt, or it may be serving a cached copy."
        : status.lastError ?? status.label}
    </p>
  );
}
