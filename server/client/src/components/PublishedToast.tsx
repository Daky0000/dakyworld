import { useEffect, useRef } from "react";

/**
 * A small note in the bottom-right corner after a publish, gone on its own after a few seconds.
 *
 * `tone="wait"` is for a publish that is held up somewhere else (GitHub having
 * problems, a host that is late), and `stay` keeps it up until it is dismissed,
 * because a note that explains a wait must still be there when somebody looks.
 */
export function PublishedToast({ message, href, linkLabel, onClose, tone = "done", stay = false }: {
  message: string;
  href?: string;
  linkLabel: string;
  onClose: () => void;
  tone?: "done" | "wait" | "progress";
  stay?: boolean;
}) {
  // The editor re-renders constantly; the timer must not restart with it.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (stay) return;
    const timer = window.setTimeout(() => close.current(), 8000);
    return () => window.clearTimeout(timer);
  }, [message, stay]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[200] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-xl sm:max-w-md"
    >
      {tone === "progress" ? (
        <span aria-hidden className="inline-flex h-5 w-5 shrink-0 items-center justify-center"><span className="h-2 w-2 animate-pulse rounded-full bg-blue" /></span>
      ) : tone === "wait" ? (
        <span aria-hidden className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-warn-surface text-[11px] font-bold text-warn-text">!</span>
      ) : (
        <span aria-hidden className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-positive-surface text-[11px] text-positive-text">✓</span>
      )}
      <span className="font-semibold">{message}</span>
      {href && (
        <a href={href} {...(href.startsWith("/") ? {} : { target: "_blank", rel: "noreferrer" })} className="whitespace-nowrap text-xs font-semibold text-blue hover:underline">
          {linkLabel}
        </a>
      )}
      <button type="button" onClick={onClose} aria-label="Dismiss" className="ml-1 text-muted hover:text-ink">×</button>
    </div>
  );
}
