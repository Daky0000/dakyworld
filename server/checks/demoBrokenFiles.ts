/**
 * A demo's files load in a real browser, and the ones that do not are reported.
 *
 * 11 Nov 2026: every picture on the Ghacem demo was broken while the HTTP logs
 * read 200 for each one. The demo page runs sandboxed in an opaque origin, and
 * the app-wide `Cross-Origin-Resource-Policy: same-origin` made the browser
 * discard every file after it arrived. It was the third time those pictures
 * broke (a lone HTML file, then 404s, then this), and each time the server had
 * nothing to show for it. Two things now stop a fourth:
 *
 * 1. Every file under `/demos/<slug>/` gets the headers a sandboxed page needs,
 *    applied to the whole prefix in the router rather than to one route.
 * 2. The page reports every file it could not load, whatever the reason, to
 *    the beacon (stored, logged, shown on the Demos screen) and to a parent
 *    frame (the Demos screen's own preview).
 *
 * This drives the real router behind the real security headers in Chromium.
 * The database is replaced by in-memory delegates, as in `geoRoutes.ts`.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import cors from "cors";
import express from "express";
import { chromium } from "playwright";
import { prisma } from "../src/lib/prisma.js";
import { isTrustedOrigin, securityHeaders } from "../src/middleware/security.js";
import { demosRouter, demoPagesRouter } from "../src/routes/demos.js";
import { FILE_WATCH_SCRIPT, injectDemoTracker, injectFileWatch } from "../src/services/demoTracker.js";
import { BROKEN_FILE_WINDOW_MS, MAX_BROKEN_FILES, mergeBrokenFiles, summariseBrokenFiles } from "../src/services/demoBrokenFiles.js";

let checks = 0;
const equal = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); checks++; };
const ok = (name: string, value: unknown) => { assert.ok(value, name); checks++; };

// ── The pieces on their own ──────────────────────────────────────────────────

// It is a template literal: a backslash or a `${` in it would be changed
// before the browser saw it, and the page would get a script that does not parse.
const watchBody = FILE_WATCH_SCRIPT.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
ok("the file watch has no backslash for the template literal to eat", !watchBody.includes("\\"));
ok("and parses as a script", (() => { new Function(watchBody); return true; })());

const page = '<!doctype html><html><head><title>t</title><link rel="stylesheet" href="a.css"></head><body><img src="x.png"></body></html>';
const watched = injectFileWatch(page);
ok("the watch goes first in <head>, before anything the page loads", watched.indexOf('id="dw-file-watch"') < watched.indexOf("<link") && watched.indexOf("<head>") < watched.indexOf('id="dw-file-watch"'));
equal("and only once", injectFileWatch(watched), watched);
ok("<header> is not taken for <head>", injectFileWatch("<html><body><header>x</header></body></html>").indexOf("dw-file-watch") < injectFileWatch("<html><body><header>x</header></body></html>").indexOf("<header>"));
ok("a fragment with no <html> still gets it first", injectFileWatch("<img src=x>").startsWith('<script id="dw-file-watch">'));
for (const disabled of [false, true]) {
  const html = injectDemoTracker(page, { slug: "s", visitId: "v", token: "t", disabled });
  ok(`both the live page and the preview carry the watch (preview: ${disabled})`, html.includes('id="dw-file-watch"'));
}

const first = mergeBrokenFiles(null, [{ url: "/a.png", kind: "img" }, { url: "/a.png", kind: "img" }]);
equal("a report is kept once per address", first.files, [{ url: "/a.png", kind: "img" }]);
const second = mergeBrokenFiles(first.files, [{ url: "/a.png", kind: "img" }, { url: "/b.css", kind: "link" }]);
equal("a later beacon adds only what is new", second.added, [{ url: "/b.css", kind: "link" }]);
const many = Array.from({ length: 60 }, (_, i) => ({ url: `/${i}.png`, kind: "img" }));
equal("and a visit holds no more than the cap", mergeBrokenFiles(null, many).files.length, MAX_BROKEN_FILES);

const now = new Date("2026-11-11T12:00:00Z");
const summary = summariseBrokenFiles([
  { brokenFiles: [{ url: "/a.png", kind: "img" }], createdAt: new Date("2026-11-11T10:00:00Z") },
  { brokenFiles: [{ url: "/a.png", kind: "img" }, { url: "/b.png", kind: "img" }], createdAt: new Date("2026-11-10T10:00:00Z") },
  { brokenFiles: [{ url: "/old.png", kind: "img" }], createdAt: new Date(now.getTime() - BROKEN_FILE_WINDOW_MS - 1000) },
  { brokenFiles: "not a list", createdAt: now },
], now);
equal("the summary counts visits per address, newest first, and lets old reports go",
  summary.map((file) => [file.url, file.visits, file.lastSeenAt]),
  [["/a.png", 2, "2026-11-11T10:00:00.000Z"], ["/b.png", 1, "2026-11-10T10:00:00.000Z"]]);

// ── The real router behind the real headers ──────────────────────────────────

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const demoHtml = `<!doctype html><html><head><title>Fixture</title>
<style>@font-face{font-family:Gone;src:url(/demos/fx/assets/dw/gone.woff2)}p{font-family:Gone}
.bg{background-image:url("/demos/fx/assets/dw/gone-bg.png");width:10px;height:10px}</style>
</head><body><img id="ok" src="/demos/fx/assets/dw/ok.png"><img id="bad" src="/demos/fx/assets/dw/gone.png"><div class="bg"></div><p>Words</p></body></html>`;
const demo = { id: "fx-demo", slug: "fx", title: "Fixture", businessName: "Fixture", status: "DRAFT", html: demoHtml,
  brief: { notifyOnView: false }, views: 0, lastViewedAt: null, createdAt: now, builtBy: "Imported HTML" };
const visits: any[] = [];
const updates: any[] = [];
(prisma.demo as any).findUnique = async () => demo;
(prisma.demo as any).update = async () => demo;
(prisma.appSetting as any).findUnique = async () => null;
(prisma.siteAsset as any).findFirst = async ({ where }: any) =>
  where.repoPath === "assets/dw/ok.png" ? { content: PNG, contentType: "image/png", size: PNG.length } : null;
(prisma.demoVisit as any).create = async ({ data }: any) => {
  const visit = { ...data, createdAt: new Date(), updatedAt: new Date() }; visits.push(visit); return visit;
};
(prisma.demoVisit as any).findFirst = async ({ where }: any) => visits.find((v) => v.id === where.id);
(prisma.demoVisit as any).update = async ({ where, data }: any) => {
  updates.push(data);
  const visit = visits.find((v) => v.id === where.id);
  Object.assign(visit, data, { updatedAt: new Date() });
  return visit;
};
(prisma.demoVisit as any).findMany = async () => visits;
delete process.env.R2_ACCOUNT_ID;

const warnings: string[] = [];
const warn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };

const app = express();
// A parent page for the preview, as the Demos screen frames the demo. Before
// the security headers so its inline listener may run.
app.get("/parent", (_req, res) => {
  res.type("html").send(`<!doctype html><script>window.got=[];addEventListener("message",function(e){if(e.data&&e.data.type==="broken-files")window.got=e.data.files})</script><iframe src="/demos/fx?dw_preview=heatmap"></iframe>`);
});
app.use(cors({ origin: (origin, callback) => callback(null, !origin || isTrustedOrigin(origin)), credentials: true }));
app.use(securityHeaders);
app.use("/demos", demoPagesRouter);
app.use((req, _res, next) => { (req as any).dbUser = { id: "fixture" }; req.permissions = new Set(["demos.view"]); next(); });
app.use("/api/demos", demosRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch();
try {
  // What a sandboxed page sends for a font or a module script.
  const file = await fetch(`${origin}/demos/fx/assets/dw/ok.png`, { headers: { Origin: "null" } });
  equal("a demo's file may be loaded by its own opaque-origin page", file.headers.get("cross-origin-resource-policy"), "cross-origin");
  equal("and read in CORS mode from Origin: null", file.headers.get("access-control-allow-origin"), "*");
  equal("without a credentials grant beside the wildcard", file.headers.get("access-control-allow-credentials"), null);
  equal("the rest of the security headers still apply to it", file.headers.get("x-content-type-options"), "nosniff");
  const future = await fetch(`${origin}/demos/fx/some/route/added/later.png`);
  equal("a file route added under a demo later is covered without anyone remembering to", future.headers.get("cross-origin-resource-policy"), "cross-origin");
  const pageResponse = await fetch(`${origin}/demos/fx`);
  await pageResponse.text();
  equal("the page itself is not a file and gets no wildcard", pageResponse.headers.get("access-control-allow-origin"), null);
  equal("everything outside a demo keeps CORP same-origin", (await fetch(`${origin}/api/ready`)).headers.get("cross-origin-resource-policy"), "same-origin");
  visits.length = 0;

  // A visitor, in a real browser.
  const visitor = await browser.newPage();
  await visitor.goto(`${origin}/demos/fx`, { waitUntil: "load" });
  await visitor.waitForFunction(() => (document.getElementById("ok") as HTMLImageElement | null)?.complete);
  equal("the demo's stored picture shows in the sandboxed page", await visitor.evaluate(() => (document.getElementById("ok") as HTMLImageElement).naturalWidth), 1);
  const reported = async () => (visits[0]?.brokenFiles ?? []).map((f: { url: string; kind: string }) => `${f.kind} ${new URL(f.url, origin).pathname || f.url}`).sort();
  const want = ["background /demos/fx/assets/dw/gone-bg.png", "img /demos/fx/assets/dw/gone.png"];
  for (let i = 0; i < 40 && !want.every((line) => JSON.stringify(visits[0]?.brokenFiles ?? []).includes(line.split(" ")[1])); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const lines = await reported();
  ok(`the visitor's browser reported the missing picture and background: ${lines.join(", ")}`, want.every((line) => lines.includes(line)));
  ok("and never the picture that loaded", !lines.some((line: string) => line.includes("ok.png")));
  ok("the server wrote it to the log, where the HTTP logs alone say nothing", warnings.some((line) => line.includes("[demos] fx:") && line.includes("did not load in a visitor's browser")));
  const report = await (await fetch(`${origin}/api/demos/fx-demo/analytics`)).json();
  // The card on the Demos list reads the same summary from the same visits.
  ok("and the Demos screen's report lists it", report.brokenFiles?.some((f: { url: string }) => f.url.endsWith("/gone.png")));

  // The owner, looking at the preview inside the Demos screen.
  const owner = await browser.newPage();
  await owner.goto(`${origin}/parent`, { waitUntil: "load" });
  // Backgrounds are probed after load, so they arrive in a later message.
  await owner.waitForFunction(() => (window as any).got.some((f: { kind: string }) => f.kind === "background"), null, { timeout: 10_000 }).catch(() => undefined);
  const got: Array<{ url: string; kind: string }> = await owner.evaluate(() => (window as any).got);
  ok(`a preview tells the frame around it: ${JSON.stringify(got)}`, got.some((f) => f.url.endsWith("/gone.png")) && got.some((f) => f.kind === "background"));
  equal("and records no visit", visits.length, 1);
} finally {
  console.warn = warn;
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await prisma.$disconnect();
}

console.log(`demoBrokenFiles: ${checks} checks passed`);
