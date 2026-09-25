import crypto from "node:crypto";
import dns from "node:dns/promises";
import type { Express, Request, Response, NextFunction, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { WebsiteError } from "./website/site.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";
import { assetUrl } from "./websiteAssets.js";

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
async function siteForHost(host: string) {
  if (!host) return null;
  const byDomain = await prisma.site.findFirst({
    where: { customDomain: host, customDomainVerifiedAt: { not: null }, hostedEnabled: true },
    select: { id: true, name: true, publicUrl: true },
  });
  if (byDomain) return byDomain;

  if (HOST_DOMAIN && host.endsWith(`.${HOST_DOMAIN}`)) {
    const label = host.slice(0, -(HOST_DOMAIN.length + 1));
    if (!label || label.includes(".")) return null;
    return prisma.site.findFirst({ where: { hostedSlug: label, hostedEnabled: true }, select: { id: true, name: true, publicUrl: true } });
  }
  return null;
}

function etagFor(html: string): string {
  return `W/"${crypto.createHash("sha1").update(html).digest("base64url")}"`;
}

const NOT_FOUND_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#1b2029}main{text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#5b6572;margin:0}</style></head><body><main><h1>Page not found</h1><p>This address is not part of this website.</p></main></body></html>`;

const NOT_PUBLISHED_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not published yet</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#1b2029}main{text-align:center;padding:24px;max-width:32rem}h1{font-size:20px;margin:0 0 8px}p{color:#5b6572;margin:0;line-height:1.6}</style></head><body><main><h1>This website has not been published yet</h1><p>The address is reserved and working. As soon as its first page is published in the editor, it will appear here.</p></main></body></html>`;

/**
 * Serves published pages for a hosted site, by hostname.
 *
 * Mounted ahead of the OS's own client and API. It only ever answers for a
 * hostname that belongs to a hosted site, so `os.dakyworld.com` falls straight
 * through to the app.
 */
export function publicSiteHosting() {
  return async function hostingMiddleware(req: Request, res: Response, next: NextFunction) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const host = hostOf(req);
    if (!host) return next();

    let site: { id: string; name: string; publicUrl: string } | null = null;
    try {
      site = await siteForHost(host);
    } catch {
      return next();
    }
    if (!site) return next();

    const path = (req.path || "/").replace(/\/+$/, "") || "/";
    try {
      const assetPath = /(?:^|\/)(assets\/dw\/[^/]+)$/.exec(path)?.[1];
      if (assetPath) {
        const asset = await prisma.siteAsset.findUnique({
          where: { siteId_repoPath: { siteId: site.id, repoPath: assetPath } },
          select: { content: true, contentType: true, repoPath: true },
        });
        if (!asset?.content || path !== assetUrl(site, asset.repoPath)) return res.status(404).end();
        const published = await prisma.sitePage.findFirst({
          where: { siteId: site.id, status: "LIVE", publishedHtml: { contains: assetUrl(site, asset.repoPath) } },
          select: { id: true },
        });
        if (!published) return res.status(404).end();
        const bytes = Buffer.from(asset.content);
        const etag = `W/"${crypto.createHash("sha1").update(bytes).digest("base64url")}"`;
        if (req.headers["if-none-match"] === etag) return res.status(304).end();
        return res.status(200)
          .set("Content-Type", asset.contentType)
          .set("X-Content-Type-Options", "nosniff")
          .set("Cache-Control", "public, max-age=60, must-revalidate")
          .set("ETag", etag)
          .send(bytes);
      }
      const page =
        (await prisma.sitePage.findFirst({
          where: { siteId: site.id, path, status: "LIVE" },
          select: { publishedHtml: true },
        })) ??
        // `/about.html` and `/about` are the same page to somebody typing it.
        (await prisma.sitePage.findFirst({
          where: { siteId: site.id, filePath: path.replace(/^\//, ""), status: "LIVE" },
          select: { publishedHtml: true },
        }));

      if (!page) {
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

      const etag = etagFor(page.publishedHtml);
      if (req.headers["if-none-match"] === etag) return res.status(304).end();
      return res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("ETag", etag)
        // Short, because a customer who presses Publish expects to see it. The
        // ETag is what saves the bandwidth on a reload.
        .set("Cache-Control", "public, max-age=60, must-revalidate")
        .set("X-Content-Type-Options", "nosniff")
        .send(page.publishedHtml);
    } catch (error) {
      console.error(`[hosting] ${host}${req.path} failed:`, (error as Error).message);
      return next();
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
 * Checks the TXT record, and only then starts answering for the domain.
 *
 * DNS is the proof because it is the one thing only the domain's owner can
 * change. Until it is there, the domain is stored and inert.
 */
export async function verifyCustomDomain(siteId: string): Promise<{ verified: boolean; found: string[]; expected: string }> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { customDomain: true, customDomainToken: true },
  });
  if (!site?.customDomain || !site.customDomainToken) {
    throw new WebsiteError(400, "Add the domain first, then verify it.");
  }
  const name = `${DOMAIN_TXT_PREFIX}.${site.customDomain}`;
  let found: string[] = [];
  try {
    const records = await dns.resolveTxt(name);
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
  const verified = found.includes(site.customDomainToken);
  if (verified) {
    await prisma.site.update({
      where: { id: siteId },
      data: { customDomainVerifiedAt: new Date(), hostedEnabled: true },
    });
  }
  return { verified, found, expected: site.customDomainToken };
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
          pages: { select: { publishedHtml: true }, take: 200 },
        },
      });
      if (!site) throw new WebsiteError(404, "No such website.");
      res.json({
        hostedEnabled: site.hostedEnabled,
        hostedSlug: site.hostedSlug ?? site.slug,
        hostDomain: HOST_DOMAIN || null,
        hostedUrl: hostedUrlFor(site),
        publishesToRepository: Boolean(site.repoName),
        publishedPages: site.pages.filter((page) => page.publishedHtml).length,
        customDomain: site.customDomain,
        customDomainVerifiedAt: site.customDomainVerifiedAt,
        dnsInstructions: site.customDomain
          ? {
              txt: { name: `${DOMAIN_TXT_PREFIX}.${site.customDomain}`, value: site.customDomainToken },
              cname: HOST_DOMAIN && site.hostedSlug ? { name: site.customDomain, value: `${site.hostedSlug}.${HOST_DOMAIN}` } : null,
            }
          : null,
      });
    }),
  );

  /** Claims a domain. It is stored and inert until the TXT record proves it. */
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
      const taken = await prisma.site.findFirst({ where: { customDomain: normalized, NOT: { id: req.params.id! } }, select: { id: true } });
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
        dnsInstructions: {
          txt: { name: `${DOMAIN_TXT_PREFIX}.${normalized}`, value: token },
          cname: HOST_DOMAIN && site.hostedSlug ? { name: normalized, value: `${site.hostedSlug}.${HOST_DOMAIN}` } : null,
        },
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
export async function ensureHostedAddress(siteId: string): Promise<void> {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { slug: true, hostedSlug: true, repoName: true } });
  if (!site || site.hostedSlug) return;
  // The slug is the obvious label, but it has to be unique among hostnames as
  // well as among sites, and two sites can be renamed into a collision.
  let label = site.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "site";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clash = await prisma.site.findFirst({ where: { hostedSlug: label }, select: { id: true } });
    if (!clash) break;
    label = `${label.slice(0, 44)}-${crypto.randomBytes(2).toString("hex")}`;
  }
  await prisma.site.update({
    where: { id: siteId },
    data: { hostedSlug: label, hostedEnabled: !site.repoName ? true : undefined },
  });
}
