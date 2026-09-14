/**
 * Publishing a framework page, across every file the page is made of.
 *
 * `publishSourcePage` writes one file, because it was built when a page was one
 * file. Now that a page's heading is in a component and its cards are in a data
 * module, a single publish routinely touches three or four files, and doing that
 * as three or four commits would be the worst of both worlds: a repository whose
 * history says the heading changed at 14:02 and the cards at 14:03, with a build
 * in between showing a page that never existed.
 *
 * So one commit, or none:
 *
 *  - every file is re-read at the moment of publishing and checked against the
 *    hash the draft was reviewed at, so a developer editing the same component
 *    while somebody edits its words loses nothing;
 *  - `expectedFiles` carries that guarantee down to GitHub itself, per file, so
 *    the window between the check and the commit is closed on the server rather
 *    than assumed away;
 *  - a refusal anywhere — a stale file, a change with nowhere to go — publishes
 *    nothing and says which part and which file.
 *
 * The rendered HTML is never committed. It is output; committing it would leave
 * a file the next build overwrites beside a source file that still says the old
 * thing.
 */
import type { Site, SitePage } from "@prisma/client";
import { commitFiles } from "../lib/github.js";
import { invalidateSource } from "./website/sourceCache.js";
import { invalidateRender } from "./website/renderSource.js";
import { githubFailure, siteRepo, WebsiteError } from "./website/site.js";
import { applyPageEdits, type PageWrite } from "./website/pageFields.js";
import { pageManifest, type PageManifest } from "./websitePageManifest.js";
import type { HtmlFieldEdit } from "./website/jsx.js";

export type FrameworkPublishInput = {
  site: Site;
  page: SitePage;
  /** The draft as the editor keeps it: values keyed by the rendered page's fields. */
  values: Record<string, HtmlFieldEdit>;
  /** The rendered HTML those edits were made against. */
  html: string;
  author: string;
  changed: number;
  /**
   * The manifest hash the draft was prepared against.
   *
   * Optional, and checked when it is given. A draft saved an hour ago was
   * prepared against a set of files that may no longer be the set of files this
   * page is made of — a component added, a data file split in two — and every
   * field id in it is then addressing a page that has moved. Refusing is the
   * only honest answer; the alternative is writing yesterday's edits into
   * today's files wherever the ids happen to still collide.
   */
  manifestHash?: string;
  /**
   * Whether a change may be committed only against a literal the author named
   * with a `data-dw-field` marker.
   *
   * Off by default, and that is deliberate rather than lax. Markers exist on a
   * site only once it has been through integration, and turning this on for
   * every site before then would refuse every edit on every site that publishes
   * today — an editor that has stopped working, offered as a safety
   * improvement.
   *
   * What carries the safety in the meantime is uniqueness, and it is now
   * stronger than it was: matching runs over every file the page reaches at
   * once, so two components that say the same thing collide and both go
   * read-only. Under the old single-file path that collision was invisible,
   * because only one of the two files was ever read.
   *
   * An integrated site turns this on and gets the stricter rule.
   */
  requireMarker?: boolean;
};

type Dependencies = { manifest: typeof pageManifest; commit: typeof commitFiles };
const dependencies: Dependencies = { manifest: pageManifest, commit: commitFiles };

/**
 * Work out the complete change set without committing it.
 *
 * Separate from the publish so that the review screen and the publish see the
 * same answer computed the same way. A review that reasons about the change set
 * differently from the publish is a review of something else.
 */
export async function frameworkChangeSet(
  input: FrameworkPublishInput,
  overrides: Partial<Dependencies> = {},
): Promise<{ writes: PageWrite[]; context: PageManifest }> {
  const deps = { ...dependencies, ...overrides };
  const context = await deps.manifest(input.site, input.page);
  if (input.manifestHash && input.manifestHash !== context.discovery.manifestHash) {
    throw new WebsiteError(
      409,
      "The files this page is built from have changed since these edits were prepared. Reload the page and review the changes again before publishing.",
    );
  }

  const applied = await applyPageEdits({
    discovery: context.discovery,
    read: context.read,
    html: input.html,
    edits: input.values,
    requireMarker: input.requireMarker === true,
  });

  if (applied.unmappable.length) {
    throw Object.assign(
      new WebsiteError(
        400,
        `Some of these changes are written by this page's code rather than by its text, so nothing was published: ${applied.unmappable.map((entry) => entry.message).join(" ")}`,
      ),
      { unmappable: applied.unmappable },
    );
  }
  if (applied.problems.length) {
    const stale = applied.problems.some((problem) => problem.code === "stale");
    throw new WebsiteError(stale ? 409 : 400, applied.problems.map((problem) => problem.message).join(" "));
  }
  if (!applied.writes.length) throw new WebsiteError(400, "None of these changes alter this page's source files.");
  return { writes: applied.writes, context };
}

/** The whole change set, in one commit, checked file by file. */
export async function publishFrameworkPage(
  input: FrameworkPublishInput,
  overrides: Partial<Dependencies> = {},
): Promise<{ sha: string; url: string; files: string[] }> {
  const deps = { ...dependencies, ...overrides };
  const repo = siteRepo(input.site);
  if (!repo) throw new WebsiteError(409, "Connect this site's GitHub repository in Website settings before publishing.");

  const { writes, context } = await frameworkChangeSet(input, overrides);

  // The bytes each file was reviewed at, re-read rather than remembered. The
  // reader is the memoised one the manifest was built with, so these are
  // exactly the bytes the edits were computed against and not a second opinion.
  const expected: Array<{ path: string; content: string }> = [];
  for (const write of writes) {
    const before = await context.read(write.filePath);
    if (before === null) {
      throw new WebsiteError(404, `${write.filePath} is no longer in ${repo} on branch ${input.site.repoBranch}. Reload the page before publishing.`);
    }
    expected.push({ path: context.repoPathFor(write.filePath), content: before });
  }

  const names = writes.map((write) => write.filePath);
  const message = `Website: ${input.changed} change${input.changed === 1 ? "" : "s"} on ${input.page.path} (${input.author})`;
  try {
    const commit = await deps.commit({
      repo,
      branch: input.site.repoBranch,
      message: names.length > 1 ? `${message}\n\nFiles: ${names.join(", ")}` : message,
      expectedFiles: expected,
      files: writes.map((write) => ({ path: context.repoPathFor(write.filePath), content: write.source })),
    });
    // Every file, not just the page's own. A stale component in the cache is a
    // page that still shows the old heading after a publish that worked, which
    // reads as a publish that did not.
    for (const write of writes) invalidateSource(input.site.id, write.filePath);
    invalidateRender(input.site, input.page);
    return { ...commit, files: names };
  } catch (err) {
    throw githubFailure(err, repo, input.site.repoBranch);
  }
}
