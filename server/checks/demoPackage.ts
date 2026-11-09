/**
 * A demo imported with the folder beside it, without a database.
 *
 * 9 Nov 2026: the Ghacem demo was imported as its index.html alone. The page
 * named 28 pictures as `./images/...` beside it; none had reached the server,
 * so every one answered 404 on the editor canvas, in the preview and on the
 * demo link. The way out was selecting each picture and uploading it again.
 * A ZIP (or a folder, zipped in the browser) now brings them.
 */
import assert from "node:assert/strict";
import JSZip from "jszip";
import { bundleDemoFiles, bundledFilesNote, readDemoPackage, zipUploadBytes } from "../src/services/demoPackage.js";
import { localFilesNamed } from "../src/services/demoBuilder.js";
import { filesForPage, htmlPagesIn, localFilesNamedInBrowser, relativeToFolder, zipPageWithFiles } from "../client/src/lib/demoFolder.js";

let checks = 0;
const equal = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); checks++; };
const ok = (name: string, value: unknown) => { assert.ok(value, name); checks++; };

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><symbol id="home"><path d="M0 0h1v1z"/></symbol><script>alert(1)</script></svg>');

const page = `<!doctype html><html><head><title>Ghacem</title>
<link rel="stylesheet" href="css/site.css?v=3"><link rel="icon" href="./images/favicon.png">
</head><body>
<img src="./images/hero/plant.png" alt="Plant">
<img src="images/products/eco%20cool.png" srcset="images/products/eco%20cool.png 1x, images/hero/plant.png 2x">
<div style="background-image:url('images/bg.png')"></div>
<img src="images/animated.gif"><img src="images/missing.png"><img src="https://cdn.test/elsewhere.png">
<svg><use href="images/icons.svg#home"></use></svg>
<a href="about.html">About</a><a href="images/hero/plant.png.html">not a picture</a>
<p>Our logo.png story</p>
<script>var slides = ['images/hero/plant.png', "images/slide-2.png"];</script>
</body></html>`;

const zip = new JSZip();
const root = zip.folder("ghacem-static-html")!;
root.file("index.html", page);
root.file("about.html", "<html><body>About</body></html>");
root.file("css/site.css", "body{background:url(../images/texture.png)} @font-face{src:url('../fonts/brand.woff2')}");
root.file("fonts/brand.woff2", Buffer.from("wOF2-not-really"));
for (const name of ["hero/plant.png", "products/eco cool.png", "bg.png", "favicon.png", "texture.png", "slide-2.png", "unused.png"]) root.file(`images/${name}`, PNG);
root.file("images/animated.gif", GIF);
root.file("images/icons.svg", SVG);
root.file("notes.txt", "not used");
const archive = await zip.generateAsync({ type: "nodebuffer" });

equal("a base64 ZIP is recognised, with or without a data: prefix", [
  zipUploadBytes(archive.toString("base64"))?.length,
  zipUploadBytes(`data:application/zip;base64,${archive.toString("base64")}`)?.length,
], [archive.length, archive.length]);
equal("an HTML upload is not a ZIP", [zipUploadBytes(Buffer.from("<html></html>").toString("base64")), zipUploadBytes(""), zipUploadBytes(null)], [null, null, null]);

const pkg = await readDemoPackage(archive, "ghacem.zip");
equal("index.html is the demo, the folder it was zipped in taken off", pkg.entryPath, "index.html");
equal("the other page is named, not used", pkg.otherPages, ["about.html"]);
equal("a named entry wins", (await readDemoPackage(archive, "ghacem.zip", "about.html")).entryPath, "about.html");

const bundled = await bundleDemoFiles(pkg.html, pkg, "/demos/ghacem/assets/dw");
const sources = bundled.assets.map((asset) => asset.source).sort();
equal("only the files the page uses are stored, stylesheet's own files included", sources, [
  "css/site.css", "fonts/brand.woff2", "images/animated.gif", "images/bg.png", "images/favicon.png",
  "images/hero/plant.png", "images/icons.svg", "images/products/eco cool.png", "images/slide-2.png", "images/texture.png",
]);
equal("a file used three times is stored once", bundled.assets.filter((asset) => asset.source === "images/hero/plant.png").length, 1);
ok("every one under the demo's own asset address, as the editor's Replace writes", bundled.assets.every((asset) => /^assets\/dw\/[0-9a-f-]{36}\.\w+$/.test(asset.repoPath)));

const url = (source: string) => `/demos/ghacem/assets/dw/${bundled.assets.find((asset) => asset.source === source)!.repoPath.split("/").pop()}`;
const html = bundled.html;
ok("an <img src> points at the stored file", html.includes(`<img src="${url("images/hero/plant.png")}" alt="Plant">`));
ok("a percent-encoded name is found", html.includes(`src="${url("images/products/eco cool.png")}"`));
ok("each srcset candidate is rewritten, its descriptor kept", html.includes(`srcset="${url("images/products/eco cool.png")} 1x, ${url("images/hero/plant.png")} 2x"`));
ok("a CSS url() in a style attribute", html.includes(`url('${url("images/bg.png")}')`));
ok("a stylesheet link, its cache-buster dropped", html.includes(`href="${url("css/site.css")}"`));
ok("an SVG sprite keeps its fragment", html.includes(`href="${url("images/icons.svg")}#home"`));
ok("a script's strings, resolved against the page", html.includes(`'${url("images/hero/plant.png")}'`) && html.includes(`"${url("images/slide-2.png")}"`));
ok("a page link, a look-alike name, words and an address elsewhere are untouched",
  html.includes('href="about.html"') && html.includes('href="images/hero/plant.png.html"') && html.includes("Our logo.png story") && html.includes('src="https://cdn.test/elsewhere.png"'));
equal("a file the folder does not have is left for the import's note to name", localFilesNamed(html), ["images/missing.png"]);

const css = bundled.assets.find((asset) => asset.source === "css/site.css")!.content.toString("utf8");
equal("the stylesheet's own references resolve against itself", css, `body{background:url(${url("images/texture.png")})} @font-face{src:url('${url("fonts/brand.woff2")}')}`);
const svg = bundled.assets.find((asset) => asset.source === "images/icons.svg")!;
ok("an SVG is rebuilt through the sanitiser, its script gone", svg.contentType === "image/svg+xml" && !svg.content.toString("utf8").includes("<script"));
const gif = bundled.assets.find((asset) => asset.source === "images/animated.gif")!;
ok("a GIF is kept byte for byte, so an animation still moves", gif.content.equals(GIF) && gif.repoPath.endsWith(".gif"));
ok("a picture goes through the upload optimiser", bundled.assets.filter((asset) => asset.source.endsWith(".png")).every((asset) => asset.contentType.startsWith("image/")));

const notes = bundledFilesNote(pkg, bundled.assets.length, bundled.skipped);
ok("the import says what came with the page", notes[0]?.startsWith("10 files the page uses were uploaded with it"));
ok("and that the other page is not part of the demo", notes.some((note) => note.includes("1 other page was in the folder")));

// Same day, second round: Dan picked the lone file again, and the page sits
// straight in Downloads beside three other copies of the same site. Choosing
// that folder must send this page's pictures, by path, and nothing else.
const folderFile = (p: string, body: string | Buffer = PNG) => ({
  path: `Downloads/${p}`,
  file: new File([typeof body === "string" ? body : new Uint8Array(body)], p.split("/").pop()!),
});
const downloads = relativeToFolder([
  folderFile("index.html", '<img src="./images/hero/plant.png"><link rel="stylesheet" href="css/a.css"><a href="about.html">x</a>'),
  folderFile("about.html", "<p>about</p>"),
  folderFile("css/a.css", "body{background:url('../images/bg.png')}"),
  folderFile("images/hero/plant.png"),
  folderFile("images/bg.png"),
  folderFile("ghacem-nextjs/public/images/hero/plant.png"),
  folderFile("ghacem-website/ghacem-static-html/images/hero/plant.png"),
  folderFile("ghacem-website/ghacem-static-html/index.html", '<img src="images/hero/plant.png">'),
  folderFile("node_modules/x/plant.png"),
]);
equal("the folder's own name comes off, node_modules is never listed", downloads.map((f) => f.path).includes("node_modules/x/plant.png"), false);
equal("the top index.html is offered first", htmlPagesIn(downloads)[0], "index.html");
equal("only the files the page names, by path — not every file with the same name",
  (await filesForPage(downloads, "index.html")).map((f) => f.path).sort(), ["css/a.css", "images/bg.png", "images/hero/plant.png", "index.html"]);
const nested = await zipPageWithFiles(downloads, "ghacem-website/ghacem-static-html/index.html", "Downloads");
equal("a page deeper in the folder is zipped from its own folder, so it sits at the top", nested.entry, "index.html");
const nestedPkg = await readDemoPackage(zipUploadBytes(nested.base64)!, nested.filename, nested.entry);
equal("and the server finds it and its picture there", [nestedPkg.entryPath, [...nestedPkg.files.keys()]], ["index.html", ["images/hero/plant.png"]]);
equal("the browser's warning names what the server's note would", localFilesNamedInBrowser(page), localFilesNamed(page));

const empty = new JSZip();
empty.file("readme.txt", "no page here");
await assert.rejects(readDemoPackage(await empty.generateAsync({ type: "nodebuffer" }), "x.zip"), (err: Error & { status?: number }) => err.status === 400);
checks++;

console.log(`demoPackage: ${checks} checks passed`);
