import type { Prisma, PublishJob, Site, SiteHostConnection } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { decryptSecret } from "../../lib/secrets.js";
import { committedFiles } from "../../lib/github.js";
import { siteRepo, underSiteCredential } from "../website/site.js";
import type { DeployProfile } from "../websiteDeployDetect.js";
import { HostApiError } from "./hostApi.js";
import { deployToNetlify } from "./directNetlify.js";
import { deployToVercel, type VercelManifest } from "./directVercel.js";

/**
 * Route A: upload straight to the host, for a site with no build step.
 *
 * Exception to the rule in docs/website-compatibility.md, approved by Dan on
 * 20 Oct 2026: DakyX may deploy through a host's official deploy API, only when
 * the customer connected their host account through the host's own sign-in, and
 * only for sites with no build step. SFTP and FTP stay unsupported.
 *
 * A site is eligible when detection is sure there is no build step
 * (`hasBuildStep === false`; unknown is not enough) and it has a live
 * connection matched to a host site. A token the host stopped accepting pauses
 * the connection: the publish falls back to following the host, and settings
 * say "Instant updates paused: reconnect Netlify".
 */

export type DirectProvider = "netlify" | "vercel";
export const DIRECT_PROVIDERS: readonly DirectProvider[] = ["netlify", "vercel"];
export const PROVIDER_NAME: Record<DirectProvider, string> = { netlify: "Netlify", vercel: "Vercel" };

export async function directEligible(site: Site, profile: DeployProfile | null): Promise<SiteHostConnection | null> {
  if (!profile || profile.hasBuildStep !== false) return null;
  const connections = await prisma.siteHostConnection.findMany({ where: { siteId: site.id, pausedAt: null, externalSiteId: { not: null }, provider: { in: [...DIRECT_PROVIDERS] } } });
  // The host that serves the site, when there is a connection for it.
  return connections.find((connection) => connection.provider === profile.host) ?? (connections.length === 1 ? connections[0]! : null);
}

/** Stops using a connection the host no longer accepts. */
export async function pauseConnection(connectionId: string, reason: string): Promise<void> {
  await prisma.siteHostConnection.update({ where: { id: connectionId }, data: { pausedAt: new Date(), pausedReason: reason.slice(0, 300) } }).catch(() => undefined);
}

export async function directDeploy(site: Site, job: PublishJob, _profile: DeployProfile, connection: SiteHostConnection): Promise<string> {
  const repo = siteRepo(site);
  if (!repo || !job.commitSha) throw new Error("No commit to deploy.");
  const token = decryptSecret(connection.accessToken);
  if (!token) {
    await pauseConnection(connection.id, "The stored sign-in could not be read. Reconnect to turn instant updates back on.");
    throw new Error("The stored host sign-in could not be read.");
  }
  const provider = connection.provider as DirectProvider;
  const changed = await underSiteCredential(site, () => committedFiles(repo, job.commitSha!));
  try {
    if (provider === "netlify") {
      const result = await deployToNetlify({ token, siteId: connection.externalSiteId!, changed, title: `DakyX publish ${job.commitSha.slice(0, 7)}` });
      await prisma.siteHostConnection.update({ where: { id: connection.id }, data: { lastUsedAt: new Date() } });
      return result.uploaded ? `Uploaded ${result.uploaded} file${result.uploaded === 1 ? "" : "s"} straight to Netlify.` : "Nothing Netlify serves changed in this publish.";
    }
    const result = await underSiteCredential(site, () =>
      deployToVercel({ token, projectId: connection.externalSiteId!, teamId: connection.teamId, repo, commitSha: job.commitSha!, changed, manifest: (connection.manifest as VercelManifest | null) ?? {} }),
    );
    await prisma.siteHostConnection.update({ where: { id: connection.id }, data: { lastUsedAt: new Date(), manifest: result.manifest as unknown as Prisma.InputJsonValue } });
    return `Deployed to Vercel production, uploading ${result.uploaded} file${result.uploaded === 1 ? "" : "s"}.`;
  } catch (error) {
    if (error instanceof HostApiError && error.revoked) {
      await pauseConnection(connection.id, `${PROVIDER_NAME[provider]} stopped accepting DakyX's sign-in. Reconnect ${PROVIDER_NAME[provider]} to turn instant updates back on.`);
    }
    throw error;
  }
}
