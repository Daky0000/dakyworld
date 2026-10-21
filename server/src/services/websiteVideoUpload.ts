import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A video or an audio file too big for one request, sent to storage in pieces.
 *
 * The picture route takes a file as base64 inside JSON, which caps it at the
 * router's 16 MB body. A video may be 1 GB (`MAX_VIDEO_UPLOAD_BYTES`), so the
 * editor sends it in `PART_BYTES` pieces, one request each, and the server
 * hands each to an R2 multipart upload as it arrives. Nothing is held beyond
 * one piece, and no piece is near any request ceiling on the way.
 *
 * Relayed rather than sent from the browser to R2 directly: a presigned
 * upload needs CORS rules on the bucket, which is configuration outside this
 * repository that would silently break uploads the day it drifted.
 *
 * What the upload is — which site, which object, how big — travels with each
 * piece as a signed token, so no table is needed for an upload in flight and
 * a piece cannot be steered into another site's upload or another object.
 */

/** R2 requires every piece but the last to be one size, and at least 5 MB. */
export const PART_BYTES = 8 * 1024 * 1024;

export type VideoUploadTicket = {
  /** Site id. */
  s: string;
  /** Declared size in bytes; every piece is held to it. */
  n: number;
  /** The name the file had, for the library. */
  f: string;
  /** Who started it. */
  a: string;
  /** Expiry, epoch ms. */
  e: number;
  /** Object key and multipart upload id, once the first piece has said what the file is. */
  k?: string;
  u?: string;
  /** The stored type ("video/mp4", "audio/mpeg"…), decided from the first piece's bytes. */
  t?: string;
  /** "audio" when the file is for an audio player. Absent is a video, which every ticket signed before audio was. */
  m?: "audio";
};

/** The same material an MFA challenge is signed with, under a label of its own. */
function secret(): string {
  const material = process.env.APP_SECRET || process.env.DATABASE_URL;
  if (!material) throw new Error("Cannot sign a video upload: neither APP_SECRET nor DATABASE_URL is set");
  return createHmac("sha256", "dakyworld-os:video-upload").update(material).digest("base64url");
}

export function signTicket(ticket: VideoUploadTicket, key = secret()): string {
  const body = Buffer.from(JSON.stringify(ticket), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** The ticket, or null when it is forged, for another site or out of date. */
export function readTicket(token: string, siteId: string, now = Date.now(), key = secret()): VideoUploadTicket | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let ticket: VideoUploadTicket;
  try { ticket = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as VideoUploadTicket; } catch { return null; }
  if (ticket.s !== siteId || !(ticket.e > now)) return null;
  return ticket;
}

export function partCount(size: number): number {
  return Math.max(1, Math.ceil(size / PART_BYTES));
}

/** How many bytes piece `part` (from 1) of a file this size must hold. */
export function partLength(size: number, part: number): number {
  const count = partCount(size);
  if (!Number.isInteger(part) || part < 1 || part > count) return -1;
  return part < count ? PART_BYTES : size - PART_BYTES * (count - 1);
}
