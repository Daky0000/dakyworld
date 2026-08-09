import { v2 as cloudinary } from "cloudinary";
import { SETTING, getSetting } from "./settings.js";

/**
 * Cloudinary, configured at use rather than at boot — the credentials live in
 * Settings (encrypted in the database) so they can be added without a redeploy.
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
  return (await credentials()) !== null;
}

/** Uploads a local buffer (e.g. a generated PDF) and returns its public URL. */
export async function uploadBuffer(buffer: Buffer, filename: string, folder: string): Promise<string> {
  const config = await credentials();
  if (!config) {
    throw new Error("Cloudinary is not configured — add the credentials under Settings → File storage.");
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
