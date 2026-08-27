import { PlannedScreen } from "../components/PlannedScreen";

/**
 * The management hub — plan §13.
 *
 * The plan's key principle: Sites → Pages → Editor is the work path, Settings is
 * where all management lives, and everything else hangs off those two.
 */
export function WebsiteSettings() {
  return (
    <PlannedScreen
      title="Settings"
      summary="Per-site configuration: where it lives, what may be edited, how it publishes, and what the AI may do."
      willHold={[
        "General — repository, branch, folder, public address, sitemap, how often to scan for new pages.",
        "Editing rules — which fields are editable, which are required, maximum lengths, allowed link domains, allowed style properties, repeatable regions, upload rules.",
        "Publishing — commit directly or open a pull request, whether an approval is needed, build command, deploy status, maintenance window, scheduled publish.",
        "AI — on or off, which model, monthly usage limit, allowed actions, brand voice, whether every change needs review.",
        "License — plan, active sites, renewal, and a link through to billing.",
      ]}
      decided={[
        "Repository, branch and public address are already editable through PATCH /website/sites/:siteId. This screen is where the rest joins them.",
        "Publish-by-pull-request is the plan's §7B answer to never silently overwriting a customer's own work: branch, preview, PR, merge only after approval. createBranch and openPullRequest already exist in lib/github.ts.",
        "The style panel's colour swatches become a per-site token set. A client editing their own website should be offered their own colours, not Dakyworld's.",
      ]}
      waitingOn={["A SiteSettings model", "A SiteField model, for the editing rules half"]}
    />
  );
}
