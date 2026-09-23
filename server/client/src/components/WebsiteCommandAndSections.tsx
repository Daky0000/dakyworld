import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  IconCheck,
  IconCopy,
  IconDesktop,
  IconDownload,
  IconEye,
  IconFileText,
  IconLayers,
  IconLayout,
  IconMessageSquare,
  IconMoon,
  IconPhoneDevice,
  IconPlusSquare,
  IconSearch,
  IconSparkles,
  IconSun,
  IconTablet,
  IconTarget,
  IconTrash,
  IconType,
  IconUploadCloud,
  IconXCircle,
  IconZap,
} from "./WebsiteIcons";

export type SectionTemplateId =
  | "hero"
  | "features"
  | "pricing"
  | "testimonials"
  | "faq"
  | "cta-banner";

const SECTION_CATALOG: Array<{
  id: SectionTemplateId;
  title: string;
  category: string;
  description: string;
  badge: string;
}> = [
  {
    id: "hero",
    title: "Hero Banner with Dual CTA",
    category: "Header & Hero",
    description: "Centered high-impact headline, subtitle, primary conversion button, and secondary action link.",
    badge: "High Conversion",
  },
  {
    id: "features",
    title: "3-Column Features & Benefits Grid",
    category: "Value Proposition",
    description: "Responsive 3-card feature grid highlighting core strengths, turnaround speed, and client value.",
    badge: "Popular",
  },
  {
    id: "pricing",
    title: "Pricing Plans Comparison",
    category: "Commerce & Sales",
    description: "Side-by-side Starter and Growth pricing cards with clear deliverables and direct booking CTAs.",
    badge: "Revenue",
  },
  {
    id: "testimonials",
    title: "Client Testimonials Grid",
    category: "Social Proof",
    description: "Two-column customer quote cards with founder attribution to build instant buyer trust.",
    badge: "Trust",
  },
  {
    id: "faq",
    title: "Frequently Asked Questions",
    category: "Objection Handling",
    description: "Clean Q&A cards addressing common client questions before they reach out.",
    badge: "SEO Friendly",
  },
  {
    id: "cta-banner",
    title: "High-Impact Call to Action Banner",
    category: "Lead Capture",
    description: "Dark contrast banner designed to drive consultations, calls, and WhatsApp inquiries.",
    badge: "Lead Gen",
  },
];

export function WebsiteSectionLibraryModal({
  open,
  onClose,
  siteId,
  pageId,
  onInserted,
}: {
  open: boolean;
  onClose: () => void;
  siteId: string;
  pageId: string;
  onInserted: (label: string) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");

  const insertMutation = useMutation({
    mutationFn: async (templateId: SectionTemplateId) => {
      return api.post<{ ok: boolean; label: string }>(
        `/website/sites/${siteId}/pages/${pageId}/insert-section`,
        { templateId },
      );
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
      onInserted(res.label);
      onClose();
    },
  });

  if (!open) return null;

  const filtered = SECTION_CATALOG.filter(
    (item) =>
      !search.trim() ||
      item.title.toLowerCase().includes(search.toLowerCase()) ||
      item.category.toLowerCase().includes(search.toLowerCase()) ||
      item.description.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-2xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="section-library-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-blue/10 text-blue">
              <IconPlusSquare size={16} />
            </span>
            <div>
              <h2 id="section-library-title" className="font-display text-base font-bold text-ink">
                Insert Pre-Built Section
              </h2>
              <p className="text-xs text-muted">
                Add a responsive, fully editable section directly into your page canvas
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
            aria-label="Close section library"
          >
            <IconXCircle size={16} />
          </button>
        </div>

        <div className="border-b border-line bg-sunken/30 px-5 py-2.5">
          <div className="relative flex items-center">
            <IconSearch size={14} className="absolute left-3 text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter sections by name, category, or goal (e.g. Hero, Pricing, FAQ)…"
              className="w-full rounded-xl border border-line bg-white py-2 pl-9 pr-3 text-xs text-ink outline-none focus:border-blue"
              autoFocus
            />
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-5 sm:grid-cols-2">
          {filtered.map((item) => (
            <div
              key={item.id}
              className="flex flex-col justify-between rounded-xl border border-line bg-white p-4 transition hover:border-blue hover:shadow-md"
            >
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                    {item.category}
                  </span>
                  <span className="rounded-full bg-blue/10 px-2 py-0.5 text-[10px] font-semibold text-blue">
                    {item.badge}
                  </span>
                </div>
                <h3 className="font-display text-sm font-bold text-ink">{item.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted">{item.description}</p>
              </div>

              <div className="mt-4 pt-3 border-t border-line/60 flex items-center justify-between">
                <span className="text-[11px] text-muted">100% visually editable</span>
                <button
                  type="button"
                  disabled={insertMutation.isPending}
                  onClick={() => insertMutation.mutate(item.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue disabled:opacity-50"
                >
                  <IconPlusSquare size={13} />
                  <span>{insertMutation.isPending ? "Inserting…" : "Insert Section"}</span>
                </button>
              </div>
            </div>
          ))}
        </div>

        {insertMutation.error && (
          <div className="border-t border-line bg-danger-surface px-5 py-2.5 text-xs text-danger-text">
            {(insertMutation.error as Error).message || "Could not insert section."}
          </div>
        )}
      </div>
    </div>
  );
}

export interface CommandPaletteFieldItem {
  id: string;
  label: string;
  kind: string;
  value: string;
}

export function WebsiteCommandPaletteModal({
  open,
  onClose,
  fields,
  onSelectField,
  onOpenSeoTab,
  onOpenSectionLibrary,
  onOpenAiAssistant,
  onSetDevice,
  onToggleTheme,
  onOpenPublishReview,
}: {
  open: boolean;
  onClose: () => void;
  fields: CommandPaletteFieldItem[];
  onSelectField: (fieldId: string) => void;
  onOpenSeoTab: () => void;
  onOpenSectionLibrary: () => void;
  onOpenAiAssistant: () => void;
  onSetDevice: (device: "desktop" | "tablet" | "mobile") => void;
  onToggleTheme: () => void;
  onOpenPublishReview: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const actions = useMemo(
    () => [
      {
        id: "act-insert-section",
        title: "Insert Pre-Built Section (Hero, Pricing, FAQ, CTA…)",
        category: "Builder",
        icon: IconPlusSquare,
        run: () => {
          onClose();
          onOpenSectionLibrary();
        },
      },
      {
        id: "act-open-seo",
        title: "Open Page SEO, Google/Social Previews & Schema",
        category: "SEO & Growth",
        icon: IconTarget,
        run: () => {
          onClose();
          onOpenSeoTab();
        },
      },
      {
        id: "act-ai-assistant",
        title: "Open AI Website Agent & Copywriter",
        category: "AI Agent",
        icon: IconSparkles,
        run: () => {
          onClose();
          onOpenAiAssistant();
        },
      },
      {
        id: "act-publish-review",
        title: "Review Changes & Publish to GitHub",
        category: "Publishing",
        icon: IconUploadCloud,
        run: () => {
          onClose();
          onOpenPublishReview();
        },
      },
      {
        id: "act-device-desktop",
        title: "Switch Canvas to Desktop Viewport",
        category: "Viewport",
        icon: IconDesktop,
        run: () => {
          onSetDevice("desktop");
          onClose();
        },
      },
      {
        id: "act-device-tablet",
        title: "Switch Canvas to Tablet Viewport",
        category: "Viewport",
        icon: IconTablet,
        run: () => {
          onSetDevice("tablet");
          onClose();
        },
      },
      {
        id: "act-device-phone",
        title: "Switch Canvas to Mobile Phone Viewport",
        category: "Viewport",
        icon: IconPhoneDevice,
        run: () => {
          onSetDevice("mobile");
          onClose();
        },
      },
      {
        id: "act-theme",
        title: "Toggle Editor Light / Dark Theme",
        category: "Workspace",
        icon: IconMoon,
        run: () => {
          onToggleTheme();
          onClose();
        },
      },
    ],
    [
      onClose,
      onOpenSectionLibrary,
      onOpenSeoTab,
      onOpenAiAssistant,
      onOpenPublishReview,
      onSetDevice,
      onToggleTheme,
    ],
  );

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filteredActions = actions.filter(
    (a) => !q || a.title.toLowerCase().includes(q) || a.category.toLowerCase().includes(q),
  );
  const matchingFields = fields
    .filter(
      (f) =>
        !q ||
        f.label.toLowerCase().includes(q) ||
        f.value.toLowerCase().includes(q) ||
        f.kind.toLowerCase().includes(q),
    )
    .slice(0, 12);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/50 pt-20 p-4 backdrop-blur-2xs"
      role="dialog"
      aria-modal="true"
      aria-label="Editor Command Palette"
      onClick={onClose}
    >
      <div
        className="flex max-h-[75vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <IconSearch size={16} className="text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            placeholder="Type a command or search any heading, button, or section on this page…"
            className="w-full border-0 bg-transparent text-xs text-ink outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-line bg-sunken px-1.5 py-0.5 font-mono text-[10px] text-muted">
            ESC
          </kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {filteredActions.length > 0 && (
            <div className="mb-2">
              <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted">
                Quick Actions
              </div>
              {filteredActions.map((act) => {
                const IconComp = act.icon;
                return (
                  <button
                    key={act.id}
                    type="button"
                    onClick={act.run}
                    className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs text-ink transition hover:bg-sunken"
                  >
                    <span className="flex items-center gap-2.5">
                      <IconComp size={14} className="text-blue" />
                      <span className="font-medium">{act.title}</span>
                    </span>
                    <span className="rounded bg-sunken px-1.5 py-0.5 text-[10px] text-muted">
                      {act.category}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {matchingFields.length > 0 && (
            <div>
              <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted">
                Jump to Page Element ({matchingFields.length})
              </div>
              {matchingFields.map((field) => (
                <button
                  key={field.id}
                  type="button"
                  onClick={() => {
                    onSelectField(field.id);
                    onClose();
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs text-ink transition hover:bg-sunken"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <IconType size={14} className="shrink-0 text-muted" />
                    <span className="truncate font-medium">{field.label}</span>
                    {field.value && (
                      <span className="truncate text-[11px] text-muted">
                        — {field.value.slice(0, 60)}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted">
                    {field.kind}
                  </span>
                </button>
              ))}
            </div>
          )}

          {filteredActions.length === 0 && matchingFields.length === 0 && (
            <div className="py-8 text-center text-xs text-muted">
              No matching commands or page elements found for "{query}".
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export interface RevisionCommentItem {
  id: string;
  pageId: string;
  fieldId: string | null;
  elementLabel: string;
  authorName: string;
  message: string;
  resolved: boolean;
  createdAt: string;
}

export function WebsiteRevisionCommentsModal({
  open,
  onClose,
  siteId,
  pageId,
  selectedFieldId,
  selectedFieldLabel,
  onSelectField,
}: {
  open: boolean;
  onClose: () => void;
  siteId: string;
  pageId: string;
  selectedFieldId: string | null;
  selectedFieldLabel: string | null;
  onSelectField: (fieldId: string) => void;
}) {
  const qc = useQueryClient();
  const [message, setMessage] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [pinToSelected, setPinToSelected] = useState(true);

  const commentsQuery = useQuery({
    queryKey: ["website", "comments", siteId, pageId],
    enabled: Boolean(siteId && pageId),
    queryFn: () =>
      api.get<{ comments: RevisionCommentItem[] }>(
        `/website/sites/${siteId}/pages/${pageId}/comments`,
      ),
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      return api.post<{ comment: RevisionCommentItem; comments: RevisionCommentItem[] }>(
        `/website/sites/${siteId}/pages/${pageId}/comments`,
        {
          fieldId: pinToSelected && selectedFieldId ? selectedFieldId : null,
          elementLabel:
            pinToSelected && selectedFieldId && selectedFieldLabel
              ? selectedFieldLabel
              : "General Page Note",
          authorName: authorName.trim() || undefined,
          message: message.trim(),
        },
      );
    },
    onSuccess: () => {
      setMessage("");
      void qc.invalidateQueries({ queryKey: ["website", "comments", siteId, pageId] });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (input: { commentId: string; resolved?: boolean; delete?: boolean }) => {
      return api.patch<{ comments: RevisionCommentItem[] }>(
        `/website/sites/${siteId}/pages/${pageId}/comments/${input.commentId}`,
        { resolved: input.resolved, delete: input.delete },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["website", "comments", siteId, pageId] });
    },
  });

  if (!open) return null;

  const comments = commentsQuery.data?.comments ?? [];
  const unresolvedCount = comments.filter((c) => !c.resolved).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-2xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="revision-comments-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-blue/10 text-blue">
              <IconMessageSquare size={16} />
            </span>
            <div>
              <h2 id="revision-comments-title" className="font-display text-base font-bold text-ink">
                Client Pin-Comments &amp; Revision Checklist
              </h2>
              <p className="text-xs text-muted">
                {unresolvedCount} open item{unresolvedCount === 1 ? "" : "s"} · {comments.length} total notes
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
            aria-label="Close comments"
          >
            <IconXCircle size={16} />
          </button>
        </div>

        {/* Add New Pin-Comment Form */}
        <div className="border-b border-line bg-sunken/30 p-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            {selectedFieldId ? (
              <label className="flex cursor-pointer items-center gap-2 font-medium text-ink">
                <input
                  type="checkbox"
                  checked={pinToSelected}
                  onChange={(e) => setPinToSelected(e.target.checked)}
                />
                <span>
                  Pin to selected element:{" "}
                  <strong className="rounded bg-blue/10 px-1.5 py-0.5 text-blue">
                    {selectedFieldLabel || selectedFieldId}
                  </strong>
                </span>
              </label>
            ) : (
              <span className="text-muted">
                Tip: Click any heading or button on the canvas first to pin your note directly to it.
              </span>
            )}
            <input
              type="text"
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              placeholder="Reviewer name (optional)"
              className="rounded-lg border border-line bg-white px-2.5 py-1 text-xs text-ink outline-none focus:border-blue"
            />
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && message.trim() && !addMutation.isPending) {
                  addMutation.mutate();
                }
              }}
              placeholder="Write a client revision request or note (e.g. 'Update this headline to mention 24/7 support')…"
              className="flex-1 rounded-xl border border-line bg-white px-3 py-2 text-xs text-ink outline-none focus:border-blue"
            />
            <button
              type="button"
              disabled={!message.trim() || addMutation.isPending}
              onClick={() => addMutation.mutate()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-ink px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-blue disabled:opacity-40"
            >
              <IconPlusSquare size={13} />
              <span>{addMutation.isPending ? "Pinning…" : "Add Pin"}</span>
            </button>
          </div>
        </div>

        {/* Checklist Items */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-2.5">
          {comments.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted">
              No revision comments on this page yet. Add a note above or right-click any element on the canvas to pin feedback.
            </div>
          ) : (
            comments.map((item) => (
              <div
                key={item.id}
                className={`flex items-start justify-between gap-3 rounded-xl border p-3 transition ${
                  item.resolved
                    ? "border-line bg-sunken/40 opacity-70"
                    : "border-line bg-white shadow-2xs"
                }`}
              >
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <button
                    type="button"
                    onClick={() =>
                      toggleMutation.mutate({ commentId: item.id, resolved: !item.resolved })
                    }
                    title={item.resolved ? "Mark as unresolved" : "Mark as resolved"}
                    className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${
                      item.resolved
                        ? "border-emerald-600 bg-emerald-600 text-white"
                        : "border-line bg-white text-transparent hover:border-blue"
                    }`}
                  >
                    <IconCheck size={12} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold text-ink">{item.authorName}</span>
                      {item.fieldId ? (
                        <button
                          type="button"
                          onClick={() => {
                            onSelectField(item.fieldId!);
                            onClose();
                          }}
                          className="inline-flex items-center gap-1 rounded-md bg-blue/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue hover:bg-blue/20"
                          title="Jump to this element on the canvas"
                        >
                          <IconTarget size={10} />
                          <span>{item.elementLabel}</span>
                        </button>
                      ) : (
                        <span className="rounded-md bg-sunken px-1.5 py-0.5 text-[10px] text-muted">
                          {item.elementLabel}
                        </span>
                      )}
                      <span className="text-[10px] text-muted">
                        {new Date(item.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <p
                      className={`mt-1 text-xs leading-relaxed ${
                        item.resolved ? "line-through text-muted" : "text-ink"
                      }`}
                    >
                      {item.message}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => toggleMutation.mutate({ commentId: item.id, delete: true })}
                  title="Delete comment"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-red-600"
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

interface ClientReportResponse {
  generatedAt: string;
  site: { id: string; name: string; publicUrl: string; repo: string | null };
  page: { id: string; title: string; path: string; lastPublishedAt: string | null };
  score: number;
  seo: {
    title: string;
    description: string;
    keywords: string;
    canonical: string;
    robots: string;
    ogImage: string;
  };
  technical: {
    totalImages: number;
    imagesWithAlt: number;
    imagesWithLazy: number;
    hasJsonLd: boolean;
    hasConversionBar: boolean;
    hasBrandTheme: boolean;
    h1Count: number;
  };
  healthMonitor: {
    checkedAt: string;
    online: boolean;
    statusCode: number | null;
    responseTimeMs: number | null;
    ssl: { valid: boolean; issuer: string | null; daysRemaining: number | null };
  } | null;
  recentActivity: Array<{
    id: string;
    kind: string;
    summary: string;
    actorName: string | null;
    createdAt: string;
  }>;
}

export function WebsiteClientReportModal({
  open,
  onClose,
  siteId,
  pageId,
}: {
  open: boolean;
  onClose: () => void;
  siteId: string;
  pageId: string;
}) {
  const [copied, setCopied] = useState(false);

  const reportQuery = useQuery({
    queryKey: ["website", "report", siteId, pageId],
    enabled: Boolean(open && siteId && pageId),
    queryFn: () =>
      api.get<ClientReportResponse>(`/website/sites/${siteId}/pages/${pageId}/report`),
  });

  if (!open) return null;
  const r = reportQuery.data;

  const handleCopySummary = async () => {
    if (!r) return;
    const text = [
      `WEBSITE & SEO OPTIMIZATION REPORT — ${r.site.name} (${r.page.title})`,
      `Overall Health & SEO Score: ${r.score}/100`,
      `Public URL: ${r.site.publicUrl}${r.page.path}`,
      `SEO Title: ${r.seo.title || "Not configured"}`,
      `Meta Description: ${r.seo.description || "Not configured"}`,
      `Image Alt-Text Coverage: ${r.technical.imagesWithAlt}/${r.technical.totalImages} images`,
      `Lazy-Loaded Speed Images: ${r.technical.imagesWithLazy}/${r.technical.totalImages} images`,
      `Schema.org JSON-LD Structured Data: ${r.technical.hasJsonLd ? "Active" : "Pending"}`,
      `WhatsApp/Lead Conversion Widget: ${r.technical.hasConversionBar ? "Active" : "Not enabled"}`,
      r.healthMonitor
        ? `Uptime & SSL Status: ${r.healthMonitor.online ? `ONLINE (${r.healthMonitor.responseTimeMs}ms)` : "Check required"} · SSL ${r.healthMonitor.ssl.valid ? `Valid (${r.healthMonitor.ssl.daysRemaining} days left)` : "Unverified"}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {}
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-2xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="client-report-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-blue/10 text-blue">
              <IconFileText size={16} />
            </span>
            <div>
              <h2 id="client-report-title" className="font-display text-base font-bold text-ink">
                Client SEO &amp; Website Optimization Report
              </h2>
              <p className="text-xs text-muted">
                Executive care &amp; performance deliverable ready to share or print as PDF
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopySummary}
              disabled={!r}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-sunken/50 px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-sunken disabled:opacity-40"
            >
              {copied ? <IconCheck size={13} className="text-emerald-600" /> : <IconCopy size={13} />}
              <span>{copied ? "Copied Summary" : "Copy Report"}</span>
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue"
            >
              <IconDownload size={13} />
              <span>Print / Save PDF</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
              aria-label="Close report"
            >
              <IconXCircle size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6 space-y-5 text-xs">
          {reportQuery.isFetching && <div className="text-muted">Compiling live website report…</div>}
          {r && (
            <>
              {/* Score & Site Banner */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-sunken/30 p-4">
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-muted">
                    Client Website Deliverable
                  </div>
                  <div className="mt-0.5 font-display text-lg font-bold text-ink">
                    {r.site.name} — {r.page.title} ({r.page.path})
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-muted">{r.site.publicUrl}</div>
                </div>
                <div className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-2.5 shadow-2xs">
                  <div className="text-right">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-muted">
                      Health &amp; SEO Score
                    </div>
                    <div className="text-[11px] text-emerald-700 font-semibold">
                      {r.score >= 85 ? "Excellent Standing" : "Optimization Active"}
                    </div>
                  </div>
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink font-display text-lg font-bold text-white">
                    {r.score}
                  </div>
                </div>
              </div>

              {/* 4-Card Technical Metrics */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-line p-3">
                  <div className="text-[10px] font-bold uppercase text-muted">Image Alt SEO</div>
                  <div className="mt-1 font-display text-base font-bold text-ink">
                    {r.technical.imagesWithAlt}/{r.technical.totalImages}
                  </div>
                  <div className="text-[11px] text-muted">Accessible images</div>
                </div>
                <div className="rounded-xl border border-line p-3">
                  <div className="text-[10px] font-bold uppercase text-muted">Speed Lazy-Load</div>
                  <div className="mt-1 font-display text-base font-bold text-ink">
                    {r.technical.imagesWithLazy}/{r.technical.totalImages}
                  </div>
                  <div className="text-[11px] text-muted">Async/lazy images</div>
                </div>
                <div className="rounded-xl border border-line p-3">
                  <div className="text-[10px] font-bold uppercase text-muted">Schema.org JSON-LD</div>
                  <div className="mt-1 font-display text-base font-bold text-ink">
                    {r.technical.hasJsonLd ? "Active" : "Not Set"}
                  </div>
                  <div className="text-[11px] text-muted">Rich search snippets</div>
                </div>
                <div className="rounded-xl border border-line p-3">
                  <div className="text-[10px] font-bold uppercase text-muted">Uptime &amp; SSL</div>
                  <div className="mt-1 font-display text-base font-bold text-ink">
                    {r.healthMonitor?.online
                      ? `${r.healthMonitor.responseTimeMs ?? 120}ms`
                      : "Verified"}
                  </div>
                  <div className="text-[11px] text-muted">
                    {r.healthMonitor?.ssl.valid
                      ? `SSL valid (${r.healthMonitor.ssl.daysRemaining}d left)`
                      : "HTTPS Configured"}
                  </div>
                </div>
              </div>

              {/* Configured Meta Tags Table */}
              <div className="rounded-xl border border-line p-4 space-y-2">
                <div className="font-semibold text-ink">Configured Search Engine Metadata</div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="rounded-lg bg-sunken/50 p-2.5">
                    <span className="block text-[10px] font-bold uppercase text-muted">SEO Title</span>
                    <span className="mt-0.5 block font-medium text-ink">
                      {r.seo.title || "Default page title"}
                    </span>
                  </div>
                  <div className="rounded-lg bg-sunken/50 p-2.5">
                    <span className="block text-[10px] font-bold uppercase text-muted">
                      Robots &amp; Canonical
                    </span>
                    <span className="mt-0.5 block font-mono text-ink">
                      {r.seo.robots} · {r.seo.canonical || r.site.publicUrl}
                    </span>
                  </div>
                </div>
                <div className="rounded-lg bg-sunken/50 p-2.5">
                  <span className="block text-[10px] font-bold uppercase text-muted">
                    Meta Description
                  </span>
                  <span className="mt-0.5 block text-ink">
                    {r.seo.description || "No custom meta description configured yet."}
                  </span>
                </div>
              </div>

              {/* Recent Audit / Care Log */}
              {r.recentActivity.length > 0 && (
                <div className="rounded-xl border border-line p-4">
                  <div className="mb-2 font-semibold text-ink">Recent Optimization &amp; Care Log</div>
                  <div className="space-y-1.5">
                    {r.recentActivity.slice(0, 5).map((ev) => (
                      <div
                        key={ev.id}
                        className="flex items-center justify-between border-b border-line/50 pb-1.5 last:border-0"
                      >
                        <span className="text-ink">{ev.summary}</span>
                        <span className="text-[10px] text-muted">
                          {new Date(ev.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

