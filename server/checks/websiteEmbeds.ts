/**
 * An embedded frame can be pointed at another video, map or player — from a
 * short list of services, and nothing else. No IO.
 *
 * 1. **Whatever somebody pastes becomes the embed address**: a watch page, a
 *    short, a youtu.be link with a start time, an unlisted Vimeo, a Spotify
 *    link with a locale, a Loom share, the service's whole `<iframe>` code
 *    with its `&amp;`s, a place in Google Maps.
 * 2. **The list is the boundary** (`shared/websiteEmbed.ts` says why): an
 *    invited editor must not be able to draw a page of their own inside the
 *    customer's site. So the negatives are most of this — lookalike hosts,
 *    credentials, ports, plain http, the right host on the wrong path, script
 *    and data addresses, quotes — each refused by the panel's converter *and*
 *    by the server's `attributeProblem`, which is what a stored draft meets.
 * 3. **Through the real settings path**: an address, a description, lazy
 *    loading and full screen land on the frame as one change named "embed
 *    settings", an off-list address is refused with the sentence, `srcdoc` is
 *    never reachable, and a frame already pointing off the list is left alone.
 */
import assert from "node:assert/strict";
import { changeStructure, StructureError } from "../src/services/website/structure.js";
import { DOCUMENT_KEY } from "../src/services/website/document.js";
import { readPage } from "../src/services/website/regions.js";
import { attributeNameProblem, attributeProblem, typedAttributes } from "../src/shared/websiteElementSettings.js";
import { EMBED_SERVICES, MAX_EMBED_ADDRESS, embedAddress, embedProblem, embedService, mapAddress, mapPlace } from "../src/shared/websiteEmbed.js";
import { MEDIA_SECTION_TEMPLATES } from "../src/services/websiteSeo.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }
const converted = (input: string) => { const result = embedAddress(input); return "address" in result ? result.address : `problem: ${result.problem}`; };

/* ---------------------------------------------------- 1. what is pasted */

equal("a YouTube watch page", converted("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "https://www.youtube.com/embed/dQw4w9WgXcQ");
equal("a youtu.be link keeps its start time", converted("https://youtu.be/dQw4w9WgXcQ?t=1m30s"), "https://www.youtube.com/embed/dQw4w9WgXcQ?start=90");
equal("a short", converted("youtube.com/shorts/abcDEF12345"), "https://www.youtube.com/embed/abcDEF12345");
equal("the phone site", converted("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42"), "https://www.youtube.com/embed/dQw4w9WgXcQ?start=42");
equal("a playlist", converted("https://www.youtube.com/playlist?list=PL0123456789abcdef"), "https://www.youtube.com/embed/videoseries?list=PL0123456789abcdef");
equal("a video in a playlist keeps both", converted("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL0123456789abcdef"), "https://www.youtube.com/embed/dQw4w9WgXcQ?list=PL0123456789abcdef");
equal("a Vimeo page", converted("https://vimeo.com/76979871"), "https://player.vimeo.com/video/76979871");
equal("an unlisted Vimeo keeps its hash", converted("https://vimeo.com/76979871/8272103f6e"), "https://player.vimeo.com/video/76979871?h=8272103f6e");
equal("a Spotify link with a locale", converted("https://open.spotify.com/intl-fr/track/4uLU6hMCjMI75M1A2tKUQC?si=abc"), "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC");
equal("a Loom share", converted("https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184"), "https://www.loom.com/embed/0281766fa2d04bb788eaf19e65135184");
equal("an Apple Podcasts page", converted("https://podcasts.apple.com/us/podcast/the-daily/id1200361736"), "https://embed.podcasts.apple.com/us/podcast/the-daily/id1200361736");
equal("an http link is made https", converted("http://www.youtube.com/watch?v=dQw4w9WgXcQ"), "https://www.youtube.com/embed/dQw4w9WgXcQ");
equal(
  "a service's own embed code, entities and all",
  converted('<iframe width="600" height="450" style="border:0" src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3&amp;hl=en" allowfullscreen loading="lazy"></iframe>'),
  "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3&hl=en",
);
equal("a Google Maps place page becomes a map of that place", converted("https://www.google.com/maps/place/Accra+Mall/@5.62,-0.17,17z"), mapAddress("Accra Mall"));
check("a short Maps link says what to do instead", /Place/.test(converted("https://maps.app.goo.gl/AbCdEf123")));
check("code that is not an embed is refused as code", /not an embed code/.test(converted("<script>alert(1)</script>")));
check("an empty box says what to paste", /Paste/.test(converted("   ")));

equal("a typed place is the keyless map form", mapAddress("  Osu,   Accra "), "https://maps.google.com/maps?q=Osu%2C+Accra&z=15&output=embed");
equal("and reads back as the place", mapPlace(mapAddress("Osu, Accra")), "Osu, Accra");
equal("any other frame has no place", mapPlace("https://www.youtube.com/embed/dQw4w9WgXcQ"), null);
equal("the map is a Google Maps frame", embedService(mapAddress("Osu"))?.id, "google-maps");

/* ------------------------------------------------- 2. the list is the line */

const refusedEverywhere = [
  ["another site", "https://evil.example/login"],
  ["a lookalike host", "https://www.youtube.com.evil.example/embed/dQw4w9WgXcQ"],
  ["a host that ends like one", "https://notyoutube.com/embed/dQw4w9WgXcQ"],
  ["credentials", "https://user:pass@www.youtube.com/embed/dQw4w9WgXcQ"],
  ["a port", "https://www.youtube.com:8443/embed/dQw4w9WgXcQ"],
  ["plain http", "http://player.vimeo.com/video/76979871"],
  ["the right host on a page that is not the player", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  ["a Google page that is not a map", "https://www.google.com/search?q=maps"],
  ["a map path without the embed marker", "https://maps.google.com/maps?q=Accra"],
  ["a script address", "javascript:alert(1)//www.youtube.com/embed/dQw4w9WgXcQ"],
  ["a data address", "data:text/html,<script>alert(1)</script>"],
  ["a quote that would leave the attribute", 'https://www.youtube.com/embed/dQw4w9WgXcQ" onload="alert(1)'],
  ["a path that walks out", "https://player.vimeo.com/video/../../evil"],
] as const;
for (const [what, address] of refusedEverywhere) {
  equal(`the list refuses ${what}`, embedService(address), null);
  check(`the server refuses ${what}`, attributeProblem("src", address, "iframe") !== null);
}
check("an address longer than any embed is refused", attributeProblem("src", `https://www.google.com/maps/embed?pb=${"!1m3".repeat(MAX_EMBED_ADDRESS)}`, "iframe") !== null);
equal("a long map address, which is normal, is accepted", attributeProblem("src", `https://www.google.com/maps/embed?pb=${"!1m3!1d3970".repeat(60)}`, "iframe"), null);
check("the refusal names what a frame can show", /YouTube.*Calendly/.test(embedProblem("https://evil.example") ?? ""));
for (const service of EMBED_SERVICES) check(`${service.label} has at least one host and a path rule`, service.hosts.length > 0 && service.path instanceof RegExp);

equal("a frame's own settings are its address, description, loading and full screen", [...typedAttributes("iframe")], ["src", "title", "loading", "allowfullscreen"]);
equal("loading takes lazy", attributeProblem("loading", "lazy", "iframe"), null);
check("and nothing else", attributeProblem("loading", "soon", "iframe") !== null);
equal("full screen is a switch", attributeProblem("allowfullscreen", "", "iframe"), null);
check("with no value", attributeProblem("allowfullscreen", "true", "iframe") !== null);
check("srcdoc is never reachable on a frame", attributeNameProblem("srcdoc", "iframe") !== null);
check("nor is a frame's address on anything that is not a frame", attributeNameProblem("src", "div") !== null);
check("nor is an embed address a picture's address", attributeProblem("src", "https://www.youtube.com/embed/dQw4w9WgXcQ", "img") !== null);

/* ----------------------------------------- 3. through the settings path */

const source = `<!doctype html><html><head><title>Visit</title></head><body><main>
<section><h2>See us</h2><div class="frame"><iframe src="https://www.youtube.com/embed/aaaaaaaaaaa" title="Old tour"></iframe></div></section>
<section><h2>Find us</h2><iframe src="https://widgets.example/map?id=4"></iframe></section>
</main></body></html>`;
const fields = readPage(source).fields;
const [tour, foreign] = fields.filter((field) => field.tag === "iframe");
check("both frames are fields", tour && foreign);
check("a frame's panel says its address is under General", /General/.test(tour!.unsupportedReason ?? ""));
equal("a frame's address and description reach the panel", tour!.attributes, [{ name: "src", value: "https://www.youtube.com/embed/aaaaaaaaaaa" }, { name: "title", value: "Old tour" }]);

const settle = (fieldId: string, attributes: Record<string, string | null>) => {
  const result = changeStructure(source, {}, { kind: "settings", fieldId, settings: { attributes } });
  const document = result.values[DOCUMENT_KEY]!.document!;
  return { html: document.html, line: document.changes.at(-1) ?? "" };
};
const next = embedAddress("https://youtu.be/dQw4w9WgXcQ?t=5");
check("the converter's address is what the panel sends", "address" in next);
const changed = settle(tour!.id, { src: (next as { address: string }).address, title: "Shop tour", loading: "lazy", allowfullscreen: "" });
check("the frame shows the new video", changed.html.includes('src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=5"'));
check("with its description", changed.html.includes('title="Shop tour"'));
check("lazy and full screen", / loading="lazy"/.test(changed.html) && / allowfullscreen[ >]/.test(changed.html));
check("named as embed settings in the change list", /embed settings changed/.test(changed.line));
equal("the rest of the page is untouched", changed.html.replace(/ data-dw-node="[^"]*"/g, "").replace(/<iframe[^>]*>/, ""), source.replace(/<iframe[^>]*>/, ""));

assert.throws(() => settle(tour!.id, { src: "https://evil.example/login" }), (error: unknown) => error instanceof StructureError && /YouTube/.test(error.message), "an off-list address is refused with the sentence");
checks += 1;
assert.throws(() => settle(tour!.id, { srcdoc: "<script>alert(1)</script>" }), (error: unknown) => error instanceof StructureError, "srcdoc is refused");
checks += 1;
const described = settle(foreign!.id, { title: "Map of the shop" });
const foreignTag = /<iframe[^>]*widgets\.example[^>]*>/.exec(described.html)?.[0] ?? "";
check("a frame off the list can still be described", foreignTag.includes('title="Map of the shop"'));
check("and keeps its address", foreignTag.includes('src="https://widgets.example/map?id=4"'));

/* --------------------------------------------- 4. the Add panel's media */

const promised: Record<string, string> = { video: "iframe", "video-file": "video", audio: "audio", map: "iframe" };
equal("the Add panel has a video, a player, audio and a map", Object.keys(MEDIA_SECTION_TEMPLATES).sort(), Object.keys(promised).sort());
for (const [id, tag] of Object.entries(promised)) {
  const template = MEDIA_SECTION_TEMPLATES[id]!;
  const inserted = readPage(`<!doctype html><html><head><title>t</title></head><body><main>${template.html}</main></body></html>`);
  const players = inserted.fields.filter((field) => field.tag === tag);
  equal(`${id}: one ${tag} the panel can select`, players.length, 1);
  check(`${id}: it arrives empty rather than showing somebody else's media`, !/\ssrc=/.test(template.html));
  check(`${id}: with a heading somebody can change`, inserted.fields.some((field) => field.tag === "h2"));
  if (tag === "iframe") check(`${id}: a frame is described for screen readers`, /<iframe title="/.test(template.html));
}
const mapPage = `<!doctype html><html><head><title>t</title></head><body><main>${MEDIA_SECTION_TEMPLATES.map!.html}</main></body></html>`;
const emptyFrame = readPage(mapPage).fields.find((field) => field.tag === "iframe")!;
const placed = changeStructure(mapPage, {}, { kind: "settings", fieldId: emptyFrame.id, settings: { attributes: { src: mapAddress("Osu, Accra") } } });
check("an empty map frame is given a place in one change", placed.values[DOCUMENT_KEY]!.document!.html.includes(`src="${mapAddress("Osu, Accra").replace(/&/g, "&amp;")}"`));

console.log(`websiteEmbeds: ${checks} checks — pasted links become embed addresses, the service list holds on both sides of the wire, and a frame's settings land as one change`);
