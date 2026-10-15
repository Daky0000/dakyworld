/**
 * Videos in a website, without a database: which files are taken as videos
 * (from their bytes), and what an imported page says about the files it names
 * but could not have brought.
 *
 * 15 Oct 2026: a demo imported as one HTML file played `nevermind-venue-tour.mp4`
 * from beside it. The file never reached the server, every address answered
 * 404, and nothing said so — and no screen could upload a video at all.
 */
import assert from "node:assert/strict";
import { sniffVideo } from "../src/lib/fileType.js";
import { localFilesNamed, prepareImportedDemoHtml } from "../src/services/demoBuilder.js";

let checks = 0;
const equal = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); checks++; };

const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]), Buffer.from(brand, "latin1"), Buffer.alloc(16)]);
equal("an MP4 is an MP4", sniffVideo(ftyp("isom")), "video/mp4");
equal("so is an M4V or an MP4 v2 brand", [sniffVideo(ftyp("M4V ")), sniffVideo(ftyp("mp42"))], ["video/mp4", "video/mp4"]);
equal("a QuickTime file shares the box and is told apart by its brand", sniffVideo(ftyp("qt  ")), "video/quicktime");
const ebml = (doctype: string) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from(doctype, "latin1"), Buffer.alloc(16)]);
equal("a WebM is a WebM", sniffVideo(ebml("webm")), "video/webm");
equal("a Matroska file shares the header and is told apart by its doctype", sniffVideo(ebml("matroska")), "video/x-matroska");
equal("a picture, a page or nothing is not a video", [sniffVideo(Buffer.from([0x89, 0x50, 0x4e, 0x47])), sniffVideo(Buffer.from("<!doctype html>")), sniffVideo(Buffer.alloc(0))], [null, null, null]);
equal("a name is not evidence: text calling itself ftyp at the wrong place is not a video", sniffVideo(Buffer.from("ftyp isom video")), null);

const page = `<html><body>
<video autoplay muted loop playsinline poster="poster.jpg"><source src="nevermind-venue-tour.mp4" type="video/mp4"></video>
<img src="https://cdn.test/a.png"><img src='data:image/png;base64,AA'><img src="/demos/venue/assets/dw/0f.jpg">
<img src="img/logo.png?v=2"><video src=clip.webm></video><audio src="//cdn.test/a.mp3"></audio><img src="#">
</body></html>`;
equal("the files a page names beside it are listed, once each, without a query", localFilesNamed(page), ["poster.jpg", "nevermind-venue-tour.mp4", "img/logo.png", "clip.webm"]);
equal("an address elsewhere, inline data and an uploaded file are not missing", localFilesNamed('<img src="https://x.test/a.png"><img src="data:image/gif;base64,R0"><video src="/assets/dw/a.mp4"></video>'), []);

const prepared = prepareImportedDemoHtml('<html><head><title>Venue</title></head><body><video controls><source src="nevermind-venue-tour.mp4"></video></body></html>', { businessName: "Venue", senderName: "DakyXTech", senderSite: "dakyx.com", includeBanner: false });
const note = prepared.notes.find((text) => text.includes("nevermind-venue-tour.mp4"));
assert.ok(note, "the import says which file it did not bring"); checks++;
assert.match(note!, /^This page uses a file that was not uploaded with it: nevermind-venue-tour\.mp4\./, "in one sentence that names it"); checks++;
assert.match(note!, /a video under its Video file/, "and says where to put it right"); checks++;
const many = prepareImportedDemoHtml(`<html><body>${Array.from({ length: 8 }, (_, i) => `<img src="p${i}.jpg">`).join("")}</body></html>`, { businessName: "Venue", senderName: "D", senderSite: "dakyx.com", includeBanner: false });
assert.match(many.notes.join(" "), /This page uses 8 files that were not uploaded with it: p0\.jpg, p1\.jpg, p2\.jpg, p3\.jpg, p4\.jpg, p5\.jpg and 2 more\./, "a long list is cut short and counted"); checks++;
equal("a page that names nothing local gets no such note", prepareImportedDemoHtml('<html><body><p>Hi</p></body></html>', { businessName: "V", senderName: "D", senderSite: "dakyx.com", includeBanner: false }).notes.filter((text) => text.includes("not uploaded")), []);

console.log(`websiteVideoFiles: ${checks} checks passed`);
