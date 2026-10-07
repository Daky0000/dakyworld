import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { setPageTitle } from "../lib/surface";
import { useWebsiteSites } from "../components/WebsiteGuard";
import { WebsiteWelcomeFlow } from "../components/WebsiteWelcomeFlow";

/**
 * Where somebody with no website yet starts. The flow ends in the editor with
 * its tour already running (`?walkthrough`), so adding a site, changing it and
 * publishing are one continuous path. Somebody who already has a website is
 * sent to their pages — this screen is for the first visit only.
 */
export function WebsiteWelcome() {
  const sites = useWebsiteSites();
  useEffect(() => setPageTitle("Welcome"), []);

  if (sites.isLoading) return <p className="text-sm text-muted" role="status">Loading…</p>;
  if ((sites.data?.length ?? 0) > 0) return <Navigate to="/website/sites" replace />;
  return <WebsiteWelcomeFlow />;
}
