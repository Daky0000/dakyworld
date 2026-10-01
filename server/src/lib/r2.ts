import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl: string;
};

export function getR2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME || "dakyxtech";
  const publicUrl = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

  if (!accountId || !accessKeyId || !secretAccessKey || !publicUrl) {
    return null;
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicUrl,
  };
}

export function isR2Configured(): boolean {
  return getR2Config() !== null;
}

let cachedS3: S3Client | null = null;
let cachedKey = "";

export function getR2Client(): { s3: S3Client; bucketName: string; publicUrl: string } | null {
  const config = getR2Config();
  if (!config) return null;

  const cacheKey = `${config.accountId}:${config.accessKeyId}`;
  if (!cachedS3 || cachedKey !== cacheKey) {
    cachedS3 = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    cachedKey = cacheKey;
  }

  return {
    s3: cachedS3,
    bucketName: config.bucketName,
    publicUrl: config.publicUrl,
  };
}

export function getR2PublicUrl(key?: string): string {
  const config = getR2Config();
  const base = (config?.publicUrl || process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!key) return base;
  const cleanKey = key.replace(/^\/+/, "");
  return `${base}/${cleanKey}`;
}

export interface UploadR2Options {
  mimeType: string;
  folder?: string;
  key?: string;
  filename?: string;
  cacheControl?: string;
}

/**
 * Uploads a buffer to Cloudflare R2 and returns its public URL and object key.
 */
export async function uploadToR2(
  bytes: Buffer,
  options: UploadR2Options,
): Promise<{ url: string; key: string }> {
  const clientInfo = getR2Client();
  if (!clientInfo) {
    throw new Error("Cloudflare R2 is not fully configured.");
  }
  const { s3, bucketName, publicUrl } = clientInfo;

  let key = options.key;
  if (!key) {
    const ext = options.mimeType.split("/")[1]?.replace("+xml", "") || "bin";
    const folder = (options.folder || "uploads").replace(/^\/+|\/+$/g, "");
    const id = randomUUID();
    key = `${folder}/${id}.${ext}`;
  }

  key = key.replace(/^\/+/, "");

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: bytes,
      ContentType: options.mimeType,
      CacheControl: options.cacheControl || "public, max-age=31536000, immutable",
    }),
  );

  return {
    url: `${publicUrl}/${key}`,
    key,
  };
}

/**
 * Deletes an asset from Cloudflare R2. Best-effort.
 */
export async function deleteFromR2(key: string): Promise<void> {
  const clientInfo = getR2Client();
  if (!clientInfo) return;
  const { s3, bucketName } = clientInfo;

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key.replace(/^\/+/, ""),
      }),
    );
  } catch {
    // Best-effort delete; failures do not break callers
  }
}

/**
 * Downloads an asset from Cloudflare R2 as a Buffer.
 */
export async function downloadFromR2(key: string): Promise<Buffer | null> {
  const clientInfo = getR2Client();
  if (!clientInfo) return null;
  const { s3, bucketName } = clientInfo;

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key.replace(/^\/+/, ""),
      }),
    );
    if (!response.Body) return null;
    const byteArray = await response.Body.transformToByteArray();
    return Buffer.from(byteArray);
  } catch {
    return null;
  }
}

/**
 * Checks if an object exists in Cloudflare R2.
 */
export async function existsInR2(key: string): Promise<boolean> {
  const clientInfo = getR2Client();
  if (!clientInfo) return false;
  const { s3, bucketName } = clientInfo;

  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: bucketName,
        Key: key.replace(/^\/+/, ""),
      }),
    );
    return true;
  } catch {
    return false;
  }
}
