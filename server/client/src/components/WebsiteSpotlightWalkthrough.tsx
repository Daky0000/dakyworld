import { useEffect, useState, useLayoutEffect, useRef } from "react";
import { Button } from "./ui";

export interface WalkthroughStep {
  id: string;
  title: string;
  targetSelector: string;
  description: string;
  tip?: string;
  actionLabel?: string;
  onAction?: () => void;
  positionPreference?: "bottom" | "top" | "left" | "right";
}

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function WebsiteSpotlightWalkthrough({
  open,
  onClose,
  onComplete,
  onSelectDevice,
  onSelectTab,
  onOpenSections,
  onOpenLayers,
}: {
  open: boolean;
  onClose: () => void;
  onComplete?: () => void;
  onSelectDevice?: (device: "desktop" | "tablet" | "mobile") => void;
  onSelectTab?: (tab: "content" | "layout" | "theme" | "seo" | "style" | "interactions") => void;
  onOpenSections?: () => void;
  onOpenLayers?: () => void;
}) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<SpotlightRect | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const steps: WalkthroughStep[] = [
    {
      id: "canvas",
      title: "1. Visual Canvas & Direct Editing",
      targetSelector: '[data-walkthrough="canvas"]',
      description:
        "This is your live website canvas. Click any text, button, or image directly to inspect it. Double-click headings or paragraphs to type live on the page.",
      tip: "Double-click text to edit in-place without opening menus.",
      positionPreference: "bottom",
    },
    {
      id: "inspector",
      title: "2. Inspector & Live Styling",
      targetSelector: '[data-walkthrough="inspector"]',
      description:
        "Customize typography, color palettes, spacing, border radii, and button presets with instant visual feedback. Your edits save automatically as a private draft.",
      tip: "Use the Style tab for quick colors and typography tokens.",
      positionPreference: "left",
    },
    {
      id: "viewports",
      title: "3. Multi-Device Responsive Viewports",
      targetSelector: '[data-walkthrough="viewports"]',
      description:
        "Switch seamlessly between Desktop (1280px), Tablet (820px), and Mobile Phone (390px) to verify legibility and ensure your site looks great on smartphones.",
      tip: "Over 70% of web traffic is mobile. Always preview at 390px!",
      positionPreference: "bottom",
    },
    {
      id: "layers",
      title: "4. Section Library & Drag-and-Drop Layers",
      targetSelector: '[data-walkthrough="layers"]',
      description:
        "Insert pre-designed sections (Hero banners, Features, Pricing tables, Testimonials, FAQ) or reorder existing sections using the Layers panel.",
      tip: "Sections come pre-styled and adapt to your brand colors automatically.",
      positionPreference: "bottom",
    },
    {
      id: "publish",
      title: "5. Safe Zero-Downtime Publishing",
      targetSelector: '[data-walkthrough="publish"]',
      description:
        "Click Save anytime (Ctrl+S). When you are ready, click Publish to open a before-and-after visual diff review. Nothing changes on your live site until you confirm!",
      tip: "Publishing commits directly to your live CDN with zero downtime.",
      positionPreference: "bottom",
    },
  ];

  const currentStep = steps[currentStepIndex];

  // Update target rect whenever step changes or window resizes
  useLayoutEffect(() => {
    if (!open) return;

    const updateRect = () => {
      if (!currentStep) return;
      const el = document.querySelector(currentStep.targetSelector);
      if (el) {
        const rect = el.getBoundingClientRect();
        // Give a generous, clean highlight margin
        const pad = 6;
        setTargetRect({
          top: Math.max(0, rect.top - pad),
          left: Math.max(0, rect.left - pad),
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
        });
      } else {
        // Fallback to center if element not currently in DOM
        setTargetRect({
          top: window.innerHeight * 0.15,
          left: window.innerWidth * 0.1,
          width: window.innerWidth * 0.8,
          height: window.innerHeight * 0.6,
        });
      }
    };

    updateRect();
    const timer = setTimeout(updateRect, 100);
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [open, currentStepIndex, currentStep]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowRight") {
        handleNext();
      } else if (e.key === "ArrowLeft") {
        handlePrev();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, currentStepIndex]);

  if (!open) return null;

  const handleNext = () => {
    if (currentStepIndex < steps.length - 1) {
      setCurrentStepIndex(currentStepIndex + 1);
    } else {
      handleFinish();
    }
  };

  const handlePrev = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex(currentStepIndex - 1);
    }
  };

  const handleFinish = () => {
    onComplete?.();
    onClose();
  };

  // Calculate card position relative to target
  const getCardStyle = (): React.CSSProperties => {
    if (!targetRect) {
      return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
    }

    const cardWidth = 380;
    const cardHeight = 240;
    const margin = 16;

    // Viewports & Toolbar: place below target
    if (currentStep.positionPreference === "bottom") {
      const top = Math.min(window.innerHeight - cardHeight - 20, targetRect.top + targetRect.height + margin);
      const left = Math.max(margin, Math.min(window.innerWidth - cardWidth - margin, targetRect.left + (targetRect.width / 2) - (cardWidth / 2)));
      return { top: `${top}px`, left: `${left}px` };
    }

    // Inspector: place to the left of the sidebar
    if (currentStep.positionPreference === "left") {
      const top = Math.max(margin, Math.min(window.innerHeight - cardHeight - margin, targetRect.top + 40));
      const left = Math.max(margin, targetRect.left - cardWidth - margin);
      return { top: `${top}px`, left: `${left}px` };
    }

    // Default centered or below
    const top = Math.max(margin, Math.min(window.innerHeight - cardHeight - margin, targetRect.top + targetRect.height + margin));
    const left = Math.max(margin, Math.min(window.innerWidth - cardWidth - margin, targetRect.left + 20));
    return { top: `${top}px`, left: `${left}px` };
  };

  return (
    <div className="fixed inset-0 z-[150] pointer-events-none select-none font-sans" aria-label="Interactive Spotlight Walkthrough">
      {/* Dimmed Overlay with Cutout Spotlight */}
      <svg className="absolute inset-0 h-full w-full pointer-events-auto" style={{ cursor: "default" }}>
        <defs>
          <mask id="spotlight-mask">
            {/* White reveals the dark background */}
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {/* Black cuts out the spotlight hole */}
            {targetRect && (
              <rect
                x={targetRect.left}
                y={targetRect.top}
                width={targetRect.width}
                height={targetRect.height}
                rx="14"
                ry="14"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(15, 23, 42, 0.65)"
          mask="url(#spotlight-mask)"
        />
      </svg>

      {/* Target Highlight Border / Glowing Pulse */}
      {targetRect && (
        <div
          className="absolute pointer-events-none rounded-2xl border-2 border-blue shadow-[0_0_24px_rgba(49,87,255,0.45)] transition-all duration-300 ease-out"
          style={{
            top: `${targetRect.top}px`,
            left: `${targetRect.left}px`,
            width: `${targetRect.width}px`,
            height: `${targetRect.height}px`,
          }}
        />
      )}

      {/* Floating Interactive Guide Card */}
      <div
        ref={cardRef}
        style={getCardStyle()}
        className="pointer-events-auto absolute z-[160] w-[380px] max-w-[calc(100vw-32px)] rounded-2xl border border-line bg-white p-5 shadow-2xl transition-all duration-200 ease-out"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue text-[11px] font-bold text-white">
              {currentStepIndex + 1}
            </span>
            <span className="font-sans text-[11px] font-bold uppercase tracking-wider text-muted">
              Step {currentStepIndex + 1} of {steps.length}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1 text-xs text-muted hover:bg-sunken hover:text-ink"
              title="Close tour"
              aria-label="Close walkthrough"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Title & Description */}
        <h3 className="mt-2.5 font-display text-base font-bold text-ink">
          {currentStep.title}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          {currentStep.description}
        </p>

        {currentStep.tip && (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-blue/5 p-2.5 text-[11px] text-blue-900 border border-blue/10">
            <span className="font-bold text-blue">💡 Tip:</span>
            <span className="leading-snug">{currentStep.tip}</span>
          </div>
        )}

        {/* Interactive Hands-On Action Buttons */}
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5 border-t border-line/60 pt-3">
          {currentStep.id === "viewports" && onSelectDevice && (
            <div className="flex w-full items-center gap-2 mb-2">
              <span className="text-[10px] uppercase font-bold text-muted">Test viewport:</span>
              <button
                type="button"
                onClick={() => onSelectDevice("mobile")}
                className="rounded-lg border border-line px-2 py-1 text-[11px] font-semibold text-ink hover:border-blue hover:text-blue transition"
              >
                📱 Phone (390px)
              </button>
              <button
                type="button"
                onClick={() => onSelectDevice("desktop")}
                className="rounded-lg border border-line px-2 py-1 text-[11px] font-semibold text-ink hover:border-blue hover:text-blue transition"
              >
                💻 Desktop (1280px)
              </button>
            </div>
          )}

          {currentStep.id === "inspector" && onSelectTab && (
            <div className="flex w-full items-center gap-1.5 mb-2">
              <span className="text-[10px] uppercase font-bold text-muted">Tab:</span>
              {(["content", "style", "layout", "theme"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => onSelectTab(tab)}
                  className="rounded-lg border border-line px-2 py-0.5 text-[10px] font-semibold capitalize text-ink hover:border-blue hover:text-blue transition"
                >
                  {tab}
                </button>
              ))}
            </div>
          )}

          {currentStep.id === "layers" && (
            <div className="flex w-full items-center gap-2 mb-2">
              {onOpenSections && (
                <button
                  type="button"
                  onClick={onOpenSections}
                  className="rounded-lg border border-line bg-sunken/40 px-2.5 py-1 text-[11px] font-semibold text-ink hover:border-blue hover:text-blue transition"
                >
                  ➕ Insert Section
                </button>
              )}
              {onOpenLayers && (
                <button
                  type="button"
                  onClick={onOpenLayers}
                  className="rounded-lg border border-line bg-sunken/40 px-2.5 py-1 text-[11px] font-semibold text-ink hover:border-blue hover:text-blue transition"
                >
                  📑 Layers Tree
                </button>
              )}
            </div>
          )}
        </div>

        {/* Navigation & Progress */}
        <div className="mt-3 flex items-center justify-between border-t border-line/60 pt-3">
          <div className="flex items-center gap-1">
            {steps.map((_, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setCurrentStepIndex(idx)}
                className={`h-1.5 rounded-full transition-all ${
                  idx === currentStepIndex ? "w-5 bg-blue" : "w-1.5 bg-slate-200 hover:bg-slate-400"
                }`}
                title={`Go to step ${idx + 1}`}
                aria-label={`Go to step ${idx + 1}`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {currentStepIndex > 0 && (
              <Button size="sm" variant="ghost" onClick={handlePrev}>
                Back
              </Button>
            )}
            <Button size="sm" variant="accent" onClick={handleNext}>
              {currentStepIndex === steps.length - 1 ? "Finish Tour ✓" : "Next Step →"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
