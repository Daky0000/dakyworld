import type { Request, Response, Router } from "express";
import type { Site } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { GitHubError } from "../lib/github.js";
import {
  forgetInstallationToken,
  githubAppConfigured,
  githubAppInstallUrl,
  githubAuthorizeUrl,
  githubConnectState,
  githubConnectStateValid,
  githubInstallUrlWithState,
  githubSignInReady,
  installationRepositories,
  verifiedRepositoriesFor,
  verifyGithubWebhook,
} from "./githubApp.js";
import { assertWebsiteConnectionChange, canManageWebsiteConnection } from "./websiteAccess.js";
import { WebsiteError } from "./website/site.js";

/**
 * Connecting a customer's repository without ever holding their credentials.
 *
 * The flow this replaces asked somebody to create a personal access token and
 * paste it in, which is the worst version of the question: it asks the customer
 * for a secret that reaches everything they own, and leaves them no way to see
 * or narrow what it is used for.
 *
 * Here they install the DakyXTech app on the repositories they choose, GitHub
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
        ? "Customers install the DakyXTech app on the repositories they choose. Their access can be narrowed or removed by them at any time."
        : "The DakyXTech GitHub App has not been set up yet, so websites connect with the shared access token instead. Create the app on GitHub and add its ID, slug and private key under Settings → Developer.",
    });
  }));

  /** The repositories one installation actually reaches, to pick from. */
  router.get("/github-app/installations/:installationId/repositories", handler(async (req, res) => {
    if (!(await githubAppConfigured())) throw new WebsiteError(503, "The DakyXTech GitHub App is not set up yet.");
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

    // Staff may point a site at any installation. Anybody else only at a
    // repository they proved through GitHub that they reach — sending just an
    // installation id and a repository id, with no owner or name, used to read
    // as "no change" to the check below and connect whatever those numbers named.
    if (canManageWebsiteConnection(req)) {
      assertWebsiteConnectionChange(req, site, { repoOwner: body.repoOwner ?? site.repoOwner, repoName: body.repoName ?? site.repoName });
    } else {
      const claim = body.installationId && body.repositoryId && req.dbUser
        ? await prisma.githubRepoClaim.findFirst({ where: { userId: req.dbUser.id, installationId: body.installationId, repositoryId: body.repositoryId } })
        : null;
      if (!claim) {
        throw new WebsiteError(403, "Install the DakyXTech app on the repository from your own GitHub account first. Disconnecting one is done by DakyXTech staff.");
      }
    }

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
        `That installation does not include the repository. Ask the customer to add it to the DakyXTech app's repository access — it currently reaches ${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"}.`,
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
 * A customer connecting their own repository, with nobody from DakyXTech in
 * the loop.
 *
 * The staff routes above take an installation id on trust, which is fine for
 * staff and wrong for anybody else (see "Proving who installed it" in
 * githubApp.ts). These two never accept an installation id at all: the person
 * installs the app, GitHub signs them in on the way back, and the repositories
 * GitHub says *they* can reach are recorded against their account. Creating a
 * website from one of those is then a decision `POST /sites` can check.
 *
 * Both sit under the account routes in the access gate — they are about the
 * signed-in person, not one website — and scope themselves to `req.dbUser`.
 */
export function registerGithubConnectRoutes(router: Router) {
  const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => {
    void fn(req, res).catch(next);
  };

  /** Whether it is switched on, where to install, and what this person has proved so far. */
  router.get("/github/connect", handler(async (req, res) => {
    const userId = req.dbUser!.id;
    const ready = await githubSignInReady();
    const claims = await prisma.githubRepoClaim.findMany({
      where: { userId },
      orderBy: { fullName: "asc" },
      select: { repositoryId: true, fullName: true, defaultBranch: true, private: true, githubLogin: true, verifiedAt: true },
    });
    res.json({
      ready,
      installUrl: ready ? await githubInstallUrlWithState(await githubConnectState(userId)) : null,
      login: claims[0]?.githubLogin ?? null,
      repositories: claims.map((claim) => ({ id: claim.repositoryId, fullName: claim.fullName, defaultBranch: claim.defaultBranch, private: claim.private, verifiedAt: claim.verifiedAt })),
    });
  }));

  /**
   * Where GitHub sends the browser after the install, or after sign-in.
   *
   * Always ends on a page of the app rather than a JSON error, because the
   * person arriving here is in a browser tab, not a fetch.
   */
  router.get("/github/callback", handler(async (req, res) => {
    const userId = req.dbUser!.id;
    const query = req.query as Record<string, string | undefined>;
    const finish = (result: Record<string, string>) => res.redirect(`/website/github/connected?${new URLSearchParams(result)}`);

    if (query.error) return finish({ error: query.error_description || "GitHub sign-in was cancelled." });
    try {
      if (!(await githubConnectStateValid(query.state, userId))) {
        // Installed from the public app page rather than from a setup here — the
        // route staff walk a customer through. The number is what they need.
        const installation: Record<string, string> = /^\d{1,20}$/.test(query.installation_id ?? "") ? { installation: query.installation_id! } : {};
        return finish({ error: "This was not started from a DakyX setup, or the link has expired. Go back to DakyX and press the install button again.", ...installation });
      }
      const redirectUri = githubCallbackUrl(req);
      // An install made with the app's sign-in box unticked, or an existing
      // installation being reconfigured, comes back with no code. Sign-in is
      // then one more hop, with the same state.
      if (!query.code) return res.redirect(await githubAuthorizeUrl(redirectUri, query.state!));

      const { login, repositories } = await verifiedRepositoriesFor(query.code, redirectUri);
      // Replaced, not merged: a repository they have since taken away from the
      // app must stop counting the moment they come back.
      await prisma.$transaction([
        prisma.githubRepoClaim.deleteMany({ where: { userId } }),
        prisma.githubRepoClaim.createMany({
          data: repositories.map((repo) => ({ userId, installationId: repo.installationId, repositoryId: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch, private: repo.private, githubLogin: login })),
          skipDuplicates: true,
        }),
      ]);
      return finish({ ok: "1", repositories: String(repositories.length), login });
    } catch (error) {
      return finish({ error: error instanceof Error ? error.message : "GitHub could not be reached." });
    }
  }));
}

/**
 * The callback address on whichever host the person is signed in on — the
 * session cookie belongs to that host. Each must be listed as a callback URL in
 * the app's settings on GitHub, or GitHub refuses the sign-in.
 */
export function githubCallbackUrl(req: Request): string {
  const host = req.get("host") ?? "localhost";
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? req.protocol : "https"}://${host}/api/website/github/callback`;
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

/**
 * Somebody GitHub sent back here who is not signed in — usually a customer
 * installing from the public app page while staff set them up. Answered with a
 * page rather than the API's 401, and with the one number staff will ask for.
 * Mounted between `attachUser` and `requireAuth`; a signed-in request passes
 * straight through to the real callback.
 */
export function githubCallbackSignedOut() {
  return (req: Request, res: Response, next: (error?: unknown) => void) => {
    if (req.dbUser) return next();
    const raw = typeof req.query.installation_id === "string" ? req.query.installation_id : "";
    const installation = /^\d{1,20}$/.test(raw) ? raw : null;
    res.status(200).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub app installed</title><link rel="icon" href="/brand/favicon-32.png" sizes="32x32" type="image/png">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#ECEEF1;color:#0D1526;font:400 16px/1.6 Outfit,ui-sans-serif,system-ui,'Segoe UI',sans-serif;padding:2rem}
main{max-width:34rem;text-align:center;background:#fff;border:1px solid #E3E6EB;border-radius:14px;padding:2rem}h1{font-size:1.35rem;margin:0 0 .75rem;font-weight:500}p{margin:0 0 .75rem;color:#5B6374}b{color:#0D1526;font-weight:600}a{color:#2563EB}</style>
</head><body><main><h1>The DakyXTech app is installed</h1>
${installation ? `<p>If DakyXTech asked you for a number, it is <b>${installation}</b>.</p>` : ""}
<p>To connect it to your website yourself, <a href="/">sign in to DakyX</a> and choose <b>Connect a GitHub repository</b> in your setup.</p>
</main></body></html>`);
  };
}
