#!/usr/bin/env node
/**
 * Tells Bing, Yandex, Seznam, Naver and Yep that the site has changed, through
 * IndexNow. Bing's index is also what Copilot and ChatGPT search read, so this
 * is the fastest way for a published change to reach an AI answer.
 *
 * No account or secret is involved. Ownership is proved by the key file at the
 * site root (`/<INDEXNOW_KEY>.txt`), which GitHub Pages must be serving before
 * this is run — so run it after a deploy has finished, not before:
 *
 *   node scripts/indexnow.mjs            # every URL in sitemap.xml
 *   node scripts/indexnow.mjs /pricing   # just these paths
 *
 * A 200 or 202 means accepted. 403 means the key file is not live yet; 422
 * means a URL is not on this host. Neither is retried.
 */

import { readFileSync } from "node:fs";
import { INDEXNOW_KEY } from "./build-seo.mjs";

const HOST = "dakyx.com";
const ORIGIN = `https://${HOST}`;

const paths = process.argv.slice(2);
const urls = paths.length
  ? paths.map((path) => `${ORIGIN}${path.startsWith("/") ? path : `/${path}`}`)
  : [...readFileSync("sitemap.xml", "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

const keyLocation = `${ORIGIN}/${INDEXNOW_KEY}.txt`;
const live = await fetch(keyLocation).then((res) => (res.ok ? res.text() : null)).catch(() => null);
if (live?.trim() !== INDEXNOW_KEY) {
  console.error(`The key file is not live at ${keyLocation} yet. Deploy first, then run this again.`);
  process.exit(1);
}

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key: INDEXNOW_KEY, keyLocation, urlList: urls }),
});
console.log(`IndexNow: ${res.status} ${res.statusText} for ${urls.length} URL(s)`);
if (!res.ok) {
  console.error(await res.text());
  process.exit(1);
}
