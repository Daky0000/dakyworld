import { LOGO_CID, LOGO_DARK_CID, hasBrandImage } from "../lib/brandAssets.js";
import { COMPANY } from "./dakyworld.js";
import { ACCENT, INK, LINE, MARK, MUTED } from "./letterhead.js";

/**
 * The Dakyworld letterhead, for screens.
 *
 * `letterhead.ts` does this for paper. This is the same identity, rebuilt
 * under the rules email actually enforces: tables rather than flexbox, inline
 * styles rather than classes, hex rather than anything with an alpha channel,
 * and one 600px column because that is what fits an Outlook reading pane.
 *
 * **What a client sees.** A white sheet on a cream ground: the lock-up at the
 * top left, the contact line small and quiet on the right, a hairline rule
 * with one lime segment holding it down. Then the letter itself, the
 * signature, and an ink footer band carrying the on-dark lock-up, the
 * positioning line, the contact details and the legal line — the website's
 * own footer, compressed to the width of a letter.
 *
 * **On fonts.** The brand faces are Space Grotesk and DM Sans, and email is
 * the one medium where you cannot insist. Apple Mail, iOS Mail and Samsung
 * Mail load the linked webfonts and show the real thing; Gmail and Outlook
 * strip the link and fall to the stack behind it, which is why every stack
 * ends in a system sans that keeps the same proportions rather than a serif.
 * Outlook gets an explicit Arial through an mso block, because the Word engine
 * renders an unknown family as Times.
 *
 * **On lime.** The design system allows it as a mark and never as type on
 * white — so here it is exactly two things: the 44px segment under the
 * lock-up, and the full stop that is already part of the artwork.
 */

// --- Palette, resolved for email --------------------------------------------

/** The site's own footer ground — deeper than ink, so the band reads as a base. */
const FOOTER_INK = "#050A14";
/** White at 58% over FOOTER_INK, pre-blended: email has no reliable alpha. */
const ON_INK = "#96989C";
/** White at 35%, for the legal line. */
const ON_INK_QUIET = "#5D6066";
/** Links on the dark band. Blue-light from the design system. */
const ON_INK_LINK = "#6490FF";
const PAPER = "#FFFFFF";
const PAGE = "#F4F5F0";

const BODY_FONT = "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY_FONT = "'Space Grotesk','DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const WIDTH = 600;

// --- Small pieces -------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The line Gmail and Apple Mail show next to the subject. Without one they
 * quote the first words of the letterhead instead, which reads as "Kumasi,
 * Ghana info@dakyworld.com" in every inbox.
 */
function preheader(text: string): string {
  const line = escapeHtml(text.replace(/\s+/g, " ").trim().slice(0, 140));
  // The trailing entities push the real body text out of the preview window.
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAGE};opacity:0">${line}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`;
}

/** The lock-up, or the wordmark set in type when the artwork isn't on disk. */
function logo(): string {
  if (hasBrandImage(LOGO_CID)) {
    return `<img src="cid:${LOGO_CID}" width="168" height="31" alt="Dakyworld" style="display:block;border:0;outline:none;text-decoration:none;height:auto;width:168px;max-width:168px">`;
  }
  return `<span style="font-family:${DISPLAY_FONT};font-size:22px;font-weight:700;letter-spacing:-.02em;color:${INK}">Dakyworld<span style="color:${MARK}">.</span></span>`;
}

function footerLogo(): string {
  if (hasBrandImage(LOGO_DARK_CID)) {
    return `<img src="cid:${LOGO_DARK_CID}" width="132" height="24" alt="Dakyworld" style="display:block;border:0;outline:none;text-decoration:none;height:auto;width:132px;max-width:132px">`;
  }
  return `<span style="font-family:${DISPLAY_FONT};font-size:18px;font-weight:700;letter-spacing:-.02em;color:${PAPER}">Dakyworld<span style="color:${MARK}">.</span></span>`;
}

function link(href: string, text: string, color: string): string {
  return `<a href="${href}" style="color:${color};text-decoration:none">${escapeHtml(text)}</a>`;
}

// --- The three bands ----------------------------------------------------------

/**
 * Lock-up left, contact right. The contact block is deliberately the quietest
 * thing on the sheet: it is there so a reply-all or a printed copy still knows
 * who sent it, not to be read.
 */
function header(): string {
  return `<tr>
<td class="pad" style="padding:28px 32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" valign="middle">${logo()}</td>
<td align="right" valign="middle" class="stack" style="font-family:${BODY_FONT};font-size:11px;line-height:18px;color:${MUTED}">
${escapeHtml(COMPANY.location)}<br>${link(`mailto:${COMPANY.email}`, COMPANY.email, MUTED)}
</td>
</tr></table>
</td>
</tr>
<tr>
<td class="pad" style="padding:22px 32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="44" style="width:44px;height:3px;line-height:3px;font-size:0;background:${MARK}">&nbsp;</td>
<td style="height:3px;line-height:3px;font-size:0;background:${LINE}">&nbsp;</td>
</tr></table>
</td>
</tr>`;
}

/** The letter, its signature, and the opt-out when there is one. */
function letter(bodyHtml: string, signature: string | null, unsubscribeUrl: string | null): string {
  const signatureBlock = signature
    ? `<tr><td style="padding:26px 0 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${LINE};padding:16px 0 0;font-family:${BODY_FONT};font-size:13px;line-height:22px;color:${MUTED}">${signature}</td></tr></table>
</td></tr>`
    : "";

  const optOut = unsubscribeUrl
    ? `<tr><td style="padding:18px 0 0;font-family:${BODY_FONT};font-size:11px;line-height:18px;color:#8993A6">If you would rather not hear from us, ${link(
        unsubscribeUrl,
        "unsubscribe",
        "#8993A6",
      )} and we will not write again.</td></tr>`
    : "";

  return `<tr>
<td class="pad" style="padding:30px 32px 34px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="font-family:${BODY_FONT};font-size:15px;line-height:26px;color:${INK}">${bodyHtml}</td></tr>
${signatureBlock}
${optOut}
</table>
</td>
</tr>`;
}

/** The website's footer, compressed: lock-up, positioning, contact, legal. */
function footer(): string {
  const contact = [
    link(`mailto:${COMPANY.email}`, COMPANY.email, ON_INK_LINK),
    link(`tel:${COMPANY.phone.replace(/\s/g, "")}`, COMPANY.phone, ON_INK_LINK),
    link(`https://${COMPANY.web}`, COMPANY.web, ON_INK_LINK),
  ].join(`<span style="color:${ON_INK_QUIET}"> &nbsp;·&nbsp; </span>`);

  // bgcolor as well as the CSS: Outlook's Word engine honours the attribute
  // and drops the declaration, which is how a dark band arrives white.
  return `<tr>
<td bgcolor="${FOOTER_INK}" class="pad" style="padding:26px 32px 24px;background:${FOOTER_INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:0 0 14px">${footerLogo()}</td></tr>
<tr><td style="font-family:${BODY_FONT};font-size:12px;line-height:20px;color:${ON_INK};padding:0 0 12px">${escapeHtml(
    COMPANY.positioning,
  )}</td></tr>
<tr><td style="font-family:${BODY_FONT};font-size:12px;line-height:20px;color:${ON_INK};padding:0 0 14px">${contact}</td></tr>
<tr><td style="border-top:1px solid #171F2C;padding:12px 0 0;font-family:${BODY_FONT};font-size:10px;line-height:17px;letter-spacing:.07em;color:${ON_INK_QUIET}">
&copy; ${new Date().getFullYear()} ${escapeHtml(COMPANY.name)} &nbsp;·&nbsp; ${escapeHtml(
    COMPANY.footerLine,
  )} &nbsp;·&nbsp; ${escapeHtml(COMPANY.location.toUpperCase())}
</td></tr>
</table>
</td>
</tr>`;
}

// --- The whole document -------------------------------------------------------

export interface ShellArgs {
  /** The letter itself, already rendered to paragraphs. */
  bodyHtml: string;
  /** Plain text of the same letter — the inbox preview is taken from it. */
  bodyText: string;
  signature: string | null;
  unsubscribeUrl: string | null;
}

export function wrapEmail({ bodyHtml, bodyText, signature, unsubscribeUrl }: ShellArgs): string {
  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(COMPANY.displayName)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Grotesk:wght@500;700&display=swap');
body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
img{-ms-interpolation-mode:bicubic}
a{color:${ACCENT}}
/* The Word engine ignores webfonts and renders an unknown family as Times. */
@media screen and (max-width:620px){
  .sheet{width:100%!important}
  .pad{padding-left:20px!important;padding-right:20px!important}
  .stack{display:block!important;width:100%!important;text-align:left!important;padding-top:10px!important}
}
</style>
<!--[if mso]>
<style>body,table,td,p,a,span{font-family:Arial,Helvetica,sans-serif!important}</style>
<![endif]-->
</head>
<body style="margin:0;padding:0;background:${PAGE}">
${preheader(bodyText)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE}">
<tr><td align="center" style="padding:28px 12px 34px">
<table role="presentation" class="sheet" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAPER}" style="width:${WIDTH}px;max-width:${WIDTH}px;background:${PAPER};border:1px solid ${LINE};border-radius:4px">
${header()}
${letter(bodyHtml, signature, unsubscribeUrl)}
${footer()}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * The same footer for the plain-text alternative. A text part that just stops
 * after the signature looks truncated next to the HTML one, and it is the part
 * spam filters read most closely.
 */
export function textFooter(unsubscribeUrl: string | null): string {
  return [
    "--",
    `${COMPANY.displayName} — ${COMPANY.promise}`,
    `${COMPANY.location} · ${COMPANY.email} · ${COMPANY.phone} · ${COMPANY.web}`,
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
