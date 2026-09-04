#!/usr/bin/env node
/**
 * Proves the cookie consent layer actually holds, by driving real Chrome
 * against a real copy of the site and watching what leaves the browser.
 *
 *   node scripts/check-consent.mjs
 *   node scripts/check-consent.mjs --keep    # leave the working copy behind
 *
 * WHY THIS IS NOT A UNIT TEST
 * ---------------------------
 * The thing being asserted is a negative about the network — that no request
 * reaches Google before a visitor has agreed — and the ways it can silently
 * stop being true are all invisible in the source:
 *
 *   - a script tag that loses its `defer`, so analytics.js runs before
 *     consent.js has defined the gate it asks;
 *   - a stray `<script src="…googletagmanager…">` pasted into one page's head;
 *   - a third-party embed added to a template, which is a transfer of the
 *     visitor's IP address whatever the banner says;
 *   - the fonts quietly going back to fonts.googleapis.com;
 *   - a change to the banner that makes Reject smaller or slower to reach than
 *     Accept, which is the most commonly enforced dark pattern in EU cookie
 *     cases and is a question about computed layout, not about markup.
 *
 * Every one of those passes a review of the diff. So this asks the browser.
 *
 * TWO ENVIRONMENT DETAILS THAT ARE NOT INCIDENTAL
 * -----------------------------------------------
 * The site is served over HTTPS on a made-up hostname rather than over HTTP on
 * 127.0.0.1, and both halves of that are load-bearing:
 *
 *   - The pages carry `upgrade-insecure-requests`, which rewrites every http://
 *     subresource to https://. Chrome exempts loopback addresses from that rule,
 *     so an http test on 127.0.0.1 passes while any real-looking hostname loads
 *     no stylesheets and no scripts at all — the banner included.
 *   - assets/analytics.js refuses to run on localhost and 127.0.0.1 on purpose,
 *     so a test on that host can never tell a working gate from a preview guard
 *     doing its job. Both false results were seen while this was being written.
 *
 * Needs Chrome and openssl, and neither is worth failing a build over on a
 * machine that has not got them: it skips with an explanation and exit code 0.
 */

import { createServer } from "node:https";
import { readFileSync, writeFileSync, existsSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = join(tmpdir(), "dakyworld-consent-check");
const KEEP = process.argv.includes("--keep");
const PORT = 8731;
const DEBUG_PORT = 9333;
const HOST = "dakyworld.test";

/** The pages worth driving: one of each shape, not all thirteen. */
const PAGES = ["index.html", "privacy.html", "terms.html", "contact.html", "insights.html", "404.html"];

const skip = (why) => {
  console.log(`SKIPPED — ${why}`);
  process.exit(0);
};

// --- prerequisites -----------------------------------------------------------

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));

if (!CHROME) skip("Chrome was not found. This check needs a browser; the site itself is unaffected.");
if (spawnSync("openssl version", { shell: true }).status !== 0) {
  skip("openssl was not found. It is needed for the throwaway TLS certificate.");
}

// --- a copy of the site with analytics switched on ---------------------------
// The live file has an empty measurement id, so analytics would stay silent
// whatever the consent layer did — and a check that passes because the feature
// is switched off is a check that proves nothing. Filling one in is the only
// way to tell a working gate from a missing id.

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
for (const file of PAGES) cpSync(join(ROOT, file), join(WORK, file));
cpSync(join(ROOT, "assets"), join(WORK, "assets"), { recursive: true });

const analyticsFile = join(WORK, "assets/analytics.js");
const withId = readFileSync(analyticsFile, "utf8").replace(
  'var DAKYWORLD_GA4_ID = "";',
  'var DAKYWORLD_GA4_ID = "G-CHECKONLY1";'
);
if (!withId.includes("G-CHECKONLY1")) {
  console.error("FAILED — could not switch analytics on in the copy under test.");
  console.error("assets/analytics.js no longer declares DAKYWORLD_GA4_ID the way this check expects.");
  process.exit(1);
}
writeFileSync(analyticsFile, withId);

// A certificate that lives for the length of this run and is trusted by nothing.
const key = join(WORK, "key.pem");
const cert = join(WORK, "cert.pem");
// One command string rather than an args array: passing args alongside
// shell:true concatenates them unescaped, which Node warns about, and every
// value here is a literal or a path this script chose.
const opensslCmd = [
  "openssl req -x509 -newkey rsa:2048",
  `-keyout "${key}" -out "${cert}"`,
  "-days 1 -nodes",
  `-subj "/CN=${HOST}" -addext "subjectAltName=DNS:${HOST}"`,
].join(" ");
const openssl = spawnSync(opensslCmd, { shell: true, stdio: "ignore" });
if (openssl.status !== 0 || !existsSync(cert)) skip("openssl could not write a test certificate.");

// --- the site, served -------------------------------------------------------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = createServer(
  { key: readFileSync(key), cert: readFileSync(cert) },
  (req, res) => {
    let path = decodeURIComponent(req.url.split("?")[0]);
    if (path === "/") path = "/index.html";
    // The live site serves clean URLs, so /privacy has to resolve here too.
    let file = join(WORK, normalize(path).replace(/^([/\\])+/, ""));
    if (!existsSync(file) && existsSync(file + ".html")) file += ".html";
    if (!existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  }
);
await new Promise((r) => server.listen(PORT, r));

// --- the browser ------------------------------------------------------------

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  // Chrome exits with code 21 on a relative --user-data-dir.
  `--user-data-dir=${resolve(WORK, "profile")}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
  "--ignore-certificate-errors",
  "--window-size=1280,900",
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl;
  } catch { await new Promise((r) => setTimeout(r, 250)); }
}
if (!wsUrl) { chrome.kill(); server.close(); skip("Chrome did not open a debugging port."); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
const requests = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { rs, rj } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rj(new Error(JSON.stringify(msg.error))) : rs(msg.result);
  } else if (msg.method === "Network.requestWillBeSent") {
    requests.push(msg.params.request.url);
  }
};
const send = (method, params = {}, sid) => {
  const id = nextId++;
  return new Promise((rs, rj) => {
    pending.set(id, { rs, rj });
    ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });
};

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const cmd = (m, p) => send(m, p, sessionId);
await cmd("Page.enable");
await cmd("Runtime.enable");
await cmd("Network.enable");

async function evaluate(expression) {
  const r = await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + expression.slice(0, 70));
  return r.result.value;
}

/**
 * index.html loads cdn.tailwindcss.com and unpkg.com with plain blocking
 * script tags, so the parser stalls on two third-party round trips before it
 * reaches <body> — and consent.js is deferred, so it does not run until
 * parsing finishes. Wait for the thing itself, never for a fixed delay: a
 * 1.4s wait reported a broken consent layer that was working perfectly,
 * several seconds later.
 */
async function goto(path) {
  requests.length = 0;
  await cmd("Page.navigate", { url: `https://${HOST}:${PORT}${path}` });
  for (let i = 0; i < 80; i++) {
    const ready = await evaluate(
      `document.readyState === 'complete' && typeof window.dakyworldConsent === 'object'`
    ).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 600));
}

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/** Anything that would put a visitor's address in front of a third party. */
const toThirdParties = (urls) =>
  urls.filter((u) => /googletagmanager|google-analytics|doubleclick|fonts\.gstatic|fonts\.googleapis|facebook|hotjar|segment/.test(u));

// --- 1. a first visit measures nobody ---------------------------------------

await goto("/");
check("the banner appears on a first visit", await evaluate(`!!document.querySelector('.dw-consent')`));
check("nothing is sent to a third party before a choice is made",
  toThirdParties(requests).length === 0, toThirdParties(requests).join(", ") || "none");
check("no analytics cookie exists before a choice",
  !(await evaluate(`document.cookie.includes('_ga')`)));
check("no consent record is stored before a choice",
  (await evaluate(`localStorage.getItem('dakyworld.consent.v1')`)) === null);

// --- 2. the banner is not a dark pattern ------------------------------------

check("reject and accept are the same size", await evaluate(`
  (() => {
    const r = document.querySelector('.dw-consent__btn--reject').getBoundingClientRect();
    const a = document.querySelector('.dw-consent__btn--accept').getBoundingClientRect();
    return Math.abs(r.height - a.height) < 1 && Math.abs(r.width - a.width) < 40 && r.width > 60;
  })()
`));
check("reject comes before accept in the tab order", await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.dw-consent__btn')];
    return b.findIndex(x => x.classList.contains('dw-consent__btn--reject')) <
           b.findIndex(x => x.classList.contains('dw-consent__btn--accept'));
  })()
`));
check("the page is usable while the banner is open", await evaluate(`
  (() => {
    const el = document.elementFromPoint(innerWidth / 2, 120);
    return !!el && !el.closest('.dw-consent');
  })()
`));

// --- 3. nothing is pre-ticked ------------------------------------------------

await evaluate(`document.querySelector('.dw-consent__btn--settings').click()`);
await new Promise((r) => setTimeout(r, 300));
check("the preferences panel opens", await evaluate(`!!document.querySelector('.dw-consent-modal')`));
check("analytics is not pre-ticked",
  (await evaluate(`document.querySelector('input[data-category="analytics"]').checked`)) === false);
check("the necessary category offers no switch to turn off",
  await evaluate(`!document.querySelector('input[data-category="necessary"]')`));
check("the decision buttons are reachable without scrolling the panel", await evaluate(`
  (() => {
    const p = document.querySelector('.dw-consent-modal__panel').getBoundingClientRect();
    const a = document.querySelector('.dw-consent-modal__actions').getBoundingClientRect();
    return a.bottom <= p.bottom + 1 && a.top >= p.top;
  })()
`));
check("closing the panel decides nothing", await evaluate(`
  (async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    return !document.querySelector('.dw-consent-modal') &&
           localStorage.getItem('dakyworld.consent.v1') === null;
  })()
`));

// --- 4. a refusal is recorded and honoured ----------------------------------

requests.length = 0;
await evaluate(`document.querySelector('.dw-consent__btn--reject').click()`);
await new Promise((r) => setTimeout(r, 900));
check("the banner closes on reject", await evaluate(`!document.querySelector('.dw-consent')`));
check("a refusal is stored as an explicit no, with its date", await evaluate(`
  (() => {
    const r = JSON.parse(localStorage.getItem('dakyworld.consent.v1') || '{}');
    return !!r.choices && r.choices.analytics === false && r.choices.necessary === true && !!r.decidedAt;
  })()
`));
check("nothing is sent to a third party after a refusal",
  toThirdParties(requests).length === 0, toThirdParties(requests).join(", ") || "none");

await goto("/privacy");
check("the banner does not ask again once answered", await evaluate(`!document.querySelector('.dw-consent')`));
check("the refusal still holds on the next page",
  toThirdParties(requests).length === 0, toThirdParties(requests).join(", ") || "none");
check("the footer offers a way to change it",
  await evaluate(`!!document.querySelector('footer [data-consent-open]')`));

// --- 5. consent can be given, and takes effect at once -----------------------

requests.length = 0;
await evaluate(`document.querySelector('[data-consent-open]').click()`);
await new Promise((r) => setTimeout(r, 300));
await evaluate(`document.querySelector('input[data-category="analytics"]').click()`);
await evaluate(`[...document.querySelectorAll('.dw-consent__btn')].find(b => b.textContent === 'Save my choices').click()`);
await new Promise((r) => setTimeout(r, 2200));
check("analytics loads once it is allowed",
  requests.some((u) => u.includes("googletagmanager.com/gtag/js")),
  requests.filter((u) => /googletagmanager|google-analytics/.test(u)).length + " requests to Google");
check("advertising storage stays denied", await evaluate(`
  (() => {
    // gtag.js rewrites dataLayer entries once it runs, and not all of them are
    // spreadable afterwards; slice.call copes with every shape and a bad entry
    // is skipped rather than taking the assertion down.
    const dl = window.dataLayer || [];
    for (let i = 0; i < dl.length; i++) {
      let a;
      try { a = Array.prototype.slice.call(dl[i]); } catch (e) { continue; }
      if (a[0] === 'consent' && a[1] === 'default' && a[2]) {
        return a[2].ad_storage === 'denied' && a[2].ad_user_data === 'denied' &&
               a[2].ad_personalization === 'denied' && a[2].analytics_storage === 'granted';
      }
    }
    return false;
  })()
`));

// --- 6. withdrawing actually stops it ---------------------------------------

const before = await evaluate(`document.cookie.split(';').filter(c => c.trim().startsWith('_ga')).length`);
await goto("/");
await evaluate(`document.querySelector('[data-consent-open]').click()`);
await new Promise((r) => setTimeout(r, 300));
await evaluate(`[...document.querySelectorAll('.dw-consent__btn')].find(b => b.textContent === 'Reject all').click()`);
await new Promise((r) => setTimeout(r, 2500));
const after = await evaluate(`document.cookie.split(';').filter(c => c.trim().startsWith('_ga')).length`);
// Counted again on a fresh page, because the guarantee is that no analytics
// cookie survives a refusal — not that none survives the first instant of one.
// gtag is still running when the switch is turned off and can re-set a cookie
// between the delete and the reload; the sweep in consent.js start() is what
// makes the outcome converge, and this is the assertion that notices if it goes.
await goto("/privacy");
const later = await evaluate(`document.cookie.split(';').filter(c => c.trim().startsWith('_ga')).length`);
check("withdrawing consent deletes the cookies it set",
  before > 0 && after === 0 && later === 0, `${before} before, ${after} after, ${later} on the next page`);
check("and the refusal is what is stored afterwards",
  await evaluate(`JSON.parse(localStorage.getItem('dakyworld.consent.v1')).choices.analytics === false`));

// --- 7. no page contacts Google for its typefaces ---------------------------

for (const path of ["/", "/privacy", "/terms", "/contact", "/insights"]) {
  await goto(path);
  const google = requests.filter((u) => /fonts\.(googleapis|gstatic)\.com/.test(u));
  const local = requests.filter((u) => /\/assets\/fonts\/.*\.woff2/.test(u));
  check(`${path} — typefaces served from this origin`,
    google.length === 0 && local.length > 0,
    `${local.length} local, ${google.length} from Google`);
}

// --- done --------------------------------------------------------------------

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

ws.close();
chrome.kill();
server.close();

// Chrome holds its profile open for a moment after being killed, so a delete
// straight after it throws EPERM on Windows — which would fail a run whose
// checks all passed. Retry, and never let the tidying decide the exit code.
if (!KEEP) {
  // A beat for the profile to be released before the first attempt.
  await new Promise((r) => setTimeout(r, 700));
  try {
    rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    console.log(`(left ${WORK} behind — Chrome still had it open)`);
  }
}

process.exit(failed.length ? 1 : 0);
