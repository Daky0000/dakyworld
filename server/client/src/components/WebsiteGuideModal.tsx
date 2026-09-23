import { useEffect, useState } from "react";
import { Badge, Button, Modal } from "./ui";

export type GuideTab = "visual" | "sections" | "media" | "ai" | "publishing";

interface TabItem {
  id: GuideTab;
  title: string;
  badge: string;
}

const TABS: TabItem[] = [
  { id: "visual", title: "Visual In-Place Editing", badge: "Core" },
  { id: "sections", title: "Sections & Layouts", badge: "Structure" },
  { id: "media", title: "Images & Media", badge: "Assets" },
  { id: "ai", title: "AI Content Assistant", badge: "Smart" },
  { id: "publishing", title: "Responsive & Publishing", badge: "Deploy" },
];

export function WebsiteGuideModal({
  open,
  onClose,
  initialTab = "visual",
}: {
  open: boolean;
  onClose: () => void;
  initialTab?: GuideTab;
}) {
  const [activeTab, setActiveTab] = useState<GuideTab>(initialTab);
  useEffect(() => { if (open) setActiveTab(initialTab); }, [open, initialTab]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2.5">

          <span>Website Builder Guide & Documentation</span>
        </div>
      }
      subtitle="Master visual editing, section ordering, responsive previews, and zero-downtime publishing."
      size="wide"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>Pro tip:</span>
            <kbd className="rounded-[10px] border border-line bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink">
              Ctrl+S
            </kbd>
            <span>saves your draft instantly</span>
          </div>
          <Button variant="primary" onClick={onClose}>
            Got it, take me to edit
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Navigation Tab Bar */}
        <div className="flex flex-wrap gap-2 border-b border-line pb-3">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`group flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-all duration-150 ${
                  isActive
                    ? "border-ink bg-ink text-white shadow-sm"
                    : "border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
                }`}
              >

                <span>{tab.title}</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[11px] font-sans uppercase ${
                    isActive ? "bg-white/20 text-cream" : "bg-sunken text-muted"
                  }`}
                >
                  {tab.badge}
                </span>
              </button>
            );
          })}
        </div>

        {/* Tab 1: Visual In-Place Editing */}
        {activeTab === "visual" && (
          <div className="space-y-5 animate-in fade-in duration-200">
            <div className="rounded-2xl border border-line bg-white p-5 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-blue">
                <span>01</span>
                <span>Direct Canvas Interaction</span>
              </div>
              <h3 className="mt-1 font-display text-lg font-medium text-ink">
                Point, click, and edit anywhere
              </h3>
              <p className="mt-1 text-sm text-muted">
                Dakyworld OS lets you interact directly with your actual website canvas. Double-click any heading, paragraph, button, or link to type directly on the page in its true typeface and layout.
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-line/80 bg-sunken/60 p-3.5">
                  <div className="font-sans text-[11px] font-bold uppercase tracking-wider text-muted">Step 1</div>
                  <div className="mt-1 text-xs font-bold text-ink">Click to Select</div>
                  <div className="mt-1 text-[11px] text-muted">
                    Clicking once highlights the element bounding box and opens properties in the Inspector.
                  </div>
                </div>

                <div className="rounded-xl border border-line/80 bg-sunken/60 p-3.5">
                  <div className="font-sans text-[11px] font-bold uppercase tracking-wider text-muted">Step 2</div>
                  <div className="mt-1 text-xs font-bold text-ink">Double-Click to Type</div>
                  <div className="mt-1 text-[11px] text-muted">
                    Double-click to activate the live text caret. Your edits push to the draft instantly.
                  </div>
                </div>

                <div className="rounded-xl border border-line/80 bg-sunken/60 p-3.5">
                  <div className="font-sans text-[11px] font-bold uppercase tracking-wider text-muted">Step 3</div>
                  <div className="mt-1 text-xs font-bold text-ink">Rich Text Toolbar</div>
                  <div className="mt-1 text-[11px] text-muted">
                    Select text to reveal formatting options: Bold, Italic, Links, Code, and Clear styles.
                  </div>
                </div>
              </div>
            </div>

            {/* Essential Shortcuts */}
            <div className="rounded-2xl border border-line bg-white p-5 shadow-xs">
              <h4 className="font-display text-sm font-medium text-ink">Essential Keyboard Shortcuts</h4>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="flex items-center justify-between rounded-xl border border-line/60 bg-sunken/40 px-3 py-2 text-xs">
                  <span className="text-muted">Undo last change</span>
                  <div className="flex items-center gap-1">
                    <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[11px]">Ctrl</kbd>
                    <span>+</span>
                    <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[11px]">Z</kbd>
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-line/60 bg-sunken/40 px-3 py-2 text-xs">
                  <span className="text-muted">Redo change</span>
                  <div className="flex items-center gap-1">
                    <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[11px]">Ctrl</kbd>
                    <span>+</span>
                    <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[11px]">Shift</kbd>
                    <span>+</span>
                    <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[11px]">Z</kbd>
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-line/60 bg-sunken/40 px-3 py-2 text-xs">
                  <span className="text-muted">Save draft</span>
                  <div className="flex items-center gap-1">
                    <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[11px]">Ctrl</kbd>
                    <span>+</span>
                    <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[11px]">S</kbd>
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-line/60 bg-sunken/40 px-3 py-2 text-xs">
                  <span className="text-muted">Review & Publish modal</span>
                  <div className="flex items-center gap-1">
                    <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[11px]">Ctrl</kbd>
                    <span>+</span>
                    <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[11px]">Enter</kbd>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Sections & Layouts */}
        {activeTab === "sections" && (
          <div className="space-y-5 animate-in fade-in duration-200">
            <div className="rounded-2xl border border-line bg-white p-5 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-blue">
                <span>02</span>
                <span>Structural Control</span>
              </div>
              <h3 className="mt-1 font-display text-lg font-medium text-ink">
                Reordering & Managing Sections
              </h3>
              <p className="mt-1 text-sm text-muted">
                Your website is structured into semantic sections (Hero, Features, Pricing, Testimonials, FAQ, Footer). Using the <strong>Layers</strong> panel, you can reorganize your entire page in seconds without writing HTML.
              </p>

              <div className="mt-4 space-y-3">
                <div className="flex items-start gap-3 rounded-xl border border-line/70 bg-sunken/40 p-3.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-bold text-white">
                    ↑↓
                  </span>
                  <div>
                    <h5 className="text-xs font-bold text-ink">Drag & Drop Section Reordering</h5>
                    <p className="mt-0.5 text-xs text-muted">
                      Open the <strong>Layers</strong> tab in the sidebar. Click and drag the handle beside any section to reorder it vertically on the live page.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-xl border border-line/70 bg-sunken/40 p-3.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-bold text-white">
                    +
                  </span>
                  <div>
                    <h5 className="text-xs font-bold text-ink">Repeatable Elements & Cards</h5>
                    <p className="mt-0.5 text-xs text-muted">
                      Need to add a 4th team member or another FAQ item? Click the <strong>+ Add Item</strong> button on any repeatable container to spawn a new card with identical styling.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-xl border border-line/70 bg-sunken/40 p-3.5">

                  <div>
                    <h5 className="text-xs font-bold text-ink">Visibility Toggles</h5>
                    <p className="mt-0.5 text-xs text-muted">
                      Temporarily hide seasonal banners or unreleased products by toggling the visibility eye icon in the section header without deleting content.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Images & Media */}
        {activeTab === "media" && (
          <div className="space-y-5 animate-in fade-in duration-200">
            <div className="rounded-2xl border border-line bg-white p-5 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-blue">
                <span>03</span>
                <span>Visual Storytelling</span>
              </div>
              <h3 className="mt-1 font-display text-lg font-medium text-ink">
                Images, Media & Focal Point Framing
              </h3>
              <p className="mt-1 text-sm text-muted">
                Images automatically optimize for fast mobile delivery. You can replace images from your desktop or select from your central site asset library.
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-line/80 bg-sunken/60 p-4">
                  <h5 className="font-display text-xs font-medium text-ink">Asset Library Picker</h5>
                  <p className="mt-1 text-xs text-muted">
                    Click any image field in the Inspector and click <strong>Choose from library</strong> to reuse existing brand logos, hero photography, and product shots.
                  </p>
                </div>

                <div className="rounded-xl border border-line/80 bg-sunken/60 p-4">
                  <h5 className="font-display text-xs font-medium text-ink">Focal Point Crop Control</h5>
                  <p className="mt-1 text-xs text-muted">
                    When images are viewed on phone screens, portrait crops can accidentally cut off faces. Use the <strong>Focal Point</strong> crosshair to ensure critical subjects stay in frame.
                  </p>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-positive-line/50 bg-positive-surface p-3.5 text-xs text-positive-text">
                <span className="font-bold">Automatic Optimization:</span> Images uploaded to Dakyworld are automatically compressed to modern WebP format with EXIF metadata stripped for maximum privacy and performance.
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: AI Content Assistant */}
        {activeTab === "ai" && (
          <div className="space-y-5 animate-in fade-in duration-200">
            <div className="rounded-2xl border border-line bg-white p-5 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-blue">
                <span>04</span>
                <span>Copywriting Superpowers</span>
              </div>
              <h3 className="mt-1 font-display text-lg font-medium text-ink">
                AI Content Assistant
              </h3>
              <p className="mt-1 text-sm text-muted">
                Never get stuck on copy. The built-in AI assistant understands your brand voice, industry, and target market.
              </p>

              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-line/80 bg-sunken/40 p-3.5">
                  <div className="text-xs font-bold text-ink">1. Headline Generator</div>
                  <div className="mt-1 text-xs text-muted">
                    Select a headline, open the Assistant, and ask: <em className="text-ink font-mono text-[11px]">"Make this headline more punchy and focused on B2B clients in Zurich"</em>.
                  </div>
                </div>

                <div className="rounded-xl border border-line/80 bg-sunken/40 p-3.5">
                  <div className="text-xs font-bold text-ink">2. Tone Adjustment</div>
                  <div className="mt-1 text-xs text-muted">
                    Shift paragraph tone between Executive / Professional, Casual / Modern, or High-Conversion Sales with one click.
                  </div>
                </div>

                <div className="rounded-xl border border-line/80 bg-sunken/40 p-3.5">
                  <div className="text-xs font-bold text-ink">3. SEO Meta Descriptions</div>
                  <div className="mt-1 text-xs text-muted">
                    Generate search-engine-friendly meta descriptions that adhere to standard 155-character limits.
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 5: Responsive & Safe Publishing */}
        {activeTab === "publishing" && (
          <div className="space-y-5 animate-in fade-in duration-200">
            <div className="rounded-2xl border border-line bg-white p-5 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-blue">
                <span>05</span>
                <span>Quality & Deployment</span>
              </div>
              <h3 className="mt-1 font-display text-lg font-medium text-ink">
                Responsive Previews & Safe Publishing
              </h3>
              <p className="mt-1 text-sm text-muted">
                Before your changes go live to the world, Dakyworld provides complete multi-device testing and safe diff reviews.
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-line/80 bg-sunken/60 p-3.5 text-center">

                  <div className="mt-1 font-mono text-[11px] font-bold text-ink">Desktop (1280px)</div>
                  <div className="mt-1 text-[11px] text-muted">Full widescreen layout</div>
                </div>

                <div className="rounded-xl border border-line/80 bg-sunken/60 p-3.5 text-center">

                  <div className="mt-1 font-mono text-[11px] font-bold text-ink">Tablet (820px)</div>
                  <div className="mt-1 text-[11px] text-muted">Fluid column wrapping</div>
                </div>

                <div className="rounded-xl border border-line/80 bg-sunken/60 p-3.5 text-center">

                  <div className="mt-1 font-mono text-[11px] font-bold text-ink">Phone (390px)</div>
                  <div className="mt-1 text-[11px] text-muted">Touch targets & legible text</div>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-line/80 bg-white p-4">
                <h5 className="font-display text-xs font-medium text-ink">Publishing Flow</h5>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-muted">
                  <li>Click <strong>Publish</strong> in the top-right toolbar.</li>
                  <li>Review the side-by-side diff summary showing exactly what changed.</li>
                  <li>Confirm publication. Your live CDN updates with zero downtime.</li>
                </ol>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
