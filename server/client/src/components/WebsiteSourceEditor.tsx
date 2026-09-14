import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postForBlob } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { SiteSummary } from "../lib/types";
import { Button, PageHeader } from "./ui";
import { useWebsiteAccess } from "./WebsiteMembers";
import { SourceBlockStyle } from "./SourceBlockStyle";

type SourceField = { id: string; label: string; tag: string; kind: "text" | "href" | "src" | "alt"; value: string; marker?: string; confidence: "explicit" | "structural" };
type SourceBlock = { id: string; tag: string; label: string; depth: number; parentId?: string; previousId?: string; nextId?: string; marker?: string; remove: boolean; duplicate: boolean; reason?: string; duplicateReason?: string; style: string; styleable: boolean; styleReason?: string; link?: { newTab: boolean; editable: boolean; reason?: string } };
type StyleEdit = { nodeId: string; style: string };
type LinkEdit = { nodeId: string; newTab: boolean };
type StructureAction = { kind: "remove" | "duplicate" | "before" | "after"; nodeId: string; targetId?: string };
type SourceDocument = { filePath: string; sourceHash: string; repo: string; branch: string; fields: SourceField[]; blocks: SourceBlock[]; structureAdapter: string | null; styleAdapter: string | null; issues: { message: string; line?: number }[] };
type SourcePreview = SourceDocument & { layout: string[]; droppedChanges: string[] };
type Directory = { repo: string; branch: string; root: string; path: string; files: { path: string; name: string; type: "file" | "dir"; size: number; editable: boolean }[] };
type Change = { fieldId: string; value: string };
type Review = { reviewHash: string; sourceHash: string; filePath: string; repo: string; branch: string; layout: string[]; changes: { fieldId: string; label: string; before: string; after: string }[] };
type StoredDraft = { sourceHash: string; values: Record<string, string>; actions?: StructureAction[]; styles?: Record<string, string>; links?: Record<string, boolean> };
type UploadedImage = { id: string; url: string; filename: string; preview: string };
const fieldClass = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink focus:border-blue focus:outline-none focus:ring-1 focus:ring-blue";

function readDraft(key: string): StoredDraft | null {
  try {
    const candidate = JSON.parse(sessionStorage.getItem(key) ?? "null") as unknown;
    if (!candidate || typeof candidate !== "object") return null;
    const draft = candidate as Partial<StoredDraft>;
    if (typeof draft.sourceHash !== "string" || !draft.values || typeof draft.values !== "object" || Array.isArray(draft.values)) return null;
    if (!Object.values(draft.values).every(value => typeof value === "string")) return null;
    // A stored layout queue is read back defensively for the same reason the
    // values are: it is browser storage, and the server will refuse anything
    // malformed anyway — but refusing here keeps the panel from rendering it.
    const actions = Array.isArray(draft.actions) ? draft.actions.filter(action => action && typeof action === "object" && ["remove", "duplicate", "before", "after"].includes((action as StructureAction).kind) && typeof (action as StructureAction).nodeId === "string") : [];
    const styles = draft.styles && typeof draft.styles === "object" && !Array.isArray(draft.styles) && Object.values(draft.styles).every(value => typeof value === "string") ? draft.styles as Record<string, string> : {};
    const links = draft.links && typeof draft.links === "object" && !Array.isArray(draft.links) && Object.values(draft.links).every(value => typeof value === "boolean") ? draft.links as Record<string, boolean> : {};
    return { sourceHash: draft.sourceHash, values: draft.values as Record<string, string>, actions: actions as StructureAction[], styles, links };
  } catch { return null; }
}

/**
 * One file's fields, with review and publish.
 *
 * Exported because the framework page editor puts this exact panel beside the
 * live page: same draft, same review, same commit. Two panels that agreed until
 * they did not would be two editors.
 *
 * `focusFieldId` is how a click on the page reaches the right box — the caller
 * changes it, and the field scrolls into view and takes the caret. `onPublished`
 * lets that caller refresh its frame once a commit has landed.
 *
 * `typedOnPage` is the other direction: somebody typing on the live page in the
 * frame, whose words arrive here and become an ordinary edit to that field. The
 * token is what makes a repeat of the same value still count, because typing the
 * old text back is a real edit.
 */
export function SourceFileEditor({ siteId, filePath, canPublish, focusFieldId, typedOnPage, onFieldFocus, onPublished }: { siteId: string; filePath: string; canPublish: boolean; focusFieldId?: string | null; typedOnPage?: { fieldId: string; value: string; token: number } | null; onFieldFocus?: (fieldId: string) => void; onPublished?: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const storageKey = `website-source-draft:${user?.id}:${siteId}:${filePath}`;
  const [draft, setDraft] = useState<StoredDraft | null>(() => readDraft(storageKey));
  const [review, setReview] = useState<Review | null>(null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [published, setPublished] = useState<{ url: string; sha: string } | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  /** The one block whose style controls are open, so the list stays readable. */
  const [styling, setStyling] = useState<string | null>(null);
  const endpoint = `/website/sites/${encodeURIComponent(siteId)}/source`;
  const document = useQuery({ queryKey: ["website", "source", siteId, filePath], queryFn: () => api.get<SourceDocument>(`${endpoint}?filePath=${encodeURIComponent(filePath)}`), refetchOnWindowFocus: false });
  // The pictures already uploaded to this site. A framework page cannot be shown
  // a drag-and-drop canvas, but somebody changing an image still needs a way to
  // name one that exists — typing a path from memory is how a broken picture
  // gets published.
  const images = useQuery({ queryKey: ["website", "assets", siteId], queryFn: () => api.get<UploadedImage[]>(`/website/sites/${encodeURIComponent(siteId)}/assets`), refetchOnWindowFocus: false });
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});
  useEffect(() => {
    if (!focusFieldId) return;
    const element = fieldRefs.current[focusFieldId];
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    const input = element.querySelector("textarea, input") as HTMLElement | null;
    input?.focus();
  }, [focusFieldId]);
  const values = draft?.values ?? {};
  const typedToken = useRef(0);
  const actions = draft?.actions ?? [];
  const styleDraft = draft?.styles ?? {};
  const styleEdits: StyleEdit[] = Object.entries(styleDraft).map(([nodeId, style]) => ({ nodeId, style }));
  const linkDraft = draft?.links ?? {};
  const linkEdits: LinkEdit[] = Object.entries(linkDraft).map(([nodeId, newTab]) => ({ nodeId, newTab }));
  const changes: Change[] = Object.entries(values).map(([fieldId, value]) => ({ fieldId, value }));
  const input = { filePath, sourceHash: draft?.sourceHash ?? document.data?.sourceHash ?? "", changes, structure: actions, styles: styleEdits, links: linkEdits };
  /**
   * The file as the queued layout actions leave it.
   *
   * Asked of the server rather than worked out here: after one action the IDs
   * this panel is holding describe a file that no longer exists, and the only
   * thing that can say what the new ones are is the parser that made them.
   */
  const preview = useQuery({
    queryKey: ["website", "source-preview", siteId, filePath, input.sourceHash, JSON.stringify(actions), JSON.stringify(styleEdits), JSON.stringify(linkEdits)],
    enabled: (actions.length > 0 || styleEdits.length > 0 || linkEdits.length > 0) && Boolean(input.sourceHash),
    queryFn: () => api.post<SourcePreview>(`${endpoint}/preview`, input),
    refetchOnWindowFocus: false,
  });
  const blocks = ((actions.length || styleEdits.length || linkEdits.length) ? preview.data?.blocks : document.data?.blocks) ?? [];
  const layout = preview.data?.layout ?? [];
  const stale = Boolean(draft && document.data && draft.sourceHash !== document.data.sourceHash);
  useEffect(() => {
    try {
      if (draft && Object.keys(draft.values).length) sessionStorage.setItem(storageKey, JSON.stringify(draft));
      else sessionStorage.removeItem(storageKey);
      setStorageUnavailable(false);
    } catch { setStorageUnavailable(true); }
  }, [storageKey, draft]);
  useEffect(() => {
    if (!changes.length) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [changes.length]);
  const prepare = useMutation({ mutationFn: () => api.post<Review>(`${endpoint}/review`, input), onSuccess: result => { setReview(result); setNotice(""); } });
  const download = useMutation({
    mutationFn: () => postForBlob(`${endpoint}/export`, input),
    onSuccess: blob => {
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a"); anchor.href = url; anchor.download = filePath.split("/").at(-1)!;
      window.document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Downloaded the edited source file. The repository has not changed.");
    },
  });
  const publish = useMutation({
    mutationFn: () => api.post<{ url: string; sha: string; auditRecorded: boolean; message: string }>(`${endpoint}/publish`, { ...input, reviewHash: review?.reviewHash }),
    onSuccess: async result => {
      setDraft(null); setReview(null); setPublished(result);
      setNotice(`${result.message}${result.auditRecorded ? "" : " The activity log could not be updated; the GitHub commit is available below."}`);
      await qc.invalidateQueries({ queryKey: ["website", "source", siteId, filePath] });
      await qc.invalidateQueries({ queryKey: ["website", "audit", siteId] });
      onPublished?.();
    },
  });
  const busy = prepare.isPending || download.isPending || publish.isPending || preview.isFetching;
  const error = document.error || prepare.error || download.error || publish.error || preview.error;
  /** Queue one layout action, and forget any review prepared before it. */
  const queue = (action: StructureAction) => {
    if (!document.data) return;
    setDraft(previous => ({ sourceHash: previous?.sourceHash ?? document.data!.sourceHash, values: previous?.values ?? {}, styles: previous?.styles ?? {}, links: previous?.links ?? {}, actions: [...(previous?.actions ?? []), action] }));
    setReview(null); setNotice(""); prepare.reset(); download.reset(); publish.reset();
  };
  /**
   * Style one block. Kept as "the declarations this block should end up with"
   * rather than as another queued action, because restyling the same block twice
   * is one decision changing its mind — a queue would publish both.
   */
  const restyle = (block: SourceBlock, style: string) => {
    if (!document.data) return;
    setDraft(previous => {
      const next = { ...(previous?.styles ?? {}) };
      // Compared against the file's own styling, not the row's: once a preview
      // is showing, the row already wears the draft, and comparing the two would
      // mean putting a block back as it was never cleared the edit.
      const original = document.data!.blocks.find(candidate => candidate.id === block.id)?.style ?? "";
      if (style === original) delete next[block.id]; else next[block.id] = style;
      return { sourceHash: previous?.sourceHash ?? document.data!.sourceHash, values: previous?.values ?? {}, actions: previous?.actions ?? [], styles: next, links: previous?.links ?? {} };
    });
    setReview(null); setNotice(""); prepare.reset(); download.reset(); publish.reset();
  };
  /** Where a link opens. Kept like a style — the block's wanted state, not a queue. */
  const relink = (block: SourceBlock, newTab: boolean) => {
    if (!document.data) return;
    setDraft(previous => {
      const next = { ...(previous?.links ?? {}) };
      const original = document.data!.blocks.find(candidate => candidate.id === block.id)?.link?.newTab ?? false;
      if (newTab === original) delete next[block.id]; else next[block.id] = newTab;
      return { sourceHash: previous?.sourceHash ?? document.data!.sourceHash, values: previous?.values ?? {}, actions: previous?.actions ?? [], styles: previous?.styles ?? {}, links: next };
    });
    setReview(null); setNotice(""); prepare.reset(); download.reset(); publish.reset();
  };
  const undoLayout = () => {
    setDraft(previous => (previous ? { ...previous, actions: (previous.actions ?? []).slice(0, -1) } : previous));
    setReview(null); setNotice(""); prepare.reset(); download.reset(); publish.reset();
  };
  const visible = useMemo(() => document.data?.fields.filter(field => `${field.label} ${field.value} ${field.marker ?? ""}`.toLowerCase().includes(search.toLowerCase())) ?? [], [document.data, search]);
  const update = (field: SourceField, value: string) => {
    if (!document.data) return;
    setDraft(previous => {
      const next = { ...(previous?.values ?? {}) };
      if (value === field.value) delete next[field.id]; else next[field.id] = value;
      return { sourceHash: previous?.sourceHash ?? document.data!.sourceHash, values: next, actions: previous?.actions ?? [], styles: previous?.styles ?? {}, links: previous?.links ?? {} };
    });
    setReview(null); setNotice(""); prepare.reset(); download.reset(); publish.reset();
  };
  // Words typed on the page itself. Applied here rather than in the frame,
  // because what is being changed is the literal in the file — the frame is
  // showing what the host built from it, and cannot be the record of anything.
  useEffect(() => {
    if (!typedOnPage || typedOnPage.token === typedToken.current) return;
    typedToken.current = typedOnPage.token;
    const field = document.data?.fields.find(candidate => candidate.id === typedOnPage.fieldId);
    if (field) update(field, typedOnPage.value);
    // `update` is recreated each render and closes over the current draft; the
    // token guard is what keeps this from applying the same words twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typedOnPage, document.data]);

  return <section className="min-w-0 space-y-4" aria-label={`Edit ${filePath}`}>
    <div className="rounded-2xl border border-line bg-white p-5">
      <h2 className="break-all font-display text-lg">{filePath}</h2>
      <p className="mt-1 text-xs text-muted">{document.data?.repo} · {document.data?.branch} · {changes.length} changed {changes.length === 1 ? "field" : "fields"}</p>
      <p className="mt-3 text-sm text-muted">Change static text, link destinations and image details. These edits change the selected React source file. Shared components can appear on several pages.</p>
      {document.isLoading && <p role="status" className="mt-3 text-sm text-muted">Reading source fields…</p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger-text">{(error as Error).message}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-muted">{notice}</p>}
      {published && <a className="mt-3 inline-block text-sm text-blue underline" href={published.url} target="_blank" rel="noreferrer">View commit {published.sha.slice(0, 7)}</a>}
      {changes.length > 0 && <p className="mt-3 text-xs text-muted">{storageUnavailable ? "Browser storage is unavailable. Keep this page open until you download or publish your edits." : "Your draft is kept in this browser tab until published or discarded."}</p>}
      {stale && <div className="mt-4 rounded-xl border border-line bg-sunken p-3" role="alert"><p className="text-sm">This file changed since your draft began. Copy any text you want to keep, then discard the draft and edit the latest fields. Publishing is paused to protect the newer source.</p><details className="mt-3"><summary className="cursor-pointer text-sm">Your saved edits</summary>{changes.map(change => <div key={change.fieldId} className="mt-3"><p className="text-xs text-muted">{document.data?.fields.find(field => field.id === change.fieldId)?.label ?? "Previous source field"}</p><pre className="mt-1 whitespace-pre-wrap break-words text-sm">{change.value}</pre></div>)}</details></div>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={busy || stale || (!changes.length && !actions.length && !styleEdits.length && !linkEdits.length)} onClick={() => prepare.mutate()}>{prepare.isPending ? "Preparing…" : "Review changes"}</Button>
        <Button variant="secondary" disabled={busy || stale || (!changes.length && !actions.length && !styleEdits.length && !linkEdits.length)} onClick={() => download.mutate()}>{download.isPending ? "Preparing file…" : "Download edited file"}</Button>
        <Button variant="secondary" disabled={busy || (!changes.length && !actions.length && !styleEdits.length && !linkEdits.length)} onClick={() => { if (window.confirm("Discard this source draft? This cannot be undone.")) { setDraft(null); setReview(null); setNotice("Draft discarded."); prepare.reset(); download.reset(); publish.reset(); } }}>Discard draft</Button>
      </div>
    </div>
    {review && <section className="rounded-2xl border border-blue/30 bg-white p-5" aria-label="Review source changes">
      <h3 className="font-display text-lg">Review {review.changes.length + (review.layout?.length ?? 0)} {review.changes.length + (review.layout?.length ?? 0) === 1 ? "change" : "changes"}</h3>
      <p className="mt-2 text-sm text-muted">Publishing commits to <strong>{review.repo}</strong>, branch <strong>{review.branch}</strong>. Your hosting service may automatically build and deploy that branch.</p>
      {(review.layout?.length ?? 0) > 0 && <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm">{review.layout.map((step, index) => <li key={index}>{step}</li>)}</ol>}
      <div className="mt-4 divide-y divide-line">{review.changes.map(change => <div key={change.fieldId} className="py-4"><p className="mb-2 text-xs font-semibold text-muted">{change.label}</p><div className="grid gap-3 sm:grid-cols-2"><div><p className="text-xs text-muted">Before</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{change.before || "(empty)"}</p></div><div><p className="text-xs text-muted">After</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{change.after || "(empty)"}</p></div></div></div>)}</div>
      <div className="mt-4 flex flex-wrap gap-3"><Button disabled={busy || !canPublish} onClick={() => publish.mutate()}>{publish.isPending ? "Committing…" : "Publish reviewed source"}</Button><Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>Keep editing</Button></div>
      {!canPublish && <p className="mt-3 text-sm text-muted">Your website role can edit source but cannot publish. Download the edited file to share it with a publisher.</p>}
    </section>}
    {document.data && document.data.structureAdapter && blocks.length > 0 && <section className="rounded-2xl border border-line bg-white p-5" aria-label="Page layout">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg">Layout</h3>
        {actions.length > 0 && <button className="text-sm text-blue hover:underline disabled:opacity-50" disabled={busy} onClick={undoLayout}>Undo last layout change</button>}
      </div>
      <p className="mt-2 text-sm text-muted">Move, copy, restyle or remove a block of this page. Blocks the page's own code places — a list, a condition — stay with the code, and say so.</p>
      {layout.length > 0 && <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted">{layout.map((step, index) => <li key={index}>{step}</li>)}</ol>}
      {preview.isFetching && <p role="status" className="mt-3 text-sm text-muted">Working out the new layout…</p>}
      {(preview.data?.droppedChanges.length ?? 0) > 0 && <p role="alert" className="mt-3 text-sm text-danger-text">{preview.data!.droppedChanges.length} of your text edits are no longer in this file and will not be published. Discard the draft to work from the latest source.</p>}
      <ul className="mt-4 space-y-1">{blocks.map(item => {
        const movable = item.remove && !stale;
        return <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 hover:bg-sunken" style={{ marginLeft: `${Math.min(item.depth, 6) * 14}px` }}>
          <span className="text-sm text-ink">{item.label}</span>
          {item.marker && <span className="max-w-[40%] truncate text-xs text-muted" title={item.marker}>{item.marker}</span>}
          {item.reason
            ? <span className="text-xs text-muted">{item.reason}</span>
            : <span className="ml-auto flex flex-wrap gap-1">
              <button className={`rounded px-2 py-1 text-xs disabled:opacity-40 ${styling === item.id ? "bg-white text-blue" : "text-blue hover:bg-white"}`} disabled={busy || stale || !item.styleable} title={item.styleReason ?? "Change this block's colours, size and spacing"} onClick={() => setStyling(styling === item.id ? null : item.id)}>{styleDraft[item.id] === undefined ? "Style" : "Style ·"}</button>
              <button className="rounded px-2 py-1 text-xs text-blue hover:bg-white disabled:opacity-40" disabled={busy || !movable || !item.previousId} title={item.previousId ? "Move above the block before it" : "This is the first block here"} onClick={() => queue({ kind: "before", nodeId: item.id, targetId: item.previousId! })}>Move up</button>
              <button className="rounded px-2 py-1 text-xs text-blue hover:bg-white disabled:opacity-40" disabled={busy || !movable || !item.nextId} title={item.nextId ? "Move below the block after it" : "This is the last block here"} onClick={() => queue({ kind: "after", nodeId: item.id, targetId: item.nextId! })}>Move down</button>
              <button className="rounded px-2 py-1 text-xs text-blue hover:bg-white disabled:opacity-40" disabled={busy || !movable || !item.duplicate} title={item.duplicateReason ?? "Add a copy of this block below it"} onClick={() => queue({ kind: "duplicate", nodeId: item.id })}>Duplicate</button>
              <button className="rounded px-2 py-1 text-xs text-danger-text hover:bg-white disabled:opacity-40" disabled={busy || !movable} onClick={() => { if (window.confirm(`Remove ${item.label} and everything inside it? You can undo this before publishing.`)) queue({ kind: "remove", nodeId: item.id }); }}>Remove</button>
            </span>}
          {!item.reason && !item.styleable && item.styleReason && <span className="w-full text-xs text-muted">{item.styleReason}</span>}
          {item.link && <label className="flex items-center gap-1 text-xs text-muted" title={item.link.reason ?? "Open this link in a new tab, with the rel that must go with it"}><input type="checkbox" disabled={busy || stale || !item.link.editable} checked={linkDraft[item.id] ?? item.link.newTab} onChange={event => relink(item, event.target.checked)} />New tab</label>}
          {styling === item.id && item.styleable && <div className="w-full"><SourceBlockStyle style={styleDraft[item.id] ?? item.style} disabled={busy || stale} onChange={next => restyle(item, next)} /></div>}
        </li>;
      })}</ul>
      {actions.length > 0 && <p className="mt-3 text-xs text-muted">A block added by Duplicate has no editable words until this change is published, because its text does not exist in the file yet.</p>}
    </section>}
    {document.data && <>
      {document.data.issues.length > 0 && <details className="rounded-2xl border border-line bg-white p-4"><summary className="cursor-pointer text-sm font-semibold">{document.data.issues.length} source compatibility {document.data.issues.length === 1 ? "note" : "notes"}</summary><ul className="mt-3 space-y-2 text-sm text-muted">{document.data.issues.map((issue, index) => <li key={index}>{issue.line ? `Line ${issue.line}: ` : ""}{issue.message}</li>)}</ul></details>}
      {!document.data.fields.length ? <p className="rounded-2xl border border-line bg-white p-5 text-sm text-muted">This file has no supported static fields. Dynamic values, custom component props, styles and layout need a source adapter for that component or a code change.</p> : <>
        <label className="block text-xs text-muted">Find content<input className={`${fieldClass} mt-1`} placeholder="Search text, element or marker" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <div className="grid gap-4 xl:grid-cols-2">{visible.map(field => <label key={field.id} ref={element => { fieldRefs.current[field.id] = element; }} className={`block rounded-2xl border bg-white p-4 ${field.id === focusFieldId ? "border-blue ring-1 ring-blue" : "border-line"}`}><span className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-muted">{field.label}</span>{field.marker && <span className="max-w-[60%] truncate text-xs text-muted" title={field.marker}>{field.marker}</span>}</span>{field.kind === "src" && (images.data?.length ?? 0) > 0 && <select aria-label={`Choose an uploaded image for ${field.label}`} className={`${fieldClass} mt-2`} disabled={busy || stale} value="" onChange={event => { if (event.target.value) update(field, event.target.value); }}><option value="">Choose an uploaded image…</option>{images.data!.map(image => <option key={image.id} value={image.url}>{image.filename}</option>)}</select>}{field.kind === "text" ? <textarea aria-label={field.label} onFocus={() => onFieldFocus?.(field.id)} className={`${fieldClass} mt-2 min-h-24 resize-y`} rows={3} maxLength={100_000} disabled={busy || stale} value={values[field.id] ?? field.value} onChange={event => update(field, event.target.value)} /> : <input aria-label={field.label} type="text" onFocus={() => onFieldFocus?.(field.id)} className={`${fieldClass} mt-2`} maxLength={100_000} disabled={busy || stale} value={values[field.id] ?? field.value} onChange={event => update(field, event.target.value)} />}{field.id in values && <span className="mt-2 block text-xs text-blue">Changed</span>}</label>)}</div>
        {!visible.length && <p className="text-sm text-muted">No fields match your search.</p>}
      </>}
    </>}
  </section>;
}

export function WebsiteSourceEditor({ siteId, initialFilePath = "" }: { siteId: string; initialFilePath?: string }) {
  const access = useWebsiteAccess(siteId);
  // A file arriving from the page list opens straight away, and its folder is
  // opened alongside it so the tree shows where it sits rather than the root.
  const [folder, setFolder] = useState(() => initialFilePath.split("/").slice(0, -1).join("/"));
  const [filePath, setFilePath] = useState(initialFilePath);
  const directory = useQuery({ queryKey: ["website", "source-files", siteId, folder], enabled: access.data?.capabilities.source === true, queryFn: () => api.get<Directory>(`/website/sites/${encodeURIComponent(siteId)}/source/files?path=${encodeURIComponent(folder)}`) });
  if (access.isLoading) return <p role="status" className="text-sm text-muted">Loading source access…</p>;
  if (access.error) return <p role="alert" className="text-sm text-danger-text">{(access.error as Error).message}</p>;
  if (!access.data?.capabilities.source) return <p className="rounded-2xl border border-line bg-white p-5 text-sm text-muted">Source editing needs a website manager or developer role.</p>;
  return <div className="grid items-start gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
    <aside className="rounded-2xl border border-line bg-white p-4" aria-label="Repository source files">
      <h2 className="font-display text-lg">Source files</h2>
      <p className="mt-1 break-all text-xs text-muted">{directory.data ? `${directory.data.repo} · ${directory.data.branch}` : "Connected repository"}</p>
      <p className="mt-3 break-all text-xs text-muted">/{directory.data?.root ? `${directory.data.root}/` : ""}{folder}</p>
      {folder && <button className="mt-3 text-sm text-blue hover:underline" onClick={() => setFolder(folder.split("/").slice(0, -1).join("/"))}>← Parent folder</button>}
      {directory.isLoading && <p className="mt-3 text-sm text-muted" role="status">Reading files…</p>}
      {directory.error && <p className="mt-3 text-sm text-danger-text" role="alert">{(directory.error as Error).message}</p>}
      <ul className="mt-3 space-y-1">{directory.data?.files.map(file => <li key={file.path}><button className={`w-full rounded-lg px-2 py-2 text-left text-sm disabled:opacity-50 ${file.path === filePath ? "bg-sunken text-blue" : "text-ink hover:bg-sunken"}`} disabled={file.type === "file" && !file.editable} onClick={() => file.type === "dir" ? setFolder(file.path) : setFilePath(file.path)}><span className="break-all">{file.type === "dir" ? "▸ " : ""}{file.name}</span>{file.type === "file" && !file.editable && <span className="block text-xs text-muted">Exceeds 2 MB</span>}</button></li>)}</ul>
      {directory.data?.files.length === 0 && <p className="mt-3 text-sm text-muted">No editable source files in this folder. This editor opens .jsx, .tsx, .astro, .vue and .svelte files. Open another folder, or check the repository folder in Website settings.</p>}
    </aside>
    {filePath ? <SourceFileEditor key={`${siteId}:${filePath}`} siteId={siteId} filePath={filePath} canPublish={access.data.capabilities.publish} /> : <div className="rounded-2xl border border-line bg-white p-6"><h2 className="font-display text-xl">Edit content in a framework site</h2><p className="mt-3 text-sm text-muted">Choose a .jsx, .tsx, .astro, .vue or .svelte file to edit its static text, links and image details — React, Next.js, Astro, Nuxt, Vue and SvelteKit projects all edit here. Existing JavaScript, component structure and formatting are preserved.</p><p className="mt-3 text-sm text-muted">The visual HTML editor handles rendered HTML pages. This source editor does not run the project or show a live React canvas. Dynamic content, custom component props, class names and layout remain controlled by the code.</p></div>}
  </div>;
}

export function WebsiteSource() {
  const sites = useQuery({ queryKey: ["website", "sites"], queryFn: () => api.get<SiteSummary[]>("/website/sites") });
  const available = sites.data?.filter(site => site.capabilities?.source) ?? [];
  // `?site=&file=` is how the page list hands a framework route over. Both are
  // hints: a site that is not editable here falls back to the first that is.
  const [params] = useSearchParams();
  const requestedSite = params.get("site") ?? "";
  const requestedFile = params.get("file") ?? "";
  const [selected, setSelected] = useState(requestedSite);
  const siteId = available.some(site => site.id === selected) ? selected : available.some(site => site.id === requestedSite) ? requestedSite : available[0]?.id;
  return <>
    <PageHeader title="Source content" subtitle="Edit static content in connected React, Next.js, Astro, Nuxt, Vue and SvelteKit projects, with a review before each commit." />
    {sites.isLoading && <p role="status" className="text-sm text-muted">Loading websites…</p>}
    {sites.error && <p role="alert" className="text-sm text-danger-text">{(sites.error as Error).message}</p>}
    {sites.data?.length === 0 && <p className="text-sm text-muted">Connect a website and its GitHub repository from Sites to get started.</p>}
    {siteId && <><label className="mb-6 block max-w-sm text-xs text-muted">Website<select className={`${fieldClass} mt-1`} value={siteId} onChange={event => setSelected(event.target.value)}>{available.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><WebsiteSourceEditor key={siteId} siteId={siteId} initialFilePath={siteId === requestedSite ? requestedFile : ""} /></>}
  </>;
}
