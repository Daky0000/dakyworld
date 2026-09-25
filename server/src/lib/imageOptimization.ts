import { sniff } from "./fileType.js";
import { looksLikeSvg, sanitizeSvg } from "./svgSanitize.js";

export type ImageOptimizationResult = {
  content: Buffer;
  contentType: string;
  extension: string;
  strippedExif: boolean;
};

/**
 * Strips EXIF and metadata chunks from a JPEG buffer.
 * JPEG markers follow 0xFF followed by marker code and 2-byte length.
 * 0xE1 is APP1 (EXIF / XMP).
 */
export function stripJpegMetadata(buffer: Buffer): { buffer: Buffer; stripped: boolean } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return { buffer, stripped: false };
  }

  const chunks: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  let stripped = false;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;

    // Skip consecutive 0xFF fill bytes
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset++;
    }
    if (offset >= buffer.length) break;

    const marker = buffer[offset]!;
    offset++;

    // End of image
    if (marker === 0xd9) {
      chunks.push(Buffer.from([0xff, 0xd9]));
      break;
    }

    // Standalone markers with no length (RST0..RST7, TEM)
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      chunks.push(Buffer.from([0xff, marker]));
      continue;
    }

    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (offset + length > buffer.length) break;

    // 0xE1 is APP1 (EXIF/XMP metadata), 0xFE is Comment
    if (marker === 0xe1 || marker === 0xfe) {
      stripped = true;
      offset += length;
      continue;
    }

    // Start of scan (SOS) - rest of file is compressed entropy data until EOI
    if (marker === 0xda) {
      chunks.push(buffer.subarray(offset - 2)); // includes FF, DA, length, and all data
      break;
    }

    chunks.push(buffer.subarray(offset - 2, offset + length));
    offset += length;
  }

  return { buffer: stripped ? Buffer.concat(chunks) : buffer, stripped };
}

/**
 * Strips ancillary metadata chunks (eXIf, tEXt, zTXt, iTXt) from a PNG buffer.
 */
export function stripPngMetadata(buffer: Buffer): { buffer: Buffer; stripped: boolean } {
  const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_HEADER)) {
    return { buffer, stripped: false };
  }

  const chunks: Buffer[] = [PNG_HEADER];
  let offset = 8;
  let stripped = false;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const totalChunkLength = 12 + length; // 4 (length) + 4 (type) + length (data) + 4 (crc)

    if (offset + totalChunkLength > buffer.length) break;

    // Drop non-critical metadata chunks
    if (["eXIf", "tEXt", "zTXt", "iTXt"].includes(chunkType)) {
      stripped = true;
      offset += totalChunkLength;
      continue;
    }

    chunks.push(buffer.subarray(offset, offset + totalChunkLength));
    offset += totalChunkLength;

    if (chunkType === "IEND") break;
  }

  return { buffer: stripped ? Buffer.concat(chunks) : buffer, stripped };
}

/**
 * Optimizes an uploaded image buffer for web hosting:
 * - Detects format via magic bytes
 * - Attempts native WebP conversion/resizing if sharp is available
 * - Otherwise falls back to lossless EXIF/metadata stripping and byte validation
 */
export async function optimizeImageBuffer(raw: Buffer): Promise<ImageOptimizationResult> {
  const mime = sniff(raw);
  // SVG has no magic number to sniff, and it is markup that can run script. It
  // is kept only as the sanitiser rebuilds it (see lib/svgSanitize.ts), which
  // also makes it the only format here whose bytes are always rewritten.
  if (!mime && looksLikeSvg(raw)) {
    return { content: Buffer.from(sanitizeSvg(raw.toString("utf8")), "utf8"), contentType: "image/svg+xml", extension: "svg", strippedExif: false };
  }
  const formats: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };

  if (!mime || !formats[mime]) {
    throw new Error("Unsupported image format. Upload a PNG, JPEG, WebP, or GIF.");
  }

  // 1. Try sharp if dynamically present in runtime environment
  try {
    // @ts-ignore
    const sharpModule = await import("sharp").catch(() => null);
    const sharp = sharpModule?.default || sharpModule;
    if (typeof sharp === "function") {
      const optimized = await sharp(raw)
        .rotate()
        .resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 84 })
        .toBuffer();
      return {
        content: optimized,
        contentType: "image/webp",
        extension: "webp",
        strippedExif: true,
      };
    }
  } catch {
    // Fall back to pure buffer pipeline
  }

  // 2. Pure buffer metadata stripping fallback
  if (mime === "image/jpeg") {
    const { buffer: clean, stripped } = stripJpegMetadata(raw);
    return { content: clean, contentType: mime, extension: formats[mime]!, strippedExif: stripped };
  }

  if (mime === "image/png") {
    const { buffer: clean, stripped } = stripPngMetadata(raw);
    return { content: clean, contentType: mime, extension: formats[mime]!, strippedExif: stripped };
  }

  return { content: raw, contentType: mime, extension: formats[mime]!, strippedExif: false };
}
