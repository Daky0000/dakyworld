import { PlannedScreen } from "../components/PlannedScreen";

/**
 * Who may touch which site — plan §10.
 *
 * This is what makes `assertSiteAccess` in routes/website.ts mean something.
 * Today it enforces the rule that can be enforced while there is one site; the
 * moment a second customer exists, membership is the whole of it.
 */
export function WebsiteTeam() {
  return (
    <PlannedScreen
      title="Team & Permissions"
      summary="Who can open, edit, approve and publish each site."
      willHold={[
        "Members of each site, and the six roles the plan names: viewer, editor, reviewer, publisher, manager, developer.",
        "Per-site access, so a client sees their own website and no part of anybody else's.",
        "Invitations, and what a new member starts with — which is nothing, deliberately.",
        "Who last published, and who has been given the right to.",
      ]}
      decided={[
        "A SiteMember row, not a global role. The existing access catalogue answers \"may this person edit websites\"; it never sees which website, and it cannot.",
        "assertSiteAccess is already called by every route that resolves a page or a site, so this lands on one function rather than on twelve handlers.",
        "The client portal opens scopeExternal for /api/website only, and every route still resolves the site's client against the caller's. Two independent reasons to say no, kept — never widened by deleting the check.",
      ]}
      waitingOn={["A SiteMember model", "A clientId column on User — middleware/auth.ts already names it as the missing piece"]}
    >
      <div className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4">
        <h3 className="font-display text-sm tracking-[-.02em] text-amber-900">The riskiest change in the whole programme</h3>
        <p className="mt-1.5 text-sm text-amber-900">
          One client seeing another client's website is the failure that ends this product. When this is built it gets its own check,
          whose assertions are mostly negatives, and it must be run over real HTTP with <span className="font-mono text-xs">DEV_NO_AUTH=false</span> —
          <span className="font-mono text-xs"> .env</span> sets it true, and against an implicit Owner every refusal assertion passes for the
          wrong reason.
        </p>
      </div>
    </PlannedScreen>
  );
}
