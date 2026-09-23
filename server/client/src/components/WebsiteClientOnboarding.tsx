import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Badge, Button } from "./ui";
import { WebsiteGuideModal, type GuideTab } from "./WebsiteGuideModal";

interface OnboardingStep {
  id: string;
  tab: GuideTab;
  title: string;
  description: string;
  actionText: string;
  actionHref?: string;
  actionIsGuide?: boolean;
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "explore",
    tab: "visual",
    title: "1. Explore your pages & live status",
    description: "Review your site structure below. Each page indicates whether it has unpublished draft changes or is up-to-date with your live site.",
    actionText: "Learn about pages",
    actionIsGuide: true,
  },
  {
    id: "brand",
    tab: "visual",
    title: "2. Configure brand presets & styling",
    description: "Set your brand's color palette, typography font pairing, button aesthetics, and border radii in the visual editor's Inspector.",
    actionText: "View design tips",
    actionIsGuide: true,
  },
  {
    id: "edit",
    tab: "visual",
    title: "3. Direct canvas visual editing",
    description: "Click into any page to begin typing on headings and paragraphs in place. Double-click any element to edit text directly on the canvas.",
    actionText: "Visual editing guide",
    actionIsGuide: true,
  },
  {
    id: "sections",
    tab: "sections",
    title: "4. Add or reorder sections & cards",
    description: "Open the Layers drawer in the editor to reorder sections by dragging, or click '+ Add Item' to add repeatable cards and testimonials.",
    actionText: "Section manager guide",
    actionIsGuide: true,
  },
  {
    id: "publish",
    tab: "publishing",
    title: "5. Mobile preview & safe zero-downtime publishing",
    description: "Preview across Desktop, Tablet, and Mobile phone viewports. Review changes in the diff inspector and publish safely with zero downtime.",
    actionText: "Publishing checklist",
    actionIsGuide: true,
  },
];

export function WebsiteClientOnboarding({
  siteId,
  siteName,
  firstPageId,
}: {
  siteId: string;
  siteName: string;
  firstPageId?: string;
}) {
  const storageKey = `website_client_onboarding_${siteId}`;
  const [completedSteps, setCompletedSteps] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [minimized, setMinimized] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`${storageKey}_minimized`) !== "false";
    } catch {
      return false;
    }
  });

  const [guideOpen, setGuideOpen] = useState(false);
  const [guideTab, setGuideTab] = useState<GuideTab>("visual");

  const toggleStep = (stepId: string) => {
    const next = completedSteps.includes(stepId)
      ? completedSteps.filter((id) => id !== stepId)
      : [...completedSteps, stepId];
    setCompletedSteps(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {}
  };

  const handleToggleMinimize = () => {
    const next = !minimized;
    setMinimized(next);
    try {
      localStorage.setItem(`${storageKey}_minimized`, next ? "true" : "false");
    } catch {}
  };

  const openGuideWithTab = (tab: GuideTab) => {
    setGuideTab(tab);
    setGuideOpen(true);
  };

  const progressPercent = Math.round((completedSteps.length / ONBOARDING_STEPS.length) * 100);
  const isAllComplete = completedSteps.length === ONBOARDING_STEPS.length;

  if (minimized) {
    return (
      <div className="mb-6 flex items-center justify-between rounded-2xl border border-line bg-white px-5 py-3 shadow-xs">
        <div className="flex items-center gap-3">

          <div>
            <span className="font-display text-sm font-medium text-ink">
              Website Builder Checklist ({completedSteps.length}/{ONBOARDING_STEPS.length})
            </span>
            <span className="ml-2 text-xs text-muted">
              {progressPercent}% completed
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => openGuideWithTab("visual")}>
            Documentation & Guide
          </Button>
          <Button variant="ghost" size="sm" onClick={handleToggleMinimize}>
            Expand Checklist ↓
          </Button>
        </div>

        <WebsiteGuideModal
          open={guideOpen}
          onClose={() => setGuideOpen(false)}
          initialTab={guideTab}
        />
      </div>
    );
  }

  return (
    <div className="mb-8 rounded-2xl border border-line bg-white p-6  transition-all">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-lime animate-pulse" />
            <span className="font-sans text-[11px] font-bold uppercase tracking-[.06em] text-muted">
              Client Quick Start & Guide
            </span>
            {isAllComplete && <Badge tone="positive">Ready for Launch</Badge>}
          </div>
          <h2 className="mt-1 font-display text-xl font-medium tracking-[-.03em] text-ink">
            Getting Started with {siteName}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            Follow this 5-step checklist to learn the editor, polish content, preview across devices, and publish live.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openGuideWithTab("visual")}
          >
            Open Visual Guide
          </Button>
          {firstPageId && (
            <Link to={`/website/pages/${firstPageId}`}>
              <Button variant="primary" size="sm">
                Open Editor
              </Button>
            </Link>
          )}
          <button
            type="button"
            onClick={handleToggleMinimize}
            className="rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold text-muted hover:border-ink/40 hover:text-ink"
            title="Minimize checklist"
          >
            Minimize
          </button>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mt-4 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              isAllComplete ? "bg-lime" : "bg-blue"
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <span className="font-mono text-xs font-bold text-ink whitespace-nowrap">
          {completedSteps.length} of {ONBOARDING_STEPS.length} completed ({progressPercent}%)
        </span>
      </div>

      {/* Checklist Steps Grid */}
      <div className="mt-5 space-y-2.5">
        {ONBOARDING_STEPS.map((step) => {
          const isDone = completedSteps.includes(step.id);
          return (
            <div
              key={step.id}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5 transition-all ${
                isDone
                  ? "border-line/60 bg-cream/30 text-muted"
                  : "border-line bg-white shadow-xs hover:border-line-strong"
              }`}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => toggleStep(step.id)}
                  className={`mt-0.5 flex min-h-8 min-w-12 px-2 text-[11px] shrink-0 items-center justify-center rounded-[10px] border transition-all ${
                    isDone
                      ? "border-positive bg-positive text-white"
                      : "border-line-strong bg-white hover:border-ink/60"
                  }`}
                  aria-label={isDone ? "Mark incomplete" : "Mark complete"}
                >
                  {isDone ? "Done" : "Mark"}
                </button>

                <div className="min-w-0">
                  <div
                    className={`font-display text-xs font-medium ${
                      isDone ? "line-through text-muted" : "text-ink"
                    }`}
                  >
                    {step.title}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    {step.description}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openGuideWithTab(step.tab)}
                  className="rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold text-blue transition hover:border-blue hover:bg-blue/5"
                >
                  {step.actionText}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Guide Modal */}
      <WebsiteGuideModal
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        initialTab={guideTab}
      />
    </div>
  );
}
