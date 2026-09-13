import { createHash } from "node:crypto";
import type { Request, Response, Router } from "express";
import type { Site } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { commitFiles, listTree, readFile } from "../lib/github.js";
import { applyJsxValues, applyTemplateValues, discoverJsxFields, discoverTemplateFields, EDITABLE_SOURCE_EXTENSIONS, isEditableSourcePath, isTemplatePath } from "./website/index.js";
import { siteRepo, WebsiteError } from "./website/site.js";
import { assertWebsiteSiteAccess, type WebsiteAction } from "./websiteAccess.js";

const MAX_SOURCE_BYTES = 2_000_000;
const EXCLUDED_FOLDERS = new Set(["node_modules", ".git", ".next", ".nuxt", "dist", "build", "coverage"]);
const changeInput = z.object({
  filePath: z.string().min(1).max(500),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z.array(z.object({ fieldId: z.string().min(1).max(120), value: z.string().max(100_000) }).strict()).min(1).max(500),
}).strict();
const publishInput = changeInput.extend({ reviewHash: z.string().regex(/^[a-f0-9]{64}$/) });

/** Relative to the site's configured repository folder, including browse calls. */
export function websiteSourcePath(folder: string, path: string, file = false): { relative: string; repository: string } {
  const normalize = (value: string) => value.replace(/\\/g, "/");
  const valid = (value: string) => !value.startsWith("/") && !/[:\x00-\x1f\x7f?#]/.test(value) && value.split("/").every(part => part && part !== "." && part !== ".." && !EXCLUDED_FOLDERS.has(part));
  const prefix = normalize(folder).replace(/\/+$/, "");
  const relative = normalize(path);
  if ((prefix && !valid(prefix)) || (relative && !valid(relative)) || (file && !isEditableSourcePath(relative))) throw new WebsiteError(400, `Choose a ${EDITABLE_SOURCE_EXTENSIONS.join(", ")} file inside this website's repository folder.`);
  return { relative, repository: [prefix, relative].filter(Boolean).join("/") };
}

function digest(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }

/**
 * The adapter that reads and writes this file's fields.
 *
 * One lookup, by extension, and every caller below goes through it. The HTTP
 * contract does not change with the answer: a `.vue` file is reviewed,
 * exported, committed and audited down exactly the same path a `.tsx` is, and
 * only the parser behind it differs. See `website/frameworks.ts`.
 */
export function sourceAdapterFor(filePath: string) {
  return isTemplatePath(filePath)
    ? { discover: discoverTemplateFields, apply: applyTemplateValues }
    : { discover: discoverJsxFields, apply: applyJsxValues };
}

export function reviewWebsiteSource(source: string, input: z.infer<typeof changeInput>) {
  const adapter = sourceAdapterFor(input.filePath);
  const discovery = adapter.discover(source, input.filePath);
  const applied = adapter.apply(source, input);
  if (applied.problems.length) throw new WebsiteError(applied.problems.some(problem => problem.code === "stale") ? 409 : 400, applied.problems.map(problem => problem.message).join(" "));
  if (!applied.changed.length) throw new WebsiteError(400, "There are no changed values to review.");
  const wanted = new Map(input.changes.map(change => [change.fieldId, change.value]));
  const changes = discovery.fields.filter(field => applied.changed.includes(field.id)).map(field => ({ fieldId: field.id, label: field.label, kind: field.kind, before: field.value, after: wanted.get(field.id)! }));
  // Binds the reviewed output to the exact input file and source bytes. No source
  // offsets or replacement snippets supplied by a browser are ever trusted.
  const reviewHash = digest(JSON.stringify([discovery.adapter, input.filePath, discovery.sourceHash, applied.source]));
  return { source: applied.source, sourceHash: discovery.sourceHash, reviewHash, changes };
}

type Access = { loadSite(req: Request, id: string): Promise<Site> };
type Dependencies = {
  read: typeof readFile;
  list: typeof listTree;
  commit: typeof commitFiles;
  authorize(req: Request, siteId: string, action: WebsiteAction): Promise<unknown>;
  audit(input: { siteId: string; actorId?: string; actorName: string; filePath: string; sourceHash: string; resultHash: string; fields: number; commitSha: string; commitUrl: string }): Promise<void>;
};
const dependencies: Dependencies = {
  read: readFile, list: listTree, commit: commitFiles, authorize: assertWebsiteSiteAccess,
  audit: async ({ siteId, actorId, actorName, filePath, ...detail }) => {
    await prisma.siteAuditEvent.create({ data: { siteId, actorId, actorName, kind: "SOURCE_PUBLISH", summary: `Published ${filePath}`, detail: { filePath, ...detail } } });
  },
};

/**
 * Site-scoped source content workflow. Never builds or executes a project.
 *
 * Which syntax a file is written in is decided per file, not per site, so a
 * repository holding both `.tsx` components and `.astro` pages edits either
 * without a setting being changed anywhere.
 */
export function registerWebsiteSource(router: Router, access: Access, overrides: Partial<Dependencies> = {}) {
  const deps = { ...dependencies, ...overrides };
  const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => { void fn(req, res).catch(next); };
  const load = async (req: Request) => {
    const site = await access.loadSite(req, req.params.siteId);
    await deps.authorize(req, site.id, "source");
    const repo = siteRepo(site);
    if (!repo) throw new WebsiteError(409, "Connect this site's GitHub repository in Website settings to edit source files.");
    return { site, repo };
  };
  const source = async (req: Request, filePath: string) => {
    const { site, repo } = await load(req);
    const path = websiteSourcePath(site.repoPath, filePath, true);
    const content = await deps.read(repo, path.repository, site.repoBranch);
    if (content === null) throw new WebsiteError(404, "That source file is not on this site's configured branch. Browse the repository again.");
    if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_BYTES) throw new WebsiteError(413, "This source file exceeds the 2 MB editing limit.");
    return { site, repo, path, content };
  };

  router.get("/sites/:siteId/source/files", handler(async (req, res) => {
    const { site, repo } = await load(req);
    const path = websiteSourcePath(site.repoPath, z.string().max(500).parse(req.query.path ?? ""));
    const entries = await deps.list(repo, path.repository, site.repoBranch);
    const prefix = site.repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const files = entries.flatMap(entry => {
      if (prefix && !entry.path.startsWith(`${prefix}/`)) return [];
      const relative = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
      try { websiteSourcePath(site.repoPath, relative, entry.type === "file"); } catch { return []; }
      if (entry.type !== "dir" && entry.type !== "file") return [];
      return [{ path: relative, name: relative.split("/").at(-1)!, type: entry.type, size: entry.size, editable: entry.type === "file" && entry.size <= MAX_SOURCE_BYTES }];
    });
    files.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
    res.json({ repo, branch: site.repoBranch, root: site.repoPath, path: path.relative, files });
  }));
  router.get("/sites/:siteId/source", handler(async (req, res) => {
    const filePath = z.string().min(1).max(500).parse(req.query.filePath);
    const current = await source(req, filePath);
    const discovery = sourceAdapterFor(current.path.relative).discover(current.content, current.path.relative);
    res.setHeader("Cache-Control", "no-store");
    res.json({ adapter: discovery.adapter, filePath: discovery.filePath, sourceHash: discovery.sourceHash, issues: discovery.issues, fields: discovery.fields.map(({ reference: _reference, ...field }) => field), repo: current.repo, branch: current.site.repoBranch });
  }));
  router.post("/sites/:siteId/source/review", handler(async (req, res) => {
    const input = changeInput.parse(req.body);
    const current = await source(req, input.filePath);
    const { source: _source, ...review } = reviewWebsiteSource(current.content, { ...input, filePath: current.path.relative });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...review, filePath: current.path.relative, repo: current.repo, branch: current.site.repoBranch });
  }));
  router.post("/sites/:siteId/source/export", handler(async (req, res) => {
    const input = changeInput.parse(req.body);
    const current = await source(req, input.filePath);
    const review = reviewWebsiteSource(current.content, { ...input, filePath: current.path.relative });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="${current.path.relative.split("/").at(-1)!.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`);
    res.type("text/plain").send(review.source);
  }));
  router.post("/sites/:siteId/source/publish", handler(async (req, res) => {
    const input = publishInput.parse(req.body);
    const current = await source(req, input.filePath);
    await deps.authorize(req, current.site.id, "publish");
    const review = reviewWebsiteSource(current.content, { ...input, filePath: current.path.relative });
    if (review.reviewHash !== input.reviewHash) throw new WebsiteError(409, "These edits differ from the reviewed changes. Review them again before publishing.");
    const result = await deps.commit({ repo: current.repo, branch: current.site.repoBranch, message: `Website editor: update ${current.path.relative}`, files: [{ path: current.path.repository, content: review.source }], expectedFiles: [{ path: current.path.repository, content: current.content }] });
    // A committed change must never be described as failed just because the
    // secondary audit write failed. GitHub's commit remains the durable record.
    let auditRecorded = true;
    try { await deps.audit({ siteId: current.site.id, actorId: req.dbUser?.id, actorName: req.dbUser?.name ?? "Website editor", filePath: current.path.relative, sourceHash: review.sourceHash, resultHash: digest(review.source), fields: review.changes.length, commitSha: result.sha, commitUrl: result.url }); }
    catch (error) { auditRecorded = false; console.error("Website source published but local audit write failed", { siteId: current.site.id, sha: result.sha, error }); }
    res.json({ ...result, auditRecorded, message: "Source committed. Your connected host still needs to build and deploy this branch." });
  }));
}
