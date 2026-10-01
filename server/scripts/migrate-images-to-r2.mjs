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
  console.log("R2 environment variables are not fully configured. Skipping image migration.");
  process.exit(0);
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

const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/svg+xml": "svg",
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
      // skip unreadable
    }
  }
  return fileList;
}

async function uploadLocalAssets() {
  console.log("\n--- Phase 1: Uploading Local Catalog & Public Image Assets to R2 ---");
  const serverDir = process.cwd();
  const rootDir = join(serverDir, "..");

  const directoriesToScan = [
    { baseDir: join(rootDir, "assets"), prefix: "assets" },
    { baseDir: join(serverDir, "assets"), prefix: "server/assets" },
    { baseDir: join(serverDir, "client", "public"), prefix: "public" },
  ];

  let uploadedCount = 0;
  for (const { baseDir, prefix } of directoriesToScan) {
    const files = getAllFiles(baseDir);
    for (const filePath of files) {
      const rel = relative(baseDir, filePath).replace(/\\/g, "/");
      const key = `${prefix}/${rel}`;
      const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
      const mime = MIMES[ext] || "application/octet-stream";

      try {
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
        uploadedCount++;
      } catch (err) {
        console.error(`Local asset upload failed for ${key}:`, err.message);
      }
    }
  }
  console.log(`Local assets uploaded: ${uploadedCount} file(s).`);
}

async function migrateDatabaseImages() {
  console.log("\n--- Phase 2: Scanning Database & Migrating Binary Image Blobs ---");
  if (!process.env.DATABASE_URL) {
    console.log("No DATABASE_URL set; skipping database image migration.");
    return;
  }

  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // 1. Migrate SiteAsset binary images
    console.log("Scanning SiteAsset table for binary image records...");
    const siteAssetRes = await pool.query(
      `SELECT id, "siteId", filename, "repoPath", "contentType", content, size FROM "SiteAsset" WHERE content IS NOT NULL`,
    );

    const siteAssets = siteAssetRes.rows;
    console.log(`Found ${siteAssets.length} SiteAsset binary image(s) in PostgreSQL.`);

    let freedBytes = 0;
    let siteAssetSuccess = 0;

    for (let i = 0; i < siteAssets.length; i++) {
      const asset = siteAssets[i];
      const key = (asset.repoPath || `assets/dw/${asset.id}.png`).replace(/^\/+/, "");
      const mime = asset.contentType || "image/png";

      process.stdout.write(
        `[${i + 1}/${siteAssets.length}] Uploading SiteAsset ${asset.id} (${(asset.size / 1024).toFixed(1)} KB) to R2... `,
      );

      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: asset.content,
            ContentType: mime,
            CacheControl: "public, max-age=31536000, immutable",
          }),
        );

        // Purge binary image data from Postgres to free disk and RAM
        await pool.query(
          `UPDATE "SiteAsset" SET content = NULL WHERE id = $1`,
          [asset.id],
        );

        freedBytes += asset.size || (asset.content ? asset.content.length : 0);
        siteAssetSuccess++;
        console.log("OK! (DB blob purged)");
      } catch (err) {
        console.error(`FAILED: ${err.message}`);
      }
    }

    if (siteAssets.length > 0) {
      console.log(`Successfully migrated ${siteAssetSuccess}/${siteAssets.length} SiteAssets to R2. Freed ~${(freedBytes / 1024 / 1024).toFixed(2)} MB in Postgres.`);
    }

    // 2. Migrate StoredFile attachments
    try {
      console.log("Scanning StoredFile table for stored blobs...");
      const storedFilesRes = await pool.query(
        `SELECT id, filename, "contentType", size, data FROM "StoredFile" WHERE data IS NOT NULL AND length(data) > 0`,
      );
      const storedFiles = storedFilesRes.rows;
      console.log(`Found ${storedFiles.length} StoredFile blob(s) in PostgreSQL.`);

      let storedSuccess = 0;
      for (let i = 0; i < storedFiles.length; i++) {
        const file = storedFiles[i];
        const key = `files/${file.id}-${file.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        try {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Key: key,
              Body: file.data,
              ContentType: file.contentType || "application/octet-stream",
              CacheControl: "public, max-age=31536000, immutable",
            }),
          );
          storedSuccess++;
        } catch (err) {
          console.error(`StoredFile ${file.id} upload failed:`, err.message);
        }
      }
      console.log(`Uploaded ${storedSuccess}/${storedFiles.length} StoredFiles to R2.`);
    } catch (err) {
      console.log("StoredFile scan skipped or table absent:", err.message);
    }

    // 3. Migrate AppSetting brand logos
    try {
      console.log("Checking AppSetting brand images...");
      const brandSettings = await pool.query(
        `SELECT key, value FROM "AppSetting" WHERE key LIKE 'brand:%'`,
      );

      for (const row of brandSettings.rows) {
        const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(row.value.trim());
        if (match) {
          const mime = match[1];
          const ext = EXTENSIONS[mime] || "png";
          const slot = row.key.replace("brand:", "");
          const key = `assets/brand/${slot}.${ext}`;
          const buffer = Buffer.from(match[2], "base64");

          try {
            await s3.send(
              new PutObjectCommand({
                Bucket: bucketName,
                Key: key,
                Body: buffer,
                ContentType: mime,
                CacheControl: "public, max-age=31536000, immutable",
              }),
            );
            console.log(`Uploaded brand image [${row.key}] to ${publicUrl}/${key}`);
          } catch (err) {
            console.error(`Failed uploading brand image ${row.key}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.log("AppSetting brand check skipped:", err.message);
    }

    console.log("\nDatabase image migration completed successfully!");
  } catch (err) {
    console.error("Migration encountered error:", err.message);
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log(`=== Cloudflare R2 Media Migration to bucket [${bucketName}] ===`);
  console.log(`Public CDN URL: ${publicUrl}`);

  await uploadLocalAssets();
  await migrateDatabaseImages();

  console.log("\n=== Migration Complete: $0 egress Cloudflare R2 is fully active! ===");
}

main().catch(console.error);
