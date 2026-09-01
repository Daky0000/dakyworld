import { PlannedScreen } from "../components/PlannedScreen";

/**
 * What the customer pays — plan §8.
 *
 * The plan asks for a separate License model with activation tokens bound to a
 * domain. That belongs to the installed-module product, which is not what is
 * being sold: a builder subscription here is a retainer with a tier, and this
 * company already bills retainers.
 */
export function WebsiteBilling() {
  return (
    <PlannedScreen
      title="License & Billing"
      summary="The plan a customer is on, what it entitles them to, and where they pay."
      willHold={[
        "Plan and tier, active sites against the ceiling, renewal date, and this month's AI usage.",
        "The features the plan carries — visual editor, AI edits, image uploads, scheduled publish.",
        "A link through to the Paystack customer portal, and the invoices this plan has raised.",
        "The subscription's state, in the words a person needs: active, payment problem, expired, suspended.",
      ]}
      decided={[
        "Billing reuses CarePlan + Invoice + Paystack rather than a parallel License model. CarePlan already does monthly fees in GHS, billing days, auto-invoicing, pause and churn, and cycles.",
        "entitlement(site) resolves the plan to { maxSites, features[], state }, and the gate reads that — never a stored counter, which drifts the first time a write fails.",
        "A lapsed subscription is a sentence naming what to do, not \"Something went wrong\". BudgetExceeded is the precedent for that error class.",
      ]}
      waitingOn={["An entitlement service over CarePlan", "A link from Site to the CarePlan that pays for it"]}
    >
      <div className="rounded-2xl border border-line bg-white px-5 py-4">
        <h3 className="font-display text-sm tracking-[-.02em]">The rule that is not a preference</h3>
        <p className="mt-1.5 text-sm text-muted">
          <strong className="text-ink">Never take a customer's public website down because their builder subscription lapsed.</strong> They
          paid a developer to build that site; this is a convenience over it, not the thing holding it up. When a plan expires the published
          site stays exactly where it is, and editing, AI and publishing stop.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-sm">
            <thead>
              <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[.12em] text-muted">
                <th className="py-2 pr-4 font-normal">State</th>
                <th className="py-2 font-normal">Behaviour</th>
              </tr>
            </thead>
            <tbody className="text-muted">
              <tr className="border-b border-line/60">
                <td className="py-2 pr-4 text-ink">Active</td>
                <td className="py-2">Full editing, AI and publishing.</td>
              </tr>
              <tr className="border-b border-line/60">
                <td className="py-2 pr-4 text-ink">Payment problem</td>
                <td className="py-2">Full access during a 7–14 day grace period, with warnings.</td>
              </tr>
              <tr className="border-b border-line/60">
                <td className="py-2 pr-4 text-ink">Expired</td>
                <td className="py-2">The published site stays live. Editing and AI stop.</td>
              </tr>
              <tr className="border-b border-line/60">
                <td className="py-2 pr-4 text-ink">Suspended</td>
                <td className="py-2">Access disabled after a clear account action.</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 text-ink">Server unavailable</td>
                <td className="py-2">Temporary grace. A failure on our side is not the customer's fault.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </PlannedScreen>
  );
}
