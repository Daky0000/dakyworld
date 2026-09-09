import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { SiteSummary } from "../lib/types";
import { Button, PageHeader } from "./ui";
import { useWebsiteAccess } from "./WebsiteMembers";

type Asset = { id: string; filename: string; alt: string; url: string; preview: string };
export function WebsiteAssetLibrary({ siteId, onSelect }: { siteId: string; onSelect?: (asset: { url: string; alt: string }) => void }) {
  const access = useWebsiteAccess(siteId);
  const [alt, setAlt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const qc = useQueryClient();
  const assets = useQuery({ queryKey: ["website", "assets", siteId], queryFn: () => api.get<Asset[]>(`/website/sites/${siteId}/assets`) });
  const upload = useMutation({ mutationFn: async () => {
    if (!file) throw new Error("Choose an image first.");
    if (file.size > 5_000_000) throw new Error("Choose an image smaller than 5 MB.");
    // Check that the browser can actually decode it before accepting the upload.
    const bitmap = await createImageBitmap(file).catch(() => { throw new Error("That file could not be opened as an image."); });
    if (bitmap.width * bitmap.height > 40_000_000) { bitmap.close(); throw new Error("Use an image smaller than 40 megapixels."); }
    bitmap.close();
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("The image could not be read.")); reader.readAsDataURL(file); });
    return api.post<{ url: string; alt: string }>(`/website/sites/${siteId}/assets`, { filename: file.name, alt, data });
  }, onSuccess: async asset => { await qc.invalidateQueries({ queryKey: ["website", "assets", siteId] }); setFile(null); onSelect?.(asset); } });
  return <div className="space-y-4">
    {access.data?.capabilities.edit && <div className="space-y-3 rounded-xl border border-line bg-sunken p-3">
      <label className="block text-xs text-muted">PNG, JPEG, WebP or GIF · up to 5 MB<input className="mt-2 block w-full text-xs" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => { setFile(e.target.files?.[0] ?? null); upload.reset(); }} /></label>
      <label className="block text-xs text-muted">Image description<input className="mt-1 h-9 w-full rounded-xl border border-line bg-white px-2 text-xs text-ink" value={alt} onChange={e => setAlt(e.target.value)} placeholder="Describe what the image shows" /></label>
      <Button size="sm" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>{upload.isPending ? "Uploading…" : onSelect ? "Upload & use" : "Upload image"}</Button>
      {upload.error && <p role="alert" className="text-xs text-danger-text">{(upload.error as Error).message}</p>}
      <p className="text-[10px] leading-relaxed text-muted">Images go live with the page when you publish. HTML downloads include uploaded images.</p>
    </div>}
    {assets.isLoading && <p className="text-xs text-muted">Loading images…</p>}
    {assets.error && <p role="alert" className="text-xs text-danger-text">{(assets.error as Error).message}</p>}
    <div className="grid grid-cols-2 gap-2">{assets.data?.map(asset => <button type="button" key={asset.id} disabled={!onSelect} onClick={() => onSelect?.(asset)} className="overflow-hidden rounded-xl border border-line bg-white text-left enabled:hover:border-blue" title={`Use ${asset.filename}`}><img src={asset.preview} alt={asset.alt} className="h-24 w-full object-contain" /><span className="block truncate px-2 py-2 text-[11px] text-muted">{asset.filename}</span></button>)}</div>
    {assets.data?.length === 0 && <p className="text-xs text-muted">Upload your first image to this website.</p>}
  </div>;
}

export function WebsiteAssets() {
  const [selected, setSelected] = useState("");
  const sites = useQuery({ queryKey: ["website", "sites"], queryFn: () => api.get<SiteSummary[]>("/website/sites") });
  const id = selected || sites.data?.[0]?.id;
  return <div><PageHeader title="Images" subtitle="Your website's uploaded images, ready to use in the visual editor." /><select aria-label="Website" value={id ?? ""} onChange={e => setSelected(e.target.value)} className="mb-6 h-10 rounded-xl border border-line bg-white px-3 text-sm">{sites.data?.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select>{id ? <div className="max-w-3xl"><WebsiteAssetLibrary key={id} siteId={id} /></div> : <p className="text-sm text-muted">Connect a website to manage its images.</p>}</div>;
}

export function WebsiteAudit() {
  const [selected, setSelected] = useState("");
  const sites = useQuery({ queryKey: ["website", "sites"], queryFn: () => api.get<SiteSummary[]>("/website/sites") });
  const id = selected || sites.data?.[0]?.id;
  const events = useQuery({ queryKey: ["website", "audit", id], enabled: !!id, queryFn: () => api.get<{ id: string; kind: string; summary: string; actorName: string; createdAt: string }[]>(`/website/sites/${id}/audit`) });
  return <div><PageHeader title="Website activity" subtitle="The latest 100 recorded changes, with who made them and when." /><select aria-label="Website" value={id ?? ""} onChange={e => setSelected(e.target.value)} className="mb-6 h-10 rounded-xl border border-line bg-white px-3 text-sm">{sites.data?.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select>{events.error && <p role="alert" className="text-danger-text">{(events.error as Error).message}</p>}<div className="max-w-3xl space-y-3">{events.data?.map(event => <article key={event.id} className="rounded-xl border border-line bg-white p-4"><p className="text-sm font-semibold">{event.summary}</p><p className="mt-1 text-xs text-muted">{event.actorName} · {new Date(event.createdAt).toLocaleString()} · {event.kind.toLowerCase().replaceAll("_", " ")}</p></article>)}{events.data?.length === 0 && <p className="text-sm text-muted">Activity will appear as this site is edited.</p>}</div></div>;
}
