import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "./ui";

export function ImportWebsitePage({ siteId }: { siteId: string }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("/new-page");
  const [filePath, setFilePath] = useState("new-page.html");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const upload = useMutation({ mutationFn: async () => {
    if (!file) throw new Error("Choose an HTML file.");
    if (file.size > 2_000_000) throw new Error("Choose an HTML file smaller than 2 MB.");
    return api.post<{ id: string }>(`/website/sites/${siteId}/import`, { title: title.trim(), path: path.trim(), filePath: filePath.trim(), html: await file.text() });
  }, onSuccess: async result => { await qc.invalidateQueries({ queryKey: ["website"] }); navigate(`/website/pages/${result.id}`); } });
  return <><Button variant="secondary" onClick={() => setOpen(true)}>Import a page</Button>{open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4" role="dialog" aria-modal="true" aria-labelledby="import-page-title" onKeyDown={event => { if (event.key === "Escape" && !upload.isPending) setOpen(false); }}>
    <form className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-6 shadow-xl" onSubmit={event => { event.preventDefault(); if (!upload.isPending) upload.mutate(); }}>
      <h2 id="import-page-title" className="font-display text-xl">Import an HTML page</h2>
      <p className="text-sm text-muted">Add an existing page to this website. Its CSS and images can use the website’s public address.</p>
      <label className="block text-xs text-muted">HTML file<input autoFocus disabled={upload.isPending} required type="file" accept=".html,.htm,text/html" className="mt-2 block w-full text-sm" onChange={event => {
        const selected = event.target.files?.[0] ?? null;
        setFile(selected); upload.reset();
        if (selected) { const slug = selected.name.replace(/\.html?$/i, "").replace(/[^a-zA-Z0-9_-]/g, "-") || "new-page"; setTitle(slug.replace(/[-_]/g, " ")); setFilePath(`${slug}.html`); setPath(slug === "index" ? "/" : `/${slug}`); }
      }} /></label>
      {([["Title", title, setTitle], ["Page address", path, setPath], ["Repository file", filePath, setFilePath]] as const).map(([label, value, setValue]) => <label key={label} className="block text-xs text-muted">{label}<input required disabled={upload.isPending} maxLength={label === "Title" ? 120 : 200} value={value} onChange={event => setValue(event.target.value)} className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-sm text-ink" /></label>)}
      <p className="text-xs text-muted">Use a new page address and file name. An existing page is never replaced by an import.</p>
      {upload.error && <p role="alert" className="text-sm text-danger-text">{(upload.error as Error).message}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={upload.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={!file || upload.isPending}>{upload.isPending ? "Importing…" : "Import & edit"}</Button></div>
    </form>
  </div>}</>;
}
