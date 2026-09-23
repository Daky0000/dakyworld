import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, apiUrl } from "../lib/api";
import { Button } from "./ui";
import { IconCheck, IconCopy, IconEye, IconList, IconUploadCloud } from "./WebsiteIcons";

export type WebsiteReview = {
  revision: number;
  sourceHash: string;
  publishable: boolean;
  reason?: string | null;
  summary: { id: string; label: string; part: string; from: string; to: string }[];
  problems: { reason: string }[];
  conflicts: unknown[];
  missing: string[];
  mode?: "commit" | "pull_request";
  prTitle?: string;
};

export function PublishReview({
  pageId,
  pending,
  onClose,
  onConfirm,
}: {
  pageId: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: (review: WebsiteReview) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const busy = useRef(pending);
  const [mode, setMode] = useState<"commit" | "pull_request">("commit");
  const [prTitle, setPrTitle] = useState("");
  const [viewTab, setViewTab] = useState<"diff" | "visual">("diff");
  const [copiedLink, setCopiedLink] = useState(false);

  close.current = onClose;
  busy.current = pending;

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busy.current) close.current();
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(
        panel.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
      );
      const first = buttons[0],
        last = buttons.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const review = useQuery({
    queryKey: ["website", "review", pageId],
    queryFn: () => api.get<WebsiteReview>(`/website/pages/${pageId}/review`),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const data = review.data;

  const previewHref = `${window.location.origin}${apiUrl(`/website/pages/${pageId}/preview`)}`;

  const handleCopyPreviewLink = async () => {
    try {
      await navigator.clipboard.writeText(previewHref);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch {
      // Clipboard fallback not required
    }
  };

  return (
    <div
      ref={panel}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 outline-none backdrop-blur-2xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-title"
    >
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-5">
          <div>
            <h2 id="review-title" className="font-display text-xl">
              Review your changes
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              Publishing updates the connected repository. Inspect the diff or live visual preview before continuing.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopyPreviewLink}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-sunken/50 px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-sunken"
              title="Copy a shareable draft preview link for client or team sign-off"
            >
              {copiedLink ? <IconCheck size={13} className="text-emerald-600" /> : <IconCopy size={13} />}
              <span>{copiedLink ? "Preview Link Copied" : "Share Draft Link"}</span>
            </button>
            <div className="inline-flex rounded-xl border border-line bg-sunken/40 p-0.5">
              <button
                type="button"
                onClick={() => setViewTab("diff")}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  viewTab === "diff" ? "bg-ink text-white" : "text-muted hover:text-ink"
                }`}
              >
                <IconList size={13} />
                <span>Changes ({data?.summary.length ?? 0})</span>
              </button>
              <button
                type="button"
                onClick={() => setViewTab("visual")}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  viewTab === "visual" ? "bg-ink text-white" : "text-muted hover:text-ink"
                }`}
              >
                <IconEye size={13} />
                <span>Visual Preview</span>
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {review.isFetching && <p className="text-sm text-muted">Checking the latest source…</p>}
          {review.error && (
            <p role="alert" className="text-sm text-danger-text">
              {(review.error as Error).message}
            </p>
          )}
          {data?.problems.map((problem, i) => (
            <p key={i} role="alert" className="mb-2 text-sm text-danger-text">
              {problem.reason}
            </p>
          ))}
          {!!(data?.conflicts.length || data?.missing.length) && (
            <p role="alert" className="mb-3 text-sm text-danger-text">
              The original page changed. Reopen it and resolve the conflicts before publishing.
            </p>
          )}
          {!review.isFetching &&
            !data?.publishable &&
            !data?.problems.length &&
            !data?.conflicts.length &&
            !data?.missing.length &&
            data?.reason && (
              <p role="status" className="mb-3 text-sm text-muted">
                {data.reason}
              </p>
            )}

          {data?.publishable && (
            <div className="mb-4 rounded-xl border border-line bg-sunken/40 p-3">
              <div className="mb-2 text-xs font-semibold">Publishing Destination</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setMode("commit")}
                  className={`rounded-[10px] px-3 py-1.5 text-xs font-medium transition ${
                    mode === "commit"
                      ? "bg-ink text-white"
                      : "border border-line bg-white text-muted hover:text-ink"
                  }`}
                >
                  Direct to Live Branch
                </button>
                <button
                  type="button"
                  onClick={() => setMode("pull_request")}
                  className={`rounded-[10px] px-3 py-1.5 text-xs font-medium transition ${
                    mode === "pull_request"
                      ? "bg-ink text-white"
                      : "border border-line bg-white text-muted hover:text-ink"
                  }`}
                >
                  Submit as Pull Request (PR)
                </button>
              </div>
              {mode === "pull_request" && (
                <div className="mt-3">
                  <label className="mb-1 block text-[11px] text-muted">Pull Request Title</label>
                  <input
                    type="text"
                    value={prTitle}
                    onChange={(e) => setPrTitle(e.target.value)}
                    placeholder="Update page content"
                    className="w-full rounded-[10px] border border-line bg-white px-2.5 py-1.5 text-xs outline-none focus:border-blue"
                  />
                  <p className="mt-1 text-[11px] text-muted">
                    A review branch will be created and submitted as a GitHub Pull Request for team review.
                  </p>
                </div>
              )}
            </div>
          )}

          {viewTab === "visual" ? (
            <div className="overflow-hidden rounded-xl border border-line bg-sunken">
              <div className="flex items-center justify-between border-b border-line bg-white px-3 py-1.5 text-[11px] text-muted">
                <span>Staged Draft Visual Preview</span>
                <a
                  href={apiUrl(`/website/pages/${pageId}/preview`)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-blue hover:underline"
                >
                  Open in new tab
                </a>
              </div>
              <iframe
                title="Staged draft visual preview"
                src={apiUrl(`/website/pages/${pageId}/preview`)}
                className="h-[420px] w-full border-0 bg-white"
              />
            </div>
          ) : (
            <div className="space-y-3">
              {data?.summary.map((change, i) => (
                <div key={`${change.id}-${i}`} className="rounded-xl border border-line p-3">
                  <p className="mb-2 text-xs font-semibold">
                    {change.label} · {change.part}
                  </p>
                  <div className="grid gap-3 text-xs sm:grid-cols-2">
                    <div className="min-w-0 break-words rounded-xl bg-sunken p-2">
                      <span className="mb-1 block text-[11px] uppercase text-muted">Before</span>
                      {change.from}
                    </div>
                    <div className="min-w-0 break-words rounded-xl bg-blue/5 p-2">
                      <span className="mb-1 block text-[11px] uppercase text-muted">After</span>
                      {change.to}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line p-4">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Keep editing
          </Button>
          <Button
            variant="accent"
            disabled={pending || review.isFetching || !data?.publishable}
            onClick={() => data && onConfirm({ ...data, mode, prTitle: prTitle.trim() || undefined })}
          >
            <span className="inline-flex items-center gap-1.5">
              <IconUploadCloud size={14} />
              <span>
                {pending
                  ? "Publishing…"
                  : mode === "pull_request"
                    ? "Create Pull Request"
                    : "Publish these changes"}
              </span>
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}

