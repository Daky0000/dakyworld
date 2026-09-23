import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader, Button } from "../components/ui";
import {
  IconCheck,
  IconMessageSquare,
  IconPalette,
  IconPhone,
  IconSearch,
  IconSparkles,
  IconType,
  IconUploadCloud,
  IconZap,
} from "../components/WebsiteIcons";
import { api } from "../lib/api";
import type {
  SiteSummary,
  SiteAgentOverview,
  SiteAgentPlan,
  SiteAgentApplyResult,
} from "../lib/types";

type PageSeoInfo = {
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
  hasGeneratedSeoBlock: boolean;
};

type SiteSeoOverviewResponse = {
  siteId: string;
  siteName: string;
  repo: string | null;
  repoMetadata: {
    fullName: string;
    description: string;
    homepage: string;
    topics: string[];
  } | null;
  pages: Array<{
    pageId: string;
    title: string;
    path: string;
    filePath: string;
    seo: PageSeoInfo;
  }>;
};

export function WebsiteAI() {
  const qc = useQueryClient();
  const sites = useQuery({
    queryKey: ["website", "sites"],
    queryFn: () => api.get<SiteSummary[]>("/website/sites"),
  });

  const [selectedSiteId, setSelectedSiteId] = useState("");
  const site = sites.data?.find((s) => s.id === selectedSiteId) ?? sites.data?.[0];

  // Active mode in the agent workspace: prompt (natural language) or structured tools
  const [activeTab, setActiveTab] = useState<"prompt" | "font" | "color" | "content" | "seo">("prompt");

  // Input states
  const [prompt, setPrompt] = useState("");
  const [fromFont, setFromFont] = useState("");
  const [toFont, setToFont] = useState("");
  const [targetFontKind, setTargetFontKind] = useState<"all" | "heading" | "button">("all");

  const [fromColor, setFromColor] = useState("");
  const [toColor, setToColor] = useState("");

  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [contentKind, setContentKind] = useState<"auto" | "phone" | "email" | "text">("auto");

  // SEO & Repo Metadata state
  const [selectedSeoPageId, setSelectedSeoPageId] = useState("");
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [seoKeywords, setSeoKeywords] = useState("");
  const [seoOgImage, setSeoOgImage] = useState("");
  const [seoCanonical, setSeoCanonical] = useState("");
  const [seoRobots, setSeoRobots] = useState("index, follow");
  const [repoDescription, setRepoDescription] = useState("");
  const [repoHomepage, setRepoHomepage] = useState("");
  const [repoTopicsInput, setRepoTopicsInput] = useState("");
  const [seoStatusMsg, setSeoStatusMsg] = useState<string | null>(null);

  // Plan state
  const [plan, setPlan] = useState<SiteAgentPlan | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [applyResult, setApplyResult] = useState<SiteAgentApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Overview query
  const overview = useQuery({
    queryKey: ["website", "agent", "overview", site?.id],
    enabled: Boolean(site?.id),
    queryFn: () => api.get<SiteAgentOverview>(`/website/sites/${site!.id}/agent/overview`),
  });

  // SEO & Repo overview query
  const seoOverview = useQuery({
    queryKey: ["website", "seo", site?.id],
    enabled: Boolean(site?.id) && activeTab === "seo",
    queryFn: () => api.get<SiteSeoOverviewResponse>(`/website/sites/${site!.id}/seo`),
  });

  useEffect(() => {
    if (!seoOverview.data) return;
    if (seoOverview.data.repoMetadata) {
      setRepoDescription(seoOverview.data.repoMetadata.description || "");
      setRepoHomepage(seoOverview.data.repoMetadata.homepage || "");
      setRepoTopicsInput((seoOverview.data.repoMetadata.topics || []).join(", "));
    }
    const targetPage =
      seoOverview.data.pages.find((p) => p.pageId === selectedSeoPageId) ??
      seoOverview.data.pages[0];
    if (targetPage) {
      if (!selectedSeoPageId || !seoOverview.data.pages.some((p) => p.pageId === selectedSeoPageId)) {
        setSelectedSeoPageId(targetPage.pageId);
      }
      setSeoTitle(targetPage.seo.title || "");
      setSeoDescription(targetPage.seo.description || "");
      setSeoKeywords(targetPage.seo.keywords || targetPage.seo.tags.join(", "));
      setSeoOgImage(targetPage.seo.ogImage || "");
      setSeoCanonical(targetPage.seo.canonical || "");
      setSeoRobots(targetPage.seo.robots || "index, follow");
    }
  }, [seoOverview.data, selectedSeoPageId]);

  const savePageSeoMutation = useMutation({
    mutationFn: async (publishNow: boolean) => {
      if (!site || !selectedSeoPageId) return null;
      setError(null);
      setSeoStatusMsg(null);
      const tags = seoKeywords
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      return api.post<{ pageId: string; published: boolean; commitSha: string | null }>(
        `/website/sites/${site.id}/seo/page`,
        {
          pageId: selectedSeoPageId,
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
      if (res) {
        setSeoStatusMsg(
          res.published
            ? "Page SEO title, description, tags, and OpenGraph metadata committed and published to GitHub."
            : "Page SEO metadata saved to draft.",
        );
        void qc.invalidateQueries({ queryKey: ["website", "seo", site?.id] });
      }
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to save page SEO.");
    },
  });

  const autoGenerateSeoMutation = useMutation({
    mutationFn: async (opts?: { pageId?: string; applyDraft?: boolean }) => {
      if (!site) return null;
      setError(null);
      return api.post<{ pageId?: string; seo?: PageSeoInfo; updatedPages?: number }>(
        `/website/sites/${site.id}/seo/auto-generate`,
        { pageId: opts?.pageId, applyDraft: opts?.applyDraft ?? true },
      );
    },
    onSuccess: (res) => {
      if (res?.seo) {
        setSeoTitle(res.seo.title);
        setSeoDescription(res.seo.description);
        setSeoKeywords(res.seo.keywords || res.seo.tags.join(", "));
        if (res.seo.canonical && !seoCanonical) setSeoCanonical(res.seo.canonical);
        setSeoStatusMsg("Generated SEO title, description, and keyword tags from this page's headings and copy.");
      } else if (res?.updatedPages !== undefined) {
        setSeoStatusMsg(`Auto-generated and applied smart SEO tags across ${res.updatedPages} pages.`);
      }
      void qc.invalidateQueries({ queryKey: ["website", "seo", site?.id] });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to auto-generate SEO.");
    },
  });

  const saveRepoSeoMutation = useMutation({
    mutationFn: async () => {
      if (!site) return null;
      setError(null);
      setSeoStatusMsg(null);
      const topics = repoTopicsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      return api.post(`/website/sites/${site.id}/seo/repo`, {
        description: repoDescription,
        homepage: repoHomepage,
        topics,
      });
    },
    onSuccess: () => {
      setSeoStatusMsg("GitHub repository description, homepage URL, and topic tags updated.");
      void qc.invalidateQueries({ queryKey: ["website", "seo", site?.id] });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to update GitHub repository metadata.");
    },
  });

  // Plan mutation
  const planMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      setError(null);
      setPlan(null);
      setApplyResult(null);
      return api.post<SiteAgentPlan>(`/website/sites/${site!.id}/agent/plan`, payload);
    },
    onSuccess: (data) => {
      setPlan(data);
      setSelectedPages(new Set(data.pages.map((p) => p.pageId)));
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to plan website changes.");
    },
  });

  // Apply mutation
  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!plan || !site) return;
      setError(null);
      // Filter plan to selected pages only
      const filteredPages = plan.pages.filter((p) => selectedPages.has(p.pageId));
      const pageRevisions = Object.fromEntries(filteredPages.map((p) => [p.pageId, p.draftRevision]));
      const payload = {
        pageRevisions,
        plan: {
          explanation: plan.explanation,
          pages: filteredPages,
        },
      };
      return api.post<SiteAgentApplyResult>(`/website/sites/${site.id}/agent/apply`, payload);
    },
    onSuccess: (data) => {
      if (data) {
        setApplyResult(data);
        setBatchPublished(null);
        void qc.invalidateQueries({ queryKey: ["website", "pages", site?.id] });
        void qc.invalidateQueries({ queryKey: ["website", "agent", "overview", site?.id] });
      }
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to apply changes to drafts.");
    },
  });

  const [batchPublished, setBatchPublished] = useState<{ publishedPages: number; commitSha: string; commitUrl: string } | null>(null);

  const publishBatchMutation = useMutation({
    mutationFn: async () => {
      if (!site || !applyResult) return null;
      const pageIds = applyResult.results.filter((r) => r.success).map((r) => r.pageId);
      return api.post<{ publishedPages: number; commitSha: string; commitUrl: string }>(
        `/website/sites/${site.id}/agent/publish-batch`,
        {
          pageIds,
          message: `Website Agent: ${plan?.explanation?.slice(0, 120) || "Published site-wide updates"}`,
        },
      );
    },
    onSuccess: (data) => {
      if (data) {
        setBatchPublished(data);
        void qc.invalidateQueries({ queryKey: ["website", "pages", site?.id] });
      }
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to publish pages live.");
    },
  });

  function handlePromptSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    planMutation.mutate({ action: "instruction", prompt: prompt.trim() });
  }

  function handleFontSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!toFont.trim()) return;
    planMutation.mutate({
      action: "replace_font",
      fromFont: fromFont.trim(),
      toFont: toFont.trim(),
      targetKinds: [targetFontKind],
    });
  }

  function handleColorSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!fromColor.trim() || !toColor.trim()) return;
    planMutation.mutate({
      action: "replace_color",
      fromColor: fromColor.trim(),
      toColor: toColor.trim(),
    });
  }

  function handleContentSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!findText.trim()) return;
    planMutation.mutate({
      action: "replace_content",
      findText: findText.trim(),
      replaceText: replaceText.trim(),
      kind: contentKind,
    });
  }

  function togglePageSelection(pageId: string) {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  }

  const examples = [
    { label: "Change all font families to Inter", action: () => { setPrompt("Change every font family from this to Inter, sans-serif"); setActiveTab("prompt"); } },
    { label: "Replace color #08101F with #1E293B", action: () => { setFromColor("#08101F"); setToColor("#1E293B"); setActiveTab("color"); } },
    { label: "Change phone number across all pages", action: () => { setActiveTab("content"); setContentKind("phone"); setFindText(overview.data?.phoneNumbers[0]?.number || "+1 234 567 8900"); setReplaceText("+1 555 0199"); } },
    { label: "Update support email address", action: () => { setActiveTab("content"); setContentKind("email"); setFindText(overview.data?.emails[0]?.email || "contact@example.com"); setReplaceText("support@example.com"); } },
  ];

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Website Builder Agent"
        subtitle="Your site-wide builder agent. Tell it to update fonts, replace colors, or change phone numbers and copy across every page of your connected website."
      />

      {sites.isLoading && <p className="text-sm text-muted">Loading connected websites…</p>}
      {sites.isSuccess && !site && (
        <div className="rounded-2xl border border-line bg-white p-6 text-center">
          <p className="text-sm text-muted">No connected website available yet.</p>
          <Link to="/website/sites" className="mt-3 inline-block font-medium text-blue hover:underline">
            Connect or browse sites →
          </Link>
        </div>
      )}

      {site && (
        <div className="space-y-6">
          {/* Site Selector Bar */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-white p-4 shadow-xs">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink text-white font-display text-base">
                {site.name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <h3 className="font-display text-base font-semibold leading-tight text-ink">{site.name}</h3>
                <p className="text-xs text-muted">
                  {site.publicUrl ? <a href={site.publicUrl} target="_blank" rel="noreferrer" className="hover:underline">{site.publicUrl}</a> : site.repo ? site.repo : "Connected site"}
                  {" · "}{overview.data?.pageCount ?? 0} pages
                </p>
              </div>
            </div>

            {sites.data && sites.data.length > 1 && (
              <label className="text-xs text-muted">
                Switch website:
                <select
                  aria-label="Connected website"
                  value={site.id}
                  onChange={(e) => { setSelectedSiteId(e.target.value); setPlan(null); setApplyResult(null); }}
                  className="ml-2 rounded-xl border border-line bg-white px-3 py-1.5 text-sm text-ink outline-none"
                >
                  {sites.data.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {/* Detected Site Elements Bar */}
          {overview.isLoading && <p className="text-xs text-muted">Scanning site fonts, colors, and contacts…</p>}
          {overview.data && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {/* Fonts card */}
              <div className="rounded-2xl border border-line bg-white p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">Detected Fonts</span>
                  <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-ink">{overview.data.fonts.length}</span>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {overview.data.fonts.length > 0 ? (
                    overview.data.fonts.slice(0, 4).map((f) => (
                      <button
                        key={f.family}
                        type="button"
                        onClick={() => { setFromFont(f.family); setActiveTab("font"); }}
                        title={`Used ${f.uses} times across ${f.pages.join(", ")}`}
                        className="truncate max-w-[140px] rounded-lg border border-line bg-cream px-2 py-1 text-xs text-ink hover:border-ink"
                      >
                        {f.family}
                      </button>
                    ))
                  ) : (
                    <span className="text-xs text-muted">Default theme typography</span>
                  )}
                </div>
              </div>

              {/* Colors card */}
              <div className="rounded-2xl border border-line bg-white p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">Brand Colors</span>
                  <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-ink">{overview.data.colors.length}</span>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {overview.data.colors.length > 0 ? (
                    overview.data.colors.slice(0, 6).map((c) => (
                      <button
                        key={c.code}
                        type="button"
                        onClick={() => { setFromColor(c.code); setActiveTab("color"); }}
                        title={`${c.code} (used ${c.uses} times)`}
                        className="flex items-center gap-1.5 rounded-lg border border-line bg-cream px-2 py-1 text-xs text-ink hover:border-ink"
                      >
                        <span className="h-3 w-3 rounded-full border border-line shrink-0" style={{ backgroundColor: c.code }} />
                        <span className="font-mono text-[11px]">{c.code}</span>
                      </button>
                    ))
                  ) : (
                    <span className="text-xs text-muted">No custom color codes found</span>
                  )}
                </div>
              </div>

              {/* Phone & Contact card */}
              <div className="rounded-2xl border border-line bg-white p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">Contact Info</span>
                  <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-ink">
                    {overview.data.phoneNumbers.length + overview.data.emails.length}
                  </span>
                </div>
                <div className="mt-2.5 space-y-1.5">
                  {overview.data.phoneNumbers[0] && (
                    <button
                      type="button"
                      onClick={() => { setFindText(overview.data!.phoneNumbers[0].number); setContentKind("phone"); setActiveTab("content"); }}
                      className="flex items-center gap-1.5 truncate text-xs text-ink hover:text-blue"
                      title="Click to replace this phone number across pages"
                    >
                      <span className="text-muted">📞</span>
                      <span className="truncate font-medium">{overview.data.phoneNumbers[0].number}</span>
                    </button>
                  )}
                  {overview.data.emails[0] && (
                    <button
                      type="button"
                      onClick={() => { setFindText(overview.data!.emails[0].email); setContentKind("email"); setActiveTab("content"); }}
                      className="flex items-center gap-1.5 truncate text-xs text-ink hover:text-blue"
                      title="Click to replace this email across pages"
                    >
                      <span className="text-muted">✉️</span>
                      <span className="truncate font-medium">{overview.data.emails[0].email}</span>
                    </button>
                  )}
                  {!overview.data.phoneNumbers[0] && !overview.data.emails[0] && (
                    <span className="text-xs text-muted">No phone numbers or emails detected</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Quick Action Suggestion Chips */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-muted">Suggestions:</span>
            {examples.map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={ex.action}
                className="rounded-full border border-line bg-white px-3 py-1 text-xs text-muted hover:border-ink hover:text-ink transition"
              >
                {ex.label}
              </button>
            ))}
          </div>

          {/* Main Agent Input Box with Tab Switcher */}
          <div className="rounded-2xl border border-line bg-white p-5 shadow-xs">
            <div className="flex border-b border-line pb-3 mb-4 gap-2">
              <button
                type="button"
                onClick={() => setActiveTab("prompt")}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === "prompt" ? "bg-ink text-white" : "text-muted hover:bg-cream hover:text-ink"
                }`}
              >
                <IconMessageSquare />
                <span>Natural Language</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("font")}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === "font" ? "bg-ink text-white" : "text-muted hover:bg-cream hover:text-ink"
                }`}
              >
                <IconType />
                <span>Font Family</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("color")}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === "color" ? "bg-ink text-white" : "text-muted hover:bg-cream hover:text-ink"
                }`}
              >
                <IconPalette />
                <span>Color Code</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("content")}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === "content" ? "bg-ink text-white" : "text-muted hover:bg-cream hover:text-ink"
                }`}
              >
                <IconPhone />
                <span>Phone / Text</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("seo")}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === "seo" ? "bg-ink text-white" : "text-muted hover:bg-cream hover:text-ink"
                }`}
              >
                <IconSearch />
                <span>SEO &amp; Repo Tags</span>
              </button>
            </div>

            {/* TAB 1: Natural Language Prompt */}
            {activeTab === "prompt" && (
              <form onSubmit={handlePromptSubmit} className="space-y-4">
                <div>
                  <label htmlFor="agent-nl-prompt" className="block text-sm font-semibold text-ink mb-1.5">
                    Tell your Builder Agent what to change
                  </label>
                  <textarea
                    id="agent-nl-prompt"
                    rows={3}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g. Change every font family to Inter, sans-serif, and update our contact phone number to +1 555-0199 across all pages…"
                    className="w-full rounded-xl border border-line bg-cream p-3 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20 transition"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted">
                    The agent scans your pages, plans the changes, and shows a full preview before applying.
                  </p>
                  <Button
                    type="submit"
                    disabled={planMutation.isPending || prompt.trim().length < 3}
                  >
                    {planMutation.isPending ? "Planning changes…" : "Plan changes"}
                  </Button>
                </div>
              </form>
            )}

            {/* TAB 2: Global Font Family */}
            {activeTab === "font" && (
              <form onSubmit={handleFontSubmit} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="from-font-input" className="block text-xs font-semibold text-muted mb-1">
                      From font family (leave blank for all fonts)
                    </label>
                    <input
                      id="from-font-input"
                      type="text"
                      value={fromFont}
                      onChange={(e) => setFromFont(e.target.value)}
                      placeholder="e.g. Space Grotesk (or leave blank)"
                      className="w-full rounded-xl border border-line bg-cream p-2.5 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20"
                    />
                  </div>
                  <div>
                    <label htmlFor="to-font-input" className="block text-xs font-semibold text-muted mb-1">
                      To new font family *
                    </label>
                    <input
                      id="to-font-input"
                      type="text"
                      required
                      value={toFont}
                      onChange={(e) => setToFont(e.target.value)}
                      placeholder="e.g. 'Inter', sans-serif"
                      className="w-full rounded-xl border border-line bg-cream p-2.5 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-4 text-xs">
                    <span className="font-semibold text-muted">Applies to:</span>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="fontKind"
                        checked={targetFontKind === "all"}
                        onChange={() => setTargetFontKind("all")}
                        className="accent-ink"
                      />
                      All elements
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="fontKind"
                        checked={targetFontKind === "heading"}
                        onChange={() => setTargetFontKind("heading")}
                        className="accent-ink"
                      />
                      Headings only
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="fontKind"
                        checked={targetFontKind === "button"}
                        onChange={() => setTargetFontKind("button")}
                        className="accent-ink"
                      />
                      Buttons only
                    </label>
                  </div>
                  <Button type="submit" disabled={planMutation.isPending || !toFont.trim()}>
                    {planMutation.isPending ? "Scanning pages…" : "Plan font replacement"}
                  </Button>
                </div>
              </form>
            )}

            {/* TAB 3: Global Color Code */}
            {activeTab === "color" && (
              <form onSubmit={handleColorSubmit} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="from-color-input" className="block text-xs font-semibold text-muted mb-1">
                      From color code *
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="color"
                        value={fromColor.startsWith("#") && fromColor.length === 7 ? fromColor : "#08101F"}
                        onChange={(e) => setFromColor(e.target.value)}
                        className="h-10 w-10 rounded-xl border border-line p-1 cursor-pointer"
                        title="Pick color"
                      />
                      <input
                        id="from-color-input"
                        type="text"
                        required
                        value={fromColor}
                        onChange={(e) => setFromColor(e.target.value)}
                        placeholder="#08101F"
                        className="flex-1 rounded-xl border border-line bg-cream p-2.5 font-mono text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20"
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="to-color-input" className="block text-xs font-semibold text-muted mb-1">
                      To new color code *
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="color"
                        value={toColor.startsWith("#") && toColor.length === 7 ? toColor : "#1E293B"}
                        onChange={(e) => setToColor(e.target.value)}
                        className="h-10 w-10 rounded-xl border border-line p-1 cursor-pointer"
                        title="Pick color"
                      />
                      <input
                        id="to-color-input"
                        type="text"
                        required
                        value={toColor}
                        onChange={(e) => setToColor(e.target.value)}
                        placeholder="#1E293B"
                        className="flex-1 rounded-xl border border-line bg-cream p-2.5 font-mono text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted">
                    Replaces this color across text, backgrounds, borders, and shadows on every page.
                  </p>
                  <Button
                    type="submit"
                    disabled={planMutation.isPending || !fromColor.trim() || !toColor.trim()}
                  >
                    {planMutation.isPending ? "Scanning pages…" : "Plan color replacement"}
                  </Button>
                </div>
              </form>
            )}

            {/* TAB 4: Phone & Cross-Page Content */}
            {activeTab === "content" && (
              <form onSubmit={handleContentSubmit} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="find-text-input" className="block text-xs font-semibold text-muted mb-1">
                      Find phone number or text *
                    </label>
                    <input
                      id="find-text-input"
                      type="text"
                      required
                      value={findText}
                      onChange={(e) => setFindText(e.target.value)}
                      placeholder="e.g. +1 (234) 567-8900"
                      className="w-full rounded-xl border border-line bg-cream p-2.5 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20"
                    />
                  </div>
                  <div>
                    <label htmlFor="replace-text-input" className="block text-xs font-semibold text-muted mb-1">
                      Replace with *
                    </label>
                    <input
                      id="replace-text-input"
                      type="text"
                      required
                      value={replaceText}
                      onChange={(e) => setReplaceText(e.target.value)}
                      placeholder="e.g. +1 (555) 019-9234"
                      className="w-full rounded-xl border border-line bg-cream p-2.5 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3 text-xs">
                    <span className="font-semibold text-muted">Match mode:</span>
                    <select
                      value={contentKind}
                      onChange={(e) => setContentKind(e.target.value as typeof contentKind)}
                      className="rounded-lg border border-line bg-white px-2.5 py-1 text-xs text-ink"
                    >
                      <option value="auto">Auto-detect</option>
                      <option value="phone">Phone number (synchronizes tel: links)</option>
                      <option value="email">Email (synchronizes mailto: links)</option>
                      <option value="text">Exact text match</option>
                    </select>
                  </div>
                  <Button type="submit" disabled={planMutation.isPending || !findText.trim()}>
                    {planMutation.isPending ? "Scanning pages…" : "Plan cross-page replacement"}
                  </Button>
                </div>
              </form>
            )}

            {/* TAB 5: Full SEO & GitHub Repository Metadata Manager */}
            {activeTab === "seo" && (
              <div className="space-y-6">
                {seoStatusMsg && (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs font-medium text-emerald-800">
                    {seoStatusMsg}
                  </div>
                )}

                {/* Part A: GitHub Repository About & Topics Metadata */}
                <div className="rounded-2xl border border-line bg-cream/60 p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-ink">
                        GitHub Repository Metadata & Topic Tags
                      </h4>
                      <p className="text-[11px] text-muted">
                        Updates the GitHub repository &ldquo;About&rdquo; description, homepage URL, and searchable repository topics (`{seoOverview.data?.repo || site?.repo}`).
                      </p>
                    </div>
                    <Button
                      type="button"
                      disabled={saveRepoSeoMutation.isPending}
                      onClick={() => saveRepoSeoMutation.mutate()}
                    >
                      {saveRepoSeoMutation.isPending ? "Updating GitHub Repo…" : "Update GitHub Repo SEO"}
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-muted mb-1">
                        Repo About Description
                      </label>
                      <input
                        type="text"
                        value={repoDescription}
                        onChange={(e) => setRepoDescription(e.target.value)}
                        placeholder="Short repository description on GitHub…"
                        className="w-full rounded-xl border border-line bg-white p-2 text-xs text-ink outline-none focus:border-blue"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-muted mb-1">
                        Repo Homepage / Live Website URL
                      </label>
                      <input
                        type="url"
                        value={repoHomepage}
                        onChange={(e) => setRepoHomepage(e.target.value)}
                        placeholder="https://yourdomain.com"
                        className="w-full rounded-xl border border-line bg-white p-2 text-xs text-ink outline-none focus:border-blue"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-muted mb-1">
                        Repo Topics / Tags (comma-separated)
                      </label>
                      <input
                        type="text"
                        value={repoTopicsInput}
                        onChange={(e) => setRepoTopicsInput(e.target.value)}
                        placeholder="e.g. portfolio,nextjs,agency,ecommerce"
                        className="w-full rounded-xl border border-line bg-white p-2 text-xs text-ink outline-none focus:border-blue"
                      />
                    </div>
                  </div>
                </div>

                {/* Part B: Page <head> SEO Properties & Auto-Optimizer */}
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <label htmlFor="seo-page-select" className="text-xs font-bold text-ink">
                        Page &lt;head&gt; SEO Target:
                      </label>
                      <select
                        id="seo-page-select"
                        value={selectedSeoPageId}
                        onChange={(e) => setSelectedSeoPageId(e.target.value)}
                        className="rounded-xl border border-line bg-cream px-3 py-1.5 text-xs font-semibold text-ink"
                      >
                        {seoOverview.data?.pages?.map((p) => (
                          <option key={p.pageId} value={p.pageId}>
                            {p.title} ({p.path})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={autoGenerateSeoMutation.isPending}
                        onClick={() => autoGenerateSeoMutation.mutate({ pageId: selectedSeoPageId, applyDraft: true })}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-blue/40 bg-blue/10 px-3 py-1.5 text-xs font-semibold text-blue hover:bg-blue/20 transition"
                      >
                        <IconSparkles />
                        <span>
                          {autoGenerateSeoMutation.isPending
                            ? "Generating Smart SEO…"
                            : "Auto-Generate Smart SEO from Page Content"}
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={autoGenerateSeoMutation.isPending}
                        onClick={() => autoGenerateSeoMutation.mutate({ applyDraft: true })}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-cream px-3 py-1.5 text-xs font-semibold text-ink hover:bg-line/40 transition"
                      >
                        <IconZap />
                        <span>Auto-Optimize All Pages</span>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <div className="flex justify-between mb-1">
                        <label className="text-xs font-semibold text-muted">
                          SEO Title (&lt;title&gt; &amp; og:title)
                        </label>
                        <span className="text-[11px] text-muted">{seoTitle.length}/60 chars</span>
                      </div>
                      <input
                        type="text"
                        value={seoTitle}
                        onChange={(e) => setSeoTitle(e.target.value)}
                        placeholder="Page Title | Brand Name"
                        className="w-full rounded-xl border border-line bg-cream p-2.5 text-sm text-ink outline-none focus:border-blue"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-muted mb-1">
                        SEO Keywords / Meta Tags (comma-separated)
                      </label>
                      <input
                        type="text"
                        value={seoKeywords}
                        onChange={(e) => setSeoKeywords(e.target.value)}
                        placeholder="web design, digital studio, creative agency, portfolio"
                        className="w-full rounded-xl border border-line bg-cream p-2.5 text-sm text-ink outline-none focus:border-blue"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between mb-1">
                      <label className="text-xs font-semibold text-muted">
                        Meta Description (`description`, `og:description`, `twitter:description`)
                      </label>
                      <span className="text-[11px] text-muted">{seoDescription.length}/160 chars</span>
                    </div>
                    <textarea
                      rows={2}
                      value={seoDescription}
                      onChange={(e) => setSeoDescription(e.target.value)}
                      placeholder="Compelling 150-160 character summary shown in Google search results and social previews…"
                      className="w-full rounded-xl border border-line bg-cream p-2.5 text-sm text-ink outline-none focus:border-blue"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div>
                      <label className="block text-xs font-semibold text-muted mb-1">
                        Social Share Image URL (`og:image`)
                      </label>
                      <input
                        type="text"
                        value={seoOgImage}
                        onChange={(e) => setSeoOgImage(e.target.value)}
                        placeholder="https://.../og-cover.jpg"
                        className="w-full rounded-xl border border-line bg-cream p-2 text-xs text-ink outline-none focus:border-blue"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-muted mb-1">
                        Canonical URL (`rel="canonical"`)
                      </label>
                      <input
                        type="text"
                        value={seoCanonical}
                        onChange={(e) => setSeoCanonical(e.target.value)}
                        placeholder="https://yourdomain.com/"
                        className="w-full rounded-xl border border-line bg-cream p-2 text-xs text-ink outline-none focus:border-blue"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-muted mb-1">
                        Robots Directive (`meta name="robots"`)
                      </label>
                      <input
                        type="text"
                        value={seoRobots}
                        onChange={(e) => setSeoRobots(e.target.value)}
                        placeholder="index, follow"
                        className="w-full rounded-xl border border-line bg-cream p-2 text-xs text-ink outline-none focus:border-blue"
                      />
                    </div>
                  </div>

                  {/* Live Google Search Snippet Preview */}
                  <div className="rounded-xl border border-line bg-cream/40 p-3.5">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
                      Live Google Search & Social Preview
                    </div>
                    <div className="text-xs text-emerald-700 truncate">
                      {seoCanonical || repoHomepage || `https://${site?.repo?.split("/")[1] || "example"}.com`}
                    </div>
                    <div className="text-sm font-semibold text-[#1a0dab] truncate mt-0.5">
                      {seoTitle || "Untitled Page — Click Auto-Generate Smart SEO"}
                    </div>
                    <div className="text-xs text-muted line-clamp-2 mt-0.5">
                      {seoDescription || "Add a meta description so Google and social platforms display a high-converting preview snippet for this page."}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={savePageSeoMutation.isPending || !selectedSeoPageId}
                      onClick={() => savePageSeoMutation.mutate(false)}
                    >
                      {savePageSeoMutation.isPending ? "Saving Draft…" : "Save SEO to Draft"}
                    </Button>
                    <Button
                      type="button"
                      disabled={savePageSeoMutation.isPending || !selectedSeoPageId}
                      onClick={() => savePageSeoMutation.mutate(true)}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <IconUploadCloud />
                        <span>
                          {savePageSeoMutation.isPending
                            ? "Publishing SEO to Repo…"
                            : "Save & Publish SEO to GitHub Repo"}
                        </span>
                      </span>
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Feedback & Error Messages */}
          {error && (
            <div role="alert" className="rounded-2xl border border-danger-line bg-danger-surface p-4 text-sm text-danger-text">
              {error}
            </div>
          )}

          {/* Plan Review & Multi-Page Diff View */}
          {plan && (
            <section className="space-y-4 rounded-2xl border border-line bg-white p-5 shadow-xs">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-blue/10 px-2.5 py-0.5 text-xs font-bold text-blue uppercase">
                      Site Plan Ready
                    </span>
                    {plan.model && <span className="text-xs text-muted">via {plan.model}</span>}
                  </div>
                  <h3 className="mt-1.5 font-display text-lg text-ink font-semibold">{plan.explanation}</h3>
                  <p className="text-xs text-muted">
                    Affects {plan.summary.affectedPages} page{plan.summary.affectedPages === 1 ? "" : "s"} ({plan.summary.totalChanges} total changes). Review details below before applying.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <Button
                    variant="accent"
                    onClick={() => applyMutation.mutate()}
                    disabled={applyMutation.isPending || selectedPages.size === 0}
                  >
                    {applyMutation.isPending
                      ? "Applying to drafts…"
                      : `Apply to ${selectedPages.size} page${selectedPages.size === 1 ? "" : "s"}`}
                  </Button>
                </div>
              </div>

              {/* Per-Page Diff Accordion */}
              {plan.pages.length > 0 ? (
                <div className="space-y-3">
                  {plan.pages.map((p) => {
                    const isSelected = selectedPages.has(p.pageId);
                    return (
                      <div
                        key={p.pageId}
                        className={`rounded-xl border transition ${
                          isSelected ? "border-line bg-white" : "border-dashed border-line bg-sunken/40 opacity-70"
                        }`}
                      >
                        <div className="flex items-center justify-between border-b border-line bg-cream px-4 py-3">
                          <label className="flex items-center gap-2.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => togglePageSelection(p.pageId)}
                              className="accent-ink"
                            />
                            <span className="font-display text-sm font-semibold text-ink">{p.pageTitle}</span>
                            <span className="font-mono text-xs text-muted">({p.pagePath})</span>
                          </label>
                          <span className="rounded-full bg-sunken px-2 py-0.5 text-xs text-muted">
                            {p.changes.length} change{p.changes.length === 1 ? "" : "s"}
                          </span>
                        </div>

                        <div className="divide-y divide-line/60 p-3 text-xs">
                          {p.changes.map((c, i) => (
                            <div key={i} className="py-2.5 first:pt-1 last:pb-1">
                              <div className="flex items-center justify-between text-muted mb-1.5">
                                <span className="font-semibold text-ink">{c.label}</span>
                                <span className="font-mono uppercase text-[11px]">{c.property}</span>
                              </div>
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div className="rounded-lg bg-sunken p-2">
                                  <span className="block font-semibold text-muted text-[10px] uppercase">Before</span>
                                  <span className="mt-0.5 block break-all font-mono text-ink/80">{c.before || "Not set"}</span>
                                </div>
                                <div className="rounded-lg bg-positive-surface p-2 border border-positive-line/50">
                                  <span className="block font-semibold text-positive-text text-[10px] uppercase">After</span>
                                  <span className="mt-0.5 block break-all font-mono text-ink font-medium">{c.after}</span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted py-2">No matching elements were found to update.</p>
              )}
            </section>
          )}

          {/* Apply Results Banner */}
          {applyResult && (
            <div className="rounded-2xl border border-positive-line bg-positive-surface p-5 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-positive-text font-semibold">
                    <span>✓ Changes successfully applied to drafts!</span>
                  </div>
                  <p className="mt-1 text-xs text-ink">
                    Updated {applyResult.appliedPages} page{applyResult.appliedPages === 1 ? "" : "s"} ({applyResult.totalChanges} fields) with revision conflict protection.
                  </p>
                </div>

                {batchPublished ? (
                  <div className="rounded-xl border border-positive-line bg-white px-3.5 py-2 text-xs font-semibold text-positive-text">
                    🚀 Published {batchPublished.publishedPages} page{batchPublished.publishedPages === 1 ? "" : "s"} live in 1 commit!
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={publishBatchMutation.isPending}
                    onClick={() => publishBatchMutation.mutate()}
                    className="rounded-xl bg-ink px-4 py-2 text-xs font-semibold text-white hover:bg-ink/90 transition disabled:opacity-50"
                  >
                    {publishBatchMutation.isPending
                      ? "Publishing all pages live…"
                      : `🚀 Publish All ${applyResult.appliedPages} Page${applyResult.appliedPages === 1 ? "" : "s"} Live`}
                  </button>
                )}
              </div>

              <div className="mt-4 space-y-2">
                {applyResult.results.map((res) => (
                  <div key={res.pageId} className="flex items-center justify-between rounded-xl bg-white/80 p-3 text-xs">
                    <div>
                      <span className="font-semibold text-ink">{res.pageTitle}</span>
                      <span className="ml-2 text-muted">{res.message}</span>
                    </div>
                    <Link
                      to={`/website/pages/${res.pageId}`}
                      className="font-medium text-blue hover:underline"
                    >
                      Open in editor →
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Quick Page Editor Link Grid */}
          <div className="mt-8 border-t border-line pt-6">
            <h3 className="font-display text-base font-semibold text-ink mb-3">Individual Pages</h3>
            <p className="text-xs text-muted mb-4">You can also open any page directly in the visual editor to inspect or make manual edits.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
              {overview.data && sites.data && (
                <Link
                  to={`/website/sites`}
                  className="flex items-center justify-between rounded-xl border border-line bg-white p-3 hover:bg-cream transition text-xs font-medium text-blue"
                >
                  <span>View all {overview.data.pageCount} pages in site list</span>
                  <span>→</span>
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
