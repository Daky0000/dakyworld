import type { WebsitePlanTier } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { RETAINER_TIERS } from "./entitlements.js";
import { sitePayer } from "./websiteEntitlement.js";
import { WebsiteError } from "./website/site.js";

/**
 * One switch for all AI on a website: the design assistant and the Builder
 * agent (Dan, 21 Oct 2026).
 *
 * The setting was the assistant's alone and defaulted to off, while the agent
 * ignored it — so a customer who had switched AI off still had the agent, and
 * a Business customer, whose plan's headline is the agent, found the
 * assistant off until somebody ticked a box in settings.
 *
 * A site where nobody has chosen is on when the site's own plan is Business:
 * the live subscription that pays for it, or the client's active retainer. It
 * is decided from the site and not from whoever is looking, so staff and the
 * customer see the same switch — staff keep every feature on a client's site,
 * and deciding from their plan would show them AI the customer does not have.
 * Once somebody saves the setting, their choice is what counts.
 */
export async function siteAiEnabled(site: { id: string; settings: unknown }): Promise<boolean> {
  const chosen = (site.settings as { aiEnabled?: unknown } | null)?.aiEnabled;
  if (typeof chosen === "boolean") return chosen;
  return (await siteOwnTier(site.id)) === "MANAGED";
}

export async function assertSiteAiEnabled(site: { id: string; settings: unknown }): Promise<void> {
  if (!(await siteAiEnabled(site))) {
    throw new WebsiteError(403, "AI is switched off for this website. A site manager can switch it on in Website settings.");
  }
}

/** The plan the website itself is on, whoever is asking: its subscription, else its client's retainer. */
export async function siteOwnTier(siteId: string): Promise<WebsitePlanTier | null> {
  const payer = await sitePayer(siteId);
  if (payer) return payer.tier;
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { clientId: true } });
  if (!site?.clientId) return null;
  const plan = await prisma.carePlan.findFirst({ where: { clientId: site.clientId, status: "ACTIVE" }, select: { tier: true } });
  return plan ? (RETAINER_TIERS[plan.tier]["website-builder"] as WebsitePlanTier) : null;
}
