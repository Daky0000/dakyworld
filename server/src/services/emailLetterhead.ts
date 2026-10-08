import { BAND_CID, LOGO_CID, LOGO_DARK_CID } from "../lib/brandAssets.js";
import { DEFAULT_PROFILE, type CompanyProfile } from "./systemProfile.js";
import { ACCENT, INK, LINE, MUTED } from "./letterhead.js";

/**
 * The DakyXTech letterhead, for screens.
 *
 * `letterhead.ts` does this for paper. This is the same identity, rebuilt
 * under the rules email actually enforces: tables rather than flexbox, inline
 * styles rather than classes, hex rather than anything with an alpha channel,
 * and one 600px column because that is what fits an Outlook reading pane.
 *
 * **What a client sees** (docs/DESIGN-SYSTEM.md, v22 furniture). A white card
 * on the website's grey canvas, headed by the navy band with the dot field and
 * the white lock-up — one embedded picture, because no email client can draw
 * the website's CSS dots and a remote image would report every open. With
 * images off it is a plain navy strip with the name in white. A workspace that
 * uploaded its own logo keeps the older white header with that logo. Then the
 * letter itself, the
 * signature, and a soft grey footer panel carrying the lock-up, the
 * positioning line, the contact details and the legal line — the website's
 * own footer, compressed to the width of a letter.
 *
 * **On fonts.** The brand face is Outfit, and email is the one medium where
 * you cannot insist. Apple Mail, iOS Mail and Samsung
 * Mail load the linked webfonts and show the real thing; Gmail and Outlook
 * strip the link and fall to the stack behind it, which is why every stack
 * ends in a system sans that keeps the same proportions rather than a serif.
 * Outlook gets an explicit Arial through an mso block, because the Word engine
 * renders an unknown family as Times.
 */

// --- Palette, resolved for email --------------------------------------------

/** The footer panel: the website's soft grey, as on dakyx.com. */
const FOOTER_GROUND = "#F6F7F9";
/** Secondary text on the footer panel (§2 muted). */
const ON_FOOTER = MUTED;
/** The legal line: the faint grey, which is only ever used this small. */
const ON_FOOTER_QUIET = "#8A91A0";
/** Links in the footer: the one accent. */
const ON_FOOTER_LINK = ACCENT;
const PAPER = "#FFFFFF";
/** The header band's ground (§2 navy). */
const NAVY = "#091833";
/** The canvas behind the card — the website's page ground. */
const PAGE = "#ECEEF1";

const BODY_FONT = "'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY_FONT = BODY_FONT;

const WIDTH = 600;

// --- Small pieces -------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The line Gmail and Apple Mail show next to the subject. Without one they
 * quote the first words of the letterhead instead, which reads as "Kumasi,
 * Ghana info@dakyx.com" in every inbox.
 */
function preheader(text: string): string {
  const line = escapeHtml(text.replace(/\s+/g, " ").trim().slice(0, 140));
  // The trailing entities push the real body text out of the preview window.
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAGE};opacity:0">${line}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`;
}

/**
 * The lock-up, or the wordmark set in type when there is no artwork.
 *
 * `src` is a `cid:` reference for a real send and a data URL for the preview
 * screen, which has no message to attach parts to. Both are decided by the
 * caller — see `ShellArgs.logoSrc`.
 */
function logo(src: string | null, profile: CompanyProfile): string {
  if (src) {
    return `<img src="${src}" width="168" height="31" alt="${escapeHtml(profile.displayName)}" style="display:block;border:0;outline:none;text-decoration:none;height:auto;width:168px;max-width:168px">`;
  }
  return `<span style="font-family:${DISPLAY_FONT};font-size:22px;font-weight:600;letter-spacing:-.02em;color:${INK}">${escapeHtml(profile.displayName)}</span>`;
}

function footerLogo(src: string | null, profile: CompanyProfile): string {
  if (src) {
    return `<img src="${src}" width="132" height="24" alt="${escapeHtml(profile.displayName)}" style="display:block;border:0;outline:none;text-decoration:none;height:auto;width:132px;max-width:132px">`;
  }
  return `<span style="font-family:${DISPLAY_FONT};font-size:18px;font-weight:600;letter-spacing:-.02em;color:${INK}">${escapeHtml(profile.displayName)}</span>`;
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
function header(profile: CompanyProfile, logoSrc: string | null, bandSrc: string | null): string {
  if (bandSrc) {
    // bgcolor as well as the style, for Outlook; the alt text is set white so
    // that with images blocked it still reads on the navy.
    return `<tr>
<td bgcolor="${NAVY}" style="background:${NAVY};padding:0;line-height:0;font-size:0">
<img src="${bandSrc}" width="${WIDTH}" height="84" alt="${escapeHtml(profile.displayName)}" style="display:block;border:0;outline:none;text-decoration:none;width:100%;max-width:${WIDTH}px;height:auto;color:#FFFFFF;font-family:${BODY_FONT};font-size:20px;line-height:84px;text-align:left;background:${NAVY}">
</td>
</tr>`;
  }
  return `<tr>
<td class="pad" style="padding:28px 32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" valign="middle">${logo(logoSrc, profile)}</td>
<td align="right" valign="middle" class="stack" style="font-family:${BODY_FONT};font-size:11px;line-height:18px;color:${MUTED}">
${escapeHtml(profile.location)}<br>${link(`mailto:${profile.email}`, profile.email, MUTED)}
</td>
</tr></table>
</td>
</tr>
<tr>
<td class="pad" style="padding:22px 32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="height:1px;line-height:1px;font-size:0;background:${LINE}">&nbsp;</td>
</tr></table>
</td>
</tr>`;
}

/** The letter, its signature, and the legal furniture when there is any. */
function letter(
  bodyHtml: string,
  signature: string | null,
  unsubscribeUrl: string | null,
  sourceNoticeHtml: string | null,
): string {
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

  // Where we found them, on a first message to somebody who never contacted
  // us — Art 14(2)(f) GDPR. Same small type as the opt-out and directly under
  // it: it has to be provided and legible, not made the subject of the letter.
  // See services/dataSourceNotice.ts for why it is a footer.
  const sourceNotice = sourceNoticeHtml
    ? `<tr><td style="padding:10px 0 0;font-family:${BODY_FONT};font-size:11px;line-height:18px;color:#8993A6">${sourceNoticeHtml}</td></tr>`
    : "";

  return `<tr>
<td class="pad" style="padding:34px 36px 34px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="font-family:${BODY_FONT};font-size:15.5px;line-height:27px;color:${INK}">${bodyHtml}</td></tr>
${signatureBlock}
${optOut}
${sourceNotice}
</table>
</td>
</tr>`;
}

/**
 * The website's footer, compressed: lock-up, positioning, contact, legal.
 *
 * A light panel since v21, like the site's own footer. Its lock-up is the
 * on-light artwork flattened onto the panel's own grey (server/assets/README.md
 * says why every email cut is flattened rather than transparent).
 */
function footer(profile: CompanyProfile, logoSrc: string | null): string {
  // A blank second phone line or an absent handle is simply not printed —
  // separators are joined across what exists, not around gaps.
  const contact = [
    link(`mailto:${profile.email}`, profile.email, ON_FOOTER_LINK),
    link(`tel:${profile.phone.replace(/\s/g, "")}`, profile.phone, ON_FOOTER_LINK),
    profile.phoneAlt ? link(`tel:${profile.phoneAlt.replace(/\s/g, "")}`, profile.phoneAlt, ON_FOOTER_LINK) : "",
    link(`https://${profile.web}`, profile.web, ON_FOOTER_LINK),
  ]
    .filter(Boolean)
    .join(`<span style="color:${ON_FOOTER_QUIET}"> &nbsp;·&nbsp; </span>`);

  const socials = Object.entries(profile.social)
    .filter(([, url]) => url)
    .map(([name, url]) => link(url, SOCIAL_LABEL[name] ?? name, ON_FOOTER_LINK))
    .join(`<span style="color:${ON_FOOTER_QUIET}"> &nbsp;·&nbsp; </span>`);

  const socialRow = socials
    ? `<tr><td style="font-family:${BODY_FONT};font-size:12px;line-height:20px;color:${ON_FOOTER};padding:0 0 14px">${socials}</td></tr>`
    : "";

  const legal = [
    `&copy; ${new Date().getFullYear()} ${escapeHtml(profile.name)}`,
    escapeHtml(profile.footerLine),
    escapeHtml(profile.location.toUpperCase()),
    profile.registrationNumber ? escapeHtml(`REG ${profile.registrationNumber}`) : "",
  ]
    .filter(Boolean)
    .join(" &nbsp;·&nbsp; ");

  // bgcolor as well as the CSS: Outlook's Word engine honours the attribute
  // and drops the declaration.
  return `<tr>
<td bgcolor="${FOOTER_GROUND}" class="pad" style="padding:26px 32px 24px;background:${FOOTER_GROUND}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:0 0 14px">${footerLogo(logoSrc, profile)}</td></tr>
<tr><td style="font-family:${BODY_FONT};font-size:12px;line-height:20px;color:${ON_FOOTER};padding:0 0 12px">${escapeHtml(
    profile.positioning,
  )}</td></tr>
<tr><td style="font-family:${BODY_FONT};font-size:12px;line-height:20px;color:${ON_FOOTER};padding:0 0 14px">${contact}</td></tr>
${socialRow}
<tr><td style="border-top:1px solid ${LINE};padding:12px 0 0;font-family:${BODY_FONT};font-size:10px;line-height:17px;letter-spacing:.07em;color:${ON_FOOTER_QUIET}">
${legal}
</td></tr>
</table>
</td>
</tr>`;
}

/** How each handle is labelled in the band. Keys match CompanyProfile.social. */
const SOCIAL_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
};

// --- The whole document -------------------------------------------------------

export interface ShellArgs {
  /** The letter itself, already rendered to paragraphs. */
  bodyHtml: string;
  /** Plain text of the same letter — the inbox preview is taken from it. */
  bodyText: string;
  signature: string | null;
  unsubscribeUrl: string | null;
  /**
   * The Art 14 source notice, already escaped and linked, or null where it does
   * not apply — which is every message to somebody who contacted us first.
   */
  sourceNoticeHtml?: string | null;
  /** Who is sending. Defaults to the shipped constants when nothing is stored. */
  profile?: CompanyProfile;
  /**
   * What the two lock-ups point at. A real send passes `cid:` references and
   * attaches the parts; the preview screen passes data URLs, because an
   * `<iframe>` has no message to resolve a `cid:` against. Null on either
   * falls the shell back to setting the wordmark in type.
   */
  logoSrc?: string | null;
  footerLogoSrc?: string | null;
  /** The navy header band; null keeps the white header with `logoSrc`. */
  bandSrc?: string | null;
}

/**
 * The whole document.
 *
 * **No webfont is requested, and that absence is deliberate.** A `<link>` to
 * fonts.googleapis.com — or an `@import` of it — is fetched by whichever mail
 * clients honour it, which tells Google the recipient's IP address and that
 * they opened a message they never asked for. It is the same transfer that was
 * taken off the website on 4 Sep 2026, it happens before anyone can consent to
 * anything, and no footer can consent it away.
 *
 * The cost is nil: every rule below names the full fallback stack, Gmail and
 * Outlook stripped both tags anyway, and the Word engine was never going to
 * render a webfont in the first place.
 *
 * `checks/sourceNotice.ts` asserts both tags stay absent.
 */
export function wrapEmail({
  bodyHtml,
  bodyText,
  signature,
  unsubscribeUrl,
  sourceNoticeHtml = null,
  profile = DEFAULT_PROFILE,
  logoSrc = `cid:${LOGO_CID}`,
  footerLogoSrc = `cid:${LOGO_DARK_CID}`,
  bandSrc = `cid:${BAND_CID}`,
}: ShellArgs): string {
  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(profile.displayName)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<!-- Deliberately no webfont. See the note above wrapEmail(). -->
<style>
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
<table role="presentation" class="sheet" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAPER}" style="width:${WIDTH}px;max-width:${WIDTH}px;background:${PAPER};border:1px solid ${LINE};border-radius:14px;overflow:hidden">
${header(profile, logoSrc, bandSrc)}
${letter(bodyHtml, signature, unsubscribeUrl, sourceNoticeHtml)}
${footer(profile, footerLogoSrc)}
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
export function textFooter(
  unsubscribeUrl: string | null,
  profile: CompanyProfile = DEFAULT_PROFILE,
  sourceNoticeText: string | null = null,
): string {
  const contact = [profile.location, profile.email, profile.phone, profile.phoneAlt, profile.web].filter(Boolean).join(" · ");
  return [
    "--",
    `${profile.displayName} — ${profile.promise}`,
    contact,
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : "",
    // The text part is not a courtesy copy — it is what a plain-text client
    // shows and what a filter reads. A notice that exists only in the HTML half
    // has not been given to somebody reading the other one.
    sourceNoticeText ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}
