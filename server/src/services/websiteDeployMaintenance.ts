import { refreshStaleDeployProfiles } from "./websiteDeployDetect.js";

/**
 * The publish router's background work, on the scheduler's minute tick.
 *
 * Deploy profiles older than a day are detected again, two a tick, because a
 * customer can move host without telling anybody.
 */
export async function publishRouterTick(now = new Date()): Promise<void> {
  await refreshStaleDeployProfiles(now, 2).catch((error) => console.error("[publish-router] background work failed:", error));
}
