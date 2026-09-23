import { randomUUID } from "node:crypto";
import tls from "node:tls";
import type { Request, Response, Router } from "express";
import { Prisma, type Site, type SitePage } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { commitFiles, readRepoMetadata, updateRepoMetadata, type RepoMetadata } from "../lib/github.js";
import { discoverFields, editingSource, restoreDocument, type FieldValue } from "./website/index.js";
import {
  pageSource,
  publishPages,
  repoFilePath,
  siteRepo,
  underSiteCredential,
  WebsiteError,
} from "./website/site.js";
import { invalidateSource } from "./website/sourceCache.js";

export interface PageSeoData {
  title: string;
  description: string;
  keywords: string;
  tags: string[];
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  twitterCard: string;
  canonical: string;
  robots: string;
  hasGeneratedSeoBlock: boolean;
}

export const pageSeoPatchSchema = z.object({
  pageId: z.string().min(1).max(120),
  title: z.string().max(300).optional(),
  description: z.string().max(600).optional(),
  keywords: z.string().max(800).optional(),
  tags: z.array(z.string().max(80)).max(30).optional(),
  ogTitle: z.string().max(300).optional(),
  ogDescription: z.string().max(600).optional(),
  ogImage: z.string().max(1_000).optional(),
  twitterCard: z.enum(["summary", "summary_large_image"]).optional(),
  canonical: z.string().max(1_000).optional(),
  robots: z.string().max(120).optional(),
  publishNow: z.boolean().optional().default(false),
});

export type PageSeoPatch = z.infer<typeof pageSeoPatchSchema>;

export const repoSeoPatchSchema = z.object({
  description: z.string().max(350).optional(),
  homepage: z.string().max(255).optional(),
  topics: z.array(z.string().max(60)).max(20).optional(),
});

function decodeBasicEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .trim();
}

function escapeAttr(val: string): string {
  return val
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeText(val: string): string {
  return val
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readMetaTag(html: string, attrName: "name" | "property", attrVal: string): string {
  const regex = new RegExp(`<meta\\b[^>]*\\b${attrName}\\s*=\\s*["']${attrVal}["'][^>]*>`, "i");
  const match = regex.exec(html);
  if (!match) return "";
  const contentMatch = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[0]);
  return decodeBasicEntities(contentMatch?.[1] ?? contentMatch?.[2] ?? "");
}

function readCanonicalLink(html: string): string {
  const match = /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i.exec(html);
  if (!match) return "";
  const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[0]);
  return decodeBasicEntities(hrefMatch?.[1] ?? hrefMatch?.[2] ?? "");
}

export function extractPageSeo(html: string): PageSeoData {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = decodeBasicEntities(titleMatch?.[1] ?? "");
  const description = readMetaTag(html, "name", "description");
  const keywords = readMetaTag(html, "name", "keywords");
  const tags = keywords
    ? keywords
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const ogTitle = readMetaTag(html, "property", "og:title") || title;
  const ogDescription = readMetaTag(html, "property", "og:description") || description;
  const ogImage = readMetaTag(html, "property", "og:image") || readMetaTag(html, "name", "twitter:image");
  const twitterCard = readMetaTag(html, "name", "twitter:card") || "summary_large_image";
  const canonical = readCanonicalLink(html);
  const robots = readMetaTag(html, "name", "robots") || "index, follow";
  const hasGeneratedSeoBlock = /<!--\s*BEGIN\s+SEO\b/i.test(html);

  return {
    title,
    description,
    keywords,
    tags,
    ogTitle,
    ogDescription,
    ogImage,
    twitterCard,
    canonical,
    robots,
    hasGeneratedSeoBlock,
  };
}

function upsertMetaTagInHtml(
  html: string,
  attrName: "name" | "property",
  attrVal: string,
  contentVal: string,
): string {
  const escaped = escapeAttr(contentVal);
  const regex = new RegExp(`<meta\\b[^>]*\\b${attrName}\\s*=\\s*["']${attrVal}["'][^>]*>`, "gi");
  if (regex.test(html)) {
    return html.replace(regex, (fullTag) => {
      if (/\bcontent\s*=\s*"[^"]*"/i.test(fullTag)) {
        return fullTag.replace(/\bcontent\s*=\s*"[^"]*"/i, `content="${escaped}"`);
      }
      if (/\bcontent\s*=\s*'[^']*'/i.test(fullTag)) {
        return fullTag.replace(/\bcontent\s*=\s*'[^']*'/i, `content='${escaped}'`);
      }
      return fullTag.replace(/\/?>$/, ` content="${escaped}">`);
    });
  }
  const newTag = `  <meta ${attrName}="${attrVal}" content="${escaped}">\n`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, (m) => `${newTag}${m}`);
  }
  return `${newTag}${html}`;
}

function upsertCanonicalInHtml(html: string, canonicalUrl: string): string {
  const escaped = escapeAttr(canonicalUrl);
  const regex = /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/gi;
  if (regex.test(html)) {
    return html.replace(regex, (fullTag) => {
      if (/\bhref\s*=\s*"[^"]*"/i.test(fullTag)) {
        return fullTag.replace(/\bhref\s*=\s*"[^"]*"/i, `href="${escaped}"`);
      }
      return fullTag;
    });
  }
  const newLink = `  <link rel="canonical" href="${escaped}">\n`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, (m) => `${newLink}${m}`);
  }
  return html;
}

export function applyPageSeoToHtml(html: string, patch: Omit<PageSeoPatch, "pageId" | "publishNow">): string {
  let updated = html;

  if (patch.title !== undefined) {
    const cleanTitle = patch.title.trim();
    if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(updated)) {
      updated = updated.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeText(cleanTitle)}</title>`);
    } else if (/<\/head>/i.test(updated)) {
      updated = updated.replace(/<\/head>/i, (m) => `  <title>${escapeText(cleanTitle)}</title>\n${m}`);
    }
    const effectiveOgTitle = (patch.ogTitle ?? cleanTitle).trim();
    if (effectiveOgTitle) {
      updated = upsertMetaTagInHtml(updated, "property", "og:title", effectiveOgTitle);
      updated = upsertMetaTagInHtml(updated, "name", "twitter:title", effectiveOgTitle);
    }
  } else if (patch.ogTitle !== undefined) {
    updated = upsertMetaTagInHtml(updated, "property", "og:title", patch.ogTitle.trim());
    updated = upsertMetaTagInHtml(updated, "name", "twitter:title", patch.ogTitle.trim());
  }

  if (patch.description !== undefined) {
    const cleanDesc = patch.description.trim();
    updated = upsertMetaTagInHtml(updated, "name", "description", cleanDesc);
    const effectiveOgDesc = (patch.ogDescription ?? cleanDesc).trim();
    if (effectiveOgDesc) {
      updated = upsertMetaTagInHtml(updated, "property", "og:description", effectiveOgDesc);
      updated = upsertMetaTagInHtml(updated, "name", "twitter:description", effectiveOgDesc);
    }
  } else if (patch.ogDescription !== undefined) {
    updated = upsertMetaTagInHtml(updated, "property", "og:description", patch.ogDescription.trim());
    updated = upsertMetaTagInHtml(updated, "name", "twitter:description", patch.ogDescription.trim());
  }

  const effectiveKeywords =
    patch.tags !== undefined
      ? patch.tags.map((t) => t.trim()).filter(Boolean).join(", ")
      : patch.keywords !== undefined
        ? patch.keywords.trim()
        : undefined;

  if (effectiveKeywords !== undefined) {
    updated = upsertMetaTagInHtml(updated, "name", "keywords", effectiveKeywords);
  }

  if (patch.ogImage !== undefined && patch.ogImage.trim()) {
    updated = upsertMetaTagInHtml(updated, "property", "og:image", patch.ogImage.trim());
    updated = upsertMetaTagInHtml(updated, "name", "twitter:image", patch.ogImage.trim());
  }

  if (patch.twitterCard !== undefined) {
    updated = upsertMetaTagInHtml(updated, "name", "twitter:card", patch.twitterCard);
  }

  if (patch.canonical !== undefined && patch.canonical.trim()) {
    updated = upsertCanonicalInHtml(updated, patch.canonical.trim());
  }

  if (patch.robots !== undefined && patch.robots.trim()) {
    updated = upsertMetaTagInHtml(updated, "name", "robots", patch.robots.trim());
  }

  return updated;
}

export function generateSmartPageSeo(site: Site, page: SitePage, html: string): PageSeoData {
  const current = extractPageSeo(html);
  const { fields } = discoverFields(html);
  const h1 = fields.find((f) => f.tag.toLowerCase() === "h1")?.value?.trim() ?? "";
  const h2s = fields
    .filter((f) => f.tag.toLowerCase() === "h2")
    .map((f) => f.value?.trim() ?? "")
    .filter(Boolean);
  const paragraphs = fields
    .filter((f) => f.tag.toLowerCase() === "p" && (f.value?.trim().length ?? 0) >= 40)
    .map((f) => f.value?.trim() ?? "");

  const rawTitle = h1 || page.title || site.name;
  const generatedTitle = rawTitle.toLowerCase().includes(site.name.toLowerCase())
    ? rawTitle.slice(0, 60)
    : `${rawTitle} | ${site.name}`.slice(0, 65);

  const generatedDesc = (paragraphs[0] || current.description || `${rawTitle} — ${h2s.slice(0, 2).join(". ")}`).slice(0, 158);

  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "your", "you", "are", "our", "have", "will",
    "into", "more", "what", "when", "where", "which", "their", "about", "they", "them", "been", "were",
  ]);
  const wordCounts = new Map<string, number>();
  const textPool = `${site.name} ${page.title} ${h1} ${h2s.join(" ")} ${paragraphs.slice(0, 2).join(" ")}`;
  for (const rawWord of textPool.toLowerCase().match(/[a-z0-9]{4,20}/g) ?? []) {
    if (stopWords.has(rawWord)) continue;
    wordCounts.set(rawWord, (wordCounts.get(rawWord) ?? 0) + 1);
  }
  const topWords = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);

  const baseUrl = (site.publicUrl ?? "").replace(/\/+$/, "");
  const cleanPath = page.path.startsWith("/") ? page.path : `/${page.path}`;
  const canonicalUrl = current.canonical || (baseUrl ? `${baseUrl}${cleanPath === "/index.html" ? "/" : cleanPath}` : "");

  return {
    ...current,
    title: generatedTitle,
    description: generatedDesc,
    keywords: topWords.join(", "),
    tags: topWords,
    ogTitle: generatedTitle,
    ogDescription: generatedDesc,
    canonical: canonicalUrl,
  };
}

export function registerWebsiteSeoRoutes(
  router: Router,
  access: {
    loadSite: (req: Request, siteId: string) => Promise<Site>;
    loadPage: (req: Request, pageId: string) => Promise<{ page: SitePage; site: Site }>;
  },
) {
  // 1. Get full SEO overview for all pages + GitHub repository metadata (description, homepage, topics/tags)
  router.get("/sites/:siteId/seo", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const pages = await prisma.sitePage.findMany({
        where: { siteId: site.id },
        orderBy: [{ sortOrder: "asc" }, { path: "asc" }],
      });

      const repo = siteRepo(site);
      let repoMetadata: RepoMetadata | null = null;
      if (repo) {
        repoMetadata = await underSiteCredential(site, () => readRepoMetadata(repo)).catch(() => ({
          fullName: repo,
          description: "",
          homepage: site.publicUrl ?? "",
          topics: [],
        }));
      }

      const livePages = pages.filter((p) => p.status !== "HIDDEN");
      const pageSeoList = await Promise.all(
        livePages.map(async (page) => {
          try {
            const source = await pageSource(site, page);
            const draft = (page.draft ?? {}) as Record<string, FieldValue>;
            const html = editingSource(source.html, draft);
            return {
              pageId: page.id,
              title: page.title,
              path: page.path,
              filePath: page.filePath,
              seo: extractPageSeo(html),
            };
          } catch {
            return {
              pageId: page.id,
              title: page.title,
              path: page.path,
              filePath: page.filePath,
              seo: {
                title: page.title,
                description: "",
                keywords: "",
                tags: [],
                ogTitle: page.title,
                ogDescription: "",
                ogImage: "",
                twitterCard: "summary_large_image",
                canonical: "",
                robots: "index, follow",
                hasGeneratedSeoBlock: false,
              },
            };
          }
        }),
      );

      res.json({
        siteId: site.id,
        siteName: site.name,
        repo,
        repoMetadata,
        pages: pageSeoList,
      });
    } catch (err) {
      next(err);
    }
  });

  // 2. Update GitHub Repository SEO metadata (description, homepage URL, and GitHub topics/tags)
  router.post("/sites/:siteId/seo/repo", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const body = repoSeoPatchSchema.parse(req.body ?? {});
      const repo = siteRepo(site);
      if (!repo) {
        throw new WebsiteError(409, "Connect a GitHub repository in Website Settings to edit repository topics and metadata.");
      }

      const updated = await underSiteCredential(site, () =>
        updateRepoMetadata(repo, {
          description: body.description,
          homepage: body.homepage,
          topics: body.topics,
        }),
      );

      const author = req.dbUser?.name ?? req.dbUser?.email ?? "Website Manager";
      await prisma.siteAuditEvent.create({
        data: {
          siteId: site.id,
          kind: "SEO_REPO_UPDATED",
          summary: `Updated GitHub repo metadata & topics (${updated.topics.length} tags)`,
          actorName: author,
          actorId: req.dbUser?.id,
          detail: updated as unknown as Prisma.InputJsonValue,
        },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // 3. Auto-generate SEO properties (Title, Description, Keywords/Tags) from page content
  router.post("/sites/:siteId/seo/auto-generate", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const { pageId } = z.object({ pageId: z.string().min(1) }).parse(req.body ?? {});
      const page = await prisma.sitePage.findFirst({ where: { id: pageId, siteId: site.id } });
      if (!page) throw new WebsiteError(404, "Page not found.");

      const source = await pageSource(site, page);
      const draft = (page.draft ?? {}) as Record<string, FieldValue>;
      const html = editingSource(source.html, draft);
      const generated = generateSmartPageSeo(site, page, html);

      res.json({ pageId: page.id, seo: generated });
    } catch (err) {
      next(err);
    }
  });

  // 4. Save (and optionally publish to GitHub repo) a page's full <head> SEO properties
  router.post("/sites/:siteId/seo/page", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const body = pageSeoPatchSchema.parse(req.body ?? {});
      const page = await prisma.sitePage.findFirst({ where: { id: body.pageId, siteId: site.id } });
      if (!page) throw new WebsiteError(404, "Page not found.");

      const source = await pageSource(site, page, { fresh: body.publishNow });
      const existingDraft = (page.draft ?? {}) as Record<string, FieldValue>;
      const currentHtml = editingSource(source.html, existingDraft);
      const updatedHtml = applyPageSeoToHtml(currentHtml, body);

      // Also sync meta.0 (title) and meta.1 (description) into page.draft when present
      const { fields } = discoverFields(source.html);
      const nextDraft: Record<string, FieldValue> = { ...existingDraft };
      const titleField = fields.find((f) => f.id === "meta.0");
      if (titleField && body.title !== undefined) {
        nextDraft["meta.0"] = {
          ...(nextDraft["meta.0"] ?? {}),
          value: body.title.trim(),
          original: titleField.value,
        };
      }
      const descField = fields.find((f) => f.id === "meta.1");
      if (descField && body.description !== undefined) {
        nextDraft["meta.1"] = {
          ...(nextDraft["meta.1"] ?? {}),
          value: body.description.trim(),
          original: descField.value,
        };
      }

      let commitInfo: { sha: string; url: string } | null = null;
      const repo = siteRepo(site);
      const author = req.dbUser?.name ?? req.dbUser?.email ?? "Website Manager";

      if (body.publishNow && repo) {
        commitInfo = await publishPages({
          site,
          message: `SEO: updated title, description & meta tags on ${page.path} (${author})`,
          pages: [{ page, html: updatedHtml, expectedSource: source.html }],
        });
        invalidateSource(site.id, page.filePath);
        await prisma.sitePage.update({
          where: { id: page.id },
          data: {
            ...(page.sourceHtml !== null ? { sourceHtml: updatedHtml } : {}),
            draft: Prisma.DbNull,
            draftRevision: { increment: 1 },
            lastPublishedAt: new Date(),
            status: "LIVE",
          },
        });
      } else {
        const docDraft = restoreDocument(source.html, existingDraft, updatedHtml, "Updated page SEO metadata");
        await prisma.sitePage.update({
          where: { id: page.id },
          data: {
            ...(page.sourceHtml !== null ? { sourceHtml: updatedHtml } : {}),
            draft: { ...nextDraft, ...docDraft } as unknown as Prisma.InputJsonValue,
            draftRevision: { increment: 1 },
            draftSavedAt: new Date(),
            draftSavedById: req.dbUser?.id ?? null,
          },
        });
      }

      await prisma.siteAuditEvent.create({
        data: {
          siteId: site.id,
          kind: "SEO_PAGE_UPDATED",
          summary: `${commitInfo ? "Published" : "Saved"} SEO metadata on ${page.title}`,
          actorName: author,
          actorId: req.dbUser?.id,
          detail: {
            pageId: page.id,
            path: page.path,
            published: Boolean(commitInfo),
            commitSha: commitInfo?.sha ?? null,
            seo: extractPageSeo(updatedHtml),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      res.json({
        pageId: page.id,
        published: Boolean(commitInfo),
        commitSha: commitInfo?.sha ?? null,
        commitUrl: commitInfo?.url ?? null,
        seo: extractPageSeo(updatedHtml),
      });
    } catch (err) {
      next(err);
    }
  });

  // 5. Generate JSON-LD Structured Data + Sitemap.xml + Robots.txt
  router.post("/sites/:siteId/seo/technical", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const body = z
        .object({
          pageId: z.string().min(1),
          schemaType: z.enum(["Organization", "LocalBusiness", "WebSite", "Product", "FAQPage"]).default("Organization"),
          organizationName: z.string().max(160).optional(),
          phone: z.string().max(60).optional(),
          publishRepoFiles: z.boolean().optional().default(false),
        })
        .parse(req.body ?? {});

      const page = await prisma.sitePage.findFirst({ where: { id: body.pageId, siteId: site.id } });
      if (!page) throw new WebsiteError(404, "Page not found.");

      const allPages = await prisma.sitePage.findMany({
        where: { siteId: site.id },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      });

      const baseUrl = (site.publicUrl || "https://example.com").replace(/\/+$/, "");
      const pageUrl = `${baseUrl}${page.path.startsWith("/") ? page.path : `/${page.path}`}`;

      const source = await pageSource(site, page);
      const existingDraft = (page.draft ?? {}) as Record<string, FieldValue>;
      let currentHtml = editingSource(source.html, existingDraft);
      const currentSeo = extractPageSeo(currentHtml);

      const jsonLd = {
        "@context": "https://schema.org",
        "@type": body.schemaType,
        name: body.organizationName || site.name || currentSeo.title || page.title,
        url: pageUrl,
        description: currentSeo.description || `${site.name} — ${page.title}`,
        ...(body.phone ? { telephone: body.phone } : {}),
        ...(currentSeo.ogImage ? { image: currentSeo.ogImage } : {}),
      };

      const schemaBlock = [
        "<!-- BEGIN JSON-LD SCHEMA -->",
        `<script type="application/ld+json">${JSON.stringify(jsonLd, null, 2)}</script>`,
        "<!-- END JSON-LD SCHEMA -->",
      ].join("\n  ");

      currentHtml = currentHtml.replace(/<!--\s*BEGIN\s+JSON-LD\s+SCHEMA\s*-->[\s\S]*?<!--\s*END\s+JSON-LD\s+SCHEMA\s*-->\s*/gi, "");
      if (/<\/head\s*>/i.test(currentHtml)) {
        currentHtml = currentHtml.replace(/<\/head\s*>/i, `  ${schemaBlock}\n</head>`);
      } else {
        currentHtml = `${schemaBlock}\n${currentHtml}`;
      }

      const docDraft = restoreDocument(source.html, existingDraft, currentHtml, `Added ${body.schemaType} JSON-LD Schema`);
      await prisma.sitePage.update({
        where: { id: page.id },
        data: {
          ...(page.sourceHtml !== null ? { sourceHtml: currentHtml } : {}),
          draft: { ...existingDraft, ...docDraft } as unknown as Prisma.InputJsonValue,
          draftRevision: { increment: 1 },
          draftSavedAt: new Date(),
          draftSavedById: req.dbUser?.id ?? null,
        },
      });

      const today = new Date().toISOString().slice(0, 10);
      const sitemapXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...allPages.map((p) => {
          const loc = `${baseUrl}${p.path.startsWith("/") ? p.path : `/${p.path}`}`;
          return `  <url>\n    <loc>${escapeText(loc)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${p.path === "/" ? "1.0" : "0.8"}</priority>\n  </url>`;
        }),
        "</urlset>",
      ].join("\n");

      const robotsTxt = [
        "User-agent: *",
        "Allow: /",
        "",
        `Sitemap: ${baseUrl}/sitemap.xml`,
      ].join("\n");

      let repoCommit: { sha: string; url: string } | null = null;
      const repo = siteRepo(site);
      if (body.publishRepoFiles && repo) {
        const sitemapPath = repoFilePath(site, { filePath: "sitemap.xml" } as SitePage);
        const robotsPath = repoFilePath(site, { filePath: "robots.txt" } as SitePage);
        repoCommit = await underSiteCredential(site, () =>
          commitFiles({
            repo,
            branch: site.repoBranch || "main",
            message: `SEO: generated sitemap.xml and robots.txt (${req.dbUser?.name ?? "Website Manager"})`,
            files: [
              { path: sitemapPath, content: sitemapXml },
              { path: robotsPath, content: robotsTxt },
            ],
          }),
        );
      }

      res.json({
        ok: true,
        schemaType: body.schemaType,
        sitemapXml,
        robotsTxt,
        repoCommit,
      });
    } catch (err) {
      next(err);
    }
  });

  // 6. Inject or remove a floating WhatsApp & Call Lead Conversion Bar
  router.post("/sites/:siteId/seo/conversion-bar", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const body = z
        .object({
          pageId: z.string().min(1),
          enabled: z.boolean(),
          whatsapp: z.string().max(60).optional().default(""),
          phone: z.string().max(60).optional().default(""),
          ctaLabel: z.string().max(120).optional().default("Chat with us on WhatsApp"),
          accentColor: z.string().max(30).optional().default("#16a34a"),
        })
        .parse(req.body ?? {});

      const page = await prisma.sitePage.findFirst({ where: { id: body.pageId, siteId: site.id } });
      if (!page) throw new WebsiteError(404, "Page not found.");

      const source = await pageSource(site, page);
      const existingDraft = (page.draft ?? {}) as Record<string, FieldValue>;
      let currentHtml = editingSource(source.html, existingDraft);

      currentHtml = currentHtml.replace(/<!--\s*BEGIN\s+CONVERSION\s+BAR\s*-->[\s\S]*?<!--\s*END\s+CONVERSION\s+BAR\s*-->\s*/gi, "");

      if (body.enabled) {
        const cleanWa = body.whatsapp.replace(/[^0-9]/g, "");
        const waHref = cleanWa ? `https://wa.me/${cleanWa}` : "#contact";
        const telHref = body.phone.trim() ? `tel:${escapeAttr(body.phone.trim())}` : "";
        const widgetHtml = [
          "<!-- BEGIN CONVERSION BAR -->",
          `<div data-dw-conversion-bar="true" style="position:fixed;bottom:20px;right:20px;z-index:9990;display:flex;align-items:center;gap:10px;font-family:system-ui,-apple-system,sans-serif;">`,
          telHref
            ? `  <a href="${telHref}" style="display:inline-flex;align-items:center;gap:8px;padding:11px 16px;border-radius:999px;background:#0f172a;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;box-shadow:0 10px 25px rgba(15,23,42,0.22);">Call Now</a>`
            : "",
          `  <a href="${escapeAttr(waHref)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:999px;background:${escapeAttr(body.accentColor || "#16a34a")};color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;box-shadow:0 10px 25px rgba(22,163,74,0.28);">${escapeText(body.ctaLabel || "Chat with us")}</a>`,
          `</div>`,
          "<!-- END CONVERSION BAR -->",
        ]
          .filter(Boolean)
          .join("\n");

        if (/<\/body\s*>/i.test(currentHtml)) {
          currentHtml = currentHtml.replace(/<\/body\s*>/i, `${widgetHtml}\n</body>`);
        } else {
          currentHtml = `${currentHtml}\n${widgetHtml}`;
        }
      }

      const docDraft = restoreDocument(
        source.html,
        existingDraft,
        currentHtml,
        body.enabled ? "Added floating WhatsApp/Call Conversion Bar" : "Removed floating Conversion Bar",
      );

      await prisma.sitePage.update({
        where: { id: page.id },
        data: {
          ...(page.sourceHtml !== null ? { sourceHtml: currentHtml } : {}),
          draft: { ...existingDraft, ...docDraft } as unknown as Prisma.InputJsonValue,
          draftRevision: { increment: 1 },
          draftSavedAt: new Date(),
          draftSavedById: req.dbUser?.id ?? null,
        },
      });

      res.json({ ok: true, enabled: body.enabled });
    } catch (err) {
      next(err);
    }
  });

  // 7. Insert a pre-built responsive Section / Component into the page draft
  router.post("/sites/:siteId/pages/:pageId/insert-section", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const page = await prisma.sitePage.findFirst({ where: { id: req.params.pageId, siteId: site.id } });
      if (!page) throw new WebsiteError(404, "Page not found.");

      const body = z
        .object({
          templateId: z.enum(["hero", "features", "pricing", "testimonials", "faq", "cta-banner"]),
        })
        .parse(req.body ?? {});

      const SECTION_TEMPLATES: Record<string, { label: string; html: string }> = {
        hero: {
          label: "Hero Banner with Dual CTA",
          html: `<section style="padding:72px 24px;max-width:1120px;margin:0 auto;text-align:center;">
  <p style="font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#3157FF;margin:0 0 12px;">Built for Modern Teams</p>
  <h2 style="font-size:clamp(2rem,4vw,3.25rem);line-height:1.12;font-weight:800;margin:0 auto 18px;max-width:760px;">Grow faster with a website engineered to convert every visitor</h2>
  <p style="font-size:1.1rem;line-height:1.65;color:#526077;max-width:620px;margin:0 auto 28px;">Launch high-converting pages, optimize your search rankings, and turn incoming traffic into qualified customer conversations.</p>
  <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;">
    <a href="#contact" style="display:inline-block;padding:13px 24px;border-radius:12px;background:#08101F;color:#ffffff;font-weight:600;text-decoration:none;">Get Started Today</a>
    <a href="#services" style="display:inline-block;padding:13px 24px;border-radius:12px;border:1px solid #CBD5E1;color:#08101F;font-weight:600;text-decoration:none;">Explore Services</a>
  </div>
</section>`,
        },
        features: {
          label: "3-Column Features & Benefits Grid",
          html: `<section style="padding:64px 24px;max-width:1120px;margin:0 auto;">
  <div style="text-align:center;max-width:640px;margin:0 auto 40px;">
    <h2 style="font-size:2rem;font-weight:700;margin:0 0 12px;">Why clients choose us</h2>
    <p style="font-size:1rem;color:#526077;margin:0;">Everything you need to deliver fast, measurable results for your business.</p>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px;">
    <div style="padding:28px;border-radius:16px;border:1px solid #E2E8F0;background:#ffffff;">
      <h3 style="font-size:1.2rem;font-weight:700;margin:0 0 10px;">Fast Turnaround</h3>
      <p style="font-size:0.95rem;line-height:1.6;color:#526077;margin:0;">We move from strategy to launch in days, keeping every milestone transparent and on schedule.</p>
    </div>
    <div style="padding:28px;border-radius:16px;border:1px solid #E2E8F0;background:#ffffff;">
      <h3 style="font-size:1.2rem;font-weight:700;margin:0 0 10px;">Conversion Focused</h3>
      <p style="font-size:0.95rem;line-height:1.6;color:#526077;margin:0;">Every headline, call-to-action, and layout is crafted to turn visitors into paying customers.</p>
    </div>
    <div style="padding:28px;border-radius:16px;border:1px solid #E2E8F0;background:#ffffff;">
      <h3 style="font-size:1.2rem;font-weight:700;margin:0 0 10px;">Dedicated Support</h3>
      <p style="font-size:0.95rem;line-height:1.6;color:#526077;margin:0;">Our team stays with you after launch with proactive updates, SEO tuning, and priority care.</p>
    </div>
  </div>
</section>`,
        },
        pricing: {
          label: "Pricing Plans Comparison",
          html: `<section style="padding:64px 24px;max-width:1120px;margin:0 auto;">
  <div style="text-align:center;max-width:640px;margin:0 auto 40px;">
    <h2 style="font-size:2rem;font-weight:700;margin:0 0 12px;">Simple, transparent pricing</h2>
    <p style="font-size:1rem;color:#526077;margin:0;">Pick the plan that matches your current stage and scale anytime.</p>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px;">
    <div style="padding:32px;border-radius:18px;border:1px solid #E2E8F0;background:#ffffff;">
      <h3 style="font-size:1.15rem;font-weight:700;margin:0 0 8px;">Starter</h3>
      <p style="font-size:2rem;font-weight:800;margin:0 0 16px;">$299<span style="font-size:0.9rem;font-weight:400;color:#64748B;"> / project</span></p>
      <p style="font-size:0.95rem;color:#526077;margin:0 0 24px;">Ideal for new businesses launching their first professional presence.</p>
      <a href="#contact" style="display:block;text-align:center;padding:12px 18px;border-radius:10px;border:1px solid #08101F;color:#08101F;font-weight:600;text-decoration:none;">Choose Starter</a>
    </div>
    <div style="padding:32px;border-radius:18px;border:2px solid #3157FF;background:#ffffff;box-shadow:0 12px 32px rgba(49,87,255,0.10);">
      <h3 style="font-size:1.15rem;font-weight:700;margin:0 0 8px;">Growth</h3>
      <p style="font-size:2rem;font-weight:800;margin:0 0 16px;">$699<span style="font-size:0.9rem;font-weight:400;color:#64748B;"> / project</span></p>
      <p style="font-size:0.95rem;color:#526077;margin:0 0 24px;">Full custom design, SEO setup, and lead-capture integration included.</p>
      <a href="#contact" style="display:block;text-align:center;padding:12px 18px;border-radius:10px;background:#3157FF;color:#ffffff;font-weight:600;text-decoration:none;">Choose Growth</a>
    </div>
  </div>
</section>`,
        },
        testimonials: {
          label: "Client Testimonials Grid",
          html: `<section style="padding:64px 24px;max-width:1120px;margin:0 auto;">
  <h2 style="font-size:2rem;font-weight:700;text-align:center;margin:0 0 36px;">Trusted by growing businesses</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px;">
    <blockquote style="margin:0;padding:28px;border-radius:16px;border:1px solid #E2E8F0;background:#F8FAFC;">
      <p style="font-size:1rem;line-height:1.65;color:#1E293B;margin:0 0 16px;">"Since launching our updated website, inbound inquiries have more than doubled and customers compliment how easy it is to book."</p>
      <footer style="font-size:0.9rem;font-weight:700;color:#0F172A;">Ama Mensah · Founder, Studio K</footer>
    </blockquote>
    <blockquote style="margin:0;padding:28px;border-radius:16px;border:1px solid #E2E8F0;background:#F8FAFC;">
      <p style="font-size:1rem;line-height:1.65;color:#1E293B;margin:0 0 16px;">"The speed, attention to detail, and built-in SEO made an immediate difference in our local search rankings."</p>
      <footer style="font-size:0.9rem;font-weight:700;color:#0F172A;">David Osei · Managing Director</footer>
    </blockquote>
  </div>
</section>`,
        },
        faq: {
          label: "Frequently Asked Questions",
          html: `<section style="padding:64px 24px;max-width:820px;margin:0 auto;">
  <h2 style="font-size:2rem;font-weight:700;text-align:center;margin:0 0 32px;">Frequently asked questions</h2>
  <div style="display:flex;flex-direction:column;gap:16px;">
    <div style="padding:20px 24px;border-radius:14px;border:1px solid #E2E8F0;background:#ffffff;">
      <h3 style="font-size:1.05rem;font-weight:700;margin:0 0 8px;">How quickly can we get started?</h3>
      <p style="font-size:0.95rem;line-height:1.6;color:#526077;margin:0;">We kick off within 24 hours of onboarding and deliver your first interactive milestone within the first week.</p>
    </div>
    <div style="padding:20px 24px;border-radius:14px;border:1px solid #E2E8F0;background:#ffffff;">
      <h3 style="font-size:1.05rem;font-weight:700;margin:0 0 8px;">Can we update text and photos ourselves later?</h3>
      <p style="font-size:0.95rem;line-height:1.6;color:#526077;margin:0;">Yes — every heading, paragraph, button, and image on this page is visually editable at any time without touching code.</p>
    </div>
  </div>
</section>`,
        },
        "cta-banner": {
          label: "High-Impact Call to Action Banner",
          html: `<section style="padding:56px 24px;max-width:1080px;margin:32px auto;">
  <div style="padding:48px 32px;border-radius:24px;background:#08101F;color:#ffffff;text-align:center;">
    <h2 style="font-size:clamp(1.6rem,3vw,2.4rem);font-weight:800;margin:0 0 12px;color:#ffffff;">Ready to take the next step?</h2>
    <p style="font-size:1.05rem;color:#CBD5E1;max-width:540px;margin:0 auto 24px;">Book a quick call or message our team on WhatsApp to get a tailored plan for your business.</p>
    <a href="#contact" style="display:inline-block;padding:13px 28px;border-radius:12px;background:#3157FF;color:#ffffff;font-weight:600;text-decoration:none;">Speak With Our Team</a>
  </div>
</section>`,
        },
      };

      const chosen = SECTION_TEMPLATES[body.templateId];
      if (!chosen) throw new WebsiteError(400, "Unknown section template.");

      const source = await pageSource(site, page);
      const existingDraft = (page.draft ?? {}) as Record<string, FieldValue>;
      let currentHtml = editingSource(source.html, existingDraft);

      if (/<\/main\s*>/i.test(currentHtml)) {
        currentHtml = currentHtml.replace(/<\/main\s*>/i, `\n${chosen.html}\n</main>`);
      } else if (/<footer\b/i.test(currentHtml)) {
        currentHtml = currentHtml.replace(/<footer\b/i, `${chosen.html}\n<footer`);
      } else if (/<\/body\s*>/i.test(currentHtml)) {
        currentHtml = currentHtml.replace(/<\/body\s*>/i, `\n${chosen.html}\n</body>`);
      } else {
        currentHtml = `${currentHtml}\n${chosen.html}`;
      }

      const docDraft = restoreDocument(source.html, existingDraft, currentHtml, `Inserted section: ${chosen.label}`);
      await prisma.sitePage.update({
        where: { id: page.id },
        data: {
          ...(page.sourceHtml !== null ? { sourceHtml: currentHtml } : {}),
          draft: { ...existingDraft, ...docDraft } as unknown as Prisma.InputJsonValue,
          draftRevision: { increment: 1 },
          draftSavedAt: new Date(),
          draftSavedById: req.dbUser?.id ?? null,
        },
      });

      res.json({ ok: true, label: chosen.label });
    } catch (err) {
      next(err);
    }
  });

  // 8. (#3) 1-Click Page Speed (lazy-load) & Link Security Optimizer + Health Score
  router.post("/sites/:siteId/seo/speed-optimize", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const body = z
        .object({
          pageId: z.string().min(1),
          applyFixes: z.boolean().optional().default(true),
        })
        .parse(req.body ?? {});

      const page = await prisma.sitePage.findFirst({ where: { id: body.pageId, siteId: site.id } });
      if (!page) throw new WebsiteError(404, "Page not found.");

      const source = await pageSource(site, page);
      const existingDraft = (page.draft ?? {}) as Record<string, FieldValue>;
      let html = editingSource(source.html, existingDraft);

      let lazyImagesAdded = 0;
      let asyncDecodingAdded = 0;
      let externalLinksHardened = 0;
      let altTagsAdded = 0;

      // Count images & links before/during optimization
      const imgRegex = /<img\b([^>]*)>/gi;
      let totalImages = 0;
      html = html.replace(imgRegex, (fullMatch, attrs: string) => {
        totalImages += 1;
        let nextAttrs = attrs;
        // Skip lazy loading on the very first hero image (LCP best practice), add to subsequent images
        if (totalImages > 1 && !/\bloading\s*=/i.test(nextAttrs)) {
          lazyImagesAdded += 1;
          if (body.applyFixes) nextAttrs += ' loading="lazy"';
        }
        if (!/\bdecoding\s*=/i.test(nextAttrs)) {
          asyncDecodingAdded += 1;
          if (body.applyFixes) nextAttrs += ' decoding="async"';
        }
        if (!/\balt\s*=/i.test(nextAttrs)) {
          altTagsAdded += 1;
          if (body.applyFixes) nextAttrs += ` alt="${escapeAttr(site.name || page.title)} visual"`;
        }
        return body.applyFixes ? `<img${nextAttrs}>` : fullMatch;
      });

      const anchorRegex = /<a\b([^>]*)>/gi;
      html = html.replace(anchorRegex, (fullMatch, attrs: string) => {
        if (/\btarget\s*=\s*["']_blank["']/i.test(attrs) && !/\brel\s*=/i.test(attrs)) {
          externalLinksHardened += 1;
          if (body.applyFixes) {
            return `<a${attrs} rel="noopener noreferrer">`;
          }
        }
        return fullMatch;
      });

      const hasPreconnect = /fonts\.googleapis\.com/i.test(html) && /rel\s*=\s*["']preconnect["']/i.test(html);
      if (body.applyFixes && !hasPreconnect && /<\/head\s*>/i.test(html)) {
        const preconnectBlock = `<link rel="preconnect" href="https://fonts.googleapis.com">\n  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`;
        html = html.replace(/<\/head\s*>/i, `  ${preconnectBlock}\n</head>`);
      }

      const h1Matches = html.match(/<h1\b[^>]*>/gi) ?? [];
      const seo = extractPageSeo(html);
      const hasJsonLd = /application\/ld\+json/i.test(html);

      // Compute 0-100 Health & Speed Score
      let score = 100;
      if (!seo.title) score -= 12;
      if (!seo.description) score -= 12;
      if (h1Matches.length === 0) score -= 10;
      if (h1Matches.length > 1) score -= 5;
      if (!hasJsonLd) score -= 8;
      if (!body.applyFixes) {
        score -= Math.min(20, lazyImagesAdded * 4 + asyncDecodingAdded * 2);
        score -= Math.min(15, externalLinksHardened * 5);
        score -= Math.min(15, altTagsAdded * 5);
      }
      score = Math.max(35, Math.min(100, score));

      if (body.applyFixes) {
        const docDraft = restoreDocument(
          source.html,
          existingDraft,
          html,
          `Optimized Page Speed (${lazyImagesAdded} lazy-load images, ${externalLinksHardened} links hardened)`,
        );
        await prisma.sitePage.update({
          where: { id: page.id },
          data: {
            ...(page.sourceHtml !== null ? { sourceHtml: html } : {}),
            draft: { ...existingDraft, ...docDraft } as unknown as Prisma.InputJsonValue,
            draftRevision: { increment: 1 },
            draftSavedAt: new Date(),
            draftSavedById: req.dbUser?.id ?? null,
          },
        });
      }

      res.json({
        ok: true,
        applied: body.applyFixes,
        score,
        metrics: {
          totalImages,
          lazyImagesAdded,
          asyncDecodingAdded,
          externalLinksHardened,
          altTagsAdded,
          h1Count: h1Matches.length,
          hasJsonLd,
          hasTitle: Boolean(seo.title),
          hasDescription: Boolean(seo.description),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // 9. (#4) 1-Click Global Font & Brand Theme Switcher (Google Fonts + Palette)
  router.post("/sites/:siteId/seo/brand-theme", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const body = z
        .object({
          pageId: z.string().min(1),
          fontPairId: z
            .enum(["space-dm", "playfair-inter", "jakarta-inter", "instrument-jakarta", "outfit-work", "reset"])
            .default("space-dm"),
          primaryColor: z.string().max(30).optional().default("#3157FF"),
          surfaceColor: z.string().max(30).optional().default("#FFFFFF"),
          textColor: z.string().max(30).optional().default("#08101F"),
          applyColorOverrides: z.boolean().optional().default(false),
        })
        .parse(req.body ?? {});

      const page = await prisma.sitePage.findFirst({ where: { id: body.pageId, siteId: site.id } });
      if (!page) throw new WebsiteError(404, "Page not found.");

      const FONT_PAIRS: Record<
        string,
        { label: string; googleUrl: string; headingFont: string; bodyFont: string }
      > = {
        "space-dm": {
          label: "Space Grotesk + DM Sans (Modern SaaS)",
          googleUrl:
            "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Grotesk:wght@600;700&display=swap",
          headingFont: "'Space Grotesk', sans-serif",
          bodyFont: "'DM Sans', sans-serif",
        },
        "playfair-inter": {
          label: "Playfair Display + Inter (Editorial & Luxury)",
          googleUrl:
            "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:wght@600;700;800&display=swap",
          headingFont: "'Playfair Display', serif",
          bodyFont: "'Inter', sans-serif",
        },
        "jakarta-inter": {
          label: "Plus Jakarta Sans + Inter (Clean Agency)",
          googleUrl:
            "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap",
          headingFont: "'Plus Jakarta Sans', sans-serif",
          bodyFont: "'Inter', sans-serif",
        },
        "instrument-jakarta": {
          label: "Instrument Serif + Plus Jakarta Sans (Boutique Studio)",
          googleUrl:
            "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap",
          headingFont: "'Instrument Serif', serif",
          bodyFont: "'Plus Jakarta Sans', sans-serif",
        },
        "outfit-work": {
          label: "Outfit + Work Sans (Bold Startup)",
          googleUrl:
            "https://fonts.googleapis.com/css2?family=Outfit:wght@600;700;800&family=Work+Sans:wght@400;500;600&display=swap",
          headingFont: "'Outfit', sans-serif",
          bodyFont: "'Work Sans', sans-serif",
        },
      };

      const source = await pageSource(site, page);
      const existingDraft = (page.draft ?? {}) as Record<string, FieldValue>;
      let html = editingSource(source.html, existingDraft);

      html = html.replace(/<!--\s*BEGIN\s+BRAND\s+THEME\s*-->[\s\S]*?<!--\s*END\s+BRAND\s+THEME\s*-->\s*/gi, "");

      let label = "Reset Brand Theme";
      if (body.fontPairId !== "reset") {
        const pair = FONT_PAIRS[body.fontPairId] ?? FONT_PAIRS["space-dm"];
        label = `Applied Brand Theme: ${pair.label}`;
        const cssLines = [
          `:root { --brand-primary: ${escapeAttr(body.primaryColor)}; --brand-surface: ${escapeAttr(body.surfaceColor)}; --brand-ink: ${escapeAttr(body.textColor)}; --font-heading: ${pair.headingFont}; --font-body: ${pair.bodyFont}; }`,
          `body { font-family: ${pair.bodyFont} !important; ${body.applyColorOverrides ? `background-color: ${escapeAttr(body.surfaceColor)}; color: ${escapeAttr(body.textColor)};` : ""} }`,
          `h1, h2, h3, h4, h5, h6 { font-family: ${pair.headingFont} !important; }`,
          body.applyColorOverrides
            ? `a.btn, button[type="submit"], [data-dw-cta] { background-color: ${escapeAttr(body.primaryColor)} !important; color: #ffffff !important; }`
            : "",
        ]
          .filter(Boolean)
          .join("\n    ");

        const themeBlock = [
          "<!-- BEGIN BRAND THEME -->",
          `<link rel="stylesheet" href="${pair.googleUrl}">`,
          `<style data-dw-brand-theme="true">\n    ${cssLines}\n  </style>`,
          "<!-- END BRAND THEME -->",
        ].join("\n  ");

        if (/<\/head\s*>/i.test(html)) {
          html = html.replace(/<\/head\s*>/i, `  ${themeBlock}\n</head>`);
        } else {
          html = `${themeBlock}\n${html}`;
        }
      }

      const docDraft = restoreDocument(source.html, existingDraft, html, label);
      await prisma.sitePage.update({
        where: { id: page.id },
        data: {
          ...(page.sourceHtml !== null ? { sourceHtml: html } : {}),
          draft: { ...existingDraft, ...docDraft } as unknown as Prisma.InputJsonValue,
          draftRevision: { increment: 1 },
          draftSavedAt: new Date(),
          draftSavedById: req.dbUser?.id ?? null,
        },
      });

      res.json({ ok: true, label });
    } catch (err) {
      next(err);
    }
  });

  // 10. (#5) Client-Ready SEO & Website Optimization Report Generator
  router.get("/sites/:siteId/pages/:pageId/report", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const page = await prisma.sitePage.findFirst({ where: { id: req.params.pageId, siteId: site.id } });
      if (!page) throw new WebsiteError(404, "Page not found.");

      const source = await pageSource(site, page);
      const existingDraft = (page.draft ?? {}) as Record<string, FieldValue>;
      const html = editingSource(source.html, existingDraft);
      const seo = extractPageSeo(html);

      const imgMatches = [...html.matchAll(/<img\b([^>]*)>/gi)];
      const totalImages = imgMatches.length;
      const imagesWithAlt = imgMatches.filter((m) => /\balt\s*=\s*["'][^"']+["']/i.test(m[1] ?? "")).length;
      const imagesWithLazy = imgMatches.filter((m) => /\bloading\s*=\s*["']lazy["']/i.test(m[1] ?? "")).length;
      const hasJsonLd = /application\/ld\+json/i.test(html);
      const hasConversionBar = /data-dw-conversion-bar/i.test(html);
      const hasBrandTheme = /data-dw-brand-theme/i.test(html);
      const h1Count = (html.match(/<h1\b[^>]*>/gi) ?? []).length;

      let score = 100;
      if (!seo.title) score -= 15;
      if (!seo.description) score -= 15;
      if (h1Count === 0) score -= 10;
      if (!hasJsonLd) score -= 10;
      if (totalImages > 0 && imagesWithAlt < totalImages) score -= 10;
      score = Math.max(40, Math.min(100, score));

      const recentEvents = await prisma.siteAuditEvent.findMany({
        where: { siteId: site.id },
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      const settingsObj =
        site.settings && typeof site.settings === "object" && !Array.isArray(site.settings)
          ? (site.settings as Record<string, unknown>)
          : {};

      res.json({
        generatedAt: new Date().toISOString(),
        site: {
          id: site.id,
          name: site.name,
          publicUrl: site.publicUrl,
          repo: siteRepo(site),
        },
        page: {
          id: page.id,
          title: page.title,
          path: page.path,
          lastPublishedAt: page.lastPublishedAt,
        },
        score,
        seo,
        technical: {
          totalImages,
          imagesWithAlt,
          imagesWithLazy,
          hasJsonLd,
          hasConversionBar,
          hasBrandTheme,
          h1Count,
        },
        healthMonitor: settingsObj.healthMonitor ?? null,
        recentActivity: recentEvents.map((ev) => ({
          id: ev.id,
          kind: ev.kind,
          summary: ev.summary,
          actorName: ev.actorName,
          createdAt: ev.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // 11. (#11) Client Pin-Comments & Revision Checklist
  type RevisionComment = {
    id: string;
    pageId: string;
    fieldId: string | null;
    elementLabel: string;
    authorName: string;
    message: string;
    resolved: boolean;
    createdAt: string;
  };

  function readSiteComments(site: Site, pageId: string): RevisionComment[] {
    const settingsObj =
      site.settings && typeof site.settings === "object" && !Array.isArray(site.settings)
        ? (site.settings as Record<string, unknown>)
        : {};
    const all = Array.isArray(settingsObj.revisionComments)
      ? (settingsObj.revisionComments as RevisionComment[])
      : [];
    return all.filter((c) => c.pageId === pageId);
  }

  router.get("/sites/:siteId/pages/:pageId/comments", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const comments = readSiteComments(site, req.params.pageId);
      res.json({ comments });
    } catch (err) {
      next(err);
    }
  });

  router.post("/sites/:siteId/pages/:pageId/comments", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const body = z
        .object({
          fieldId: z.string().max(120).nullable().optional().default(null),
          elementLabel: z.string().max(160).optional().default("Page General Note"),
          authorName: z.string().max(100).optional(),
          message: z.string().min(1).max(1000),
        })
        .parse(req.body ?? {});

      const settingsObj =
        site.settings && typeof site.settings === "object" && !Array.isArray(site.settings)
          ? { ...(site.settings as Record<string, unknown>) }
          : {};
      const existing = Array.isArray(settingsObj.revisionComments)
        ? [...(settingsObj.revisionComments as RevisionComment[])]
        : [];

      const newComment: RevisionComment = {
        id: randomUUID(),
        pageId: req.params.pageId,
        fieldId: body.fieldId ?? null,
        elementLabel: body.elementLabel || "Page Note",
        authorName: body.authorName?.trim() || req.dbUser?.name || "Client Reviewer",
        message: body.message.trim(),
        resolved: false,
        createdAt: new Date().toISOString(),
      };

      const updatedList = [newComment, ...existing].slice(0, 200);
      settingsObj.revisionComments = updatedList;

      await prisma.site.update({
        where: { id: site.id },
        data: { settings: settingsObj as unknown as Prisma.InputJsonValue },
      });

      res.json({ comment: newComment, comments: updatedList.filter((c) => c.pageId === req.params.pageId) });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/sites/:siteId/pages/:pageId/comments/:commentId", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const body = z
        .object({
          resolved: z.boolean().optional(),
          delete: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      const settingsObj =
        site.settings && typeof site.settings === "object" && !Array.isArray(site.settings)
          ? { ...(site.settings as Record<string, unknown>) }
          : {};
      let existing = Array.isArray(settingsObj.revisionComments)
        ? [...(settingsObj.revisionComments as RevisionComment[])]
        : [];

      if (body.delete) {
        existing = existing.filter((c) => c.id !== req.params.commentId);
      } else {
        existing = existing.map((c) =>
          c.id === req.params.commentId
            ? { ...c, resolved: body.resolved !== undefined ? body.resolved : !c.resolved }
            : c,
        );
      }

      settingsObj.revisionComments = existing;
      await prisma.site.update({
        where: { id: site.id },
        data: { settings: settingsObj as unknown as Prisma.InputJsonValue },
      });

      res.json({ comments: existing.filter((c) => c.pageId === req.params.pageId) });
    } catch (err) {
      next(err);
    }
  });

  // 12. (#12) Automated Uptime & SSL Certificate Health Monitor
  async function checkSslCertificate(hostname: string): Promise<{
    valid: boolean;
    issuer: string | null;
    validTo: string | null;
    daysRemaining: number | null;
  }> {
    return new Promise((resolve) => {
      const socket = tls.connect(
        {
          host: hostname,
          port: 443,
          servername: hostname,
          rejectUnauthorized: false,
          timeout: 6000,
        },
        () => {
          try {
            const cert = socket.getPeerCertificate();
            socket.end();
            if (!cert || !cert.valid_to) {
              resolve({ valid: false, issuer: null, validTo: null, daysRemaining: null });
              return;
            }
            const expiryDate = new Date(cert.valid_to);
            const daysRemaining = Math.floor((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            const issuerOrg =
              typeof cert.issuer?.O === "string"
                ? cert.issuer.O
                : typeof cert.issuer?.CN === "string"
                  ? cert.issuer.CN
                  : "TLS Authority";
            resolve({
              valid: daysRemaining > 0,
              issuer: issuerOrg,
              validTo: expiryDate.toISOString(),
              daysRemaining,
            });
          } catch {
            socket.destroy();
            resolve({ valid: false, issuer: null, validTo: null, daysRemaining: null });
          }
        },
      );
      socket.on("error", () => {
        socket.destroy();
        resolve({ valid: false, issuer: null, validTo: null, daysRemaining: null });
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve({ valid: false, issuer: null, validTo: null, daysRemaining: null });
      });
    });
  }

  async function runSiteHealthProbe(site: Site) {
    const targetUrl = (site.publicUrl || "").trim();
    const checkedAt = new Date().toISOString();
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      return {
        checkedAt,
        targetUrl,
        online: false,
        statusCode: null,
        responseTimeMs: null,
        ssl: { valid: false, issuer: null, validTo: null, daysRemaining: null },
      };
    }

    const start = Date.now();
    let online = false;
    let statusCode: number | null = null;
    let responseTimeMs: number | null = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(targetUrl, {
        method: "GET",
        signal: controller.signal,
        headers: { "User-Agent": "Dakyworld-OS-UptimeMonitor/1.0" },
      });
      clearTimeout(timer);
      statusCode = resp.status;
      online = resp.status >= 200 && resp.status < 400;
      responseTimeMs = Date.now() - start;
    } catch {
      online = false;
      responseTimeMs = Date.now() - start;
    }

    let ssl = { valid: false, issuer: null as string | null, validTo: null as string | null, daysRemaining: null as number | null };
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol === "https:") {
        ssl = await checkSslCertificate(parsed.hostname);
      }
    } catch {
      // Invalid URL
    }

    const result = {
      checkedAt,
      targetUrl,
      online,
      statusCode,
      responseTimeMs,
      ssl,
    };

    const settingsObj =
      site.settings && typeof site.settings === "object" && !Array.isArray(site.settings)
        ? { ...(site.settings as Record<string, unknown>) }
        : {};
    settingsObj.healthMonitor = result;

    await prisma.site.update({
      where: { id: site.id },
      data: { settings: settingsObj as unknown as Prisma.InputJsonValue },
    });

    return result;
  }

  router.get("/sites/:siteId/health-monitor", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const settingsObj =
        site.settings && typeof site.settings === "object" && !Array.isArray(site.settings)
          ? (site.settings as Record<string, unknown>)
          : {};
      if (settingsObj.healthMonitor) {
        res.json(settingsObj.healthMonitor);
        return;
      }
      const fresh = await runSiteHealthProbe(site);
      res.json(fresh);
    } catch (err) {
      next(err);
    }
  });

  router.post("/sites/:siteId/health-monitor/check", async (req: Request, res: Response, next) => {
    try {
      const site = await access.loadSite(req, req.params.siteId);
      const fresh = await runSiteHealthProbe(site);
      res.json(fresh);
    } catch (err) {
      next(err);
    }
  });
}


