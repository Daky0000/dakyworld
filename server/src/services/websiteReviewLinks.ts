/**
 * Client sign-off: a link somebody editing a website sends to the person they
 * build it for, who has no account, to look at an unpublished draft and either
 * approve it or ask for changes — with comments pinned to the page if they want.
 *
 * This replaces websiteApprovalAndReview.ts, which never worked end to end and
 * is worth remembering for how many ways it did not: the editor posted to a
 * route that did not exist, the access gate refused the one that did, the
 * review page sat behind the sign-in screen, it crashed on the response it got,
 * and its Approve button sent fields the server rejected. Under all of that the
 * links and comments lived in `Site.settings`, rewritten whole on every
 * anonymous comment, and a token was found by loading every site in the system.
 *
 * What it is now:
 *
 * - **Its own tables** (`ReviewLink`, `ReviewComment`), indexed on the token's
 *   hash. The token is 192 random bits and exists only in the link.
 * - **A frozen draft.** The reviewer sees the draft as it was when the link was
 *   made, and an approval records the revision it approved. The editor says when
 *   the draft has moved on since, rather than letting an old "yes" stand for
 *   words nobody approved.
 * - **The page renders in an origin of its own** (`buildPreview` without
 *   fields: the isolated policy), served as a real document so the site's own
 *   stylesheets load — the first version used `srcdoc`, which inherits the app's
 *   policy and showed every page unstyled.
 * - **One answer.** A decision is taken once, atomically; a second click, a
 *   second tab or a forwarded link cannot overturn it.
 * - **Expiry and withdrawal.** Fourteen days by default; the sender can withdraw
 *   a link, and a withdrawn or expired one answers 404 with no detail.
 */

import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import { Prisma, type ReviewLink, type Site, type SitePage } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { mailerConfigured, sendMail } from "../lib/mailer.js";
import { customerAppUrl } from "./emailSender.js";
import { signInBaseFor } from "./accountAccess.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";
import { embedWebsiteAssets } from "./websiteAssets.js";
import { pageSource, pageUrl, WebsiteError } from "./website/site.js";
import { applyValues, buildPreview, editingSource, fieldValues, type FieldValue } from "./website/index.js";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 60;
const MAX_COMMENTS_PER_LINK = 200;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A refusal a reviewer can act on — the first problem, in words — rather than "Validation failed". */
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new WebsiteError(400, result.error.issues[0]?.message ?? "Check the form and try again.");
  return result.data;
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

type LinkWithCounts = ReviewLink & { _count?: { comments: number } };

/** What the editor is told about a link. Never the token: it exists only in the link. */
export function reviewLinkView(link: LinkWithCounts, page: Pick<SitePage, "draftRevision">) {
  const expired = link.expiresAt.getTime() < Date.now();
  return {
    id: link.id,
    title: link.title,
    status: link.status,
    expired,
    createdAt: link.createdAt.toISOString(),
    expiresAt: link.expiresAt.toISOString(),
    decidedAt: link.decidedAt?.toISOString() ?? null,
    reviewerName: link.reviewerName,
    reviewerEmail: link.reviewerEmail,
    feedback: link.feedback,
    draftRevision: link.draftRevision,
    /** The draft has changed since this link was made: an approval here is of earlier words. */
    stale: page.draftRevision !== link.draftRevision,
    commentCount: link._count?.comments ?? 0,
  };
}

async function loadPage(req: Request, pageId: string, action: "view" | "edit") {
  const page = await prisma.sitePage.findUnique({ where: { id: pageId }, include: { site: true } });
  if (!page) throw new WebsiteError(404, "That page is not in the editor.");
  await assertWebsiteSiteAccess(req, page.siteId, action);
  return page;
}

/** A live link for a token, or a 404 that does not say which of the reasons it is. */
async function linkForToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new WebsiteError(404, "This review link has expired or been withdrawn.");
  const link = await prisma.reviewLink.findUnique({ where: { tokenHash: hashToken(token) }, include: { page: true, site: true } });
  if (!link || link.status === "WITHDRAWN" || link.expiresAt.getTime() < Date.now() || link.site.deletionScheduledFor) {
    throw new WebsiteError(404, "This review link has expired or been withdrawn.");
  }
  return link;
}

/** The draft the reviewer was sent, applied to the page as it reads now. */
async function draftHtmlFor(site: Site, page: SitePage, snapshot: Record<string, FieldValue>) {
  const source = await pageSource(site, page);
  if (!Object.keys(snapshot).length) return source.html;
  return applyValues(editingSource(source.html, snapshot), fieldValues(snapshot)).html;
}

/**
 * Runs inside the review frame, which is opaque and cannot be reached into.
 * Everything crosses by message: the host turns pin mode on, the frame answers
 * with where on the page was clicked and what was there, and draws the pins it
 * is sent. Links are held so a reviewer cannot wander off the draft.
 */
const FRAME_SCRIPT = `<script>(function(){
var pinMode=false;
function post(m){try{m.source="dakyx-review";parent.postMessage(m,"*")}catch(e){}}
function size(){var d=document.documentElement,b=document.body;return{w:Math.max(d.scrollWidth,b?b.scrollWidth:0)||1,h:Math.max(d.scrollHeight,b?b.scrollHeight:0)||1}}
function label(el){var t=(el&&el.closest&&el.closest("h1,h2,h3,h4,h5,h6,p,a,button,li,img,figure,label,td,th"))||el;if(!t)return"";if(t.tagName==="IMG")return(t.getAttribute("alt")||"A picture").slice(0,80);return(t.textContent||"").replace(/\\s+/g," ").trim().slice(0,80)||t.tagName.toLowerCase()}
document.addEventListener("click",function(e){if(!pinMode){var a=e.target&&e.target.closest&&e.target.closest("a,button,form");if(a){e.preventDefault()}return}e.preventDefault();e.stopPropagation();var s=size();pinMode=false;document.documentElement.style.cursor="";post({type:"pinned",x:Math.max(0,Math.min(100,e.pageX/s.w*100)),y:Math.max(0,Math.min(100,e.pageY/s.h*100)),label:label(e.target)})},true);
function draw(list){var old=document.getElementById("dakyx-review-pins");if(old)old.remove();if(!list||!list.length)return;var layer=document.createElement("div");layer.id="dakyx-review-pins";layer.style.cssText="position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";var s=size();list.forEach(function(p,i){var m=document.createElement("div");m.textContent=String(i+1);m.style.cssText="position:absolute;transform:translate(-50%,-50%);width:26px;height:26px;border-radius:50%;background:#3157FF;color:#fff;font:600 12px/26px system-ui,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.35);border:2px solid #fff;left:"+(p.x/100*s.w)+"px;top:"+(p.y/100*s.h)+"px";layer.appendChild(m)});document.body.appendChild(layer)}
window.addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data||{};if(d.source!=="dakyx-review-host")return;if(d.type==="pin-mode"){pinMode=!!d.on;document.documentElement.style.cursor=pinMode?"crosshair":""}if(d.type==="pins")draw(d.pins);if(d.type==="focus"&&typeof d.y==="number"){var s=size();window.scrollTo({top:Math.max(0,d.y/100*s.h-140),behavior:"smooth"})}});
function ready(){post({type:"ready"})}
window.addEventListener("load",ready);setTimeout(ready,600);
})();</script>`;

function withFrameScript(html: string): string {
  const at = html.search(/<\/body\s*>/i);
  return at >= 0 ? html.slice(0, at) + FRAME_SCRIPT + html.slice(at) : html + FRAME_SCRIPT;
}

/** Tell whoever made the link what the reviewer decided. Best effort: never fails the decision. */
async function notifyDecision(link: ReviewLink & { page: SitePage; site: Site }) {
  if (!link.createdById) return;
  const creator = await prisma.user.findUnique({ where: { id: link.createdById }, select: { email: true, name: true } });
  if (!creator?.email || !(await mailerConfigured())) return;
  const base = await signInBaseFor(link.createdById);
  const editorLink = `${base}/website/pages/${link.pageId}`;
  const who = link.reviewerName ?? "Your reviewer";
  const approved = link.status === "APPROVED";
  const subject = approved ? `${who} approved ${link.page.title}` : `${who} asked for changes on ${link.page.title}`;
  const lines = [
    approved
      ? `${who} approved the changes to ${link.page.title} on ${link.site.name}.`
      : `${who} asked for changes to ${link.page.title} on ${link.site.name}.`,
    link.feedback ? `They wrote: “${link.feedback}”` : "",
    "Open the page in the editor to see their comments and carry on.",
  ].filter(Boolean);
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#1b2029">${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}<p style="margin:24px 0"><a href="${editorLink}" style="background:#1b2029;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block">Open the page</a></p><p>DakyX</p></div>`;
  await sendMail({ to: creator.email, toName: creator.name, subject, html, text: `${lines.join("\n\n")}\n\n${editorLink}\n\nDakyX` }).catch((error) =>
    console.warn(`[review] could not email ${creator.email} about a decision: ${(error as Error).message}`),
  );
}

const createInput = z.object({
  title: z.string().trim().max(120).optional(),
  expiresInDays: z.number().int().min(1).max(MAX_DAYS).optional(),
  /** Optionally email the link to the reviewer as well as handing it back. */
  reviewerEmail: z.string().trim().email().max(200).optional(),
  reviewerName: z.string().trim().max(100).optional(),
});

/** The editor's side: making links, seeing what came back, withdrawing them. */
export function registerWebsiteReviewLinkRoutes(router: Router) {
  router.get("/pages/:pageId/review-links", handle(async (req, res) => {
    const page = await loadPage(req, req.params.pageId, "view");
    const links = await prisma.reviewLink.findMany({
      where: { pageId: page.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { _count: { select: { comments: true } } },
    });
    res.json({ links: links.map((link) => reviewLinkView(link, page)) });
  }));

  router.post("/pages/:pageId/review-links", handle(async (req, res) => {
    const page = await loadPage(req, req.params.pageId, "edit");
    const input = parse(createInput, req.body);
    const snapshot = (page.draft ?? {}) as Record<string, FieldValue>;
    if (!Object.keys(snapshot).length) {
      throw new WebsiteError(409, "There is nothing to review yet — this page has no unpublished changes. Make your changes first, then send the link.");
    }
    const token = randomBytes(24).toString("base64url");
    const link = await prisma.reviewLink.create({
      data: {
        siteId: page.siteId,
        pageId: page.id,
        tokenHash: hashToken(token),
        title: input.title || `Changes to ${page.title}`,
        draftSnapshot: snapshot as Prisma.InputJsonValue,
        draftRevision: page.draftRevision,
        createdById: req.dbUser?.id ?? null,
        expiresAt: new Date(Date.now() + (input.expiresInDays ?? DEFAULT_DAYS) * 86_400_000),
      },
      include: { _count: { select: { comments: true } } },
    });
    const url = `${customerAppUrl()}/review/${token}`;
    await prisma.siteAuditEvent.create({ data: {
      siteId: page.siteId, kind: "REVIEW_LINK_CREATED",
      summary: `Sent ${page.title} for review${input.reviewerName ? ` to ${input.reviewerName}` : ""}`,
      actorName: req.dbUser?.name ?? "Website editor", actorId: req.dbUser?.id,
      detail: { pageId: page.id, linkId: link.id, expiresAt: link.expiresAt.toISOString() },
    } });
    let emailed = false;
    if (input.reviewerEmail && (await mailerConfigured())) {
      const sender = req.dbUser?.name ?? "Your website team";
      const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#1b2029"><p>Hello${input.reviewerName ? ` ${escapeHtml(input.reviewerName.split(" ")[0] ?? "")}` : ""},</p><p>${escapeHtml(sender)} has changes to <strong>${escapeHtml(page.title)}</strong> on ${escapeHtml(page.site.name)} ready for you to look at. You can approve them or ask for changes — no account needed.</p><p style="margin:24px 0"><a href="${url}" style="background:#1b2029;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block">Review the changes</a></p><p style="color:#5b6572;font-size:13px">The link works until ${link.expiresAt.toDateString()}.</p></div>`;
      emailed = await sendMail({ to: input.reviewerEmail, toName: input.reviewerName ?? input.reviewerEmail, subject: `Please review the changes to ${page.title}`, html, text: `${sender} has changes to ${page.title} ready for you to review:\n\n${url}\n\nThe link works until ${link.expiresAt.toDateString()}.` })
        .then(() => true)
        .catch((error) => { console.warn(`[review] could not email the review link: ${(error as Error).message}`); return false; });
    }
    res.status(201).json({ link: reviewLinkView(link, page), url, emailed });
  }));

  router.post("/pages/:pageId/review-links/:linkId/withdraw", handle(async (req, res) => {
    const page = await loadPage(req, req.params.pageId, "edit");
    const updated = await prisma.reviewLink.updateMany({ where: { id: req.params.linkId, pageId: page.id }, data: { status: "WITHDRAWN" } });
    if (!updated.count) throw new WebsiteError(404, "That review link is not on this page.");
    res.json({ ok: true });
  }));

  router.get("/pages/:pageId/review-links/:linkId/comments", handle(async (req, res) => {
    const page = await loadPage(req, req.params.pageId, "view");
    const link = await prisma.reviewLink.findFirst({ where: { id: req.params.linkId, pageId: page.id }, select: { id: true } });
    if (!link) throw new WebsiteError(404, "That review link is not on this page.");
    const comments = await prisma.reviewComment.findMany({ where: { linkId: link.id }, orderBy: { createdAt: "asc" } });
    res.json({ comments: comments.map(commentView) });
  }));

  router.post("/pages/:pageId/review-links/:linkId/comments/:commentId/resolve", handle(async (req, res) => {
    const page = await loadPage(req, req.params.pageId, "edit");
    const resolved = z.object({ resolved: z.boolean().default(true) }).parse(req.body ?? {}).resolved;
    const updated = await prisma.reviewComment.updateMany({
      where: { id: req.params.commentId, link: { id: req.params.linkId, pageId: page.id } },
      data: { resolvedAt: resolved ? new Date() : null },
    });
    if (!updated.count) throw new WebsiteError(404, "That comment is not on this page.");
    res.json({ ok: true });
  }));
}

function commentView(comment: { id: string; authorName: string; body: string; xPercent: number | null; yPercent: number | null; anchorLabel: string | null; resolvedAt: Date | null; createdAt: Date }) {
  return {
    id: comment.id,
    authorName: comment.authorName,
    body: comment.body,
    xPercent: comment.xPercent,
    yPercent: comment.yPercent,
    anchorLabel: comment.anchorLabel,
    resolved: Boolean(comment.resolvedAt),
    createdAt: comment.createdAt.toISOString(),
  };
}

const decisionInput = z.object({
  decision: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  name: z.string().trim().min(1, "Add your name so they know who answered.").max(100),
  email: z.union([z.string().trim().email().max(200), z.literal("")]).optional(),
  feedback: z.string().trim().max(2000).optional(),
});

const commentInput = z.object({
  name: z.string().trim().min(1, "Add your name so they know who wrote it.").max(100),
  body: z.string().trim().min(1, "Write the comment first.").max(1000),
  xPercent: z.number().min(0).max(100).optional(),
  yPercent: z.number().min(0).max(100).optional(),
  anchorLabel: z.string().trim().max(120).optional(),
});

/**
 * The reviewer's side, under /api/public: no account, a token in the path, a
 * rate limit in index.ts. Mounted above the session middleware on purpose.
 */
export function registerPublicReviewRoutes(router: Router) {
  router.get("/review/:token", handle(async (req, res) => {
    const link = await linkForToken(req.params.token);
    const comments = await prisma.reviewComment.findMany({ where: { linkId: link.id }, orderBy: { createdAt: "asc" }, take: MAX_COMMENTS_PER_LINK });
    const base = `/api/public/review/${encodeURIComponent(req.params.token)}/frame`;
    res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow").json({
      site: { name: link.site.name },
      page: { title: link.page.title, path: link.page.path },
      link: {
        title: link.title,
        status: link.status,
        createdAt: link.createdAt.toISOString(),
        expiresAt: link.expiresAt.toISOString(),
        decidedAt: link.decidedAt?.toISOString() ?? null,
        reviewerName: link.reviewerName,
        feedback: link.feedback,
      },
      comments: comments.map(commentView),
      frames: { draft: `${base}?view=draft`, live: `${base}?view=live` },
    });
  }));

  router.get("/review/:token/frame", handle(async (req, res) => {
    const link = await linkForToken(req.params.token);
    const view = req.query.view === "live" ? "live" : "draft";
    const html = view === "live"
      ? (await pageSource(link.site, link.page)).html
      : await draftHtmlFor(link.site, link.page, link.draftSnapshot as Record<string, FieldValue>);
    // No fields: the isolated policy — the page's own scripts run, in an
    // origin of its own, with no reach into anything of ours.
    const document = buildPreview(html, pageUrl(link.site, link.page));
    const body = withFrameScript(view === "draft" ? await embedWebsiteAssets(link.site, document.html) : document.html);
    res.type("html").set({
      "Content-Security-Policy": document.csp,
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    }).send(body);
  }));

  router.post("/review/:token/decision", handle(async (req, res) => {
    const link = await linkForToken(req.params.token);
    const input = parse(decisionInput, req.body);
    const status = input.decision === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED";
    // Taken once, atomically: a second tab, a double click or a forwarded link
    // cannot overturn an answer already given.
    const taken = await prisma.reviewLink.updateMany({
      where: { id: link.id, status: "PENDING" },
      data: { status, reviewerName: input.name, reviewerEmail: input.email || null, feedback: input.feedback || null, decidedAt: new Date() },
    });
    if (!taken.count) {
      throw new WebsiteError(409, "This review has already been answered. If something has changed, ask for a new link.");
    }
    const decided = await prisma.reviewLink.findUniqueOrThrow({ where: { id: link.id }, include: { page: true, site: true } });
    await prisma.siteAuditEvent.create({ data: {
      siteId: link.siteId,
      kind: status === "APPROVED" ? "REVIEW_APPROVED" : "REVIEW_CHANGES_REQUESTED",
      summary: status === "APPROVED"
        ? `${input.name} approved the changes to ${link.page.title}`
        : `${input.name} asked for changes to ${link.page.title}${input.feedback ? `: ${input.feedback.slice(0, 200)}` : ""}`,
      actorName: input.name,
      detail: { pageId: link.pageId, linkId: link.id, draftRevision: link.draftRevision },
    } });
    void notifyDecision(decided);
    res.json({ status, decidedAt: decided.decidedAt?.toISOString() ?? null });
  }));

  router.post("/review/:token/comments", handle(async (req, res) => {
    const link = await linkForToken(req.params.token);
    const input = parse(commentInput, req.body);
    const existing = await prisma.reviewComment.count({ where: { linkId: link.id } });
    if (existing >= MAX_COMMENTS_PER_LINK) throw new WebsiteError(409, "This review has as many comments as it can hold. Ask for a new link to carry on.");
    const comment = await prisma.reviewComment.create({ data: {
      linkId: link.id,
      authorName: input.name,
      body: input.body,
      xPercent: input.xPercent ?? null,
      yPercent: input.yPercent ?? null,
      anchorLabel: input.anchorLabel || null,
    } });
    res.status(201).json({ comment: commentView(comment) });
  }));
}
