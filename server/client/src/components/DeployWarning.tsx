import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * The one deploy problem worth saying in the editor: the host deploys a
 * different branch or folder from the one publishing writes to, so a publish
 * would commit and never appear. Said before anybody publishes, never blocking
 * Publish (warn, don't block: Dan, Oct 2026). The rest of "how this site goes
 * live" is in Website settings.
 */
type Deploy = { profile: { answer: string; deployBranch?: string; host: string } | null };

export function DeployWarning({ siteId, canManage }: { siteId: string; canManage: boolean }) {
  const deploy = useQuery({
    queryKey: ["website", "deploy", siteId],
    queryFn: ({ signal }) => api.get<Deploy>(`/website/sites/${siteId}/deploy`, signal),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const profile = deploy.data?.profile;
  if (profile?.answer !== "branch-mismatch") return null;
  return (
    <div className="flex-none border-b border-line px-4 py-3" data-section="deploy-warning">
      <div role="status" className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
        Your host deploys {profile.deployBranch ? `branch ${profile.deployBranch}` : "a different branch"}, not the one publishing writes to, so a publish will not appear on your live site yet.{" "}
        {canManage ? <a className="font-semibold underline underline-offset-2" href={`/website/settings?site=${encodeURIComponent(siteId)}`}>Fix it in Website settings</a> : "Ask whoever manages the website to fix it in Website settings."}
      </div>
    </div>
  );
}
