import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { tourSeen, updateUiState, useUiState } from "../lib/uiState";
import { PublishedToast } from "./PublishedToast";
import type { PublishJobStatus } from "./PublishStatus";

const WAITING = new Set(["QUEUED", "VALIDATING", "COMMITTING", "COMMITTED", "DEPLOYING", "VERIFYING"]);
const FAILED = new Set(["DEPLOY_FAILED", "VERIFY_FAILED"]);
/** Offered once per person, after their first publish that took over a minute. */
export const INSTANT_OFFER = "instant-offer";

/** The live address with a throwaway query, so no cached copy answers. */
export function freshUrl(address: string): string {
  try {
    const url = new URL(address);
    url.searchParams.set("dakyx", Date.now().toString(36));
    return url.href;
  } catch {
    return address;
  }
}

/** "40 s", "3 min", "1 h 5 min". */
export function tookFor(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

type Note = { key: string; text: string; tone: "done" | "wait" | "progress"; stay?: boolean; link?: boolean };

const STAGE_TEXT: Record<string, string> = {
  queued: "Changes sent. Your host has queued the rebuild…",
  building: "Changes sent. Your host is building your site…",
  deploying: "Changes sent. Your host is putting it live…",
};

/** What to say about a publish, given the latest word on it. Exported for the harness. */
export function publishNote(status: PublishJobStatus | undefined): Note {
  if (status && WAITING.has(status.state)) {
    // GitHub having problems is the one wait that is nobody's fault here, and
    // the one where somebody is most likely to publish again "to make it work".
    if (status.notice) return { key: "github", text: status.notice, tone: "wait", stay: true };
    if (status.late) return { key: "late", text: status.label, tone: "wait", stay: true, link: true };
    // What the host says it is doing, when it can be read. Stays while it moves:
    // the next note replaces it.
    if (status.stage && STAGE_TEXT[status.stage]) return { key: `stage:${status.stage}`, text: STAGE_TEXT[status.stage]!, tone: "progress", stay: true };
  }
  // WordPress saved it the moment it answered; what is left is the live page
  // (and any page cache in front of it) catching up, not a rebuild.
  if (status?.wordpress && WAITING.has(status.state)) {
    return { key: "wordpress", text: "Saved in WordPress. Checking the live page shows it…", tone: "progress", stay: true };
  }
  if (status?.state === "COMPLETED") {
    return { key: "live", text: status.deployedInSeconds ? `Your changes are live · took ${tookFor(status.deployedInSeconds)}` : "Your changes are live.", tone: "done", link: true };
  }
  if (status && FAILED.has(status.state)) {
    return { key: "failed", text: status.hostMessage ? `${status.label}. Your host said: ${status.hostMessage}` : status.label, tone: "wait", stay: true, link: true };
  }
  const usual = status?.typicalSeconds ? `usually live in about ${tookFor(status.typicalSeconds)}` : "your site rebuilds in a few minutes";
  return { key: "sent", text: `Changes sent. ${usual[0]!.toUpperCase()}${usual.slice(1)}.`, tone: "done", link: true };
}

/**
 * The corner toast for a publish to a site a host rebuilds, which keeps
 * following the publish after the first note has gone.
 *
 * The server watches the live page (websitePublishJobs.ts). This asks it, and
 * speaks again only when there is something new to say: what the host is doing,
 * GitHub having problems, the host being hours late, or the change being live
 * and how long it took. Otherwise it stays quiet, because "Publish just
 * publishes" (Dan, 17 Oct 2026). Each note, once dismissed or timed out, stays
 * gone.
 *
 * After a person's first publish that took over a minute, and only then, the
 * live note offers the one faster route that fits their site.
 */
export function PublishFollow({ siteId, jobId, liveUrl, canManage = false }: { siteId: string; jobId: string; liveUrl?: string | null; canManage?: boolean }) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const uiState = useUiState();
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

  const slow = job.data?.state === "COMPLETED" && (job.data.deployedInSeconds ?? 0) > 60 && job.data.route !== "direct";
  const wantOffer = slow && canManage && !tourSeen(uiState, INSTANT_OFFER);
  const deploy = useQuery({
    queryKey: ["website", "deploy", siteId],
    enabled: wantOffer,
    queryFn: ({ signal }) => api.get<{ offer: { button: string | null; text: string | null } }>(`/website/sites/${siteId}/deploy`, signal),
  });
  const offer = wantOffer && deploy.data?.offer?.button ? deploy.data.offer : null;
  useEffect(() => {
    if (offer) updateUiState({ tours: { [INSTANT_OFFER]: { status: "done", at: new Date().toISOString() } } });
  }, [Boolean(offer)]);

  const base = publishNote(job.data);
  const note: Note = offer && base.key === "live" ? { ...base, key: "live-offer", text: `${base.text}. ${offer.text}`, stay: true } : base;
  if (dismissed.has(note.key)) return null;
  const dismiss = () => setDismissed((current) => new Set(current).add(note.key));
  // Once it is live, the link asks past any copy the browser or the host's CDN
  // kept, so it shows what is really there.
  const live = liveUrl && job.data?.state === "COMPLETED" ? freshUrl(liveUrl) : liveUrl;
  return (
    <PublishedToast
      message={note.text}
      tone={note.tone}
      stay={note.stay}
      href={note.key === "live-offer" ? `/website/settings?site=${encodeURIComponent(siteId)}` : note.link ? live || undefined : undefined}
      linkLabel={note.key === "live-offer" ? offer!.button! : "Open the live page"}
      onClose={dismiss}
    />
  );
}
