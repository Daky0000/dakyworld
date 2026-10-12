import {
  MOVED_ASSET_CACHE, movedAssetLocation, publishedAssetBytes, publishedAssetCacheControl, publishedAssetEtag, readPublishedAsset,
} from "./publishedAssets.js";
import { decodeEntities, parse } from "./website/index.js";
import { getOrLoad } from "../lib/cache.js";
import { capacity } from "../lib/capacity.js";
import { cloudflareZones } from "./cacheInvalidation.js";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import type { Express, Request, Response, NextFunction, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { WebsiteError } from "./website/site.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";

import { SVG_CONTENT_SECURITY_POLICY } from "../lib/svgSanitize.js";
import { FORM_ENDPOINT, receiveFormPost, routeFormsToInbox } from "./websiteForms.js";
import { recordVisit } from "./websiteVisits.js";

/**
 * Serving a customer's published website.
 *
 * The editor could only ever publish into a GitHub repository, which quietly
 * decided who the product was for: a small business with a website and no
 * repository could pay, edit, press Publish — and nothing would reach the web.
 * The publish job would sit in DEPLOYING waiting for a deployment that was
 * never coming.
 *
 * So the OS hosts them. Every site gets `<hostedSlug>.<WEBSITE_HOST_DOMAIN>`
 * from the moment it exists, and a customer can point their own domain at it
 * once they have proved they own it. Sites with a repository are untouched:
 * that is still the right answer for a developer's site, and both paths write
 * the same published HTML.
 *
 * What this deliberately is not: a CDN. Pages are served from the database with
 * an ETag and a short cache. For brochure sites at this price that is enough,
 * and putting Cloudflare in front of it later changes nothing here.
 */

/** The domain hosted sites hang off. Without it, only path-based hosting works. */
export const HOST_DOMAIN = (process.env.WEBSITE_HOST_DOMAIN ?? "").trim().toLowerCase();

/** The TXT record a customer publishes to prove a domain is theirs. */
export const DOMAIN_TXT_PREFIX = "_dakyworld";

function normalizeDomain(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) {
    throw new WebsiteError(400, "That does not look like a domain name. Enter it as `example.com`, with no https:// and no path.");
  }
  return trimmed;
}

function hostOf(req: Request): string {
  return (req.headers.host ?? "").toLowerCase().split(":")[0] ?? "";
}

/**
 * Which site, if any, this request is for.
 *
 * A custom domain only counts once verified. Serving a domain somebody merely
 * typed into a form would let anyone claim a hostname they do not own and have
 * us answer for it.
 */
async function uncachedSiteForHost(host: string) {
  if (!host) return null;
  const byDomain = await prisma.site.findFirst({
    where: { customDomain: host, customDomainVerifiedAt: { not: null }, hostedEnabled: true, deletionScheduledFor: null },
    select: { id: true, name: true, publicUrl: true },
  });
  if (byDomain) return byDomain;

  if (HOST_DOMAIN && host.endsWith(`.${HOST_DOMAIN}`)) {
    const label = host.slice(0, -(HOST_DOMAIN.length + 1));
    if (!label || label.includes(".")) return null;
    return prisma.site.findFirst({ where: { hostedSlug: label, hostedEnabled: true, deletionScheduledFor: null }, select: { id: true, name: true, publicUrl: true } });
  }
  return null;
}

function osHosts(): Set<string> {
  const hosts = (process.env.OS_HOSTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  // CLIENT_ORIGIN is a comma-separated list in production. Read as one URL it
  // parses to the hostname "os.dakyx.com,https", so a host named there and not
  // in the list below was looked up as a customer's website and answered 404.
  const origins = [process.env.CLIENT_ORIGIN, process.env.APP_URL, process.env.RAILWAY_PUBLIC_DOMAIN].flatMap(value => (value ?? "").split(","));
  for (const value of origins.map(origin => origin.trim()).filter(Boolean)) {
    try { hosts.push(new URL(value.includes("://") ? value : `https://${value}`).hostname); } catch { /* Invalid optional URL is not trusted. */ }
  }
  hosts.push("os.dakyx.com", "app.dakyx.com", "editor.dakyx.com", "os.dakyworld.com");
  if (process.env.NODE_ENV !== "production") hosts.push("localhost", "127.0.0.1");
  return new Set(hosts);
}
async function siteForHost(host: string) {
  if (osHosts().has(host)) return null;
  // Unknown hosts have a short lifetime to avoid retaining arbitrary host scans.
  return getOrLoad({ scope: "public", resource: "hosts", identity: host }, { ttlMs: 4500 }, () => uncachedSiteForHost(host));
}

/**
 * The other spelling of a verified domain, when this host is it.
 *
 * A customer connects `example.com` or `www.example.com`, and people type both.
 * Whichever one was not connected used to answer 404, so the address on the
 * shop sign was a dead link for half of the people who tried it. Only a
 * verified domain is redirected to — the same rule that decides what is served.
 */
async function canonicalHostFor(host: string): Promise<string | null> {
  const other = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  if (!other.includes(".")) return null;
  const verified = await getOrLoad({ scope: "public", resource: "hosts", identity: `verified:${other}` }, { ttlMs: 4500 }, async () =>
    Boolean(await prisma.site.findFirst({
      where: { customDomain: other, customDomainVerifiedAt: { not: null }, hostedEnabled: true, deletionScheduledFor: null },
      select: { id: true },
    })));
  return verified ? other : null;
}

/**
 * A ceiling per visitor per hosted site, held in memory.
 *
 * Hosted pages share a process with the editor, so one scraper hammering one
 * customer's site slowed every customer's editor. Generous on purpose — a page
 * with forty pictures is forty requests, and a school or an office is one
 * address — and never a database write per page view, which would turn a flood
 * into exactly the load this is meant to stop. When the table is full the
 * oldest windows go; nobody is refused because somebody else filled it.
 */
const VISITOR_WINDOW_MS = 60_000;
const VISITOR_KEYS = 20_000;
const visitorWindows = new Map<string, { count: number; resetAt: number }>();

function visitorLimit(): number {
  const value = Number(process.env.WEBSITE_HOST_RATE_LIMIT);
  return Number.isInteger(value) && value > 0 ? value : 300;
}

/** Seconds until this visitor may come back, or 0 while they are within the limit. */
function visitorRetryAfter(key: string, now = Date.now()): number {
  let entry = visitorWindows.get(key);
  if (!entry || entry.resetAt <= now) {
    // A new window is always appended, never renewed in place, so the map stays
    // in the order windows end and the expired or oldest ones are at its head.
    if (entry) visitorWindows.delete(key);
    for (const [oldest, held] of visitorWindows) {
      if (held.resetAt > now && visitorWindows.size < VISITOR_KEYS) break;
      visitorWindows.delete(oldest);
    }
    entry = { count: 0, resetAt: now + VISITOR_WINDOW_MS };
    visitorWindows.set(key, entry);
  }
  entry.count += 1;
  return entry.count > visitorLimit() ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
}

async function findLivePage(siteId: string, path: string) {
  return (await prisma.sitePage.findFirst({
    where: { siteId, path, status: "LIVE" },
    select: { publishedHtml: true, publishedEtag: true },
  })) ??
    // `/about.html` and `/about` are the same page to somebody typing it.
    (await prisma.sitePage.findFirst({
      where: { siteId, filePath: path.replace(/^\//, ""), status: "LIVE" },
      select: { publishedHtml: true, publishedEtag: true },
    }));
}

/**
 * The query string is not part of the key: a hosted page is static, and
 * `?utm_source=` on every shared link made each of them a cache miss.
 */
function livePage(siteId: string, host: string, path: string, bypass: boolean) {
  return getOrLoad({ scope: `public:${siteId}`, resource: "pages", identity: `${host}:${path}` },
    { ttlMs: 25_000, cacheNull: false, maxBytes: 1024 * 1024, bypass }, () => findLivePage(siteId, path));
}

/**
 * An uploaded file a LIVE page of this site points at, and nothing else.
 *
 * The bytes are read only when they are about to be sent: a revalidation is
 * answered from the path and size. Once the deploy script has moved a file to
 * R2 and emptied the column, the visitor is sent there instead of a 404.
 */
async function serveAsset(site: { id: string; publicUrl: string }, assetPath: string, path: string, req: Request, res: Response) {
  const asset = await readPublishedAsset(site, assetPath, path);
  if (!asset) return res.status(404).set("Cache-Control", "no-store").end();
  const etag = publishedAssetEtag(asset);
  const cacheControl = publishedAssetCacheControl(asset.repoPath);
  if (req.headers["if-none-match"] === etag) return res.status(304).set("Cache-Control", cacheControl).set("ETag", etag).end();
  const bytes = await publishedAssetBytes(site.id, asset.repoPath);
  if (!bytes) {
    const moved = movedAssetLocation(asset.repoPath);
    if (!moved) return res.status(404).set("Cache-Control", "no-store").end();
    return res.set("Cache-Control", MOVED_ASSET_CACHE).redirect(302, moved);
  }
  if (asset.contentType === "image/svg+xml") res.set("Content-Security-Policy", SVG_CONTENT_SECURITY_POLICY);
  return res.status(200)
    .set("Content-Type", asset.contentType)
    .set("X-Content-Type-Options", "nosniff")
    .set("Cache-Control", cacheControl)
    .set("ETag", etag)
    .send(bytes);
}

const xmlEscape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

async function sitemapFor(siteId: string, host: string): Promise<string> {
  const pages = await prisma.sitePage.findMany({
    where: { siteId, status: "LIVE", publishedHtml: { not: null } },
    select: { path: true, lastPublishedAt: true },
    orderBy: { path: "asc" },
    take: 50_000,
  });
  const urls = pages.map((page) => {
    // One leading slash, always, so a stored path can never name another host.
    const loc = new URL(`/${page.path.replace(/^\/+/, "")}`, `https://${host}/`).href;
    return `  <url><loc>${xmlEscape(loc)}</loc>${page.lastPublishedAt ? `<lastmod>${page.lastPublishedAt.toISOString()}</lastmod>` : ""}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** The first `<link rel="icon">` (or `shortcut icon`) the HTML declares, read by the editor's own parser. */
function declaredIcon(html: string): string | null {
  const stack = [parse(html)];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.tag === "link") {
      const rel = node.attrs.find((attribute) => attribute.name === "rel")?.value ?? "";
      const href = node.attrs.find((attribute) => attribute.name === "href")?.value.trim();
      if (href && rel.toLowerCase().split(/\s+/).includes("icon")) return decodeEntities(href);
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]!);
  }
  return null;
}

/** Where `/favicon.ico` should send a browser: a same-site path or an https URL, never itself. */
async function faviconFor(siteId: string, host: string): Promise<string | null> {
  const home = await findLivePage(siteId, "/");
  const href = home?.publishedHtml ? declaredIcon(home.publishedHtml) : null;
  if (!href) return null;
  let url: URL;
  try { url = new URL(href, `https://${host}/`); } catch { return null; }
  if (url.host === host) return url.pathname === "/favicon.ico" ? null : `${url.pathname}${url.search}`;
  return url.protocol === "https:" ? url.href : null;
}

/**
 * robots.txt, sitemap.xml and favicon.ico, for a site that has not published
 * its own. Search engines and browsers ask every site for all three; a hosted
 * site answered each with the "Page not found" page, which told Google there
 * was no sitemap and filled every visitor's console with a 404.
 */
async function serveSiteFile(site: { id: string }, host: string, path: string, res: Response): Promise<boolean> {
  if (path === "/robots.txt") {
    res.status(200).set("Content-Type", "text/plain; charset=utf-8").set("Cache-Control", "public, max-age=3600")
      .send(`User-agent: *\nAllow: /\n\nSitemap: https://${host}/sitemap.xml\n`);
    return true;
  }
  if (path === "/sitemap.xml") {
    const xml = await getOrLoad({ scope: `public:${site.id}`, resource: "pages", identity: `${host}:#sitemap` },
      { ttlMs: 25_000, maxBytes: 4 * 1024 * 1024 }, () => sitemapFor(site.id, host));
    res.status(200).set("Content-Type", "application/xml; charset=utf-8").set("Cache-Control", "public, max-age=300").send(xml);
    return true;
  }
  if (path === "/favicon.ico") {
    const { location } = await getOrLoad({ scope: `public:${site.id}`, resource: "pages", identity: `${host}:#favicon` },
      { ttlMs: 25_000 }, async () => ({ location: await faviconFor(site.id, host) }));
    if (location) res.set("Cache-Control", "public, max-age=3600").redirect(302, location);
    else res.status(204).set("Cache-Control", "public, max-age=86400").end();
    return true;
  }
  return false;
}

function etagFor(html: string): string {
  return `W/"${crypto.createHash("sha1").update(html).digest("base64url")}"`;
}

/**
 * The page as served: forms that post nowhere pointed at the site's inbox
 * (services/websiteForms.ts). Remembered per published version, and the ETag
 * says when the served copy differs from the stored one, so a browser holding
 * the page from before this existed is not told it is still current.
 */
const servedCopies = new Map<string, string>();
function servedPage(html: string, path: string, etag: string): { html: string; etag: string } {
  const key = `${etag}|${path}`;
  let out = servedCopies.get(key);
  if (out === undefined) {
    out = routeFormsToInbox(html, path);
    if (servedCopies.size > 300) servedCopies.clear();
    servedCopies.set(key, out);
  }
  return out === html ? { html, etag } : { html: out, etag: etag.replace(/"$/, '-f1"') };
}

const NOT_FOUND_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#1b2029}main{text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#5b6572;margin:0}</style></head><body><main><h1>Page not found</h1><p>This address is not part of this website.</p></main></body></html>`;

const NOT_PUBLISHED_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not published yet</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#1b2029}main{text-align:center;padding:24px;max-width:32rem}h1{font-size:20px;margin:0 0 8px}p{color:#5b6572;margin:0;line-height:1.6}</style></head><body><main><h1>This website has not been published yet</h1><p>The address is reserved and working. As soon as its first page is published in the editor, it will appear here.</p></main></body></html>`;

/**
 * Serves published pages for a hosted site, by hostname.
 *
 * Mounted ahead of the OS's own client and API. It only ever answers for a
 * hostname that belongs to a hosted site, so `os.dakyx.com` falls straight
 * through to the app.
 */
export function publicSiteHosting() {
  return async function hostingMiddleware(req: Request, res: Response, next: NextFunction) {
    if (req.path === "/api/ready" || req.path === "/api/health") return next();
    const host = hostOf(req);
    if (!host || osHosts().has(host)) return next();

    const retryAfter = visitorRetryAfter(`${host} ${req.ip ?? req.socket.remoteAddress ?? "?"}`);
    if (retryAfter) return res.status(429).set("Retry-After", String(retryAfter)).set("Cache-Control", "no-store").end();

    let site: { id: string; name: string; publicUrl: string } | null = null;
    let canonical: string | null = null;
    try {
      site = await siteForHost(host);
      if (!site) canonical = await canonicalHostFor(host);
    } catch {
      return res.status(503).set("Cache-Control", "no-store").end();
    }
    if (canonical) {
      // An hour rather than for ever: a browser keeps a bare 301 indefinitely,
      // and a customer can still change which spelling they connect.
      return res.set("Cache-Control", "public, max-age=3600")
        .redirect(301, `https://${canonical}${req.originalUrl.startsWith("/") ? req.originalUrl : "/"}`);
    }
    if (!site) return res.status(404).set("Cache-Control", "no-store").end();
    // A form on the site sending its message — the one thing a visitor posts.
    if (req.method === "POST" && req.path === FORM_ENDPOINT) {
      try {
        await receiveFormPost(site, req, res);
      } catch (error) {
        console.error(`[hosting] form post to ${host} failed:`, (error as Error).message);
        if (!res.headersSent) res.status(503).set("Cache-Control", "no-store").end();
      }
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) return res.status(405).set("Cache-Control", "no-store").end();

    const path = (req.path || "/").replace(/\/+$/, "") || "/";
    try {
      const assetPath = /(?:^|\/)(assets\/dw\/[^/]+)$/.exec(path)?.[1];
      if (assetPath) return await serveAsset(site, assetPath, path, req, res);

      // The one header added to a customer's pages. No Content-Security-Policy
      // or X-Frame-Options: we cannot know what their scripts load or where they
      // are embedded, and a guess would break their own website.
      res.set("Referrer-Policy", "strict-origin-when-cross-origin");
      const page = await livePage(site.id, host, path, Boolean(req.headers.authorization || req.headers.cookie || req.headers["x-dw-cache-bypass"]));

      if (!page) {
        if (await serveSiteFile(site, host, path, res)) return;
        const anyPublished = await prisma.sitePage.count({ where: { siteId: site.id, publishedHtml: { not: null } } });
        return res
          .status(anyPublished > 0 ? 404 : 503)
          .set("Content-Type", "text/html; charset=utf-8")
          .set("Cache-Control", "no-store")
          .send(anyPublished > 0 ? NOT_FOUND_HTML : NOT_PUBLISHED_HTML);
      }
      if (!page.publishedHtml) {
        return res
          .status(503)
          .set("Content-Type", "text/html; charset=utf-8")
          .set("Cache-Control", "no-store")
          .send(NOT_PUBLISHED_HTML);
      }

      const served = servedPage(page.publishedHtml, path, page.publishedEtag ?? etagFor(page.publishedHtml));
      const etag = served.etag;
      const edgeAllowed = capacity.edge && Boolean(cloudflareZones()[host]) && !req.headers.cookie && !req.headers.authorization && !res.hasHeader("Set-Cookie");
      res.set("ETag", etag).set("Cache-Control", edgeAllowed ? "public, max-age=0, s-maxage=25, must-revalidate" : "private, no-cache");
      // A page somebody was shown — fresh or from their cache — is a visit.
      recordVisit(site.id, req, path, host);
      if (req.headers["if-none-match"] === etag) return res.status(304).end();
      return res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("ETag", etag)
        // Short, because a customer who presses Publish expects to see it. The
        // ETag is what saves the bandwidth on a reload.
        .set("X-Content-Type-Options", "nosniff")
        .send(served.html);
    } catch (error) {
      console.error(`[hosting] ${host}${req.path} failed:`, (error as Error).message);
      return res.status(503).set("Cache-Control", "no-store").end();
    }
  };
}

export function mountPublicSiteHosting(app: Express) {
  app.use(publicSiteHosting());
}

/* ------------------------------------------------------------- domains ---- */

export function hostedUrlFor(site: { hostedSlug: string | null; customDomain: string | null; customDomainVerifiedAt: Date | null }): string | null {
  if (site.customDomain && site.customDomainVerifiedAt) return `https://${site.customDomain}`;
  if (site.hostedSlug && HOST_DOMAIN) return `https://${site.hostedSlug}.${HOST_DOMAIN}`;
  return null;
}

/**
 * Second-level suffixes under which a registrable domain has three labels.
 * Not the public suffix list — enough to tell `shop.com.gh` is a zone apex
 * and `shop.example.com` is not, for the countries customers are in.
 */
const SECOND_LEVEL_SUFFIXES = new Set(["com.gh", "org.gh", "edu.gh", "gov.gh", "co.uk", "org.uk", "com.ng", "co.za", "co.ke", "com.au"]);

export function isApexDomain(domain: string): boolean {
  const labels = domain.split(".");
  return labels.length === 2 || (labels.length === 3 && SECOND_LEVEL_SUFFIXES.has(labels.slice(1).join(".")));
}

/**
 * The records a customer adds, in the words their DNS provider uses.
 *
 * "CNAME your domain to us" is impossible at a zone apex — DNS forbids a CNAME
 * beside the SOA and NS records every apex has — and most customers connect
 * exactly that, `example.com`. Told to do it anyway, a provider either refuses
 * or quietly breaks their email. So an apex gets the names of the records that
 * do work there, the fallback when the provider has none, and the www record
 * that makes the other spelling reach the site as well.
 */
function dnsInstructionsFor(domain: string, token: string | null, hostedSlug: string | null) {
  const target = HOST_DOMAIN && hostedSlug ? `${hostedSlug}.${HOST_DOMAIN}` : null;
  const apex = isApexDomain(domain);
  return {
    txt: { name: `${DOMAIN_TXT_PREFIX}.${domain}`, value: token },
    cname: target ? { name: domain, value: target } : null,
    apex,
    www: apex && target ? { name: `www.${domain}`, value: target } : null,
    guidance: apex
      ? `${domain} is the root of your domain, and DNS does not allow a plain CNAME record there. If your DNS provider offers ALIAS, ANAME or CNAME flattening, create the root record as one of those. If it does not, connect www.${domain} here instead and set your registrar to forward ${domain} to it. Either way, add the www record as well, so both addresses reach your website.`
      : null,
  };
}

/**
 * Checks the TXT record, and only then starts answering for the domain.
 *
 * DNS is the proof because it is the one thing only the domain's owner can
 * change. Until it is there, the domain is stored and inert.
 *
 * Verifying is also what settles who holds a domain. Claiming one proves
 * nothing, so any number of websites may claim it; the first to prove it wins
 * it, and the claims left waiting on the same name are cleared in the same
 * transaction. The partial unique index on verified domains is what stops two
 * proofs racing each other to both win.
 */
export async function verifyCustomDomain(
  siteId: string,
  resolveTxt: (name: string) => Promise<string[][]> = (name) => dns.resolveTxt(name),
): Promise<{ verified: boolean; found: string[]; expected: string }> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { customDomain: true, customDomainToken: true },
  });
  if (!site?.customDomain || !site.customDomainToken) {
    throw new WebsiteError(400, "Add the domain first, then verify it.");
  }
  const domain = site.customDomain;
  const token = site.customDomainToken;
  const name = `${DOMAIN_TXT_PREFIX}.${domain}`;
  let found: string[] = [];
  try {
    const records = await resolveTxt(name);
    found = records.map((parts) => parts.join(""));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      throw new WebsiteError(
        400,
        `No TXT record found at ${name}. Add it at your domain provider, then try again — DNS changes can take up to an hour to appear.`,
      );
    }
    throw new WebsiteError(502, `Could not read DNS for ${name}: ${(error as Error).message}`);
  }
  const verified = found.includes(token);
  if (verified) {
    const taken = new WebsiteError(409, "That domain was verified by another website here a moment ago.");
    try {
      await prisma.$transaction(async (tx) => {
        // One proof per domain at a time. Without it two proofs landing together
        // deadlock — each holds its own row and waits on the other's, one to
        // claim the domain and one to clear the other's claim — and the loser is
        // handed a database error rather than told the domain is taken.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`custom-domain:${domain}`}))`;
        const holder = await tx.site.findFirst({
          where: { customDomain: domain, customDomainVerifiedAt: { not: null }, NOT: { id: siteId } },
          select: { id: true },
        });
        if (holder) throw taken;
        // Conditional on the domain and token read above: the DNS lookup takes
        // seconds, and a domain changed in the meantime must not be verified on
        // the strength of the old one's record.
        const marked = await tx.site.updateMany({
          where: { id: siteId, customDomain: domain, customDomainToken: token },
          data: { customDomainVerifiedAt: new Date(), hostedEnabled: true },
        });
        if (marked.count === 0) throw new WebsiteError(409, "The domain on this website changed while it was being checked. Try again.");
        await tx.site.updateMany({
          where: { customDomain: domain, customDomainVerifiedAt: null, NOT: { id: siteId } },
          data: { customDomain: null, customDomainToken: null },
        });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") throw taken;
      throw error;
    }
  }
  return { verified, found, expected: token };
}

const domainInput = z.object({ domain: z.string().trim().min(4).max(253).nullable() });

export function registerWebsiteHosting(router: Router) {
  const handler =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  /** What a customer needs to point a domain here, and where their site is now. */
  router.get(
    "/sites/:id/hosting",
    handler(async (req, res) => {
      await assertWebsiteSiteAccess(req, req.params.id!, "view");
      const site = await prisma.site.findUnique({
        where: { id: req.params.id! },
        select: {
          slug: true,
          hostedEnabled: true,
          hostedSlug: true,
          customDomain: true,
          customDomainToken: true,
          customDomainVerifiedAt: true,
          repoName: true,
        },
      });
      if (!site) throw new WebsiteError(404, "No such website.");
      // Counted, not loaded: this used to read the full HTML of up to 200 pages
      // to answer with one number.
      const publishedPages = await prisma.sitePage.count({ where: { siteId: req.params.id!, publishedHtml: { not: null } } });
      res.json({
        hostedEnabled: site.hostedEnabled,
        hostedSlug: site.hostedSlug ?? site.slug,
        hostDomain: HOST_DOMAIN || null,
        hostedUrl: hostedUrlFor(site),
        publishesToRepository: Boolean(site.repoName),
        publishedPages,
        customDomain: site.customDomain,
        customDomainVerifiedAt: site.customDomainVerifiedAt,
        dnsInstructions: site.customDomain ? dnsInstructionsFor(site.customDomain, site.customDomainToken, site.hostedSlug) : null,
      });
    }),
  );

  /**
   * Claims a domain. It is stored and inert until the TXT record proves it.
   *
   * Refused only when another website has already *verified* the domain. The
   * column used to be unique among claims, so anybody could type a business's
   * domain into a form here and keep its real owner out for good, with nothing
   * proved at all.
   */
  router.put(
    "/sites/:id/hosting/domain",
    handler(async (req, res) => {
      await assertWebsiteSiteAccess(req, req.params.id!, "manage");
      const { domain } = domainInput.parse(req.body ?? {});
      if (domain === null) {
        const cleared = await prisma.site.update({
          where: { id: req.params.id! },
          data: { customDomain: null, customDomainToken: null, customDomainVerifiedAt: null },
          select: { customDomain: true },
        });
        res.json({ ok: true, customDomain: cleared.customDomain });
        return;
      }
      const normalized = normalizeDomain(domain);
      const taken = await prisma.site.findFirst({
        where: { customDomain: normalized, customDomainVerifiedAt: { not: null }, NOT: { id: req.params.id! } },
        select: { id: true },
      });
      if (taken) throw new WebsiteError(409, "That domain is already connected to another website here.");
      const token = `dakyworld-site-verification=${crypto.randomBytes(16).toString("hex")}`;
      const site = await prisma.site.update({
        where: { id: req.params.id! },
        data: { customDomain: normalized, customDomainToken: token, customDomainVerifiedAt: null },
        select: { customDomain: true, hostedSlug: true },
      });
      res.json({
        ok: true,
        customDomain: site.customDomain,
        verified: false,
        dnsInstructions: dnsInstructionsFor(normalized, token, site.hostedSlug),
      });
    }),
  );

  router.post(
    "/sites/:id/hosting/verify",
    handler(async (req, res) => {
      await assertWebsiteSiteAccess(req, req.params.id!, "manage");
      const result = await verifyCustomDomain(req.params.id!);
      res.json(result);
    }),
  );
}

/**
 * Gives a site somewhere to be, the first time anything is published to it.
 *
 * A site with a repository keeps publishing there and gets a hosted address as
 * well, which costs nothing and is useful for staging. A site without one has
 * this as its only address.
 */
export async function ensureHostedAddress(siteId: string, db: import("@prisma/client").Prisma.TransactionClient = prisma): Promise<void> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { slug: true, hostedSlug: true, repoName: true } });
  if (!site || site.hostedSlug) return;
  // The slug is the obvious label, but it has to be unique among hostnames as
  // well as among sites, and two sites can be renamed into a collision.
  let label = site.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "site";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clash = await db.site.findFirst({ where: { hostedSlug: label }, select: { id: true } });
    if (!clash) break;
    label = `${label.slice(0, 44)}-${crypto.randomBytes(2).toString("hex")}`;
  }
  await db.site.update({
    where: { id: siteId },
    data: { hostedSlug: label, hostedEnabled: !site.repoName ? true : undefined },
  });
}
