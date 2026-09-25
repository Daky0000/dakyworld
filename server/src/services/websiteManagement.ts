import { createHash, randomUUID } from "node:crypto";
import type { Request, Response, Router } from "express";
import type { Site, SitePage } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { buildPublishPlan, discoverFields, describeChanges, parse, editingSource } from "./website/index.js";
import { pageSource, WebsiteError } from "./website/site.js";
import { sniff } from "../lib/fileType.js";
import { optimizeImageBuffer } from "../lib/imageOptimization.js";
import { looksLikeSvg, SvgRejected, SVG_CONTENT_SECURITY_POLICY } from "../lib/svgSanitize.js";
import { assetUrl, embedWebsiteAssets, unpublishedUsesOf } from "./websiteAssets.js";
import { assertWebsiteConnectionChange, canManageWebsiteConnection } from "./websiteAccess.js";
import {
  assertImportAllowance,
  assertMediaStorageAllowance,
  assertTierFeatureAccess,
  captureHtmlImagesIntoMediaLibrary,
  recordImportUsed,
  recordMediaStorageAdded,
  WEBSITE_TIER_PLANS,
} from "./websiteTierPlans.js";
import { resolveEntitlement } from "./websiteEntitlement.js";

const publicUrl = z.string().url().max(2000).refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Use an HTTP or HTTPS website address without login details.");
const repoPart = z.string().regex(/^[a-zA-Z0-9_.-]+$/).max(100);
const folder = z.string().max(200).refine(value => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), "Use a folder inside the repository.");
export const siteInput = z.object({
  name: z.string().trim().min(1).max(120), publicUrl,
  repoOwner: repoPart.nullable().optional(), repoName: repoPart.nullable().optional(),
  repoBranch: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_./-]+$/).default("main"),
  repoPath: folder.default(""),
  /**
   * Whose website this is. Null for Dakyworld's own.
   *
   * It is what makes "does a retainer cover this" answerable at all — without
   * it the onboarding list can only say that nothing decides, which is true and
   * useless. See services/products.ts.
   */
  clientId: z.string().min(1).max(60).nullable().optional(),
});
const presetProperty = z.enum(["font-family", "font-size", "font-weight", "line-height", "color", "background-color", "border-radius", "padding", "margin", "gap"]);
const presetValue = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9 #.,%()\/-]+$/).refine(value => !/url\s*\(|expression|javascript|important|var\s*\(/i.test(value), "Use a plain colour, font or size.");
export const websiteBrandPreset = z.object({ id: z.string().min(1).max(60).regex(/^[a-zA-Z0-9_-]+$/), name: z.string().trim().min(1).max(60), target: z.enum(["heading", "button", "spacing"]), styles: z.record(presetProperty, presetValue) }).strict();
export const websiteDesignOptions = z.object({
  presets: z.array(websiteBrandPreset).max(20).default([]).refine(items => new Set(items.map(item => item.id)).size === items.length, "Brand style IDs must be unique."),
  colours: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(16).default([]),
  fonts: z.array(z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9 ,.-]+$/)).max(12).default([]),
  brandVoice: z.string().max(4000).default(""),
  aiEnabled: z.boolean().default(false),
});

/** Metadata alone is not an editable page: SPA shells usually have a title. */
export function importedWebsiteFields(html: string): number {
  const document = parse(html);
  let previous = 0;
  let outside = "";
  for (const element of document.children) {
    outside += html.slice(previous, element.start);
    previous = element.end;
  }
  outside += html.slice(previous);
  outside = outside.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype\s[^>]*>/gi, "").trim();
  if (outside || !document.children.length) throw new WebsiteError(400, "Choose an HTML page. JavaScript and React source files need a source adapter.");
  const count = discoverFields(html).fields.filter(field => field.kind !== "container" && field.tag !== "title" && field.tag !== "meta").length;
  if (!count) throw new WebsiteError(400, "This file has no editable HTML content. A JavaScript app shell needs its source project connected.");
  return count;
}

const actor = (req: Request) => ({ actorName: req.dbUser?.name ?? "Website editor", actorId: req.dbUser?.id });

type Access = {
  loadSite: (req: Request, id: string) => Promise<Site>;
  loadPage: (req: Request, id: string) => Promise<{ page: SitePage; site: Site }>;
};

export function registerWebsiteManagement(router: Router, access: Access) {
  const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => { void fn(req, res).catch(next); };

  router.get("/sites/:siteId/assets", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const assets = await prisma.siteAsset.findMany({ where: { siteId: site.id }, orderBy: { createdAt: "desc" }, select: { id: true, filename: true, repoPath: true, alt: true, contentType: true, createdAt: true } });
    res.json(assets.map(asset => ({ ...asset, url: assetUrl(site, asset.repoPath), preview: `/api/website/sites/${site.id}/assets/${asset.id}/content` })));
  }));
  router.get("/sites/:siteId/assets/:assetId/content", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const asset = await prisma.siteAsset.findFirst({ where: { id: req.params.assetId, siteId: site.id } });
    if (!asset) throw new WebsiteError(404, "That image is not part of this site.");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    if (asset.contentType === "image/svg+xml") res.setHeader("Content-Security-Policy", SVG_CONTENT_SECURITY_POLICY);
    // Published uploads can have their duplicate bytes swept from storage.
    // Their previews must use the published file instead of an empty image.
    if (!asset.content) {
      if (!asset.publishedAt) throw new WebsiteError(404, "That image is no longer available. Upload it again.");
      res.redirect(new URL(assetUrl(site, asset.repoPath), site.publicUrl).href);
      return;
    }
    res.type(asset.contentType).send(asset.content);
  }));
  router.post("/sites/:siteId/assets", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const input = z.object({ filename: z.string().min(1).max(200), data: z.string().max(15_000_000), alt: z.string().max(500).default("") }).parse(req.body);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new WebsiteError(400, "The image data is not valid base64.");
    const content = Buffer.from(input.data, "base64");
    const mime = sniff(content);
    const formats: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
    const svg = !mime && looksLikeSvg(content);
    if (!svg && (!mime || !formats[mime])) throw new WebsiteError(400, "Upload a PNG, JPEG, WebP, GIF or SVG image.");
    if (!content.length) throw new WebsiteError(400, "Choose a non-empty image file.");
    await assertMediaStorageAllowance(req, content.length, site.id);
    let optimized: Awaited<ReturnType<typeof optimizeImageBuffer>>;
    try {
      optimized = await optimizeImageBuffer(content);
    } catch (error) {
      if (error instanceof SvgRejected) throw new WebsiteError(400, error.message);
      throw error;
    }
    await assertMediaStorageAllowance(req, optimized.content.length, site.id);
    const asset = await prisma.$transaction(async tx => {
      const uploaded = await tx.siteAsset.create({ data: { siteId: site.id, filename: input.filename, repoPath: `assets/dw/${randomUUID()}.${optimized.extension}`, contentType: optimized.contentType, content: optimized.content, size: optimized.content.length, alt: input.alt } });
      await tx.siteAuditEvent.create({ data: { siteId: site.id, kind: "ASSET_UPLOAD", summary: `Uploaded ${input.filename}`, ...actor(req), detail: { assetId: uploaded.id, contentType: optimized.contentType, bytes: optimized.content.length, strippedExif: optimized.strippedExif } } });
      return uploaded;
    });
    recordMediaStorageAdded(req, optimized.content.length);
    res.status(201).json({ id: asset.id, url: assetUrl(site, asset.repoPath), alt: asset.alt, size: optimized.content.length });
  }));
  /**
   * Removing an uploaded image.
   *
   * There was no way to do this at all, so the table only ever grew — for every
   * customer, for ever. The gate already resolved `/assets/:id` to the `edit`
   * action, so the permission had been decided; only the endpoint was missing.
   *
   * **It refuses while an unpublished draft still points at the file**, which is
   * the one case where deleting does real damage: the draft would publish a page
   * referencing a picture this system no longer holds and can no longer commit,
   * and the customer would find out by looking at their live site. A reference
   * from an already-published page is not a reason to refuse — that file is in
   * their repository and stays there whatever happens to this row.
   */
  router.delete("/sites/:siteId/assets/:assetId", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const asset = await prisma.siteAsset.findFirst({ where: { id: req.params.assetId, siteId: site.id }, select: { id: true, filename: true, repoPath: true, size: true } });
    if (!asset) throw new WebsiteError(404, "That image is not part of this site.");

    // Page drafts *and* shared-element drafts — see `unpublishedUsesOf`, which
    // is where the rule and the reason for its second half live.
    const holding = await unpublishedUsesOf(site, asset.repoPath);
    if (holding.length) {
      throw new WebsiteError(
        409,
        `${asset.filename} is still used by an unpublished draft on ${holding.join(", ")}. Publish or discard ${holding.length === 1 ? "that draft" : "those drafts"} first, or change the picture there, and then delete it.`,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.siteAsset.delete({ where: { id: asset.id } });
      await tx.siteAuditEvent.create({ data: { siteId: site.id, kind: "ASSET_DELETED", summary: `Deleted ${asset.filename}`, ...actor(req), detail: { assetId: asset.id, repoPath: asset.repoPath, bytes: asset.size } } });
    });
    recordMediaStorageAdded(req, -asset.size);
    res.status(204).end();
  }));

  router.get("/sites/:siteId/audit", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const events = await prisma.siteAuditEvent.findMany({ where: { siteId: site.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 });
    res.json(events);
  }));

  router.post("/sites", handler(async (req, res) => {
    const input = siteInput.extend({ html: z.string().min(1).max(2_000_000).optional() }).parse(req.body);
    if (!!input.repoOwner !== !!input.repoName) throw new WebsiteError(400, "Enter both the repository owner and name.");
    const { html, ...data } = input;
    const external = Boolean(req.dbUser?.accessRole?.external);
    let owner: { clientId: string; userId: string; siteLimit: number } | null = null;
    if (external) {
      const entitlement = await resolveEntitlement(req);
      if (!entitlement.purchaseId || !entitlement.userId) throw new WebsiteError(402, "Buy a Website Builder plan before connecting a website.");
      const purchase = await prisma.websitePurchase.findUnique({ where: { id: entitlement.purchaseId }, select: { clientId: true, setupPaidAt: true, status: true } });
      if (!purchase?.setupPaidAt || !["ACTIVE", "READY", "SETUP_PAID", "SETUP_IN_PROGRESS"].includes(purchase.status)) throw new WebsiteError(402, "Payment must be verified before connecting a website.");
      if (data.repoOwner || data.repoName || data.clientId) throw new WebsiteError(403, "Connect a hosted website first. Attach your own GitHub installation from its settings.");
      owner = { clientId: purchase.clientId, userId: entitlement.userId, siteLimit: WEBSITE_TIER_PLANS[entitlement.tier].websiteLimit };
    }
    if (html) {
      await assertImportAllowance(req);
      importedWebsiteFields(html);
    }
    const site = await prisma.$transaction(async tx => {
      if (owner) {
        await tx.$queryRaw`SELECT "id" FROM "Client" WHERE "id" = ${owner.clientId} FOR UPDATE`;
        const used = await tx.site.count({ where: { clientId: owner.clientId } });
        if (used >= owner.siteLimit) throw new WebsiteError(403, `Your plan includes ${owner.siteLimit} website${owner.siteLimit === 1 ? "" : "s"}. Upgrade before connecting another.`);
      }
      return tx.site.create({ data: {
        ...data,
        ...(owner ? { clientId: owner.clientId, members: { create: { userId: owner.userId, role: "MANAGER" as const } } } : {}),
        slug: `${data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0,60) || "site"}-${randomUUID().slice(0,8)}`,
        ...(html ? { pages: { create: { title: data.name, path: "/", filePath: "index.html", sourceHtml: html } } } : {}),
        auditEvents: { create: { kind: "SITE_CONNECTED", summary: `Connected ${data.name}${html ? " with an imported page" : ""}`, ...actor(req), detail: { importedPage: Boolean(html) } } },
      }, include: { pages: { select: { id: true } } } });
    });
    if (html) {
      const capturedMedia = await captureHtmlImagesIntoMediaLibrary(req, site.id, html);
      if (capturedMedia.html !== html && site.pages[0]) await prisma.sitePage.update({ where: { id: site.pages[0].id }, data: { sourceHtml: capturedMedia.html } });
      await recordImportUsed(req);
    }
    res.status(201).json({ id: site.id, pageId: site.pages[0]?.id ?? null });
  }));

  router.get("/sites/:siteId/config", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    res.json({
      id: site.id, name: site.name, publicUrl: site.publicUrl,
      repoOwner: site.repoOwner, repoName: site.repoName, repoBranch: site.repoBranch, repoPath: site.repoPath,
      connectionEditable: canManageWebsiteConnection(req),
      // Which credential this site publishes with, and whether the customer has
      // taken it back. The installation id is not a secret — it is a number
      // GitHub puts in a redirect URL — and the key that uses it never leaves
      // the server.
      github: { installationId: site.githubInstallationId, repositoryId: site.githubRepositoryId, accessLostAt: site.githubAccessLostAt },
      clientId: site.clientId,
      options: websiteDesignOptions.parse(site.settings ?? {}),
    });
  }));

  router.get("/sites/:siteId/design", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const { colours, fonts, aiEnabled, presets } = websiteDesignOptions.parse(site.settings ?? {});
    res.json({ options: { colours, fonts, aiEnabled, presets } });
  }));

  router.put("/sites/:siteId/config", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const { options, ...data } = siteInput.extend({ options: websiteDesignOptions }).parse(req.body);
    assertWebsiteConnectionChange(req, site, data);
    if (!!data.repoOwner !== !!data.repoName) throw new WebsiteError(400, "Enter both the repository owner and name.");
    // Checked rather than left to the foreign key: a client id that does not
    // exist should read as "that client is not here", not as a 500.
    if (data.clientId && !(await prisma.client.findUnique({ where: { id: data.clientId }, select: { id: true } }))) {
      throw new WebsiteError(400, "That client is not in the system.");
    }
    const previousOptions = websiteDesignOptions.parse(site.settings ?? {});
    const optionsChanged = Object.keys(options).filter(key => JSON.stringify(options[key as keyof typeof options]) !== JSON.stringify(previousOptions[key as keyof typeof previousOptions]));
    if (optionsChanged.length > 0) {
      await assertTierFeatureAccess(req, "themeSettings", site.id);
    }
    const changed = [
      ...Object.keys(data).filter(key => data[key as keyof typeof data] !== site[key as keyof Site]),
      ...optionsChanged.map(key => `options.${key}`),
    ];
    if (changed.length) await prisma.$transaction([
      prisma.site.update({ where: { id: site.id }, data: { ...data, settings: options } }),
      prisma.siteAuditEvent.create({ data: { siteId: site.id, kind: "SETTINGS_UPDATED", summary: `Updated website settings: ${changed.map(key => key.replace("options.", "")).join(", ")}`, ...actor(req), detail: { changed } } }),
    ]);
    res.json({ saved: true });
  }));

  router.post("/sites/:siteId/import", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    await assertImportAllowance(req, site.id);
    const body = z.object({ title: z.string().trim().min(1).max(120), filePath: z.string().regex(/^[a-zA-Z0-9_/-]+\.html$/).max(200), path: z.string().regex(/^\/[a-zA-Z0-9_/-]*$/).max(200), html: z.string().min(1).max(2_000_000) }).parse(req.body);
    const count = importedWebsiteFields(body.html);
    const capturedMedia = await captureHtmlImagesIntoMediaLibrary(req, site.id, body.html);
    const page = await prisma.$transaction(async tx => {
      if (await tx.sitePage.findFirst({ where: { siteId: site.id, OR: [{ filePath: body.filePath }, { path: body.path }] }, select: { id: true } })) throw new WebsiteError(409, "A page already uses that address or file path. Choose a different page address and file name.");
      const imported = await tx.sitePage.create({ data: { siteId: site.id, title: body.title, filePath: body.filePath, path: body.path, sourceHtml: capturedMedia.html } });
      await tx.siteAuditEvent.create({ data: { siteId: site.id, kind: "PAGE_IMPORTED", summary: `Imported ${body.title}`, ...actor(req), detail: { pageId: imported.id, filePath: body.filePath, path: body.path, fields: count, capturedMediaCount: capturedMedia.capturedCount, capturedMediaBytes: capturedMedia.totalBytesAdded } } });
      return imported;
    }).catch(error => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new WebsiteError(409, "A page already uses that address or file path. Choose a different page address and file name.");
      throw error;
    });
    await recordImportUsed(req);
    const { html: _html, ...captureSummary } = capturedMedia;
    res.status(201).json({ id: page.id, fields: count, capturedMedia: captureSummary });
  }));

  router.get("/pages/:pageId/review", handler(async (req, res) => {
    const { page, site } = await access.loadPage(req, req.params.pageId);
    const source = await pageSource(site, page, { fresh: true });
    const values = (page.draft ?? {}) as Record<string, import("./website/index.js").FieldValue>;
    const plan = buildPublishPlan({ source: source.html, values });
    res.json({ revision: page.draftRevision, sourceHash: createHash("sha256").update(source.html).digest("hex"), publishable: plan.publishable, reason: plan.reason, summary: describeChanges(discoverFields(editingSource(source.html, values)).fields, values), problems: plan.problems, conflicts: plan.conflicts, missing: plan.missing });
  }));

  router.get("/pages/:pageId/export", handler(async (req, res) => {
    const { page, site } = await access.loadPage(req, req.params.pageId);
    const source = await pageSource(site, page, { fresh: true });
    const values = (page.draft ?? {}) as Record<string, import("./website/index.js").FieldValue>;
    const plan = Object.keys(values).length ? buildPublishPlan({ source: source.html, values }) : null;
    if (plan && (plan.conflicts.length || plan.missing.length || plan.problems.length)) throw new WebsiteError(409, "Resolve the draft's conflicts and validation problems before exporting.");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.setHeader("Content-Disposition", `attachment; filename="${page.filePath.split("/").pop()?.replace(/[^a-zA-Z0-9_.-]/g,"_") || "page.html"}"`);
    res.type("text/html").send(await embedWebsiteAssets(site, plan?.html ?? source.html));
  }));
}
