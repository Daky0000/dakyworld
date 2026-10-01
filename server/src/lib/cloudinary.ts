import { v2 as cloudinary } from "cloudinary";
import { SETTING, getSetting } from "./settings.js";
import { isR2Configured, uploadToR2 } from "./r2.js";

/**
 * Cloudinary & Cloudflare R2 unified storage handler.
 * Prioritizes Cloudflare R2 ($0 egress), with Cloudinary as fallback.
 */

async function credentials(): Promise<{ cloudName: string; apiKey: string; apiSecret: string } | null> {
  const [cloudName, apiKey, apiSecret] = await Promise.all([
    getSetting(SETTING.CLOUDINARY_CLOUD_NAME),
    getSetting(SETTING.CLOUDINARY_API_KEY),
    getSetting(SETTING.CLOUDINARY_API_SECRET),
  ]);
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret };
}

export async function cloudinaryConfigured(): Promise<boolean> {
  if (isR2Configured()) return true;
  return (await credentials()) !== null;
}

/** Uploads a local buffer (e.g. a generated PDF) and returns its public URL. */
export async function uploadBuffer(buffer: Buffer, filename: string, folder: string): Promise<string> {
  if (isR2Configured()) {
    const cleanFolder = folder.replace(/^\/+|\/+$/g, "");
    const ext = filename.includes(".") ? filename.split(".").pop() : "pdf";
    const mime = ext === "pdf" ? "application/pdf" : "application/octet-stream";
    const key = `${cleanFolder}/${filename}`;
    const uploaded = await uploadToR2(buffer, {
      mimeType: mime,
      key,
    });
    return uploaded.url;
  }

  const config = await credentials();
  if (!config) {
    throw new Error("No storage configured — set Cloudflare R2 or Cloudinary credentials.");
  }
  cloudinary.config({ cloud_name: config.cloudName, api_key: config.apiKey, api_secret: config.apiSecret });
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: filename, resource_type: "auto" },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error("Cloudinary upload failed"));
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

