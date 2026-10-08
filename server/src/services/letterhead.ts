import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type PDFDocument from "pdfkit";
import { brandImage, companyProfile, decodeDataUrl, type CompanyProfile } from "./systemProfile.js";

type PDFDoc = InstanceType<typeof PDFDocument>;

/**
 * The DakyXTech letterhead, drawn onto every page of every document the app
 * produces.
 *
 * A proposal and an invoice are the two things a client actually keeps. Until
 * now they came out as plain typed pages with a wordmark on top, which reads
 * as a document somebody generated rather than one a company sent. This is the
 * printed identity: since v22 (8 Oct 2026) a navy band across the top of every
 * page carrying the website's dot field, the white lock-up and the contact
 * block, then the page, then a plain footer rule. The corner ribbons and the
 * watermark went with it — see website-drafts/system-v22.html.
 *
 * A workspace that uploaded its own logo gets a white band with that logo
 * instead, because uploads are on-light artwork (the email shell does the same).
 *
 * Colours and type follow the website design system (`DakyXTech Website/
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

/* docs/DESIGN-SYSTEM.md v21 (8 Oct 2026). Lime is retired: the corner wedges
   that carried it are blue now, the one accent everywhere. */
export const INK = "#0D1526";
export const NAVY = "#091833";
/** The canvas the website's panels sit on. The old name stays for callers. */
export const CREAM = "#ECEEF1";
/** Legible accent: rules, hairline icons, small bold type. */
export const ACCENT = "#2563EB";
/** The same blue, darkened, for accent type that sits under 8pt. */
export const ACCENT_DEEP = "#1D4ED8";
export const MUTED = "#5B6374";
export const LINE = "#E3E6EB";
/** Solid mark colour, for shapes only, never type. */
export const MARK = "#2563EB";
/** The pale-blue panel (§2 pale) — a balance due, a summary box. */
export const PALE = "#EAF1FF";
/** The soft grey of a table header row (§2 soft). */
export const SOFT = "#F6F7F9";

// --- Page geometry ---------------------------------------------------------

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN_X = 56;
/** Content starts below the letterhead block and ends above the footer rule. */
export const CONTENT_TOP = 150;
/** The navy band across the top of every page. */
export const BAND_H = 104;
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
/** The white lock-up for the navy band. Shipped only — there is no upload slot for it. */
const LOGO_ON_DARK_CANDIDATES = assetCandidates(["logo-on-dark.png"]);
/** The band as a picture, for Word, which cannot draw it (scripts/generate_email_band.py). */
const DOC_BAND_CANDIDATES = assetCandidates(["doc-band.png"]);

/** The A4 navy band with the dot field, or null when the file is missing. */
export function docBandAsset(): Buffer | null {
  return findAsset("docBand", DOC_BAND_CANDIDATES);
}
/** The square mark on its own, for the watermark. Optional. */
const MARK_CANDIDATES = assetCandidates(["mark.png", "mark.jpg", "mark.jpeg"]);

/**
 * Outfit, the one brand typeface (DESIGN-SYSTEM.md §3), for every PDF.
 *
 * Every document in the app sets its type with pdfkit's built-in names —
 * "Helvetica", "Helvetica-Bold", "Helvetica-Oblique" — in some three hundred
 * calls. pdfkit looks a name up among registered fonts before its standard
 * fourteen, so registering Outfit under those four names changes the face of
 * every document at once and leaves the calls alone. Outfit has no italic, so
 * the oblique cuts map to its light weight, which keeps the distinction.
 * If the files are missing the documents fall back to Helvetica, unchanged.
 */
const FONT_FILES: Record<string, string> = {
  Helvetica: "Outfit-Regular.ttf",
  "Helvetica-Bold": "Outfit-SemiBold.ttf",
  "Helvetica-Oblique": "Outfit-Light.ttf",
  "Helvetica-BoldOblique": "Outfit-Medium.ttf",
};
const fontPaths = new Map<string, string | null>();
export function useBrandFonts(doc: PDFDoc): PDFDoc {
  for (const [name, file] of Object.entries(FONT_FILES)) {
    if (!fontPaths.has(file)) fontPaths.set(file, assetCandidates([`fonts/${file}`]).find((p) => fs.existsSync(p)) ?? null);
    const hit = fontPaths.get(file);
    if (hit) {
      try {
        doc.registerFont(name, hit);
      } catch {
        // A damaged file leaves this one name on Helvetica; the document still renders.
      }
    }
  }
  // pdfkit loads Helvetica when the document is constructed and caches it by
  // name, and the cache is consulted before the registered fonts — so without
  // this every plain-text run stayed Helvetica while the bold ones changed.
  const cache = (doc as unknown as { _fontFamilies?: Record<string, unknown> })._fontFamilies;
  if (cache) for (const name of Object.keys(FONT_FILES)) delete cache[name];
  doc.font("Helvetica");
  return doc;
}

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
  /** The square mark. Same order. */
  mark: Buffer | null;
  /** The white lock-up for the navy band, or null when an uploaded logo should be used on white instead. */
  logoOnDark: Buffer | null;
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
    logoOnDark: uploadedLogo ? null : findAsset("logoOnDark", LOGO_ON_DARK_CANDIDATES),
  };
}

// --- The band --------------------------------------------------------------

/**
 * The navy band and the website's dot field (DESIGN-SYSTEM.md, the dot
 * pattern): an 11px grid of dots seen through soft patches, kept to the right
 * so the lock-up and the contact lines sit on clean navy. Drawn as vectors, so
 * it prints sharp at any size and costs a few kilobytes.
 */
const BAND_DOT = "#4A639B";
const DOT_PATCHES: [number, number, number, number][] = [
  [0.6, 0.42, 0.16, 0.85],
  [0.79, 0.72, 0.13, 0.7],
  [0.5, 0.15, 0.1, 0.55],
];

function band(doc: PDFDoc, onDark: boolean) {
  doc.save();
  doc.rect(0, 0, PAGE_W, BAND_H).fill(onDark ? NAVY : "#FFFFFF");
  if (onDark) {
    const step = 7.5;
    doc.fillColor(BAND_DOT);
    for (let y = step / 2; y < BAND_H; y += step) {
      for (let x = step / 2; x < PAGE_W; x += step) {
        let strength = 0;
        for (const [cx, cy, rx, ry] of DOT_PATCHES) {
          const d = Math.hypot((x / PAGE_W - cx) / rx, (y / BAND_H - cy) / ry);
          strength = Math.max(strength, d < 0.55 ? 1 : Math.max(0, (1 - d) / 0.45));
        }
        if (strength < 0.08) continue;
        doc.fillOpacity(0.55 * strength).circle(x, y, 0.8).fill();
      }
    }
    doc.fillOpacity(1);
  } else {
    doc.strokeColor(LINE).lineWidth(1).moveTo(MARGIN_X, BAND_H).lineTo(PAGE_W - MARGIN_X, BAND_H).stroke();
  }
  doc.restore();
}

// --- Contact icons ---------------------------------------------------------

/**
 * Line icons at 1.5px-equivalent stroke, per the identity guide. Drawn rather
 * than imported so the documents carry no icon-font dependency, and kept to
 * four shapes that read at 8pt.
 */
function icon(doc: PDFDoc, kind: "pin" | "mail" | "phone" | "globe", x: number, y: number, colour: string = ACCENT) {
  const s = 8;
  doc.save();
  doc.strokeColor(colour).lineWidth(0.7);

  if (kind === "pin") {
    doc.circle(x + s / 2, y + s / 2 - 0.6, s / 2 - 1).stroke();
    doc.circle(x + s / 2, y + s / 2 - 0.6, 0.9).fillColor(colour).fill();
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
  const { logo, logoOnDark, profile } = identity;
  const art = logoOnDark ?? logo;
  // Vertically centred in the band.
  const top = (BAND_H - LOGO_BOX.height) / 2;

  if (art) {
    // Fitted into a fixed box so a logo of any exported size lands identically.
    try {
      doc.image(art, MARGIN_X, top, { fit: [LOGO_BOX.width, LOGO_BOX.height], valign: "center" });
      return;
    } catch {
      // A corrupt file must not take the whole document down; fall through.
    }
  }

  doc.save();
  doc
    .fillColor(logoOnDark !== null ? "#FFFFFF" : INK)
    .font("Helvetica-Bold")
    .fontSize(21)
    .text(profile.name, MARGIN_X, BAND_H / 2 - 12, { lineBreak: false });
  doc.restore();
}

/** Contact lines on the right of the band, light on navy (or muted on white). */
function contactBlock(doc: PDFDoc, profile: CompanyProfile, onDark: boolean) {
  const rows: { kind: "pin" | "mail" | "phone" | "globe"; text: string }[] = [
    { kind: "pin", text: profile.location },
    { kind: "mail", text: profile.email },
    { kind: "phone", text: profile.phone },
    { kind: "globe", text: profile.web },
  ];
  const step = 14;
  const top = (BAND_H - step * rows.length) / 2 + 2;
  const right = PAGE_W - MARGIN_X;
  const textColour = onDark ? "#B4BFD3" : MUTED;
  const iconColour = onDark ? "#8FB2FF" : ACCENT;

  doc.save();
  doc.font("Helvetica").fontSize(8.5);
  const widest = Math.max(...rows.map((row) => doc.widthOfString(row.text)));
  const textX = right - widest;
  rows.forEach((row, index) => {
    const y = top + index * step;
    icon(doc, row.kind, textX - 14, y + 0.5, iconColour);
    doc.fillColor(textColour).font("Helvetica").fontSize(8.5).text(row.text, textX, y, { lineBreak: false });
  });
  doc.restore();
}

// --- Footer ----------------------------------------------------------------

function footerBar(doc: PDFDoc, profile: CompanyProfile) {
  const y = PAGE_H - 56;
  doc.save();
  doc.strokeColor(LINE).lineWidth(1).moveTo(MARGIN_X, y).lineTo(PAGE_W - MARGIN_X, y).stroke();
  doc
    .fillColor("#8A91A0")
    .font("Helvetica")
    .fontSize(7.5)
    .text(`${profile.name.toUpperCase()}  ·  ${profile.footerLine.toUpperCase()}`, MARGIN_X, y + 12, { characterSpacing: 1.1, lineBreak: false });
  const web = profile.web;
  const webWidth = doc.font("Helvetica").fontSize(8).widthOfString(web);
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(web, PAGE_W - MARGIN_X - webWidth, y + 11.5, { lineBreak: false });
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
  const onDark = identity.logoOnDark !== null;
  band(doc, onDark);
  wordmark(doc, identity);
  contactBlock(doc, identity.profile, onDark);
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

/**
 * Text that the built-in fonts can actually draw.
 *
 * PDFKit's standard Helvetica is WinAnsi-encoded, which has no arrow. Every
 * "Settings -> AI models" sentence in this app is written with a real arrow,
 * and one of them reached a rendered page as `Settings !' AI models` before
 * anybody looked at the PDF.
 *
 * Lives here rather than in one renderer because there are now several, and a
 * second copy is a second thing to forget: the dossier PDF renders Markdown
 * written by agents, which is the text most likely of all to contain an arrow
 * or a bullet. Embedding a Unicode font instead would be the other answer, and
 * it is the wrong one — 300KB in every generated document to render four
 * characters that have perfectly good ASCII spellings.
 */
const UNRENDERABLE: [RegExp, string][] = [
  [/[→➡⇒]/g, "->"],
  [/[←⇐]/g, "<-"],
  [/[✓✔]/g, "yes"],
  [/[✗✘]/g, "no"],
  [/[•●▪]/g, "-"],
  [/…/g, "..."],
  [/[≤]/g, "<="],
  [/[≥]/g, ">="],
  [/[×]/g, "x"],
];

export function pdfText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of UNRENDERABLE) out = out.replace(pattern, replacement);
  return out;
}


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
export function readLogoAsset(identity: LetterheadIdentity, onDark = false): { data: Buffer; width: number; height: number } | null {
  const data = onDark ? identity.logoOnDark : identity.logo;
  if (!data) return null;
  const size = pngSize(data);
  if (!size) return { data, ...LOGO_BOX };

  const scale = Math.min(LOGO_BOX.width / size.width, LOGO_BOX.height / size.height);
  return { data, width: size.width * scale, height: size.height * scale };
}
