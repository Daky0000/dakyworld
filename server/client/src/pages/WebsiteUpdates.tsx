import { PlannedScreen } from "../components/PlannedScreen";

/**
 * Updates — plan §7.
 *
 * This screen exists so that a decision stays visible rather than being
 * rediscovered as a gap. §7A is about a module installed inside a customer's own
 * project, checking an update endpoint, verifying a signed package, backing up
 * and rolling back on failure. **There is no such module.** The builder is sold
 * as hosted seats, so an update is a Railway deploy and every customer gets it at
 * the same moment.
 *
 * §7B is a different thing entirely and is real work: changing the customer's
 * *own site code* must never silently overwrite what they have. That is
 * publish-by-pull-request, and it belongs on the Settings screen as a per-site
 * publish mode rather than here.
 */
export function WebsiteUpdates() {
  return (
    <PlannedScreen
      title="Updates"
      summary="Kept as a reminder of a decision, not as a feature that is coming."
      willHold={[
        "Nothing, on the current plan. It is here so the decision below is not rediscovered in six months as a missing feature.",
      ]}
      decided={[
        "§7A — module updates, an update endpoint, signed release packages, stable and beta channels, backup and rollback on the customer's machine — is dropped. It describes a module installed in somebody else's project, and the builder is sold as hosted seats.",
        "An update to this product is a deploy. Every customer is on the same version, always, and there is no version to check.",
        "§7B is real and is not dropped: never silently overwrite a customer's own site code. That is publish-by-pull-request — branch, preview, PR, merge only after approval — and it lives on the Settings screen.",
      ]}
    >
      <div className="rounded-2xl border border-line bg-white px-5 py-4">
        <h3 className="font-display text-sm tracking-[-.02em]">If the installed-module product is ever revived</h3>
        <p className="mt-1.5 text-sm text-muted">
          Everything in §7A comes back with it, and so does §2B, the license server, activation tokens bound to a normalised domain, and
          signed releases. That is a second product with a second threat model, not a feature of this one — the decision to build it is a
          decision to take on all of that at once.
        </p>
      </div>
    </PlannedScreen>
  );
}
