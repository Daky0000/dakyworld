import { createHash } from "node:crypto";
import { HostApiError, hostCall, pause } from "./hostApi.js";

/**
 * Route A for Netlify: put the published files live by uploading them to the
 * site directly, through the customer's own Netlify sign-in.
 *
 * Netlify deploys by digest. The current deploy's file list, with each file's
 * SHA-1, is read; the changed files' digests are swapped in; a new deploy is
 * created from the whole list; and Netlify answers with the digests it does not
 * have, which are exactly the changed files. Only those are uploaded. A
 * one-page change is one upload, whatever the size of the site.
 *
 * Only for a site Netlify does not build. If the site has a build command, what
 * is uploaded would not be what the build makes, so this refuses and the
 * publish follows the host's own build instead. The same goes for a deploy
 * that carries Netlify Functions, which a file deploy would drop.
 */

const API = "https://api.netlify.com/api/v1";
const READY_WAIT_MS = 50_000;

export type ChangedFile = { path: string; content: Buffer | null };

type NetlifySite = { id: string; name?: string; url?: string; ssl_url?: string; custom_domain?: string | null; domain_aliases?: string[]; published_deploy?: { id?: string } | null; build_settings?: { cmd?: string | null; dir?: string | null; repo_url?: string | null } | null };
type NetlifyDeploy = { id: string; state: string; required?: string[]; error_message?: string | null; available_functions?: unknown[] | null; deploy_ssl_url?: string; ssl_url?: string };

export const sha1 = (content: Buffer) => createHash("sha1").update(content).digest("hex");

export async function netlifySite(token: string, siteId: string): Promise<NetlifySite> {
  return hostCall<NetlifySite>("Netlify", `${API}/sites/${encodeURIComponent(siteId)}`, { token });
}

export async function netlifySites(token: string): Promise<NetlifySite[]> {
  const all: NetlifySite[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await hostCall<NetlifySite[]>("Netlify", `${API}/sites?filter=all&per_page=100&page=${page}`, { token });
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** Every file in a deploy, path to SHA-1. */
async function deployFiles(token: string, deployId: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (let page = 1; page <= 50; page++) {
    const batch = await hostCall<Array<{ path?: string; id?: string; sha?: string }>>("Netlify", `${API}/deploys/${encodeURIComponent(deployId)}/files?page=${page}&per_page=1000`, { token });
    for (const file of batch) {
      const path = file.path ?? file.id;
      if (path && file.sha) files[path.startsWith("/") ? path : `/${path}`] = file.sha;
    }
    if (batch.length < 1000) break;
  }
  return files;
}

/**
 * The new file list: the current one with the changes applied. Pure, so the
 * checks can hold it to "only the changed digests move".
 */
export function nextFileMap(current: Record<string, string>, changed: ChangedFile[]): { files: Record<string, string>; byDigest: Map<string, ChangedFile> } {
  const files = { ...current };
  const byDigest = new Map<string, ChangedFile>();
  for (const file of changed) {
    const path = file.path.startsWith("/") ? file.path : `/${file.path}`;
    if (file.content === null) {
      delete files[path];
      continue;
    }
    const digest = sha1(file.content);
    files[path] = digest;
    byDigest.set(digest, { path, content: file.content });
  }
  return { files, byDigest };
}

/** Repository paths inside the publish folder, as the paths Netlify serves them at. */
export function servedFiles(changed: ChangedFile[], publishDir: string): ChangedFile[] {
  const dir = publishDir.trim().replace(/^\.?\/+/, "").replace(/^\.$/, "").replace(/\/+$/, "");
  return changed
    .map((file) => ({ ...file, path: file.path.replace(/^\/+/, "") }))
    .filter((file) => !dir || file.path.startsWith(`${dir}/`))
    .map((file) => ({ ...file, path: `/${dir ? file.path.slice(dir.length + 1) : file.path}` }));
}

export async function deployToNetlify(input: { token: string; siteId: string; changed: ChangedFile[]; title: string }): Promise<{ deployId: string; url: string | null; uploaded: number }> {
  const site = await netlifySite(input.token, input.siteId);
  if (site.build_settings?.cmd?.trim()) {
    throw new HostApiError("Netlify", 409, "Netlify builds this site, so a direct upload would not match what the build makes.");
  }
  const currentId = site.published_deploy?.id;
  if (!currentId) throw new HostApiError("Netlify", 409, "This Netlify site has nothing published yet to build on.");
  const current = await hostCall<NetlifyDeploy>("Netlify", `${API}/deploys/${encodeURIComponent(currentId)}`, { token: input.token });
  if (Array.isArray(current.available_functions) && current.available_functions.length) {
    throw new HostApiError("Netlify", 409, "This Netlify site runs functions, which a direct upload would drop.");
  }

  // Repository paths, mapped into the folder Netlify publishes.
  const served = servedFiles(input.changed, site.build_settings?.dir ?? "");
  if (!served.length) return { deployId: currentId, url: site.ssl_url ?? site.url ?? null, uploaded: 0 };
  const { files, byDigest } = nextFileMap(await deployFiles(input.token, currentId), served);
  const deploy = await hostCall<NetlifyDeploy>("Netlify", `${API}/sites/${encodeURIComponent(input.siteId)}/deploys`, {
    method: "POST",
    token: input.token,
    json: { files, title: input.title.slice(0, 200), draft: false },
    timeoutMs: 30_000,
  });

  let uploaded = 0;
  for (const digest of deploy.required ?? []) {
    const file = byDigest.get(digest);
    // Netlify asking for a file this publish did not change means its copy of
    // the current deploy is incomplete; uploading half a site is worse than
    // following the host this once.
    if (!file?.content) throw new HostApiError("Netlify", 409, "Netlify asked for a file this publish did not change.");
    await hostCall("Netlify", `${API}/deploys/${encodeURIComponent(deploy.id)}/files${file.path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      token: input.token,
      body: file.content,
      timeoutMs: 30_000,
    });
    uploaded++;
  }

  const deadline = Date.now() + READY_WAIT_MS;
  let state = deploy;
  while (state.state !== "ready") {
    if (state.state === "error") throw new HostApiError("Netlify", 502, `Netlify could not finish the deploy: ${state.error_message ?? "no reason given"}`);
    if (Date.now() > deadline) throw new HostApiError("Netlify", 504, "Netlify did not finish the deploy in time.");
    await pause(1_000);
    state = await hostCall<NetlifyDeploy>("Netlify", `${API}/deploys/${encodeURIComponent(deploy.id)}`, { token: input.token });
  }
  return { deployId: deploy.id, url: state.ssl_url ?? state.deploy_ssl_url ?? null, uploaded };
}
