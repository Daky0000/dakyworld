import { Prisma, type Site } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { decryptSecret, encryptSecret } from "../../lib/secrets.js";
import { SETTING, getSetting } from "../../lib/settings.js";
import { hostCall } from "./hostApi.js";
import { netlifySites } from "./directNetlify.js";
import { vercelProjectDomains, vercelProjects } from "./directVercel.js";
import { PROVIDER_NAME, type DirectProvider } from "./direct.js";

/**
 * Connecting a customer's host account, once, through the host's own screen.
 *
 * The customer never pastes a key. They press "Connect Netlify" (or Vercel),
 * approve DakyX on the host's page, and come back. What comes back is a token
 * the host scoped to this app, which is encrypted here and used for one thing:
 * deploying the site it was matched to.
 *
 * - **Netlify** is an OAuth application. Its tokens do not expire; Netlify has
 *   no endpoint for an app to revoke one, so disconnecting deletes ours and says
 *   where in Netlify to remove DakyX as well.
 * - **Vercel** is an Integration: installing it is the sign-in. Its token lasts
 *   until the integration is removed, which disconnecting does.
 *
 * Matching is automatic when there is one answer: a host site whose domain is
 * this site's domain, or whose linked repository is this site's repository.
 * More than one, and the customer picks.
 */

export type HostCandidate = { id: string; name: string; url: string | null; reason: string };

export async function providerConfigured(provider: DirectProvider): Promise<boolean> {
  if (provider === "netlify") return Boolean((await getSetting(SETTING.NETLIFY_CLIENT_ID)) && (await getSetting(SETTING.NETLIFY_CLIENT_SECRET)));
  return Boolean((await getSetting(SETTING.VERCEL_CLIENT_ID)) && (await getSetting(SETTING.VERCEL_CLIENT_SECRET)) && (await getSetting(SETTING.VERCEL_INTEGRATION_SLUG)));
}

/** Where to send the customer to approve DakyX. */
export async function connectUrl(provider: DirectProvider, redirectUri: string, state: string): Promise<string> {
  if (provider === "netlify") {
    const clientId = await getSetting(SETTING.NETLIFY_CLIENT_ID);
    return `https://app.netlify.com/authorize?${new URLSearchParams({ client_id: clientId ?? "", response_type: "code", redirect_uri: redirectUri, state })}`;
  }
  const slug = await getSetting(SETTING.VERCEL_INTEGRATION_SLUG);
  return `https://vercel.com/integrations/${encodeURIComponent(slug ?? "")}/new?${new URLSearchParams({ state })}`;
}

/** Turns the code the host sent back into a token. */
export async function exchangeCode(provider: DirectProvider, code: string, redirectUri: string): Promise<{ token: string; teamId: string | null }> {
  const form = (values: Record<string, string>) => new URLSearchParams(values).toString();
  if (provider === "netlify") {
    const grant = await hostCall<{ access_token?: string }>("Netlify", "https://api.netlify.com/oauth/token", {
      method: "POST",
      body: form({ grant_type: "authorization_code", code, client_id: (await getSetting(SETTING.NETLIFY_CLIENT_ID)) ?? "", client_secret: (await getSetting(SETTING.NETLIFY_CLIENT_SECRET)) ?? "", redirect_uri: redirectUri }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!grant.access_token) throw new Error("Netlify did not return a sign-in.");
    return { token: grant.access_token, teamId: null };
  }
  const grant = await hostCall<{ access_token?: string; team_id?: string | null }>("Vercel", "https://api.vercel.com/v2/oauth/access_token", {
    method: "POST",
    body: form({ code, client_id: (await getSetting(SETTING.VERCEL_CLIENT_ID)) ?? "", client_secret: (await getSetting(SETTING.VERCEL_CLIENT_SECRET)) ?? "", redirect_uri: redirectUri }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!grant.access_token) throw new Error("Vercel did not return a sign-in.");
  return { token: grant.access_token, teamId: grant.team_id ?? null };
}

const hostnameOf = (url: string | undefined): string | null => {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
};

/** The site's own hostnames, both spellings of www. */
export function siteHostnames(site: Pick<Site, "publicUrl" | "customDomain">): Set<string> {
  const names = new Set<string>();
  for (const raw of [site.publicUrl, site.customDomain ? `https://${site.customDomain}` : null]) {
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      names.add(host);
      names.add(host.startsWith("www.") ? host.slice(4) : `www.${host}`);
    } catch {
      /* Not an address. */
    }
  }
  return names;
}

/**
 * Which host sites could be this one. Pure over what the host listed, so the
 * checks can hand it a host's answer.
 */
export function matchCandidates(
  site: Pick<Site, "publicUrl" | "customDomain" | "repoOwner" | "repoName">,
  hostSites: Array<{ id: string; name: string; url: string | null; domains: string[]; repo: string | null }>,
): HostCandidate[] {
  const names = siteHostnames(site);
  const repo = site.repoOwner && site.repoName ? `${site.repoOwner}/${site.repoName}`.toLowerCase() : null;
  const found: HostCandidate[] = [];
  for (const entry of hostSites) {
    const domain = entry.domains.find((name) => names.has(name.toLowerCase()));
    if (domain) found.push({ id: entry.id, name: entry.name, url: entry.url, reason: `serves ${domain}` });
    else if (repo && entry.repo && entry.repo.toLowerCase().includes(repo)) found.push({ id: entry.id, name: entry.name, url: entry.url, reason: `is linked to ${site.repoOwner}/${site.repoName}` });
  }
  return found;
}

/** Lists the host sites a connection can see, shaped for matching. */
export async function hostSitesFor(provider: DirectProvider, token: string, teamId: string | null) {
  if (provider === "netlify") {
    const sites = await netlifySites(token);
    return sites.map((site) => ({
      id: site.id,
      name: site.name ?? site.id,
      url: site.ssl_url ?? site.url ?? null,
      domains: [site.custom_domain, ...(site.domain_aliases ?? []), hostnameOf(site.url)].filter((name): name is string => Boolean(name)),
      repo: site.build_settings?.repo_url ?? null,
    }));
  }
  const projects = await vercelProjects(token, teamId);
  const shaped = [];
  for (const project of projects.slice(0, 30)) {
    const repo = project.link?.org && project.link?.repo ? `github.com/${project.link.org}/${project.link.repo}` : null;
    shaped.push({ id: project.id, name: project.name, url: null, domains: repo ? [] : await vercelProjectDomains(token, project.id, teamId), repo });
  }
  return shaped;
}

/** Saves a connection and matches it if there is exactly one candidate. */
export async function saveConnection(input: { site: Site; provider: DirectProvider; token: string; teamId: string | null; configurationId: string | null; userId: string | null }): Promise<{ matched: HostCandidate | null; candidates: HostCandidate[] }> {
  const candidates = matchCandidates(input.site, await hostSitesFor(input.provider, input.token, input.teamId));
  const matched = candidates.length === 1 ? candidates[0]! : null;
  const data = {
    accessToken: encryptSecret(input.token),
    teamId: input.teamId,
    configurationId: input.configurationId,
    connectedById: input.userId,
    externalSiteId: matched?.id ?? null,
    externalName: matched?.name ?? null,
    pausedAt: null,
    pausedReason: null,
    manifest: Prisma.DbNull,
  };
  await prisma.siteHostConnection.upsert({
    where: { siteId_provider: { siteId: input.site.id, provider: input.provider } },
    create: { siteId: input.site.id, provider: input.provider, ...data },
    update: data,
  });
  await prisma.siteAuditEvent.create({
    data: { siteId: input.site.id, kind: "HOST_CONNECTED", summary: `Connected ${PROVIDER_NAME[input.provider]}${matched ? ` (${matched.name})` : ""} for instant updates`, actorId: input.userId, actorName: "Website settings", detail: { provider: input.provider, matched: matched?.id ?? null, candidates: candidates.length } },
  }).catch(() => undefined);
  return { matched, candidates };
}

/** The candidates for a connection that has not been matched, to choose from. */
export async function connectionCandidates(siteId: string, provider: DirectProvider): Promise<HostCandidate[]> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const connection = await prisma.siteHostConnection.findUnique({ where: { siteId_provider: { siteId, provider } } });
  const token = connection ? decryptSecret(connection.accessToken) : null;
  if (!connection || !token) return [];
  const all = await hostSitesFor(provider, token, connection.teamId);
  const matched = matchCandidates(site, all);
  // Offered: the matches when there are any, every site otherwise.
  return matched.length ? matched : all.slice(0, 50).map((entry) => ({ id: entry.id, name: entry.name, url: entry.url, reason: "on your account" }));
}

export async function chooseHostSite(siteId: string, provider: DirectProvider, externalSiteId: string): Promise<HostCandidate> {
  const candidates = await connectionCandidates(siteId, provider);
  const chosen = candidates.find((entry) => entry.id === externalSiteId);
  if (!chosen) throw new Error("That site is not on the connected account.");
  await prisma.siteHostConnection.update({ where: { siteId_provider: { siteId, provider } }, data: { externalSiteId: chosen.id, externalName: chosen.name, manifest: Prisma.DbNull } });
  return chosen;
}

/** Disconnects, revoking at the host where the host allows an app to. */
export async function disconnectHost(siteId: string, provider: DirectProvider, userId: string | null): Promise<{ revokedAtHost: boolean; note: string | null }> {
  const connection = await prisma.siteHostConnection.findUnique({ where: { siteId_provider: { siteId, provider } } });
  if (!connection) return { revokedAtHost: false, note: null };
  let revokedAtHost = false;
  const token = decryptSecret(connection.accessToken);
  if (provider === "vercel" && token && connection.configurationId) {
    revokedAtHost = await hostCall("Vercel", `https://api.vercel.com/v1/integrations/configuration/${encodeURIComponent(connection.configurationId)}${connection.teamId ? `?teamId=${encodeURIComponent(connection.teamId)}` : ""}`, { method: "DELETE", token })
      .then(() => true)
      .catch(() => false);
  }
  await prisma.siteHostConnection.delete({ where: { id: connection.id } });
  await prisma.siteAuditEvent.create({ data: { siteId, kind: "HOST_DISCONNECTED", summary: `Disconnected ${PROVIDER_NAME[provider]}`, actorId: userId, actorName: "Website settings", detail: { provider, revokedAtHost } } }).catch(() => undefined);
  return {
    revokedAtHost,
    note: provider === "netlify" ? "DakyX no longer holds a Netlify sign-in for this site. To remove DakyX from your Netlify account as well, open Netlify, User settings, Applications." : revokedAtHost ? null : "Remove the DakyX integration from your Vercel account's Integrations page as well.",
  };
}
