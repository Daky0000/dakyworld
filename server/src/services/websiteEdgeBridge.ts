import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import type { EdgeBridge, PublishJob, Site } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { SETTING, getSetting } from "../lib/settings.js";
import { committedFiles, githubRepoWrite, withGithubCredential } from "../lib/github.js";
import { siteRepo, underSiteCredential, WebsiteError } from "./website/site.js";
import { deployProfileOf, type DeployProfile } from "./websiteDeployDetect.js";
import { pagesAppCredential } from "./githubApp.js";
import { hostCall, HostApiError } from "./publishRoutes/hostApi.js";

/**
 * Route B, the edge bridge, as seen from the OS. The Worker is in `edge/`.
 *
 * At publish, the files the commit changed (pages, and the stylesheets,
 * scripts and images they use, because new HTML with old styles is a broken
 * page) are written to the Worker, which serves them in front of the host from
 * then on. The watcher keeps checking what the *host* serves, through the
 * Worker's bypass header, and once the host shows the change the bridged files
 * are deleted and the host takes over again.
 *
 * Files expire from the Worker after a day. A host that has not caught up by
 * then is not allowed to make the site go backwards: the files are renewed, up
 * to seven days, with an alert after the first day. After seven days they lapse
 * and the customer is told plainly that their host is failing.
 *
 * Getting a site onto the bridge is one DNS record: a CNAME from the site's
 * hostname to DakyX's edge hostname. The hostname is proved first with a TXT
 * record, as the hosting custom domain is, so nobody can put the bridge in
 * front of a site they do not own. Domain Connect does the record in one click
 * at the DNS providers that support it; everyone else gets the exact record and
 * a check that turns green. Only that one record is ever asked for: email and
 * every other record are left alone.
 */

const DAY_MS = 24 * 60 * 60_000;
const RENEW_LIMIT_MS = 7 * DAY_MS;
const MAX_FILE_BYTES = 1_900_000;
export const BRIDGE_TXT_PREFIX = "_dakyworld";

/* ------------------------------------------------------------ configuration */

export async function bridgeConfigured(): Promise<boolean> {
  return Boolean((await getSetting(SETTING.BRIDGE_ADMIN_URL)) && (await getSetting(SETTING.BRIDGE_ADMIN_TOKEN)) && (await getSetting(SETTING.BRIDGE_CNAME_TARGET)));
}

async function adminCall<T>(path: string, options: { method?: "GET" | "PUT" | "POST" | "DELETE"; json?: unknown; body?: Buffer; headers?: Record<string, string> } = {}): Promise<T> {
  const base = (await getSetting(SETTING.BRIDGE_ADMIN_URL))?.replace(/\/+$/, "");
  const token = await getSetting(SETTING.BRIDGE_ADMIN_TOKEN);
  if (!base || !token) throw new HostApiError("Edge bridge", 503, "The edge bridge is not set up.");
  return hostCall<T>("Edge bridge", `${base}${path}`, { method: options.method, json: options.json, body: options.body, headers: options.headers, token, timeoutMs: 8_000 });
}

/** The bypass header that makes the Worker show the host's own copy. */
export async function bridgeBypassHeaders(siteId: string): Promise<Record<string, string>> {
  const token = await getSetting(SETTING.BRIDGE_BYPASS_TOKEN);
  if (!token) return {};
  const bridge = await prisma.edgeBridge.findUnique({ where: { siteId }, select: { status: true } });
  return bridge && bridge.status !== "disabled" ? { "x-dakyx-bridge-bypass": token } : {};
}

export async function bridgeEligible(site: Site): Promise<boolean> {
  const bridge = await prisma.edgeBridge.findUnique({ where: { siteId: site.id }, select: { status: true } });
  return bridge?.status === "active" && (await bridgeConfigured());
}

/* ------------------------------------------------------------- publishing */

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", txt: "text/plain; charset=utf-8", xml: "application/xml", webmanifest: "application/manifest+json",
  mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf",
};

export function contentTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[extension] ?? "application/octet-stream";
}

/** The folder the host serves, from detection. */
function servedFolder(site: Site, profile: DeployProfile | null): string {
  const folder = profile?.pages?.buildType === "legacy" ? profile.pages.folder : profile?.deployFolder ?? site.repoPath;
  return (folder ?? "").replace(/^\/+|\/+$/g, "");
}

/** Repository files as the paths a visitor asks for. Files outside the served folder are left out. */
export function bridgedPaths(files: Array<{ path: string; content: Buffer | null }>, folder: string): Array<{ path: string; content: Buffer }> {
  const prefix = folder ? `${folder}/` : "";
  return files
    .filter((file): file is { path: string; content: Buffer } => file.content !== null && file.path.startsWith(prefix) && !/(^|\/)\.[^/]+/.test(file.path.slice(prefix.length)))
    .map((file) => ({ path: `/${file.path.slice(prefix.length)}`, content: file.content }));
}

/** Called by the router at publish. Answers in words for the activity screen. */
export async function bridgePublish(site: Site, job: PublishJob): Promise<string> {
  const bridge = await prisma.edgeBridge.findUniqueOrThrow({ where: { siteId: site.id } });
  const repo = siteRepo(site);
  if (!repo || !job.commitSha) throw new Error("No commit to bridge.");
  const files = bridgedPaths(await underSiteCredential(site, () => committedFiles(repo, job.commitSha!)), servedFolder(site, deployProfileOf(site)));
  const now = Date.now();
  let written = 0;
  let skipped = 0;
  for (const file of files) {
    if (file.content.length > MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    await adminCall(`/v1/hosts/${bridge.hostname}/object?path=${encodeURIComponent(file.path)}&ttl=${DAY_MS}`, {
      method: "PUT",
      body: file.content,
      headers: { "Content-Type": contentTypeFor(file.path), "x-dakyx-commit": job.commitSha },
    });
    // The newest copy of a path is the one that counts; older entries for it are gone from the Worker now.
    await prisma.edgeBridgeEntry.updateMany({ where: { bridgeId: bridge.id, path: file.path, clearedAt: null }, data: { clearedAt: new Date(now) } });
    await prisma.edgeBridgeEntry.create({
      data: { bridgeId: bridge.id, publishJobId: job.id, path: file.path, commitSha: job.commitSha, contentHash: createHash("sha256").update(file.content).digest("hex"), expiresAt: new Date(now + DAY_MS), renewUntil: new Date(now + RENEW_LIMIT_MS) },
    });
    written++;
  }
  if (!written) return skipped ? `Nothing small enough to serve from the edge (${skipped} file${skipped === 1 ? "" : "s"} over 1.9 MB).` : "Nothing this publish changed is served by the site.";
  return `Serving ${written} file${written === 1 ? "" : "s"} from the edge until the host catches up${skipped ? ` (${skipped} too large, left to the host)` : ""}.`;
}

/**
 * The host has caught up with this publish: its files, and any older ones,
 * leave the Worker. Called by the watcher when a job goes live.
 */
export async function clearBridgeFor(job: Pick<PublishJob, "id" | "siteId" | "createdAt">): Promise<number> {
  const bridge = await prisma.edgeBridge.findUnique({ where: { siteId: job.siteId } });
  if (!bridge) return 0;
  const entries = await prisma.edgeBridgeEntry.findMany({ where: { bridgeId: bridge.id, clearedAt: null, createdAt: { lte: new Date(job.createdAt.getTime() + 60_000) } } });
  let cleared = 0;
  for (const entry of entries) {
    // A newer publish that rewrote the same path keeps its copy.
    const newer = await prisma.edgeBridgeEntry.findFirst({ where: { bridgeId: bridge.id, path: entry.path, clearedAt: null, createdAt: { gt: entry.createdAt } } });
    if (newer) continue;
    await adminCall(`/v1/hosts/${bridge.hostname}/object?path=${encodeURIComponent(entry.path)}`, { method: "DELETE" }).catch(() => undefined);
    await prisma.edgeBridgeEntry.update({ where: { id: entry.id }, data: { clearedAt: new Date() } });
    cleared++;
  }
  return cleared;
}

/**
 * Keeps bridged files alive while the host has not caught up, up to seven days.
 * Run hourly. Alerts once a file has been waiting a day; lets it lapse, and
 * says so, after seven.
 */
export async function renewBridgeEntries(now = new Date(), alert: (siteId: string, message: string) => Promise<void> = async () => undefined): Promise<{ renewed: number; lapsed: number }> {
  const soon = new Date(now.getTime() + 2 * 60 * 60_000);
  const due = await prisma.edgeBridgeEntry.findMany({ where: { clearedAt: null, expiresAt: { lte: soon } }, include: { bridge: true }, take: 200 });
  let renewed = 0;
  let lapsed = 0;
  for (const entry of due) {
    if (entry.renewUntil <= now) {
      await prisma.edgeBridgeEntry.update({ where: { id: entry.id }, data: { clearedAt: now } });
      await prisma.siteAuditEvent.create({ data: { siteId: entry.bridge.siteId, kind: "BRIDGE_LAPSED", summary: `Your host has not rebuilt your site in 7 days, so ${entry.path} is back to the host's older copy. Check your host's deploy page.`, actorName: "DakyX", detail: { path: entry.path, commit: entry.commitSha } } }).catch(() => undefined);
      lapsed++;
      continue;
    }
    const ttl = Math.min(DAY_MS, entry.renewUntil.getTime() - now.getTime());
    try {
      await adminCall(`/v1/hosts/${entry.bridge.hostname}/renew`, { method: "POST", json: { paths: [entry.path], ttl } });
      await prisma.edgeBridgeEntry.update({ where: { id: entry.id }, data: { expiresAt: new Date(now.getTime() + ttl) } });
      renewed++;
    } catch {
      /* Tried again next hour, well inside the file's day. */
    }
    if (!entry.alertedAt && now.getTime() - entry.createdAt.getTime() > DAY_MS) {
      await alert(entry.bridge.siteId, `The host for ${entry.bridge.hostname} has not shown a publish from ${entry.createdAt.toISOString()} after a day. The edge bridge is still serving it.`);
      await prisma.edgeBridgeEntry.update({ where: { id: entry.id }, data: { alertedAt: now } });
    }
  }
  return { renewed, lapsed };
}

/* ------------------------------------------------------------- onboarding */

/** Where the host serves the site itself, for the Worker to pass requests to. */
export function defaultOrigin(site: Pick<Site, "repoOwner" | "repoName" | "publicUrl">, profile: DeployProfile | null): string | null {
  if (profile?.host === "github-pages" && site.repoOwner && site.repoName) {
    const userSite = site.repoName.toLowerCase() === `${site.repoOwner.toLowerCase()}.github.io`;
    return `https://${site.repoOwner.toLowerCase()}.github.io${userSite ? "" : `/${site.repoName}`}`;
  }
  return null;
}

export function bridgeDnsInstructions(hostname: string, token: string, target: string) {
  const labels = hostname.split(".");
  const apex = labels.length <= 2;
  return {
    txt: { name: `${BRIDGE_TXT_PREFIX}.${hostname}`, value: `dakyx-bridge=${token}` },
    cname: { name: hostname, value: target },
    apex,
    guidance: apex
      ? `${hostname} is a root domain, where most DNS providers cannot add a CNAME. Use your provider's ALIAS, ANAME or "CNAME flattening" record if it has one; otherwise point www.${hostname} at ${target} and turn on your registrar's forwarding from ${hostname} to https://www.${hostname}.`
      : null,
    untouched: "Only this one record changes. Your email (MX) and every other record stay exactly as they are.",
  };
}

/** The token for proving a hostname, kept on the bridge row. */
function bridgeToken(bridge: Pick<EdgeBridge, "id" | "createdAt">): string {
  return createHash("sha256").update(`${bridge.id}:${bridge.createdAt.toISOString()}:${process.env.APP_SECRET ?? process.env.DATABASE_URL ?? ""}`).digest("hex").slice(0, 32);
}

/** Starts putting a site behind the bridge: the row, the Worker's config, and what DNS to add. */
export async function startBridge(site: Site, input: { hostname?: string; origin?: string }): Promise<{ bridge: EdgeBridge; dns: ReturnType<typeof bridgeDnsInstructions> }> {
  if (!(await bridgeConfigured())) throw new WebsiteError(503, "Instant updates through the edge are not switched on yet.");
  const profile = deployProfileOf(site);
  const hostname = (input.hostname ?? new URL(site.publicUrl).hostname).toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) throw new WebsiteError(400, "That is not a hostname.");
  if (/\.(github\.io|netlify\.app|vercel\.app|pages\.dev)$/.test(hostname)) throw new WebsiteError(400, "Instant updates need the site's own domain, not the host's address.");
  const origin = input.origin ?? defaultOrigin(site, profile);
  if (!origin || !/^https:\/\//.test(origin)) throw new WebsiteError(400, "Say where your host serves the site (its own address, such as https://example.netlify.app).");
  const taken = await prisma.edgeBridge.findFirst({ where: { hostname, NOT: { siteId: site.id } } });
  if (taken) throw new WebsiteError(409, "That hostname is already behind the edge for another website.");
  const bridge = await prisma.edgeBridge.upsert({
    where: { siteId: site.id },
    create: { siteId: site.id, hostname, origin, status: "pending-dns" },
    update: { hostname, origin, status: "pending-dns", disabledReason: null },
  });
  // The Worker knows the host before any traffic arrives, so the moment DNS
  // moves, requests pass straight through.
  await adminCall(`/v1/hosts/${hostname}/config`, { method: "PUT", json: { hostname, origin, siteId: site.id } });
  return { bridge, dns: bridgeDnsInstructions(hostname, bridgeToken(bridge), (await getSetting(SETTING.BRIDGE_CNAME_TARGET))!) };
}

type CloudflareHostname = { id: string; status: string; ssl?: { status?: string } };

async function cloudflare<T>(path: string, options: { method?: "GET" | "POST" | "DELETE" | "PATCH"; json?: unknown } = {}): Promise<T> {
  const token = await getSetting(SETTING.CLOUDFLARE_API_TOKEN);
  const zone = await getSetting(SETTING.CLOUDFLARE_ZONE_ID);
  if (!token || !zone) throw new HostApiError("Cloudflare", 503, "Cloudflare is not set up for the edge bridge.");
  const body = await hostCall<{ result: T }>("Cloudflare", `https://api.cloudflare.com/client/v4/zones/${zone}${path}`, { ...options, token });
  return body.result;
}

/** Whether a DNS answer points at the edge. */
export function pointsAtEdge(cnames: string[], target: string): boolean {
  const clean = (value: string) => value.toLowerCase().replace(/\.$/, "");
  return cnames.some((name) => clean(name) === clean(target));
}

/**
 * One look at a pending bridge: proved, pointed, certificate issued? Moves it to
 * active when all three are true. For GitHub Pages it also clears the custom
 * domain from Pages, which would otherwise redirect the Worker's requests back
 * to the customer's domain in a loop. That needs the DakyX Pages app; without
 * it, the customer is told the one setting to clear.
 */
export async function checkBridge(siteId: string, lookup = { txt: (name: string) => dns.resolveTxt(name), cname: (name: string) => dns.resolveCname(name) }): Promise<{ status: string; steps: Array<{ step: string; done: boolean; note?: string }> }> {
  const bridge = await prisma.edgeBridge.findUniqueOrThrow({ where: { siteId }, include: { site: true } });
  const target = (await getSetting(SETTING.BRIDGE_CNAME_TARGET)) ?? "";
  const steps: Array<{ step: string; done: boolean; note?: string }> = [];

  const txt = await lookup.txt(`${BRIDGE_TXT_PREFIX}.${bridge.hostname}`).catch(() => [] as string[][]);
  const proved = txt.some((record) => record.join("") === `dakyx-bridge=${bridgeToken(bridge)}`);
  steps.push({ step: "The domain is proved to be yours", done: proved });

  const cnames = await lookup.cname(bridge.hostname).catch(() => [] as string[]);
  const pointed = pointsAtEdge(cnames, target);
  steps.push({ step: `${bridge.hostname} points at ${target}`, done: pointed, note: cnames.length && !pointed ? `It points at ${cnames[0]} at the moment.` : undefined });

  let certificate = bridge.sslStatus === "active";
  if (proved && pointed) {
    let hostnameId = bridge.cloudflareHostnameId;
    if (!hostnameId) {
      const created = await cloudflare<CloudflareHostname>("/custom_hostnames", { method: "POST", json: { hostname: bridge.hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } } });
      hostnameId = created.id;
    }
    const current = await cloudflare<CloudflareHostname>(`/custom_hostnames/${hostnameId}`);
    certificate = current.status === "active" && current.ssl?.status === "active";
    await prisma.edgeBridge.update({ where: { id: bridge.id }, data: { cloudflareHostnameId: hostnameId, sslStatus: current.ssl?.status ?? null, lastCheckedAt: new Date() } });
  }
  steps.push({ step: "Its secure certificate is issued", done: certificate });

  const profile = deployProfileOf(bridge.site);
  let loopFree = profile?.host !== "github-pages" || !profile.pages?.cname;
  if (certificate && !loopFree) {
    const credential = await pagesAppCredential(bridge.site).catch(() => null);
    const repo = siteRepo(bridge.site);
    if (credential && repo) {
      loopFree = await withGithubCredential(credential, () => githubRepoWrite(repo, "/pages", "PUT", { cname: null })).then(() => true).catch(() => false);
    }
  }
  steps.push({
    step: "GitHub Pages no longer redirects to the domain itself",
    done: loopFree,
    note: loopFree ? undefined : "In GitHub, open the repository's Settings, then Pages, and clear Custom domain. Or install the DakyX Pages app and DakyX does it for you.",
  });

  const ready = proved && pointed && certificate && loopFree;
  if (ready && bridge.status !== "active") await prisma.edgeBridge.update({ where: { id: bridge.id }, data: { status: "active", activatedAt: new Date() } });
  return { status: ready ? "active" : bridge.status, steps };
}

/** Pending bridges, checked a few at a time. */
export async function checkPendingBridges(limit = 10, lookedBefore?: Date): Promise<number> {
  const pending = await prisma.edgeBridge.findMany({ where: { status: "pending-dns", ...(lookedBefore ? { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: lookedBefore } }] } : {}) }, orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } }, take: limit, select: { siteId: true, id: true } });
  for (const bridge of pending) {
    await checkBridge(bridge.siteId).catch(async () => {
      await prisma.edgeBridge.update({ where: { id: bridge.id }, data: { lastCheckedAt: new Date() } }).catch(() => undefined);
    });
  }
  return pending.length;
}

/**
 * Stops serving files from the edge. Requests still pass through to the host,
 * because the customer's DNS still points here; taking the hostname away
 * before they move it back would take their site down.
 */
export async function pauseBridge(siteId: string, reason: string): Promise<void> {
  const bridge = await prisma.edgeBridge.findUnique({ where: { siteId } });
  if (!bridge) return;
  const entries = await prisma.edgeBridgeEntry.findMany({ where: { bridgeId: bridge.id, clearedAt: null } });
  for (const entry of entries) await adminCall(`/v1/hosts/${bridge.hostname}/object?path=${encodeURIComponent(entry.path)}`, { method: "DELETE" }).catch(() => undefined);
  await prisma.edgeBridgeEntry.updateMany({ where: { bridgeId: bridge.id, clearedAt: null }, data: { clearedAt: new Date() } });
  await prisma.edgeBridge.update({ where: { id: bridge.id }, data: { status: "disabled", disabledReason: reason.slice(0, 300) } });
}

/** Removes the bridge entirely, once the hostname no longer points here. */
export async function removeBridge(siteId: string, lookup = { cname: (name: string) => dns.resolveCname(name) }): Promise<void> {
  const bridge = await prisma.edgeBridge.findUnique({ where: { siteId } });
  if (!bridge) return;
  const target = (await getSetting(SETTING.BRIDGE_CNAME_TARGET)) ?? "";
  const cnames = await lookup.cname(bridge.hostname).catch(() => [] as string[]);
  if (bridge.cloudflareHostnameId && pointsAtEdge(cnames, target)) {
    throw new WebsiteError(409, `${bridge.hostname} still points at DakyX. Point it back at your host first, or the site would stop loading. Instant updates are paused in the meantime.`);
  }
  await pauseBridge(siteId, "Removed");
  await adminCall(`/v1/hosts/${bridge.hostname}/config`, { method: "DELETE" }).catch(() => undefined);
  if (bridge.cloudflareHostnameId) await cloudflare(`/custom_hostnames/${bridge.cloudflareHostnameId}`, { method: "DELETE" }).catch(() => undefined);
  await prisma.edgeBridge.delete({ where: { id: bridge.id } });
}

/** Resumes a paused bridge. */
export async function resumeBridge(siteId: string): Promise<void> {
  const bridge = await prisma.edgeBridge.findUniqueOrThrow({ where: { siteId } });
  await prisma.edgeBridge.update({ where: { id: bridge.id }, data: { status: bridge.activatedAt ? "active" : "pending-dns", disabledReason: null } });
}

export function bridgeView(bridge: EdgeBridge | null, target: string | null) {
  if (!bridge) return null;
  return {
    hostname: bridge.hostname,
    origin: bridge.origin,
    status: bridge.status,
    sslStatus: bridge.sslStatus,
    activatedAt: bridge.activatedAt,
    disabledReason: bridge.disabledReason,
    dns: target ? bridgeDnsInstructions(bridge.hostname, bridgeToken(bridge), target) : null,
  };
}

/* ------------------------------------------------------------ Domain Connect */

/**
 * The one-click DNS change, at providers that support Domain Connect and have
 * accepted DakyX's template (`edge/domainconnect/dakyx.com.bridge.json`). Each
 * provider onboards a template separately, so this is null everywhere until
 * DOMAIN_CONNECT_PROVIDER_ID is set and the provider answers.
 */
export async function domainConnectUrl(hostname: string, redirectUri: string, state: string, lookup = { txt: (name: string) => dns.resolveTxt(name) }, fetcher: typeof fetch = fetch): Promise<string | null> {
  const providerId = await getSetting(SETTING.DOMAIN_CONNECT_PROVIDER_ID);
  const serviceId = await getSetting(SETTING.DOMAIN_CONNECT_SERVICE_ID);
  const target = await getSetting(SETTING.BRIDGE_CNAME_TARGET);
  if (!providerId || !serviceId || !target) return null;
  const labels = hostname.split(".");
  if (labels.length < 3) return null;
  const domain = labels.slice(-2).join(".");
  const host = labels.slice(0, -2).join(".");
  const record = await lookup.txt(`_domainconnect.${domain}`).catch(() => [] as string[][]);
  const apiHost = record[0]?.join("");
  if (!apiHost || !/^[a-z0-9.-]+(\/[\w./-]*)?$/i.test(apiHost)) return null;
  const settings = await fetcher(`https://${apiHost}/v2/${domain}/settings`, { signal: AbortSignal.timeout(5_000) }).then((response) => (response.ok ? response.json() : null)).catch(() => null) as { urlSyncUX?: string } | null;
  if (!settings?.urlSyncUX || !/^https:\/\//.test(settings.urlSyncUX)) return null;
  const supported = await fetcher(`https://${apiHost}/v2/domainTemplates/providers/${providerId}/services/${serviceId}`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.ok).catch(() => false);
  if (!supported) return null;
  const query = new URLSearchParams({ domain, host, target, redirect_uri: redirectUri, state });
  return `${settings.urlSyncUX.replace(/\/+$/, "")}/v2/domainTemplates/providers/${providerId}/services/${serviceId}/apply?${query}`;
}

