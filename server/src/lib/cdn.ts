import {
  isR2Configured,
  uploadToR2,
  deleteFromR2,
  getR2PublicUrl,
} from "./r2.js";
import { v2 as cloudinary } from "cloudinary";
import { SETTING, getSetting } from "./settings.js";

/**
 * Image storage & delivery via Cloudflare R2 or Cloudinary.
 *
 * Prioritizes Cloudflare R2 ($0 egress fees, 10GB free tier).
 * Falls back to Cloudinary if R2 is not configured.
 */

export class UploadError extends Error {}

async function cloudinaryCredentials(): Promise<{ cloudName: string; apiKey: string; apiSecret: string } | null> {
  const [cloudName, apiKey, apiSecret] = await Promise.all([
    getSetting(SETTING.CLOUDINARY_CLOUD_NAME),
    getSetting(SETTING.CLOUDINARY_API_KEY),
    getSetting(SETTING.CLOUDINARY_API_SECRET),
  ]);
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret };
}

export async function isCloudinaryConfigured(): Promise<boolean> {
  return (await cloudinaryCredentials()) !== null;
}

export async function isCdnConfigured(): Promise<boolean> {
  if (isR2Configured()) return true;
  return isCloudinaryConfigured();
}

export async function getActiveCdnProvider(): Promise<"r2" | "cloudinary" | null> {
  if (isR2Configured()) return "r2";
  if (await isCloudinaryConfigured()) return "cloudinary";
  return null;
}

export async function uploadToCdn(
  bytes: Buffer,
  options: { mimeType: string; folder: string; filename?: string; key?: string },
): Promise<{ url: string; key: string }> {
  const provider = await getActiveCdnProvider();

  if (provider === "r2") {
    try {
      const result = await uploadToR2(bytes, options);
      return result;
    } catch (error) {
      throw new UploadError(
        error instanceof Error ? error.message : "Cloudflare R2 upload failed.",
      );
    }
  }

  if (provider === "cloudinary") {
    const creds = await cloudinaryCredentials();
    if (!creds) throw new UploadError("Cloudinary is not configured.");
    cloudinary.config({ cloud_name: creds.cloudName, api_key: creds.apiKey, api_secret: creds.apiSecret });

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: options.folder, public_id: options.filename, resource_type: "auto" },
        (error, result) => {
          if (error || !result) return reject(new UploadError(error?.message ?? "Cloudinary upload failed"));
          resolve({ url: result.secure_url, key: result.public_id });
        },
      );
      stream.end(bytes);
    });
  }

  throw new UploadError("No storage or CDN provider configured (Cloudflare R2 or Cloudinary).");
}

export async function deleteFromCdn(key: string): Promise<void> {
  if (isR2Configured()) {
    await deleteFromR2(key);
  }
}

/**
 * Universal buffer uploader for documents, PDFs, generated invoices, and media.
 * Prefers Cloudflare R2 ($0 egress fees), falling back to Cloudinary.
 */
export async function uploadBuffer(
  buffer: Buffer,
  filename: string,
  folder: string,
  mimeType: string = "application/pdf",
): Promise<string> {
  if (isR2Configured()) {
    const ext = filename.includes(".") ? filename.split(".").pop() : (mimeType === "application/pdf" ? "pdf" : "bin");
    const baseName = filename.replace(/\.[^/.]+$/, "");
    const cleanFolder = folder.replace(/^\/+|\/+$/g, "");
    const key = `${cleanFolder}/${baseName}.${ext}`;
    const result = await uploadToR2(buffer, {
      mimeType,
      key,
    });
    return result.url;
  }

  const creds = await cloudinaryCredentials();
  if (!creds) {
    throw new Error("No storage configured. Provide Cloudflare R2 credentials in environment variables.");
  }
  cloudinary.config({ cloud_name: creds.cloudName, api_key: creds.apiKey, api_secret: creds.apiSecret });
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: filename, resource_type: "auto" },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error("Cloudinary upload failed"));
        resolve(result.secure_url);
      },
    );
    stream.end(buffer);
  });
}
