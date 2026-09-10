import type { Request, Response, Router } from "express";
import type { Site } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { siteCompatibility } from "./websiteReadiness.js";
import { READINESS_LABEL, sharedCandidates } from "./website/index.js";
import { pageSource, WebsiteError } from "./website/site.js";

/**
 * Getting a customer's website ready, as a list rather than as folklore.
 *
 * Onboarding a site is nine or ten things that have to be true, spread across
 * four screens and one conversation, and until now the only record of which of
 * them had been done was whoever did it. That is fine for the first website and
 * is exactly how the fifth one goes out half-configured — a site nobody scanned,
 * a branch nobody read, a client given access to something that cannot publish.
 *
 * So every step is *derived* rather than ticked. Nothing here is a checkbox
 * somebody sets; each answer is worked out from the site as it actually is, so
 * the list cannot say "done" about something that has since broken.
 *
 * The order is the order it has to happen in. Steps after a blocked one are not
 * marked failed — they are simply not started yet, which is the truth and reads
 * as one.
 */

type Access = { loadSite: (req: Request, id: string) => Promise<Site> };

export type OnboardingStep = {
  key: string;
  title: string;
  /** What is true right now, in a sentence. */
  detail: string;
  state: "done" | "todo" | "blocked" | "attention";
  /** Where in the product this is settled, when it is not settled here. */
  href?: string;
  action?: string;
};

const step = (
  key: string,
  title: string,
  state: OnboardingStep["state"],
  detail: string,
  extra: { href?: string; action?: string } = {},
): OnboardingStep => ({ key, title, state, detail, ...extra });

export async function onboardingSteps(site: Site): Promise<{ steps: OnboardingStep[]; readiness: string; readinessLabel: string; complete: boolean }> {
  const pages = await prisma.sitePage.findMany({ where: { siteId: site.id }, orderBy: { sortOrder: "asc" } });
  const report = await siteCompatibility(site, pages);
  const settings = (site.settings ?? {}) as { colours?: string[]; fonts?: string[] };
  const [members, sharedElements] = await Promise.all([
    prisma.siteMember.findMany({ where: { siteId: site.id }, include: { user: { select: { accessRole: { select: { external: true } } } } } }),
    prisma.sharedElement.count({ where: { siteId: site.id } }),
  ]);
  const clients = members.filter((member) => member.user.accessRole?.external);

  const steps: OnboardingStep[] = [];

  steps.push(step("address", "Website address", "done", site.publicUrl, { href: "/website/settings", action: "Change" }));

  steps.push(
    report.publishing.repository
      ? step("repository", "Repository connected", "done", `${site.repoOwner}/${site.repoName} on ${site.repoBranch}`, { href: "/website/settings", action: "Change" })
      : step("repository", "Repository connected", "todo", "No repository yet. Pages can be imported and edited, but nothing can be published.", {
          href: "/website/settings",
          action: "Connect one",
        }),
  );

  // Reading a real file is the only proof the branch is right. A repository name
  // that exists and a branch nobody can read look identical until a publish.
  let branch: OnboardingStep;
  if (!report.publishing.repository) {
    branch = step("branch", "Branch readable", "todo", "Waiting on a repository.");
  } else if (!pages.length) {
    branch = step("branch", "Branch readable", "todo", "Nothing has been read from it yet. Scan the site.", { href: "/website/sites", action: "Scan" });
  } else {
    const sample = pages[0]!;
    try {
      await pageSource(site, sample, { fresh: true });
      branch = step("branch", "Branch readable", "done", `${sample.filePath} was read from ${site.repoBranch}.`);
    } catch (error) {
      branch = step("branch", "Branch readable", "blocked", error instanceof WebsiteError ? error.message : "That branch could not be read.", {
        href: "/website/settings",
        action: "Check the settings",
      });
    }
  }
  steps.push(branch);

  steps.push(
    pages.length
      ? step("pages", "Pages scanned", "done", `${pages.length} page${pages.length === 1 ? "" : "s"}, ${report.totals.editable} editable things.`, {
          href: "/website/sites",
          action: "Rescan",
        })
      : step("pages", "Pages scanned", "todo", "No pages yet.", { href: "/website/sites", action: "Scan the site" }),
  );

  steps.push(
    !pages.length
      ? step("compatibility", "Compatibility reviewed", "todo", "Nothing to judge until the site is scanned.")
      : report.grade === "unsupported" || report.totals.readable < report.totals.pages
        ? step("compatibility", "Compatibility reviewed", "attention", `${report.rating}. Some pages cannot be carried by the editor — go through them before a client is given access.`, {
            href: "/website/compatibility",
            action: "Open the report",
          })
        : step("compatibility", "Compatibility reviewed", "done", `${report.rating}. ${report.findings.length} thing${report.findings.length === 1 ? "" : "s"} to mention when handing it over.`, {
            href: "/website/compatibility",
            action: "Open the report",
          }),
  );

  const palette = (settings.colours ?? []).length;
  const faces = (settings.fonts ?? []).length;
  steps.push(
    palette || faces
      ? step("design", "Colours and fonts", "done", `${palette} colour${palette === 1 ? "" : "s"} and ${faces} font${faces === 1 ? "" : "s"} set for the editor's menus.`, {
          href: "/website/settings",
          action: "Change",
        })
      : step("design", "Colours and fonts", "todo", "The editor will offer Dakyworld's palette until this site's own is set. A client picking our blue for their brand is the failure this prevents.", {
          href: "/website/settings",
          action: "Set them",
        }),
  );

  // Suggestions are cheap on a scanned site and expensive to explain later: a
  // client who edits the header on five pages separately has been let down by
  // onboarding rather than by the editor.
  let shared: OnboardingStep;
  if (sharedElements > 0) {
    shared = step("shared", "Shared elements", "done", `${sharedElements} set up.`, { href: "/website/sites", action: "Review" });
  } else if (pages.length < 2) {
    shared = step("shared", "Shared elements", "todo", "A shared element needs at least two pages.");
  } else {
    const sources = await Promise.all(
      pages.slice(0, 12).map(async (page) => {
        try {
          return { pageId: page.id, title: page.title, html: (await pageSource(site, page)).html };
        } catch {
          return null;
        }
      }),
    );
    const readable = sources.filter((entry): entry is { pageId: string; title: string; html: string } => entry !== null);
    // Everything `sharedCandidates` returns is already high or medium — a low
    // one is never offered at all — so this is the whole list.
    const candidates = sharedCandidates(readable);
    shared = candidates.length
      ? step("shared", "Shared elements", "todo", `${candidates.length} repeated block${candidates.length === 1 ? "" : "s"} found — a header, a call to action, a footer. Link them so a change is made once.`, {
          href: "/website/sites",
          action: "Set them up",
        })
      : step("shared", "Shared elements", "done", "Nothing on this site repeats across pages in a way the editor can link.");
  }
  steps.push(shared);

  steps.push(
    report.publishing.blocked
      ? step("publishing", "Publishing works", "blocked", report.publishing.blocked, { href: "/website/settings", action: "Fix it" })
      : step("publishing", "Publishing works", "done", `Commits go to ${site.repoOwner}/${site.repoName} on ${site.repoBranch}, and the live page is checked afterwards.`),
  );

  steps.push(
    clients.length
      ? step("access", "Customer access", "done", `${clients.length} client account${clients.length === 1 ? "" : "s"} on this site.`, { href: "/website/team", action: "Manage" })
      : step("access", "Customer access", "todo", "Nobody outside Dakyworld can open this site yet.", { href: "/website/team", action: "Invite the client" }),
  );

  const complete = steps.every((entry) => entry.state === "done");
  return { steps, readiness: report.readiness, readinessLabel: READINESS_LABEL[report.readiness], complete };
}

export function registerWebsiteOnboarding(router: Router, access: Access) {
  const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => {
    void fn(req, res).catch(next);
  };

  router.get("/sites/:siteId/onboarding", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const result = await onboardingSteps(site);
    res.json({ site: { id: site.id, name: site.name, publicUrl: site.publicUrl }, ...result });
  }));

  /** Marks the handover conversation as had. The one thing nothing can derive. */
  router.post("/sites/:siteId/onboarding/handover", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const body = z.object({ note: z.string().trim().max(2000).default("") }).parse(req.body);
    await prisma.siteAuditEvent.create({
      data: {
        siteId: site.id,
        kind: "ONBOARDING_HANDOVER",
        summary: "Website handed over to the client",
        actorName: req.dbUser?.name ?? "Website editor",
        actorId: req.dbUser?.id,
        detail: { note: body.note },
      },
    });
    res.json({ ok: true });
  }));
}
