import { refreshStaleDeployProfiles } from "./websiteDeployDetect.js";
import { checkPendingBridges, renewBridgeEntries } from "./websiteEdgeBridge.js";
import { alertOwnerOnce } from "./opsAlert.js";

/**
 * The publish router's background work, on the scheduler's minute tick.
 *
 * - Deploy profiles older than a day are detected again, two a tick, because a
 *   customer can move host without telling anybody.
 * - Bridges waiting on DNS are looked at again, a few a tick and none more
 *   than every two minutes.
 * - Bridged files are renewed once an hour, so a host that is slow to rebuild
 *   never makes a site go backwards.
 */

let lastRenewal = 0;
const RENEW_EVERY_MS = 60 * 60_000;

export async function publishRouterTick(now = new Date()): Promise<void> {
  const results = await Promise.allSettled([
    refreshStaleDeployProfiles(now, 2),
    checkPendingBridges(3, new Date(now.getTime() - 2 * 60_000)),
    now.getTime() - lastRenewal >= RENEW_EVERY_MS
      ? (lastRenewal = now.getTime(), renewBridgeEntries(now, async (siteId, message) => {
          await alertOwnerOnce(`bridge-late:${siteId}`, 24 * 60 * 60, { subject: "A customer's host has not rebuilt for a day", paragraphs: [message, "The edge bridge keeps serving the change for up to seven days. After that the site goes back to the host's older copy."], category: "ops:bridge-host-late" });
        }))
      : Promise.resolve(null),
  ]);
  for (const result of results) if (result.status === "rejected") console.error("[publish-router] background work failed:", result.reason);
}
