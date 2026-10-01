import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative } from "path";
import "dotenv/config";

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME || "dakyxtech";
const publicUrl = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

if (!accountId || !accessKeyId || !secretAccessKey || !publicUrl) {
  console.error("Missing R2 credentials in environment variables.");
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

const MIMES = {
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

function getAllFiles(dir, fileList = []) {
  if (!existsSync(dir)) return fileList;
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      if (statSync(fullPath).isDirectory()) {
        getAllFiles(fullPath, fileList);
      } else {
        fileList.push(fullPath);
      }
    } catch {
      // skip inaccessible files
    }
  }
  return fileList;
}

async function uploadFile(filePath, key) {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const mime = MIMES[ext] || "application/octet-stream";
  const bytes = readFileSync(filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: bytes,
      ContentType: mime,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return bytes.length;
}

async function uploadLocalAssets() {
  const rootDir = join(process.cwd(), "..");
  const serverDir = process.cwd();

  const directoriesToScan = [
    { baseDir: join(rootDir, "assets"), prefix: "assets" },
    { baseDir: join(serverDir, "assets"), prefix: "server/assets" },
    { baseDir: join(serverDir, "client", "public"), prefix: "public" },
  ];

  console.log(`Starting upload of local assets to Cloudflare R2 bucket: ${bucketName}...`);
  let totalUploaded = 0;
  let totalBytes = 0;

  for (const { baseDir, prefix } of directoriesToScan) {
    const files = getAllFiles(baseDir);
    for (const filePath of files) {
      const rel = relative(baseDir, filePath).replace(/\\/g, "/");
      const key = `${prefix}/${rel}`;

      process.stdout.write(`Uploading ${key}... `);
      try {
        const bytes = await uploadFile(filePath, key);
        totalUploaded++;
        totalBytes += bytes;
        console.log(`OK! (${(bytes / 1024).toFixed(1)} KB)`);
      } catch (err) {
        console.error(`FAILED: ${err.message}`);
      }
    }
  }

  console.log(`\nSuccessfully uploaded ${totalUploaded} assets (~${(totalBytes / 1024 / 1024).toFixed(2)} MB) to Cloudflare R2!`);
  console.log(`CDN Base URL: ${publicUrl}`);
}

uploadLocalAssets().catch(console.error);
