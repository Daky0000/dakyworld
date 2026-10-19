import { useState } from "react";
import { Button, useOverlay } from "./ui";
import { updateUiState } from "../lib/uiState";

/** The record that says this person asked never to see the notice again. */
export const PUBLISH_DELAY_NOTICE = "publish-delay-notice";

/**
 * Shown after a publish to a site that a host rebuilds from the repository.
 *
 * The commit lands at once; the page people visit changes only when the host
 * (GitHub Pages, Netlify, Vercel…) has rebuilt it, which is usually a minute or
 * two and, when that host is having a bad day, much longer (19 Oct 2026: forty
 * minutes behind a GitHub Actions incident). Without this, a publish that worked
 * looks exactly like one that did nothing.
 *
 * It appears **after** the publish, never before it: Publish just publishes
 * (Dan, 17 Oct 2026). "Don't show this again" is kept on the account, so it
 * stays put on every device.
 */
export function PublishDelayNotice({ open, liveUrl, onClose }: { open: boolean; liveUrl?: string | null; onClose: () => void }) {
  const [never, setNever] = useState(false);
  const close = () => {
    if (never) updateUiState({ tours: { [PUBLISH_DELAY_NOTICE]: { status: "dismissed", at: new Date().toISOString() } } });
    onClose();
  };
  const overlay = useOverlay(open, close);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[10002] flex items-end justify-center bg-ink/40 p-4 sm:items-center" onClick={close}>
      <div
        ref={overlay}
        tabIndex={-1}
        data-os-overlay="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-delay-title"
        className="w-full max-w-md rounded-2xl border border-line bg-white p-5 text-ink shadow-2xl outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="publish-delay-title" className="font-display text-lg">Your changes are on their way</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          They have been saved to your website. Your hosting now rebuilds the site, which usually takes a
          minute or two. Sometimes it takes longer, when your host is busy. You don't need to publish again:
          the changes will appear on their own.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Still seeing the old page? Refresh it. Your browser may be showing a copy it saved earlier.
        </p>
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={never} onChange={(event) => setNever(event.target.checked)} className="h-4 w-4 accent-blue" />
          Don't show this again
        </label>
        <div className="mt-5 flex items-center justify-end gap-3">
          {liveUrl && (
            <a href={liveUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold text-blue hover:underline">
              Open the live page
            </a>
          )}
          <Button onClick={close}>Got it</Button>
        </div>
      </div>
    </div>
  );
}
