import { githubRead, repoFullName } from "../../lib/github.js";
import { HostApiError, hostCall, pause } from "./hostApi.js";
import { sha1, type ChangedFile } from "./directNetlify.js";

/**
 * Route A for Vercel: a production deployment made from the files themselves,
 * through the customer's own Vercel Integration.
 *
 * Vercel's file listing is not dependable for a deployment that came from Git,
 * so the file list comes from the repository instead: the tree at the commit
 * just made is exactly what Vercel's own Git deploy would have received, for a
 * project it does not build. Vercel deduplicates by SHA-1, so only files it
 * does not already hold are uploaded. Working out each file's SHA-1 needs its
 * bytes, so the digests are kept per site (`manifest`, keyed by Git blob id):
 * after the first deploy only the files the publish changed are read at all.
 *
 * Only for a project with no framework and no build command. Anything else,
 * and the uploaded files would not be what Vercel's build makes.
 */

const API = "https://api.vercel.com";
const READY_WAIT_MS = 55_000;
const MAX_FILES = 5_000;

export type VercelManifest = Record<string, { git: string; sha: string; size: number }>;
type VercelProject = { id: string; name: string; framework?: string | null; buildCommand?: string | null; outputDirectory?: string | null; link?: { type?: string; repo?: string; org?: string; repoId?: number } | null; targets?: { production?: { alias?: string[] } } };
type VercelDeployment = { id: string; url?: string; readyState?: string; errorMessage?: string | null; alias?: string[] };

const team = (teamId: string | null) => (teamId ? `teamId=${encodeURIComponent(teamId)}` : "");
const withTeam = (path: string, teamId: string | null) => `${API}${path}${team(teamId) ? `${path.includes("?") ? "&" : "?"}${team(teamId)}` : ""}`;

export async function vercelProject(token: string, projectId: string, teamId: string | null): Promise<VercelProject> {
  return hostCall<VercelProject>("Vercel", withTeam(`/v9/projects/${encodeURIComponent(projectId)}`, teamId), { token });
}

export async function vercelProjects(token: string, teamId: string | null): Promise<VercelProject[]> {
  const body = await hostCall<{ projects?: VercelProject[] }>("Vercel", withTeam("/v9/projects?limit=100", teamId), { token });
  return body.projects ?? [];
}

export async function vercelProjectDomains(token: string, projectId: string, teamId: string | null): Promise<string[]> {
  const body = await hostCall<{ domains?: Array<{ name: string }> }>("Vercel", withTeam(`/v9/projects/${encodeURIComponent(projectId)}/domains`, teamId), { token }).catch(() => ({ domains: [] }));
  return (body.domains ?? []).map((domain) => domain.name);
}

/** `.vercelignore`, read the simple way: names, folders and `*.ext`. */
export function ignoredBy(rules: string[]): (path: string) => boolean {
  const patterns = rules.map((rule) => rule.trim()).filter((rule) => rule && !rule.startsWith("#"));
  return (path: string) =>
    path.startsWith(".git/") || path.startsWith("node_modules/") || path === ".vercel" || path.startsWith(".vercel/") ||
    patterns.some((rule) => {
      const clean = rule.replace(/^\/+/, "").replace(/\/+$/, "");
      if (clean.startsWith("*.")) return path.endsWith(clean.slice(1));
      return path === clean || path.startsWith(`${clean}/`);
    });
}

export async function deployToVercel(input: {
  token: string;
  projectId: string;
  teamId: string | null;
  repo: string;
  commitSha: string;
  changed: ChangedFile[];
  manifest: VercelManifest;
}): Promise<{ deploymentId: string; url: string | null; uploaded: number; manifest: VercelManifest }> {
  const project = await vercelProject(input.token, input.projectId, input.teamId);
  if (project.framework || project.buildCommand) {
    throw new HostApiError("Vercel", 409, "Vercel builds this project, so a direct upload would not match what the build makes.");
  }

  const full = await repoFullName(input.repo);
  const tree = await githubRead<{ tree?: Array<{ path: string; type: string; sha: string; size?: number }>; truncated?: boolean }>(`/repos/${full}/git/trees/${input.commitSha}?recursive=1`);
  if (tree.truncated) throw new HostApiError("Vercel", 409, "This repository is too large to upload directly.");
  const changedBytes = new Map(input.changed.filter((file) => file.content).map((file) => [file.path.replace(/^\/+/, ""), file.content!]));
  let ignoreText = changedBytes.get(".vercelignore")?.toString("utf8") ?? null;
  const ignoreEntry = (tree.tree ?? []).find((entry) => entry.path === ".vercelignore");
  if (ignoreText === null && ignoreEntry) {
    const raw = await githubRead<{ content: string; encoding: string }>(`/repos/${full}/git/blobs/${ignoreEntry.sha}`);
    ignoreText = Buffer.from(raw.content, raw.encoding as BufferEncoding).toString("utf8");
  }
  const ignore = ignoredBy((ignoreText ?? "").split("\n"));
  const blobs = (tree.tree ?? []).filter((entry) => entry.type === "blob" && !ignore(entry.path));
  if (blobs.length > MAX_FILES) throw new HostApiError("Vercel", 409, `This repository has ${blobs.length} files, more than a direct upload is used for.`);

  // SHA-1s, from the manifest where the blob has not changed, from the bytes otherwise.
  const manifest: VercelManifest = {};
  const bytes = new Map<string, Buffer>();
  for (const blob of blobs) {
    const known = input.manifest[blob.path];
    if (known && known.git === blob.sha) {
      manifest[blob.path] = known;
      continue;
    }
    let content = changedBytes.get(blob.path);
    if (!content) {
      const raw = await githubRead<{ content: string; encoding: string }>(`/repos/${full}/git/blobs/${blob.sha}`);
      content = Buffer.from(raw.content, raw.encoding as BufferEncoding);
    }
    const digest = sha1(content);
    manifest[blob.path] = { git: blob.sha, sha: digest, size: content.length };
    bytes.set(digest, content);
  }

  const upload = async (digest: string) => {
    let content = bytes.get(digest);
    if (!content) {
      const path = Object.keys(manifest).find((key) => manifest[key]!.sha === digest);
      const blob = path ? blobs.find((entry) => entry.path === path) : undefined;
      if (!blob) throw new HostApiError("Vercel", 409, "Vercel asked for a file that is not in the repository.");
      const raw = await githubRead<{ content: string; encoding: string }>(`/repos/${full}/git/blobs/${blob.sha}`);
      content = Buffer.from(raw.content, raw.encoding as BufferEncoding);
    }
    await hostCall("Vercel", withTeam("/v2/files", input.teamId), {
      method: "POST",
      token: input.token,
      body: content,
      headers: { "x-vercel-digest": digest, "Content-Length": String(content.length) },
      timeoutMs: 30_000,
    });
  };

  // The files this publish changed are new to Vercel by definition; send them first.
  let uploaded = 0;
  for (const digest of bytes.keys()) {
    await upload(digest);
    uploaded++;
  }

  const files = Object.entries(manifest).map(([file, entry]) => ({ file, sha: entry.sha, size: entry.size }));
  const create = () => hostCall<VercelDeployment>("Vercel", withTeam("/v13/deployments", input.teamId), {
    method: "POST",
    token: input.token,
    json: { name: project.name, project: project.id, target: "production", files, meta: { dakyxCommit: input.commitSha } },
    timeoutMs: 30_000,
  });
  let deployment: VercelDeployment;
  try {
    deployment = await create();
  } catch (error) {
    const missing = ((error as { body?: { error?: { code?: string; missing?: string[] } } }).body?.error);
    if (!(error instanceof HostApiError) || missing?.code !== "missing_files" || !missing.missing?.length) throw error;
    for (const digest of missing.missing) {
      await upload(digest);
      uploaded++;
    }
    deployment = await create();
  }

  const deadline = Date.now() + READY_WAIT_MS;
  let state = deployment;
  while (state.readyState !== "READY") {
    if (state.readyState === "ERROR" || state.readyState === "CANCELED") throw new HostApiError("Vercel", 502, `Vercel could not finish the deployment: ${state.errorMessage ?? state.readyState}`);
    if (Date.now() > deadline) throw new HostApiError("Vercel", 504, "Vercel did not finish the deployment in time.");
    await pause(1_000);
    state = await hostCall<VercelDeployment>("Vercel", withTeam(`/v13/deployments/${encodeURIComponent(deployment.id)}`, input.teamId), { token: input.token });
  }
  return { deploymentId: deployment.id, url: state.url ? `https://${state.url}` : null, uploaded, manifest };
}
