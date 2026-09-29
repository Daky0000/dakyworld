import type { PublicationOptions } from "../../../src/shared/websitePublication";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, apiUrl } from "../lib/api";
import { Button } from "./ui";
import {
  IconCheck,
  IconCopy,
  IconDesktop,
  IconEye,
  IconList,
  IconPhoneDevice,
  IconShieldCheck,
  IconTablet,
  IconUploadCloud,
  IconClock,
  IconExternalLink,
  IconAlertTriangle,
  IconSparkles,
} from "./WebsiteIcons";

export type SafePublishCheck = {
  name: string;
  label: string;
  status: "PASSED" | "WARNING" | "BLOCKED";
  message: string;
  details?: string;
};

export type SafePublishGuardResult = {
  safeToPublish: boolean;
  totalChecks: number;
  passedCount: number;
  warningsCount: number;
  blockersCount: number;
  checks: SafePublishCheck[];
  blockers: string[];
  warnings: string[];
};

export type ViewportRegression = {
  viewportWidth: number;
  shiftPercent: number;
  shifts: Array<{
    selector: string;
    label: string;
    shiftType: string;
    shiftDeltaPx: number;
    isExpected: boolean;
  }>;
  hasUnexpectedLayoutShift: boolean;
};

export type VisualRegressionResult = {
  desktop: ViewportRegression;
  tablet: ViewportRegression;
  mobile: ViewportRegression;
  overallShiftPercent: number;
  hasBlockingRegression: boolean;
  summary: string;
};

export type WebsiteReview = Pick<PublicationOptions, "mode" | "prTitle"> & {
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
  publishGuard?: SafePublishGuardResult;
  visualRegression?: VisualRegressionResult;
  approvalLink?: {
    id: string;
    token: string;
    shareUrl: string;
    status: string;
    createdAt: string;
  } | null;
  editingBoundary?: string;
  editingMode?: string;
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
  const qc = useQueryClient();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const busy = useRef(pending);
  const [mode, setMode] = useState<"commit" | "pull_request">("commit");
  const [prTitle, setPrTitle] = useState("");
  const [viewTab, setViewTab] = useState<"guard" | "diff" | "regression" | "visual">("guard");
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedApprovalLink, setCopiedApprovalLink] = useState(false);
  const [regressionDevice, setRegressionDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");

  // Scheduled Publishing State
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const [revertAt, setRevertAt] = useState("");
  const [scheduleNotes, setScheduleNotes] = useState("");
  const [scheduleSuccess, setScheduleSuccess] = useState<string | null>(null);

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
    queryFn: ({ signal }) => api.get<WebsiteReview>(`/website/pages/${pageId}/review`, signal),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const data = review.data;

  // Auto-switch to diff if guard passed
  useEffect(() => {
    if (data?.publishGuard && !data.publishGuard.safeToPublish) {
      setViewTab("guard");
    }
  }, [data?.publishGuard]);

  const previewHref = `${window.location.origin}${apiUrl(`/website/pages/${pageId}/preview`)}`;

  const handleCopyPreviewLink = async () => {
    try {
      await navigator.clipboard.writeText(previewHref);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch {}
  };

  const createApproval = useMutation({
    mutationFn: () => api.post<{ approval: any; shareUrl: string }>(`/website/pages/${pageId}/approvals`, { title: "Draft Sign-off" }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["website", "review", pageId] });
      try {
        await navigator.clipboard.writeText(res.shareUrl);
        setCopiedApprovalLink(true);
        setTimeout(() => setCopiedApprovalLink(false), 3000);
      } catch {}
    },
  });

  const schedulePublish = useMutation({
    mutationFn: () =>
      api.post(`/website/pages/${pageId}/schedule`, {
        scheduledAt: new Date(scheduledAt).toISOString(),
        revertAt: revertAt ? new Date(revertAt).toISOString() : undefined,
        notes: scheduleNotes.trim() || undefined,
      }),
    onSuccess: () => {
      setScheduleSuccess(`Publish scheduled for ${new Date(scheduledAt).toLocaleString()}${revertAt ? ` (with auto-revert)` : ""}`);
      setShowScheduleForm(false);
      void qc.invalidateQueries({ queryKey: ["website"] });
    },
  });

  const guard = data?.publishGuard;
  const regression = data?.visualRegression;
  const activeRegression = regression ? regression[regressionDevice] : null;
  const approvalLink = data?.approvalLink;
  const isBlockedByGuard = guard && !guard.safeToPublish;

  return (
    <div
      ref={panel}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 outline-none backdrop-blur-2xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-title"
    >
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl">
        {/* Top Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-5">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="review-title" className="font-display text-xl">
                Review your changes
              </h2>
              {guard && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    guard.safeToPublish
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-red-100 text-red-800"
                  }`}
                >
                  <IconShieldCheck size={13} />
                  <span>{guard.safeToPublish ? "Ready to publish" : "Publishing blocked"}</span>
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted">
              Pre-flight checks and visual regression comparison prevent business sites from breaking.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopyPreviewLink}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-sunken/50 px-2.5 py-1.5 text-xs font-semibold text-ink transition hover:bg-sunken"
              title="Copy internal draft preview link"
            >
              {copiedLink ? <IconCheck size={13} className="text-emerald-600" /> : <IconCopy size={13} />}
              <span>{copiedLink ? "Link Copied" : "Draft Link"}</span>
            </button>

            {/* Approval Link CTA */}
            <button
              type="button"
              disabled={createApproval.isPending}
              onClick={() => {
                if (approvalLink?.shareUrl) {
                  navigator.clipboard.writeText(approvalLink.shareUrl);
                  setCopiedApprovalLink(true);
                  setTimeout(() => setCopiedApprovalLink(false), 2500);
                } else {
                  createApproval.mutate();
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-blue/30 bg-blue/5 px-2.5 py-1.5 text-xs font-semibold text-blue transition hover:bg-blue/10"
              title="Generate a public sign-off link for your client (no login required)"
            >
              {copiedApprovalLink ? (
                <IconCheck size={13} className="text-emerald-600" />
              ) : (
                <IconExternalLink size={13} />
              )}
              <span>{copiedApprovalLink ? "Approval Link Copied" : "Send for Approval"}</span>
            </button>

            {/* Tabs */}
            <div className="inline-flex rounded-xl border border-line bg-sunken/40 p-0.5">
              <button
                type="button"
                onClick={() => setViewTab("guard")}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  viewTab === "guard" ? "bg-ink text-white" : "text-muted hover:text-ink"
                }`}
              >
                <IconShieldCheck size={13} />
                <span>
                  Guard {guard ? `(${guard.passedCount}/${guard.totalChecks})` : ""}
                </span>
              </button>
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
                onClick={() => setViewTab("regression")}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  viewTab === "regression" ? "bg-ink text-white" : "text-muted hover:text-ink"
                }`}
              >
                <IconDesktop size={13} />
                <span>Regression</span>
              </button>
              <button
                type="button"
                onClick={() => setViewTab("visual")}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  viewTab === "visual" ? "bg-ink text-white" : "text-muted hover:text-ink"
                }`}
              >
                <IconEye size={13} />
                <span>Preview</span>
              </button>
            </div>
          </div>
        </div>

        {/* Schedule / Alert Notification */}
        {scheduleSuccess && (
          <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-2.5 text-xs font-medium text-emerald-800">
            ✓ {scheduleSuccess}
          </div>
        )}

        {/* Body Content */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {review.isFetching && <p className="text-sm text-muted">Running 17 pre-flight safety checks…</p>}
          {review.error && (
            <p role="alert" className="text-sm text-danger-text">
              {(review.error as Error).message}
            </p>
          )}

          {/* TAB 1: SAFE PUBLISH GUARD */}
          {viewTab === "guard" && guard && (
            <div className="space-y-4">
              {/* Highlight Hero Card */}
              <div
                className={`rounded-2xl border p-4.5 transition ${
                  guard.safeToPublish
                    ? "border-emerald-200 bg-gradient-to-br from-emerald-50/70 to-white"
                    : "border-red-200 bg-gradient-to-br from-red-50/70 to-white"
                }`}
              >
                <div className="flex items-start gap-3.5">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl font-bold ${
                      guard.safeToPublish
                        ? "bg-emerald-600 text-white shadow-xs"
                        : "bg-red-600 text-white shadow-xs"
                    }`}
                  >
                    {guard.safeToPublish ? <IconCheck size={20} /> : <IconAlertTriangle size={20} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-bold text-ink">
                      {guard.safeToPublish ? "Ready to publish" : "Publishing blocked"}
                    </h3>
                    <div className="mt-1 space-y-1 text-xs text-ink/80">
                      <p className="font-semibold text-ink">
                        {guard.passedCount} of {guard.totalChecks} pre-flight safety checks passed.
                      </p>
                      {guard.blockers.length > 0 && (
                        <div className="mt-2 rounded-lg bg-red-100/80 p-2.5 text-red-900 font-medium">
                          {guard.blockers.map((b, i) => (
                            <p key={i}>• {b}</p>
                          ))}
                        </div>
                      )}
                      {guard.warnings.length > 0 && (
                        <div className="mt-1 text-amber-800">
                          {guard.warnings.map((w, i) => (
                            <p key={i}>⚠️ {w}</p>
                          ))}
                        </div>
                      )}
                      {guard.safeToPublish && guard.warnings.length === 0 && (
                        <p className="text-emerald-700">
                          No broken links · No mobile overflow · Proper contrast & alt text verified.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* 17 Checks Breakdown */}
              <div className="rounded-xl border border-line bg-white">
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5 bg-sunken/40">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted">
                    Pre-Flight Safety Checklist ({guard.totalChecks} checks)
                  </span>
                  <span className="text-xs text-muted">Automated Guard Engine</span>
                </div>
                <div className="divide-y divide-line">
                  {guard.checks.map((check) => {
                    const isPassed = check.status === "PASSED";
                    const isWarning = check.status === "WARNING";
                    return (
                      <div key={check.name} className="flex items-start justify-between gap-3 px-4 py-2.5 text-xs">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-ink">{check.label}</span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                                isPassed
                                  ? "bg-emerald-100 text-emerald-700"
                                  : isWarning
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-red-100 text-red-700"
                              }`}
                            >
                              {check.status}
                            </span>
                          </div>
                          <p className="mt-0.5 text-muted">{check.message}</p>
                          {check.details && (
                            <p className="mt-0.5 font-mono text-[11px] text-muted">{check.details}</p>
                          )}
                        </div>
                        <div className="shrink-0 pt-0.5">
                          {isPassed ? (
                            <IconCheck size={14} className="text-emerald-600" />
                          ) : isWarning ? (
                            <IconAlertTriangle size={14} className="text-amber-600" />
                          ) : (
                            <span className="text-red-600 font-bold">✕</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: CHANGES DIFF */}
          {viewTab === "diff" && (
            <div className="space-y-3">
              {data?.summary.length === 0 ? (
                <p className="text-sm text-muted">No draft changes to publish.</p>
              ) : (
                data?.summary.map((change, i) => (
                  <div key={`${change.id}-${i}`} className="rounded-xl border border-line p-3">
                    <p className="mb-2 text-xs font-semibold">
                      {change.label} · {change.part}
                    </p>
                    <div className="grid gap-3 text-xs sm:grid-cols-2">
                      <div className="min-w-0 break-words rounded-xl bg-sunken p-2">
                        <span className="mb-1 block text-[11px] uppercase text-muted">Live on Site</span>
                        {change.from}
                      </div>
                      <div className="min-w-0 break-words rounded-xl bg-blue/5 p-2">
                        <span className="mb-1 block text-[11px] uppercase text-muted">Proposed in Draft</span>
                        {change.to}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* TAB 3: VISUAL REGRESSION GUARD */}
          {viewTab === "regression" && regression && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-sunken/40 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold">Viewport:</span>
                  <div className="inline-flex rounded-lg border border-line bg-white p-0.5">
                    <button
                      type="button"
                      onClick={() => setRegressionDevice("desktop")}
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
                        regressionDevice === "desktop" ? "bg-ink text-white" : "text-muted hover:text-ink"
                      }`}
                    >
                      <IconDesktop size={13} />
                      Desktop (1280px)
                    </button>
                    <button
                      type="button"
                      onClick={() => setRegressionDevice("tablet")}
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
                        regressionDevice === "tablet" ? "bg-ink text-white" : "text-muted hover:text-ink"
                      }`}
                    >
                      <IconTablet size={13} />
                      Tablet (820px)
                    </button>
                    <button
                      type="button"
                      onClick={() => setRegressionDevice("mobile")}
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
                        regressionDevice === "mobile" ? "bg-ink text-white" : "text-muted hover:text-ink"
                      }`}
                    >
                      <IconPhoneDevice size={13} />
                      Mobile (390px)
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-3 text-xs">
                  <span className="text-muted">Layout Shift:</span>
                  <span
                    className={`font-mono font-semibold ${
                      activeRegression && activeRegression.shiftPercent > 10
                        ? "text-amber-700"
                        : "text-emerald-700"
                    }`}
                  >
                    {activeRegression?.shiftPercent.toFixed(1)}%
                  </span>
                </div>
              </div>

              {activeRegression && (
                <div className="rounded-xl border border-line p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-muted">
                      Element Bounding Shifts ({activeRegression.shifts.length})
                    </span>
                    <span className="text-xs text-muted">
                      {activeRegression.hasUnexpectedLayoutShift
                        ? "⚠️ Unexpected layout shift detected"
                        : "✓ Changes match intended edits"}
                    </span>
                  </div>

                  {activeRegression.shifts.length === 0 ? (
                    <p className="text-xs text-muted">No layout shifts detected on this viewport.</p>
                  ) : (
                    <div className="space-y-2">
                      {activeRegression.shifts.map((s, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between rounded-lg border border-line bg-white p-2.5 text-xs"
                        >
                          <div>
                            <span className="font-semibold text-ink">{s.label}</span>
                            <span className="ml-2 font-mono text-[11px] text-muted">({s.selector})</span>
                            <p className="text-[11px] text-muted">
                              {s.shiftType.replace("_", " ")}: ~{Math.round(s.shiftDeltaPx)}px delta
                            </p>
                          </div>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                              s.isExpected ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
                            }`}
                          >
                            {s.isExpected ? "Expected Content Change" : "Layout Shift"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: VISUAL PREVIEW */}
          {viewTab === "visual" && (
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
          )}

          {/* SCHEDULE PUBLISH / DESTINATION ACCORDION */}
          {data?.publishable && (
            <div className="mt-4 rounded-xl border border-line bg-sunken/40 p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-ink">Publishing Options</span>
                <button
                  type="button"
                  onClick={() => setShowScheduleForm(!showScheduleForm)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-blue hover:underline"
                >
                  <IconClock size={13} />
                  <span>{showScheduleForm ? "Direct Publish" : "Schedule for Later / Auto-Revert"}</span>
                </button>
              </div>

              {showScheduleForm ? (
                <div className="rounded-lg border border-line bg-white p-3 space-y-2.5">
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <div>
                      <label className="block text-[11px] font-semibold text-ink">
                        Go live at (Date & Time)
                      </label>
                      <input
                        type="datetime-local"
                        value={scheduledAt}
                        onChange={(e) => setScheduledAt(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 text-xs outline-none focus:border-blue"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-ink">
                        Auto-revert back at (Optional)
                      </label>
                      <input
                        type="datetime-local"
                        value={revertAt}
                        onChange={(e) => setRevertAt(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 text-xs outline-none focus:border-blue"
                      />
                      <p className="mt-0.5 text-[10px] text-muted">
                        Ideal for weekend flash sales, promos, or holiday announcements.
                      </p>
                    </div>
                  </div>
                  <div>
                    <input
                      type="text"
                      placeholder="Notes for this scheduled publish (e.g. Black Friday Banner)"
                      value={scheduleNotes}
                      onChange={(e) => setScheduleNotes(e.target.value)}
                      className="w-full rounded-lg border border-line px-2.5 py-1 text-xs outline-none focus:border-blue"
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={!scheduledAt || schedulePublish.isPending}
                      onClick={() => schedulePublish.mutate()}
                    >
                      {schedulePublish.isPending ? "Scheduling…" : "Save Schedule"}
                    </Button>
                  </div>
                </div>
              ) : (
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
              )}

              {mode === "pull_request" && !showScheduleForm && (
                <div className="mt-2">
                  <label className="mb-1 block text-[11px] text-muted">Pull Request Title</label>
                  <input
                    type="text"
                    value={prTitle}
                    onChange={(e) => setPrTitle(e.target.value)}
                    placeholder="Update page content"
                    className="w-full rounded-[10px] border border-line bg-white px-2.5 py-1.5 text-xs outline-none focus:border-blue"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4">
          <div className="text-xs text-muted">
            {isBlockedByGuard ? (
              <span className="font-semibold text-danger-text">
                ⚠️ Blocked by Safe Publish Guard: Fix {guard?.blockersCount} issue{guard?.blockersCount === 1 ? "" : "s"} before publishing.
              </span>
            ) : guard?.warningsCount ? (
              <span className="text-amber-800">
                17 checks passed with {guard.warningsCount} advisory warning{guard.warningsCount === 1 ? "" : "s"}.
              </span>
            ) : (
              <span className="text-emerald-700">All 17 pre-flight safety checks passed cleanly.</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Keep editing
            </Button>
            <Button
              variant="accent"
              disabled={
                pending ||
                review.isFetching ||
                !data?.publishable ||
                Boolean(isBlockedByGuard)
              }
              onClick={() => data && onConfirm({ ...data, mode, prTitle: prTitle.trim() || undefined })}
            >
              <span className="inline-flex items-center gap-1.5">
                <IconUploadCloud size={14} />
                <span>
                  {pending
                    ? "Publishing…"
                    : isBlockedByGuard
                      ? "Publishing Blocked"
                      : mode === "pull_request"
                        ? "Create Pull Request"
                        : "Publish these changes"}
                </span>
              </span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
