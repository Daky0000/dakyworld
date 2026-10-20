import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * The deploy problems worth saying in the editor, before anybody publishes: the
 * host deploys a different branch or folder (a publish would commit and never
 * appear), the branch is missing, or DakyX cannot write to the repository (a
 * publish would fail). It never blocks Publish (warn, don't block: Dan, Oct
 * 2026). The rest of "how this site goes live" is in Website settings.
 */
type Deploy = { profile: { answer: string; deployBranch?: string; host: string; branchMissing?: boolean; canWrite?: boolean | null } | null };

export function DeployWarning({ siteId, canManage }: { siteId: string; canManage: boolean }) {
  const deploy = useQuery({
    queryKey: ["website", "deploy", siteId],
    queryFn: ({ signal }) => api.get<Deploy>(`/website/sites/${siteId}/deploy`, signal),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const profile = deploy.data?.profile;
  if (!profile) return null;
  const problem = profile.branchMissing
    ? "The branch this site publishes to is not in its repository, so a publish will fail."
    : profile.canWrite === false
      ? "DakyX can read this site's repository but not write to it, so a publish will fail."
      : profile.answer === "branch-mismatch"
        ? `Your host deploys ${profile.deployBranch ? `branch ${profile.deployBranch}` : "a different branch"}, not the one publishing writes to, so a publish will not appear on your live site yet.`
        : null;
  if (!problem) return null;
  return (
    <div className="flex-none border-b border-line px-4 py-3" data-section="deploy-warning">
      <div role="status" className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
        {problem}{" "}
        {canManage ? <a className="font-semibold underline underline-offset-2" href={`/website/settings?site=${encodeURIComponent(siteId)}`}>Fix it in Website settings</a> : "Ask whoever manages the website to fix it in Website settings."}
      </div>
    </div>
  );
}
