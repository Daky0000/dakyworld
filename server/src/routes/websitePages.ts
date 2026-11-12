import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { isR2Configured, getR2PublicUrl } from "../lib/r2.js";
import { applyValues, editingSource, fieldValues } from "../services/website/index.js";
import type { FieldValue } from "../services/website/index.js";

function readSitePageDraft(draft: unknown): Record<string, FieldValue> {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return {};
  return draft as Record<string, FieldValue>;
}

export const websitePagesRouter = Router();

/**
 * Serves website assets stored in R2 or database (SiteAsset).
 * Route: /website/:siteSlug/assets/dw/:filename
 */
websitePagesRouter.get("/:siteSlug/assets/dw/:filename", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { siteSlug, filename } = req.params;
    const repoPath = `assets/dw/${filename}`;

    if (isR2Configured()) {
      return res.redirect(302, getR2PublicUrl(repoPath));
    }

    let site = await prisma.site.findFirst({
      where: {
        OR: [{ slug: siteSlug }, { id: siteSlug }],
      },
      select: { id: true, slug: true },
    });

    if (!site && siteSlug.includes("-")) {
      const allSites = await prisma.site.findMany({ select: { id: true, slug: true } });
      const match = allSites.filter((s) => siteSlug === s.slug || siteSlug.startsWith(`${s.slug}-`)).sort((a, b) => b.slug.length - a.slug.length)[0];
      if (match) site = match;
    }

    if (!site) return res.status(404).set("Cache-Control", "no-store").end();

    const asset = await prisma.siteAsset.findFirst({
      where: { siteId: site.id, repoPath },
      select: { contentType: true, content: true },
    });

    if (!asset || !asset.content) {
      return res.status(404).set("Cache-Control", "no-store").end();
    }

    res.status(200)
      .set("Content-Type", asset.contentType)
      .set("X-Content-Type-Options", "nosniff")
      .set("Cache-Control", "public, max-age=86400")
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

    // 1. Find the website
    let site = await prisma.site.findFirst({
      where: {
        OR: [{ slug: siteSlug }, { id: siteSlug }],
        deletionScheduledFor: null,
      },
      select: { id: true, name: true, slug: true },
    });

    let rawSubpath = req.params[0] ?? "";

    // 2. If site was not directly matched, check if siteSlug is a compound slug (e.g. "gulf-contracting-home", "gulf-contracting-about-us")
    if (!site && siteSlug.includes("-")) {
      const allSites = await prisma.site.findMany({
        where: { deletionScheduledFor: null },
        select: { id: true, name: true, slug: true },
      });
      const match = allSites
        .filter((s) => siteSlug === s.slug || siteSlug.startsWith(`${s.slug}-`))
        .sort((a, b) => b.slug.length - a.slug.length)[0];

      if (match) {
        site = match;
        const remainder = siteSlug.slice(match.slug.length + 1); // e.g. "about-us" or "home"
        rawSubpath = remainder === "home" ? "" : remainder;
      }
    }

    if (!site) {
      return res.status(404).type("html").send(site404Page());
    }

    const cleanSub = rawSubpath.trim().replace(/^\/+/, "").replace(/\/+$/, "");

    // Generate candidate routes and file paths to match SitePage
    const candidates: string[] = [];
    const fileCandidates: string[] = [];

    if (!cleanSub || cleanSub === "home") {
      candidates.push("/", "", "/home", "/home/");
      fileCandidates.push("index.html", "index.htm", "home.html");
    } else {
      candidates.push(
        `/${cleanSub}`,
        `/${cleanSub}/`,
        `/${cleanSub.replace(/\.html?$/i, "")}`,
        `/${cleanSub.replace(/\.html?$/i, "")}/`,
      );
      if (cleanSub.includes("-")) {
        candidates.push(`/${cleanSub.replace(/-/g, "")}`, `/${cleanSub.split("-")[0]}`);
      }
      fileCandidates.push(
        cleanSub,
        `${cleanSub}.html`,
        `${cleanSub}/index.html`,
        `${cleanSub.replace(/\.html?$/i, "")}.html`,
        `${cleanSub.replace(/\.html?$/i, "")}/index.html`,
      );
      if (cleanSub.includes("-")) {
        fileCandidates.push(`${cleanSub.replace(/-/g, "")}.html`, `${cleanSub.split("-")[0]}.html`);
      }
    }

    // Query matching page for this site
    let page = await prisma.sitePage.findFirst({
      where: {
        siteId: site.id,
        OR: [
          { path: { in: candidates } },
          { filePath: { in: fileCandidates } },
        ],
      },
    });

    // Fallback if home page requested but not matched by exact path
    if (!page && (!cleanSub || cleanSub === "home")) {
      page = await prisma.sitePage.findFirst({
        where: { siteId: site.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
    }

    // Fallback: search by path or title containing cleanSub
    if (!page && cleanSub) {
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
          .set({
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "X-Robots-Tag": "noindex, nofollow",
            "Cache-Control": "no-store",
          })
          .send(notFoundHtml);
      }

      return res.status(404).type("html").send(website404Page(site.name, site.slug));
    }

    let renderedHtml = page.publishedHtml || page.sourceHtml || "";

    // If draft exists with live edits, apply draft values so previewing shows active changes
    if (page.draft) {
      try {
        const draft = readSitePageDraft(page.draft);
        if (draft && Object.keys(draft).length > 0) {
          renderedHtml = applyValues(editingSource(renderedHtml, draft), fieldValues(draft)).html;
        }
      } catch {
        // Fall back to sourceHtml if draft parse fails
      }
    }

    res
      .status(200)
      .type("html")
      .set({
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "public, max-age=60",
      })
      .send(renderedHtml);
  } catch (err) {
    next(err);
  }
});

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
