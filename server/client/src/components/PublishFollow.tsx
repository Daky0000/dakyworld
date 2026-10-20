import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PublishedToast } from "./PublishedToast";
import type { PublishJobStatus } from "./PublishStatus";

const WAITING = new Set(["QUEUED", "VALIDATING", "COMMITTING", "COMMITTED", "DEPLOYING", "VERIFYING"]);
const FAILED = new Set(["DEPLOY_FAILED", "VERIFY_FAILED"]);

/** "40 s", "3 min", "1 h 5 min". */
export function tookFor(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

type Note = { key: string; text: string; tone: "done" | "wait"; stay?: boolean; link?: boolean };

/** What to say about a publish, given the latest word on it. Exported for the harness. */
export function publishNote(status: PublishJobStatus | undefined): Note {
  if (status && WAITING.has(status.state)) {
    // GitHub having problems is the one wait that is nobody's fault here, and
    // the one where somebody is most likely to publish again "to make it work".
    if (status.notice) return { key: "github", text: status.notice, tone: "wait", stay: true };
    if (status.late) return { key: "late", text: status.label, tone: "wait", stay: true, link: true };
  }
  if (status?.state === "COMPLETED") {
    return { key: "live", text: status.deployedInSeconds ? `Your changes are live · took ${tookFor(status.deployedInSeconds)}` : "Your changes are live.", tone: "done", link: true };
  }
  if (status && FAILED.has(status.state)) return { key: "failed", text: status.label, tone: "wait", stay: true, link: true };
  return { key: "sent", text: "Changes sent. Your site rebuilds in a few minutes.", tone: "done", link: true };
}

/**
 * The corner toast for a publish to a site a host rebuilds, which keeps
 * following the publish after the first note has gone.
 *
 * The server watches the live page (websitePublishJobs.ts). This asks it, and
 * speaks again only when there is something new to say: GitHub is having
 * problems, the host is hours late, or the change is live and how long it took.
 * Otherwise it stays quiet, because "Publish just publishes" (Dan, 17 Oct 2026).
 * Each note, once dismissed or timed out, stays gone.
 */
export function PublishFollow({ siteId, jobId, liveUrl }: { siteId: string; jobId: string; liveUrl?: string | null }) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const job = useQuery({
    queryKey: ["website", "publish-job", jobId],
    queryFn: ({ signal }) => api.get<PublishJobStatus>(`/website/sites/${siteId}/publish-jobs/${jobId}`, signal),
    // The server looks on its own minute tick; this only has to keep up with it.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && !WAITING.has(data.state)) return false;
      const age = data?.createdAt ? Date.now() - new Date(data.createdAt).getTime() : 0;
      return age < 60_000 ? 5_000 : age < 5 * 60_000 ? 15_000 : 60_000;
    },
    retry: 1,
  });

  const note = publishNote(job.data);
  if (dismissed.has(note.key)) return null;
  const dismiss = () => setDismissed((current) => new Set(current).add(note.key));
  return (
    <PublishedToast
      message={note.text}
      tone={note.tone}
      stay={note.stay}
      href={note.link ? liveUrl || undefined : undefined}
      linkLabel="Open the live page"
      onClose={dismiss}
    />
  );
}
