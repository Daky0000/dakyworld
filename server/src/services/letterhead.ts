import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type PDFDocument from "pdfkit";
import { brandImage, companyProfile, decodeDataUrl, type CompanyProfile } from "./systemProfile.js";

type PDFDoc = InstanceType<typeof PDFDocument>;

/**
 * The Dakyworld letterhead, drawn onto every page of every document the app
 * produces.
 *
 * A proposal and an invoice are the two things a client actually keeps. Until
 * now they came out as plain typed pages with a wordmark on top, which reads
 * as a document somebody generated rather than one a company sent. This is the
 * printed identity from the letterhead template: the corner ribbons, the
 * wordmark lock-up, the contact block, the footer rule and the watermark.
 *
 * Colours and type follow the website design system (`Dakyworld Website/
 * assets/site.css`) so a proposal and the site read as one company. Accent is
 * kept to two corner wedges, four hairline icons and one rule.
 *
 * **Why two accents.** Lime is the brand's signature, but it is a solid mark
 * colour, not a text colour: at 8pt on white it does not read. So lime paints
 * the corner wedges, where it is a shape against ink, and blue carries the
 * rules, icons and small accent type, where it has to be legible.
 *
 * **On the logo.** The identity guide is explicit that logo artwork does not
 * exist yet and that the mark is a wordmark — "no icon crutch". The letterhead
 * template has since gained a D monogram, but that artwork is not in this
 * repository, and a wrong logo on a document a client keeps is worse than a
 * clean typographic one. So the wordmark is drawn from type, and
 * `assets/logo.png` is used instead the moment somebody puts it there.
 */

// --- The palette, and nothing else -----------------------------------------

export const INK = "#08101F";
export const CREAM = "#F4F5F0";
/** Legible accent: rules, hairline icons, small bold type. */
export const ACCENT = "#3157FF";
/** The same blue, darkened, for accent type that sits under 8pt. */
export const ACCENT_DEEP = "#2440C4";
export const MUTED = "#69758A";
export const LINE = "#DFE4EB";
/** Solid mark colour. Shapes on ink only — never type, never on white. */
export const MARK = "#B8FF3D";
/**
 * The watermark only — a tint of cream, never an extra brand colour. Kept very
 * close to white on purpose: body text runs over it, and a watermark you can
 * read through is decoration, while one you can't is a legibility problem.
 */
const WATERMARK = "#F1F4F9";

// --- Page geometry ---------------------------------------------------------

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN_X = 56;
/** Content starts below the letterhead block and ends above the footer rule. */
export const CONTENT_TOP = 168;
export const CONTENT_BOTTOM = 96;
export const CONTENT_W = PAGE_W - MARGIN_X * 2;

// The name, tagline and address block come from services/systemProfile.ts,
// which the Owner edits on the System settings screen. They are shared with
// the Word cut and with email so a phone number only ever changes in one
// place — and now changes without a deploy.

// --- The real logo, if it has been supplied --------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * Drop the exported logo here and every PDF picks it up on the next render —
 * no code change, no redeploy beyond the one that carries the file. Checked
 * once per process because the answer cannot change while it runs.
 */
function assetCandidates(names: string[]): string[] {
  return names.flatMap((name) => [
    path.resolve(here, "../../assets", name),
    path.resolve(here, "../../../assets", name),
  ]);
}

const LOGO_CANDIDATES = assetCandidates(["logo.png", "logo.jpg", "logo.jpeg"]);
/** The square mark on its own, for the watermark. Optional. */
const MARK_CANDIDATES = assetCandidates(["mark.png", "mark.jpg", "mark.jpeg"]);

const found = new Map<string, Buffer | null>();

function findAsset(key: string, candidates: string[]): Buffer | null {
  const cached = found.get(key);
  if (cached !== undefined) return cached;
  const hit = candidates.find((candidate) => fs.existsSync(candidate));
  let buffer: Buffer | null = null;
  if (hit) {
    try {
      buffer = fs.readFileSync(hit);
    } catch {
      buffer = null;
    }
  }
  found.set(key, buffer);
  return buffer;
}

/**
 * Who the document is from, and the artwork it is stamped with, resolved once
 * before a page is drawn.
 *
 * PDFKit stamps the chrome from a synchronous `pageAdded` handler, so nothing
 * inside the drawing code can await a database read. Everything that needs one
 * is gathered here instead and passed down — which is also why a logo uploaded
 * on the settings screen reaches a PDF at all.
 */
export interface LetterheadIdentity {
  profile: CompanyProfile;
  /** The lock-up: uploaded first, the file in `server/assets/` second, null when neither. */
  logo: Buffer | null;
  /** The square mark, for the watermark. Same order. */
  mark: Buffer | null;
}

export async function letterheadIdentity(): Promise<LetterheadIdentity> {
  const [profile, uploadedLogo, uploadedMark] = await Promise.all([
    companyProfile(),
    brandImage("logoLight"),
    brandImage("mark"),
  ]);
  return {
    profile,
    logo: (uploadedLogo ? decodeDataUrl(uploadedLogo)?.buffer : null) ?? findAsset("logo", LOGO_CANDIDATES),
    mark: (uploadedMark ? decodeDataUrl(uploadedMark)?.buffer : null) ?? findAsset("mark", MARK_CANDIDATES),
  };
}

// --- Corner ribbons --------------------------------------------------------

/**
 * The diagonal wedges at top-right and bottom-left. Two shapes per corner: an
 * ink triangle in the corner itself and a lime band running parallel just
 * inside it, with a paper gap between so neither muddies the other. Lime is a
 * shape here, never type, which is the only place it is legible on white.
 */
function cornerRibbons(doc: PDFDoc) {
  const wedge = 74;
  const bandOuter = 112;
  const bandInner = 90;

  // Top right.
  doc.save();
  doc.fillColor(INK);
  doc.moveTo(PAGE_W - wedge, 0).lineTo(PAGE_W, 0).lineTo(PAGE_W, wedge).closePath().fill();
  doc.fillColor(MARK);
  doc
    .moveTo(PAGE_W - bandOuter, 0)
    .lineTo(PAGE_W - bandInner, 0)
    .lineTo(PAGE_W, bandInner)
    .lineTo(PAGE_W, bandOuter)
    .closePath()
    .fill();
  doc.restore();

  // Bottom left, mirrored.
  doc.save();
  doc.fillColor(INK);
  doc.moveTo(0, PAGE_H - wedge).lineTo(0, PAGE_H).lineTo(wedge, PAGE_H).closePath().fill();
  doc.fillColor(MARK);
  doc
    .moveTo(0, PAGE_H - bandOuter)
    .lineTo(0, PAGE_H - bandInner)
    .lineTo(bandInner, PAGE_H)
    .lineTo(bandOuter, PAGE_H)
    .closePath()
    .fill();
  doc.restore();
}

// --- Contact icons ---------------------------------------------------------

/**
 * Line icons at 1.5px-equivalent stroke, per the identity guide. Drawn rather
 * than imported so the documents carry no icon-font dependency, and kept to
 * four shapes that read at 8pt.
 */
function icon(doc: PDFDoc, kind: "pin" | "mail" | "phone" | "globe", x: number, y: number) {
  const s = 8;
  doc.save();
  doc.strokeColor(ACCENT).lineWidth(0.7);

  if (kind === "pin") {
    doc.circle(x + s / 2, y + s / 2 - 0.6, s / 2 - 1).stroke();
    doc.circle(x + s / 2, y + s / 2 - 0.6, 0.9).fillColor(ACCENT).fill();
    doc
      .moveTo(x + s / 2 - 1.8, y + s / 2 + 1.4)
      .lineTo(x + s / 2, y + s)
      .lineTo(x + s / 2 + 1.8, y + s / 2 + 1.4)
      .stroke();
  } else if (kind === "mail") {
    doc.rect(x + 0.4, y + 1.2, s - 0.8, s - 3).stroke();
    doc
      .moveTo(x + 0.4, y + 1.2)
      .lineTo(x + s / 2, y + s / 2 + 0.6)
      .lineTo(x + s - 0.4, y + 1.2)
      .stroke();
  } else if (kind === "phone") {
    // A handset, drawn as a tilted rounded bar.
    doc.roundedRect(x + 1.6, y + 0.6, s - 3.2, s - 1.2, 1.4).stroke();
    doc.moveTo(x + 2.8, y + s - 2.2).lineTo(x + s - 2.8, y + s - 2.2).stroke();
  } else {
    doc.circle(x + s / 2, y + s / 2, s / 2 - 0.8).stroke();
    doc.moveTo(x + 0.8, y + s / 2).lineTo(x + s - 0.8, y + s / 2).stroke();
    doc
      .moveTo(x + s / 2, y + 0.8)
      .bezierCurveTo(x + s / 2 - 2.4, y + s / 2, x + s / 2 - 2.4, y + s / 2, x + s / 2, y + s - 0.8)
      .stroke();
    doc
      .moveTo(x + s / 2, y + 0.8)
      .bezierCurveTo(x + s / 2 + 2.4, y + s / 2, x + s / 2 + 2.4, y + s / 2, x + s / 2, y + s - 0.8)
      .stroke();
  }
  doc.restore();
}

// --- The lock-up -----------------------------------------------------------

function wordmark(doc: PDFDoc, identity: LetterheadIdentity) {
  const { logo, profile } = identity;
  const top = 46;

  if (logo) {
    // Fitted into a fixed box so a logo of any exported size lands identically.
    try {
      doc.image(logo, MARGIN_X, top, { fit: [LOGO_BOX.width, LOGO_BOX.height] });
      return;
    } catch {
      // A corrupt file must not take the whole document down; fall through.
    }
  }

  doc.save();
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(21)
    .text(profile.name, MARGIN_X, top, { characterSpacing: 1.4, lineBreak: false });

  const markWidth = doc.widthOfString(profile.name, { characterSpacing: 1.4 });
  doc.fillColor(INK).font("Helvetica").fontSize(7).text("®", MARGIN_X + markWidth + 2, top + 1, { lineBreak: false });

  // The swoosh: one gold stroke under the wordmark, thickening left to right.
  // It is the only decorative element on the page, which is what lets it work.
  doc
    .save()
    .strokeColor(ACCENT)
    .lineWidth(1.6)
    .moveTo(MARGIN_X, top + 27)
    .bezierCurveTo(MARGIN_X + markWidth * 0.3, top + 31, MARGIN_X + markWidth * 0.7, top + 24.5, MARGIN_X + markWidth + 6, top + 27.5)
    .stroke()
    .restore();

  doc
    .fillColor(ACCENT_DEEP)
    .font("Helvetica-Bold")
    .fontSize(5.6)
    .text(profile.tagline, MARGIN_X, top + 34, { characterSpacing: 0.85, lineBreak: false });
  doc.restore();
}

function contactBlock(doc: PDFDoc, profile: CompanyProfile) {
  const dividerX = 372;
  const textX = 396;
  const iconX = 380;
  const top = 44;
  const step = 17;

  doc.save();
  doc.strokeColor(LINE).lineWidth(1).moveTo(dividerX, top).lineTo(dividerX, top + step * 3 + 12).stroke();

  const rows: { kind: "pin" | "mail" | "phone" | "globe"; text: string }[] = [
    { kind: "pin", text: profile.location },
    { kind: "mail", text: profile.email },
    { kind: "phone", text: profile.phone },
    { kind: "globe", text: profile.web },
  ];

  rows.forEach((row, index) => {
    const y = top + index * step;
    icon(doc, row.kind, iconX, y);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(row.text, textX, y, { lineBreak: false });
  });
  doc.restore();
}

// --- Footer ----------------------------------------------------------------

function footerBar(doc: PDFDoc, profile: CompanyProfile) {
  const y = PAGE_H - 64;
  doc.save();
  doc.strokeColor(LINE).lineWidth(1).moveTo(MARGIN_X, y).lineTo(PAGE_W - MARGIN_X, y).stroke();

  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .text(profile.footerLine, MARGIN_X, y + 12, { characterSpacing: 2.1, lineBreak: false });

  // Right-aligned: the site, then the social handles as plain letterforms.
  const socials = "f    X    ig    in";
  const socialWidth = doc.font("Helvetica-Bold").fontSize(7.5).widthOfString(socials, { characterSpacing: 1.2 });
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(7.5).text(socials, PAGE_W - MARGIN_X - socialWidth, y + 12, {
    characterSpacing: 1.2,
    lineBreak: false,
  });

  const web = profile.web;
  const webWidth = doc.font("Helvetica").fontSize(8).widthOfString(web);
  const webX = PAGE_W - MARGIN_X - socialWidth - 18 - webWidth;
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(web, webX, y + 11.5, { lineBreak: false });
  icon(doc, "globe", webX - 12, y + 10.5);
  doc.restore();
}

// --- Watermark -------------------------------------------------------------

/**
 * The oversized D behind the content. Stamped first, so everything sits over
 * it, and placed low-right where a page's last third is usually the emptiest —
 * a watermark centred in the text column fights every line that crosses it.
 */
function watermark(doc: PDFDoc, mark: Buffer | null) {

  if (mark) {
    // The real mark, dropped to a tint. Opacity rather than a pale copy of the
    // artwork, so one file serves both this and any full-strength use.
    doc.save();
    try {
      doc.opacity(0.05).image(mark, PAGE_W - 258, PAGE_H - 392, { fit: [232, 232] });
      doc.restore();
      return;
    } catch {
      // Fall through to the typographic watermark rather than lose the page.
    }
    doc.restore();
  }

  doc.save();
  doc.fillColor(WATERMARK).font("Helvetica-Bold").fontSize(270).text("D", PAGE_W - 245, PAGE_H - 395, {
    lineBreak: false,
    characterSpacing: 0,
  });
  doc.restore();
}

// --- Stamping --------------------------------------------------------------

/**
 * Everything above, in back-to-front order, then the cursor put back at the
 * top of the content area. PDFKit resets x/y when it adds a page and then
 * emits `pageAdded`, so drawing here would otherwise leave the cursor
 * wherever the last footer glyph landed.
 */
export function stampLetterhead(doc: PDFDoc, identity: LetterheadIdentity) {
  watermark(doc, identity.mark);
  cornerRibbons(doc);
  wordmark(doc, identity);
  contactBlock(doc, identity.profile);
  footerBar(doc, identity.profile);

  doc.fillColor(INK).font("Helvetica").fontSize(10);
  doc.x = MARGIN_X;
  doc.y = CONTENT_TOP;
}

/** True when there is real artwork to stamp, for the settings read-out. */
export async function hasLogoAsset(): Promise<boolean> {
  return (await letterheadIdentity()).logo !== null;
}

/** The box the lock-up is fitted into, shared by every letterhead renderer. */
export const LOGO_BOX = { width: 190, height: 46 };

/** Intrinsic size from a PNG's IHDR. Null for anything that is not a PNG. */
function pngSize(data: Buffer): { width: number; height: number } | null {
  const isPng = data.length > 24 && data.readUInt32BE(0) === 0x89504e47;
  if (!isPng) return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/**
 * The lock-up as bytes, already fitted to LOGO_BOX, for renderers that embed
 * rather than draw — the .docx letterhead, which has no "fit" of its own and
 * needs the final points. Null when no artwork is present, which is the
 * caller's cue to fall back to the typographic wordmark, exactly as the PDF does.
 */
export function readLogoAsset(identity: LetterheadIdentity): { data: Buffer; width: number; height: number } | null {
  const data = identity.logo;
  if (!data) return null;
  const size = pngSize(data);
  if (!size) return { data, ...LOGO_BOX };

  const scale = Math.min(LOGO_BOX.width / size.width, LOGO_BOX.height / size.height);
  return { data, width: size.width * scale, height: size.height * scale };
}
