import type { Request, Response } from "express";

/**
 * One `Range: bytes=…` request, resolved against a file of `length` bytes.
 *
 * A video or audio file is played by asking for it in pieces, and Safari will
 * not play one at all from a server that answers its first `bytes=0-1` with the
 * whole file and a 200 — the player just sits there. `res.send` ignores the
 * header, so every stored file this app hands out whole was unplayable on an
 * iPhone unless cloud storage, which does answer ranges, happened to be serving
 * it instead.
 *
 * `null` means serve the whole file: no header, a header this does not read
 * (several ranges at once, another unit), or one that contradicts itself, all
 * of which the HTTP rules let a server answer with the full 200. Only a range
 * that starts past the end is `"unsatisfiable"`, which is a 416.
 */
export function byteRange(header: string | undefined, length: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    // `bytes=-500`: the last 500 bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, length - suffix), end: length - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? length - 1 : Math.min(Number(match[2]), length - 1);
  if (start >= length) return "unsatisfiable";
  if (end < start) return null;
  return { start, end };
}

/**
 * Sends stored bytes, honouring a single byte range. Headers the caller sets
 * (type, cache, ETag) are kept; `If-Range` naming another version of the file
 * gets the whole of the current one, as the rules say.
 */
export function sendBytes(req: Request, res: Response, bytes: Buffer, etag?: string): Response {
  res.set("Accept-Ranges", "bytes");
  const ifRange = req.headers["if-range"];
  const range = ifRange && ifRange !== etag ? null : byteRange(req.headers.range, bytes.length);
  if (range === "unsatisfiable") return res.status(416).set("Content-Range", `bytes */${bytes.length}`).end();
  if (!range) return res.status(200).send(bytes);
  return res.status(206).set("Content-Range", `bytes ${range.start}-${range.end}/${bytes.length}`).send(bytes.subarray(range.start, range.end + 1));
}
