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

// --- The ribbons ----------------------------------------------------------

/**
 * The same geometry as services/letterhead.ts draws in the PDF: an obsidian
 * wedge in the corner itself, and a gold band running parallel just inside it.
 * A point belongs to one or the other by its distance from the corner measured
 * along the diagonal, which is what makes both edges a single comparison.
 */
export const RIBBON_PT = 112;
const WEDGE_PT = 74;
const BAND_INNER_PT = 90;
const BAND_OUTER_PT = RIBBON_PT;

const OBSIDIAN_RGB = [11, 11, 12] as const;
const GOLD_RGB = [199, 162, 76] as const;

/** 3 device pixels per point — crisp at print resolution, still a tiny image. */
const SCALE = 3;
/** Coverage sampling, so the diagonals don't come out as staircases. */
const SUB = 3;

type Corner = "top-right" | "bottom-left";

function band(t: number): 0 | 1 | 2 {
  if (t <= WEDGE_PT) return 1; // obsidian
  if (t >= BAND_INNER_PT && t <= BAND_OUTER_PT) return 2; // gold
  return 0;
}

export function ribbonPng(corner: Corner): Buffer {
  const size = Math.round(RIBBON_PT * SCALE);
  const pixels = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let obsidian = 0;
      let gold = 0;

      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const x = (px + (sx + 0.5) / SUB) / SCALE;
          const y = (py + (sy + 0.5) / SUB) / SCALE;
          // Distance from the page corner, along the diagonal.
          const t = corner === "top-right" ? RIBBON_PT - x + y : x + (RIBBON_PT - y);
          const which = band(t);
          if (which === 1) obsidian += 1;
          else if (which === 2) gold += 1;
        }
      }

      const total = SUB * SUB;
      const offset = (py * size + px) * 4;
      if (obsidian === 0 && gold === 0) continue;

      // The two never overlap, so whichever has coverage decides the colour and
      // the combined coverage decides the alpha.
      const rgb = obsidian >= gold ? OBSIDIAN_RGB : GOLD_RGB;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = Math.round(((obsidian + gold) / total) * 255);
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
