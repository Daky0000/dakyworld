import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { Button } from "./ui";

export type WebsiteReview = { revision: number; sourceHash: string; publishable: boolean; reason?: string | null; summary: { id: string; label: string; part: string; from: string; to: string }[]; problems: { reason: string }[]; conflicts: unknown[]; missing: string[] };
export function PublishReview({ pageId, pending, onClose, onConfirm }: { pageId: string; pending: boolean; onClose: () => void; onConfirm: (review: WebsiteReview) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const busy = useRef(pending);
  close.current = onClose;
  busy.current = pending;
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy.current) close.current(); }
      if (event.key !== "Tab") return;
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
      const first = buttons[0], last = buttons.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  const review = useQuery({ queryKey: ["website", "review", pageId], queryFn: () => api.get<WebsiteReview>(`/website/pages/${pageId}/review`), staleTime: 0, refetchOnMount: "always" });
  const data = review.data;
  return <div ref={panel} tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 outline-none" role="dialog" aria-modal="true" aria-labelledby="review-title">
    <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-xl">
      <div className="border-b border-line p-5"><h2 id="review-title" className="font-display text-xl">Review your changes</h2><p className="mt-1 text-sm text-muted">Publishing updates the connected repository. Check what will change before continuing.</p></div>
      <div className="min-h-0 overflow-y-auto p-5">
        {review.isFetching && <p className="text-sm text-muted">Checking the latest source…</p>}
        {review.error && <p role="alert" className="text-sm text-danger-text">{(review.error as Error).message}</p>}
        {data?.problems.map((problem, i) => <p key={i} role="alert" className="mb-2 text-sm text-danger-text">{problem.reason}</p>)}
        {!!(data?.conflicts.length || data?.missing.length) && <p role="alert" className="mb-3 text-sm text-danger-text">The original page changed. Reopen it and resolve the conflicts before publishing.</p>}
        {/* Without this the dialog is an empty box with a dead Publish button,
            which reads as a fault rather than as the answer. */}
        {!review.isFetching && !data?.publishable && !data?.problems.length && !data?.conflicts.length && !data?.missing.length && data?.reason && <p role="status" className="mb-3 text-sm text-muted">{data.reason}</p>}
        <div className="space-y-3">{data?.summary.map((change, i) => <div key={`${change.id}-${i}`} className="rounded-xl border border-line p-3"><p className="mb-2 text-xs font-semibold">{change.label} · {change.part}</p><div className="grid gap-3 text-xs sm:grid-cols-2"><div className="min-w-0 break-words rounded-xl bg-sunken p-2"><span className="mb-1 block text-[10px] uppercase text-muted">Before</span>{change.from}</div><div className="min-w-0 break-words rounded-xl bg-blue/5 p-2"><span className="mb-1 block text-[10px] uppercase text-muted">After</span>{change.to}</div></div></div>)}</div>
      </div>
      <div className="flex justify-end gap-2 border-t border-line p-4"><Button variant="ghost" onClick={onClose} disabled={pending}>Keep editing</Button><Button variant="accent" disabled={pending || review.isFetching || !data?.publishable} onClick={() => data && onConfirm(data)}>{pending ? "Publishing…" : "Publish these changes"}</Button></div>
    </div>
  </div>;
}
