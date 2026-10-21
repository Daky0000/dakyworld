/**
 * Audio is a first-class player: judged by its bytes, uploaded through the
 * same two doors as a video, refused with a reason when it would never play,
 * and served in pieces so an iPhone can play it.
 *
 *   DATABASE_URL=<isolated local editor database> npx tsx checks/websiteAudio.ts
 *
 * 1. **The sniffer knows audio from its bytes**, and the negatives matter more
 *    than the positives: a JPEG starts with 0xFF too, and a WebP is a RIFF file
 *    like a WAV. Each is held to what it really is.
 * 2. **What a player is given decides the in-between cases** (`playableMedia`):
 *    a phone's voice memo in an ordinary MP4 box is audio under an audio
 *    player; an MP3 under a video player is refused; Ogg is refused everywhere,
 *    because Safari never plays it.
 * 3. **Through the real route and database**: a stored MP3 is an `.mp3` with
 *    `audio/mpeg`, each refusal leaves no row, and a library upload with no
 *    player still lands as audio rather than being refused as "not a picture".
 * 4. **A stored file is served in pieces.** `bytes=0-1` is answered 206 with a
 *    Content-Range, past-the-end is 416, and a header it does not read is the
 *    whole file — the editor's raw route and the rule behind hosted sites alike.
 * 5. **The player's panel no longer says it is read-only.**
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) {
  throw new Error("These checks require an isolated local test/editor database. Set DATABASE_URL to one.");
}
process.env.NODE_ENV = "development";
process.env.DEV_NO_AUTH = "true";
// Stored in the database, not cloud storage: this check needs nothing but Postgres.
for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"]) delete process.env[name];

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const { sniffAudio, sniffVideo } = await import("../src/lib/fileType.js");
const { byteRange } = await import("../src/lib/byteRange.js");
const { prisma } = await import("../src/lib/prisma.js");
const { playableMedia, registerWebsiteManagement } = await import("../src/services/websiteManagement.js");
const { discoverFields } = await import("../src/services/website/index.js");

/* ------------------------------------------------------------- 1. bytes */

const bytes = (...values: number[]) => Buffer.from([...values, ...new Array(64).fill(0)]);
const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from(`ftyp${brand}`, "latin1"), Buffer.alloc(48)]);
const riff = (form: string) => Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x24, 0, 0, 0]), Buffer.from(form, "latin1"), Buffer.alloc(48)]);

const mp3Tagged = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64)]);
const mp3Frame = bytes(0xff, 0xfb, 0x90, 0x64); // MPEG-1 layer III, 128 kbps, 44.1 kHz
const adts = bytes(0xff, 0xf1, 0x50, 0x80); // AAC LC, 44.1 kHz
equal("an ID3 tag is an MP3", sniffAudio(mp3Tagged), "audio/mpeg");
equal("a bare MPEG frame header is an MP3", sniffAudio(mp3Frame), "audio/mpeg");
equal("raw AAC is told apart from MP3 by its layer bits", sniffAudio(adts), "audio/aac");
equal("an iTunes-brand MP4 is audio", sniffAudio(ftyp("M4A ")), "audio/mp4");
equal("an audiobook-brand MP4 is audio", sniffAudio(ftyp("M4B ")), "audio/mp4");
equal("RIFF … WAVE is a WAV", sniffAudio(riff("WAVE")), "audio/wav");
equal("fLaC is FLAC", sniffAudio(bytes(0x66, 0x4c, 0x61, 0x43)), "audio/flac");
equal("OggS is recognised, so it can be refused with the reason", sniffAudio(bytes(0x4f, 0x67, 0x67, 0x53)), "audio/ogg");

equal("a JPEG starts with 0xFF and is not audio", sniffAudio(bytes(0xff, 0xd8, 0xff, 0xe0)), null);
equal("a WebP is a RIFF file and is not a WAV", sniffAudio(riff("WEBP")), null);
equal("a PNG is not audio", sniffAudio(bytes(0x89, 0x50, 0x4e, 0x47)), null);
equal("an ordinary MP4 video is not claimed as audio", sniffAudio(ftyp("isom")), null);
equal("a frame header with the reserved version is not audio", sniffAudio(bytes(0xff, 0xeb, 0x90, 0x64)), null);
equal("a frame header with a bad bitrate is not audio", sniffAudio(bytes(0xff, 0xfb, 0xf0, 0x64)), null);
equal("a frame header with the reserved sample rate is not audio", sniffAudio(bytes(0xff, 0xfb, 0x9c, 0x64)), null);
equal("eleven sync bits with layer 0 but no AAC sync word is not audio", sniffAudio(bytes(0xff, 0xe1, 0x50, 0x80)), null);
equal("text calling itself ID3 somewhere else is not audio", sniffAudio(Buffer.from("this file mentions ID3")), null);
equal("nothing is not audio", sniffAudio(Buffer.alloc(0)), null);
equal("the M4A brand is still an MP4 container to the video sniffer, so audio must be asked first", sniffVideo(ftyp("M4A ")), "video/mp4");

/* ---------------------------------------------------- 2. what it is for */

const kind = (media: ReturnType<typeof playableMedia>) => media === null ? null : "refused" in media ? `refused: ${media.refused}` : `${media.kind} ${media.type} .${media.extension}`;
equal("an MP3 under an audio player", kind(playableMedia(mp3Tagged, "audio")), "audio audio/mpeg .mp3");
equal("an M4A under an audio player", kind(playableMedia(ftyp("M4A "), "audio")), "audio audio/mp4 .m4a");
equal("a voice memo in an ordinary MP4 box is the player's sound", kind(playableMedia(ftyp("isom"), "audio")), "audio audio/mp4 .m4a");
check("a WebM recording is the player's sound", kind(playableMedia(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("....webm", "latin1"), Buffer.alloc(40)]), "audio"))?.startsWith("audio audio/webm"));
check("Ogg is refused, naming Safari and what to export", /Safari.*MP3/.test(kind(playableMedia(bytes(0x4f, 0x67, 0x67, 0x53), "audio")) ?? ""));
check("Ogg is refused from the library too", kind(playableMedia(bytes(0x4f, 0x67, 0x67, 0x53)))?.startsWith("refused"));
check("a .mov under an audio player is told to export MP3", /QuickTime.*MP3/.test(kind(playableMedia(ftyp("qt  "), "audio")) ?? ""));
check("a picture under an audio player is refused as not audio", /not audio/.test(kind(playableMedia(bytes(0x89, 0x50, 0x4e, 0x47), "audio")) ?? ""));
check("an MP3 under a video player is refused rather than shown as a black box", /audio file, not a video/.test(kind(playableMedia(mp3Tagged, "video")) ?? ""));
equal("an MP3 from the library, with no player, is audio", kind(playableMedia(mp3Tagged)), "audio audio/mpeg .mp3");
equal("a video under a video player is unchanged", kind(playableMedia(ftyp("isom"), "video")), "video video/mp4 .mp4");
equal("a picture from the library is not media, so it goes on to be judged as a picture", playableMedia(bytes(0x89, 0x50, 0x4e, 0x47)), null);

/* ------------------------------------------------------------ 4. ranges */

equal("no header is the whole file", byteRange(undefined, 100), null);
equal("the first two bytes, as Safari asks", byteRange("bytes=0-1", 100), { start: 0, end: 1 });
equal("an open end runs to the last byte", byteRange("bytes=40-", 100), { start: 40, end: 99 });
equal("a suffix is the last bytes", byteRange("bytes=-10", 100), { start: 90, end: 99 });
equal("an end past the file is cut to it", byteRange("bytes=90-500", 100), { start: 90, end: 99 });
equal("a start past the end is unsatisfiable", byteRange("bytes=100-", 100), "unsatisfiable");
equal("several ranges are answered with the whole file", byteRange("bytes=0-1,5-9", 100), null);
equal("a backwards range is ignored, not refused", byteRange("bytes=9-5", 100), null);
equal("another unit is ignored", byteRange("items=0-1", 100), null);

/* ------------------------------------------------- 5. the player's panel */

const page = discoverFields('<!doctype html><html><head><title>Listen</title></head><body><main><section><h2>Episode 1</h2><div class="frame"><audio controls src="/ep1.mp3">Your browser does not support audio.</audio></div></section></main></body></html>');
const player = page.fields.find((field) => field.tag === "audio");
check("an audio player in a frame is a field of its own", player);
check("and its panel no longer calls it read-only", player?.unsupportedReason && !/read-only/.test(player.unsupportedReason) && /General/.test(player.unsupportedReason));

/* ------------------------------------------------ 3. the route, for real */

const siteIds: string[] = [];
const userIds: string[] = [];
try {
  const site = await prisma.site.create({ data: { name: "Audio check", slug: `audiocheck-${randomUUID().slice(0, 8)}`, publicUrl: "https://audio.example", repoPath: "" } });
  siteIds.push(site.id);
  // Staff, who have no storage quota: this is about audio, not about plans.
  const staff = await prisma.user.create({ data: { email: `audiocheck-${randomUUID().slice(0, 8)}@example.test`, name: "Audio check" } });
  userIds.push(staff.id);
  const principal = { id: staff.id, name: staff.name, email: staff.email, active: true, accessRole: { external: false, superAdmin: true }, deniedPermissions: [] };

  const app = express();
  app.use((req, _res, next) => { (req as unknown as { dbUser?: unknown }).dbUser = principal; next(); });
  app.use(express.json({ limit: "20mb" }));
  const router = express.Router();
  registerWebsiteManagement(router, {
    loadSite: async (_req, id) => prisma.site.findUniqueOrThrow({ where: { id } }),
    loadPage: async () => { throw new Error("Not used by these routes."); },
  });
  app.use("/api/website", router);
  app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!error.status) console.error(error);
    res.status(error.status ?? 500).json({ error: error.message });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/website`;
  try {
    const upload = async (file: Buffer, filename: string, as?: "audio" | "video") => {
      const response = await fetch(`${base}/sites/${site.id}/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, data: file.toString("base64"), ...(as && { kind: as }) }),
      });
      return { status: response.status, body: (await response.json()) as { id?: string; url?: string; contentType?: string; error?: string } };
    };
    const rows = () => prisma.siteAsset.count({ where: { siteId: site.id } });

    const episode = Buffer.concat([mp3Tagged, Buffer.from(Array.from({ length: 4000 }, (_, at) => at % 251))]);
    const stored = await upload(episode, "episode-1.mp3", "audio");
    equal("an MP3 under an audio player is stored", [stored.status, stored.body.contentType], [201, "audio/mpeg"]);
    const row = await prisma.siteAsset.findUniqueOrThrow({ where: { id: stored.body.id! } });
    check("as an .mp3 under the upload folder", /^assets\/dw\/[0-9a-f-]{36}\.mp3$/.test(row.repoPath));
    equal("byte for byte", Buffer.compare(Buffer.from(row.content!), episode), 0);
    check("and the upload is on the site's activity", await prisma.siteAuditEvent.count({ where: { siteId: site.id, kind: "ASSET_UPLOAD", detail: { path: ["assetId"], equals: row.id } } }) === 1);

    const memo = await upload(ftyp("isom"), "voice-memo.m4a", "audio");
    equal("a voice memo in an ordinary MP4 box is stored as audio", [memo.status, memo.body.contentType], [201, "audio/mp4"]);
    const library = await upload(mp3Tagged, "jingle.mp3");
    equal("an MP3 from the library lands as audio, not as a refused picture", [library.status, library.body.contentType], [201, "audio/mpeg"]);

    const before = await rows();
    const ogg = await upload(bytes(0x4f, 0x67, 0x67, 0x53), "song.ogg", "audio");
    check("Ogg is refused with the reason", ogg.status === 400 && /Safari/.test(ogg.body.error ?? ""));
    const picture = await upload(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "cover.png", "audio");
    check("a picture under an audio player is refused", picture.status === 400 && /not audio/.test(picture.body.error ?? ""));
    const wrongPlayer = await upload(mp3Tagged, "episode.mp3", "video");
    check("an MP3 under a video player is refused", wrongPlayer.status === 400 && /not a video/.test(wrongPlayer.body.error ?? ""));
    equal("and no refusal leaves a row", await rows(), before);

    // The editor's raw route, which the canvas plays from before a publish.
    const raw = `${base}/sites/${site.id}/raw/${row.repoPath}`;
    const whole = await fetch(raw);
    equal("the whole file without a range", [whole.status, whole.headers.get("accept-ranges"), (await whole.arrayBuffer()).byteLength], [200, "bytes", episode.length]);
    const first = await fetch(raw, { headers: { Range: "bytes=0-1" } });
    equal("Safari's first question is answered with two bytes", [first.status, first.headers.get("content-range"), Buffer.from(await first.arrayBuffer())], [206, `bytes 0-1/${episode.length}`, episode.subarray(0, 2)]);
    equal("the type survives a range", first.headers.get("content-type")?.split(";")[0], "audio/mpeg");
    const tail = await fetch(raw, { headers: { Range: "bytes=-100" } });
    equal("the end of the file, for seeking", [tail.status, Buffer.compare(Buffer.from(await tail.arrayBuffer()), episode.subarray(episode.length - 100))], [206, 0]);
    const past = await fetch(raw, { headers: { Range: `bytes=${episode.length}-` } });
    equal("past the end is 416 with the length", [past.status, past.headers.get("content-range")], [416, `bytes */${episode.length}`]);
  } finally {
    server.close();
  }
  console.log(`websiteAudio: ${checks} checks passed — audio known by its bytes, refused when it would never play, stored through the real route, and served in pieces`);
} finally {
  await prisma.siteAuditEvent.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.siteAsset.deleteMany({ where: { siteId: { in: siteIds } } });
  await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}
