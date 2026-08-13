import { createHmac } from "node:crypto";
import { SETTING, getSetting } from "../lib/settings.js";
import type { RecipientContext } from "./emailContext.js";

/**
 * Turning a written email into the thing that actually leaves the building:
 * placeholders filled, plain text and HTML produced from one source, a
 * signature appended, and an unsubscribe link that works without a login.
 *
 * The body is authored as plain text with blank lines between paragraphs —
 * both by the drafter and by a person typing into the composer — and rendered
 * to HTML here. One source, so the text and HTML alternatives can never drift
 * into saying different things.
 */

/** `{{first_name}}` and friends. Unknown names are left visible rather than blanked. */
export function fillPlaceholders(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, key: string) => {
    const value = variables[key.toLowerCase()];
    // An empty string is a real value ("no city on file"); undefined is a typo
    // in the template, and hiding it would send "Hi ," to a client.
    return value === undefined ? whole : value;
  });
}

/** Every placeholder a template can use, for the composer's help text. */
export function placeholderKeys(context: RecipientContext): string[] {
  return Object.keys(context.variables).sort();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Bare URLs become links; nothing else in the body is interpreted as markup. */
function linkify(value: string): string {
  return value.replace(/\b(https?:\/\/[^\s<>"]+)/g, (url) => `<a href="${url}" style="color:#3157FF">${url}</a>`);
}

/**
 * Plain text to HTML. Deliberately minimal — a business email that arrives
 * looking like a newsletter reads as a campaign, and a campaign is easier to
 * ignore than a letter. System font stack, one accent colour, no images, no
 * tracking pixel.
 */
export function toHtml(body: string, signature: string | null, unsubscribeUrl: string | null): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 16px">${linkify(escapeHtml(block)).replace(/\n/g, "<br>")}</p>`)
    .join("");

  const signatureHtml = signature
    ? `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #dfe4eb;color:#69758a;font-size:13px;line-height:1.6">${linkify(
        escapeHtml(signature),
      ).replace(/\n/g, "<br>")}</div>`
    : "";

  const unsubscribeHtml = unsubscribeUrl
    ? `<div style="margin-top:18px;color:#8993a6;font-size:11px">If you would rather not hear from us, <a href="${unsubscribeUrl}" style="color:#8993a6">unsubscribe</a> and we will not write again.</div>`
    : "";

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#08101f;max-width:580px">${paragraphs}${signatureHtml}${unsubscribeHtml}</div>`;
}

/** The text alternative — the same words, plus the same signature and opt-out. */
export function toText(body: string, signature: string | null, unsubscribeUrl: string | null): string {
  return [body.trim(), signature ? `\n--\n${signature}` : "", unsubscribeUrl ? `\nUnsubscribe: ${unsubscribeUrl}` : ""]
    .filter(Boolean)
    .join("\n");
}

export async function signature(): Promise<string | null> {
  const stored = await getSetting(SETTING.MAIL_SIGNATURE);
  if (stored !== null) return stored.trim() || null;
  const name = (await getSetting(SETTING.MAIL_FROM_NAME)) ?? "Dan Kwame Ayipah";
  return `${name}\nDakyworld — your outsourced IT department\nKumasi, Ghana · dakyworld.com`;
}

/**
 * A signed unsubscribe link. HMAC rather than a stored token so the link works
 * for an address that has never been written to before, and so nothing has to
 * be cleaned up when it is used. `APP_SECRET` keys it, the same secret the
 * stored credentials are encrypted with.
 */
export function unsubscribeToken(email: string): string {
  const secret = process.env.APP_SECRET ?? process.env.DATABASE_URL ?? "dakyworld";
  return createHmac("sha256", secret).update(email.toLowerCase()).digest("base64url").slice(0, 32);
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  return unsubscribeToken(email) === token;
}

export async function unsubscribeUrl(email: string, appUrl: string): Promise<string> {
  const base = appUrl.replace(/\/$/, "");
  return `${base}/api/emails/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;
}

export interface RenderedEmail {
  subject: string;
  bodyText: string;
  html: string;
  text: string;
}

/**
 * The one place a message becomes sendable. Cold outreach gets an unsubscribe
 * link and everything else does not — a client being handed their finished
 * website should not be invited to opt out of hearing from their supplier.
 */
export async function renderEmail(args: {
  subject: string;
  body: string;
  variables: Record<string, string>;
  toEmail: string;
  appUrl: string;
  includeUnsubscribe: boolean;
}): Promise<RenderedEmail> {
  const subject = fillPlaceholders(args.subject, args.variables).trim();
  const body = fillPlaceholders(args.body, args.variables).trim();
  const sign = await signature();
  const optOut = args.includeUnsubscribe ? await unsubscribeUrl(args.toEmail, args.appUrl) : null;

  return {
    subject,
    bodyText: body,
    html: toHtml(body, sign, optOut),
    text: toText(body, sign, optOut),
  };
}
