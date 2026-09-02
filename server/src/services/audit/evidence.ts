import { fetchSite, type CertificateState, type SiteFetch } from "../companyAudit.js";
import { runSeoAudit, type RenderedMeasurements } from "../seoAudit.js";
import { PHONE_VIEWPORT_WIDTH, captureHomepage, normaliseSiteUrl, type ShotResult } from "../siteShot.js";

export type { RenderedMeasurements };

/**
 * Everything the audit team argues from, gathered once.
 *
 * The reason this is one file rather than four is money and honesty in equal
 * measure. Four reviewers each fetching the page is four fetches of the same
 * bytes, four sets of timings that disagree with each other, and four chances
 * for one of them to be looking at a different version of the site than the
 * others. The report then contradicts itself, in front of a stranger, about
 * their own business.
 *
 * So: fetch once, measure once, photograph once, and hand the same evidence to
 * everybody. The measurements below are all arithmetic on what came back —
 * nothing here is a judgement, and nothing here is a model's opinion. The
 * judgements happen in the four reviewer files, and each of them may only
 * argue from what is in this object.
 *
 * **What this deliberately does not do:** it does not run a browser. There is
 * no Lighthouse score here, no Core Web Vitals, no rendering. Those need a
 * real Chrome and this is a small Node process on Railway. What can be
 * measured from a fetch — time to first byte, page weight, how many things the
 * page asks the browser to go and get before it can paint, whether the tags
 * that decide a search result are there — is measured exactly, and everything
 * that cannot be is named in `notes` rather than guessed at.
 */

const SMALL_FETCH_TIMEOUT_MS = 8000;
const CRAWLER_UA = "DakyworldOS-SiteAudit/1.0 (+https://dakyworld.com)";

export interface PageResource {
  url: string;
  /** True when it is served from another origin — a font, a tag manager, a chat widget. */
  external: boolean;
  /** True when the browser must fetch and run it before it can paint. */
  blocking: boolean;
}

export interface HeadingRow {
  level: number;
  text: string;
}

/** What a search engine and a link preview read off the page. */
export interface SeoTags {
  title: string | null;
  titleLength: number;
  description: string | null;
  descriptionLength: number;
  canonical: string | null;
  robots: string | null;
  viewport: string | null;
  lang: string | null;
  charset: string | null;
  favicon: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  twitterCard: string | null;
  /** The `@type` of every JSON-LD block on the page. */
  structuredData: string[];
}

export interface PageMeasurements {
  /** Milliseconds to the first byte of the homepage. */
  responseMs: number;
  /** Bytes of HTML actually delivered. A floor, not a total: the fetch is capped. */
  htmlBytes: number;
  /** True when the fetch hit its cap, so `htmlBytes` is the cap and not the page. */
  htmlTruncated: boolean;
  /** What the server said the body weighed, when it said. */
  contentLength: number | null;
  /** gzip, br, or nothing — text served uncompressed is the cheapest win there is. */
  contentEncoding: string | null;
  /** How long a browser is told it may keep the page. */
  cacheControl: string | null;
  scripts: PageResource[];
  stylesheets: PageResource[];
  /** Bytes of CSS written straight into the page. */
  inlineStyleBytes: number;
  /** Bytes of JavaScript written straight into the page. */
  inlineScriptBytes: number;
  images: { url: string; alt: string | null; lazy: boolean; external: boolean; hasDimensions: boolean }[];
  iframes: string[];
  forms: { action: string | null; method: string; secure: boolean }[];
  links: { internal: number; external: number; empty: number };
  /**
   * The ways a visitor can actually make contact from this page.
   *
   * Counted rather than judged, because "there is no way to ring them from
   * their own homepage" is the single most common thing wrong with a small
   * business site and it is a fact, not an opinion. A phone number printed as
   * text is not a `tel:` link, and on a phone that is the difference between
   * one tap and copying digits by hand.
   */
  contactRoutes: { tel: number; mailto: number; whatsapp: number; contactPageLinked: boolean };
  headings: HeadingRow[];
  h1Count: number;
  /** The visible words on the page, with the markup taken out. */
  text: string;
  wordCount: number;
  /** Anything the page loads from somewhere else, by hostname. */
  thirdPartyHosts: string[];
}

export interface SecurityEvidence {
  /** The final address. Tells us whether http was upgraded. */
  https: boolean;
  /**
   * Set when the page was only readable by going past a certificate warning.
   *
   * `https: true` and this both being set is not a contradiction — it is the
   * exact state of a site with an expired certificate, which is encrypted and
   * untrusted at the same time, and the report has to say both.
   */
  certificate: CertificateState | null;
  /** True when a plain http request ended up on https. */
  redirectsToHttps: boolean | null;
  /** Set when http could not be checked at all, with the reason. */
  httpNote: string | null;
  headers: {
    strictTransportSecurity: string | null;
    contentSecurityPolicy: string | null;
    xFrameOptions: string | null;
    xContentTypeOptions: string | null;
    referrerPolicy: string | null;
    permissionsPolicy: string | null;
  };
  /** `Server:` and `X-Powered-By:` — a version number here is a shopping list. */
  serverBanner: string | null;
  poweredBy: string | null;
  /** A WordPress generator tag with a version in it, and anything like it. */
  generator: string | null;
  /** Cookies the homepage set before anybody agreed to anything, and their flags. */
  cookies: { name: string; secure: boolean; httpOnly: boolean; sameSite: string | null }[];
  /** `http://` assets on an https page. A browser blocks them and shows a warning. */
  mixedContent: string[];
  /** Login and admin paths linked from the homepage itself. */
  exposedAdminLinks: string[];
}

export interface RobotsEvidence {
  robotsTxt: { found: boolean; disallowsEverything: boolean; sitemapUrls: string[] } | null;
  sitemap: { url: string; found: boolean; urlCount: number | null } | null;
}

export interface AuditEvidence {
  /** What was asked for, before any correction. */
  requested: string;
  /** The address that answered. Null when nothing did. */
  finalUrl: string | null;
  status: number | null;
  reachable: boolean;
  fetch: SiteFetch;
  page: PageMeasurements | null;
  seo: SeoTags | null;
  security: SecurityEvidence | null;
  robots: RobotsEvidence;
  /** Desktop first, then phone. Either may be absent. */
  shots: { view: "desktop" | "mobile"; result: ShotResult }[];
  /**
   * What a real browser measured — first paint, layout shift, broken links.
   * Null when it could not be run, which is a note rather than a fault.
   */
  rendered: RenderedMeasurements | null;
  /** What could not be gathered, in plain words. Never a failure. */
  notes: string[];
  /**
   * The subset of `notes` that each of the two paid steps produced.
   *
   * Everything else in `notes` comes from the fetch, which is free and is
   * therefore repeated in full by any re-run. The two paid steps are not, and a
   * re-run of one section skips whichever of them that section does not argue
   * from — so without this a re-run has no way to tell "the browser could not
   * be rented" (still true, and still worth saying) from "no screenshot could
   * be taken" (no longer true, because this run took one). Carrying the first
   * forward and dropping the second is the whole difference between a report
   * that reads correctly after a partial re-run and one that contradicts
   * itself. Both arrays are also in `notes`; this is a view of them, not a
   * second source.
   */
  stepNotes: { screenshots: string[]; rendered: string[] };
  /** Apify, for the pictures. */
  costUsd: number;
}

// --- Reading the markup -----------------------------------------------------

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (!match) return null;
  // Decoded here rather than at each caller: a meta description is written by
  // the same word processor that put the entities in the title.
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? "").trim();
}

function tags(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((match) => match[0]);
}

function metaByName(html: string, name: string): string | null {
  for (const tag of tags(html, "meta")) {
    const key = attr(tag, "name") ?? attr(tag, "property") ?? attr(tag, "http-equiv");
    if (key && key.toLowerCase() === name.toLowerCase()) return attr(tag, "content");
  }
  return null;
}

function sameOrigin(url: string, base: URL): boolean {
  try {
    return new URL(url, base).host === base.host;
  } catch {
    return false;
  }
}

function absolute(url: string, base: URL): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/**
 * The named entities worth knowing, and the rule about the rest.
 *
 * Numeric references are decoded generally; named ones are not, because there
 * are two thousand of them and a table of two thousand in this file would be
 * absurd. These are the ones that actually turn up in the markup of a small
 * business homepage — the punctuation a word processor inserts, and the symbols
 * a company puts after its own name.
 *
 * This matters more than it looks. The first run of this reported a page title
 * of `Dakyworld&reg; &mdash; Your Outsourced IT Department`: eleven characters
 * longer than the real title, which is enough to change a length finding, and
 * unreadable in a document that was about to be shown to the business whose
 * title it is.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  reg: "®",
  copy: "©",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  deg: "°",
  eacute: "é",
  pound: "£",
  euro: "€",
  laquo: "«",
  raquo: "»",
  times: "×",
  divide: "÷",
  frac12: "½",
  shy: "",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,31});/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // A broken or out-of-range reference is left exactly as it was written.
      // Guessing at it would put a character on the page that their markup
      // does not contain, in a document that quotes their page back to them.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * The visible words, with the markup taken out.
 *
 * Script and style content is removed first rather than after: a page with an
 * inline analytics block otherwise reads as three hundred words of JavaScript,
 * and the content reviewer would be judging somebody's tag manager as their
 * copy.
 */
function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

const ADMIN_PATHS = /\/(wp-admin|wp-login\.php|administrator|admin|login|user\/login|cpanel|phpmyadmin)(\/|$|\?)/i;

function measurePage(html: string, headers: Headers, finalUrl: string, responseMs: number, truncated: boolean): PageMeasurements {
  const base = new URL(finalUrl);

  const scripts: PageResource[] = [];
  let inlineScriptBytes = 0;
  const headEnd = html.search(/<\/head>/i);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const tag = `<script${match[1]}>`;
    const src = attr(tag, "src");
    if (src) {
      const url = absolute(src, base);
      // `defer` and `async` both take a script off the critical path, and
      // `type="module"` is deferred by definition. Anything else in the head
      // stops the browser painting until it has been fetched and run.
      const deferred = /\bdefer\b|\basync\b/i.test(match[1]) || (attr(tag, "type") ?? "").toLowerCase() === "module";
      const inHead = headEnd === -1 ? false : (match.index ?? 0) < headEnd;
      scripts.push({ url, external: !sameOrigin(src, base), blocking: inHead && !deferred });
    } else {
      inlineScriptBytes += Buffer.byteLength(match[2], "utf8");
    }
  }

  const stylesheets: PageResource[] = [];
  for (const tag of tags(html, "link")) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    const href = attr(tag, "href");
    if (!href || !rel.split(/\s+/).includes("stylesheet")) continue;
    const media = (attr(tag, "media") ?? "").toLowerCase();
    stylesheets.push({
      url: absolute(href, base),
      external: !sameOrigin(href, base),
      // A stylesheet blocks rendering unless it is scoped to a media query the
      // browser can defer, or explicitly loaded as print.
      blocking: media !== "print",
    });
  }

  let inlineStyleBytes = 0;
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    inlineStyleBytes += Buffer.byteLength(match[1], "utf8");
  }

  const images = tags(html, "img").map((tag) => {
    const src = attr(tag, "src") ?? attr(tag, "data-src") ?? "";
    return {
      url: src ? absolute(src, base) : "",
      // An absent alt attribute and an empty one mean different things: empty
      // is the correct answer for decoration, absent is nobody thought about it.
      alt: attr(tag, "alt"),
      lazy: (attr(tag, "loading") ?? "").toLowerCase() === "lazy",
      external: Boolean(src) && !sameOrigin(src, base),
      hasDimensions: Boolean(attr(tag, "width") && attr(tag, "height")),
    };
  });

  const iframes = tags(html, "iframe")
    .map((tag) => attr(tag, "src"))
    .filter((src): src is string => Boolean(src))
    .map((src) => absolute(src, base));

  const forms = [...html.matchAll(/<form\b[^>]*>/gi)].map((match) => {
    const action = attr(match[0], "action");
    const resolved = action ? absolute(action, base) : finalUrl;
    return {
      action: action ?? null,
      method: (attr(match[0], "method") ?? "get").toLowerCase(),
      secure: resolved.startsWith("https://"),
    };
  });

  let internal = 0;
  let external = 0;
  let empty = 0;
  const contactRoutes = { tel: 0, mailto: 0, whatsapp: 0, contactPageLinked: false };
  for (const tag of tags(html, "a")) {
    const href = attr(tag, "href");
    if (!href || href === "#" || href.startsWith("javascript:")) {
      empty += 1;
      continue;
    }
    if (/^tel:/i.test(href)) {
      contactRoutes.tel += 1;
      continue;
    }
    if (/^mailto:/i.test(href)) {
      contactRoutes.mailto += 1;
      continue;
    }
    if (/^(sms|whatsapp):/i.test(href) || /(wa\.me|api\.whatsapp\.com)/i.test(href)) {
      contactRoutes.whatsapp += 1;
      continue;
    }
    if (/\/(contact|contact-us|get-in-touch|enquir)/i.test(href)) contactRoutes.contactPageLinked = true;
    if (sameOrigin(href, base)) internal += 1;
    else external += 1;
  }

  const headings: HeadingRow[] = [];
  for (const match of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = visibleText(match[2]);
    if (text) headings.push({ level: Number(match[1]), text: text.slice(0, 180) });
  }

  const text = visibleText(html);

  const thirdParty = new Set<string>();
  for (const resource of [...scripts, ...stylesheets]) {
    if (!resource.external) continue;
    try {
      thirdParty.add(new URL(resource.url).hostname);
    } catch {
      /* an address we cannot parse is not a host we can name */
    }
  }
  for (const image of images) {
    if (!image.external || !image.url) continue;
    try {
      thirdParty.add(new URL(image.url).hostname);
    } catch {
      /* as above */
    }
  }

  const contentLength = Number(headers.get("content-length"));

  return {
    responseMs,
    htmlBytes: Buffer.byteLength(html, "utf8"),
    htmlTruncated: truncated,
    contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
    contentEncoding: headers.get("content-encoding"),
    cacheControl: headers.get("cache-control"),
    scripts,
    stylesheets,
    inlineStyleBytes,
    inlineScriptBytes,
    images,
    iframes,
    forms,
    links: { internal, external, empty },
    contactRoutes,
    headings,
    h1Count: headings.filter((heading) => heading.level === 1).length,
    text,
    wordCount: text ? text.split(/\s+/).length : 0,
    thirdPartyHosts: [...thirdParty].sort(),
  };
}

function readSeo(html: string, finalUrl: string): SeoTags {
  const base = new URL(finalUrl);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? visibleText(titleMatch[1]) : null;
  const description = metaByName(html, "description");

  let canonical: string | null = null;
  let favicon: string | null = null;
  for (const tag of tags(html, "link")) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    const href = attr(tag, "href");
    if (!href) continue;
    if (rel === "canonical" && !canonical) canonical = absolute(href, base);
    if (rel.includes("icon") && !favicon) favicon = absolute(href, base);
  }

  const structuredData: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const walk = (node: unknown) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        const type = (node as { "@type"?: unknown })["@type"];
        if (typeof type === "string") structuredData.push(type);
        else if (Array.isArray(type)) type.forEach((entry) => typeof entry === "string" && structuredData.push(entry));
        const graph = (node as { "@graph"?: unknown })["@graph"];
        if (graph) walk(graph);
      };
      walk(parsed);
    } catch {
      // Broken JSON-LD is itself worth knowing, but it is the reviewer's point
      // to make from `structuredData` being empty — not a crash here.
    }
  }

  const charsetTag = tags(html, "meta").find((tag) => attr(tag, "charset"));

  return {
    title,
    titleLength: title?.length ?? 0,
    description,
    descriptionLength: description?.length ?? 0,
    canonical,
    robots: metaByName(html, "robots"),
    viewport: metaByName(html, "viewport"),
    lang: attr(/<html\b[^>]*>/i.exec(html)?.[0] ?? "", "lang"),
    charset: charsetTag ? attr(charsetTag, "charset") : null,
    favicon,
    ogTitle: metaByName(html, "og:title"),
    ogDescription: metaByName(html, "og:description"),
    ogImage: metaByName(html, "og:image"),
    twitterCard: metaByName(html, "twitter:card"),
    structuredData: [...new Set(structuredData)],
  };
}

function readSecurity(html: string, headers: Headers, finalUrl: string, certificate: CertificateState | null): SecurityEvidence {
  const https = finalUrl.startsWith("https://");

  const cookies: SecurityEvidence["cookies"] = [];
  // `getSetCookie` is the only way to read more than one; older runtimes fold
  // them into a single comma-joined string, which cannot be split safely
  // because an Expires date contains a comma.
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const line of raw) {
    const name = line.split("=")[0]?.trim();
    if (!name) continue;
    const sameSite = /;\s*samesite\s*=\s*([^;]+)/i.exec(line);
    cookies.push({
      name,
      secure: /;\s*secure\b/i.test(line),
      httpOnly: /;\s*httponly\b/i.test(line),
      sameSite: sameSite ? sameSite[1].trim() : null,
    });
  }

  const mixedContent: string[] = [];
  if (https) {
    for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["'](http:\/\/[^"']+)["']/gi)) {
      // A link to an http page is a link, not mixed content. Only things the
      // browser has to *load* into the page trigger the warning.
      if (mixedContent.length < 12) mixedContent.push(match[1]);
    }
  }

  const adminLinks = new Set<string>();
  for (const tag of tags(html, "a")) {
    const href = attr(tag, "href");
    if (href && ADMIN_PATHS.test(href)) adminLinks.add(href);
  }

  return {
    https,
    certificate,
    redirectsToHttps: null,
    httpNote: null,
    headers: {
      strictTransportSecurity: headers.get("strict-transport-security"),
      contentSecurityPolicy: headers.get("content-security-policy"),
      xFrameOptions: headers.get("x-frame-options"),
      xContentTypeOptions: headers.get("x-content-type-options"),
      referrerPolicy: headers.get("referrer-policy"),
      permissionsPolicy: headers.get("permissions-policy"),
    },
    serverBanner: headers.get("server"),
    poweredBy: headers.get("x-powered-by"),
    generator: metaByName(html, "generator"),
    cookies,
    mixedContent: [...new Set(mixedContent)],
    exposedAdminLinks: [...adminLinks].slice(0, 6),
  };
}

// --- The small extra requests -----------------------------------------------

async function getText(url: string, maxBytes = 200_000): Promise<{ status: number; body: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMALL_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { "user-agent": CRAWLER_UA }, signal: controller.signal, redirect: "follow" });
    const body = (await response.text()).slice(0, maxBytes);
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readRobots(finalUrl: string): Promise<RobotsEvidence> {
  const base = new URL(finalUrl);
  const robotsUrl = new URL("/robots.txt", base).toString();
  const fetched = await getText(robotsUrl, 40_000);

  if (!fetched || fetched.status >= 400) {
    // No robots.txt is not itself a fault — the default is "crawl everything",
    // which is what most small sites want. It matters only because it is where
    // a sitemap is usually declared.
    const sitemapUrl = new URL("/sitemap.xml", base).toString();
    const sitemap = await getText(sitemapUrl);
    return {
      robotsTxt: { found: false, disallowsEverything: false, sitemapUrls: [] },
      sitemap: sitemap && sitemap.status < 400 && sitemap.body.includes("<urlset") ? { url: sitemapUrl, found: true, urlCount: countLocs(sitemap.body) } : { url: sitemapUrl, found: false, urlCount: null },
    };
  }

  const lines = fetched.body.split(/\r?\n/).map((line) => line.trim());
  const sitemapUrls = lines
    .filter((line) => /^sitemap\s*:/i.test(line))
    .map((line) => line.split(/:(.+)/)[1]?.trim())
    .filter((value): value is string => Boolean(value));

  // "Disallow: /" under a wildcard user-agent, with no Allow rescuing it, is
  // the one line in this file that can take an entire business out of Google.
  let inWildcard = false;
  let blocked = false;
  for (const line of lines) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(key?.trim() ?? "")) inWildcard = value === "*";
    else if (inWildcard && /^disallow$/i.test(key?.trim() ?? "") && value === "/") blocked = true;
    else if (inWildcard && /^allow$/i.test(key?.trim() ?? "") && value === "/") blocked = false;
  }

  const sitemapUrl = sitemapUrls[0] ?? new URL("/sitemap.xml", base).toString();
  const sitemap = await getText(sitemapUrl);
  return {
    robotsTxt: { found: true, disallowsEverything: blocked, sitemapUrls },
    sitemap:
      sitemap && sitemap.status < 400 && /<urlset|<sitemapindex/i.test(sitemap.body)
        ? { url: sitemapUrl, found: true, urlCount: countLocs(sitemap.body) }
        : { url: sitemapUrl, found: false, urlCount: null },
  };
}

function countLocs(xml: string): number | null {
  const matches = xml.match(/<loc>/gi);
  return matches ? matches.length : null;
}

/**
 * Whether a plain http request ends up on https.
 *
 * Worth its own request because "the site has a certificate" and "the site
 * uses it" are different facts. Plenty of small sites answer on both, and
 * every customer who types the address without the s is then on the unencrypted
 * one — with a browser warning next to their business name.
 */
async function checkHttpUpgrade(finalUrl: string): Promise<{ redirects: boolean | null; note: string | null }> {
  const base = new URL(finalUrl);
  if (base.protocol !== "https:") return { redirects: null, note: null };
  const plain = `http://${base.host}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMALL_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(plain, { headers: { "user-agent": CRAWLER_UA }, redirect: "follow", signal: controller.signal });
    return { redirects: response.url.startsWith("https://"), note: null };
  } catch (err) {
    // A failed question is not an answer — the rule this codebase learned the
    // hard way. Not reaching http tells us nothing about whether it upgrades.
    return { redirects: null, note: `Whether ${plain} redirects to https could not be checked: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

// --- The one entry point ----------------------------------------------------

export interface GatherOptions {
  /** Skip the pictures — for a re-run where the site has not changed. */
  skipScreenshots?: boolean;
  /**
   * Skip renting a browser. It is the one paid step here billed per page
   * rather than per picture, so a dry run or a re-render should not repeat it.
   */
  skipRendered?: boolean;
  /** A desktop picture already taken for this address, from a batched run. */
  desktopShot?: ShotResult | null;
}

export async function gatherEvidence(website: string, options: GatherOptions = {}): Promise<AuditEvidence> {
  const notes: string[] = [];
  let costUsd = 0;

  const normalised = normaliseSiteUrl(website);
  if (!normalised) {
    return {
      requested: website,
      finalUrl: null,
      status: null,
      reachable: false,
      fetch: { page: null, usedUrl: null, attempts: [], domainDoesNotResolve: false, inconclusive: true, certificate: null, otherHost: null },
      page: null,
      seo: null,
      security: null,
      robots: { robotsTxt: null, sitemap: null },
      shots: [],
      rendered: null,
      notes: [`"${website}" is not a web address this could open, so nothing was checked.`],
      stepNotes: { screenshots: [], rendered: [] },
      costUsd: 0,
    };
  }

  const site = await fetchSite(normalised);
  const page = site.page;

  // Said once, here, so it reaches every section rather than only the security
  // one. The page was readable; what was not verifiable is who served it.
  if (site.certificate) {
    notes.push(
      `${site.certificate.summary} The page was still read — the same way a visitor gets in, by clicking past the browser's warning — so everything below is what is actually on it. Nothing verified who served it.`,
    );
  }

  if (!page) {
    notes.push(
      site.domainDoesNotResolve
        ? `No DNS record exists for ${normalised} or its www/apex counterpart, so there was nothing to audit.`
        : `${normalised} could not be retrieved, so only what is checkable without the page was examined. ${site.attempts.map((attempt) => `${attempt.url}: ${attempt.detail}`).join("; ")}`,
    );
    return {
      requested: website,
      finalUrl: null,
      status: null,
      reachable: false,
      fetch: site,
      page: null,
      seo: null,
      security: null,
      robots: { robotsTxt: null, sitemap: null },
      shots: [],
      rendered: null,
      notes,
      stepNotes: { screenshots: [], rendered: [] },
      costUsd: 0,
    };
  }

  const truncated = page.html.length >= 600_000;
  if (truncated) {
    notes.push("Their homepage is larger than the amount this reads, so the page-weight numbers are a floor rather than a total.");
  }

  const measurements = measurePage(page.html, page.headers, page.finalUrl, page.responseMs, truncated);
  const seo = readSeo(page.html, page.finalUrl);
  const security = readSecurity(page.html, page.headers, page.finalUrl, site.certificate);

  // The three small extra questions, together, because they are independent
  // and each one is a round trip.
  const [robots, upgrade] = await Promise.all([
    readRobots(page.finalUrl).catch(() => ({ robotsTxt: null, sitemap: null }) as RobotsEvidence),
    checkHttpUpgrade(page.finalUrl),
  ]);
  security.redirectsToHttps = upgrade.redirects;
  security.httpNote = upgrade.note;
  if (upgrade.note) notes.push(upgrade.note);

  // A real browser, for the things a fetch cannot see: how long until
  // something appears, how much the page moves while it settles, and whether
  // the links on it actually go anywhere. Started before the pictures and
  // waited for after them, so the two paid steps overlap rather than queue.
  const renderedRun = options.skipRendered ? null : runSeoAudit(page.finalUrl);

  // The pictures. Two viewports, because a site that lays out correctly at
  // 1280 and spills off the screen at 390 passes every check except the one
  // that matches where their customers actually are.
  const shots: AuditEvidence["shots"] = [];
  // Kept as well as pushed into `notes`, so a partial re-run can tell which of
  // an earlier run's notes it has actually replaced. See `stepNotes`.
  const stepNotes: AuditEvidence["stepNotes"] = { screenshots: [], rendered: [] };
  const shotNote = (note: string) => {
    stepNotes.screenshots.push(note);
    notes.push(note);
  };
  if (!options.skipScreenshots) {
    const desktop = options.desktopShot ?? (await captureHomepage(page.finalUrl));
    if (desktop.shot) {
      shots.push({ view: "desktop", result: desktop });
      costUsd += desktop.shot.costUsd ?? 0;
    }
    if (desktop.note) shotNote(desktop.note);

    // Only worth a second Apify run when the first one worked. If a site blocks
    // headless browsers it blocks both, and a second run is a second bill for
    // the same refusal.
    if (desktop.shot) {
      const mobile = await captureHomepage(page.finalUrl, { viewportWidth: PHONE_VIEWPORT_WIDTH, keepRows: 3200 });
      if (mobile.shot) {
        shots.push({ view: "mobile", result: mobile });
        costUsd += mobile.shot.costUsd ?? 0;
      }
      if (mobile.note) shotNote(`Phone view: ${mobile.note}`);
    }
  }

  if (!shots.length && !options.skipScreenshots) {
    shotNote(
      "Nobody has seen how the site actually looks — only what it is made of. The design, the layout and the first impression are the half a business owner cares about, and none of it could be checked.",
    );
  }

  let rendered: RenderedMeasurements | null = null;
  if (renderedRun) {
    const result = await renderedRun.catch((err: unknown) => ({ measured: null, costUsd: null, note: `The page could not be opened in a real browser: ${(err as Error).message}`, actorId: "" }));
    rendered = result.measured;
    if (result.note) {
      stepNotes.rendered.push(result.note);
      notes.push(result.note);
    }
    costUsd += result.costUsd ?? 0;
  }

  return {
    requested: website,
    finalUrl: page.finalUrl,
    status: page.status,
    reachable: true,
    fetch: site,
    page: measurements,
    seo,
    security,
    robots,
    shots,
    rendered,
    notes,
    stepNotes,
    costUsd,
  };
}
