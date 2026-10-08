import { wrapEmail } from "./emailLetterhead.js";
import { logoSources } from "./emailRender.js";
import { companyProfile } from "./systemProfile.js";

/**
 * The account and product emails — a password link, an invitation, a form
 * message, a payment reminder, a review request — on the same letterhead as
 * every other message the company sends.
 *
 * These were hand-written `<div>`s in system fonts with an ink button, so the
 * first email a paying customer ever received (their set-password link) was the
 * one message that did not look like DakyXTech. They now go through
 * `wrapEmail`: the navy band, the white card, the soft footer.
 *
 * Every string given here is plain text and escaped here. `extraHtml` is the one
 * door for markup, for a caller that has already escaped what it built (the form
 * message's table of fields).
 */
export interface NoticeArgs {
  /** First name, or null for no greeting line. */
  greeting?: string | null;
  paragraphs: string[];
  /** The one thing to do, as a real button, with the address under it for clients that drop buttons. */
  action?: { label: string; url: string } | null;
  /** Lines after the button. */
  after?: string[];
  /** Small grey lines at the end — expiry, "ignore this if…". */
  footnotes?: string[];
  /** Already-escaped markup placed after the paragraphs. */
  extraHtml?: string;
  /** Plain-text version of `extraHtml`. */
  extraText?: string;
  signOff?: string;
}

const BLUE = "#2563EB";
const FAINT = "#8A91A0";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/**
 * A button that survives Outlook: a table cell with the colour as an attribute
 * as well as a style, and the link filling it.
 */
function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 8px"><tr>
<td bgcolor="${BLUE}" style="background:${BLUE};border-radius:10px">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 22px;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:500;line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:10px">${escapeHtml(label)}</a>
</td></tr></table>`;
}

export async function brandedNotice(args: NoticeArgs): Promise<{ html: string; text: string }> {
  const [profile, shell] = await Promise.all([companyProfile(), logoSources(false)]);
  const p = (line: string, style = "margin:0 0 18px") => `<p style="${style}">${escapeHtml(line)}</p>`;
  const signOff = args.signOff ?? profile.displayName;

  const html = [
    args.greeting !== null && args.greeting !== undefined ? p(`Hello ${args.greeting || "there"},`) : "",
    ...args.paragraphs.map((line) => p(line)),
    args.extraHtml ?? "",
    args.action ? button(args.action.label, args.action.url) : "",
    args.action
      ? `<p style="margin:0 0 22px;font-size:12.5px;line-height:20px;color:${FAINT}">If the button does not work, paste this into your browser:<br><a href="${escapeHtml(args.action.url)}" style="color:${FAINT};word-break:break-all">${escapeHtml(args.action.url)}</a></p>`
      : "",
    ...(args.after ?? []).map((line) => p(line)),
    ...(args.footnotes ?? []).map((line) => p(line, `margin:0 0 10px;font-size:13px;line-height:21px;color:${FAINT}`)),
    p(signOff, "margin:18px 0 0"),
  ].join("");

  const text = [
    args.greeting !== null && args.greeting !== undefined ? `Hello ${args.greeting || "there"},` : "",
    ...args.paragraphs,
    args.extraText ?? "",
    args.action ? `${args.action.label}: ${args.action.url}` : "",
    ...(args.after ?? []),
    ...(args.footnotes ?? []),
    signOff,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { html: wrapEmail({ bodyHtml: html, bodyText: text, signature: null, unsubscribeUrl: null, profile, ...shell }), text };
}
