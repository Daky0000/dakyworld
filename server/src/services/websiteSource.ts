import { createHash } from "node:crypto";
import type { Request, Response, Router } from "express";
import type { Site } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { commitFiles, listTree, readFile } from "../lib/github.js";
import { applyJsxValues, applyMarkdownValues, applyTemplateValues, discoverJsxFields, discoverMarkdownFields, discoverTemplateFields, EDITABLE_SOURCE_EXTENSIONS, isEditableSourcePath, isMarkdownPath, isTemplatePath, markdownStructureNodes, replayMarkdownStructure, MARKDOWN_STRUCTURE_VERSION, templateStructureNodes, replayTemplateStructure, TEMPLATE_STRUCTURE_VERSION, jsxStructureNodes, replayJsxStructure, JsxStructureError, applySourceStyles, sourceStyleState, SOURCE_STYLE_VERSION, type SourceStyleEdit, type SourceStyleState, JSX_STRUCTURE_VERSION, type JsxStructureAction, type JsxStructureNode } from "./website/index.js";
import { siteRepo, WebsiteError } from "./website/site.js";
import { invalidateRender, publicFolder } from "./website/index.js";
import { invalidateSource } from "./website/sourceCache.js";
import { assetUrl } from "./websiteAssets.js";
import { failPublishJob, sourcePublishCommitted, startPublishJob } from "./websitePublishJobs.js";
import { assertWebsiteSiteAccess, type WebsiteAction } from "./websiteAccess.js";

const MAX_SOURCE_BYTES = 2_000_000;
const EXCLUDED_FOLDERS = new Set(["node_modules", ".git", ".next", ".nuxt", "dist", "build", "coverage"]);
const structureAction = z.object({
  kind: z.enum(["remove", "duplicate", "before", "after"]),
  nodeId: z.string().min(1).max(120),
  targetId: z.string().min(1).max(120).optional(),
}).strict();
/** Layout actions replay in order against the file on the branch, and the words
 * are written into the result. A browser sends identities, never offsets. */
const changeObject = z.object({
  filePath: z.string().min(1).max(500),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  structure: z.array(structureAction).max(100).default([]),
  styles: z.array(z.object({ nodeId: z.string().min(1).max(120), style: z.string().max(4_000) }).strict()).max(200).default([]),
  changes: z.array(z.object({ fieldId: z.string().min(1).max(120), value: z.string().max(100_000) }).strict()).max(500).default([]),
}).strict();
const atLeastOne = (input: { structure: unknown[]; changes: unknown[]; styles: unknown[] }) => input.structure.length + input.changes.length + input.styles.length > 0;
const ONE_EDIT = { message: "Submit at least one layout action, style or field change." };
const changeInput = changeObject.refine(atLeastOne, ONE_EDIT);
const publishInput = changeObject.extend({ reviewHash: z.string().regex(/^[a-f0-9]{64}$/) }).refine(atLeastOne, ONE_EDIT);
export type WebsiteSourceEdit = { filePath: string; sourceHash: string; structure?: readonly JsxStructureAction[]; styles?: readonly SourceStyleEdit[]; changes?: readonly { fieldId: string; value: string }[] };

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
type SourceDiscovery = ReturnType<typeof discoverJsxFields> | ReturnType<typeof discoverTemplateFields> | ReturnType<typeof discoverMarkdownFields>;
type SourceApply = ReturnType<typeof applyJsxValues> | ReturnType<typeof applyTemplateValues> | ReturnType<typeof applyMarkdownValues>;
export type SourceAdapter = {
  discover(source: string, filePath: string): SourceDiscovery;
  apply(source: string, request: { filePath: string; sourceHash: string; changes: readonly { fieldId: string; value: string }[] }): SourceApply;
  /** Blocks a person may rearrange. Absent while a language has no layout engine
   * yet, which is the difference between "nothing to move" and "not built". */
  blocks?(source: string, filePath: string): JsxStructureNode[];
  replay?(source: string, filePath: string, actions: readonly JsxStructureAction[]): { source: string; summary: string[] };
  structureAdapter?: string;
  /** Absent for a language whose appearance is not an element attribute. */
  styles?(source: string, filePath: string): SourceStyleState[];
  restyle?(source: string, filePath: string, edits: readonly SourceStyleEdit[]): { source: string; changed: string[]; summary: string[] };
  styleAdapter?: string;
};
export function sourceAdapterFor(filePath: string): SourceAdapter {
  if (isMarkdownPath(filePath)) return { discover: discoverMarkdownFields, apply: applyMarkdownValues, blocks: markdownStructureNodes, replay: replayMarkdownStructure, structureAdapter: MARKDOWN_STRUCTURE_VERSION };
  if (isTemplatePath(filePath)) return { discover: discoverTemplateFields, apply: applyTemplateValues, blocks: templateStructureNodes, replay: replayTemplateStructure, structureAdapter: TEMPLATE_STRUCTURE_VERSION, styles: sourceStyleState, restyle: applySourceStyles, styleAdapter: SOURCE_STYLE_VERSION };
  return { discover: discoverJsxFields, apply: applyJsxValues, blocks: jsxStructureNodes, replay: replayJsxStructure, structureAdapter: JSX_STRUCTURE_VERSION, styles: sourceStyleState, restyle: applySourceStyles, styleAdapter: SOURCE_STYLE_VERSION };
}
/**
 * Blocks for the browser: identities, reasons and current styling, never source
 * offsets.
 *
 * The style a block already carries is merged in here rather than sent as a
 * second list, because the panel needs one row per block: what it is, whether it
 * can be moved, whether it can be restyled, and what it is wearing. Two lists
 * keyed by the same ID would only be joined again on the other side.
 */
function blocksOf(adapter: SourceAdapter, source: string, filePath: string) {
  if (!adapter.blocks) return [];
  try {
    const styles = new Map<string, SourceStyleState>();
    if (adapter.styles) { try { for (const entry of adapter.styles(source, filePath)) styles.set(entry.nodeId, entry); } catch { /* a style read failing must not hide the layout */ } }
    return adapter.blocks(source, filePath).map(({ start: _start, end: _end, ...node }) => {
      const style = styles.get(node.id);
      return { ...node, style: style?.style ?? "", styleable: Boolean(style && !style.reason), ...(style?.reason && { styleReason: style.reason }) };
    });
  } catch { return []; }
}

export function reviewWebsiteSource(source: string, request: WebsiteSourceEdit) {
  const input = { ...request, structure: request.structure ?? [], styles: request.styles ?? [], changes: request.changes ?? [] };
  const adapter = sourceAdapterFor(input.filePath);
  const base = adapter.discover(source, input.filePath);
  // Checked here rather than left to the adapter, because a layout action moves
  // the bytes the field edits are then measured against: by the time the values
  // are applied, the hash they were prepared for is no longer the file's.
  if (base.sourceHash !== input.sourceHash) throw new WebsiteError(409, "The source file changed after these edits were prepared. Reload it and review the edits again.");
  /**
   * Words first, then layout — and the order is the whole safety argument.
   *
   * A field ID is derived from where its element sits, so removing the first of
   * two sections renumbers the second into the first one's ID. Writing the
   * values afterwards would hand an edit prepared for the block that went away
   * to the block that took its place, silently and with a green review. Applied
   * against the file the browser actually read, every ID means what it meant
   * when somebody typed into it, and the layout actions then move finished text.
   *
   * The cost is that a block created by a duplicate in this same pass has no
   * fields to edit until it has been published once. That is a smaller thing to
   * explain than an edit that lands on the wrong heading.
   */
  const applied = adapter.apply(source, { filePath: input.filePath, sourceHash: base.sourceHash, changes: input.changes });
  if (applied.problems.length) throw new WebsiteError(applied.problems.some(problem => problem.code === "stale") ? 409 : 400, applied.problems.map(problem => problem.message).join(" "));
  let output = applied.source;
  let layout: string[] = [];
  // Styles are attribute edits on the same blocks the layout acts on, so they
  // run in the middle: after the words, which do not move anything, and before
  // the blocks move, while every block ID still means what the browser was shown.
  if (input.styles.length) {
    if (!adapter.restyle) throw new WebsiteError(409, "Blocks in this kind of file cannot be restyled from the editor.");
    try { const restyled = adapter.restyle(output, input.filePath, input.styles); output = restyled.source; layout = restyled.summary; }
    catch (error) { throw error instanceof JsxStructureError ? new WebsiteError(409, error.message) : error; }
  }
  if (input.structure.length) {
    if (!adapter.replay) throw new WebsiteError(409, "Blocks in this kind of file cannot be rearranged from the editor yet.");
    try { const replayed = adapter.replay(output, input.filePath, input.structure); output = replayed.source; layout = [...layout, ...replayed.summary]; }
    catch (error) { throw error instanceof JsxStructureError ? new WebsiteError(409, error.message) : error; }
  }
  if (!applied.changed.length && !layout.length) throw new WebsiteError(400, "There are no changed values to review.");
  const wanted = new Map(input.changes.map(change => [change.fieldId, change.value]));
  const changes = base.fields.filter(field => applied.changed.includes(field.id)).map(field => ({ fieldId: field.id, label: field.label, kind: field.kind, before: field.value, after: wanted.get(field.id)! }));
  // Binds the reviewed output to the exact input file and source bytes, layout
  // actions included. No offsets or markup supplied by a browser are trusted.
  const reviewHash = digest(JSON.stringify([base.adapter, adapter.structureAdapter ?? null, adapter.styleAdapter ?? null, input.filePath, base.sourceHash, output]));
  return { source: output, sourceHash: base.sourceHash, reviewHash, changes, layout };
}

type Access = { loadSite(req: Request, id: string): Promise<Site> };
type Dependencies = {
  read: typeof readFile;
  list: typeof listTree;
  commit: typeof commitFiles;
  authorize(req: Request, siteId: string, action: WebsiteAction): Promise<unknown>;
  /**
   * Records the publish, and then whether the world can see it.
   *
   * A framework host builds the project before anybody sees the change, so
   * "committed" and "live" are minutes apart and a build can fail in between.
   * Returning success and leaving the customer to refresh is the silence the
   * publish jobs exist to end — see `websitePublishJobs.ts`.
   */
  /**
   * The images this file now points at, as files to commit beside it.
   *
   * An image uploaded in the editor lives in the database until something
   * publishes it. On an HTML page that happens when the page is published; a
   * source file needs the same, or somebody pastes an uploaded image into a
   * `src` field, publishes, and gets a broken picture with no clue why.
   */
  assets(input: { site: Site; source: string }): Promise<Array<{ path: string; content: string; encoding: "base64" }>>;
  track(input: { site: Site; filePath: string; startedById?: string }): Promise<{ id: string } | null>;
  tracked(input: { id: string; site: Site; filePath: string; commit: { sha: string; url: string }; changes: Array<{ before: string; after: string }> }): Promise<void>;
  trackFailed(input: { id: string; message: string }): Promise<void>;
  audit(input: { siteId: string; actorId?: string; actorName: string; filePath: string; sourceHash: string; resultHash: string; fields: number; commitSha: string; commitUrl: string }): Promise<void>;
};
const dependencies: Dependencies = {
  read: readFile, list: listTree, commit: commitFiles, authorize: assertWebsiteSiteAccess,
  assets: async ({ site, source }) => {
    const uploaded = await prisma.siteAsset.findMany({ where: { siteId: site.id } });
    // The framework's own static folder, not the site's page folder: a build
    // copies `public/` to the root, and an image committed anywhere else is a
    // file in the repository that the built site cannot see.
    const folder = publicFolder(site.sourceKind);
    return uploaded
      .filter((asset) => source.includes(assetUrl(site, asset.repoPath)))
      .map((asset) => ({ path: [folder, asset.repoPath].filter(Boolean).join("/"), content: Buffer.from(asset.content).toString("base64"), encoding: "base64" as const }));
  },
  track: async ({ site, filePath, startedById }) => startPublishJob({ site, kind: "PAGE", startedById, detail: { filePath, source: true } }),
  tracked: async ({ id, site, filePath, commit, changes }) => {
    // The route file the scan listed, where it listed one: its address is what a
    // verification has to look at, and a source file has no address of its own.
    const page = await prisma.sitePage.findFirst({ where: { siteId: site.id, filePath } });
    await sourcePublishCommitted({ id, commit, site, page, changes });
  },
  trackFailed: async ({ id, message }) => failPublishJob(id, "COMMIT_FAILED", message),
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
    const adapter = sourceAdapterFor(current.path.relative);
    const discovery = adapter.discover(current.content, current.path.relative);
    const blocks = blocksOf(adapter, current.content, current.path.relative);
    res.setHeader("Cache-Control", "no-store");
    res.json({ adapter: discovery.adapter, structureAdapter: adapter.structureAdapter ?? null, styleAdapter: adapter.styleAdapter ?? null, filePath: discovery.filePath, sourceHash: discovery.sourceHash, issues: discovery.issues, fields: discovery.fields.map(({ reference: _reference, ...field }) => field), blocks, repo: current.repo, branch: current.site.repoBranch });
  }));
  /**
   * The file as the queued layout actions leave it, before anything is written.
   *
   * A layout action moves the bytes every field ID is derived from, so after one
   * the browser's list of fields and blocks describes a file that no longer
   * exists. It could not recompute them itself without holding the source and
   * the parser, which is the thing this design refuses to let it do — so it asks
   * here instead, and gets back the identities for the state it is showing.
   *
   * The fields it returns are the file's own, not the rearranged file's, because
   * that is the state the values are written against — see `reviewWebsiteSource`
   * for why the order is words first. The blocks are the rearranged file's, since
   * that is what the next layout action will act on.
   *
   * `droppedChanges` is the honest half: an edit whose field is no longer in the
   * file — because a developer changed it underneath — is named here rather than
   * failing a whole review later with "this field is absent".
   */
  router.post("/sites/:siteId/source/preview", handler(async (req, res) => {
    const input = changeObject.parse(req.body);
    const current = await source(req, input.filePath);
    const adapter = sourceAdapterFor(current.path.relative);
    const base = adapter.discover(current.content, current.path.relative);
    if (base.sourceHash !== input.sourceHash) throw new WebsiteError(409, "The source file changed after these edits were prepared. Reload it and review the edits again.");
    let content = current.content;
    let layout: string[] = [];
    if (input.styles.length) {
      if (!adapter.restyle) throw new WebsiteError(409, "Blocks in this kind of file cannot be restyled from the editor.");
      try { const restyled = adapter.restyle(content, current.path.relative, input.styles); content = restyled.source; layout = restyled.summary; }
      catch (error) { throw error instanceof JsxStructureError ? new WebsiteError(409, error.message) : error; }
    }
    if (input.structure.length) {
      if (!adapter.replay) throw new WebsiteError(409, "Blocks in this kind of file cannot be rearranged from the editor yet.");
      try { const replayed = adapter.replay(content, current.path.relative, input.structure); content = replayed.source; layout = [...layout, ...replayed.summary]; }
      catch (error) { throw error instanceof JsxStructureError ? new WebsiteError(409, error.message) : error; }
    }
    const present = new Set(base.fields.map(field => field.id));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      adapter: base.adapter, structureAdapter: adapter.structureAdapter ?? null, styleAdapter: adapter.styleAdapter ?? null, filePath: current.path.relative,
      sourceHash: base.sourceHash, issues: base.issues, layout,
      fields: base.fields.map(({ reference: _reference, ...field }) => field),
      blocks: blocksOf(adapter, content, current.path.relative),
      droppedChanges: input.changes.filter(change => !present.has(change.fieldId)).map(change => change.fieldId),
      repo: current.repo, branch: current.site.repoBranch,
    });
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
    // Opened before GitHub is touched, for the same reason the page publish does
    // it: a process that dies mid-commit has to leave a row somebody can ask
    // about, not a repository that is ahead of everything that knows about it.
    const job = await deps.track({ site: current.site, filePath: current.path.relative, startedById: req.dbUser?.id }).catch(() => null);
    let result: { sha: string; url: string };
    try {
      const images = await deps.assets({ site: current.site, source: review.source }).catch(() => []);
      result = await deps.commit({
        repo: current.repo,
        branch: current.site.repoBranch,
        message: `Website editor: update ${current.path.relative}`,
        // One commit, the file and the pictures it needs together. Two commits
        // would leave a minute in which the page is live and its images are not.
        files: [{ path: current.path.repository, content: review.source }, ...images],
        // Only the source file is guarded: an image is new bytes at a new path,
        // and demanding it be absent would fail a re-publish of the same picture.
        expectedFiles: [{ path: current.path.repository, content: current.content }],
      });
    } catch (error) {
      if (job) await deps.trackFailed({ id: job.id, message: error instanceof Error ? error.message : "The commit did not land." }).catch(() => undefined);
      throw error;
    }
    // Both caches for this file: the bytes themselves, and the built page they
    // produce. Left behind, the next open shows the version from before the
    // commit and the reload meant to confirm the publish confirms the opposite.
    invalidateSource(current.site.id, current.path.relative);
    invalidateRender(current.site, { filePath: current.path.relative });
    if (job) await deps.tracked({ id: job.id, site: current.site, filePath: current.path.relative, commit: result, changes: review.changes }).catch((error: unknown) => console.error("Source published but the publish job could not be updated", { jobId: job.id, error }));
    // A committed change must never be described as failed just because the
    // secondary audit write failed. GitHub's commit remains the durable record.
    let auditRecorded = true;
    try { await deps.audit({ siteId: current.site.id, actorId: req.dbUser?.id, actorName: req.dbUser?.name ?? "Website editor", filePath: current.path.relative, sourceHash: review.sourceHash, resultHash: digest(review.source), fields: review.changes.length, commitSha: result.sha, commitUrl: result.url }); }
    catch (error) { auditRecorded = false; console.error("Website source published but local audit write failed", { siteId: current.site.id, sha: result.sha, error }); }
    res.json({ ...result, auditRecorded, jobId: job?.id ?? null, message: "Source committed. Your host is building this branch now — the change is live once that build finishes, and Updates will say when it is." });
  }));
}
