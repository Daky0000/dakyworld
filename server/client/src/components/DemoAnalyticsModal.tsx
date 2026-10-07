import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import type { Demo, DemoAnalyticsReport, DemoVisitSession, DemoVisitClick } from "../lib/types.js";
import { Button, Badge, RelativeTime, CopyButton } from "./ui.js";
import {
  IconAward,
  IconBarChart,
  IconDesktop,
  IconFlame,
  IconGlobe,
  IconMove,
  IconPhoneDevice,
  IconRefresh,
  IconTablet,
  IconTarget,
  IconMaximize,
  IconXCircle,
} from "./WebsiteIcons";

interface DemoAnalyticsModalProps {
  demo: Demo | null;
  open: boolean;
  onClose: () => void;
}

type TabKey = "overview" | "heatmap";
type HeatmapMode = "pins" | "heat" | "both";
type ViewportPreset = "desktop" | "tablet" | "mobile" | "full";

export interface ClickCluster {
  id: string;
  xPercent: number;
  yPercent: number;
  clicks: DemoVisitClick[];
  primaryTag: string;
  primaryText: string;
  count: number;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function DemoAnalyticsModal({ demo, open, onClose }: DemoAnalyticsModalProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [selectedVisitId, setSelectedVisitId] = useState<string>("all");
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>("pins");
  const [viewportPreset, setViewportPreset] = useState<ViewportPreset>("desktop");
  const [activePin, setActivePin] = useState<DemoVisitClick | null>(null);
  const [activeCluster, setActiveCluster] = useState<ClickCluster | null>(null);
  const [clusterPins, setClusterPins] = useState<boolean>(true);
  const [heatRadius, setHeatRadius] = useState<number>(35);
  const [heatIntensity, setHeatIntensity] = useState<number>(0.75);
  const [isInteractiveMode, setIsInteractiveMode] = useState<boolean>(false);
  const [iframeHeight, setIframeHeight] = useState<number>(900);
  const [selectedElementSelector, setSelectedElementSelector] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameContainerRef = useRef<HTMLDivElement | null>(null);

  const { data: report, isLoading, error, refetch } = useQuery<DemoAnalyticsReport>({
    queryKey: ["demo-analytics", demo?.id],
    queryFn: ({ signal }) => api.get<DemoAnalyticsReport>(`/demos/${demo!.id}/analytics`, signal),
    enabled: Boolean(open && demo?.id),
    refetchInterval: open ? 10000 : false,
  });

  // URL for the preview iframe that tells server and tracker not to count admin views
  const previewUrl = useMemo(() => {
    if (!demo?.url) return "";
    const sep = demo.url.includes("?") ? "&" : "?";
    return `${demo.url}${sep}dw_preview=heatmap`;
  }, [demo?.url]);

  // Dynamically measure iframe content height so canvas and pins overlay the full document
  const measureIframe = () => {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc) {
        const scrollH = Math.max(
          doc.documentElement?.scrollHeight || 0,
          doc.body?.scrollHeight || 0,
          850,
        );
        if (scrollH > 100) {
          setIframeHeight(scrollH);
        }
      }
    } catch {
      // Cross-origin fallback keeps default height
    }
  };

  useEffect(() => {
    const timer = setTimeout(measureIframe, 400);
    return () => clearTimeout(timer);
  }, [viewportPreset, activeTab, demo?.url]);

  // Demo pages run sandboxed in an origin of their own, so the frame cannot be
  // measured from here; in heatmap mode the page reports its own height.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; value?: number } | null;
      if (event.source !== iframeRef.current?.contentWindow || data?.source !== "dakyx-demo" || data.type !== "height") return;
      const height = Number(data.value);
      if (Number.isFinite(height) && height > 100 && height < 60_000) setIframeHeight(Math.max(height, 850));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Filter clicks based on selected visit and selected element
  const filteredClicks = useMemo(() => {
    if (!report?.heatmap?.clicks) return [];
    let list = report.heatmap.clicks;
    if (selectedVisitId !== "all") {
      list = list.filter((c) => c.visitId === selectedVisitId);
    }
    if (selectedElementSelector) {
      list = list.filter((c) => (c.targetSelector || c.targetTag) === selectedElementSelector);
    }
    return list;
  }, [report, selectedVisitId, selectedElementSelector]);

  // Group nearby clicks into clusters so multiple clicks on the same button don't stack invisibly
  const clickClusters = useMemo<ClickCluster[]>(() => {
    if (!filteredClicks || filteredClicks.length === 0) return [];
    const clusters: ClickCluster[] = [];
    const thresholdPercent = 2.4; // Radius in percentage space

    for (const click of filteredClicks) {
      const match = clusters.find((c) => {
        const dx = c.xPercent - click.xPercent;
        const dy = c.yPercent - click.yPercent;
        return Math.sqrt(dx * dx + dy * dy) <= thresholdPercent;
      });

      if (match) {
        match.clicks.push(click);
        match.count += 1;
        match.xPercent = (match.xPercent * (match.count - 1) + click.xPercent) / match.count;
        match.yPercent = (match.yPercent * (match.count - 1) + click.yPercent) / match.count;
        if (!match.primaryText && click.targetText) {
          match.primaryText = click.targetText;
        }
      } else {
        clusters.push({
          id: `${click.visitId}-${click.x}-${click.y}-${clusters.length}`,
          xPercent: click.xPercent,
          yPercent: click.yPercent,
          clicks: [click],
          primaryTag: click.targetTag || "ELEMENT",
          primaryText: click.targetText || "",
          count: 1,
        });
      }
    }
    return clusters;
  }, [filteredClicks]);

  // Draw thermal heatmap on canvas matching full iframe document height
  useEffect(() => {
    if (activeTab !== "heatmap" || heatmapMode === "pins") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(iframeHeight));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.clearRect(0, 0, width, height);

    if (filteredClicks.length === 0) return;

    // Draw intensity-scaled radial glow for each click
    const alphaScale = Math.min(1, Math.max(0.2, heatIntensity));

    for (const click of filteredClicks) {
      const x = (click.xPercent / 100) * width;
      const y = (click.yPercent / 100) * height;
      const rad = Math.max(15, heatRadius);

      const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, `rgba(239, 68, 68, ${0.85 * alphaScale})`); // Red hot center
      grad.addColorStop(0.25, `rgba(249, 115, 22, ${0.65 * alphaScale})`); // Orange
      grad.addColorStop(0.55, `rgba(234, 179, 8, ${0.45 * alphaScale})`); // Yellow
      grad.addColorStop(0.8, `rgba(34, 197, 94, ${0.2 * alphaScale})`); // Green
      grad.addColorStop(1, "rgba(59, 130, 246, 0)"); // Fading blue

      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }, [activeTab, heatmapMode, filteredClicks, heatRadius, heatIntensity, viewportPreset, iframeHeight]);

  if (!open || !demo) return null;

  const summary = report?.summary;
  const visits = report?.visits ?? [];
  const breakdowns = report?.breakdowns;
  const topElements = report?.heatmap?.topClickedElements ?? [];

  const viewportWidthClass = {
    desktop: "max-w-[1200px]",
    tablet: "max-w-[768px]",
    mobile: "max-w-[390px]",
    full: "max-w-full",
  }[viewportPreset];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-ink/50 backdrop-blur-sm" onClick={onClose} aria-hidden />

      {/* Modal Dialog */}
      <div className="relative flex h-[92vh] w-full max-w-[96rem] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between border-b border-line bg-white px-6 py-4">
          <div className="min-w-0 pr-4">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-blue/10 px-2.5 py-0.5 text-xs font-semibold text-blue">
                <span className="h-1.5 w-1.5 rounded-full bg-blue animate-pulse" />
                Live Demo Analytics
              </span>
              <span className="text-xs text-muted">/demos/{demo.slug}</span>
            </div>
            <h2 className="mt-1 truncate font-display text-xl tracking-[-.02em] text-ink sm:text-2xl">
              {demo.title || demo.businessName}
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-muted">
              <span>Public link:</span>
              <a
                href={demo.url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-blue hover:underline"
              >
                {demo.url}
              </a>
              <CopyButton text={demo.url} label="Copy Link" />
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Tab switch buttons */}
            <div className="flex rounded-full border border-line bg-surface p-0.5 text-xs font-medium">
              <button
                type="button"
                onClick={() => setActiveTab("overview")}
                className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 transition ${
                  activeTab === "overview"
                    ? "bg-white text-ink shadow-sm font-semibold"
                    : "text-muted hover:text-ink"
                }`}
              >
                <IconBarChart size={13} /> Visitors & Activity
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("heatmap")}
                className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 transition ${
                  activeTab === "heatmap"
                    ? "bg-white text-ink shadow-sm font-semibold"
                    : "text-muted hover:text-ink"
                }`}
              >
                <IconFlame size={13} /> Heatmap & Clicks
                {report?.heatmap?.totalClicks ? (
                  <span className="rounded-full bg-rose-100 px-1.5 py-0.2 text-[10px] font-bold text-rose-700">
                    {report.heatmap.totalClicks}
                  </span>
                ) : null}
              </button>
            </div>

            <Button size="sm" variant="secondary" onClick={() => void refetch()}>
              <span className="flex items-center gap-1.5">
                <IconRefresh size={12} /> Refresh
              </span>
            </Button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-muted transition hover:bg-surface hover:text-ink"
              aria-label="Close"
            >
              <IconXCircle size={18} />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto bg-surface p-5 sm:p-6">
          {isLoading ? (
            <div className="flex h-96 flex-col items-center justify-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue border-t-transparent" />
              <p className="text-sm text-muted">Loading demo analytics and session data…</p>
            </div>
          ) : error ? (
            <div className="rounded-xl border border-danger-line bg-danger-surface p-6 text-center text-sm text-danger-text">
              Failed to load analytics: {(error as Error).message}
            </div>
          ) : (
            <>
              {/* TAB 1: OVERVIEW & VISITOR ACTIVITY */}
              {activeTab === "overview" && (
                <div className="space-y-6">
                  {/* Summary Metric Cards */}
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    {/* Views & Visitors */}
                    <div className="rounded-2xl border border-line bg-white p-4 shadow-xs">
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                        Total Views
                      </div>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="font-display text-3xl font-bold tracking-tight text-ink">
                          {summary?.totalViews ?? 0}
                        </span>
                        <span className="text-xs text-muted">opens</span>
                      </div>
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                        <span>
                          <strong className="text-ink">{summary?.uniqueVisitors ?? 0}</strong> unique visitor{summary?.uniqueVisitors === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>

                    {/* Dwell Time */}
                    <div className="rounded-2xl border border-line bg-white p-4 shadow-xs">
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                        Avg Dwell Time
                      </div>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="font-display text-3xl font-bold tracking-tight text-ink">
                          {formatDuration(summary?.avgDurationSeconds ?? 0)}
                        </span>
                      </div>
                      <div className="mt-2 text-xs text-muted">
                        active reading time per visit
                      </div>
                    </div>

                    {/* Scroll Depth */}
                    <div className="rounded-2xl border border-line bg-white p-4 shadow-xs">
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                        Avg Scroll Depth
                      </div>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="font-display text-3xl font-bold tracking-tight text-ink">
                          {summary?.avgScrollDepth != null ? `${summary.avgScrollDepth}%` : "—"}
                        </span>
                        <span className="text-xs text-muted">
                          {summary?.avgScrollDepth != null ? "of page" : "unavailable"}
                        </span>
                      </div>
                      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-line">
                        <div
                          className="h-full rounded-full bg-blue"
                          style={{ width: `${Math.min(100, summary?.avgScrollDepth ?? 0)}%` }}
                        />
                      </div>
                    </div>

                    {/* Heatmap & Clicks */}
                    <div className="rounded-2xl border border-line bg-white p-4 shadow-xs">
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                        Interactions & Clicks
                      </div>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="font-display text-3xl font-bold tracking-tight text-rose-600">
                          {summary?.totalClicks ?? 0}
                        </span>
                        <span className="text-xs text-muted">clicks recorded</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-muted">
                        <span>Bounce rate:</span>
                        <span className="font-semibold text-ink">{summary?.bounceRate ?? 0}%</span>
                      </div>
                    </div>
                  </div>

                  {/* Distribution Breakdowns */}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {/* Country Distribution */}
                    <div className="rounded-2xl border border-line bg-white p-5 shadow-xs">
                      <h3 className="flex items-center gap-1.5 font-display text-sm font-bold text-ink">
                        <IconGlobe size={14} /> Visitor Countries
                      </h3>
                      <p className="mt-0.5 text-xs text-muted">
                        Resolved via IP, CDN edge & locale
                      </p>
                      <div className="mt-4 space-y-3">
                        {breakdowns?.countries && breakdowns.countries.length > 0 ? (
                          breakdowns.countries.map((c) => (
                            <div key={c.code} className="space-y-1">
                              <div className="flex items-center justify-between text-xs">
                                <span className="flex items-center gap-1.5 font-medium text-ink">
                                  <span className="text-base">{c.flag}</span>
                                  <span>{c.name}</span>
                                </span>
                                <span className="font-mono text-muted">
                                  {c.count} visit{c.count === 1 ? "" : "s"} ({c.percentage}%)
                                </span>
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/60">
                                <div
                                  className="h-full rounded-full bg-blue"
                                  style={{ width: `${c.percentage}%` }}
                                />
                              </div>
                            </div>
                          ))
                        ) : (
                          <p className="py-4 text-center text-xs text-muted">No location data yet.</p>
                        )}
                      </div>
                    </div>

                    {/* City Distribution */}
                    <div className="rounded-2xl border border-line bg-white p-5 shadow-xs">
                      <h3 className="flex items-center gap-1.5 font-display text-sm font-bold text-ink">
                        <IconTarget size={14} className="text-blue" /> Top Cities & Metros
                      </h3>
                      <p className="mt-0.5 text-xs text-muted">
                        Measured visitor cities (edge-verified)
                      </p>
                      <div className="mt-4 space-y-3">
                        {breakdowns?.cities && breakdowns.cities.length > 0 ? (
                          breakdowns.cities.map((city: any) => (
                            <div key={`${city.city}-${city.region}-${city.country}`} className="space-y-1">
                              <div className="flex items-center justify-between text-xs">
                                <span className="flex items-center gap-1.5 font-medium text-ink">
                                  <span className="text-base">{city.flag}</span>
                                  <span>{[city.city, city.region].filter(Boolean).join(", ") || "City unavailable"}</span>
                                  {city.unverified ? (
                                    <span className="rounded bg-amber-50 px-1 py-0.2 font-mono text-[9px] font-semibold text-amber-700">
                                      Unverified
                                    </span>
                                  ) : null}
                                </span>
                                <span className="font-mono text-muted">
                                  {city.count} ({city.percentage}%)
                                </span>
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/60">
                                <div
                                  className="h-full rounded-full bg-indigo-500"
                                  style={{ width: `${city.percentage}%` }}
                                />
                              </div>
                            </div>
                          ))
                        ) : (
                          <p className="py-4 text-center text-xs text-muted">City data unavailable without edge lookup.</p>
                        )}
                      </div>
                    </div>

                    {/* Device Types */}
                    <div className="rounded-2xl border border-line bg-white p-5 shadow-xs">
                      <h3 className="flex items-center gap-1.5 font-display text-sm font-bold text-ink">
                        <IconPhoneDevice size={14} /> Devices Opened With
                      </h3>
                      <p className="mt-0.5 text-xs text-muted">
                        Mobile, tablet, or desktop devices
                      </p>
                      <div className="mt-4 space-y-3">
                        {breakdowns?.devices && breakdowns.devices.length > 0 ? (
                          breakdowns.devices.map((d) => {
                            const DeviceIcon = d.deviceType === "mobile" ? IconPhoneDevice : d.deviceType === "tablet" ? IconTablet : IconDesktop;
                            const label = d.deviceType.charAt(0).toUpperCase() + d.deviceType.slice(1);
                            return (
                              <div key={d.deviceType} className="space-y-1">
                                <div className="flex items-center justify-between text-xs">
                                  <span className="flex items-center gap-1.5 font-medium text-ink">
                                    <DeviceIcon size={13} className="text-muted" />
                                    <span>{label}</span>
                                  </span>
                                  <span className="font-mono text-muted">
                                    {d.count} ({d.percentage}%)
                                  </span>
                                </div>
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/60">
                                  <div
                                    className="h-full rounded-full bg-emerald-500"
                                    style={{ width: `${d.percentage}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <p className="py-4 text-center text-xs text-muted">No device data yet.</p>
                        )}
                      </div>
                    </div>

                    {/* Browsers & OS */}
                    <div className="rounded-2xl border border-line bg-white p-5 shadow-xs">
                      <h3 className="flex items-center gap-1.5 font-display text-sm font-bold text-ink">
                        <IconGlobe size={14} /> Browsers & Platforms
                      </h3>
                      <p className="mt-0.5 text-xs text-muted">Client software details</p>
                      <div className="mt-4 space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                          Top Browsers
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {breakdowns?.browsers && breakdowns.browsers.length > 0 ? (
                            breakdowns.browsers.map((b) => (
                              <span
                                key={b.browser}
                                className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink"
                              >
                                <strong>{b.browser}</strong>
                                <span className="text-muted">({b.count})</span>
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted">None</span>
                          )}
                        </div>

                        <div className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                          Operating Systems
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {breakdowns?.os && breakdowns.os.length > 0 ? (
                            breakdowns.os.map((o) => (
                              <span
                                key={o.os}
                                className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink"
                              >
                                <strong>{o.os}</strong>
                                <span className="text-muted">({o.count})</span>
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted">None</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Visitor Sessions Log Table */}
                  <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-xs">
                    <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
                      <div>
                        <h3 className="font-display text-base font-bold text-ink">
                          Individual Visitor Sessions
                        </h3>
                        <p className="text-xs text-muted">
                          Complete log of prospects who clicked and opened this proposal
                        </p>
                      </div>
                      <span className="font-mono text-xs text-muted">
                        {visits.length} session{visits.length === 1 ? "" : "s"} logged
                      </span>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="border-b border-line bg-surface/60 font-sans text-[11px] uppercase tracking-wider text-muted">
                          <tr>
                            <th className="px-4 py-3">Opened</th>
                            <th className="px-4 py-3">Location & City</th>
                            <th className="px-4 py-3">IP Address</th>
                            <th className="px-4 py-3">Device & Browser</th>
                            <th className="px-4 py-3">Viewport</th>
                            <th className="px-4 py-3">Time Spent</th>
                            <th className="px-4 py-3">Scroll Depth</th>
                            <th className="px-4 py-3">Clicks</th>
                            <th className="px-4 py-3 text-right">Heatmap</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line/60">
                          {visits.length > 0 ? (
                            visits.map((visit) => {
                              const DeviceIcon =
                                visit.deviceType === "mobile"
                                  ? IconPhoneDevice
                                  : visit.deviceType === "tablet"
                                    ? IconTablet
                                    : IconDesktop;

                              const locText = visit.city
                                ? `${visit.city}, ${visit.countryName || visit.country || ""}`
                                : visit.countryName || visit.country || "Unknown location";

                              return (
                                <tr key={visit.id} className="transition hover:bg-surface/40">
                                  {/* Opened */}
                                  <td className="whitespace-nowrap px-4 py-3 font-mono text-ink">
                                    <RelativeTime value={visit.createdAt} />
                                  </td>

                                  {/* Location & City */}
                                  <td className="whitespace-nowrap px-4 py-3">
                                    <span className="flex items-center gap-1.5 font-medium text-ink">
                                      {visit.flag ? (
                                        <span className="text-base">{visit.flag}</span>
                                      ) : (
                                        <IconGlobe size={14} className="text-muted" />
                                      )}
                                      <span>{locText}</span>
                                      <span className="text-[10px] text-muted">{visit.locationLabel}</span>
                                      {!visit.city && (visit.countryName || visit.country) ? (
                                        <span className="text-[10px] text-muted">(City unavailable)</span>
                                      ) : null}
                                      {visit.citySource === "legacy" ? (
                                        <span className="rounded bg-amber-50 px-1 py-0.2 font-mono text-[9px] font-semibold text-amber-700">
                                          Unverified
                                        </span>
                                      ) : null}
                                      {visit.isLocal ? (
                                        <span className="rounded bg-neutral-100 px-1.5 py-0.2 font-mono text-[9px] font-semibold text-neutral-600">
                                          Local
                                        </span>
                                      ) : null}
                                    </span>
                                  </td>

                                  {/* IP Address */}
                                  <td className="whitespace-nowrap px-4 py-3 font-mono text-muted">
                                    <div className="flex items-center gap-1.5">
                                      <span>{visit.ip || "—"}</span>
                                      {visit.ip && <CopyButton text={visit.ip} label="" />}
                                    </div>
                                  </td>

                                  {/* Device & Browser */}
                                  <td className="whitespace-nowrap px-4 py-3">
                                    <div className="flex items-center gap-1.5 text-ink">
                                      <DeviceIcon size={14} className="text-muted" />
                                      <span className="font-semibold">{visit.browser || "Unknown"}</span>
                                      <span className="text-muted">on</span>
                                      <span className="text-muted">{visit.os || "OS"}</span>
                                    </div>
                                  </td>

                                  {/* Viewport */}
                                  <td className="whitespace-nowrap px-4 py-3 font-mono text-muted">
                                    {visit.viewportWidth && visit.viewportHeight
                                      ? `${visit.viewportWidth}×${visit.viewportHeight}`
                                      : "—"}
                                  </td>

                                  {/* Time spent */}
                                  <td className="whitespace-nowrap px-4 py-3">
                                    <span
                                      className={`inline-flex rounded-full px-2 py-0.5 font-mono font-medium ${
                                        visit.durationSeconds >= 60
                                          ? "bg-emerald-50 text-emerald-700"
                                          : visit.durationSeconds >= 10
                                            ? "bg-blue-50 text-blue-700"
                                            : "bg-surface text-muted"
                                      }`}
                                    >
                                      {formatDuration(visit.durationSeconds)}
                                    </span>
                                  </td>

                                  {/* Scroll Depth */}
                                  <td className="whitespace-nowrap px-4 py-3 font-mono text-ink">
                                    <div className="flex items-center gap-2">
                                      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-line">
                                        <div
                                          className="h-full rounded-full bg-blue"
                                          style={{ width: `${visit.scrollDepth}%` }}
                                        />
                                      </div>
                                      <span>{visit.scrollDepth}%</span>
                                    </div>
                                  </td>

                                  {/* Clicks */}
                                  <td className="whitespace-nowrap px-4 py-3">
                                    {visit.clickCount > 0 ? (
                                      <Badge tone="default">
                                        {visit.clickCount} click{visit.clickCount === 1 ? "" : "s"}
                                      </Badge>
                                    ) : (
                                      <span className="text-muted">0</span>
                                    )}
                                  </td>

                                  {/* Heatmap action */}
                                  <td className="whitespace-nowrap px-4 py-3 text-right">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedVisitId(visit.id);
                                        setActiveTab("heatmap");
                                      }}
                                      className="font-sans text-[11px] font-semibold text-blue hover:underline"
                                    >
                                      Inspect Heatmap →
                                    </button>
                                  </td>
                                </tr>
                              );
                            })
                          ) : (
                            <tr>
                              <td colSpan={9} className="py-8 text-center text-sm text-muted">
                                No visitor sessions logged yet. Share the demo link to begin tracking!
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: INTERACTIVE HEATMAP & CLICK MAP */}
              {activeTab === "heatmap" && (
                <div className="flex flex-col gap-4">
                  {/* Heatmap Controls Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white p-3.5 shadow-xs">
                    {/* Viewport Preset */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-muted">Screen View:</span>
                      <div className="flex rounded-full border border-line bg-surface p-0.5 text-xs">
                        <button
                          type="button"
                          onClick={() => setViewportPreset("desktop")}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition ${
                            viewportPreset === "desktop"
                              ? "bg-white font-semibold text-ink shadow-xs"
                              : "text-muted hover:text-ink"
                          }`}
                        >
                          <IconDesktop size={13} />
                          <span>Desktop (1200px)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewportPreset("tablet")}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition ${
                            viewportPreset === "tablet"
                              ? "bg-white font-semibold text-ink shadow-xs"
                              : "text-muted hover:text-ink"
                          }`}
                        >
                          <IconTablet size={13} />
                          <span>Tablet (768px)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewportPreset("mobile")}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition ${
                            viewportPreset === "mobile"
                              ? "bg-white font-semibold text-ink shadow-xs"
                              : "text-muted hover:text-ink"
                          }`}
                        >
                          <IconPhoneDevice size={13} />
                          <span>Mobile (390px)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewportPreset("full")}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition ${
                            viewportPreset === "full"
                              ? "bg-white font-semibold text-ink shadow-xs"
                              : "text-muted hover:text-ink"
                          }`}
                        >
                          <IconMaximize size={13} />
                          <span>Full Width</span>
                        </button>
                      </div>
                    </div>

                    {/* Overlay Mode */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-muted">Overlay:</span>
                      <div className="flex rounded-full border border-line bg-surface p-0.5 text-xs">
                        <button
                          type="button"
                          onClick={() => setHeatmapMode("pins")}
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
                            heatmapMode === "pins"
                              ? "bg-white font-semibold text-ink shadow-xs"
                              : "text-muted hover:text-ink"
                          }`}
                        >
                          <IconTarget size={13} />
                          <span>Click Pins</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setHeatmapMode("heat")}
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
                            heatmapMode === "heat"
                              ? "bg-white font-semibold text-ink shadow-xs"
                              : "text-muted hover:text-ink"
                          }`}
                        >
                          <IconFlame size={13} />
                          <span>Thermal Glow</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setHeatmapMode("both")}
                          className={`rounded-full px-3 py-1 transition ${
                            heatmapMode === "both"
                              ? "bg-white font-semibold text-ink shadow-xs"
                              : "text-muted hover:text-ink"
                          }`}
                        >
                          Combined
                        </button>
                      </div>
                    </div>

                    {/* Filter by Visitor Session */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-muted">Visitor:</span>
                      <select
                        value={selectedVisitId}
                        onChange={(e) => setSelectedVisitId(e.target.value)}
                        className="rounded-full border border-line bg-white px-3 py-1 text-xs text-ink outline-none focus:border-blue"
                      >
                        <option value="all">
                          All Visitors ({report?.heatmap?.totalClicks ?? 0} clicks)
                        </option>
                        {visits.map((v) => {
                          const labelLoc = v.locationLabel || "Unknown location";
                          return (
                            <option key={v.id} value={v.id}>
                              {labelLoc} ({v.deviceType || "Device"}) — {v.clickCount} clicks
                            </option>
                          );
                        })}
                      </select>
                    </div>

                    {/* Cluster Toggle */}
                    {(heatmapMode === "pins" || heatmapMode === "both") && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setClusterPins(!clusterPins)}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
                            clusterPins
                              ? "border-blue bg-blue/10 text-blue font-semibold"
                              : "border-line bg-white text-muted hover:text-ink"
                          }`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${clusterPins ? "bg-blue" : "bg-neutral-300"}`} />
                          <span>Group Clustered Clicks</span>
                        </button>
                      </div>
                    )}

                    {/* Interaction Mode Toggle */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setIsInteractiveMode(!isInteractiveMode)}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
                          isInteractiveMode
                            ? "border-emerald-600 bg-emerald-50 text-emerald-700 font-semibold"
                            : "border-line bg-white text-muted hover:text-ink"
                        }`}
                        title="Allow clicking inside demo page"
                      >
                        <span>{isInteractiveMode ? "Interactive Demo ON" : "Heatmap Inspector Active"}</span>
                      </button>
                    </div>

                    {/* Heat Radius and Intensity Sliders */}
                    {(heatmapMode === "heat" || heatmapMode === "both") && (
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="flex items-center gap-1.5 text-xs text-muted">
                          <span>Radius:</span>
                          <input
                            type="range"
                            min="20"
                            max="80"
                            value={heatRadius}
                            onChange={(e) => setHeatRadius(Number(e.target.value))}
                            className="h-1.5 w-20 cursor-pointer accent-blue"
                          />
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted">
                          <span>Glow:</span>
                          <input
                            type="range"
                            min="0.3"
                            max="1"
                            step="0.05"
                            value={heatIntensity}
                            onChange={(e) => setHeatIntensity(Number(e.target.value))}
                            className="h-1.5 w-20 cursor-pointer accent-rose-500"
                          />
                        </div>
                      </div>
                    )}

                    {selectedElementSelector && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setSelectedElementSelector(null)}
                      >
                        Clear Filter ({selectedElementSelector})
                      </Button>
                    )}
                  </div>

                  {/* Main Heatmap Container */}
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
                    {/* Visual Preview Frame & Overlay */}
                    <div className="lg:col-span-3 flex justify-center rounded-2xl border border-line bg-neutral-900/5 p-4">
                      {/* Synchronized Scroll Container */}
                      <div
                        ref={frameContainerRef}
                        className={`relative w-full ${viewportWidthClass} max-h-[74vh] overflow-y-auto overflow-x-hidden rounded-xl border border-line/80 bg-white shadow-lg transition-all duration-300`}
                        style={{ minHeight: "680px" }}
                      >
                        {/* Live Demo Preview Iframe */}
                        <iframe
                          ref={iframeRef}
                          src={previewUrl}
                          title={demo.title}
                          onLoad={measureIframe}
                          className="w-full border-0 transition-all duration-150"
                          style={{
                            height: `${iframeHeight}px`,
                            pointerEvents: isInteractiveMode ? "auto" : "none",
                          }}
                        />

                        {/* Thermal Canvas Layer */}
                        {(heatmapMode === "heat" || heatmapMode === "both") && (
                          <canvas
                            ref={canvasRef}
                            className="pointer-events-none absolute inset-0 z-10 w-full opacity-85"
                            style={{ height: `${iframeHeight}px` }}
                          />
                        )}

                        {/* Interactive Click Pins Layer */}
                        {(heatmapMode === "pins" || heatmapMode === "both") && !isInteractiveMode && (
                          <div
                            className="absolute inset-0 z-20 pointer-events-none"
                            style={{ height: `${iframeHeight}px` }}
                          >
                            {clusterPins ? (
                              /* Clustered Pins View */
                              clickClusters.map((cluster, idx) => (
                                <button
                                  key={`cluster-${cluster.id}-${idx}`}
                                  type="button"
                                  onClick={() => {
                                    setActiveCluster(cluster);
                                    setActivePin(cluster.clicks[0] ?? null);
                                  }}
                                  style={{
                                    left: `${cluster.xPercent}%`,
                                    top: `${cluster.yPercent}%`,
                                    transform: "translate(-50%, -50%)",
                                  }}
                                  className={`pointer-events-auto group absolute flex items-center justify-center rounded-full text-white shadow-lg ring-2 ring-white transition hover:scale-125 ${
                                    cluster.count > 3
                                      ? "h-7 w-7 bg-rose-600 font-extrabold text-[11px] ring-rose-200"
                                      : cluster.count > 1
                                        ? "h-6 w-6 bg-amber-600 font-bold text-[10px] ring-amber-200"
                                        : "h-5 w-5 bg-blue font-bold text-[10px] ring-blue/30"
                                  }`}
                                  title={`${cluster.count} click${cluster.count === 1 ? "" : "s"} on ${cluster.primaryTag} "${cluster.primaryText}"`}
                                >
                                  {cluster.count > 1 ? `${cluster.count}×` : `${idx + 1}`}
                                </button>
                              ))
                            ) : (
                              /* Individual Raw Pins View */
                              filteredClicks.map((click, idx) => (
                                <button
                                  key={`${click.visitId}-${idx}-${click.x}-${click.y}`}
                                  type="button"
                                  onClick={() => {
                                    setActivePin(click);
                                    setActiveCluster(null);
                                  }}
                                  style={{
                                    left: `${click.xPercent}%`,
                                    top: `${click.yPercent}%`,
                                    transform: "translate(-50%, -50%)",
                                  }}
                                  className="pointer-events-auto group absolute flex h-6 w-6 items-center justify-center rounded-full bg-rose-600 text-[10px] font-bold text-white shadow-md ring-2 ring-white transition hover:scale-125 hover:bg-rose-700 hover:ring-4 hover:ring-rose-200"
                                  title={`Click #${idx + 1}: ${click.targetTag} "${click.targetText}"`}
                                >
                                  {idx + 1}
                                </button>
                              ))
                            )}
                          </div>
                        )}

                        {/* Floating Click Details Card (when a pin or cluster is clicked) */}
                        {(activePin || activeCluster) && (
                          <div className="sticky bottom-4 left-4 right-4 mx-4 z-30 max-w-lg rounded-xl border border-line bg-white/95 p-4 shadow-2xl backdrop-blur-md">
                            <div className="flex items-start justify-between">
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="inline-block rounded-md bg-rose-100 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-rose-800">
                                    {activeCluster?.primaryTag || activePin?.targetTag || "ELEMENT"}
                                  </span>
                                  {activeCluster && activeCluster.count > 1 && (
                                    <span className="rounded-md bg-amber-100 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-900">
                                      {activeCluster.count} Combined Clicks
                                    </span>
                                  )}
                                </div>
                                <h4 className="mt-1 font-semibold text-ink text-sm">
                                  {activeCluster?.primaryText
                                    ? `"${activeCluster.primaryText}"`
                                    : activePin?.targetText
                                      ? `"${activePin.targetText}"`
                                      : "Target element clicked"}
                                </h4>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setActivePin(null);
                                  setActiveCluster(null);
                                }}
                                className="text-muted hover:text-ink"
                              >
                                <IconXCircle size={16} />
                              </button>
                            </div>

                            {activePin && (
                              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted border-t border-line/50 pt-2.5">
                                <div>
                                  <span>Location: </span>
                                  <strong className="inline-flex items-center gap-1 text-ink">
                                    <span>{activePin.flag || "🌐"}</span>
                                    <span>
                                      {activePin.locationLabel || "Unknown location"}
                                    </span>
                                  </strong>
                                </div>
                                <div>
                                  <span>Device: </span>
                                  <strong className="text-ink">
                                    {activePin.deviceType} ({activePin.browser})
                                  </strong>
                                </div>
                                <div>
                                  <span>Coordinates: </span>
                                  <strong className="font-mono text-ink">
                                    x: {activePin.xPercent}%, y: {activePin.yPercent}%
                                  </strong>
                                </div>
                                <div>
                                  <span>Timing: </span>
                                  <strong className="text-ink">
                                    +{formatDuration(activePin.timeOffset ?? 0)} into visit
                                  </strong>
                                </div>
                              </div>
                            )}

                            {activeCluster && activeCluster.count > 1 && (
                              <div className="mt-3 border-t border-line/60 pt-2">
                                <div className="text-[11px] font-semibold text-ink uppercase tracking-wider">
                                  Clicks in this hot spot:
                                </div>
                                <div className="mt-1.5 max-h-28 overflow-y-auto space-y-1 pr-1 text-[11px]">
                                  {activeCluster.clicks.map((c, i) => (
                                    <div
                                      key={`${c.visitId}-${i}`}
                                      className="flex items-center justify-between rounded bg-surface px-2 py-1"
                                    >
                                      <span className="flex items-center gap-1 text-ink">
                                        <span>{c.flag || "🌐"}</span>
                                        <span>{c.locationLabel || "Unknown location"}</span>
                                        <span className="text-muted">({c.deviceType || "Device"})</span>
                                      </span>
                                      <span className="font-mono text-muted">
                                        +{formatDuration(c.timeOffset ?? 0)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Top Clicked Elements Sidebar */}
                    <div className="flex flex-col gap-4">
                      <div className="rounded-2xl border border-line bg-white p-4 shadow-xs">
                        <div className="flex items-center justify-between">
                          <h3 className="inline-flex items-center gap-1.5 font-display text-sm font-bold text-ink">
                            <IconAward size={16} className="text-amber-500" />
                            <span>Top Clicked Elements</span>
                          </h3>
                          <span className="font-mono text-xs text-muted">
                            {topElements.length} targets
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted">
                          What prospects engaged with most on this landing page
                        </p>

                        <div className="mt-4 space-y-2.5">
                          {topElements.length > 0 ? (
                            topElements.map((el, i) => (
                              <button
                                key={`${el.selector}-${i}`}
                                type="button"
                                onClick={() =>
                                  setSelectedElementSelector(
                                    selectedElementSelector === el.selector ? null : el.selector,
                                  )
                                }
                                className={`w-full rounded-xl border p-2.5 text-left transition ${
                                  selectedElementSelector === el.selector
                                    ? "border-blue bg-blue/5 shadow-xs"
                                    : "border-line bg-surface/50 hover:border-line-strong hover:bg-surface"
                                }`}
                              >
                                <div className="flex items-center justify-between">
                                  <span className="rounded bg-neutral-200 px-1.5 py-0.2 font-mono text-[10px] font-bold text-neutral-800">
                                    #{i + 1} {el.tag}
                                  </span>
                                  <span className="font-mono text-xs font-semibold text-rose-600">
                                    {el.count} click{el.count === 1 ? "" : "s"} ({el.percentage}%)
                                  </span>
                                </div>
                                <div className="mt-1 truncate font-medium text-xs text-ink">
                                  {el.text ? `"${el.text}"` : el.selector}
                                </div>
                              </button>
                            ))
                          ) : (
                            <p className="py-6 text-center text-xs text-muted">
                              No clicks recorded yet. Share the demo link with prospects to generate heatmap data!
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Heatmap Legend */}
                      <div className="rounded-2xl border border-line bg-white p-4 text-xs shadow-xs">
                        <h4 className="font-bold text-ink">Heat Intensity Legend</h4>
                        <div className="mt-2.5 flex items-center justify-between font-mono text-[10px] text-muted">
                          <span>Low Clicks</span>
                          <span>High Activity</span>
                        </div>
                        <div className="mt-1 h-3 w-full rounded-full bg-gradient-to-r from-blue-400 via-emerald-400 via-amber-400 to-rose-600 shadow-inner" />
                        <p className="mt-2 text-[11px] leading-relaxed text-muted">
                          Coordinates dynamically adjust across desktop, tablet, and mobile screens. Iframe and heatmap scroll in sync.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line bg-white px-6 py-3.5 text-xs text-muted">
          <div>
            Locations are approximate IP estimates. VPNs and mobile networks may show a different location.
            {report?.summary.locationCoverage && (
              <p className="text-xs text-muted">
                Location coverage: country {report.summary.locationCoverage.countryPercent}%, city {report.summary.locationCoverage.cityPercent}%.
                {" "}Unknown: {report.summary.locationCoverage.unknown}. Legacy: {report.summary.locationCoverage.legacy}. Local: {report.summary.locationCoverage.local}.
              </p>
            )}
          </div>
          <Button size="sm" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
