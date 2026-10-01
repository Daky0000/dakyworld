import { createHash } from "node:crypto";
import { isR2Configured, uploadToR2, deleteFromR2, getR2PublicUrl } from "./r2.js";
import { uploadToCdn, isCdnConfigured, UploadError } from "./cdn.js";

export { UploadError, isR2Configured, getR2PublicUrl };

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB

export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/avif",
];

export const EXTENSION_FOR_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/**
 * Returns the SHA256 checksum of a buffer.
 */
export function calculateChecksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Uploads an image to Cloudflare R2 if configured, or returns metadata.
 */
export async function storeMediaAsset(
  bytes: Buffer,
  options: {
    filename: string;
    mimeType: string;
    folder?: string;
    key?: string;
  },
): Promise<{ url: string; key: string; isR2: boolean }> {
  if (isR2Configured()) {
    const ext = EXTENSION_FOR_TYPE[options.mimeType] || "jpg";
    const folder = (options.folder || "media").replace(/^\/+|\/+$/g, "");
    const baseName = options.filename.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
    const key = options.key || `${folder}/${Date.now()}-${baseName}.${ext}`;

    const uploaded = await uploadToR2(bytes, {
      mimeType: options.mimeType,
      key,
    });

    return {
      url: uploaded.url,
      key: uploaded.key,
      isR2: true,
    };
  }

  throw new UploadError("Cloudflare R2 is not configured.");
}
