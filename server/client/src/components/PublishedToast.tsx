import { useEffect, useRef } from "react";

/** A small note in the bottom-right corner after a publish, gone on its own after a few seconds. */
export function PublishedToast({ message, href, linkLabel, onClose }: { message: string; href?: string; linkLabel: string; onClose: () => void }) {
  // The editor re-renders constantly; the timer must not restart with it.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const timer = window.setTimeout(() => close.current(), 8000);
    return () => window.clearTimeout(timer);
  }, [message]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[200] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-xl"
    >
      <span aria-hidden className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-positive-surface text-[11px] text-positive-text">✓</span>
      <span className="font-semibold">{message}</span>
      {href && (
        <a href={href} target="_blank" rel="noreferrer" className="whitespace-nowrap text-xs font-semibold text-blue hover:underline">
          {linkLabel}
        </a>
      )}
      <button type="button" onClick={onClose} aria-label="Dismiss" className="ml-1 text-muted hover:text-ink">×</button>
    </div>
  );
}
