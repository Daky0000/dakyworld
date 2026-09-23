import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  IconCheck,
  IconDesktop,
  IconFileText,
  IconMessageSquare,
  IconPalette,
  IconPhone,
  IconPhoneDevice,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconUploadCloud,
  IconZap,
} from "./WebsiteIcons";

interface PageSeoInfo {
  title: string;
  description: string;
  keywords: string;
  tags: string[];
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  twitterCard: string;
  canonical: string;
  robots: string;
}

interface SiteSeoOverviewResponse {
  siteId: string;
  repo: string | null;
  repoMetadata: {
    name: string;
    fullName: string;
    description: string;
    homepage: string;
    topics: string[];
    defaultBranch: string;
    htmlUrl: string;
  } | null;
  pages: Array<{
    pageId: string;
    title: string;
    path: string;
    filePath: string;
    seo: PageSeoInfo;
  }>;
}

export interface PageImageFieldSummary {
  id: string;
  label: string;
  src: string;
  alt: string;
}

interface WebsitePageSeoInspectorProps {
  siteId: string;
  pageId: string;
  pageTitle: string;
  pagePath: string;
  readOnly: boolean;
  imageFields?: PageImageFieldSummary[];
  onApplyAltFixes?: (fixes: Array<{ id: string; alt: string }>) => void;
  onOpenClientReport?: () => void;
  onDraftUpdated?: () => void;
}

export function WebsitePageSeoInspector({
  siteId,
  pageId,
  pageTitle,
  pagePath,
  readOnly,
  imageFields = [],
  onApplyAltFixes,
  onOpenClientReport,
  onDraftUpdated,
}: WebsitePageSeoInspectorProps) {
  const qc = useQueryClient();
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [seoKeywords, setSeoKeywords] = useState("");
  const [seoOgImage, setSeoOgImage] = useState("");
  const [seoCanonical, setSeoCanonical] = useState("");
  const [seoRobots, setSeoRobots] = useState("index, follow");
  const [previewTab, setPreviewTab] = useState<"google-desktop" | "google-mobile" | "social">("google-desktop");

  // Technical SEO (Schema + Sitemap/Robots)
  const [schemaType, setSchemaType] = useState<"Organization" | "LocalBusiness" | "WebSite" | "Product" | "FAQPage">("Organization");
  const [orgName, setOrgName] = useState("");
  const [orgPhone, setOrgPhone] = useState("");
  const [generatedFilesPreview, setGeneratedFilesPreview] = useState<{ sitemapXml: string; robotsTxt: string } | null>(null);

  // Lead Capture / WhatsApp Conversion Bar
  const [conversionEnabled, setConversionEnabled] = useState(false);
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [callPhone, setCallPhone] = useState("");
  const [ctaLabel, setCtaLabel] = useState("Chat with us on WhatsApp");
  const [accentColor, setAccentColor] = useState("#16a34a");

  // Global Font & Brand Theme (#4)
  const [fontPairId, setFontPairId] = useState<"space-dm" | "playfair-inter" | "jakarta-inter" | "instrument-jakarta" | "outfit-work" | "reset">("space-dm");
  const [brandPrimary, setBrandPrimary] = useState("#3157FF");
  const [brandSurface, setBrandSurface] = useState("#FFFFFF");
  const [brandInk, setBrandInk] = useState("#08101F");
  const [applyBrandColors, setApplyBrandColors] = useState(false);

  // Page Speed & Link Security Score (#3)
  const [speedScore, setSpeedScore] = useState<number | null>(null);

  // GitHub Repo Metadata
  const [repoDescription, setRepoDescription] = useState("");
  const [repoHomepage, setRepoHomepage] = useState("");
  const [repoTopicsInput, setRepoTopicsInput] = useState("");

  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const seoQuery = useQuery({
    queryKey: ["website", "seo", siteId],
    enabled: Boolean(siteId),
    queryFn: () => api.get<SiteSeoOverviewResponse>(`/website/sites/${siteId}/seo`),
  });

  useEffect(() => {
    if (!seoQuery.data) return;
    const pageEntry =
      seoQuery.data.pages.find((p) => p.pageId === pageId) ?? seoQuery.data.pages[0];
    if (pageEntry) {
      setSeoTitle(pageEntry.seo.title || "");
      setSeoDescription(pageEntry.seo.description || "");
      setSeoKeywords(pageEntry.seo.keywords || pageEntry.seo.tags.join(", ") || "");
      setSeoOgImage(pageEntry.seo.ogImage || "");
      setSeoCanonical(pageEntry.seo.canonical || "");
      setSeoRobots(pageEntry.seo.robots || "index, follow");
    }
    if (seoQuery.data.repoMetadata) {
      setRepoDescription(seoQuery.data.repoMetadata.description || "");
      setRepoHomepage(seoQuery.data.repoMetadata.homepage || "");
      setRepoTopicsInput((seoQuery.data.repoMetadata.topics || []).join(", "));
      if (!orgName && seoQuery.data.repoMetadata.name) {
        setOrgName(seoQuery.data.repoMetadata.name);
      }
    }
  }, [seoQuery.data, pageId]);

  const missingAltImages = imageFields.filter((img) => !img.alt || !img.alt.trim());

  const handleAutoFixMissingAlts = () => {
    if (!onApplyAltFixes || missingAltImages.length === 0) return;
    const baseTopic = (seoTitle || pageTitle || "Website").split(/[|—–-]/)[0]?.trim() || pageTitle;
    const fixes = missingAltImages.map((img, idx) => {
      const fileStem = img.src
        .split("/")
        .pop()
        ?.split("?")[0]
        ?.replace(/\.[a-z0-9]+$/i, "")
        ?.replace(/[-_]+/g, " ")
        ?.trim();
      const cleanLabel = img.label && !/^image\s*\d*$/i.test(img.label) ? img.label : fileStem;
      const generatedAlt = cleanLabel
        ? `${baseTopic} — ${cleanLabel}`
        : `${baseTopic} visual ${idx + 1}`;
      return { id: img.id, alt: generatedAlt };
    });
    onApplyAltFixes(fixes);
    setStatusMsg(`Auto-filled descriptive alt text for ${fixes.length} image${fixes.length === 1 ? "" : "s"}.`);
  };

  const savePageSeoMutation = useMutation({
    mutationFn: async (publishNow: boolean) => {
      setErrorMsg(null);
      setStatusMsg(null);
      const tags = seoKeywords
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      return api.post<{ pageId: string; published: boolean; commitSha: string | null }>(
        `/website/sites/${siteId}/seo/page`,
        {
          pageId,
          title: seoTitle,
          description: seoDescription,
          keywords: seoKeywords,
          tags,
          ogImage: seoOgImage,
          canonical: seoCanonical,
          robots: seoRobots,
          publishNow,
        },
      );
    },
    onSuccess: (res) => {
      setStatusMsg(
        res.published
          ? "SEO metadata committed and published to GitHub."
          : "Page SEO saved to draft.",
      );
      void qc.invalidateQueries({ queryKey: ["website", "seo", siteId] });
      void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
      onDraftUpdated?.();
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : "Could not save page SEO.");
    },
  });

  const autoGenerateMutation = useMutation({
    mutationFn: async () => {
      setErrorMsg(null);
      setStatusMsg(null);
      return api.post<{ pageId: string; seo: PageSeoInfo }>(
        `/website/sites/${siteId}/seo/auto-generate`,
        { pageId, applyDraft: true },
      );
    },
    onSuccess: (res) => {
      if (res?.seo) {
        setSeoTitle(res.seo.title);
        setSeoDescription(res.seo.description);
        setSeoKeywords(res.seo.keywords || res.seo.tags.join(", "));
        if (res.seo.canonical && !seoCanonical) setSeoCanonical(res.seo.canonical);
        setStatusMsg("Auto-generated SEO title, description and tags from page copy.");
        void qc.invalidateQueries({ queryKey: ["website", "seo", siteId] });
        void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
        onDraftUpdated?.();
      }
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : "Could not auto-generate SEO.");
    },
  });

  const technicalSeoMutation = useMutation({
    mutationFn: async (publishRepoFiles: boolean) => {
      setErrorMsg(null);
      setStatusMsg(null);
      return api.post<{
        ok: boolean;
        schemaType: string;
        sitemapXml: string;
        robotsTxt: string;
        repoCommit: { sha: string; url: string } | null;
      }>(`/website/sites/${siteId}/seo/technical`, {
        pageId,
        schemaType,
        organizationName: orgName,
        phone: orgPhone,
        publishRepoFiles,
      });
    },
    onSuccess: (res) => {
      setGeneratedFilesPreview({ sitemapXml: res.sitemapXml, robotsTxt: res.robotsTxt });
      setStatusMsg(
        res.repoCommit
          ? `Injected ${res.schemaType} JSON-LD schema & committed sitemap.xml + robots.txt to GitHub.`
          : `Injected ${res.schemaType} JSON-LD schema into draft & generated sitemap.xml + robots.txt.`,
      );
      void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
      onDraftUpdated?.();
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : "Could not generate technical SEO files.");
    },
  });

  const conversionBarMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      setErrorMsg(null);
      setStatusMsg(null);
      return api.post<{ ok: boolean; enabled: boolean }>(`/website/sites/${siteId}/seo/conversion-bar`, {
        pageId,
        enabled,
        whatsapp: whatsappNumber,
        phone: callPhone,
        ctaLabel,
        accentColor,
      });
    },
    onSuccess: (res) => {
      setConversionEnabled(res.enabled);
      setStatusMsg(
        res.enabled
          ? "Floating WhatsApp & Call Conversion Bar added to page draft."
          : "Floating Conversion Bar removed from page draft.",
      );
      void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
      onDraftUpdated?.();
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : "Could not update Conversion Bar.");
    },
  });

  const speedOptimizeMutation = useMutation({
    mutationFn: async () => {
      setErrorMsg(null);
      setStatusMsg(null);
      return api.post<{
        ok: boolean;
        score: number;
        metrics: {
          totalImages: number;
          lazyImagesAdded: number;
          asyncDecodingAdded: number;
          externalLinksHardened: number;
          altTagsAdded: number;
        };
      }>(`/website/sites/${siteId}/seo/speed-optimize`, {
        pageId,
        applyFixes: true,
      });
    },
    onSuccess: (res) => {
      setSpeedScore(res.score);
      setStatusMsg(
        `Speed & Security Optimized (Score: ${res.score}/100): ${res.metrics.lazyImagesAdded} lazy-loaded images, ${res.metrics.externalLinksHardened} external links hardened.`,
      );
      void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
      onDraftUpdated?.();
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : "Could not optimize page speed.");
    },
  });

  const brandThemeMutation = useMutation({
    mutationFn: async (targetFontPair: typeof fontPairId) => {
      setErrorMsg(null);
      setStatusMsg(null);
      return api.post<{ ok: boolean; label: string }>(`/website/sites/${siteId}/seo/brand-theme`, {
        pageId,
        fontPairId: targetFontPair,
        primaryColor: brandPrimary,
        surfaceColor: brandSurface,
        textColor: brandInk,
        applyColorOverrides: applyBrandColors,
      });
    },
    onSuccess: (res) => {
      setStatusMsg(res.label);
      void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
      onDraftUpdated?.();
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : "Could not apply brand theme.");
    },
  });

  const healthMonitorQuery = useQuery({
    queryKey: ["website", "health-monitor", siteId],
    enabled: Boolean(siteId),
    queryFn: () =>
      api.get<{
        checkedAt: string;
        targetUrl: string;
        online: boolean;
        statusCode: number | null;
        responseTimeMs: number | null;
        ssl: { valid: boolean; issuer: string | null; daysRemaining: number | null };
      }>(`/website/sites/${siteId}/health-monitor`),
  });

  const runHealthProbeMutation = useMutation({
    mutationFn: async () => {
      return api.post<{
        checkedAt: string;
        targetUrl: string;
        online: boolean;
        statusCode: number | null;
        responseTimeMs: number | null;
        ssl: { valid: boolean; issuer: string | null; daysRemaining: number | null };
      }>(`/website/sites/${siteId}/health-monitor/check`, {});
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["website", "health-monitor", siteId] });
      setStatusMsg("Live uptime & SSL certificate health check completed.");
    },
  });

  const saveRepoSeoMutation = useMutation({
    mutationFn: async () => {
      setErrorMsg(null);
      setStatusMsg(null);
      const topics = repoTopicsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      return api.post(`/website/sites/${siteId}/seo/repo`, {
        description: repoDescription,
        homepage: repoHomepage,
        topics,
      });
    },
    onSuccess: () => {
      setStatusMsg("GitHub repository description, homepage and topic tags updated.");
      void qc.invalidateQueries({ queryKey: ["website", "seo", siteId] });
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : "Could not update GitHub repo metadata.");
    },
  });

  const resolvedUrl = seoCanonical || repoHomepage || `https://example.com${pagePath}`;
  const resolvedTitle = seoTitle || `${pageTitle} — Click Auto-fill`;
  const resolvedDesc =
    seoDescription || "Add a meta description to control how this page appears in Google search results and social shares.";

  return (
    <div className="space-y-4 p-3.5 text-xs">
      {/* Header & Auto-Fill + Client Report Button */}
      <div className="flex items-center justify-between gap-2 border-b border-line pb-2.5">
        <div className="min-w-0">
          <div className="truncate font-semibold text-ink">
            Page SEO: {pageTitle} ({pagePath})
          </div>
          <div className="text-[11px] text-muted">
            Search rankings, speed, brand theme, SSL monitor &amp; reports
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onOpenClientReport && (
            <button
              type="button"
              onClick={onOpenClientReport}
              className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-2 py-1.5 text-[11px] font-semibold text-ink transition hover:bg-cream"
              title="Open Printable Client SEO & Website Optimization Report"
            >
              <IconFileText size={12} />
              <span>Report</span>
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              disabled={autoGenerateMutation.isPending}
              onClick={() => autoGenerateMutation.mutate()}
              className="inline-flex items-center gap-1 rounded-lg border border-blue/30 bg-blue/10 px-2.5 py-1.5 text-[11px] font-semibold text-blue transition hover:bg-blue/20 disabled:opacity-50"
              title="Automatically generate SEO title, description, and keyword tags from this page's headings and paragraphs"
            >
              <IconSparkles size={12} />
              <span>{autoGenerateMutation.isPending ? "Generating…" : "Auto-fill"}</span>
            </button>
          )}
        </div>
      </div>

      {statusMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] font-medium text-emerald-800">
          <IconCheck />
          <span>{statusMsg}</span>
        </div>
      )}
      {errorMsg && (
        <div role="alert" className="rounded-lg border border-danger-line bg-danger-surface px-2.5 py-2 text-[11px] text-danger-text">
          {errorMsg}
        </div>
      )}

      {/* Interactive Google SERP & Social Card Preview Switcher */}
      <div className="rounded-xl border border-line bg-cream/40 p-2.5">
        <div className="mb-2 flex items-center justify-between gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
            Live Search &amp; Share Preview
          </span>
          <div className="inline-flex rounded-lg border border-line bg-white p-0.5">
            <button
              type="button"
              onClick={() => setPreviewTab("google-desktop")}
              title="Google Desktop Search Result"
              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold transition ${
                previewTab === "google-desktop" ? "bg-ink text-white" : "text-muted hover:text-ink"
              }`}
            >
              <IconDesktop size={11} />
              <span>Desktop</span>
            </button>
            <button
              type="button"
              onClick={() => setPreviewTab("google-mobile")}
              title="Google Mobile Search Result"
              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold transition ${
                previewTab === "google-mobile" ? "bg-ink text-white" : "text-muted hover:text-ink"
              }`}
            >
              <IconPhoneDevice size={11} />
              <span>Mobile</span>
            </button>
            <button
              type="button"
              onClick={() => setPreviewTab("social")}
              title="WhatsApp / LinkedIn / X OpenGraph Card"
              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold transition ${
                previewTab === "social" ? "bg-ink text-white" : "text-muted hover:text-ink"
              }`}
            >
              <IconMessageSquare size={11} />
              <span>Social</span>
            </button>
          </div>
        </div>

        {previewTab === "social" ? (
          <div className="overflow-hidden rounded-lg border border-line bg-white shadow-2xs">
            {seoOgImage ? (
              <div className="h-28 w-full overflow-hidden bg-sunken">
                <img
                  src={seoOgImage}
                  alt="Social share preview"
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
            ) : (
              <div className="flex h-24 w-full items-center justify-center bg-sunken text-[11px] text-muted">
                No og:image URL set — add a cover image URL below
              </div>
            )}
            <div className="p-2.5">
              <div className="truncate text-[10px] uppercase tracking-wide text-muted">
                {resolvedUrl.replace(/^https?:\/\//, "").split("/")[0]}
              </div>
              <div className="mt-0.5 truncate text-xs font-bold text-ink">{resolvedTitle}</div>
              <div className="mt-0.5 line-clamp-2 text-[11px] text-muted">{resolvedDesc}</div>
            </div>
          </div>
        ) : (
          <div
            className={`rounded-lg border border-line bg-white p-2.5 shadow-2xs ${
              previewTab === "google-mobile" ? "mx-auto max-w-[260px]" : ""
            }`}
          >
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-700">
              <IconSearch size={11} />
              <span className="truncate">{resolvedUrl}</span>
            </div>
            <div className="mt-1 truncate text-xs font-semibold text-[#1a0dab] hover:underline">
              {resolvedTitle}
            </div>
            <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted">
              {resolvedDesc}
            </div>
          </div>
        )}
      </div>

      {/* (#3) 1-Click Page Speed (lazy-load) & Link Security Optimizer + Health Score */}
      {!readOnly && (
        <div className="rounded-xl border border-line bg-cream/40 p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5 font-semibold text-ink">
                <IconZap size={13} className="text-blue" />
                <span>Page Speed &amp; Security Optimizer</span>
              </div>
              <div className="text-[11px] text-muted">
                Auto-injects image `loading=&quot;lazy&quot;`, `decoding=&quot;async&quot;` &amp; hardens external links
              </div>
            </div>
            {speedScore !== null && (
              <span className="inline-flex h-7 items-center rounded-lg bg-ink px-2 font-mono text-xs font-bold text-white">
                {speedScore}/100
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={speedOptimizeMutation.isPending}
              onClick={() => speedOptimizeMutation.mutate()}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-ink px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              <IconZap size={12} />
              <span>
                {speedOptimizeMutation.isPending
                  ? "Optimizing Speed & Links…"
                  : "1-Click Optimize Speed & Security"}
              </span>
            </button>
            {missingAltImages.length > 0 && onApplyAltFixes && (
              <button
                type="button"
                onClick={handleAutoFixMissingAlts}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px] font-semibold text-ink transition hover:bg-cream"
                title="Automatically generate and apply SEO alt tags to all images missing alt text"
              >
                <IconSparkles size={12} />
                <span>Fix {missingAltImages.length} Alt{missingAltImages.length === 1 ? "" : "s"}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* (#4) 1-Click Global Font & Brand Theme Switcher (Google Fonts + Palette) */}
      {!readOnly && (
        <div className="rounded-xl border border-line bg-cream/40 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-semibold text-ink">
              <IconPalette size={13} className="text-blue" />
              <span>Global Font &amp; Brand Theme Switcher</span>
            </div>
            <span className="rounded-full bg-blue/10 px-2 py-0.5 text-[10px] font-semibold text-blue">
              Google Fonts
            </span>
          </div>
          <select
            value={fontPairId}
            onChange={(e) => setFontPairId(e.target.value as typeof fontPairId)}
            className="w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink outline-none"
          >
            <option value="space-dm">Space Grotesk + DM Sans (Modern SaaS)</option>
            <option value="playfair-inter">Playfair Display + Inter (Editorial &amp; Luxury)</option>
            <option value="jakarta-inter">Plus Jakarta Sans + Inter (Clean Agency)</option>
            <option value="instrument-jakarta">Instrument Serif + Plus Jakarta Sans (Boutique Studio)</option>
            <option value="outfit-work">Outfit + Work Sans (Bold Startup)</option>
            <option value="reset">Reset to Original Template Fonts</option>
          </select>
          <div className="flex items-center justify-between gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={applyBrandColors}
                onChange={(e) => setApplyBrandColors(e.target.checked)}
              />
              <span>Override page colors</span>
            </label>
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={brandPrimary}
                onChange={(e) => setBrandPrimary(e.target.value)}
                title="Brand Primary Accent"
                className="h-6 w-7 cursor-pointer rounded border border-line bg-white"
              />
              <input
                type="color"
                value={brandSurface}
                onChange={(e) => setBrandSurface(e.target.value)}
                title="Page Background Surface"
                className="h-6 w-7 cursor-pointer rounded border border-line bg-white"
              />
              <input
                type="color"
                value={brandInk}
                onChange={(e) => setBrandInk(e.target.value)}
                title="Body Text Color"
                className="h-6 w-7 cursor-pointer rounded border border-line bg-white"
              />
            </div>
          </div>
          <button
            type="button"
            disabled={brandThemeMutation.isPending}
            onClick={() => brandThemeMutation.mutate(fontPairId)}
            className="w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px] font-semibold text-ink transition hover:bg-cream disabled:opacity-50"
          >
            {brandThemeMutation.isPending ? "Applying Typography & Palette…" : "Apply Global Brand Theme"}
          </button>
        </div>
      )}

      {/* (#12) Automated Uptime & SSL Certificate Health Monitor */}
      <div className="rounded-xl border border-line bg-cream/40 p-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-ink">
            <span
              className={`h-2 w-2 rounded-full ${
                healthMonitorQuery.data?.online ? "bg-emerald-500" : "bg-amber-500"
              }`}
            />
            <span>Live Uptime &amp; SSL Monitor</span>
          </div>
          <button
            type="button"
            disabled={runHealthProbeMutation.isPending}
            onClick={() => runHealthProbeMutation.mutate()}
            className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-2 py-0.5 text-[10px] font-semibold text-ink hover:bg-sunken"
          >
            <IconRefresh size={10} />
            <span>{runHealthProbeMutation.isPending ? "Checking…" : "Check Now"}</span>
          </button>
        </div>
        {healthMonitorQuery.data ? (
          <div className="grid grid-cols-3 gap-1.5 text-[11px]">
            <div className="rounded-lg bg-white p-1.5 border border-line/60">
              <span className="block text-[9px] uppercase text-muted">Status</span>
              <span className="font-semibold text-ink">
                {healthMonitorQuery.data.online
                  ? `${healthMonitorQuery.data.statusCode ?? 200} OK`
                  : "Standby"}
              </span>
            </div>
            <div className="rounded-lg bg-white p-1.5 border border-line/60">
              <span className="block text-[9px] uppercase text-muted">Latency</span>
              <span className="font-mono font-semibold text-ink">
                {healthMonitorQuery.data.responseTimeMs !== null
                  ? `${healthMonitorQuery.data.responseTimeMs}ms`
                  : "—"}
              </span>
            </div>
            <div className="rounded-lg bg-white p-1.5 border border-line/60">
              <span className="block text-[9px] uppercase text-muted">SSL Cert</span>
              <span className="font-semibold text-ink">
                {healthMonitorQuery.data.ssl.valid
                  ? `${healthMonitorQuery.data.ssl.daysRemaining}d left`
                  : "HTTPS"}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-muted">Checking site uptime and SSL certificate…</div>
        )}
      </div>

      {/* Page <head> SEO Inputs */}
      <div className="space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="inspector-seo-title" className="font-semibold text-ink">
              SEO Title (&lt;title&gt;)
            </label>
            <span className="text-[10px] text-muted">{seoTitle.length}/60</span>
          </div>
          <input
            id="inspector-seo-title"
            type="text"
            disabled={readOnly}
            value={seoTitle}
            onChange={(e) => setSeoTitle(e.target.value)}
            placeholder="Page Title | Brand Name"
            className="w-full rounded-lg border border-line bg-cream px-2.5 py-1.5 text-xs text-ink outline-none focus:border-blue"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="inspector-seo-desc" className="font-semibold text-ink">
              Meta Description
            </label>
            <span className="text-[10px] text-muted">{seoDescription.length}/160</span>
          </div>
          <textarea
            id="inspector-seo-desc"
            rows={3}
            disabled={readOnly}
            value={seoDescription}
            onChange={(e) => setSeoDescription(e.target.value)}
            placeholder="150–160 character summary shown in Google search results and social links…"
            className="w-full rounded-lg border border-line bg-cream px-2.5 py-1.5 text-xs text-ink outline-none focus:border-blue"
          />
        </div>

        <div>
          <label htmlFor="inspector-seo-keywords" className="mb-1 block font-semibold text-ink">
            SEO Tags / Keywords (comma-separated)
          </label>
          <input
            id="inspector-seo-keywords"
            type="text"
            disabled={readOnly}
            value={seoKeywords}
            onChange={(e) => setSeoKeywords(e.target.value)}
            placeholder="web design, portfolio, digital agency, brand"
            className="w-full rounded-lg border border-line bg-cream px-2.5 py-1.5 text-xs text-ink outline-none focus:border-blue"
          />
        </div>

        <div className="grid grid-cols-1 gap-2.5">
          <div>
            <label htmlFor="inspector-seo-ogimage" className="mb-1 block font-semibold text-muted">
              Social Share Image (`og:image` URL)
            </label>
            <input
              id="inspector-seo-ogimage"
              type="text"
              disabled={readOnly}
              value={seoOgImage}
              onChange={(e) => setSeoOgImage(e.target.value)}
              placeholder="https://.../og-cover.jpg"
              className="w-full rounded-lg border border-line bg-cream px-2.5 py-1.5 text-xs text-ink outline-none focus:border-blue"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="inspector-seo-canonical" className="mb-1 block font-semibold text-muted">
                Canonical URL
              </label>
              <input
                id="inspector-seo-canonical"
                type="text"
                disabled={readOnly}
                value={seoCanonical}
                onChange={(e) => setSeoCanonical(e.target.value)}
                placeholder="https://..."
                className="w-full rounded-lg border border-line bg-cream px-2 py-1.5 text-xs text-ink outline-none focus:border-blue"
              />
            </div>
            <div>
              <label htmlFor="inspector-seo-robots" className="mb-1 block font-semibold text-muted">
                Robots Directive
              </label>
              <input
                id="inspector-seo-robots"
                type="text"
                disabled={readOnly}
                value={seoRobots}
                onChange={(e) => setSeoRobots(e.target.value)}
                placeholder="index, follow"
                className="w-full rounded-lg border border-line bg-cream px-2 py-1.5 text-xs text-ink outline-none focus:border-blue"
              />
            </div>
          </div>
        </div>

        {!readOnly && (
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              disabled={savePageSeoMutation.isPending}
              onClick={() => savePageSeoMutation.mutate(false)}
              className="flex-1 rounded-lg border border-line bg-white px-2.5 py-2 text-xs font-semibold text-ink transition hover:bg-cream disabled:opacity-50"
            >
              {savePageSeoMutation.isPending ? "Saving…" : "Save SEO to Draft"}
            </button>
            <button
              type="button"
              disabled={savePageSeoMutation.isPending}
              onClick={() => savePageSeoMutation.mutate(true)}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-ink px-2.5 py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              <IconUploadCloud />
              <span>{savePageSeoMutation.isPending ? "Publishing…" : "Publish SEO"}</span>
            </button>
          </div>
        )}
      </div>

      {/* 1-Click Technical SEO: JSON-LD Schema + Sitemap.xml + Robots.txt */}
      {!readOnly && (
        <div className="space-y-2.5 border-t border-line pt-3.5">
          <div className="flex items-center gap-1.5 font-semibold text-ink">
            <IconFileText size={14} className="text-blue" />
            <span>Schema.org JSON-LD, Sitemap &amp; Robots.txt</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted">Schema Type</label>
              <select
                value={schemaType}
                onChange={(e) => setSchemaType(e.target.value as typeof schemaType)}
                className="w-full rounded-lg border border-line bg-cream px-2 py-1.5 text-xs text-ink outline-none"
              >
                <option value="Organization">Organization</option>
                <option value="LocalBusiness">LocalBusiness</option>
                <option value="WebSite">WebSite</option>
                <option value="Product">Product</option>
                <option value="FAQPage">FAQPage</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted">Business Name</label>
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Your Brand Name"
                className="w-full rounded-lg border border-line bg-cream px-2 py-1.5 text-xs text-ink outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={technicalSeoMutation.isPending}
              onClick={() => technicalSeoMutation.mutate(false)}
              className="flex-1 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px] font-semibold text-ink transition hover:bg-cream disabled:opacity-50"
            >
              {technicalSeoMutation.isPending ? "Generating…" : "Inject Schema & Sitemap"}
            </button>
            {seoQuery.data?.repo && (
              <button
                type="button"
                disabled={technicalSeoMutation.isPending}
                onClick={() => technicalSeoMutation.mutate(true)}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-blue/30 bg-blue/10 px-2.5 py-1.5 text-[11px] font-semibold text-blue transition hover:bg-blue/20 disabled:opacity-50"
                title="Commit sitemap.xml and robots.txt directly to the GitHub repository"
              >
                <IconUploadCloud size={12} />
                <span>Commit Sitemap to Repo</span>
              </button>
            )}
          </div>
          {generatedFilesPreview && (
            <details className="rounded-lg border border-line bg-sunken/50 p-2 text-[10px]">
              <summary className="cursor-pointer font-semibold text-ink">
                View generated sitemap.xml &amp; robots.txt
              </summary>
              <pre className="mt-1.5 max-h-28 overflow-auto rounded bg-white p-2 font-mono text-[10px] text-muted">
                {generatedFilesPreview.robotsTxt}
                {"\n\n"}
                {generatedFilesPreview.sitemapXml}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Built-in Lead Capture & WhatsApp Conversion Bar */}
      {!readOnly && (
        <div className="space-y-2.5 border-t border-line pt-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-semibold text-ink">
              <IconPhone size={14} className="text-emerald-600" />
              <span>Lead Capture &amp; WhatsApp Bar</span>
            </div>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
              Conversion Booster
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted">WhatsApp Number</label>
              <input
                type="text"
                value={whatsappNumber}
                onChange={(e) => setWhatsappNumber(e.target.value)}
                placeholder="+233501234567"
                className="w-full rounded-lg border border-line bg-cream px-2 py-1.5 text-xs text-ink outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted">Call Phone (optional)</label>
              <input
                type="text"
                value={callPhone}
                onChange={(e) => setCallPhone(e.target.value)}
                placeholder="+233501234567"
                className="w-full rounded-lg border border-line bg-cream px-2 py-1.5 text-xs text-ink outline-none"
              />
            </div>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input
              type="text"
              value={ctaLabel}
              onChange={(e) => setCtaLabel(e.target.value)}
              placeholder="Chat with us on WhatsApp"
              className="w-full rounded-lg border border-line bg-cream px-2.5 py-1.5 text-xs text-ink outline-none"
            />
            <input
              type="color"
              value={accentColor}
              onChange={(e) => setAccentColor(e.target.value)}
              title="Button Accent Color"
              className="h-8 w-10 cursor-pointer rounded-lg border border-line bg-cream"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={conversionBarMutation.isPending}
              onClick={() => conversionBarMutation.mutate(true)}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
            >
              <IconZap size={12} />
              <span>{conversionEnabled ? "Update Conversion Bar" : "Add Conversion Bar to Page"}</span>
            </button>
            {conversionEnabled && (
              <button
                type="button"
                disabled={conversionBarMutation.isPending}
                onClick={() => conversionBarMutation.mutate(false)}
                className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px] font-medium text-muted hover:text-ink"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}

      {/* GitHub Repository Metadata & Topics Section */}
      {seoQuery.data?.repo && (
        <div className="space-y-2.5 border-t border-line pt-3.5">
          <div>
            <div className="font-semibold text-ink">
              GitHub Repo SEO ({seoQuery.data.repo})
            </div>
            <div className="text-[11px] text-muted">
              Repository About description, website URL &amp; topic tags
            </div>
          </div>

          <div>
            <label htmlFor="inspector-repo-desc" className="mb-1 block font-semibold text-muted">
              Repo About Description
            </label>
            <input
              id="inspector-repo-desc"
              type="text"
              disabled={readOnly}
              value={repoDescription}
              onChange={(e) => setRepoDescription(e.target.value)}
              placeholder="Repository description on GitHub…"
              className="w-full rounded-lg border border-line bg-cream px-2.5 py-1.5 text-xs text-ink outline-none focus:border-blue"
            />
          </div>

          <div>
            <label htmlFor="inspector-repo-homepage" className="mb-1 block font-semibold text-muted">
              Repo Homepage URL
            </label>
            <input
              id="inspector-repo-homepage"
              type="url"
              disabled={readOnly}
              value={repoHomepage}
              onChange={(e) => setRepoHomepage(e.target.value)}
              placeholder="https://yourdomain.com"
              className="w-full rounded-lg border border-line bg-cream px-2.5 py-1.5 text-xs text-ink outline-none focus:border-blue"
            />
          </div>

          <div>
            <label htmlFor="inspector-repo-topics" className="mb-1 block font-semibold text-muted">
              Repo Topics / Tags (comma-separated)
            </label>
            <input
              id="inspector-repo-topics"
              type="text"
              disabled={readOnly}
              value={repoTopicsInput}
              onChange={(e) => setRepoTopicsInput(e.target.value)}
              placeholder="portfolio, nextjs, agency, website"
              className="w-full rounded-lg border border-line bg-cream px-2.5 py-1.5 text-xs text-ink outline-none focus:border-blue"
            />
          </div>

          {!readOnly && (
            <button
              type="button"
              disabled={saveRepoSeoMutation.isPending}
              onClick={() => saveRepoSeoMutation.mutate()}
              className="w-full rounded-lg border border-line bg-cream px-2.5 py-2 text-xs font-semibold text-ink transition hover:bg-line/40 disabled:opacity-50"
            >
              {saveRepoSeoMutation.isPending ? "Updating GitHub Repo…" : "Update GitHub Repo SEO"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

