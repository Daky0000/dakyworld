/**
 * WordPress sites: connecting one, finding its pages, and publishing into it.
 *
 * A WordPress site is edited through WordPress's own REST API, signed in with
 * an Application Password the site's owner made for us under Users → Profile.
 * Nothing is installed on their site and nothing is hosted here: the editor
 * shows the live page, and a publish writes the changed words back into the
 * WordPress page they came from (see `website/wordpress.ts` for how a field is
 * traced there, and when it is refused).
 *
 * Three rules this module keeps, each of which is the difference between a
 * password that stays where it was given and one that does not:
 *
 * - **The password goes to one origin.** Every authenticated call is made to
 *   the API root found when the site was connected, never follows a redirect,
 *   and never falls back from HTTPS to HTTP. A redirect is reported as the
 *   address to reconnect with.
 * - **It is stored encrypted and never returned.** Routes say who we are signed
 *   in as and when it last worked; the password itself does not leave here.
 * - **A refusal from WordPress is a setting, and says which.** Wrong password,
 *   Application Passwords switched off by a security plugin, a host stripping
 *   the Authorization header, a firewall in front of the REST API: each has a
 *   different fix, and "could not connect" sends somebody looking for none.
 */
import type { Request, Response, Router } from "express";
import { Prisma, type Site, type SitePage, type WordPressConnection } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { decryptSecret, encryptSecret } from "../lib/secrets.js";
import { isTlsOrConnectionError, requestWebsite, type WebsiteResponse } from "../lib/websiteFetch.js";
import { downloadFromR2 } from "../lib/r2.js";
import { invalidateSource } from "./website/sourceCache.js";
import { WebsiteError, pageSource, pageUrl, type DiscoveredPage, type Discovery } from "./website/site.js";
import {
  applyWordPressEdits,
  buildPublishPlan,
  builderEditable,
  categoriseChanges,
  describeChanges,
  detectWordPressBuilder,
  discoverFields,
  editingSource,
  versionValues,
  wordpressFieldMap,
  WORDPRESS_BUILDER_LABEL,
  type FieldValue,
  type WordPressBuilder,
  type WordPressFieldMap,
  type WordPressMedia,
  type WordPressSource,
} from "./website/index.js";
import type { WebsiteActor } from "./websiteActor.js";
import { advancePublishJob, failPublishJob, publishJobView, sourcePublishCommitted, startPublishJob } from "./websitePublishJobs.js";
import { commitPublication } from "./websitePublishing.js";
import { beforeWebsiteExternalAction } from "../lib/websiteWorkContext.js";

/** What `Site.sourceKind` says for a WordPress site. */
export const WORDPRESS_SOURCE_KIND = "wordpress";

export function isWordPressSite(site: Pick<Site, "sourceKind">): boolean {
  return site.sourceKind === WORDPRESS_SOURCE_KIND;
}

/**
 * The network, replaceable. Production is `requestWebsite` — DNS-pinned, public
 * addresses only, no redirects followed. `checks/websiteWordPress.ts` swaps in
 * a request to a local stub WordPress, because rule 1 of `checks/` is no
 * network and a real WordPress is the network.
 */
export const wordpressTransport: { request: typeof requestWebsite } = { request: requestWebsite };

// ---------------------------------------------------------------- addresses

/** A page row's `filePath` for a WordPress post: `wordpress/pages/42`. */
export function wordpressFilePath(type: "page" | "post", id: number): string {
  return `wordpress/${type === "page" ? "pages" : "posts"}/${id}`;
}

export function wordpressPostOf(page: Pick<SitePage, "filePath">): { type: "page" | "post"; id: number } | null {
  const match = /^wordpress\/(pages|posts)\/(\d{1,12})$/.exec(page.filePath);
  return match ? { type: match[1] === "pages" ? "page" : "post", id: Number(match[2]) } : null;
}

/**
 * A REST route on a site, for both shapes an API root comes in: `…/wp-json`
 * with pretty permalinks, and `…/?rest_route=` without them.
 */
export function wordpressEndpoint(apiRoot: string, route: string, query: Record<string, string | number> = {}): string {
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const qs = params.toString();
  if (apiRoot.includes("rest_route=")) return `${apiRoot}${route}${qs ? `&${qs}` : ""}`;
  return `${apiRoot.replace(/\/+$/, "")}${route}${qs ? `?${qs}` : ""}`;
}

/** `example.com` → `https://example.com`; anything with a path keeps it. */
export function normaliseWordPressAddress(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.username || url.password) throw new WebsiteError(400, "Enter the website's address without a username or password in it.");
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/+$/, "");
}

// ---------------------------------------------------------------- the client

export type WordPressCredentials = { apiRoot: string; username: string; password: string };

type CallOptions = {
  method?: string;
  query?: Record<string, string | number>;
  json?: unknown;
  body?: Buffer;
  headers?: Record<string, string>;
};

type WordPressAnswer<T> = { data: T; headers: Record<string, string> };

/**
 * Raised for any answer from WordPress that is not the one asked for.
 *
 * Never a 401 to our own caller, whatever WordPress said: the app reads a 401
 * from its API as "your session has ended" and signs the person out, so a
 * mistyped WordPress password would have logged them out of DakyX. WordPress
 * refusing a password is 422 here — a value that did not work.
 */
export class WordPressRefusal extends WebsiteError {
  constructor(status: number, message: string, readonly code: string | null, readonly signedOut = false) {
    super(status === 401 ? 422 : status, message);
  }
}

function authorization(credentials: WordPressCredentials): string {
  // WordPress shows the password in groups of four; the spaces are cosmetic
  // and it accepts it either way, but a pasted one with a newline is not.
  const password = credentials.password.replace(/\s+/g, "");
  return `Basic ${Buffer.from(`${credentials.username}:${password}`, "utf8").toString("base64")}`;
}

async function call<T>(credentials: WordPressCredentials, route: string, options: CallOptions = {}): Promise<WordPressAnswer<T>> {
  const address = wordpressEndpoint(credentials.apiRoot, route, options.query);
  if (!address.startsWith("https://") && !allowsPlainHttp()) {
    throw new WordPressRefusal(400, "This WordPress site's address is not HTTPS, and an Application Password is only ever sent over HTTPS. Turn on HTTPS for the site, then connect it with its https:// address.", "not_https");
  }
  let response: WebsiteResponse;
  try {
    response = await wordpressTransport.request(address, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: authorization(credentials),
        ...(options.json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
    });
  } catch (error) {
    throw new WordPressRefusal(502, `Could not reach the WordPress site: ${error instanceof Error ? error.message : "no answer"}.`, "unreachable");
  }
  return read<T>(response, credentials);
}

/** Only a local development server may be spoken to without TLS. */
function allowsPlainHttp(): boolean {
  return process.env.NODE_ENV === "development" && process.env.DEV_NO_AUTH === "true";
}

function read<T>(response: WebsiteResponse, credentials: WordPressCredentials): WordPressAnswer<T> {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.location ?? "another address";
    let where = location;
    try { where = new URL(location, credentials.apiRoot).origin; } catch { /* keep what it said */ }
    throw new WordPressRefusal(409, `WordPress answered from ${where} instead. Reconnect the site using that address — the password is only sent to the address it was connected with.`, "redirected");
  }
  let body: unknown = null;
  try { body = response.text ? JSON.parse(response.text) : null; } catch { body = null; }
  if (response.status >= 200 && response.status < 300) {
    if (body === null) throw new WordPressRefusal(502, notWordPress(response), "not_json");
    return { data: body as T, headers: response.headers };
  }
  const code = body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : null;
  const said = body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message.replace(/<[^>]*>/g, "").trim() : "";
  throw refusal(response.status, code, said, credentials, response);
}

function notWordPress(response: WebsiteResponse): string {
  return response.status === 403 || /cloudflare|sucuri|wordfence|captcha|access denied/i.test(response.text.slice(0, 4000))
    ? "A firewall or security service in front of the site blocked the request before it reached WordPress (Cloudflare, Sucuri and Wordfence are the usual ones). Allow requests to /wp-json/ from DakyXTech, or ask your host."
    : "The site did not answer like WordPress. Check the address, and that the WordPress REST API is not switched off by a plugin.";
}

/** What WordPress refused, said to the person who can fix it. */
function refusal(status: number, code: string | null, said: string, credentials: WordPressCredentials, response: WebsiteResponse): WordPressRefusal {
  const user = credentials.username;
  switch (code) {
    case "incorrect_password":
      return new WordPressRefusal(401, `WordPress did not accept that Application Password for ${user}. Create a new one under Users → Profile → Application Passwords and paste it here — it is the 24-letter code WordPress shows once, not your login password.`, code, true);
    case "invalid_username":
    case "invalid_email":
      return new WordPressRefusal(401, `This WordPress site has no user called “${user}”. Use the username you sign in to WordPress with (shown under Users → Profile).`, code, true);
    case "application_passwords_disabled":
    case "application_passwords_disabled_for_user":
      return new WordPressRefusal(403, "Application Passwords are switched off on this site — usually by a security plugin (Wordfence, Solid Security, All-In-One Security). Turn them back on in that plugin's settings, then connect again.", code, true);
    case "rest_not_logged_in":
    case "rest_forbidden_context":
      return new WordPressRefusal(401, "WordPress did not receive the password: your web host removed it before WordPress saw it. This is a known setting on some Apache hosts. Ask your host to pass the Authorization header through to PHP, or add this line to the site's .htaccess: SetEnvIf Authorization \"(.*)\" HTTP_AUTHORIZATION=$1", code, true);
    case "rest_cannot_edit":
    case "rest_cannot_update":
    case "rest_forbidden":
    case "rest_cannot_create":
      return new WordPressRefusal(403, `The WordPress user ${user} is not allowed to do this${said ? ` (WordPress said: “${said}”)` : ""}. Connect with an Administrator or Editor account.`, code);
    case "rest_no_route":
      return new WordPressRefusal(404, "This WordPress site's REST API does not offer that. A plugin may have switched part of it off.", code);
    case "rest_post_invalid_id":
      return new WordPressRefusal(404, "That page no longer exists in WordPress. Look for pages again to bring the list up to date.", code);
    case "rest_disabled":
    case "rest_api_disabled":
      return new WordPressRefusal(403, "The WordPress REST API is switched off on this site by a plugin. Turn it back on for signed-in users, then connect again.", code);
    default:
      if (code === null) return new WordPressRefusal(status === 401 ? 401 : 502, notWordPress(response), null, status === 401);
      return new WordPressRefusal(status >= 500 ? 502 : status, `WordPress refused the request${said ? `: “${said}”` : ` (${status})`}.`, code);
  }
}

// ---------------------------------------------------------------- connecting

/** What a connection check found, kept on the connection and shown on screen. */
export type WordPressDetails = {
  siteName: string;
  siteUrl: string;
  apiRoot: string;
  version: string | null;
  user: { id: number; name: string; roles: string[] };
  canEditPages: boolean;
  canPublishPages: boolean;
  canUploadFiles: boolean;
  pageCount: number | null;
  /** Page builders the site has, where WordPress would say. */
  builders: string[];
  /** Said on screen before anybody tries to edit: what will and will not work. */
  warnings: string[];
};

type RootIndex = { name?: string; url?: string; home?: string; namespaces?: string[]; authentication?: Record<string, unknown> };

/**
 * Where a site's REST API answers, read from the site itself.
 *
 * WordPress advertises it on every page, as a `Link` header and a `<link>` tag
 * with `rel="https://api.w.org/"` — which is also how a site without pretty
 * permalinks says `?rest_route=`. Redirects are followed here, and only here,
 * because nothing secret is sent: this is how `example.com` becomes
 * `https://www.example.com` before a password is ever involved.
 */
async function discoverApiRoot(address: string): Promise<{ apiRoot: string; homeHtml: string; finalUrl: string }> {
  let url = address;
  for (let hop = 0; hop <= 5; hop += 1) {
    let response: WebsiteResponse;
    try {
      response = await wordpressTransport.request(url, { headers: { Accept: "text/html" }, maxBytes: 3 * 1024 * 1024 });
    } catch (error) {
      const host = new URL(url).host;
      if (url.startsWith("https://") && isTlsOrConnectionError(error) && !/ENOTFOUND|EAI_AGAIN|resolve/i.test(String((error as Error)?.message))) {
        throw new WebsiteError(502, `${host} did not answer securely over HTTPS. An Application Password is only ever sent over HTTPS, so the site needs a working certificate first — most hosts switch one on for free from their control panel. If the site is reachable at another address (with or without www.), connect that one.`);
      }
      throw new WebsiteError(502, `Could not reach ${host}: ${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "no answer"}. Check the address.`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      url = new URL(response.headers.location, url).href;
      continue;
    }
    if (response.status >= 400) throw new WebsiteError(502, `${new URL(url).host} answered ${response.status}. Check the address, and that the site is online.`);
    const fromHeader = /<([^>]+)>;\s*rel="https:\/\/api\.w\.org\/"/.exec(response.headers.link ?? "")?.[1];
    const fromTag = /<link[^>]+rel=["']https:\/\/api\.w\.org\/["'][^>]*>/i.exec(response.text)?.[0];
    const tagHref = fromTag ? /href=["']([^"']+)["']/i.exec(fromTag)?.[1] : undefined;
    const found = fromHeader ?? (tagHref ? tagHref.replace(/&amp;/g, "&") : undefined);
    const apiRoot = found ? new URL(found, url).href : `${new URL(url).origin}/wp-json/`;
    return { apiRoot: apiRoot.replace(/\/+$/, "").replace(/\?rest_route=\/?$/, "?rest_route="), homeHtml: response.text, finalUrl: url };
  }
  throw new WebsiteError(502, "The website redirected too many times. Check the address.");
}

/** Plugin and theme folders that mean a page builder is installed. */
const BUILDER_PLUGINS: Array<[RegExp, WordPressBuilder]> = [
  [/^elementor(-pro)?\//, "elementor"],
  [/^(beaver-builder-lite-version|bb-plugin)\//, "beaver"],
  [/^oxygen\//, "oxygen"],
  [/^brizy(-pro)?\//, "brizy"],
  [/^thrive-visual-editor\//, "thrive"],
  [/^siteorigin-panels\//, "siteorigin"],
  [/^js_composer\//, "wpbakery"],
  [/^fusion-builder\//, "avada"],
  [/^divi-builder\//, "divi"],
];
const BUILDER_THEMES: Array<[RegExp, WordPressBuilder]> = [[/^divi$/i, "divi"], [/^bricks$/i, "bricks"], [/^avada$/i, "avada"]];

/**
 * Checks a site, an account and a password together, and says what it found.
 *
 * Writes nothing. It is what the connect screen calls on "Check connection",
 * and what connecting calls again before saving, so a password is never stored
 * that has not just worked.
 */
export async function checkWordPress(input: { address: string; username: string; password: string }): Promise<WordPressDetails> {
  const address = normaliseWordPressAddress(input.address);
  const { apiRoot, homeHtml, finalUrl } = await discoverApiRoot(address);
  if (!apiRoot.startsWith("https://") && !allowsPlainHttp()) {
    throw new WebsiteError(400, `${new URL(finalUrl).host} is not served over HTTPS, and an Application Password is only ever sent over HTTPS. Turn on HTTPS for the site (most hosts offer a free certificate), then connect again.`);
  }
  const credentials: WordPressCredentials = { apiRoot, username: input.username.trim(), password: input.password };

  // The index is public. If it is not WordPress, say so before a password is sent.
  let index: RootIndex;
  try {
    const response = await wordpressTransport.request(wordpressEndpoint(apiRoot, "/"), { headers: { Accept: "application/json" } });
    index = read<RootIndex>(response, credentials).data;
  } catch (error) {
    if (error instanceof WordPressRefusal && error.code === "redirected") throw error;
    throw new WebsiteError(422, `${new URL(finalUrl).host} does not look like a WordPress site, or its REST API is switched off. ${error instanceof Error ? error.message : ""}`.trim());
  }
  if (!Array.isArray(index.namespaces) || !index.namespaces.includes("wp/v2")) {
    throw new WebsiteError(422, "This site's REST API does not offer WordPress's own routes (wp/v2). A plugin may have restricted it.");
  }
  if (index.authentication && !("application-passwords" in index.authentication)) {
    throw new WebsiteError(403, "This site does not offer Application Passwords. They need WordPress 5.6 or later, and some security plugins switch them off — check the plugin's settings, then connect again.");
  }

  const me = (await call<{ id: number; name: string; roles?: string[]; capabilities?: Record<string, boolean> }>(credentials, "/wp/v2/users/me", { query: { context: "edit" } })).data;
  const capabilities = me.capabilities ?? {};
  const canEditPages = Boolean(capabilities.edit_pages && capabilities.edit_published_pages !== false);
  if (!canEditPages) {
    throw new WebsiteError(403, `${me.name} can sign in, but WordPress does not let them edit pages. Use an account with the Administrator or Editor role.`);
  }

  let pageCount: number | null = null;
  try {
    const pages = await call<unknown[]>(credentials, "/wp/v2/pages", { query: { context: "edit", per_page: 1, status: "publish", _fields: "id" } });
    pageCount = Number(pages.headers["x-wp-total"] ?? "") || (Array.isArray(pages.data) ? pages.data.length : null);
  } catch { /* the count is a nicety; editing does not depend on it */ }

  const builders = new Set<WordPressBuilder>();
  for (const namespace of index.namespaces) if (/^elementor\//.test(namespace)) builders.add("elementor");
  try {
    const plugins = (await call<Array<{ plugin: string }>>(credentials, "/wp/v2/plugins", { query: { status: "active", _fields: "plugin" } })).data;
    for (const plugin of plugins) for (const [pattern, builder] of BUILDER_PLUGINS) if (pattern.test(plugin.plugin)) builders.add(builder);
  } catch { /* only an administrator may list plugins; an editor is fine */ }
  try {
    const themes = (await call<Array<{ stylesheet: string; template?: string }>>(credentials, "/wp/v2/themes", { query: { status: "active", _fields: "stylesheet,template" } })).data;
    for (const theme of themes) for (const [pattern, builder] of BUILDER_THEMES) if (pattern.test(theme.template ?? theme.stylesheet)) builders.add(builder);
  } catch { /* same */ }

  const warnings: string[] = [];
  const elsewhere = [...builders].filter((builder) => !builderEditable(builder)).map((builder) => WORDPRESS_BUILDER_LABEL[builder]);
  if (elsewhere.length) {
    warnings.push(`${elsewhere.join(" and ")} ${elsewhere.length === 1 ? "is" : "are"} installed. Pages built with ${elsewhere.length === 1 ? "it" : "them"} keep their words in the builder's own data, which WordPress does not let other apps edit yet, so those pages open read-only here. Pages made with the block editor, the classic editor, Divi, WPBakery or Avada can be edited.`);
  }
  if (!capabilities.upload_files) warnings.push(`${me.name} cannot upload files in WordPress, so pictures cannot be changed from here.`);
  if (!capabilities.edit_others_pages) warnings.push(`${me.name} can only edit pages they wrote themselves. An Editor or Administrator account can edit every page.`);

  const version = /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress ([0-9.]+)/i.exec(homeHtml)?.[1] ?? null;
  return {
    siteName: (index.name ?? "").trim() || new URL(finalUrl).host,
    siteUrl: (index.home ?? index.url ?? finalUrl).replace(/\/+$/, ""),
    apiRoot,
    version,
    user: { id: me.id, name: me.name, roles: me.roles ?? [] },
    canEditPages,
    canPublishPages: Boolean(capabilities.publish_pages),
    canUploadFiles: Boolean(capabilities.upload_files),
    pageCount,
    builders: [...builders].map((builder) => WORDPRESS_BUILDER_LABEL[builder]),
    warnings,
  };
}

export const wordpressConnectInput = z.object({
  address: z.string().trim().min(3).max(2000),
  username: z.string().trim().min(1).max(200),
  // 24 letters and digits in groups of four, as WordPress shows it. Bounded,
  // not pattern-checked: a plugin may issue its own format.
  password: z.string().min(8).max(200),
});

/** The connection's password, readable — or the sentence saying it is not. */
function credentialsOf(connection: WordPressConnection): WordPressCredentials {
  const password = decryptSecret(connection.applicationPassword);
  if (!password) throw new WebsiteError(409, "The saved WordPress password can no longer be read. Reconnect the site under Website settings → WordPress.");
  return { apiRoot: connection.apiRoot, username: connection.username, password };
}

export async function wordpressConnection(siteId: string): Promise<WordPressConnection> {
  const connection = await prisma.wordPressConnection.findUnique({ where: { siteId } });
  if (!connection) throw new WebsiteError(409, "This website is not connected to WordPress. Connect it under Website settings → WordPress.");
  return connection;
}

/** A call made for a saved connection: a password WordPress has stopped taking pauses it, with the reason. */
async function connectedCall<T>(connection: WordPressConnection, route: string, options: CallOptions = {}): Promise<WordPressAnswer<T>> {
  try {
    const answer = await call<T>(credentialsOf(connection), route, options);
    if (connection.pausedAt) await prisma.wordPressConnection.update({ where: { id: connection.id }, data: { pausedAt: null, pausedReason: null } }).catch(() => undefined);
    return answer;
  } catch (error) {
    if (error instanceof WordPressRefusal && error.signedOut) {
      await prisma.wordPressConnection.update({ where: { id: connection.id }, data: { pausedAt: new Date(), pausedReason: error.message.slice(0, 500) } }).catch(() => undefined);
    }
    throw error;
  }
}

/** What a route may say about a connection. Never the password. */
export function wordpressConnectionView(connection: WordPressConnection | null) {
  if (!connection) return null;
  return {
    siteUrl: connection.siteUrl,
    apiRoot: connection.apiRoot,
    username: connection.username,
    details: connection.details as WordPressDetails | null,
    verifiedAt: connection.verifiedAt,
    pausedAt: connection.pausedAt,
    pausedReason: connection.pausedReason,
  };
}

// ---------------------------------------------------------------- pages

type RestPost = {
  id: number;
  link: string;
  status: string;
  parent?: number;
  menu_order?: number;
  modified_gmt?: string;
  title: { raw?: string; rendered?: string };
  content?: { raw?: string; rendered?: string };
};

const MAX_PAGES = 1000;

/**
 * The site's published pages, as the scan reconciles them.
 *
 * Published only: the editor works on the page a visitor sees, and a draft has
 * no public address to read. Each page's address is the path of its WordPress
 * permalink, which is unique on a site the way `SitePage.path` must be.
 */
export async function discoverWordPressPages(site: Site): Promise<Discovery> {
  const connection = await wordpressConnection(site.id);
  const pages: DiscoveredPage[] = [];
  const seen = new Set<string>();
  // A page's address is joined to the site's own (`pageUrl`), so a WordPress
  // installed under /blog must not keep /blog in each page's path as well.
  const homePath = new URL(connection.siteUrl).pathname.replace(/\/+$/, "");
  for (let index = 1; index <= MAX_PAGES / 100; index += 1) {
    const answer = await connectedCall<RestPost[]>(connection, "/wp/v2/pages", {
      query: { context: "edit", status: "publish", per_page: 100, page: index, orderby: "menu_order", order: "asc", _fields: "id,link,status,title,parent,menu_order" },
    });
    for (const post of answer.data) {
      let path: string;
      try { path = new URL(post.link).pathname.replace(/\/+$/, "") || "/"; } catch { continue; }
      if (homePath && (path === homePath || path.startsWith(`${homePath}/`))) path = path.slice(homePath.length) || "/";
      if (seen.has(path)) continue;
      seen.add(path);
      const title = decode(post.title.raw ?? post.title.rendered ?? "").trim() || (path === "/" ? "Home" : path);
      pages.push({ filePath: wordpressFilePath("page", post.id), path, title: title.slice(0, 200), listed: true });
    }
    const totalPages = Number(answer.headers["x-wp-totalpages"] ?? "1");
    if (answer.data.length < 100 || index >= totalPages) break;
  }
  // The front page first, then WordPress's own order.
  pages.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : 0));
  return { pages, repoPath: "", sourceKind: WORDPRESS_SOURCE_KIND };
}

function decode(text: string): string {
  return text.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Read for the editor, briefly remembered: opening a page and its preview ask the same question twice. */
const sourceCache = new Map<string, { at: number; source: WordPressSource & { modified: string | null; link: string } }>();
const SOURCE_TTL_MS = 30_000;

/** A page's stored content, read fresh from WordPress unless a recent copy will do. */
export async function wordpressSource(site: Site, page: SitePage, html: string, options: { fresh?: boolean } = {}): Promise<WordPressSource & { modified: string | null; link: string }> {
  const post = wordpressPostOf(page);
  if (!post) throw new WebsiteError(409, `${page.title} is not a WordPress page. Look for pages again to bring the list up to date.`);
  const key = `${site.id}:${page.filePath}`;
  const cached = sourceCache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < SOURCE_TTL_MS) {
    // The builder is read off the live page, so it is re-decided against the
    // page being asked about rather than whatever was live when it was cached.
    return { ...cached.source, builder: detectWordPressBuilder({ postId: post.id, content: cached.source.content, html }) };
  }
  const connection = await wordpressConnection(site.id);
  const data = (await connectedCall<RestPost>(connection, `/wp/v2/${post.type === "page" ? "pages" : "posts"}/${post.id}`, { query: { context: "edit" } })).data;
  const content = data.content?.raw ?? "";
  const source = {
    id: post.id,
    type: post.type,
    content,
    title: data.title.raw ?? "",
    builder: detectWordPressBuilder({ postId: post.id, content, html }),
    modified: data.modified_gmt ?? null,
    link: data.link,
  };
  sourceCache.set(key, { at: Date.now(), source });
  if (sourceCache.size > 500) sourceCache.delete(sourceCache.keys().next().value!);
  return source;
}

function forgetSource(site: Site, page: SitePage) {
  sourceCache.delete(`${site.id}:${page.filePath}`);
}

/**
 * Which fields on a WordPress page a publish can write — the same answer the
 * framework path gives `routes/website.ts`, so the editor locks what a publish
 * would refuse, at the moment somebody clicks it.
 */
export async function wordpressManagedFields(site: Site, page: SitePage, html: string): Promise<WordPressFieldMap & { builder?: WordPressBuilder }> {
  try {
    const source = await wordpressSource(site, page, html);
    return { ...wordpressFieldMap({ html, source }), builder: source.builder };
  } catch (error) {
    const failure = error instanceof WebsiteError ? error.message : "This page's content could not be read from WordPress.";
    return { writable: new Set(), notes: new Map(), failure };
  }
}

// ---------------------------------------------------------------- pictures

/**
 * Every picture the edits point at that is one of this site's uploads, added
 * to the WordPress media library, so the page references a file WordPress has
 * rather than one served from here.
 */
async function uploadPictures(site: Site, connection: WordPressConnection, values: Record<string, FieldValue>): Promise<WordPressMedia> {
  const media: WordPressMedia = new Map();
  for (const edit of Object.values(values)) {
    const value = edit.value;
    if (!value || media.has(value) || value === edit.original) continue;
    const key = /(assets\/dw\/[A-Za-z0-9._-]+)/.exec(value)?.[1];
    if (!key) continue;
    const asset = await prisma.siteAsset.findFirst({ where: { siteId: site.id, repoPath: key }, select: { filename: true, contentType: true, content: true, repoPath: true, alt: true } });
    if (!asset) continue;
    const bytes = asset.content ? Buffer.from(asset.content) : await downloadFromR2(asset.repoPath);
    if (!bytes) throw new WebsiteError(409, `${asset.filename} could not be read to add it to WordPress. Upload it again, then publish.`);
    const filename = asset.filename.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "picture";
    const uploaded = (await connectedCall<{ id: number; source_url: string }>(connection, "/wp/v2/media", {
      method: "POST",
      body: bytes,
      headers: { "Content-Type": asset.contentType, "Content-Disposition": `attachment; filename="${filename}"` },
    })).data;
    if (asset.alt) {
      await connectedCall(connection, `/wp/v2/media/${uploaded.id}`, { method: "POST", json: { alt_text: asset.alt } }).catch(() => undefined);
    }
    media.set(value, { id: uploaded.id, url: uploaded.source_url });
  }
  return media;
}

// ---------------------------------------------------------------- publishing

type WriteResult = { modified: string | null; link: string; changes: Array<{ before: string; after: string }>; changed: string[] };

/**
 * Writes a set of edits into a WordPress page, or refuses all of them.
 *
 * Read fresh, applied, written. WordPress has no "only if unchanged" for a
 * post, so the guard is the one the editor already keeps: every edit carries
 * the words it replaced, and an edit whose words are no longer in the content
 * — somebody changed the page in WordPress since — refuses the whole publish.
 */
async function writeEdits(input: { site: Site; page: SitePage; html: string; values: Record<string, FieldValue> }): Promise<WriteResult> {
  const post = wordpressPostOf(input.page);
  if (!post) throw new WebsiteError(409, `${input.page.title} is not a WordPress page.`);
  const connection = await wordpressConnection(input.site.id);
  const source = await wordpressSource(input.site, input.page, input.html, { fresh: true });
  if (!builderEditable(source.builder)) {
    throw new WebsiteError(409, applyWordPressEdits({ html: input.html, source, values: input.values }).unmappable[0]!.message);
  }
  // A dry run first, so a refusal costs no upload.
  const dry = applyWordPressEdits({ html: input.html, source, values: input.values, media: new Map(Object.values(input.values).filter((edit) => edit.value).map((edit) => [edit.value!, { id: 0, url: "https://upload.invalid/" }])) });
  refuseIfNeeded(dry);
  const media = await uploadPictures(input.site, connection, input.values);
  const applied = applyWordPressEdits({ html: input.html, source, values: input.values, media });
  refuseIfNeeded(applied);
  if (!applied.changed.length) throw new WebsiteError(400, "WordPress already says all of this. Nothing to publish.");
  const body: Record<string, string> = {};
  if (applied.content !== source.content) body.content = applied.content;
  if (applied.title !== source.title) body.title = applied.title;
  await beforeWebsiteExternalAction();
  const written = (await connectedCall<RestPost>(connection, `/wp/v2/${post.type === "page" ? "pages" : "posts"}/${post.id}`, { method: "POST", json: body })).data;
  forgetSource(input.site, input.page);
  // And the live page the editor opens, which now says something else.
  invalidateSource(input.site.id, input.page.filePath);
  return { modified: written.modified_gmt ?? null, link: written.link ?? source.link, changes: applied.changes, changed: applied.changed };
}

function refuseIfNeeded(result: ReturnType<typeof applyWordPressEdits>) {
  if (result.unmappable.length) {
    throw Object.assign(
      new WebsiteError(400, `Some of these changes can only be made in WordPress, so nothing was published: ${[...new Set(result.unmappable.map((entry) => entry.message))].join(" ")}`),
      { unmappable: result.unmappable },
    );
  }
  if (result.problems.length) {
    const stale = result.problems.some((problem) => problem.code === "stale");
    throw Object.assign(
      new WebsiteError(stale ? 409 : 400, `${stale ? "The page has changed in WordPress since these edits were made, so nothing was published. " : ""}${[...new Set(result.problems.map((problem) => problem.message))].join(" ")}`),
      { problems: result.problems },
    );
  }
}

/** A stand-in for a commit id: what WordPress last saved, so two publishes are told apart. */
function revisionId(write: WriteResult): string {
  return `wp-${createHash("sha1").update(`${write.modified ?? Date.now()}:${write.link}`).digest("hex").slice(0, 12)}`;
}

/**
 * Publishing a page of a WordPress site. Called by `publishPageCommand` inside
 * its lock, with the draft it has already checked for a stale revision.
 *
 * The shape of the answer is the shape every publish returns, so the editor's
 * publish dialog needs to know nothing about WordPress except the note.
 */
export async function publishWordPressPage(input: {
  actor: WebsiteActor;
  site: Site;
  page: SitePage;
  values: Record<string, FieldValue>;
  sourceHash?: string;
  preflight: (candidateHtml: string, sourceHtml: string) => Promise<void>;
}) {
  const { actor, site, page, values } = input;
  const job = await startPublishJob({ site, kind: "PAGE", pageId: page.id, startedById: actor.dbUser?.id, detail: { path: page.path, filePath: page.filePath, draftRevision: page.draftRevision, wordpress: true } });
  try {
    const source = await pageSource(site, page, { fresh: true });
    if (input.sourceHash && input.sourceHash !== createHash("sha256").update(source.html).digest("hex")) {
      throw new WebsiteError(409, "The page changed after your review. Review it again before publishing.");
    }
    const plan = buildPublishPlan({ source: source.html, values });
    if (plan.problems.length) throw Object.assign(new WebsiteError(400, "This page cannot be published yet — some fields need attention."), { problems: plan.problems });
    if (plan.conflicts.length || plan.missing.length) {
      throw Object.assign(new WebsiteError(409, "The page has changed since these edits were made, so they have not been published. Reopen the page to see it as it is now."), { conflicts: plan.conflicts, missing: plan.missing });
    }
    if (!plan.html) throw new WebsiteError(400, "The page already says all of this. Nothing to publish.");
    await input.preflight(plan.html, source.html);
    const content = discoverFields(editingSource(source.html, values));
    const summary = describeChanges(content.fields, values);
    await advancePublishJob(job.id, "COMMITTING");
    const write = await writeEdits({ site, page, html: source.html, values });
    const commit = { sha: revisionId(write), url: write.link };
    await sourcePublishCommitted({ id: job.id, commit, site, page, changes: write.changes });
    const author = actor.dbUser?.name ?? "the website editor";
    const { version, cleared } = await commitPublication(async (tx) => {
      const last = await tx.sitePageVersion.findFirst({ where: { pageId: page.id }, orderBy: { number: "desc" }, select: { number: true } });
      const version = await tx.sitePageVersion.create({
        data: {
          pageId: page.id,
          number: (last?.number ?? 0) + 1,
          html: plan.html!,
          values: versionValues(values) as unknown as Prisma.InputJsonValue,
          commitSha: commit.sha,
          commitUrl: commit.url,
          publishedById: actor.dbUser?.id ?? null,
        },
      });
      const cleared = await tx.sitePage.updateMany({
        where: { id: page.id, draftRevision: page.draftRevision },
        data: { draft: Prisma.DbNull, draftSavedAt: null, draftSavedById: null, lastPublishedAt: new Date(), draftRevision: { increment: 1 } },
      });
      if (!cleared.count) await tx.sitePage.update({ where: { id: page.id }, data: { lastPublishedAt: new Date() } });
      await tx.siteAuditEvent.create({ data: { siteId: site.id, kind: "PUBLISH", summary: `Published ${page.title} to WordPress · version ${version.number}`, actorName: author, actorId: actor.dbUser?.id, detail: summary as unknown as Prisma.InputJsonValue } });
      return { version, cleared };
    });
    const finishedJob = publishJobView(await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } }));
    return {
      job: finishedJob,
      draftRetained: cleared.count === 0,
      version: version.number,
      changed: write.changed.length,
      summary,
      touched: categoriseChanges(summary),
      commit: { sha: commit.sha, url: null },
      url: pageUrl(site, page),
      hosted: false,
      mode: "commit" as const,
      note: "Saved in WordPress. The live page usually shows it straight away — if a caching plugin or CDN is in front of the site, it shows once that cache refreshes, and this screen will say when it does.",
    };
  } catch (error) {
    const state = error instanceof WebsiteError && error.status === 409 ? "CONFLICT" : "COMMIT_FAILED";
    await failPublishJob(job.id, state, error instanceof Error ? error.message : "WordPress did not save the change.");
    throw error;
  }
}

/**
 * Putting a WordPress page back to an earlier version: the differences between
 * that version and the live page, written as edits. WordPress also keeps its
 * own revisions of every save, which is the deeper undo and is left to it.
 */
export async function rollbackWordPressPage(input: {
  actor: WebsiteActor;
  site: Site;
  page: SitePage;
  html: string;
  values: Record<string, FieldValue>;
  versionNumber: number;
  versionHtml: string;
  versionValues: Prisma.JsonValue | null;
  expectedRevision: number;
}) {
  const { actor, site, page } = input;
  const job = await startPublishJob({ site, pageId: page.id, kind: "ROLLBACK", startedById: actor.dbUser?.id, detail: { restoredFrom: input.versionNumber, wordpress: true } });
  try {
    await advancePublishJob(job.id, "COMMITTING");
    // The browser title and description follow the page title in WordPress, so
    // a difference in them is a consequence of restoring, not a change to make.
    const values = Object.fromEntries(Object.entries(input.values).filter(([id]) => !id.startsWith("meta.")));
    if (!Object.keys(values).length) throw new WebsiteError(400, `The page already says what version ${input.versionNumber} said. Nothing to publish.`);
    const write = await writeEdits({ site, page, html: input.html, values });
    const commit = { sha: revisionId(write), url: write.link };
    await sourcePublishCommitted({ id: job.id, commit, site, page, changes: write.changes });
    const author = actor.dbUser?.name ?? "the website editor";
    return await commitPublication(async (tx) => {
      const last = await tx.sitePageVersion.findFirst({ where: { pageId: page.id }, orderBy: { number: "desc" }, select: { number: true } });
      const written = await tx.sitePageVersion.create({
        data: {
          pageId: page.id,
          number: (last?.number ?? 0) + 1,
          html: input.versionHtml,
          values: (input.versionValues ?? Prisma.DbNull) as Prisma.InputJsonValue,
          commitSha: commit.sha,
          commitUrl: commit.url,
          publishedById: actor.dbUser?.id ?? null,
        },
      });
      const cleared = await tx.sitePage.updateMany({ where: { id: page.id, draftRevision: input.expectedRevision }, data: { draft: Prisma.DbNull, draftSavedAt: null, draftSavedById: null, draftRevision: { increment: 1 } } });
      await tx.sitePage.update({ where: { id: page.id }, data: { lastPublishedAt: new Date() } });
      await tx.siteAuditEvent.create({ data: { siteId: site.id, kind: "ROLLBACK", summary: `Restored ${page.title} to version ${input.versionNumber} in WordPress`, actorName: author, actorId: actor.dbUser?.id, detail: { pageId: page.id, version: written.number, restoredFrom: input.versionNumber } } });
      return {
        version: written.number,
        restoredFrom: input.versionNumber,
        label: `Rollback to version ${input.versionNumber}`,
        commit: { sha: commit.sha, url: null },
        url: pageUrl(site, page),
        note: `Saved in WordPress. ${cleared.count ? "The saved draft was cleared." : "A newer draft was saved during publishing and has been kept; it still appears in the editor."}`,
      };
    });
  } catch (error) {
    await failPublishJob(job.id, error instanceof WebsiteError && error.status === 409 ? "CONFLICT" : "COMMIT_FAILED", error instanceof Error ? error.message : "WordPress did not save the change.");
    throw error;
  }
}

// ---------------------------------------------------------------- routes

type Access = { loadSite: (req: Request, siteId: string) => Promise<Site> };

export function registerWebsiteWordPress(router: Router, access: Access) {
  const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (error?: unknown) => void) => { void fn(req, res).catch(next); };

  /**
   * Tries a site, a username and an Application Password, and says what it
   * found. Saves nothing — the connect screen's "Check connection" button.
   */
  router.post("/wordpress/check", handler(async (req, res) => {
    const input = wordpressConnectInput.parse(req.body ?? {});
    res.json(await checkWordPress(input));
  }));

  router.get("/sites/:siteId/wordpress", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const connection = await prisma.wordPressConnection.findUnique({ where: { siteId: site.id } });
    res.json({ connected: Boolean(connection), connection: wordpressConnectionView(connection) });
  }));

  /** Replaces the password (or the account) on a site already connected — the "reconnect" button. */
  router.put("/sites/:siteId/wordpress", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    if (!isWordPressSite(site)) throw new WebsiteError(409, "This website is not a WordPress site.");
    const input = wordpressConnectInput.parse(req.body ?? {});
    const details = await checkWordPress(input);
    const existing = await wordpressConnection(site.id);
    if (new URL(details.siteUrl).host !== new URL(existing.siteUrl).host) {
      throw new WebsiteError(409, `That password is for ${new URL(details.siteUrl).host}, but this website is ${new URL(existing.siteUrl).host}. Connect it as a new website instead.`);
    }
    const connection = await prisma.wordPressConnection.update({
      where: { siteId: site.id },
      data: {
        apiRoot: details.apiRoot,
        username: input.username.trim(),
        applicationPassword: encryptSecret(input.password.replace(/\s+/g, "")),
        details: details as unknown as Prisma.InputJsonValue,
        verifiedAt: new Date(),
        pausedAt: null,
        pausedReason: null,
        connectedById: req.dbUser?.id ?? null,
      },
    });
    await prisma.siteAuditEvent.create({ data: { siteId: site.id, kind: "SITE_CONNECTED", summary: `Reconnected WordPress as ${input.username.trim()}`, actorName: req.dbUser?.name ?? "Website editor", actorId: req.dbUser?.id } });
    res.json({ connected: true, connection: wordpressConnectionView(connection) });
  }));
}

/**
 * Creating a WordPress website: checked first, then saved with the site in one
 * transaction by the caller (`POST /sites`). Returns what the site row needs.
 */
export async function prepareWordPressSite(input: z.infer<typeof wordpressConnectInput>, connectedById: string | null) {
  const details = await checkWordPress(input);
  return {
    publicUrl: details.siteUrl,
    details,
    connection: {
      siteUrl: details.siteUrl,
      apiRoot: details.apiRoot,
      username: input.username.trim(),
      applicationPassword: encryptSecret(input.password.replace(/\s+/g, "")),
      details: details as unknown as Prisma.InputJsonValue,
      verifiedAt: new Date(),
      connectedById,
    },
  };
}

/**
 * Lists a newly connected site's pages straight away, so "Connect" lands in
 * the editor rather than on an empty table with a button to press. Additive
 * like the scan (`POST /sites/:id/scan`), which is what keeps them in step
 * afterwards. A failure here is not a failed connection: the site is saved,
 * and the page list says what went wrong when somebody looks again.
 */
export async function addWordPressPages(site: Site): Promise<{ firstPageId: string | null; error: string | null }> {
  try {
    const discovery = await discoverWordPressPages(site);
    if (discovery.pages.length) {
      await prisma.sitePage.createMany({
        data: discovery.pages.map((page, index) => ({ siteId: site.id, title: page.title, path: page.path, filePath: page.filePath, sortOrder: index, status: "LIVE" as const })),
        skipDuplicates: true,
      });
    }
    const first = await prisma.sitePage.findFirst({ where: { siteId: site.id, status: "LIVE" }, orderBy: [{ sortOrder: "asc" }, { path: "asc" }], select: { id: true } });
    return { firstPageId: first?.id ?? null, error: null };
  } catch (error) {
    return { firstPageId: null, error: error instanceof Error ? error.message : "The pages could not be listed." };
  }
}
