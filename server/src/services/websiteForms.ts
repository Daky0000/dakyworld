import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { mailerConfigured, sendMail } from "../lib/mailer.js";
import { brandedNotice } from "./transactionalEmail.js";
import { attr, parseHtml, walk, type ElementNode } from "./website/parse.js";
import { WebsiteError } from "./website/site.js";
import { assertWebsiteSiteAccess } from "./websiteAccess.js";
import { customerAppUrl } from "./emailSender.js";

/**
 * Forms on a website DakyX hosts, with somewhere for their messages to go.
 *
 * Most small-business websites need exactly one form — "contact us", "book a
 * table" — and on a site moved here from a builder or a template that form
 * usually posts nowhere: `action="#"`, a `mailto:`, or a Netlify attribute
 * that means nothing on this host. Visitors pressed Send and the message
 * vanished. Now such a form posts to `/__dakyx/forms` on the site's own
 * address; the message is kept, checked for spam, emailed to the site's
 * managers and listed in the editor's Inbox. A form that already posts to a
 * real address of its own is never touched.
 *
 * Nothing is stored that the visitor did not type, plus the page they were on.
 * No IP address is kept: the rate limit holds it in memory for ten minutes.
 */

export const FORM_ENDPOINT = "/__dakyx/forms";
const HONEYPOT = "_gotcha";
const MAX_FIELDS = 30;
const MAX_NAME = 100;
const MAX_VALUE = 5000;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** A form that goes nowhere and looks like it is for a message — not a site search. */
function wantsInbox(form: ElementNode): boolean {
  const action = (attr(form, "action") ?? "").trim();
  if (!(action === "" || action === "#" || /^mailto:/i.test(action))) return false;
  if ((attr(form, "role") ?? "").toLowerCase() === "search") return false;
  const fields = [...walk(form)].filter((node) => node !== form && ["input", "textarea", "select"].includes(node.tag));
  if (fields.some((node) => node.tag === "input" && (attr(node, "type") ?? "").toLowerCase() === "search")) return false;
  const method = (attr(form, "method") ?? "get").trim().toLowerCase();
  const looksLikeAMessage = fields.some((node) => {
    const type = (attr(node, "type") ?? "").toLowerCase();
    const name = `${attr(node, "name") ?? ""} ${attr(node, "id") ?? ""}`.toLowerCase();
    return node.tag === "textarea" || type === "email" || type === "tel" || /mail|phone|message|name/.test(name);
  });
  return method === "post" || looksLikeAMessage;
}

/**
 * The published page as it is served: forms that post nowhere point at the
 * inbox. Done when serving rather than when publishing, so nothing about the
 * customer's own markup changes and switching this off is a deploy, not a
 * migration of everybody's pages.
 */
export function routeFormsToInbox(html: string, pagePath: string): string {
  if (!/<form\b/i.test(html)) return html;
  const root = parseHtml(html);
  const forms = [...walk(root)].filter((node) => node.tag === "form" && wantsInbox(node));
  if (!forms.length) return html;
  type Edit = { start: number; end: number; text: string };
  const edits: Edit[] = [];
  for (const form of forms) {
    for (const name of ["action", "method", "enctype"]) {
      const node = form.attrs.find((item) => item.name.toLowerCase() === name);
      if (node) edits.push({ start: node.start, end: node.end, text: "" });
    }
    edits.push({ start: form.attrInsert, end: form.attrInsert, text: ` action="${FORM_ENDPOINT}" method="post"` });
    const formName = (attr(form, "name") ?? attr(form, "id") ?? "").slice(0, MAX_NAME);
    edits.push({
      start: form.innerStart,
      end: form.innerStart,
      text:
        `<input type="hidden" name="_page" value="${escapeHtml(pagePath)}">` +
        (formName ? `<input type="hidden" name="_form" value="${escapeHtml(formName)}">` : "") +
        // Invisible to people, irresistible to bots: anything typed here is spam.
        `<div aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden"><input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></div>`,
    });
  }
  let out = html;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/* -------------------------------------------------------------- receiving -- */

const recent = new Map<string, number[]>();
const WINDOW_MS = 10 * 60_000;
const PER_WINDOW = 8;

function overLimit(key: string, now = Date.now()): boolean {
  const kept = (recent.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  kept.push(now);
  recent.set(key, kept);
  if (recent.size > 5000) for (const [entry, times] of recent) if (times.every((at) => now - at >= WINDOW_MS)) recent.delete(entry);
  return kept.length > PER_WINDOW;
}

const parseForm = express.urlencoded({ extended: false, limit: "64kb", parameterLimit: MAX_FIELDS * 2 });
const parseJson = express.json({ limit: "64kb" });

function page(title: string, body: string, back: string | null): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#1b2029}main{text-align:center;padding:24px;max-width:32rem}h1{font-size:22px;margin:0 0 8px}p{color:#5b6572;margin:0 0 16px;line-height:1.6}a{color:#1b2029}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${back ? `<p><a href="${escapeHtml(back)}">Back to the page</a></p>` : ""}</main></body></html>`;
}

/** A path on this same site, or nothing — never somewhere else. */
function samePath(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return /^\/(?!\/)[^\s<>"]{0,300}$/.test(text) ? text : null;
}

/** POST /__dakyx/forms on a hosted site's own address. Called by the hosting middleware. */
export async function receiveFormPost(site: { id: string; name: string }, req: Request, res: Response): Promise<void> {
  const type = (req.headers["content-type"] ?? "").toLowerCase();
  if (type.startsWith("multipart/")) {
    res.status(415).set("Cache-Control", "no-store").type("html").send(page("This form cannot send files", "Please send your message without the attachment, or email it instead.", samePath(req.headers.referer ? new URL(req.headers.referer, "https://x").pathname : null)));
    return;
  }
  const parser = type.includes("json") ? parseJson : parseForm;
  try {
    await new Promise<void>((resolve, reject) => parser(req, res, (error?: unknown) => (error ? reject(error) : resolve())));
  } catch {
    res.status(413).set("Cache-Control", "no-store").type("html").send(page("That message is too long", "Please shorten it and send it again.", null));
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const back = samePath(body._page) ?? "/";

  if (overLimit(`${site.id}:${req.ip ?? "?"}`)) {
    res.status(429).set("Cache-Control", "no-store").type("html").send(page("Please wait a few minutes", "A lot of messages have come from here just now. Try again shortly.", back));
    return;
  }

  const fields: Record<string, string> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (key.startsWith("_")) continue;
    if (Object.keys(fields).length >= MAX_FIELDS) break;
    const value = (Array.isArray(raw) ? raw.map(String).join(", ") : String(raw ?? "")).trim();
    fields[key.slice(0, MAX_NAME)] = value.slice(0, MAX_VALUE);
  }
  if (!Object.values(fields).some((value) => value.length > 0)) {
    res.status(400).set("Cache-Control", "no-store").type("html").send(page("Nothing was sent", "The form was empty. Please fill it in and try again.", back));
    return;
  }
  const honeypot = typeof body[HONEYPOT] === "string" && (body[HONEYPOT] as string).trim().length > 0;
  const links = Object.values(fields).join(" ").match(/https?:\/\//gi)?.length ?? 0;
  const spam = honeypot || links > 4;
  const email = Object.entries(fields).find(([key, value]) => /mail/i.test(key) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))?.[1]
    ?? Object.values(fields).find((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    ?? null;

  const saved = await prisma.formSubmission.create({
    data: {
      siteId: site.id,
      pagePath: back,
      formName: typeof body._form === "string" ? body._form.slice(0, MAX_NAME) : null,
      fields: fields as Prisma.InputJsonValue,
      email: email?.slice(0, 254) ?? null,
      spam,
    },
  });
  // A bot is told the same as a person, so it learns nothing from the answer.
  if (!spam) void notifyManagers(site, saved.id, fields, email).catch((error) => console.warn(`[forms] ${site.name}: the notification did not send: ${(error as Error).message}`));

  const next = samePath(body._next);
  if (next) {
    res.redirect(303, next);
    return;
  }
  res.status(200).set("Cache-Control", "no-store").type("html").send(page("Thank you — your message has been sent", `${site.name} has received it and will reply as soon as they can.`, back));
}

async function notifyManagers(site: { id: string; name: string }, submissionId: string, fields: Record<string, string>, email: string | null) {
  const managers = await prisma.siteMember.findMany({
    where: { siteId: site.id, role: "MANAGER", user: { active: true } },
    select: { user: { select: { email: true, name: true } } },
  });
  if (!managers.length) return;
  const link = `${customerAppUrl()}/website/inbox?site=${encodeURIComponent(site.id)}&message=${encodeURIComponent(submissionId)}`;
  if (!(await mailerConfigured())) {
    console.warn(`[forms] no mailer configured — a message for ${site.name} is in the inbox: ${link}`);
    return;
  }
  const rows = Object.entries(fields).map(([key, value]) => `<tr><td style="padding:8px 14px 8px 0;color:#5B6374;vertical-align:top;border-top:1px solid #E3E6EB;font-size:13px">${escapeHtml(key)}</td><td style="padding:8px 0;white-space:pre-wrap;border-top:1px solid #E3E6EB">${escapeHtml(value)}</td></tr>`).join("");
  const { html, text } = await brandedNotice({
    paragraphs: [`Somebody sent a message through a form on ${site.name}.`],
    extraHtml: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 6px">${rows}</table>`,
    extraText: Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n"),
    action: { label: "Open it in your inbox", url: link },
    after: email ? ["Or simply reply to this email to answer them."] : [],
    signOff: "DakyX",
  });
  for (const { user } of managers) {
    await sendMail({
      to: user.email,
      toName: user.name,
      subject: `New message from your website — ${site.name}`,
      replyTo: email,
      html,
      text,
      category: "website:form-message",
    });
  }
}

/* ------------------------------------------------------------ the inbox ---- */

const listQuery = z.object({
  box: z.enum(["inbox", "spam"]).default("inbox"),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const changeInput = z.object({ read: z.boolean().optional(), spam: z.boolean().optional() }).strict();

export function registerWebsiteFormRoutes(router: Router) {
  const handle = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

  // Messages carry visitors' names and contact details, so the inbox is for
  // whoever manages the site rather than everybody who can edit a heading.
  router.get("/sites/:siteId/forms", handle(async (req, res) => {
    await assertWebsiteSiteAccess(req, req.params.siteId!, "manage");
    const query = listQuery.parse(req.query);
    const where = { siteId: req.params.siteId!, spam: query.box === "spam" };
    const rows = await prisma.formSubmission.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const [unread, spam] = await Promise.all([
      prisma.formSubmission.count({ where: { siteId: req.params.siteId!, spam: false, readAt: null } }),
      prisma.formSubmission.count({ where: { siteId: req.params.siteId!, spam: true } }),
    ]);
    res.set("Cache-Control", "no-store").json({
      messages: rows.slice(0, query.limit),
      nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      unread,
      spam,
    });
  }));

  router.patch("/sites/:siteId/forms/:messageId", handle(async (req, res) => {
    await assertWebsiteSiteAccess(req, req.params.siteId!, "manage");
    const input = changeInput.parse(req.body ?? {});
    const updated = await prisma.formSubmission.updateMany({
      where: { id: req.params.messageId!, siteId: req.params.siteId! },
      data: {
        ...(input.read === undefined ? {} : { readAt: input.read ? new Date() : null }),
        ...(input.spam === undefined ? {} : { spam: input.spam }),
      },
    });
    if (!updated.count) throw new WebsiteError(404, "That message is not in this website's inbox.");
    res.json({ ok: true });
  }));

  router.delete("/sites/:siteId/forms/:messageId", handle(async (req, res) => {
    await assertWebsiteSiteAccess(req, req.params.siteId!, "manage");
    const removed = await prisma.formSubmission.deleteMany({ where: { id: req.params.messageId!, siteId: req.params.siteId! } });
    if (!removed.count) throw new WebsiteError(404, "That message is not in this website's inbox.");
    res.status(204).end();
  }));
}
