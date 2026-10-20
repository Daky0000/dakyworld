import type { Prisma, Site } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { commitFiles, githubRead, githubRepoWrite, readFile, repoFullName, withGithubCredential } from "../../lib/github.js";
import { installationRepositories, pagesAppConfigured, pagesAppCredential } from "../githubApp.js";
import { siteRepo, underSiteCredential, WebsiteError } from "../website/site.js";
import { deployProfileOf, PAGES_WORKFLOW_PATH, refreshDeployProfile, type DeployProfile } from "../websiteDeployDetect.js";

/**
 * Route P: GitHub Pages, published by DakyX's own workflow instead of the
 * classic branch build.
 *
 * The classic build runs every commit through Jekyll on GitHub's shared build
 * queue. A plain HTML site gains nothing from Jekyll, and the queue is where the
 * waiting happens. A workflow that uploads the folder as it is and deploys it
 * skips both. Whether that is meaningfully faster than `.nojekyll` alone is
 * what `scripts/pagesTiming.mjs` measures; the route should stay off for
 * customers until it has (docs/publish-router.md).
 *
 * It needs two things the main app does not hold and should not: Workflows
 * write (to add a file under `.github/workflows/`) and Pages write (to switch
 * Pages' source to GitHub Actions). Those live in the second, opt-in app, DakyX
 * Pages, so only a customer who turns this on is asked for them.
 *
 * Undo puts everything back: Pages builds from the branch and folder it used
 * before, and the workflow file is removed.
 */

export function pagesWorkflow(branch: string, folder: string): string {
  const path = folder.replace(/^\/+|\/+$/g, "") || ".";
  return `# Added by DakyX to publish this site straight to GitHub Pages.
# It uploads the published folder as it is (no Jekyll, no build) and deploys it.
# To stop using it, turn off "Fast GitHub Pages" in DakyX Website settings,
# which also switches Pages back to building from the branch.
name: DakyX Pages
on:
  push:
    branches: [${JSON.stringify(branch)}]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: dakyx-pages
  cancel-in-progress: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${JSON.stringify(path)}
      - id: deployment
        uses: actions/deploy-pages@v4
`;
}

async function pagesCredentialFor(site: Site) {
  const credential = await pagesAppCredential(site);
  if (!credential) throw new WebsiteError(409, "Fast GitHub Pages needs the DakyX Pages app installed on this site's repository first.");
  return credential;
}

/**
 * Records a DakyX Pages installation against a site, once GitHub says that
 * installation really includes the site's repository. An installation id is a
 * number anyone can type; the repository check is what makes it safe.
 */
export async function attachPagesInstallation(site: Site, installationId: string): Promise<void> {
  if (!(await pagesAppConfigured())) throw new WebsiteError(503, "The DakyX Pages app is not set up yet.");
  const repositories = await installationRepositories(installationId, "pages");
  const fullName = site.repoOwner && site.repoName ? `${site.repoOwner}/${site.repoName}`.toLowerCase() : null;
  const match = repositories.find((repo) => (site.githubRepositoryId && repo.id === site.githubRepositoryId) || (fullName && repo.fullName.toLowerCase() === fullName));
  if (!match) throw new WebsiteError(400, "That DakyX Pages installation does not include this site's repository. Choose the repository when GitHub asks.");
  await prisma.site.update({ where: { id: site.id }, data: { githubPagesInstallationId: installationId } });
}

export async function enablePagesRoute(site: Site, actorId: string | null): Promise<DeployProfile | null> {
  const repo = siteRepo(site);
  if (!repo) throw new WebsiteError(409, "Connect the site's repository first.");
  const profile = deployProfileOf(site);
  if (profile?.host !== "github-pages") throw new WebsiteError(409, "Fast GitHub Pages is only for sites GitHub Pages serves.");
  if (profile.pages?.jekyllContent) throw new WebsiteError(409, "This site uses Jekyll (it has _config.yml), so it has to keep GitHub's Jekyll build.");
  if (profile.hasBuildStep) throw new WebsiteError(409, "This site has a build step, so its files cannot be published as they are.");
  const credential = await pagesCredentialFor(site);

  await withGithubCredential(credential, async () => {
    const full = await repoFullName(repo);
    const current = await githubRead<{ build_type?: string; source?: { branch?: string; path?: string } }>(`/repos/${full}/pages`);
    const previous = { branch: current.source?.branch ?? site.repoBranch, folder: current.source?.path ?? "/" };
    if (previous.branch !== site.repoBranch) throw new WebsiteError(409, `GitHub Pages builds branch ${previous.branch}, but publishing writes to ${site.repoBranch}. Fix that first.`);
    // Kept, so undo can put Pages back exactly where it was.
    const stored = deployProfileOf(await prisma.site.findUniqueOrThrow({ where: { id: site.id } }));
    if (stored) await prisma.site.update({ where: { id: site.id }, data: { deployProfile: { ...stored, pagesPrevious: previous } as unknown as Prisma.InputJsonValue } });
    // Source first, then the workflow: the workflow's first run deploys, and it
    // can only deploy once Pages takes its site from Actions.
    await githubRepoWrite(repo, "/pages", "PUT", { build_type: "workflow" });
    const existing = await readFile(repo, PAGES_WORKFLOW_PATH, site.repoBranch);
    const content = pagesWorkflow(site.repoBranch, previous.folder);
    if (existing !== content) {
      await commitFiles({ repo, branch: site.repoBranch, message: "DakyX: publish to GitHub Pages without the Jekyll build", files: [{ path: PAGES_WORKFLOW_PATH, content }] });
    }
  });
  await prisma.siteAuditEvent.create({ data: { siteId: site.id, kind: "PAGES_ROUTE_ON", summary: "Turned on fast GitHub Pages publishing", actorId, actorName: "Website settings", detail: {} } }).catch(() => undefined);
  return refreshDeployProfile(site.id);
}

export async function disablePagesRoute(site: Site, actorId: string | null): Promise<DeployProfile | null> {
  const repo = siteRepo(site);
  if (!repo) throw new WebsiteError(409, "This site has no repository.");
  const credential = await pagesCredentialFor(site);
  const previous = deployProfileOf(site)?.pagesPrevious ?? { branch: site.repoBranch, folder: site.repoPath ? `/${site.repoPath}` : "/" };
  await withGithubCredential(credential, async () => {
    // Back to the branch build first, so the commit removing the workflow is
    // itself built the classic way and the site never goes without a build.
    await githubRepoWrite(repo, "/pages", "PUT", { build_type: "legacy", source: { branch: previous.branch, path: previous.folder === "/docs" ? "/docs" : "/" } });
    const existing = await readFile(repo, PAGES_WORKFLOW_PATH, site.repoBranch);
    if (existing !== null) {
      await commitFiles({ repo, branch: site.repoBranch, message: "DakyX: back to GitHub Pages' own build", files: [{ path: PAGES_WORKFLOW_PATH, content: "", delete: true }] });
    }
  });
  await prisma.siteAuditEvent.create({ data: { siteId: site.id, kind: "PAGES_ROUTE_OFF", summary: "Turned off fast GitHub Pages publishing", actorId, actorName: "Website settings", detail: {} } }).catch(() => undefined);
  return refreshDeployProfile(site.id);
}

/**
 * `.nojekyll` (D5): for a plain HTML site on the classic build, one empty file
 * tells GitHub Pages to skip Jekyll. Uses the main app: it is an ordinary commit.
 */
export async function addNoJekyll(site: Site): Promise<DeployProfile | null> {
  const repo = siteRepo(site);
  const profile = deployProfileOf(site);
  if (!repo || profile?.host !== "github-pages" || profile.pages?.buildType !== "legacy") throw new WebsiteError(409, "This is only for sites GitHub Pages builds from a branch.");
  if (profile.pages.jekyllContent) throw new WebsiteError(409, "This site uses Jekyll (it has _config.yml), so Jekyll must keep running.");
  if (profile.pages.noJekyll) return profile;
  const folder = (profile.pages.folder ?? "/").replace(/^\/+|\/+$/g, "");
  await underSiteCredential(site, () => commitFiles({ repo, branch: site.repoBranch, message: "DakyX: skip the Jekyll build on GitHub Pages", files: [{ path: `${folder ? `${folder}/` : ""}.nojekyll`, content: "" }] }));
  return refreshDeployProfile(site.id);
}
