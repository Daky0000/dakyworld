import { publicationInput } from "./websitePublicationInput.js";
import type { WebsiteActor } from "./websiteActor.js";
import { beforeWebsiteExternalAction } from "../lib/websiteWorkContext.js";
import { versionDraft } from "./website/versionRestore.js";
import type { Request } from "express";
import { createHash } from "node:crypto";
import { createBranch, openPullRequest } from "../lib/github.js";
import { withWebsitePublishLock, commitPublication } from "./websitePublishing.js";
import { publishFrameworkPage } from "./websiteFrameworkPublish.js";
import { hasSourceManifest } from "./websitePageManifest.js";
import { assertTierFeatureAccess } from "./websiteTierPlans.js";
import { advancePublishJob, failPublishJob, publishJobCommitted, publishJobView, startPublishJob } from "./websitePublishJobs.js";
import { ensureHostedAddress } from "./websiteHosting.js";
import { runPublishGuardChecks } from "./websitePublishGuard.js";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { assertWebsiteSiteAccess, getWebsiteCapabilities } from "./websiteAccess.js";
import { editingSource, sourceHash, versionValues, categoriseChanges, describeChanges, buildPublishPlan, discoverFields } from "./website/index.js";
import { pageSource, pageUrl, publishPage, publishSourcePage, siteRepo, underSiteCredential, WebsiteError } from "./website/site.js";
import { offerPagePublished } from "./context/business.js";
import { draftValues, loadPage, syncDemoFromSitePage } from "./websitePageContext.js";
export function executePagePublish(req: Request) {
    return publishPageCommand(req, { pageId: req.params.pageId, body: req.body });
}
export async function publishPageCommand(actor: WebsiteActor, input: {
    pageId: string;
    body?: unknown;
}) {
    const body = publicationInput.parse(input.body ?? {});
    await assertWebsiteSiteAccess(actor, (await loadPage(actor, input.pageId)).site.id, "publish");
    const result = await withWebsitePublishLock(input.pageId, async () => {
        const { page, site } = await loadPage(actor, input.pageId);
        if (body?.ifRevision !== undefined && body.ifRevision !== page.draftRevision)
            throw new WebsiteError(409, "The draft changed after your review. Review it again before publishing.");
        const values = draftValues(page);
        if (Object.keys(values).length === 0) {
            if (page.sourceHtml !== null && !siteRepo(site)) {
                await syncDemoFromSitePage(site, page.id, page.sourceHtml, false);
                await beforeWebsiteExternalAction();
                return commitPublication(async (tx) => {
                    const last = await tx.sitePageVersion.findFirst({ where: { pageId: page.id }, orderBy: { number: "desc" }, select: { number: true } });
                    let version = last?.number ?? 0;
                    if (!page.publishedHtml) {
                        await tx.sitePage.update({ where: { id: page.id }, data: { publishedHtml: page.sourceHtml, status: "LIVE", lastPublishedAt: new Date() } });
                        await ensureHostedAddress(site.id, tx);
                        const created = await tx.sitePageVersion.create({ data: {
                                pageId: page.id, number: version + 1, html: page.sourceHtml!,
                                publishedById: actor.dbUser?.id ?? null,
                            } });
                        version = created.number;
                        await tx.siteAuditEvent.create({ data: { siteId: site.id, kind: "PUBLISH", summary: `Published ${page.title} for the first time`, actorName: actor.dbUser?.name ?? "Website editor", actorId: actor.dbUser?.id } });
                    }
                    return {
                        version,
                        changed: 0,
                        summary: [],
                        commitSha: "local",
                        commitUrl: pageUrl(site, page),
                        url: pageUrl(site, page),
                        revision: page.draftRevision,
                        draftRetained: false,
                        publishJob: null,
                        pullRequest: null,
                    };
                });
            }
            // A page whose only pending change is a shared one is not a page with
            // nothing on it. Publishing it here would write this page and leave the
            // other six saying something else, so it is refused — and the refusal
            // says where the button is instead of implying the work was lost.
            const pending = await prisma.sharedElementInstance.findMany({
                where: { pageId: page.id, state: "LINKED", element: { draft: { not: Prisma.DbNull } } },
                include: { element: { select: { name: true, id: true } } },
            });
            if (pending.length) {
                throw Object.assign(new WebsiteError(409, `The unpublished changes on this page belong to ${pending.map((instance) => instance.element.name).join(" and ")}, which ${pending.length === 1 ? "is" : "are"} shared with other pages. Publish ${pending.length === 1 ? "it" : "them"} from the shared change so every page gets it at the same time.`), { sharedElements: pending.map((instance) => ({ id: instance.element.id, name: instance.element.name })) });
            }
            throw new WebsiteError(400, "There is nothing to publish — this page has no unsaved changes.");
        }
        // `fresh` is not an optimisation switch here. The whole purpose of the next
        // few lines is to decide whether the page has moved under this draft, and a
        // copy taken ninety seconds ago cannot answer that. See sourceCache.ts.
        // Written before anything touches GitHub. A commit that lands while the
        // write after it fails leaves the repository ahead of this system with
        // nothing recording that it happened; this row is what turns that from a
        // mystery into a state somebody can act on.
        const job = await startPublishJob({
            site,
            kind: "PAGE",
            pageId: page.id,
            startedById: actor.dbUser?.id,
            detail: { path: page.path, filePath: page.filePath, draftRevision: page.draftRevision },
        });
        const source = await pageSource(site, page, { fresh: true });
        // Every refusal is decided before anything acts, and each one is reported as
        // itself — "some fields need attention" and "the page moved under you" send
        // somebody to two different places.
        if (body?.sourceHash && body.sourceHash !== createHash("sha256").update(source.html).digest("hex"))
            throw new WebsiteError(409, "The source changed after your review. Review it again before publishing.");
        const plan = buildPublishPlan({ source: source.html, values });
        if (plan.problems.length) {
            await failPublishJob(job.id, "CONFLICT", "Some fields need attention before this page can be published.");
            throw Object.assign(new WebsiteError(400, "This page cannot be published yet — some fields need attention."), { problems: plan.problems });
        }
        if (plan.conflicts.length || plan.missing.length) {
            await failPublishJob(job.id, "CONFLICT", "The page moved under these edits, so nothing was published.");
            throw Object.assign(new WebsiteError(409, "The page has changed since these edits were made, so they have not been published. Reopen the page to see it as it is now."), { conflicts: plan.conflicts, missing: plan.missing });
        }
        if (!plan.html) {
            await failPublishJob(job.id, "CONFLICT", "The page already said all of this.");
            throw new WebsiteError(400, "The page already says all of this. Nothing to publish.");
        }
        // Safe Publish Guard Pre-flight Check
        const policy = (site.settings as Record<string, any> | null)?.editingPolicy;
        const guard = runPublishGuardChecks({
            candidateHtml: plan.html,
            sourceHtml: source.html,
            draftValues: values,
            brandGuard: policy?.brandGuard,
        });
        // The guard is the agency's rule for what a client may publish, so only
        // somebody who may change the site's settings may step over it — and it
        // is written down when they do. Before, `forceOverride: true` from any
        // publisher skipped it and left no trace.
        const overriding = !guard.canPublish && body?.forceOverride === true
            && (await getWebsiteCapabilities(actor, site.id)).capabilities.manage;
        if (!guard.canPublish && !overriding) {
            await failPublishJob(job.id, "CONFLICT", guard.summary);
            throw Object.assign(new WebsiteError(400, guard.summary), { blockers: guard.blockers, warnings: guard.warnings });
        }
        if (overriding) {
            await prisma.siteAuditEvent.create({ data: { siteId: site.id, kind: "PUBLISH_GUARD_OVERRIDDEN", summary: `${actor.dbUser?.name ?? "Somebody"} published ${page.title} over the publish guard: ${guard.summary}`.slice(0, 500), actorName: actor.dbUser?.name ?? "Website editor", actorId: actor.dbUser?.id, detail: { pageId: page.id, blockers: guard.blockers } as Prisma.InputJsonValue } });
        }
        // Read once for the labels the summary is written in. The plan has already
        // parsed the page; this is the same parse and is kept separate rather than
        // threaded out of the plan, because a publish summary that silently depended
        // on the plan's internals is how the two come to disagree.
        const content = discoverFields(editingSource(source.html, values));
        const author = actor.dbUser?.name ?? "the website editor";
        const summary = describeChanges(content.fields, values);
        await advancePublishJob(job.id, "COMMITTING", {
            detail: { path: page.path, filePath: page.filePath, draftRevision: page.draftRevision, expectedHtmlHash: createHash("sha256").update(plan.html).digest("hex") },
        });
        const isPR = body?.mode === "pull_request";
        const prTitle = (typeof body?.prTitle === "string" && body.prTitle.trim()) || `Website: ${plan.changed.length} change${plan.changed.length === 1 ? "" : "s"} on ${page.path} (${author})`;
        let branchOverride: string | undefined = undefined;
        const repo = siteRepo(site);
        if (isPR) {
            await assertTierFeatureAccess(actor, "pullRequestPublish", site.id);
            if (!repo)
                throw new WebsiteError(409, "Connect this site's GitHub repository before opening a pull request.");
            const slug = page.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "content";
            branchOverride = `content/${slug}-${Date.now().toString(36)}`;
            await underSiteCredential(site, () => createBranch(repo, branchOverride!));
        }
        let commit: {
            sha: string;
            url: string;
        };
        try {
            commit = source.sourceFile
                ? hasSourceManifest(page.filePath)
                    ? await publishFrameworkPage({ site, page, values, html: source.html, author, changed: plan.changed.length, branchOverride })
                    : await publishSourcePage({ site, page, values, html: source.html, author, changed: plan.changed.length, branchOverride })
                : await publishPage({
                    site,
                    page,
                    html: plan.html!,
                    expectedSource: source.html,
                    message: prTitle,
                    branchOverride,
                });
        }
        catch (error) {
            await failPublishJob(job.id, "COMMIT_FAILED", error instanceof Error ? error.message : "The commit did not happen.");
            throw error;
        }
        let prResult: {
            prUrl: string;
            prNumber: number;
            branch: string;
        } | null = null;
        if (isPR && repo && branchOverride) {
            const prBody = `### Website Content Updates\n\n- **Page**: \`${page.path}\`\n- **Target Branch**: \`${site.repoBranch}\`\n- **Author**: ${author}\n\n### Summary of Changes\n${summary.map(s => `- **${s.label}** (${s.part}): \`${s.from}\` → \`${s.to}\``).join("\n")}\n\nSubmitted via DakyXTech Website Editor.`;
            const pr = await underSiteCredential(site, () => openPullRequest({
                repo,
                branch: branchOverride,
                title: prTitle,
                body: prBody,
                base: site.repoBranch,
            }));
            prResult = { prUrl: pr.url, prNumber: pr.number, branch: branchOverride };
        }
        // From here the change is in the repository whatever else happens. The
        // job carries what to look for on the live page, because by the time
        // anybody looks the draft this came from will have been cleared.
        // What the OS serves for a hosted site. Written on every publish, for a
        // site with a repository too: the repository is still the record there,
        // and having the same bytes here means a customer can be given a working
        // address while their DNS is still pointing somewhere else.
        await advancePublishJob(job.id, "COMMITTING", { commitSha: commit.sha, commitUrl: commit.url });
        await beforeWebsiteExternalAction();
        const { version, cleared } = await commitPublication(async (tx) => {
            await tx.sitePage.update({ where: { id: page.id }, data: { publishedHtml: plan.html } });
            await ensureHostedAddress(site.id, tx);
            await publishJobCommitted({ id: job.id, commit, site, page, html: plan.html!, summary }, tx);
            // The website is where the workforce reads what this company sells, so a
            // published change to a page that describes the offer is a change to every
            // agent's brief. Fire-and-forget — see `offerPagePublished`.
            const last = await tx.sitePageVersion.findFirst({ where: { pageId: page.id }, orderBy: { number: "desc" }, select: { number: true } });
            const version = await tx.sitePageVersion.create({
                data: {
                    pageId: page.id,
                    number: (last?.number ?? 0) + 1,
                    html: plan.html!,
                    values: versionValues(values) as unknown as Prisma.InputJsonValue,
                    commitSha: commit.sha,
                    commitUrl: commit.url,
                    publishedById: actor.dbUser?.id ?? null,
                },
            });
            const cleared = await tx.sitePage.updateMany({
                where: { id: page.id, draftRevision: page.draftRevision },
                data: {
                    draft: Prisma.DbNull,
                    sourceHtml: page.sourceHtml === null ? undefined : plan.html,
                    draftSavedAt: null,
                    draftSavedById: null,
                    lastPublishedAt: new Date(),
                    // A publish is a change to the draft — it removes it. A second editor
                    // still holding the pre-publish number must be told that, or their next
                    // save silently re-creates a draft of edits that are already live.
                    draftRevision: { increment: 1 },
                },
            });
            if (!cleared.count) {
                // Someone saved during the network commit. Their draft must survive.
                await tx.sitePage.update({ where: { id: page.id }, data: { lastPublishedAt: new Date(), sourceHtml: page.sourceHtml === null ? undefined : plan.html } });
            }
            await tx.siteAuditEvent.create({ data: { siteId: site.id, kind: "PUBLISH", summary: `${isPR ? "Submitted PR for" : "Published"} ${page.title} · version ${version.number}`, actorName: author, actorId: actor.dbUser?.id, detail: summary } });
            return { version, cleared };
        });
        offerPagePublished(page.filePath);
        await syncDemoFromSitePage(site, page.id, plan.html, true);
        const finishedJob = publishJobView(await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } }));
        // A site with no repository is served by the OS itself: there is no
        // commit, no rebuild to wait for, and its address is the hosted one —
        // not `publicUrl`, which is wherever the customer's old site still is.
        const hostedAddress = repo ? null : finishedJob.verifyUrl ?? null;
        return {
            job: finishedJob,
            draftRetained: cleared.count === 0,
            version: version.number,
            changed: plan.changed.length,
            summary,
            touched: categoriseChanges(summary),
            commit: { sha: commit.sha, url: repo ? commit.url : null },
            url: repo ? pageUrl(site, page) : hostedAddress,
            hosted: !repo,
            ...(prResult ? { mode: "pull_request", ...prResult } : { mode: "commit" }),
            note: prResult
                ? `Created Pull Request #${prResult.prNumber} on GitHub.`
                : !repo
                    ? hostedAddress
                        ? "DakyX serves this page directly, so it is live now — there is no rebuild to wait for."
                        : "Saved as the live version. This website has no public address yet — set one up in Website settings, under “Where this website is served”, so visitors can see it."
                    : "GitHub Pages rebuilds the site after a commit. The change is usually live within a minute or two, and this screen will say when it is.",
        };
    });
    return result;
}
export function executeVersionPublish(req: Request) {
    return publishVersionCommand(req, { pageId: req.params.pageId, versionId: req.params.versionId, body: req.body });
}
export async function publishVersionCommand(actor: WebsiteActor, input: {
    pageId: string;
    versionId: string;
    body?: unknown;
}) {
    const body = publicationInput.parse(input.body ?? {});
    await assertWebsiteSiteAccess(actor, (await loadPage(actor, input.pageId)).site.id, "publish");
    const result = await withWebsitePublishLock(input.pageId, async (db) => {
        const { page, site } = await loadPage(actor, input.pageId);
        const version = await db.sitePageVersion.findFirst({ where: { id: input.versionId, pageId: page.id } });
        if (!version)
            throw new WebsiteError(404, "That version is not on this page.");
        const expectedRevision = body?.ifRevision === undefined ? page.draftRevision : z.number().int().nonnegative().parse(body.ifRevision);
        if (expectedRevision !== page.draftRevision)
            throw new WebsiteError(409, "The draft changed after the rollback review. Reopen the page before publishing this version.");
        const source = await pageSource(site, page, { fresh: true });
        if (body?.sourceHash && body.sourceHash !== createHash("sha256").update(source.html).digest("hex"))
            throw new WebsiteError(409, "The page changed after the rollback review. Review this version again before publishing.");
        if (source.html === version.html) {
            throw new WebsiteError(400, `The page is already exactly as it was in version ${version.number}. Nothing to publish.`);
        }
        const author = actor.dbUser?.name ?? "the website editor";
        const restored = versionDraft(source.html, {}, version.html, Boolean(source.sourceFile), `Restored version ${version.number}`);
        if (source.sourceFile && restored.dropped.length)
            throw new WebsiteError(409, "This version contains elements that no longer match the page. Restore it as a draft and review the differences first.");
        const job = await startPublishJob({ site, pageId: page.id, kind: "ROLLBACK", startedById: actor.dbUser?.id,
            detail: { expectedHtmlHash: createHash("sha256").update(version.html).digest("hex"), restoredFrom: version.number } });
        await advancePublishJob(job.id, "COMMITTING");
        const commit = source.sourceFile
            ? hasSourceManifest(page.filePath)
                ? await publishFrameworkPage({ site, page, html: source.html, values: restored.values, author, changed: Object.keys(restored.values).length })
                : await publishSourcePage({ site, page, html: source.html, values: restored.values, author, changed: Object.keys(restored.values).length })
            : await publishPage({ site, page, html: version.html, expectedSource: source.html, message: `Website: roll ${page.path} back to version ${version.number} (${author})` });
        // A rollback changes the live page like any other publish, and a price
        // rolled back is a price the agents must stop quoting.
        offerPagePublished(page.filePath);
        await advancePublishJob(job.id, "COMMITTING", { commitSha: commit.sha, commitUrl: commit.url });
        await beforeWebsiteExternalAction();
        return commitPublication(async (tx) => {
            await publishJobCommitted({ id: job.id, commit, site, page, html: version.html, summary: [] }, tx);
            const last = await tx.sitePageVersion.findFirst({ where: { pageId: page.id }, orderBy: { number: "desc" }, select: { number: true } });
            const written = await tx.sitePageVersion.create({
                data: {
                    pageId: page.id,
                    number: (last?.number ?? 0) + 1,
                    html: version.html,
                    // The values are carried across so the new row can say what it restored
                    // rather than reading as a publish that changed nothing.
                    values: (version.values ?? Prisma.DbNull) as Prisma.InputJsonValue,
                    commitSha: commit.sha,
                    commitUrl: commit.url,
                    publishedById: actor.dbUser?.id ?? null,
                },
            });
            // The reviewed draft must not cover the restored content when the editor
            // reloads. A draft saved concurrently is retained rather than overwritten.
            const cleared = await tx.sitePage.updateMany({ where: { id: page.id, draftRevision: expectedRevision }, data: { draft: Prisma.DbNull, draftSavedAt: null, draftSavedById: null, draftRevision: { increment: 1 } } });
            await tx.sitePage.update({ where: { id: page.id }, data: { lastPublishedAt: new Date(), publishedHtml: version.html, sourceHtml: page.sourceHtml === null ? undefined : version.html } });
            await ensureHostedAddress(site.id, tx);
            await tx.siteAuditEvent.create({ data: { siteId: site.id, kind: "ROLLBACK", summary: `Restored ${page.title} to version ${version.number}`, actorName: author, actorId: actor.dbUser?.id, detail: { pageId: page.id, version: written.number, restoredFrom: version.number } } });
            return {
                version: written.number,
                restoredFrom: version.number,
                label: `Rollback to version ${version.number}`,
                commit: { sha: commit.sha, url: commit.url },
                url: pageUrl(site, page),
                note: `Your host rebuilds the site after the commit. ${cleared.count ? "The saved draft was cleared." : "A newer draft was saved during publishing and has been kept; it still appears in the editor."}`,
            };
        });
    });
    return result;
}
