import { PlannedScreen } from "../components/PlannedScreen";

/**
 * The record — plan §9.
 *
 * "Who changed our pricing page, and when" has to be answerable. A customer will
 * ask it, and the honest answer today is a list of commits in a repository they
 * cannot see.
 */
export function WebsiteAudit() {
  return (
    <PlannedScreen
      title="Audit Log"
      summary="Every publish, rollback, upload, permission change and sign-in, in the order they happened."
      willHold={[
        "Publishes and rollbacks, with the readable summaries the version list already renders — 'Main heading: “Build once” → “Built to last”'.",
        "Uploads: which picture, by whom, onto which page.",
        "Permission and membership changes — who was given the right to publish, and who gave it.",
        "Sign-ins against a site, so a customer can see who has been in.",
        "Filters by site, by person and by kind, because an audit log nobody can narrow is one nobody reads.",
      ]}
      decided={[
        "A SiteAuditEvent row per action. The agent floor already does this with ToolCall and AgentTaskTransition; this is the same idea for the builder.",
        "The summaries come from describeChanges in the core package, so the log, the publish banner and the version list cannot disagree about what a publish did.",
        "Written where the action succeeds, never optimistically. A log that records intentions is worse than none.",
      ]}
      waitingOn={["A SiteAuditEvent model"]}
    />
  );
}
