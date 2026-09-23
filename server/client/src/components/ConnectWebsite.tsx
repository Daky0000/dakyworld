import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "./ui";

export function ConnectWebsite() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [publicUrl, setUrl] = useState("");
  const [repository, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [html, setHtml] = useState<string | undefined>();
  const [filename, setFilename] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const create = useMutation({ mutationFn: () => {
    const parts = repository.trim().replace(/^https:\/\/github.com\//, "").replace(/\.git$/, "").split("/");
    if (repository.trim() && parts.length !== 2) throw new Error("Enter the repository as owner/name.");
    return api.post<{ id: string; pageId: string | null }>("/website/sites", { name, publicUrl, repoOwner: repository.trim() ? parts[0] : null, repoName: repository.trim() ? parts[1] : null, repoBranch: branch, html });
  }, onSuccess: async result => {
    await qc.invalidateQueries({ queryKey: ["website"] });
    setOpen(false);
    navigate(result.pageId ? `/website/pages/${result.pageId}` : "/website/sites");
  } });
  return <>
    <Button onClick={() => { create.reset(); setOpen(true); }}>Connect a website</Button>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/50 p-4" role="dialog" aria-modal="true" aria-labelledby="connect-title" onKeyDown={e => { if (e.key === "Escape" && !create.isPending) setOpen(false); }}>
      <form onSubmit={e => { e.preventDefault(); create.mutate(); }} className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between"><h2 id="connect-title" className="font-display text-xl">Bring your website</h2><button type="button" aria-label="Close" onClick={() => setOpen(false)} disabled={create.isPending}>Close</button></div>
        <p className="text-sm text-muted">Connect an HTML website repository or import an HTML page to start editing. Original markup and styling stay intact.</p>
        {[["Website name", name, setName], ["Public website address", publicUrl, setUrl], ["GitHub repository (optional)", repository, setRepo], ["Branch", branch, setBranch]].map(([label, value, setter], index) => <label key={String(label)} className="block text-xs text-muted">{String(label)}<input autoFocus={index === 0} required={index !== 2} type={index === 1 ? "url" : "text"} value={value as string} onChange={e => (setter as (v: string) => void)(e.target.value)} placeholder={index === 1 ? "https://your-site.com" : index === 2 ? "owner/repository" : ""} className="mt-1 h-10 w-full rounded-xl border border-line px-3 text-sm text-ink" /></label>)}
        <label className="block rounded-xl border border-dashed border-line-strong bg-sunken p-4 text-sm">Import an HTML file (optional)<input type="file" accept=".html,.htm,text/html" className="mt-2 block w-full text-xs" onChange={async e => {
          const file = e.target.files?.[0]; setFileError(null); setHtml(undefined); setFilename("");
          if (!file) return;
          if (file.size > 2_000_000) { setFileError("Choose a file smaller than 2 MB."); return; }
          try { setHtml(await file.text()); setFilename(file.name); } catch { setFileError("That file could not be read."); }
        }} />{filename && <span className="mt-2 block text-xs text-muted">{filename} is ready to import.</span>}</label>
        <p className="text-xs leading-relaxed text-muted">A website address supplies relative images and styles. React/Next.js app shells require source integration; uploading compiled HTML does not update React components. Imported scripts are kept in downloads and disabled in the editor.</p>
        {(create.error || fileError) && <p role="alert" className="text-sm text-danger-text">{fileError || (create.error as Error).message}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={create.isPending || !!fileError}>{create.isPending ? "Connecting…" : "Open website"}</Button></div>
      </form>
    </div>}
  </>;
}
