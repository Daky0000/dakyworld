/**
 * What a file actually is, as opposed to what its name and its `Content-Type`
 * claim.
 *
 * Both upload paths in this app trusted the caller's description of the bytes.
 * The spreadsheet import checked that the *filename* ended in `.xlsx` and then
 * handed whatever arrived to a zip reader; the logo upload checked the MIME
 * type written into the front of the data URL, which is a string the client
 * chose. Neither is a fact about the file.
 *
 * Sniffing the first few bytes is the cheap half of the fix. The other half —
 * a ceiling on what a zip is allowed to expand to — is `assertSafeZip` below,
 * because a 20 MB `.xlsx` really can be a few hundred bytes of nested
 * compression that unpacks to more memory than the process has.
 */

export class FileTypeError extends Error {
  status = 400;
}

/** Bytes every one of these formats starts with. */
const SIGNATURES: Array<{ kind: string; bytes: number[]; offset?: number }> = [
  // A .xlsx is a zip. So is a .docx, an .odt and a .jar — the extension is
  // checked separately; this only establishes that it is a zip at all.
  { kind: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { kind: "zip", bytes: [0x50, 0x4b, 0x05, 0x06] }, // empty archive
  { kind: "zip", bytes: [0x50, 0x4b, 0x07, 0x08] }, // spanned archive
  { kind: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { kind: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { kind: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { kind: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 }, // "WEBP" after the RIFF header
  { kind: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  // The old binary Excel format, which exceljs does not read but which people
  // rename to .xlsx and then wonder why it fails.
  { kind: "application/vnd.ms-excel", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

const startsWith = (buffer: Buffer, bytes: number[], offset = 0) =>
  buffer.length >= offset + bytes.length && bytes.every((byte, index) => buffer[offset + index] === byte);

/** The format the bytes are, or null when nothing matches (which includes every text format). */
export function sniff(buffer: Buffer): string | null {
  for (const signature of SIGNATURES) {
    if (startsWith(buffer, signature.bytes, signature.offset)) return signature.kind;
  }
  return null;
}

/** Text with no NUL bytes in the first kilobyte — good enough to separate a CSV from a binary blob wearing its name. */
export function looksLikeText(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 1024);
  for (const byte of head) {
    // Control characters other than tab, newline, carriage return and form feed.
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) return false;
  }
  return true;
}

/**
 * A spreadsheet upload, checked against its own extension.
 *
 * `.xlsx` must be a zip and `.csv`/`.tsv` must be text — which is the pairing
 * that matters, because those are the two entirely different parsers behind
 * them and feeding either the other's input is where a crash lives.
 */
export function assertSpreadsheetBytes(buffer: Buffer, fileName: string): void {
  const extension = fileName.toLowerCase().slice(fileName.lastIndexOf("."));

  if (extension === ".xlsx") {
    const kind = sniff(buffer);
    if (kind === "application/vnd.ms-excel") {
      throw new FileTypeError("That is an old .xls file renamed to .xlsx. Open it in Excel and save it as .xlsx properly.");
    }
    if (kind !== "zip") {
      throw new FileTypeError("That file is named .xlsx but is not a spreadsheet.");
    }
    assertSafeZip(buffer);
    return;
  }

  if (extension === ".csv" || extension === ".tsv") {
    if (!looksLikeText(buffer)) throw new FileTypeError(`That file is named ${extension} but is not text.`);
    return;
  }

  throw new FileTypeError("Upload an .xlsx, .csv or .tsv file.");
}

/**
 * Refuses a zip whose own directory says it expands to more than this.
 *
 * A decompression bomb is a small, perfectly valid archive that unpacks to
 * gigabytes, and the way it takes a service down is by being handed to a
 * parser that expands it before anybody looks at the size. The local file
 * headers carry the uncompressed size, so this is answerable without unpacking
 * anything: read the declared sizes, add them up, refuse an absurd total.
 *
 * A lying header still gets through — the number is not authenticated — but a
 * bomb that declares its real size is the common case, and the alternative
 * (streaming the whole thing through a counter) is not available inside a
 * library that takes a Buffer.
 */
const MAX_UNCOMPRESSED_BYTES = 400 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 400;

export function assertSafeZip(buffer: Buffer): void {
  let declared = 0;
  let entries = 0;

  // Walk the local file headers: signature 0x04034b50, then the sizes at +18
  // (compressed) and +22 (uncompressed).
  for (let at = 0; at + 30 <= buffer.length; ) {
    if (buffer.readUInt32LE(at) !== 0x04034b50) break;

    const compressed = buffer.readUInt32LE(at + 18);
    const uncompressed = buffer.readUInt32LE(at + 22);
    const nameLength = buffer.readUInt16LE(at + 26);
    const extraLength = buffer.readUInt16LE(at + 28);

    declared += uncompressed;
    entries += 1;
    if (declared > MAX_UNCOMPRESSED_BYTES) {
      throw new FileTypeError("That file expands to far more than a spreadsheet should. It has not been opened.");
    }
    // 65,535 entries is the zip64 boundary; a spreadsheet is nowhere near it.
    if (entries > 65_535) throw new FileTypeError("That archive holds an implausible number of entries.");

    const next = at + 30 + nameLength + extraLength + compressed;
    // A zero-length streamed entry (sizes in a trailing descriptor) leaves us
    // where we started; stop rather than loop forever.
    if (next <= at) break;
    at = next;
  }

  if (declared > 0 && buffer.length > 0 && declared / buffer.length > MAX_COMPRESSION_RATIO) {
    throw new FileTypeError("That file is compressed far beyond what a spreadsheet compresses to. It has not been opened.");
  }
}

/**
 * An uploaded image, checked against the type the data URL declares.
 *
 * SVG is the reason the declared type cannot simply be believed: it is markup,
 * it can carry a script element, and a caller writing `data:image/png` in front
 * of SVG bytes is describing the file rather than being one. So SVG has to be
 * recognised as SVG and judged as SVG — which here means allowed only when the
 * caller said so, and only after the obviously executable parts are ruled out.
 */
const SCRIPTABLE_SVG = /<\s*script|\son\w+\s*=|javascript:|<\s*foreignObject|<\s*use[^>]+href\s*=\s*["']\s*http/i;

export function assertImageBytes(buffer: Buffer, declaredType: string): void {
  if (declaredType === "image/svg+xml") {
    const head = buffer.subarray(0, 4096).toString("utf8");
    if (!/<\s*svg[\s>]/i.test(head)) throw new FileTypeError("That file is declared as SVG but does not contain SVG markup.");
    if (SCRIPTABLE_SVG.test(buffer.toString("utf8"))) {
      throw new FileTypeError("That SVG contains a script, an event handler or an external reference. Export it as a plain SVG or a PNG.");
    }
    return;
  }

  const kind = sniff(buffer);
  if (!kind) throw new FileTypeError("That file is not an image in a format this app recognises.");
  if (kind !== declaredType) {
    throw new FileTypeError(`That file is described as ${declaredType} but is actually ${kind}.`);
  }
}
