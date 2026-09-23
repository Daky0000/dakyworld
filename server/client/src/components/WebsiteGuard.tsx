import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { SiteSummary } from "../lib/types";
import { Card } from "./ui";

export type WebsiteAction = "view" | "edit" | "review" | "publish" | "manage" | "members" | "source";

/** Collection access is server scoped. Site-specific controls use /sites/:id/access. */
export function useWebsiteSites() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["website", "sites"], enabled: Boolean(user),
    queryFn: () => api.get<SiteSummary[]>("/website/sites"), staleTime: 15_000,
    retry: false,
  });
}

export function WebsiteGuard({ needs = "view", children }: { needs?: WebsiteAction; children: ReactNode }) {
  const { user, can } = useAuth();
  const sites = useWebsiteSites();
  const globalPermission = needs === "review" ? "website.view" : ["source", "members"].includes(needs) ? "website.manage" : `website.${needs}`;
  const allowed = can("website.view") && can(globalPermission) || sites.data?.some(site => site.capabilities?.[needs]) || needs === "view" && user?.external && sites.isSuccess;
  if (allowed) return <>{children}</>;
  if (sites.isLoading) return <p role="status" className="text-sm text-muted">Loading website access…</p>;
  return <Card className="mx-auto max-w-lg p-8 text-center">
    <h1 className="font-display text-xl font-medium">Website access is not available</h1>
    <p className="mt-3 text-sm leading-relaxed text-muted">{sites.error ? (sites.error as Error).message : "A website manager can assign the access needed for this screen."}</p>
  </Card>;
}
