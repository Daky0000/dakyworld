import type { Request, Response, Router } from "express";
import type { Site } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { GitHubError } from "../lib/github.js";
import { forgetInstallationToken, githubAppConfigured, githubAppInstallUrl, installationRepositories, verifyGithubWebhook } from "./githubApp.js";
import { assertWebsiteConnectionChange } from "./websiteAccess.js";
import { WebsiteError } from "./website/site.js";

/**
 * Connecting a customer's repository without ever holding their credentials.
 *
 * The flow this replaces asked somebody to create a personal access token and
 * paste it in, which is the worst version of the question: it asks the customer
 * for a secret that reaches everything they own, and leaves them no way to see
 * or narrow what it is used for.
 *
 * Here they install the Dakyworld app on the repositories they choose, GitHub
 * hands back an installation id, and that id is all this system stores. What it
 * can reach is theirs to decide and theirs to withdraw.
 *
 * The shared token still works for every site without an installation, on
 * purpose — see `services/githubApp.ts`.
 */

type Access = { loadSite: (req: Request, id: string) => Promise<Site> };

export function registerGithubAppRoutes(router: Router, access: Access) {
  const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => {
    void fn(req, res).catch(next);
  };

  /** Whether the app exists yet, and where a customer goes to install it. */
  router.get("/github-app", handler(async (_req, res) => {
    const configured = await githubAppConfigured();
    res.json({
      configured,
      installUrl: configured ? await githubAppInstallUrl() : null,
      // Said plainly rather than left as an empty screen: this is a thing
      // somebody has to go and create once, and the product should say so.
      note: configured
        ? "Customers install the Dakyworld app on the repositories they choose. Their access can be narrowed or removed by them at any time."
        : "The Dakyworld GitHub App has not been set up yet, so websites connect with the shared access token instead. Create the app on GitHub and add its ID, slug and private key under Settings → Developer.",
    });
  }));

  /** The repositories one installation actually reaches, to pick from. */
  router.get("/github-app/installations/:installationId/repositories", handler(async (req, res) => {
    if (!(await githubAppConfigured())) throw new WebsiteError(503, "The Dakyworld GitHub App is not set up yet.");
    const repositories = await installationRepositories(req.params.installationId);
    res.json({ repositories });
  }));

  /**
   * Points a site at an installation and a repository inside it.
   *
   * The repository's numeric id is kept alongside the owner and name because a
   * repository can be renamed: the name is what people read, the id is what
   * identity should rest on.
   */
  router.put("/sites/:siteId/github-app", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const body = z
      .object({
        installationId: z.string().regex(/^\d{1,20}$/).nullable(),
        repositoryId: z.string().regex(/^\d{1,20}$/).optional(),
        repoOwner: z.string().regex(/^[a-zA-Z0-9_.-]+$/).max(100).optional(),
        repoName: z.string().regex(/^[a-zA-Z0-9_.-]+$/).max(100).optional(),
        repoBranch: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_./-]+$/).optional(),
      })
      .parse(req.body);

    assertWebsiteConnectionChange(req, site, { repoOwner: body.repoOwner ?? site.repoOwner, repoName: body.repoName ?? site.repoName });

    if (body.installationId === null) {
      await prisma.site.update({ where: { id: site.id }, data: { githubInstallationId: null, githubRepositoryId: null, githubAccessLostAt: null } });
      await prisma.siteAuditEvent.create({
        data: { siteId: site.id, kind: "GITHUB_APP_DISCONNECTED", summary: "Stopped using the customer's GitHub installation", actorName: req.dbUser?.name ?? "Website editor", actorId: req.dbUser?.id, detail: {} },
      });
      res.json({ ok: true, installationId: null });
      return;
    }

    // Proved before it is stored: an installation id that cannot be exchanged
    // for a token is a connection that looks made and fails at the first publish.
    const repositories = await installationRepositories(body.installationId).catch((error) => {
      throw error instanceof GitHubError ? new WebsiteError(error.status === 404 ? 404 : 502, error.message) : error;
    });
    const chosen = body.repositoryId
      ? repositories.find((repo) => repo.id === body.repositoryId)
      : repositories.find((repo) => repo.fullName.toLowerCase() === `${body.repoOwner ?? site.repoOwner}/${body.repoName ?? site.repoName}`.toLowerCase());
    if (!chosen) {
      throw new WebsiteError(
        400,
        `That installation does not include the repository. Ask the customer to add it to the Dakyworld app's repository access — it currently reaches ${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"}.`,
      );
    }

    const [owner, name] = chosen.fullName.split("/");
    await prisma.site.update({
      where: { id: site.id },
      data: {
        githubInstallationId: body.installationId,
        githubRepositoryId: chosen.id,
        githubAccessLostAt: null,
        repoOwner: owner,
        repoName: name,
        repoBranch: body.repoBranch ?? site.repoBranch ?? chosen.defaultBranch,
      },
    });
    await prisma.siteAuditEvent.create({
      data: {
        siteId: site.id,
        kind: "GITHUB_APP_CONNECTED",
        summary: `Connected ${chosen.fullName} through the customer's own GitHub installation`,
        actorName: req.dbUser?.name ?? "Website editor",
        actorId: req.dbUser?.id,
        detail: { installationId: body.installationId, repositoryId: chosen.id },
      },
    });

    res.json({ ok: true, installationId: body.installationId, repository: chosen });
  }));
}

/**
 * What GitHub tells us, unprompted.
 *
 * The one that matters: a customer removing a repository from the installation,
 * or uninstalling the app. Without this, the first anybody knows is a publish
 * failing with a 404 nobody can act on; with it, the site says its access was
 * withdrawn and when.
 *
 * Mounted outside the website router because GitHub is not a logged-in user —
 * the signature is the authentication, and an unsigned delivery is dropped
 * without being read.
 */
export function githubWebhookHandler() {
  return (req: Request, res: Response, next: (error?: unknown) => void) => {
    void (async () => {
      // The raw bytes, not a re-serialised object: a signature is over what was
      // sent, and `JSON.stringify` of a parsed body does not reliably reproduce
      // it. Mounted with `express.raw`, so this is a Buffer.
      const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
      if (!(await verifyGithubWebhook(req.header("x-hub-signature-256"), raw))) {
        res.status(401).json({ error: "Unsigned or wrongly signed delivery." });
        return;
      }

      const event = req.header("x-github-event") ?? "";
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.status(400).json({ error: "That delivery was not JSON." });
        return;
      }
      const body = parsed as {
        action?: string;
        installation?: { id?: number };
        repositories_removed?: Array<{ id?: number; full_name?: string }>;
        repositories_added?: Array<{ id?: number; full_name?: string }>;
      };
      const installationId = body.installation?.id ? String(body.installation.id) : null;
      if (!installationId) {
        res.json({ ok: true });
        return;
      }

      // Any change to an installation invalidates whatever token is cached for
      // it: an access that has just been narrowed must stop working now, not in
      // fifty-five minutes.
      forgetInstallationToken(installationId);

      if (event === "installation" && (body.action === "deleted" || body.action === "suspend")) {
        await prisma.site.updateMany({ where: { githubInstallationId: installationId }, data: { githubAccessLostAt: new Date() } });
      }
      if (event === "installation_repositories") {
        const removed = (body.repositories_removed ?? []).map((repo) => String(repo.id));
        const added = (body.repositories_added ?? []).map((repo) => String(repo.id));
        if (removed.length) {
          await prisma.site.updateMany({ where: { githubInstallationId: installationId, githubRepositoryId: { in: removed } }, data: { githubAccessLostAt: new Date() } });
        }
        if (added.length) {
          await prisma.site.updateMany({ where: { githubInstallationId: installationId, githubRepositoryId: { in: added } }, data: { githubAccessLostAt: null } });
        }
      }
      if (event === "installation" && body.action === "unsuspend") {
        await prisma.site.updateMany({ where: { githubInstallationId: installationId }, data: { githubAccessLostAt: null } });
      }

      res.json({ ok: true });
    })().catch(next);
  };
}
