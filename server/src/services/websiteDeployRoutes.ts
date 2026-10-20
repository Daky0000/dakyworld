import type { Request, Response, Router } from "express";
import type { Prisma, Site } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { SETTING, getSetting } from "../lib/settings.js";
import { readState, signState } from "../lib/signedState.js";
import { WebsiteError } from "./website/site.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";
import { deployProfileOf, FAST_ROUTES, refreshDeployProfile, type DeployProfile, type FastRoute } from "./websiteDeployDetect.js";
import { maskHook, saveDeployHook, storedHook, validateDeployHookUrl } from "./websiteDeployHook.js";
import { globallyDisabledRoutes } from "./websitePublishRouter.js";
import { pagesAppConfigured, pagesAppInstallUrl } from "./githubApp.js";
import { addNoJekyll, attachPagesInstallation, disablePagesRoute, enablePagesRoute } from "./publishRoutes/pagesActions.js";
import { DIRECT_PROVIDERS, PROVIDER_NAME, type DirectProvider } from "./publishRoutes/direct.js";
import { chooseHostSite, connectionCandidates, connectUrl, disconnectHost, exchangeCode, providerConfigured, saveConnection } from "./publishRoutes/hostConnect.js";
import { bridgeConfigured, bridgeView, checkBridge, domainConnectUrl, pauseBridge, removeBridge, resumeBridge, startBridge } from "./websiteEdgeBridge.js";

/**
 * The routes behind "How this site goes live" and "Make updates instant" in
 * Website settings. Everything here belongs to one site and needs Manage,
 * except reading the profile, which editors need for the branch warning in the
 * editor. The three places a host sends the browser back to are account
 * routes: the signed state carries the site and proves who started it.
 */

type Access = { loadSite: (req: Request, id: string) => Promise<Site> };

export type InstantOffer = {
  kind: "direct-netlify" | "direct-vercel" | "pages" | "bridge" | "build-step" | null;
  text: string | null;
  button: string | null;
  /** Already on. */
  active: boolean;
};

/**
 * The one option the "Make updates instant" card shows, from what detection
 * found. Pure, so the checks can walk every kind of site through it.
 */
export function instantOffer(input: {
  profile: DeployProfile | null;
  available: { netlify: boolean; vercel: boolean; pages: boolean; bridge: boolean };
  active: { direct: DirectProvider | null; pages: boolean; bridge: boolean };
}): InstantOffer {
  const { profile, available, active } = input;
  if (!profile) return { kind: null, text: null, button: null, active: false };
  if (active.bridge) return { kind: "bridge", text: "Updates are instant: the edge serves each publish while your host rebuilds.", button: null, active: true };
  if (active.direct) return { kind: active.direct === "netlify" ? "direct-netlify" : "direct-vercel", text: `Updates go straight to ${PROVIDER_NAME[active.direct]} in seconds.`, button: null, active: true };
  if (active.pages) return { kind: "pages", text: "GitHub Pages publishes straight from DakyX's workflow, without the Jekyll build.", button: null, active: true };
  if ((profile.host === "netlify" || profile.host === "vercel") && profile.hasBuildStep === false && available[profile.host]) {
    const name = PROVIDER_NAME[profile.host];
    return { kind: profile.host === "netlify" ? "direct-netlify" : "direct-vercel", text: `Connect ${name} to publish in seconds.`, button: `Connect ${name}`, active: false };
  }
  if (profile.hasBuildStep) {
    const seconds = profile.typicalSeconds;
    return { kind: "build-step", text: `Your site rebuilds on every publish${seconds ? `, usually in about ${seconds} seconds` : ""}.`, button: null, active: false };
  }
  if (available.bridge && profile.host !== "unknown") return { kind: "bridge", text: "Make updates instant with one change to your domain.", button: "Make instant", active: false };
  if (profile.host === "github-pages" && available.pages && !profile.pages?.jekyllContent) {
    return { kind: "pages", text: "Publish to GitHub Pages without waiting for the Jekyll build.", button: "Make faster", active: false };
  }
  return { kind: null, text: null, button: null, active: false };
}

const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => {
  void fn(req, res).catch(next);
};

/** The address a host sends the browser back to, on whichever host the person is signed in on. */
export function callbackUrl(req: Request, path: string): string {
  const host = req.get("host") ?? "localhost";
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? req.protocol : "https"}://${host}/api/website${path}`;
}

/**
 * A site for a callback. The access gate does not see these (they are account
 * routes, because the site is in the signed state rather than the path), so the
 * Manage check the start route made is made again here.
 */
async function managedSite(req: Request, siteId: string): Promise<Site> {
  await assertWebsiteSiteAccess(req, siteId, "manage");
  return prisma.site.findUniqueOrThrow({ where: { id: siteId } });
}

const providerParam = (value: string): DirectProvider => {
  if (!DIRECT_PROVIDERS.includes(value as DirectProvider)) throw new WebsiteError(404, "That host is not one DakyX can connect to.");
  return value as DirectProvider;
};

async function deployView(site: Site) {
  const profile = deployProfileOf(site);
  const [connections, bridge, globallyOff, netlify, vercel, pagesApp, bridgeReady, target] = await Promise.all([
    prisma.siteHostConnection.findMany({ where: { siteId: site.id } }),
    prisma.edgeBridge.findUnique({ where: { siteId: site.id } }),
    globallyDisabledRoutes(),
    providerConfigured("netlify"),
    providerConfigured("vercel"),
    pagesAppConfigured(),
    bridgeConfigured(),
    getSetting(SETTING.BRIDGE_CNAME_TARGET),
  ]);
  const hook = storedHook(site);
  const liveDirect = connections.find((connection) => !connection.pausedAt && connection.externalSiteId);
  return {
    profile,
    hook: hook ? { configured: true, masked: maskHook(hook), provider: (() => { const valid = validateDeployHookUrl(hook); return valid.ok ? valid.provider : "custom"; })(), used: profile?.answer !== "auto" } : { configured: false, masked: null, provider: null, used: false },
    connections: connections.map((connection) => ({
      provider: connection.provider,
      name: connection.externalName,
      matched: Boolean(connection.externalSiteId),
      paused: Boolean(connection.pausedAt),
      pausedReason: connection.pausedReason,
      connectedAt: connection.createdAt,
      lastUsedAt: connection.lastUsedAt,
    })),
    providers: { netlify, vercel },
    pagesApp: { configured: pagesApp, installed: Boolean(site.githubPagesInstallationId) },
    bridge: bridgeView(bridge, target),
    bridgeConfigured: bridgeReady,
    disabledGlobally: [...globallyOff],
    offer: instantOffer({
      profile,
      available: { netlify, vercel, pages: pagesApp, bridge: bridgeReady },
      active: { direct: liveDirect && profile?.hasBuildStep === false ? (liveDirect.provider as DirectProvider) : null, pages: Boolean(profile?.routes.pages?.workflowInstalled), bridge: bridge?.status === "active" },
    }),
  };
}

export function registerWebsiteDeployRoutes(router: Router, access: Access) {
  /** Everything "How this site goes live" shows. */
  router.get("/sites/:siteId/deploy", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    res.json(await deployView(site));
  }));

  /** Detect again now. */
  router.post("/sites/:siteId/deploy/detect", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    await refreshDeployProfile(site.id);
    res.json(await deployView(await prisma.site.findUniqueOrThrow({ where: { id: site.id } })));
  }));

  /** Save or clear the deploy hook. `test` calls it once before saving. */
  router.put("/sites/:siteId/deploy/hook", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    const body = z.object({ url: z.string().max(2_000).nullable(), test: z.boolean().default(true) }).parse(req.body ?? {});
    const saved = await saveDeployHook(site.id, body.url, { test: body.test });
    await prisma.siteAuditEvent.create({ data: { siteId: site.id, kind: body.url ? "DEPLOY_HOOK_SET" : "DEPLOY_HOOK_CLEARED", summary: body.url ? `Saved a ${saved.provider} deploy hook` : "Removed the deploy hook", actorId: req.dbUser?.id, actorName: req.dbUser?.name ?? "Website settings", detail: {} } }).catch(() => undefined);
    res.json(saved);
  }));

  /** `.nojekyll`, one click. */
  router.post("/sites/:siteId/deploy/nojekyll", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    await addNoJekyll(site);
    res.json(await deployView(await prisma.site.findUniqueOrThrow({ where: { id: site.id } })));
  }));

  /** The per-site off switch for one faster route. */
  router.put("/sites/:siteId/deploy/routes", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    const body = z.object({ route: z.enum(FAST_ROUTES as unknown as [FastRoute, ...FastRoute[]]), enabled: z.boolean() }).parse(req.body ?? {});
    const profile = deployProfileOf(site) ?? (await refreshDeployProfile(site.id));
    if (!profile) throw new WebsiteError(409, "This site has not been looked at yet. Detect first.");
    const disabled = new Set(profile.disabledRoutes);
    if (body.enabled) disabled.delete(body.route);
    else disabled.add(body.route);
    await prisma.site.update({ where: { id: site.id }, data: { deployProfile: { ...profile, disabledRoutes: [...disabled] } as unknown as Prisma.InputJsonValue } });
    res.json(await deployView(await prisma.site.findUniqueOrThrow({ where: { id: site.id } })));
  }));

  /* ------------------------------------------------ Route P: DakyX Pages */

  /** Where to install DakyX Pages, or, once installed, turn the route on. */
  router.post("/sites/:siteId/deploy/pages", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    const body = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    if (!body.enabled) {
      await disablePagesRoute(site, req.dbUser?.id ?? null);
      res.json({ view: await deployView(await prisma.site.findUniqueOrThrow({ where: { id: site.id } })) });
      return;
    }
    if (!site.githubPagesInstallationId) {
      const url = await pagesAppInstallUrl(signState({ site: site.id, user: req.dbUser!.id, enable: "1" }));
      if (!url) throw new WebsiteError(503, "The DakyX Pages app is not set up yet.");
      res.json({ installUrl: url });
      return;
    }
    await enablePagesRoute(site, req.dbUser?.id ?? null);
    res.json({ view: await deployView(await prisma.site.findUniqueOrThrow({ where: { id: site.id } })) });
  }));

  /** GitHub sends the browser here after DakyX Pages is installed (the app's Setup URL). */
  router.get("/github-pages/callback", handler(async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const state = readState(query.state, req.dbUser!.id);
    const finish = (siteId: string | undefined, result: Record<string, string>) => res.redirect(`/website/settings?${new URLSearchParams({ ...(siteId ? { site: siteId } : {}), ...result })}`);
    if (!state?.site) return finish(undefined, { deployError: "This was not started from DakyX, or the link expired. Press the button in Website settings again." });
    try {
      const site = await managedSite(req, state.site);
      if (!/^\d{1,20}$/.test(query.installation_id ?? "")) return finish(site.id, { deployError: "GitHub did not say which installation was made." });
      await attachPagesInstallation(site, query.installation_id!);
      if (state.enable === "1") await enablePagesRoute(await prisma.site.findUniqueOrThrow({ where: { id: site.id } }), req.dbUser?.id ?? null);
      return finish(site.id, { connected: "pages" });
    } catch (error) {
      return finish(state.site, { deployError: error instanceof Error ? error.message : "That did not work." });
    }
  }));

  /* -------------------------------------- Route A: Netlify and Vercel */

  router.post("/sites/:siteId/connect/:provider", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    const provider = providerParam(req.params.provider!);
    if (!(await providerConfigured(provider))) throw new WebsiteError(503, `Connecting ${PROVIDER_NAME[provider]} is not switched on yet.`);
    const state = signState({ site: site.id, user: req.dbUser!.id, provider });
    res.json({ url: await connectUrl(provider, callbackUrl(req, `/connect/${provider}/callback`), state) });
  }));

  router.get("/connect/:provider/callback", handler(async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const provider = providerParam(req.params.provider!);
    const state = readState(query.state, req.dbUser!.id);
    const finish = (siteId: string | undefined, result: Record<string, string>) => res.redirect(`/website/settings?${new URLSearchParams({ ...(siteId ? { site: siteId } : {}), ...result })}`);
    if (!state?.site || state.provider !== provider) return finish(undefined, { deployError: "This was not started from DakyX, or the link expired. Press Connect again." });
    if (query.error) return finish(state.site, { deployError: `${PROVIDER_NAME[provider]} said: ${query.error_description ?? query.error}` });
    try {
      const site = await managedSite(req, state.site);
      if (!query.code) return finish(site.id, { deployError: `${PROVIDER_NAME[provider]} did not send a sign-in back.` });
      const grant = await exchangeCode(provider, query.code, callbackUrl(req, `/connect/${provider}/callback`));
      const saved = await saveConnection({ site, provider, token: grant.token, teamId: query.teamId ?? grant.teamId, configurationId: query.configurationId ?? null, userId: req.dbUser?.id ?? null });
      // Vercel hands back a `next` URL to finish its own install screen; ours is the settings page.
      return finish(site.id, { connected: provider, ...(saved.matched ? {} : { choose: provider }) });
    } catch (error) {
      return finish(state.site, { deployError: error instanceof Error ? error.message : `${PROVIDER_NAME[provider]} could not be reached.` });
    }
  }));

  /** The host sites a connection could be, when it could not be matched on its own. */
  router.get("/sites/:siteId/connect/:provider/candidates", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    res.json({ candidates: await connectionCandidates(site.id, providerParam(req.params.provider!)) });
  }));

  router.put("/sites/:siteId/connect/:provider", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    const body = z.object({ externalSiteId: z.string().min(1).max(200) }).parse(req.body ?? {});
    const chosen = await chooseHostSite(site.id, providerParam(req.params.provider!), body.externalSiteId).catch((error: Error) => {
      throw new WebsiteError(400, error.message);
    });
    res.json({ chosen, view: await deployView(site) });
  }));

  router.delete("/sites/:siteId/connect/:provider", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    const result = await disconnectHost(site.id, providerParam(req.params.provider!), req.dbUser?.id ?? null);
    res.json({ ...result, view: await deployView(site) });
  }));

  /* ------------------------------------------------- Route B: the bridge */

  router.post("/sites/:siteId/bridge", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    const body = z.object({ hostname: z.string().max(253).optional(), origin: z.string().url().max(500).optional() }).parse(req.body ?? {});
    const started = await startBridge(site, body);
    const oneClick = await domainConnectUrl(started.bridge.hostname, callbackUrl(req, "/bridge/connected"), signState({ site: site.id, user: req.dbUser!.id })).catch(() => null);
    await prisma.siteAuditEvent.create({ data: { siteId: site.id, kind: "BRIDGE_STARTED", summary: `Started instant updates for ${started.bridge.hostname}`, actorId: req.dbUser?.id, actorName: req.dbUser?.name ?? "Website settings", detail: { origin: started.bridge.origin } } }).catch(() => undefined);
    res.json({ dns: started.dns, oneClick, view: await deployView(site) });
  }));

  router.post("/sites/:siteId/bridge/check", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    const result = await checkBridge(site.id);
    res.json({ ...result, view: await deployView(site) });
  }));

  router.put("/sites/:siteId/bridge", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    const body = z.object({ paused: z.boolean() }).parse(req.body ?? {});
    if (body.paused) await pauseBridge(site.id, "Paused in Website settings");
    else await resumeBridge(site.id);
    res.json({ view: await deployView(site) });
  }));

  router.delete("/sites/:siteId/bridge", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId!);
    await removeBridge(site.id);
    res.json({ view: await deployView(site) });
  }));

  /** Where a Domain Connect provider sends the browser back after the one-click change. */
  router.get("/bridge/connected", handler(async (req, res) => {
    const state = readState((req.query as Record<string, string | undefined>).state, req.dbUser!.id);
    if (state?.site) await managedSite(req, state.site).then(() => checkBridge(state.site!)).catch(() => undefined);
    res.redirect(`/website/settings?${new URLSearchParams(state?.site ? { site: state.site, connected: "bridge" } : { deployError: "The link expired. Press Check in Website settings." })}`);
  }));
}
