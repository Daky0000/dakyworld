import zlib from "node:zlib";

/**
 * A minimal RGBA PNG encoder, and the letterhead's corner ribbons drawn with it.
 *
 * Word has no way to draw a diagonal, so the ribbons that the PDF strokes as
 * paths have to reach a .docx as images. The alternatives were committing
 * binary artwork nobody can regenerate, or pulling in an image library to draw
 * two triangles. Encoding a PNG by hand is about sixty lines and leaves the
 * ribbons defined in exactly one place — the same numbers the PDF uses.
 */

// --- PNG ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** `pixels` is width * height * 4 bytes, RGBA, top row first. */
export function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  // Each scanline is prefixed with its filter type; 0 means "none", which
  // costs a little size and saves a lot of code.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Reading one back -----------------------------------------------------

/**
 * Enough of a PNG decoder to crop a screenshot, and no more.
 *
 * A full-page screenshot of a homepage can come back 1280 by twelve thousand
 * pixels, which is past what every vision model will accept and several
 * megabytes of base64 nobody needed: the argument an email makes is about what
 * a visitor sees when the page opens, not about the footer. Cropping needs a
 * decoder, and a decoder for *this* — 8-bit, non-interlaced, straight out of a
 * headless Chrome — is sixty lines of `zlib.inflateSync` and an unfilter loop,
 * against an image library and its transitive tree.
 *
 * It handles what Chrome emits and refuses everything else by returning null.
 * A refusal is not a failure: the caller keeps the original bytes and says so.
 */

export interface DecodedPng {
  width: number;
  height: number;
  /** width * height * 4, RGBA, top row first — the shape `encodePng` takes. */
  pixels: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height without decoding anything — eight bytes into the IHDR. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE)) return null;
  if (png.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Channels per pixel for the colour types Chrome actually writes. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(png: Buffer): DecodedPng | null {
  const size = pngSize(png);
  if (!size) return null;

  const bitDepth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  const channels = CHANNELS[colorType];
  // Palettes, 16-bit samples and Adam7 are all real PNG and none of them come
  // out of a screenshot. Refuse rather than decode them wrongly.
  if (bitDepth !== 8 || interlace !== 0 || !channels) return null;

  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("latin1");
    const start = offset + 8;
    if (type === "IDAT") idat.push(png.subarray(start, start + length));
    if (type === "IEND") break;
    offset = start + length + 4; // + CRC
  }
  if (idat.length === 0) return null;

  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const { width, height } = size;
  const bpp = channels;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;

  // Unfilter in place, one scanline at a time. Each filter is defined against
  // the pixel to the left, the one above, and the one above-left.
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    // Checked before the row rather than inside it: a Buffer cell cannot hold
    // a sentinel, so an unknown filter has to be caught while it still can be.
    if (filter > 4) return null;
    const source = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const line = lines.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? line[x - bpp] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= bpp ? prior[x - bpp] : 0;
      const value = source[x];
      line[x] =
        filter === 0
          ? value
          : filter === 1
            ? (value + left) & 0xff
            : filter === 2
              ? (value + up) & 0xff
              : filter === 3
                ? (value + ((left + up) >> 1)) & 0xff
                : (value + paeth(left, up, upLeft)) & 0xff;
    }
  }

  // Out to RGBA, whatever came in.
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const at = i * bpp;
    if (colorType === 6) {
      pixels[p] = lines[at];
      pixels[p + 1] = lines[at + 1];
      pixels[p + 2] = lines[at + 2];
      pixels[p + 3] = lines[at + 3];
    } else if (colorType === 2) {
      pixels[p] = lines[at];
      pixels[p + 1] = lines[at + 1];
      pixels[p + 2] = lines[at + 2];
      pixels[p + 3] = 255;
    } else if (colorType === 0) {
      pixels[p] = pixels[p + 1] = pixels[p + 2] = lines[at];
      pixels[p + 3] = 255;
    } else {
      pixels[p] = pixels[p + 1] = pixels[p + 2] = lines[at];
      pixels[p + 3] = lines[at + 1];
    }
  }

  return { width, height, pixels };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * The top `rows` pixels of a PNG, re-encoded. Null when it could not be read,
 * and the original when it is already short enough — so a caller can write
 * `cropPngTop(png, 2400) ?? png` and be right either way.
 */
export function cropPngTop(png: Buffer, rows: number): Buffer | null {
  const size = pngSize(png);
  if (!size) return null;
  if (size.height <= rows) return png;

  const decoded = decodePng(png);
  if (!decoded) return null;

  const kept = Math.min(rows, decoded.height);
  return encodePng(decoded.width, kept, decoded.pixels.subarray(0, decoded.width * kept * 4));
}

// --- The ribbons ----------------------------------------------------------

/**
 * The same geometry as services/letterhead.ts draws in the PDF: an ink
 * wedge in the corner itself, and a lime band running parallel just inside it.
 * A point belongs to one or the other by its distance from the corner measured
 * along the diagonal, which is what makes both edges a single comparison.
 */
export const RIBBON_PT = 112;
const WEDGE_PT = 74;
const BAND_INNER_PT = 90;
const BAND_OUTER_PT = RIBBON_PT;

const INK_RGB = [8, 16, 31] as const;
const MARK_RGB = [184, 255, 61] as const;

/** 3 device pixels per point — crisp at print resolution, still a tiny image. */
const SCALE = 3;
/** Coverage sampling, so the diagonals don't come out as staircases. */
const SUB = 3;

type Corner = "top-right" | "bottom-left";

function band(t: number): 0 | 1 | 2 {
  if (t <= WEDGE_PT) return 1; // ink
  if (t >= BAND_INNER_PT && t <= BAND_OUTER_PT) return 2; // mark
  return 0;
}

export function ribbonPng(corner: Corner): Buffer {
  const size = Math.round(RIBBON_PT * SCALE);
  const pixels = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let ink = 0;
      let mark = 0;

      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const x = (px + (sx + 0.5) / SUB) / SCALE;
          const y = (py + (sy + 0.5) / SUB) / SCALE;
          // Distance from the page corner, along the diagonal.
          const t = corner === "top-right" ? RIBBON_PT - x + y : x + (RIBBON_PT - y);
          const which = band(t);
          if (which === 1) ink += 1;
          else if (which === 2) mark += 1;
        }
      }

      const total = SUB * SUB;
      const offset = (py * size + px) * 4;
      if (ink === 0 && mark === 0) continue;

      // The two never overlap, so whichever has coverage decides the colour and
      // the combined coverage decides the alpha.
      const rgb = ink >= mark ? INK_RGB : MARK_RGB;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = Math.round(((ink + mark) / total) * 255);
    }
  }

  return encodePng(size, size, pixels);
}

// Drawing them is cheap but not free, and they never change within a process.
const cache = new Map<Corner, Buffer>();

export function ribbon(corner: Corner): Buffer {
  const hit = cache.get(corner);
  if (hit) return hit;
  const png = ribbonPng(corner);
  cache.set(corner, png);
  return png;
}
