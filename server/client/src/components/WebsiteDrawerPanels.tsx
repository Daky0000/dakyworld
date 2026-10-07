import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { RelativeTime } from "./ui";
import { SECTION_CATALOG, type RevisionCommentItem, type SectionTemplateId } from "./WebsiteCommandAndSections";

/**
 * The Add and Notes drawers of the editor's tool rail. They use the same
 * routes as the dialogs they replace — inserting a section, the page's
 * revision notes — drawn as a column beside the page instead of over it.
 */

/** A rough picture of each section's shape, for its card. */
const THUMBS: Record<string, [number, number, number, number][]> = {
  default: [[12, 14, 60, 8], [12, 30, 80, 6], [12, 42, 40, 14], [70, 14, 22, 40]],
};

export function WebsiteSectionsPanel({ siteId, pageId, disabled, onInserted }: { siteId: string; pageId: string; disabled: boolean; onInserted: (label: string) => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const categories = useMemo(() => ["All", ...Array.from(new Set(SECTION_CATALOG.map((item) => item.category)))], []);
  const insert = useMutation({
    mutationFn: (templateId: SectionTemplateId) => api.post<{ ok: boolean; label: string }>(`/website/sites/${siteId}/pages/${pageId}/insert-section`, { templateId }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
      onInserted(result.label);
    },
  });
  const query = search.trim().toLowerCase();
  const shown = SECTION_CATALOG.filter(
    (item) => (category === "All" || item.category === category) && (!query || `${item.title} ${item.category} ${item.description}`.toLowerCase().includes(query)),
  );
  return (
    <>
      <div className="dx-inp">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input type="text" aria-label="Search sections" placeholder="Search sections (hero, pricing, FAQ…)" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="dx-chips" role="group" aria-label="Section kinds">
        {categories.map((name) => (
          <button key={name} type="button" className="dx-chip" aria-pressed={category === name} onClick={() => setCategory(name)}>{name.replace(/ & .*/, "")}</button>
        ))}
      </div>
      {shown.length === 0 && <p className="dx-hint">No section matches that.</p>}
      {shown.map((item, index) => (
        <div key={item.id} className="dx-sec-card">
          <div className="dx-thumb" aria-hidden="true">
            {THUMBS.default.map(([left, top, width, height], part) => (
              <i key={part} style={{ left: `${left}%`, top, width: `${(part + index) % 3 ? width : width - 20}%`, height }} />
            ))}
          </div>
          <div className="dx-meta">
            <span className="dx-label">{item.category}</span>
            <b>{item.title}</b>
            <span>{item.description}</span>
          </div>
          <div className="dx-sfoot">
            <span className="dx-badge">{item.badge}</span>
            <button type="button" className="dx-btn dx-pri" style={{ height: 28 }} disabled={disabled || insert.isPending} onClick={() => insert.mutate(item.id)}>
              {insert.isPending && insert.variables === item.id ? "Inserting…" : "+ Insert"}
            </button>
          </div>
        </div>
      ))}
      {insert.error && <p role="alert" className="dx-note warn" style={{ margin: 0 }}>{insert.error instanceof ApiError ? insert.error.message : "Could not insert that section."}</p>}
    </>
  );
}

export function WebsiteNotesPanel({
  siteId,
  pageId,
  selectedFieldId,
  selectedFieldLabel,
  onSelectField,
}: {
  siteId: string;
  pageId: string;
  selectedFieldId: string | null;
  selectedFieldLabel: string | null;
  onSelectField: (fieldId: string) => void;
}) {
  const qc = useQueryClient();
  const [message, setMessage] = useState("");
  const key = ["website", "comments", siteId, pageId];
  const comments = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get<{ comments: RevisionCommentItem[] }>(`/website/sites/${siteId}/pages/${pageId}/comments`, signal),
  });
  const add = useMutation({
    mutationFn: () =>
      api.post(`/website/sites/${siteId}/pages/${pageId}/comments`, {
        fieldId: selectedFieldId,
        elementLabel: selectedFieldId && selectedFieldLabel ? selectedFieldLabel : "General Page Note",
        message: message.trim(),
      }),
    onSuccess: () => {
      setMessage("");
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const update = useMutation({
    mutationFn: (input: { commentId: string; resolved?: boolean; delete?: boolean }) =>
      api.patch(`/website/sites/${siteId}/pages/${pageId}/comments/${input.commentId}`, { resolved: input.resolved, delete: input.delete }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const list = Array.isArray(comments.data?.comments) ? comments.data!.comments : [];
  return (
    <>
      {list.length === 0 && !comments.isLoading && <p className="dx-hint">No notes on this page yet.</p>}
      {list.map((item) => (
        <div key={item.id} className={`dx-comment${item.resolved ? " done" : ""}`}>
          <div className="dx-comment-h">
            <b>{item.authorName}</b>
            <button type="button" className="dx-ib" title={item.resolved ? "Open again" : "Mark as done"} aria-label={item.resolved ? "Open again" : "Mark as done"} onClick={() => update.mutate({ commentId: item.id, resolved: !item.resolved })}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
            </button>
            <button type="button" className="dx-ib" title="Delete note" aria-label="Delete note" onClick={() => update.mutate({ commentId: item.id, delete: true })}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
            </button>
          </div>
          <p>{item.message}</p>
          <span>
            {item.fieldId ? <button type="button" className="dx-link" onClick={() => onSelectField(item.fieldId!)}>{item.elementLabel}</button> : item.elementLabel} · <RelativeTime value={item.createdAt} />
          </span>
        </div>
      ))}
      <div className="dx-f">
        <div className="dx-fl"><label htmlFor="dx-note-new">New note{selectedFieldLabel ? ` on ${selectedFieldLabel}` : ""}</label></div>
        <textarea id="dx-note-new" className="dx-ta" value={message} placeholder="Select something on the page, then leave a note" onChange={(event) => setMessage(event.target.value)} />
      </div>
      <button type="button" className="dx-btn dx-pri" style={{ alignSelf: "flex-start" }} disabled={!message.trim() || add.isPending} onClick={() => add.mutate()}>
        {add.isPending ? "Posting…" : "Post note"}
      </button>
    </>
  );
}
