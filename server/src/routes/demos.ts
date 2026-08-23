import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { buildDemo, demoUrl, subjectFromLead } from "../services/demoBuilder.js";
import { appUrl } from "../services/emailSender.js";
import { companyProfile } from "../services/systemProfile.js";
import { gateBy } from "../middleware/permissionGate.js";

/**
 * Demos: the pages built for prospects, and the public serving of them.
 *
 * Two routers, because they answer to different people. `demosRouter` is the
 * Owner's — list, build, rebuild, retire — and sits behind the session like
 * every other API route. `demoPagesRouter` is the prospect's, mounted before
 * the auth middleware in index.ts, and serves one page to anybody holding the
 * link.
 *
 * **The index is deliberately not public.** `/demos/<slug>` is unlisted rather
 * than secret: whoever has the link can open it, which is what makes it
 * sendable in an email. `/demos` on its own falls through to the app, so the
 * list of every business Dakyworld is pitching stays behind the login where it
 * belongs. Publishing that list would tell every prospect who else is being
 * written to.
 */

export const demosRouter = Router();

demosRouter.use(
  gateBy({
    view: "demos.view",
    create: "demos.create",
    // The only thing PATCH changes is the status, and SENT is what puts a page
    // carrying a stranger's business name in front of them.
    edit: "demos.publish",
    remove: "demos.delete",
  }),
);

const listQuery = z.object({
  status: z.enum(["DRAFT", "READY", "SENT", "ACCEPTED", "DECLINED", "ARCHIVED"]).optional(),
  leadId: z.string().optional(),
});

demosRouter.get("/", async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const [demos, base] = await Promise.all([
      prisma.demo.findMany({
        where: { ...(query.status ? { status: query.status } : {}), ...(query.leadId ? { leadId: query.leadId } : {}) },
        orderBy: { updatedAt: "desc" },
        // The HTML is the largest column in the database and no list needs it.
        select: {
          id: true,
          slug: true,
          title: true,
          businessName: true,
          status: true,
          version: true,
          views: true,
          lastViewedAt: true,
          sentAt: true,
          builtBy: true,
          buildCostUsd: true,
          createdAt: true,
          updatedAt: true,
          references: true,
          lead: { select: { id: true, contactName: true, companyName: true, contactEmail: true, website: true, status: true } },
        },
      }),
      appUrl(),
    ]);
    res.json({ demos: demos.map((demo) => ({ ...demo, url: demoUrl(demo.slug, base) })), base });
  } catch (err) {
    next(err);
  }
});

demosRouter.get("/:id", async (req, res, next) => {
  try {
    const demo = await prisma.demo.findUnique({
      where: { id: req.params.id },
      include: { lead: { select: { id: true, contactName: true, companyName: true, contactEmail: true, website: true } } },
    });
    if (!demo) return res.status(404).json({ error: "No such demo" });
    res.json({ ...demo, url: demoUrl(demo.slug, await appUrl()) });
  } catch (err) {
    next(err);
  }
});

const buildInput = z.object({
  leadId: z.string().min(1),
  /** Replace the page at the existing link rather than opening a second one. */
  rebuild: z.boolean().default(true),
  /**
   * Build anyway, with no scan behind it. Off by default and deliberately
   * awkward: a page built from a bare record is a template with a business
   * name dropped into it, which is the one thing this feature exists not to
   * produce.
   */
  force: z.boolean().default(false),
});

/**
 * Builds the page. Slow — a design lookup and then a whole page of HTML — and
 * deliberately a separate call from sending anything, so the Owner reads it
 * before a prospect does.
 */
demosRouter.post("/build", async (req, res, next) => {
  try {
    const input = buildInput.parse(req.body);
    const lead = await prisma.lead.findUnique({ where: { id: input.leadId }, include: { research: true } });
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    // Refused rather than warned about, and refused here rather than only in
    // the UI: the tool an agent calls has the same rule, and a guard that only
    // exists in a button is not a guard.
    if (!lead.research && !input.force) {
      return res.status(409).json({
        error:
          "Nobody has looked at this business yet. Run the scan first — a demo built from a bare record is a template with their name dropped into it, and it is worse than sending nothing.",
      });
    }

    const subject = subjectFromLead(lead, (lead.research?.audit ?? null) as never, (lead.research?.look ?? null) as never);
    const result = await buildDemo(subject, { rebuild: input.rebuild });
    res.status(201).json({
      ...result,
      lookedAtFirst: Boolean(lead.research),
      notes: lead.research
        ? result.notes
        : ["This was built without a scan behind it, so it could be about any business in the trade. Read every line before the link goes out.", ...result.notes],
    });
  } catch (err) {
    next(err);
  }
});

const updateInput = z.object({
  status: z.enum(["DRAFT", "READY", "SENT", "ACCEPTED", "DECLINED", "ARCHIVED"]).optional(),
  title: z.string().min(1).max(200).optional(),
});

demosRouter.patch("/:id", async (req, res, next) => {
  try {
    const input = updateInput.parse(req.body);
    const demo = await prisma.demo.update({
      where: { id: req.params.id },
      data: {
        ...(input.title ? { title: input.title } : {}),
        ...(input.status ? { status: input.status, ...(input.status === "SENT" ? { sentAt: new Date() } : {}) } : {}),
      },
    });
    res.json({ ...demo, url: demoUrl(demo.slug, await appUrl()) });
  } catch (err) {
    next(err);
  }
});

demosRouter.delete("/:id", async (req, res, next) => {
  try {
    await prisma.demo.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// --- The public half --------------------------------------------------------

export const demoPagesRouter = Router();

/**
 * One demo, to whoever has the link.
 *
 * The CSP is the real guard on what a generated page may do. `sanitiseDemoHtml`
 * strips the obvious things at build time so the page does not arrive visibly
 * broken by its own headers, but a page written by a model and served from
 * Dakyworld's own domain does not get to decide what it may load.
 */
const CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "script-src 'unsafe-inline'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

demoPagesRouter.get("/:slug", async (req, res, next) => {
  try {
    const demo = await prisma.demo.findUnique({ where: { slug: req.params.slug } });
    if (!demo || demo.status === "ARCHIVED") {
      const profile = await companyProfile();
      return res.status(404).type("html").send(missingPage(profile.displayName));
    }

    // Counted, not tracked. This is a web server counting requests to its own
    // page — there is no pixel in anybody's mail, no identity attached, and
    // nothing follows the visitor anywhere. What it answers is the one thing
    // worth knowing before a follow-up: did they open it.
    void prisma.demo
      .update({ where: { id: demo.id }, data: { views: { increment: 1 }, lastViewedAt: new Date() } })
      .catch(() => undefined);

    res
      .status(200)
      .type("html")
      .set({
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        // A concept page for somebody else's business has no business in a
        // search index under their name.
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "no-store",
      })
      .send(demo.html);
  } catch (err) {
    next(err);
  }
});

function missingPage(company: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not here</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F5F0;color:#08101F;font:400 16px/1.6 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;padding:2rem}
main{max-width:34rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .75rem}p{margin:0;color:#69758A}</style>
</head><body><main><h1>This page is not here any more</h1>
<p>The demo you are looking for has been taken down or never existed. If somebody at ${company} sent you the link, ask them for a new one.</p>
</main></body></html>`;
}
