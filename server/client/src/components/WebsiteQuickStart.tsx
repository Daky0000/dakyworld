import { useState } from "react";

const steps = [
  ["Select a heading", "Click a heading on the page. Its words appear in the editing panel."],
  ["Make your first change", "Change the words in the panel, or double-click the heading to type on the page. Wait for Draft saved."],
  ["Check the phone preview", "Choose Phone and Preview. Check that the heading fits and the image still shows what matters."],
  ["Review before publishing", "Choose Publish to review the changes. Nothing goes live until you confirm. Afterwards, wait for Live and open the website."],
];

export function WebsiteQuickStart({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  return <section aria-label="First edit walkthrough" className="flex flex-wrap items-center gap-4 border-b border-line bg-blue/5 px-4 py-3">
    <div className="min-w-0 flex-1" aria-live="polite"><p className="text-sm font-semibold">First edit · {step + 1} of 4: {steps[step][0]}</p><p className="mt-1 text-sm text-muted">{steps[step][1]}</p></div>
    <button type="button" className="px-3 py-2 text-sm" onClick={onClose}>Close guide</button>
    {step > 0 && <button type="button" className="px-3 py-2 text-sm" onClick={() => setStep(step - 1)}>Back</button>}
    <button type="button" className="rounded-xl bg-ink px-4 py-2 text-sm text-white" onClick={() => step === 3 ? onClose() : setStep(step + 1)}>{step === 3 ? "Finish guide" : "Next step"}</button>
  </section>;
}
