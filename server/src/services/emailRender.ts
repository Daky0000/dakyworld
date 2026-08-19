import { createHmac } from "node:crypto";
import { SETTING, getSetting } from "../lib/settings.js";
import { LOGO_CID, LOGO_DARK_CID, brandDataUrl, hasBrandImage } from "../lib/brandAssets.js";
import { textFooter, wrapEmail } from "./emailLetterhead.js";
import { companyProfile, type CompanyProfile } from "./systemProfile.js";
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
 * Plain text to HTML, on the Dakyworld letterhead.
 *
 * The letter itself stays deliberately plain — paragraphs, one accent colour
 * for links, no images in the body, no tracking pixel — because a business
 * email that arrives looking like a newsletter reads as a campaign, and a
 * campaign is easier to ignore than a letter. What surrounds it is the
 * identity: the lock-up above, the ink footer below. See emailLetterhead.ts.
 */
export function toHtml(
  body: string,
  signature: string | null,
  unsubscribeUrl: string | null,
  shell: { profile?: CompanyProfile; logoSrc?: string | null; footerLogoSrc?: string | null } = {},
): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 18px">${linkify(escapeHtml(block)).replace(/\n/g, "<br>")}</p>`)
    .join("");

  return wrapEmail({
    bodyHtml: paragraphs,
    bodyText: body,
    signature: signature ? linkify(escapeHtml(signature)).replace(/\n/g, "<br>") : null,
    unsubscribeUrl,
    ...shell,
  });
}

/**
 * The text alternative — the same words and signature, closed by the same
 * details the footer band carries, so the two parts say the same thing.
 */
export function toText(body: string, signature: string | null, unsubscribeUrl: string | null, profile?: CompanyProfile): string {
  return [body.trim(), signature ? `\n${signature}` : "", `\n${textFooter(unsubscribeUrl, profile)}`]
    .filter(Boolean)
    .join("\n");
}

/**
 * Who signed it, and nothing else. The address, the phone number and the
 * website are in the footer band the letterhead draws — a signature that
 * repeats them makes the bottom of every email say the same thing twice.
 */
export async function signature(): Promise<string | null> {
  const stored = await getSetting(SETTING.MAIL_SIGNATURE);
  if (stored !== null) return stored.trim() || null;
  const name = (await getSetting(SETTING.MAIL_FROM_NAME)) ?? "Dan Kwame Ayipah";
  return `${name}
Founder, ${(await companyProfile()).displayName}`;
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
  /**
   * True when the result will be shown on a page rather than sent. The two
   * differ in one respect and it matters: an `<iframe>` cannot resolve a
   * `cid:` reference, so the preview carries the artwork as data URLs and a
   * real send carries the `cid:` the attached parts answer to.
   */
  forPreview?: boolean;
}): Promise<RenderedEmail> {
  const subject = fillPlaceholders(args.subject, args.variables).trim();
  const filled = fillPlaceholders(args.body, args.variables).trim();

  // The reply-based opt-out, on every cold email, added here rather than asked
  // of the drafter.
  //
  // There is already an unsubscribe link in the footer, and it is not the same
  // thing. A link is a mechanism; this is a sentence in the sender's own voice
  // that costs the reader one word to use, and on a personal note from one
  // person it is the form that actually gets used — which is the point, because
  // an easy "stop" is worth more to a sending reputation than a complaint. It
  // is appended rather than prompted for because a rule that must hold on every
  // single message cannot depend on a model remembering it.
  const body = args.includeUnsubscribe && !carriesOptOut(filled) ? `${filled}

${OPT_OUT_SENTENCE}` : filled;
  const [sign, profile, shell] = await Promise.all([signature(), companyProfile(), logoSources(args.forPreview ?? false)]);
  const optOut = args.includeUnsubscribe ? await unsubscribeUrl(args.toEmail, args.appUrl) : null;

  return {
    subject,
    bodyText: body,
    html: toHtml(body, sign, optOut, { profile, ...shell }),
    text: toText(body, sign, optOut, profile),
  };
}

/** The wording the playbook requires, in Dan's own voice. */
export const OPT_OUT_SENTENCE = `If you'd rather I didn't write again, reply "stop" and I'll close this off.`;

/** Already there, however the drafter happened to word it. */
function carriesOptOut(body: string): boolean {
  const lower = body.toLowerCase();
  return /reply\s+["“']?stop/.test(lower) || /rather i didn.?t write again/.test(lower);
}

/**
 * Where the two lock-ups point. Null on either means there is no artwork for
 * that slot at all, and the shell sets the wordmark in type instead — which is
 * better than a broken image icon at the top of a client's inbox.
 */
export async function logoSources(forPreview: boolean): Promise<{ logoSrc: string | null; footerLogoSrc: string | null }> {
  if (forPreview) {
    const [logoSrc, footerLogoSrc] = await Promise.all([brandDataUrl(LOGO_CID), brandDataUrl(LOGO_DARK_CID)]);
    return { logoSrc, footerLogoSrc };
  }
  const [light, dark] = await Promise.all([hasBrandImage(LOGO_CID), hasBrandImage(LOGO_DARK_CID)]);
  return { logoSrc: light ? `cid:${LOGO_CID}` : null, footerLogoSrc: dark ? `cid:${LOGO_DARK_CID}` : null };
}
