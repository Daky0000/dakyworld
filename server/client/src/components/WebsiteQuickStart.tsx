import { useState } from "react";
import { WebsiteGuideModal } from "./WebsiteGuideModal";

const steps = [
  ["1. Select an element", "Click any heading, body paragraph, button, or image on the canvas. The Inspector sidebar on the right will show its properties."],
  ["2. Make your first change", "Double-click text directly on the page to type live, or adjust fields in the Inspector panel. Notice the live auto-save indicator."],
  ["3. Test responsive viewports", "Switch between Desktop (1280px), Tablet (820px), and Phone (390px) viewports in the top bar to verify layout legibility."],
  ["4. Review before publishing", "Click Publish to inspect the visual diff and verify changes. Nothing goes live to your visitors until you confirm."],
];

export function WebsiteQuickStart({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [fullGuideOpen, setFullGuideOpen] = useState(false);

  return (
    <>
      <section
        aria-label="First edit walkthrough"
        className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-blue/5 px-4 py-3 transition-all"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1" aria-live="polite">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted">
                First edit · {step + 1} of 4
              </span>
              <span className="font-display text-xs font-medium text-ink">
                {steps[step][0]}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {steps[step][1]}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-muted hover:border-ink/40 hover:text-ink transition-all "
            onClick={() => setFullGuideOpen(true)}
          >
            Open guide
          </button>
          {step > 0 && (
            <button
              type="button"
              className="rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-muted hover:border-ink/40 hover:text-ink transition-all "
              onClick={() => setStep(step - 1)}
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="rounded-full bg-ink px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:shadow-lift transition-all "
            onClick={() => (step === steps.length - 1 ? onClose() : setStep(step + 1))}
          >
            {step === steps.length - 1 ? "Finish walkthrough" : "Next step"}
          </button>
          <button
            type="button"
            className="text-xs text-muted hover:text-ink px-2 py-1"
            onClick={onClose}
            title="Dismiss walkthrough"
            aria-label="Close guide"
          >
            Dismiss
          </button>
        </div>
      </section>

      <WebsiteGuideModal
        open={fullGuideOpen}
        onClose={() => setFullGuideOpen(false)}
        initialTab="visual"
      />
    </>
  );
}
