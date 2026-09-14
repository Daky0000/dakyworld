import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postForBlob } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { SiteSummary } from "../lib/types";
import { Button, PageHeader } from "./ui";
import { useWebsiteAccess } from "./WebsiteMembers";

type SourceField = { id: string; label: string; tag: string; kind: "text" | "href" | "src" | "alt"; value: string; marker?: string; confidence: "explicit" | "structural" };
type SourceDocument = { filePath: string; sourceHash: string; repo: string; branch: string; fields: SourceField[]; issues: { message: string; line?: number }[] };
type Directory = { repo: string; branch: string; root: string; path: string; files: { path: string; name: string; type: "file" | "dir"; size: number; editable: boolean }[] };
type Change = { fieldId: string; value: string };
type Review = { reviewHash: string; sourceHash: string; filePath: string; repo: string; branch: string; changes: { fieldId: string; label: string; before: string; after: string }[] };
type StoredDraft = { sourceHash: string; values: Record<string, string> };
type UploadedImage = { id: string; url: string; filename: string; preview: string };
const fieldClass = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink focus:border-blue focus:outline-none focus:ring-1 focus:ring-blue";

function readDraft(key: string): StoredDraft | null {
  try {
    const candidate = JSON.parse(sessionStorage.getItem(key) ?? "null") as unknown;
    if (!candidate || typeof candidate !== "object") return null;
    const draft = candidate as Partial<StoredDraft>;
    return typeof draft.sourceHash === "string" && draft.values && typeof draft.values === "object" && !Array.isArray(draft.values) && Object.values(draft.values).every(value => typeof value === "string") ? draft as StoredDraft : null;
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
 */
export function SourceFileEditor({ siteId, filePath, canPublish, focusFieldId, onPublished }: { siteId: string; filePath: string; canPublish: boolean; focusFieldId?: string | null; onPublished?: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const storageKey = `website-source-draft:${user?.id}:${siteId}:${filePath}`;
  const [draft, setDraft] = useState<StoredDraft | null>(() => readDraft(storageKey));
  const [review, setReview] = useState<Review | null>(null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [published, setPublished] = useState<{ url: string; sha: string } | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
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
  const changes: Change[] = Object.entries(values).map(([fieldId, value]) => ({ fieldId, value }));
  const input = { filePath, sourceHash: draft?.sourceHash ?? document.data?.sourceHash ?? "", changes };
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
  const busy = prepare.isPending || download.isPending || publish.isPending;
  const error = document.error || prepare.error || download.error || publish.error;
  const visible = useMemo(() => document.data?.fields.filter(field => `${field.label} ${field.value} ${field.marker ?? ""}`.toLowerCase().includes(search.toLowerCase())) ?? [], [document.data, search]);
  const update = (field: SourceField, value: string) => {
    if (!document.data) return;
    setDraft(previous => {
      const next = { ...(previous?.values ?? {}) };
      if (value === field.value) delete next[field.id]; else next[field.id] = value;
      return { sourceHash: previous?.sourceHash ?? document.data!.sourceHash, values: next };
    });
    setReview(null); setNotice(""); prepare.reset(); download.reset(); publish.reset();
  };
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
        <Button disabled={busy || stale || !changes.length} onClick={() => prepare.mutate()}>{prepare.isPending ? "Preparing…" : "Review changes"}</Button>
        <Button variant="secondary" disabled={busy || stale || !changes.length} onClick={() => download.mutate()}>{download.isPending ? "Preparing file…" : "Download edited file"}</Button>
        <Button variant="secondary" disabled={busy || !changes.length} onClick={() => { if (window.confirm("Discard this source draft? This cannot be undone.")) { setDraft(null); setReview(null); setNotice("Draft discarded."); prepare.reset(); download.reset(); publish.reset(); } }}>Discard draft</Button>
      </div>
    </div>
    {review && <section className="rounded-2xl border border-blue/30 bg-white p-5" aria-label="Review source changes">
      <h3 className="font-display text-lg">Review {review.changes.length} {review.changes.length === 1 ? "change" : "changes"}</h3>
      <p className="mt-2 text-sm text-muted">Publishing commits to <strong>{review.repo}</strong>, branch <strong>{review.branch}</strong>. Your hosting service may automatically build and deploy that branch.</p>
      <div className="mt-4 divide-y divide-line">{review.changes.map(change => <div key={change.fieldId} className="py-4"><p className="mb-2 text-xs font-semibold text-muted">{change.label}</p><div className="grid gap-3 sm:grid-cols-2"><div><p className="text-xs text-muted">Before</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{change.before || "(empty)"}</p></div><div><p className="text-xs text-muted">After</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{change.after || "(empty)"}</p></div></div></div>)}</div>
      <div className="mt-4 flex flex-wrap gap-3"><Button disabled={busy || !canPublish} onClick={() => publish.mutate()}>{publish.isPending ? "Committing…" : "Publish reviewed source"}</Button><Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>Keep editing</Button></div>
      {!canPublish && <p className="mt-3 text-sm text-muted">Your website role can edit source but cannot publish. Download the edited file to share it with a publisher.</p>}
    </section>}
    {document.data && <>
      {document.data.issues.length > 0 && <details className="rounded-2xl border border-line bg-white p-4"><summary className="cursor-pointer text-sm font-semibold">{document.data.issues.length} source compatibility {document.data.issues.length === 1 ? "note" : "notes"}</summary><ul className="mt-3 space-y-2 text-sm text-muted">{document.data.issues.map((issue, index) => <li key={index}>{issue.line ? `Line ${issue.line}: ` : ""}{issue.message}</li>)}</ul></details>}
      {!document.data.fields.length ? <p className="rounded-2xl border border-line bg-white p-5 text-sm text-muted">This file has no supported static fields. Dynamic values, custom component props, styles and layout need a source adapter for that component or a code change.</p> : <>
        <label className="block text-xs text-muted">Find content<input className={`${fieldClass} mt-1`} placeholder="Search text, element or marker" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <div className="grid gap-4 xl:grid-cols-2">{visible.map(field => <label key={field.id} ref={element => { fieldRefs.current[field.id] = element; }} className={`block rounded-2xl border bg-white p-4 ${field.id === focusFieldId ? "border-blue ring-1 ring-blue" : "border-line"}`}><span className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-muted">{field.label}</span>{field.marker && <span className="max-w-[60%] truncate text-xs text-muted" title={field.marker}>{field.marker}</span>}</span>{field.kind === "src" && (images.data?.length ?? 0) > 0 && <select aria-label={`Choose an uploaded image for ${field.label}`} className={`${fieldClass} mt-2`} disabled={busy || stale} value="" onChange={event => { if (event.target.value) update(field, event.target.value); }}><option value="">Choose an uploaded image…</option>{images.data!.map(image => <option key={image.id} value={image.url}>{image.filename}</option>)}</select>}{field.kind === "text" ? <textarea aria-label={field.label} className={`${fieldClass} mt-2 min-h-24 resize-y`} rows={3} maxLength={100_000} disabled={busy || stale} value={values[field.id] ?? field.value} onChange={event => update(field, event.target.value)} /> : <input aria-label={field.label} type="text" className={`${fieldClass} mt-2`} maxLength={100_000} disabled={busy || stale} value={values[field.id] ?? field.value} onChange={event => update(field, event.target.value)} />}{field.id in values && <span className="mt-2 block text-xs text-blue">Changed</span>}</label>)}</div>
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
