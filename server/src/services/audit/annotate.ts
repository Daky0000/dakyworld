import { decodePng, encodePng } from "../png.js";
import type { AuditFindingDetail, Region } from "./types.js";

/**
 * Drawing the findings onto the screenshot.
 *
 * A sentence that says "nothing on the first screen tells a visitor what you
 * sell" is an opinion the owner can wave away. The same sentence beside their
 * own homepage with a box drawn round the top of it is something they have to
 * either accept or argue with, and either one means they are reading. That is
 * the whole reason this file exists.
 *
 * It is done here rather than in the PDF because the PDF is not the only place
 * the picture goes — the Markdown carries it, the drawer shows it, and a
 * marked-up picture that only exists inside one renderer would have to be
 * redrawn by every other one. One annotated PNG, made once, used everywhere.
 *
 * No image library. `png.ts` already has a decoder and an encoder for exactly
 * the kind of PNG a headless Chrome produces, written for the crop; this is
 * pixel writes into the array it hands back, and a seven-row bitmap font for
 * the numbers. The alternative was a canvas dependency and its native build,
 * on a deploy that currently needs neither.
 *
 * **The boxes are approximate and every caption says so.** A model can point at
 * the top third of a page reliably. It cannot measure to the pixel, and a
 * caption implying it did would be the same false precision as reporting a
 * performance score nobody measured.
 */

/** Brand blue — structure and emphasis. The colour of a point being made. */
const BLUE: RGB = [0x31, 0x57, 0xff];
/** Brand lime — positive status only, which is exactly what a GOOD finding is. */
const LIME: RGB = [0xb8, 0xff, 0x3d];
const INK: RGB = [0x08, 0x10, 0x1f];
const CREAM: RGB = [0xf4, 0xf5, 0xf0];

type RGB = readonly [number, number, number];

/** Scales with the image so a box on a phone screenshot is not four times as heavy. */
function strokeFor(width: number): number {
  return Math.max(2, Math.round(width / 320));
}

const DIGIT_SCALE_DIVISOR = 200;

/**
 * Digits 0-9 as 5x7 bitmaps.
 *
 * Seven rows is the smallest size at which a digit stays unambiguous when it is
 * scaled up by whole pixels, which is the only kind of scaling available here —
 * there is no anti-aliasing, so a fractional scale would produce a number with
 * a limp.
 */
const DIGITS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

interface Canvas {
  width: number;
  height: number;
  pixels: Uint8Array;
}

function setPixel(canvas: Canvas, x: number, y: number, colour: RGB, alpha = 1): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const at = (y * canvas.width + x) * 4;
  if (alpha >= 1) {
    canvas.pixels[at] = colour[0];
    canvas.pixels[at + 1] = colour[1];
    canvas.pixels[at + 2] = colour[2];
    canvas.pixels[at + 3] = 255;
    return;
  }
  // Straight alpha over an opaque screenshot, so no premultiplication and no
  // need to touch the alpha channel: the picture underneath is already solid.
  canvas.pixels[at] = Math.round(canvas.pixels[at] * (1 - alpha) + colour[0] * alpha);
  canvas.pixels[at + 1] = Math.round(canvas.pixels[at + 1] * (1 - alpha) + colour[1] * alpha);
  canvas.pixels[at + 2] = Math.round(canvas.pixels[at + 2] * (1 - alpha) + colour[2] * alpha);
}

function fillRect(canvas: Canvas, x: number, y: number, width: number, height: number, colour: RGB, alpha = 1): void {
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) setPixel(canvas, column, row, colour, alpha);
  }
}

/**
 * A rectangle outline with a dark hairline on each side of it.
 *
 * The hairline is the difference between a box that reads on any screenshot and
 * one that vanishes. A blue box on a blue hero is invisible; a blue box with an
 * ink edge is visible on a blue hero, on a white page and on a photograph,
 * which is the whole range this has to survive.
 */
function strokeRect(canvas: Canvas, x: number, y: number, width: number, height: number, thickness: number, colour: RGB): void {
  const halo = Math.max(1, Math.round(thickness / 3));

  for (const [inset, paint, weight] of [
    [-halo, INK, halo],
    [0, colour, thickness],
    [thickness, INK, halo],
  ] as const) {
    const left = x + inset;
    const top = y + inset;
    const boxWidth = width - inset * 2;
    const boxHeight = height - inset * 2;
    if (boxWidth <= 0 || boxHeight <= 0) continue;
    fillRect(canvas, left, top, boxWidth, weight, paint);
    fillRect(canvas, left, top + boxHeight - weight, boxWidth, weight, paint);
    fillRect(canvas, left, top, weight, boxHeight, paint);
    fillRect(canvas, left + boxWidth - weight, top, weight, boxHeight, paint);
  }
}

function drawDigit(canvas: Canvas, digit: string, x: number, y: number, scale: number, colour: RGB): void {
  const rows = DIGITS[digit];
  if (!rows) return;
  for (let row = 0; row < rows.length; row++) {
    for (let column = 0; column < rows[row].length; column++) {
      if (rows[row][column] !== "1") continue;
      fillRect(canvas, x + column * scale, y + row * scale, scale, scale, colour);
    }
  }
}

/**
 * The numbered badge, in the corner of the box.
 *
 * Placed inside the box rather than above it, because a box at the very top of
 * a screenshot has nothing above it to place a badge in — and a badge drawn off
 * the edge of the picture is a number nobody can match to a paragraph.
 */
function drawBadge(canvas: Canvas, x: number, y: number, marker: number, colour: RGB): void {
  const scale = Math.max(2, Math.round(canvas.width / DIGIT_SCALE_DIVISOR));
  const text = String(marker);
  const padding = scale * 2;
  const digitWidth = 5 * scale;
  const gap = scale;
  const width = padding * 2 + text.length * digitWidth + (text.length - 1) * gap;
  const height = padding * 2 + 7 * scale;

  // Kept on the picture even when the box starts at the very edge.
  const left = Math.min(Math.max(0, x), Math.max(0, canvas.width - width));
  const top = Math.min(Math.max(0, y), Math.max(0, canvas.height - height));

  fillRect(canvas, left, top, width, height, INK);
  // A hairline in the box's own colour, so a reader can tell a GOOD badge from
  // a problem badge without reading the number back against the document.
  fillRect(canvas, left, top, width, Math.max(1, Math.round(scale / 2)), colour);

  let cursor = left + padding;
  for (const digit of text) {
    drawDigit(canvas, digit, cursor, top + padding, scale, CREAM);
    cursor += digitWidth + gap;
  }
}

export interface AnnotateResult {
  /** The marked-up picture, base64 PNG. Null when the original could not be read. */
  base64: string | null;
  /** The markers actually drawn, in the order they appear on the picture. */
  drawn: number[];
  note: string | null;
}

/**
 * Draws every finding that carries a region for this view.
 *
 * Returns null rather than throwing when the PNG is one `png.ts` will not
 * decode: an un-annotated screenshot in the report is a small loss, and losing
 * the whole audit to a picture is not a trade worth making.
 */
export function annotateScreenshot(base64: string, view: "desktop" | "mobile", findings: AuditFindingDetail[]): AnnotateResult {
  const boxed = findings.filter((finding): finding is AuditFindingDetail & { region: Region; marker: number } => Boolean(finding.region && finding.marker && finding.region.view === view));
  if (!boxed.length) return { base64: null, drawn: [], note: null };

  const decoded = decodePng(Buffer.from(base64, "base64"));
  if (!decoded) {
    return { base64: null, drawn: [], note: "The screenshot could not be marked up — it is in a PNG variant this cannot read. The plain picture is used instead." };
  }

  const canvas: Canvas = { width: decoded.width, height: decoded.height, pixels: decoded.pixels };
  const thickness = strokeFor(canvas.width);
  const drawn: number[] = [];

  for (const finding of boxed) {
    const x = Math.round(finding.region.x * canvas.width);
    const y = Math.round(finding.region.y * canvas.height);
    const width = Math.max(thickness * 6, Math.round(finding.region.width * canvas.width));
    const height = Math.max(thickness * 6, Math.round(finding.region.height * canvas.height));
    const colour = finding.severity === "GOOD" ? LIME : BLUE;

    // A wash inside the box, light enough to read the page through. Without it
    // a box around a large area reads as a border on the picture rather than a
    // mark on the page.
    fillRect(canvas, x, y, Math.min(width, canvas.width - x), Math.min(height, canvas.height - y), colour, 0.08);
    strokeRect(canvas, x, y, Math.min(width, canvas.width - x), Math.min(height, canvas.height - y), thickness, colour);
    drawBadge(canvas, x + thickness, y + thickness, finding.marker, colour);
    drawn.push(finding.marker);
  }

  return {
    base64: encodePng(canvas.width, canvas.height, canvas.pixels).toString("base64"),
    drawn,
    note: null,
  };
}
