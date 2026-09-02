import sharp from "sharp";

/**
 * Cutting a screenshot down to what a vision model will actually read.
 *
 * The server used to do this with a PNG decoder written by hand, because it
 * was decoding an image that had already crossed the network. Now that the
 * actor is ours the work happens here instead, which is both the right place —
 * the actor owns the picture — and much the cheaper one: the server downloads
 * a 1024x1920 image rather than a 1280x12000 one, which is roughly a tenth of
 * the bytes for exactly the same argument.
 *
 * Two rules, both inherited from the implementation this replaces:
 *
 *  - **Crop first, then resize.** Cropping is what removes the footer nobody
 *    is judging; resizing a 12,000px page before cutting it would spend the
 *    work on rows that are about to be thrown away. It also means `maxHeight`
 *    is measured in captured pixels — 2400 rows of a 1280-wide capture is
 *    1920 rows once it has been shrunk to 1024.
 *  - **Never upscale.** A 390px-wide phone shot blown up to 1024 is the same
 *    picture with softer edges and three times the vision tiles to pay for.
 */

export interface ProcessedImage {
  /** The picture a model should read. */
  png: Buffer;
  width: number;
  height: number;
  /** True when the page was longer than `maxHeight` and the rest was cut. */
  cropped: boolean;
  /** True when this is byte-for-byte the capture — nothing was cut or shrunk. */
  untouched: boolean;
}

export interface ProcessOptions {
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * PNG, 8-bit, non-interlaced, no palette.
 *
 * Not a default worth leaving to the library. The audit draws numbered boxes
 * onto this picture with a decoder that reads greyscale and RGB(A) at 8 bits
 * and refuses everything else — a palette PNG would be quietly unmarkable, and
 * the report would lose its annotations without saying why.
 */
const PNG_OPTIONS = { compressionLevel: 9, adaptiveFiltering: true, palette: false } as const;

export async function processScreenshot(capture: Buffer, options: ProcessOptions): Promise<ProcessedImage> {
  const source = sharp(capture, { limitInputPixels: 800_000_000 });
  const meta = await source.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("The captured image had no readable dimensions.");

  const keep = options.maxHeight && height > options.maxHeight ? options.maxHeight : height;
  const cropped = keep < height;
  const shrink = Boolean(options.maxWidth && width > options.maxWidth);

  if (!cropped && !shrink) {
    return { png: capture, width, height, cropped: false, untouched: true };
  }

  let pipeline = sharp(capture, { limitInputPixels: 800_000_000 });
  if (cropped) pipeline = pipeline.extract({ left: 0, top: 0, width, height: keep });
  if (shrink) {
    // `withoutEnlargement` as well as the guard above, because the two say
    // different things: the guard decides whether to touch the image at all,
    // and this makes certain that asking for a width cannot grow one.
    pipeline = pipeline.resize({ width: options.maxWidth, withoutEnlargement: true, fit: "inside" });
  }

  const png = await pipeline.png(PNG_OPTIONS).toBuffer({ resolveWithObject: true });
  return {
    png: png.data,
    width: png.info.width,
    height: png.info.height,
    cropped,
    untouched: false,
  };
}
