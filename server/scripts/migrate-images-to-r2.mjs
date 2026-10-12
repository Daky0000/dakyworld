/**
 * Moving website images out of Postgres and into Cloudflare R2 — by hand, once.
 *
 *   npm run migrate:r2        (from server/, with DATABASE_URL and the R2_* variables set)
 *
 * **This is a manual one-off, not a deploy step.** It ran as Railway's
 * preDeployCommand on every deploy until 12 Oct 2026, and in that seat it did
 * two things nobody had asked of it. It copied every `StoredFile` — email
 * attachments, prospect audit PDFs, lead screenshots — into the *public*
 * bucket, where anybody holding the address can read them; and it copied the
 * brand settings beside them. The app never read either copy (`fileStore`
 * reads Postgres), so the only effect was to publish private documents. Both
 * phases are gone, and must not come back: **private documents are never
 * written to the public bucket** — everything in it is served to whoever asks.
 * The deploy step is `npm run db:deploy` now (docs/infrastructure/RUNBOOK.md).
 *
 * What is left:
 *
 *  1. The repository's own public images (assets/, server/assets,
 *     client/public), skipping any already in the bucket at the same size.
 *  2. Website uploads (`SiteAsset`) still held as bytes in Postgres, 25 rows at
 *     a time by id — not every blob in one query, which is how a script meant
 *     to free memory runs a small service out of it. Each upload is read back
 *     with a HEAD at the right size before its bytes are dropped, and the drop
 *     is conditional on the bytes being the ones that were copied.
 *
 * Exits 1 if anything failed, so a run that half-worked does not read as done.
 */
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative } from "path";
import "dotenv/config";

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME || "dakyxtech";
const publicUrl = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

if (!accountId || !accessKeyId || !secretAccessKey || !publicUrl) {
  console.error("R2 environment variables are not fully configured, so nothing was copied.");
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

let failures = 0;

/** The object's size in the bucket, or null when it is not there. */
async function storedSize(key) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return head.ContentLength ?? null;
  } catch (err) {
    if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

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
  console.log("\n--- Phase 1: the repository's public images ---");
  const serverDir = process.cwd();
  const rootDir = join(serverDir, "..");

  const directoriesToScan = [
    { baseDir: join(rootDir, "assets"), prefix: "assets" },
    { baseDir: join(serverDir, "assets"), prefix: "server/assets" },
    { baseDir: join(serverDir, "client", "public"), prefix: "public" },
  ];

  const allUploadTasks = [];
  for (const { baseDir, prefix } of directoriesToScan) {
    const files = getAllFiles(baseDir);
    for (const filePath of files) {
      const rel = relative(baseDir, filePath).replace(/\\/g, "/");
      const key = `${prefix}/${rel}`;
      const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
      const mime = MIMES[ext] || "application/octet-stream";
      allUploadTasks.push({ filePath, key, mime });
    }
  }

  let uploaded = 0;
  let unchanged = 0;
  const BATCH_SIZE = 10;
  for (let i = 0; i < allUploadTasks.length; i += BATCH_SIZE) {
    const batch = allUploadTasks.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ filePath, key, mime }) => {
        try {
          const bytes = readFileSync(filePath);
          // Same key, same size: the copy made last time. Sending it again is
          // the whole folder over the wire on every run for nothing.
          if ((await storedSize(key)) === bytes.length) {
            unchanged++;
            return;
          }
          await s3.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Key: key,
              Body: bytes,
              ContentType: mime,
              CacheControl: "public, max-age=31536000, immutable",
            }),
          );
          uploaded++;
        } catch (err) {
          failures++;
          console.error(`Local asset upload failed for ${key}:`, err.message);
        }
      })
    );
  }
  console.log(`Local assets: ${uploaded} uploaded, ${unchanged} already there.`);
}

/**
 * Website uploads still held as bytes, and which of them may move.
 *
 * Only an upload's own `assets/dw/<uuid>` path: an R2 key is the bare repoPath,
 * and a package import keeps the archive's paths, so two customers' `images/logo.png`
 * would land on one key and each would be shown whichever was copied last.
 *
 * Only a site with a repository that is not served from here: the hosting route
 * (services/websiteHosting.ts) answers a hosted page's pictures from these
 * bytes and has no R2 fallback, so dropping them takes the pictures off the
 * customer's live site.
 */
const ELIGIBLE = `
  a.content IS NOT NULL
  AND s."repoName" IS NOT NULL
  AND s."hostedEnabled" = false
  AND a."repoPath" ~ '^assets/dw/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.-]'
`;

async function migrateSiteAssets() {
  console.log("\n--- Phase 2: website uploads held in Postgres ---");
  if (!process.env.DATABASE_URL) {
    failures++;
    console.error("No DATABASE_URL set, so no website upload was moved.");
    return;
  }

  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

  try {
    const BATCH = 25;
    let after = "";
    let moved = 0;
    let freedBytes = 0;
    for (;;) {
      const { rows } = await pool.query(
        `SELECT a.id, a."repoPath", a."contentType", a.content
           FROM "SiteAsset" a JOIN "Site" s ON s.id = a."siteId"
          WHERE ${ELIGIBLE} AND a.id > $1
          ORDER BY a.id
          LIMIT ${BATCH}`,
        [after],
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].id;

      for (const asset of rows) {
        const key = asset.repoPath.replace(/^\/+/, "");
        try {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Key: key,
              Body: asset.content,
              ContentType: asset.contentType || "application/octet-stream",
              CacheControl: "public, max-age=31536000, immutable",
            }),
          );
          // A PUT that answered is not a file that can be read. The bytes here
          // are the only copy until this says the bucket has them.
          const size = await storedSize(key);
          if (size !== asset.content.length) {
            failures++;
            console.error(`SiteAsset ${asset.id}: the bucket holds ${size ?? "nothing"} at ${key}, expected ${asset.content.length} bytes. Kept in Postgres.`);
            continue;
          }
          const digest = createHash("md5").update(asset.content).digest("hex");
          const dropped = await pool.query(
            `UPDATE "SiteAsset" SET content = NULL WHERE id = $1 AND md5(content) = $2`,
            [asset.id, digest],
          );
          if (!dropped.rowCount) {
            console.log(`SiteAsset ${asset.id} changed while it was being copied; left in Postgres for the next run.`);
            continue;
          }
          moved++;
          freedBytes += asset.content.length;
        } catch (err) {
          failures++;
          console.error(`SiteAsset ${asset.id} (${key}) failed: ${err.message}`);
        }
      }
      console.log(`  …through ${after}: ${moved} moved so far.`);
    }
    console.log(`Website uploads moved to R2: ${moved}, freeing ~${(freedBytes / 1024 / 1024).toFixed(2)} MB in Postgres.`);
  } catch (err) {
    failures++;
    console.error("Website upload migration stopped:", err.message);
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log(`=== Website images to Cloudflare R2, bucket [${bucketName}] ===`);
  console.log(`Public address: ${publicUrl}`);

  await uploadLocalAssets();
  await migrateSiteAssets();

  if (failures) {
    console.error(`\n=== Finished with ${failures} failure(s). Nothing that failed was removed from Postgres; run it again. ===`);
    process.exit(1);
  }
  console.log("\n=== Finished with no failures. ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
