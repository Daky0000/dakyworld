import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { isR2Configured, getR2PublicUrl } from "../lib/r2.js";
import { SVG_CONTENT_SECURITY_POLICY } from "../lib/svgSanitize.js";
import { MOVED_ASSET_CACHE, publishedAssetCacheControl } from "../services/publishedAssets.js";
import { applyValues, editingSource, fieldValues } from "../services/website/index.js";
import type { FieldValue } from "../services/website/index.js";
import { attachUser } from "../middleware/auth.js";
import { sandboxedPageFiles } from "../middleware/security.js";
import { assertWebsiteSiteAccess } from "../services/websiteAccess.js";
import { compoundPagePart } from "../services/websiteSitePackage.js";

/**
 * Every page this router sends runs in an origin of its own.
 *
 * These addresses are on os., editor. and app.dakyx.com — the hosts of the
 * signed-in app — and the HTML is a customer's: an imported file or package,
 * scripts included. Served plainly, that script runs **as whoever opens the
 * link**: a same-origin `fetch` to `/api` carries their session, and the
 * guard against foreign writes passes it because the origin is ours. One
 * customer's page could read or change every record a member of staff can.
 *
 * `sandbox` without `allow-same-origin` makes the document opaque: it sends
 * no cookie, cannot reach the window that opened it, and its writes arrive
 * with `Origin: null`, which the write guard refuses. It is the rule
 * `routes/demos.ts` already follows for the same reason (`DEMO_SANDBOX`).
 * `allow-forms` is added here because this is a business's own website and
 * its contact form has to submit.
 *
 * Nothing else is restricted: an imported site loads its fonts, styles and
 * scripts from wherever it always did. The lasting answer is a hosting domain
 * that is not dakyx.com (see docs/claude/13); this is what makes the path
 * address safe to have until then.
 */
const SITE_SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

const PAGE_HEADERS = {
  "Content-Security-Policy": SITE_SANDBOX,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

/**
 * Whether this visitor may see the page's unpublished edits.
 *
 * A draft is work nobody has decided to show. It used to be laid over the page
 * for anyone who had the address, and a site's address is its name. Only a
 * signed-in person with access to this website sees it now; everyone else is
 * sent the page as it stands.
 */
async function maySeeDraft(req: Request, res: Response, siteId: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      void attachUser(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
    });
    if (!req.dbUser?.active) return false;
    await assertWebsiteSiteAccess(req, siteId, "view");
    return true;
  } catch {
    return false;
  }
}

function readSitePageDraft(draft: unknown): Record<string, FieldValue> {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return {};
  return draft as Record<string, FieldValue>;
}

/** Resolves a site from either its own slug/ID or a compound `<siteSlug>-<pageSlug>` segment. */
async function findSiteBySlugOrCompound(siteSlug: string): Promise<{ site: { id: string; name: string; slug: string }; remainder: string } | null> {
  const direct = await prisma.site.findFirst({
    where: {
      OR: [{ slug: siteSlug }, { id: siteSlug }],
      deletionScheduledFor: null,
    },
    select: { id: true, name: true, slug: true },
  });
  if (direct) return { site: direct, remainder: "" };

  if (!siteSlug.includes("-")) return null;

  const allSites = await prisma.site.findMany({
    where: { deletionScheduledFor: null },
    select: { id: true, name: true, slug: true },
  });
  const match = allSites
    .filter((s) => siteSlug.startsWith(`${s.slug}-`))
    .sort((a, b) => b.slug.length - a.slug.length)[0];

  if (!match) return null;
  const remainder = siteSlug.slice(match.slug.length + 1);
  return { site: match, remainder };
}

export const websitePagesRouter = Router();

// The files a sandboxed page loads from us. Its origin is opaque, so even a
// file from this same host is cross-origin to it and would be discarded after
// a full 200 without these headers — the fault the Ghacem demo had.
websitePagesRouter.use(["/:siteSlug/assets", "/:siteSlug/*/assets"], (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  sandboxedPageFiles(req, res, next);
});

/**
 * Serves website assets stored in Postgres (`SiteAsset.content`) or R2 when swept.
 * Route: /website/:siteSlug/assets/dw/:filename
 */
websitePagesRouter.get(["/:siteSlug/assets/dw/:filename", "/:siteSlug/*/assets/dw/:filename"], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { siteSlug, filename } = req.params;
    const repoPath = `assets/dw/${filename}`;

    const resolved = await findSiteBySlugOrCompound(siteSlug);
    if (!resolved) return res.status(404).set("Cache-Control", "no-store").end();

    const asset = await prisma.siteAsset.findFirst({
      where: { siteId: resolved.site.id, repoPath },
      select: { contentType: true, content: true },
    });

    if (!asset) {
      return res.status(404).set("Cache-Control", "no-store").end();
    }

    // Small assets (<8 MB) are stored in Postgres; larger ones or swept ones live in R2.
    if (!asset.content) {
      if (isR2Configured()) {
        return res.set("Cache-Control", MOVED_ASSET_CACHE).redirect(302, getR2PublicUrl(repoPath));
      }
      return res.status(404).set("Cache-Control", "no-store").end();
    }

    if (asset.contentType === "image/svg+xml") {
      res.set("Content-Security-Policy", SVG_CONTENT_SECURITY_POLICY);
    }

    res.status(200)
      .set("Content-Type", asset.contentType || "application/octet-stream")
      .set("Content-Length", String(asset.content.length))
      .set("X-Content-Type-Options", "nosniff")
      .set("Cache-Control", publishedAssetCacheControl(repoPath))
      .send(Buffer.from(asset.content));
  } catch (err) {
    next(err);
  }
});

const RESERVED_WEBSITE_PATHS = new Set([
  "",
  "sites",
  "pages",
  "assets",
  "compatibility",
  "survey",
  "onboarding",
  "ai",
  "updates",
  "team",
  "audit",
  "balance",
  "inbox",
  "analytics",
  "settings",
  "source",
  "billing",
  "account",
  "welcome",
  "github",
]);

/**
 * Serves any subpage or the home page of a website by its slug.
 * Supports:
 * - /website/:siteSlug (e.g. /website/gulf-contracting)
 * - /website/:siteSlug/:pageName (e.g. /website/gulf-contracting/about-us)
 * - /website/:compoundSlug (e.g. /website/gulf-contracting-home, /website/gulf-contracting-about-us)
 */
websitePagesRouter.get(["/:siteSlug", "/:siteSlug/*"], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteSlug = req.params.siteSlug;
    if (!siteSlug || RESERVED_WEBSITE_PATHS.has(siteSlug.toLowerCase())) return next();

    const resolved = await findSiteBySlugOrCompound(siteSlug);
    if (!resolved) {
      return res.status(404).type("html").set(PAGE_HEADERS).set("Cache-Control", "no-store").send(site404Page());
    }

    const { site, remainder } = resolved;
    const rawSubpath = remainder ? (remainder === "home" ? "" : remainder) : (req.params[0] ?? "");
    const cleanSub = rawSubpath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    const lowerSub = cleanSub.toLowerCase();

    let page = null;

    if (!cleanSub || lowerSub === "home") {
      page = await prisma.sitePage.findFirst({
        where: {
          siteId: site.id,
          OR: [
            { path: { in: ["/", "", "/home", "/home/"] } },
            { filePath: { in: ["index.html", "index.htm", "home.html"] } },
          ],
        },
      });
      if (!page) {
        page = await prisma.sitePage.findFirst({
          where: {
            siteId: site.id,
            path: { notIn: ["/404", "/404/"] },
            filePath: { notIn: ["404.html", "404/index.html"] },
          },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        });
      }
    } else {
      const strippedHtml = cleanSub.replace(/\.html?$/i, "");
      const exactPaths = [
        `/${cleanSub}`,
        `/${cleanSub}/`,
        `/${strippedHtml}`,
        `/${strippedHtml}/`,
      ];
      const exactFiles = [
        cleanSub,
        `${cleanSub}.html`,
        `${cleanSub}/index.html`,
        `${strippedHtml}.html`,
        `${strippedHtml}/index.html`,
      ];

      // 1. Exact route or file path match
      page = await prisma.sitePage.findFirst({
        where: {
          siteId: site.id,
          OR: [
            { path: { in: exactPaths } },
            { filePath: { in: exactFiles } },
          ],
        },
      });

      // 2. Exact compound slug match (e.g. `projects-doha-festival-city` -> `/projects/doha-festival-city`)
      if (!page) {
        const sitePages = await prisma.sitePage.findMany({
          where: { siteId: site.id },
          select: { id: true, path: true, filePath: true },
        });
        const matchedMeta = sitePages.find((p) =>
          compoundPagePart(p.path) === lowerSub ||
          compoundPagePart(p.filePath.replace(/\.html?$/i, "").replace(/\/index$/i, "")) === lowerSub,
        );
        if (matchedMeta) {
          page = await prisma.sitePage.findUnique({ where: { id: matchedMeta.id } });
        }
      }

      // 3. Fallback: search by path, filePath, or title
      if (!page) {
        page = await prisma.sitePage.findFirst({
          where: {
            siteId: site.id,
            OR: [
              { path: { contains: cleanSub, mode: "insensitive" } },
              { filePath: { contains: cleanSub, mode: "insensitive" } },
              { title: { contains: cleanSub, mode: "insensitive" } },
            ],
          },
        });
      }
    }

    if (!page) {
      // Check if site has a custom 404 page
      const notFoundPage = await prisma.sitePage.findFirst({
        where: {
          siteId: site.id,
          OR: [
            { path: { in: ["/404", "/404/"] } },
            { filePath: { in: ["404.html", "404/index.html"] } },
          ],
        },
      });

      if (notFoundPage?.publishedHtml || notFoundPage?.sourceHtml) {
        const notFoundHtml = notFoundPage.publishedHtml || notFoundPage.sourceHtml || "";
        return res
          .status(404)
          .type("html")
          .set({ ...PAGE_HEADERS, "Cache-Control": "no-store" })
          .send(notFoundHtml);
      }

      return res.status(404).type("html").set(PAGE_HEADERS).set("Cache-Control", "no-store").send(website404Page(escapeHtml(site.name), encodeURIComponent(site.slug)));
    }

    let renderedHtml = page.publishedHtml || page.sourceHtml || "";

    // Unpublished edits are laid over the page only for somebody signed in
    // with access to this website. Asked only when there is a draft to show,
    // so an ordinary visit costs no session lookup.
    const draft = page.draft ? readSitePageDraft(page.draft) : {};
    const hasDraft = Object.keys(draft).length > 0;
    const member = hasDraft ? await maySeeDraft(req, res, site.id) : false;

    if (hasDraft && member) {
      try {
        renderedHtml = applyValues(editingSource(renderedHtml, draft), fieldValues(draft)).html;
      } catch {
        // Fall back to the page as it stands if the draft cannot be applied
      }
    }

    res
      .status(200)
      .type("html")
      .set({
        ...PAGE_HEADERS,
        // What a member sees is theirs alone: never kept by anything shared.
        "Cache-Control": member ? "private, no-store" : "public, max-age=60",
        ...(member ? { Vary: "Cookie" } : {}),
      })
      .send(renderedHtml);
  } catch (err) {
    next(err);
  }
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function website404Page(siteName: string, siteSlug: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page Not Found · ${siteName}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1329; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; padding: 2rem; }
    .card { max-width: 28rem; text-align: center; background: #131f38; border: 1px solid #1e293b; border-radius: 1rem; padding: 2.5rem; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    .code { font-size: 3rem; font-weight: 800; color: #38bdf8; margin: 0 0 0.5rem; line-height: 1; }
    h1 { font-size: 1.25rem; margin: 0 0 0.75rem; color: #ffffff; }
    p { margin: 0 0 1.5rem; color: #94a3b8; font-size: 0.9rem; line-height: 1.5; }
    a { display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 0.65rem 1.25rem; border-radius: 0.5rem; font-size: 0.875rem; font-weight: 600; transition: background 0.15s; }
    a:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="code">404</div>
    <h1>Page Not Found</h1>
    <p>The page you are looking for does not exist on ${siteName}.</p>
    <a href="/website/${siteSlug}">Return to Home</a>
  </div>
</body>
</html>`;
}

function site404Page(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Website Not Found</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1329; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; padding: 2rem; }
    .card { max-width: 28rem; text-align: center; background: #131f38; border: 1px solid #1e293b; border-radius: 1rem; padding: 2.5rem; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    .code { font-size: 3rem; font-weight: 800; color: #38bdf8; margin: 0 0 0.5rem; line-height: 1; }
    h1 { font-size: 1.25rem; margin: 0 0 0.75rem; color: #ffffff; }
    p { margin: 0 0 1.5rem; color: #94a3b8; font-size: 0.9rem; line-height: 1.5; }
    a { display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 0.65rem 1.25rem; border-radius: 0.5rem; font-size: 0.875rem; font-weight: 600; transition: background 0.15s; }
    a:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="code">404</div>
    <h1>Website Not Found</h1>
    <p>This website could not be found or has not been published yet.</p>
    <a href="/">Go to Dakyworld</a>
  </div>
</body>
</html>`;
}
