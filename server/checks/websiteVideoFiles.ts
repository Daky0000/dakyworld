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
import { readPage } from "../src/services/website/regions.js";
import { changeStructure } from "../src/services/website/structure.js";
import { editingSource } from "../src/services/website/document.js";
import { PART_BYTES, partCount, partLength, readTicket, signTicket } from "../src/services/websiteVideoUpload.js";

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

// 20 Oct 2026: on the same demo nothing could be uploaded, changed or deleted.
// Its player sat alone in a frame <div> with the usual fallback words, which
// made the <div> read as a paragraph — so the video was never a field — and the
// page, pictures inlined, was 4.6 MB, over a size guard every action answered to.
const framed = `<html><body><main><section><h2>Tour</h2><div class="frame">
  <video controls playsinline><source src="nevermind-venue-tour.mp4" type="video/mp4">Your browser does not support HTML video.</video>
</div><p>A look inside</p></section></main></body></html>`;
const player = readPage(framed).fields.find((field) => field.tag === "video");
assert.ok(player, "a player alone in a frame with fallback words is a field of its own"); checks++;
equal("and the frame around it is not a paragraph holding it", readPage(framed).fields.some((field) => field.kind !== "unsupported" && String(field.value ?? "").includes("<video")), false);
const heavy = framed.replace("</h2>", `</h2><img alt="" src="data:image/png;base64,${"A".repeat(3.5 * 1024 * 1024)}">`);
const heavyPlayer = readPage(heavy).fields.find((field) => field.tag === "video")!;
const given = changeStructure(heavy, {}, { kind: "settings", fieldId: heavyPlayer.id, settings: { attributes: { src: "https://media.test/assets/dw/tour.mp4" } } });
assert.ok(editingSource(heavy, given.values).includes('<source src="https://media.test/assets/dw/tour.mp4"'), "a page over the size ceiling still takes a new video file"); checks++;
const gone = changeStructure(heavy, {}, { kind: "remove", fieldId: heavyPlayer.id, force: true });
assert.ok(!/<video/.test(editingSource(heavy, gone.values)), "and can lose the video"); checks++;
assert.throws(() => changeStructure(heavy, {}, { kind: "duplicate", fieldId: readPage(heavy).fields.find((field) => field.tag === "p")!.id }), /too large to duplicate/, "a copy is still what the ceiling refuses"); checks++;

// 20 Oct 2026: videos up to 1 GB, in pieces. The ticket is all the server
// knows about an upload in flight, so it has to refuse being moved or forged.
const ticket = { s: "site-a", n: 20 * 1024 * 1024 + 5, f: "tour.mp4", a: "user-1", e: Date.now() + 60_000 };
const token = signTicket(ticket, "k");
equal("a ticket reads back on its own site", readTicket(token, "site-a", Date.now(), "k"), ticket);
equal("not on another site", readTicket(token, "site-b", Date.now(), "k"), null);
equal("not once it has expired", readTicket(token, "site-a", ticket.e + 1, "k"), null);
equal("not signed with another key", readTicket(token, "site-a", Date.now(), "other"), null);
const [body, signature] = token.split(".");
const bigger = Buffer.from(JSON.stringify({ ...ticket, n: 1 })).toString("base64url");
equal("not with its size changed under the same signature", readTicket(`${bigger}.${signature}`, "site-a", Date.now(), "k"), null);
equal("nor as rubbish", [readTicket("", "site-a"), readTicket("x", "site-a"), readTicket(`${body}.`, "site-a", Date.now(), "k")], [null, null, null]);
equal("pieces are 8 MB, the last one the rest", [partCount(ticket.n), partLength(ticket.n, 1), partLength(ticket.n, 2), partLength(ticket.n, 3)], [3, PART_BYTES, PART_BYTES, 4 * 1024 * 1024 + 5]);
equal("a piece outside the file has no length", [partLength(ticket.n, 0), partLength(ticket.n, 4), partLength(ticket.n, 1.5)], [-1, -1, -1]);
equal("1 GB is 128 pieces, well under R2's 10,000", partCount(1024 * 1024 * 1024), 128);
assert.ok(PART_BYTES >= 5 * 1024 * 1024, "every piece but the last is at least R2's 5 MB minimum"); checks++;

console.log(`websiteVideoFiles: ${checks} checks passed`);
