import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { SiteSummary } from "../lib/types";
import { PageHeader } from "./ui";
export function WebsiteAuditTrail() {
  const [selected, setSelected] = useState("");
  const sites = useQuery({ queryKey: ["website", "sites"], queryFn: () => api.get<SiteSummary[]>("/website/sites") });
  const id = selected || sites.data?.[0]?.id;
  const events = useQuery({ queryKey: ["website", "audit", id], enabled: !!id, queryFn: () => api.get<{ id: string; kind: string; summary: string; actorName: string; createdAt: string }[]>(`/website/sites/${id}/audit`) });
  return <div><PageHeader title="Website activity" subtitle="The latest 100 recorded changes, with who made them and when." /><select aria-label="Website" value={id ?? ""} onChange={e => setSelected(e.target.value)} className="mb-6 h-10 rounded-xl border border-line bg-white px-3 text-sm">{sites.data?.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select>{events.error && <p role="alert" className="text-danger-text">{(events.error as Error).message}</p>}{events.isLoading && id && <p role="status">Loading activity?</p>}{sites.error && <p role="alert">Unable to load websites.</p>}{!id && !sites.isLoading && <p>Connect a website to view its activity.</p>}<div className="max-w-3xl space-y-3">{events.data?.map(event => <article key={event.id} className="rounded-xl border border-line bg-white p-4"><p className="text-sm font-semibold">{event.summary}</p><p className="mt-1 text-xs text-muted">{event.actorName} · {new Date(event.createdAt).toLocaleString()} · {event.kind.toLowerCase().replaceAll("_", " ")}</p></article>)}{events.data?.length === 0 && <p className="text-sm text-muted">Activity will appear as this site is edited.</p>}</div></div>;
}
