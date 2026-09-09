import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { api } from "../lib/api";
import type { SitePageRow, SiteSummary } from "../lib/types";

export function WebsiteAI() {
  const sites = useQuery({ queryKey: ["website", "sites"], queryFn: () => api.get<SiteSummary[]>("/website/sites") });
  const [selected, setSelected] = useState("");
  const site = sites.data?.find(item => item.id === selected) ?? sites.data?.[0];
  const design = useQuery({ queryKey: ["website", "design", site?.id], enabled: Boolean(site), queryFn: () => api.get<{ options: { aiEnabled: boolean } }>(`/website/sites/${site!.id}/design`) });
  const pages = useQuery({ queryKey: ["website", "pages", site?.id], enabled: Boolean(site), queryFn: () => api.get<{ pages: SitePageRow[] }>(`/website/sites/${site!.id}/pages`) });
  const error = sites.error || design.error || pages.error;
  return <div className="max-w-4xl">
    <PageHeader title="Design assistant" subtitle="Open a page, describe a change, and review the suggestion in your editor." />
    {sites.isLoading && <p className="text-sm text-muted">Loading websites…</p>}
    {error && <p role="alert" className="mb-4 text-sm text-danger-text">{(error as Error).message}</p>}
    {sites.isSuccess && !site && <p className="text-sm text-muted">Your websites will appear here when you have access to a site.</p>}
    {site && <>
      <label className="mb-5 block max-w-md text-xs text-muted">Website<select value={site.id} onChange={event => setSelected(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink">{sites.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="mb-6 rounded-2xl border border-line bg-white p-5">
        <h2 className="font-display text-lg">{design.data?.options.aiEnabled ? "Suggestions are enabled" : design.isLoading ? "Checking settings…" : design.error ? "Settings unavailable" : "Suggestions are disabled"}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">Select text, an image or a container in the page editor and open the design assistant. It can suggest changes to content, links, image descriptions, typography and spacing. Choose which suggestions to add to your draft, then save and publish when you are ready.</p>
        {site.capabilities?.manage && <Link to="/website/settings" className="mt-4 inline-block text-sm font-medium text-blue hover:underline">Manage AI and brand voice settings →</Link>}
      </div>
      <h2 className="mb-3 font-display text-lg">Choose a page</h2>
      {pages.isLoading && <p className="text-sm text-muted">Loading pages…</p>}
      {pages.isSuccess && !pages.data.pages.some(page => page.status === "LIVE") && <p className="text-sm text-muted">This website has no visible pages yet. <Link to="/website/sites" className="text-blue hover:underline">Open its pages</Link> to get started.</p>}
      <div className="divide-y divide-line rounded-2xl border border-line bg-white">{pages.data?.pages.filter(page => page.status === "LIVE").map(page => <Link key={page.id} to={`/website/pages/${page.id}`} className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-cream"><span><span className="block text-sm font-medium text-ink">{page.title}</span><span className="mt-1 block text-xs text-muted">{page.path}</span></span><span className="text-sm text-blue">Open editor →</span></Link>)}</div>
    </>}
  </div>;
}
