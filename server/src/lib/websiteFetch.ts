import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16]] as const) blocked.addSubnet(address, prefix, "ipv6");

export function websiteAddressAllowed(address: string, allowLoopback = false): boolean {
  if (allowLoopback && (address === "::1" || /^127\./.test(address))) return true;
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  // Only globally routed native IPv6; this also excludes mapped IPv4 and NAT64.
  return isIP(address) === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

type Address = { address: string; family: number };
export async function resolveWebsiteAddress(url: URL, allowLoopback = false, resolve: (hostname: string) => Promise<Address[]> = hostname => lookup(hostname, { all: true })): Promise<Address> {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use a public HTTP or HTTPS website address.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname);
  if (!addresses.length || addresses.some(entry => !websiteAddressAllowed(entry.address, allowLoopback))) throw new Error("The website address must resolve to a public server.");
  return addresses[0]!;
}

function createPinnedLookup(pinned: Address) {
  return (_hostname: string, optionsOrCallback: unknown, maybeDone?: unknown) => {
    const done = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeDone) as (err: Error | null, ...args: any[]) => void;
    const isAll = typeof optionsOrCallback === "object" && optionsOrCallback !== null && Boolean((optionsOrCallback as { all?: boolean }).all);
    if (isAll) done(null, [pinned]);
    else done(null, pinned.address, pinned.family);
  };
}

export function isTlsOrConnectionError(error: unknown): boolean {
  const msg = ((error as Error)?.message || "").toLowerCase();
  const code = ((error as { code?: string })?.code || "").toLowerCase();
  return (
    /ssl|tls|eproto|cert|handshake|alert number|routines|wrong version number/i.test(msg) ||
    /err_ssl|eproto|econnreset|econnrefused|etimedout/i.test(code)
  );
}

/** A page's text, and the response headers that say which host sent it. */
export type WebsitePage = { text: string; headers: Record<string, string> };

async function executeFetchWebsitePage(address: string, extraHeaders: Record<string, string> = {}): Promise<WebsitePage> {
  const allowLoopback = process.env.NODE_ENV === "development" && process.env.DEV_NO_AUTH === "true";
  const signal = AbortSignal.timeout(20_000);
  let url = new URL(address);
  for (let hop = 0; hop <= 5; hop++) {
    const pinned = await resolveWebsiteAddress(url, allowLoopback);
    if (signal.aborted) throw new Error("The website took too long to respond.");
    const result = await new Promise<{ location?: string; text: string; headers?: Record<string, string> }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(url, {
        signal, method: "GET", headers: { "User-Agent": "DakyXTech-OS-Editor", "Accept-Encoding": "identity", ...extraHeaders },
        // Keep the original hostname for Host/TLS, but connect only to the vetted IP.
        lookup: createPinnedLookup(pinned),
      }, response => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.destroy(); resolve({ location: response.headers.location, text: "" }); return;
        }
        if (status < 200 || status >= 300) { response.destroy(); reject(new Error(`The website answered ${status}.`)); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) { response.destroy(new Error("This page exceeds the editor's 2 MB limit.")); return; }
          chunks.push(chunk);
        });
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
        response.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), headers }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end();
    });
    if (!result.location) return { text: result.text, headers: result.headers ?? {} };
    url = new URL(result.location, url);
  }
  throw new Error("The website redirected too many times.");
}

/** Pin DNS for each request and revalidate every redirect; never forward a session. Falls back to HTTP if HTTPS TLS handshake fails. */
export async function fetchWebsiteText(address: string): Promise<string> {
  return (await fetchWebsitePage(address)).text;
}

/** `fetchWebsiteText`, plus the headers of the response that answered, which say what host is serving the site. */
export async function fetchWebsitePage(address: string, options: { headers?: Record<string, string> } = {}): Promise<WebsitePage> {
  try {
    return await executeFetchWebsitePage(address, options.headers);
  } catch (error) {
    if (/^https:\/\//i.test(address) && isTlsOrConnectionError(error)) {
      try {
        return await executeFetchWebsitePage(address.replace(/^https:\/\//i, "http://"), options.headers);
      } catch {
        throw error;
      }
    }
    throw error;
  }
}

async function executeProbeWebsiteUrl(address: string): Promise<{ statusCode: number; finalUrl: string }> {
  const signal = AbortSignal.timeout(8_000);
  let url = new URL(address);
  for (let hop = 0; hop <= 5; hop++) {
    const pinned = await resolveWebsiteAddress(url);
    const result = await new Promise<{ statusCode: number; location?: string }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(url, {
        signal,
        method: "GET",
        headers: { "User-Agent": "DakyXTech-OS-UptimeMonitor/1.0", "Accept-Encoding": "identity" },
        lookup: createPinnedLookup(pinned),
      }, response => {
        const statusCode = response.statusCode ?? 0;
        const location = response.headers.location;
        response.destroy();
        resolve({ statusCode, location });
      });
      request.on("error", reject);
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(result.statusCode) && result.location) {
      url = new URL(result.location, url);
      continue;
    }
    return { statusCode: result.statusCode, finalUrl: url.href };
  }
  throw new Error("The website redirected too many times.");
}

/** A bounded, DNS-pinned availability probe. Redirects are vetted anew. Falls back to HTTP if HTTPS fails TLS. */
export async function probeWebsiteUrl(address: string): Promise<{ statusCode: number; finalUrl: string }> {
  try {
    return await executeProbeWebsiteUrl(address);
  } catch (error) {
    if (/^https:\/\//i.test(address) && isTlsOrConnectionError(error)) {
      try {
        return await executeProbeWebsiteUrl(address.replace(/^https:\/\//i, "http://"));
      } catch {
        throw error;
      }
    }
    throw error;
  }
}

/** Download a public image without allowing DNS rebinding, private redirects or unbounded bodies. */
export async function fetchWebsiteBytes(address: string, maxBytes: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(20_000);
  let url = new URL(address);
  for (let hop = 0; hop <= 5; hop++) {
    const pinned = await resolveWebsiteAddress(url);
    const result = await new Promise<{ location?: string; bytes?: Buffer }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(url, {
        signal, method: "GET", headers: { "User-Agent": "DakyXTech-OS-Editor", "Accept-Encoding": "identity" },
        lookup: createPinnedLookup(pinned),
      }, response => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.destroy(); resolve({ location: response.headers.location }); return;
        }
        if (status < 200 || status >= 300) { response.destroy(); reject(new Error(`The image answered ${status}.`)); return; }
        const declared = Number(response.headers["content-length"] ?? 0);
        if (declared > maxBytes) { response.destroy(); reject(new Error("The image exceeds the upload limit.")); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) { response.destroy(new Error("The image exceeds the upload limit.")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ bytes: Buffer.concat(chunks) }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end();
    });
    if (result.location) { url = new URL(result.location, url); continue; }
    return result.bytes!;
  }
  throw new Error("The image redirected too many times.");
}

/**
 * One POST to a deploy hook: no body, no redirects followed, DNS pinned the same
 * way as every other outbound request here, so a hook URL cannot be pointed at
 * this server's own network. Answers with the status; anything but 2xx throws.
 */
export async function postWebsiteHook(address: string): Promise<number> {
  const url = new URL(address);
  if (url.protocol !== "https:") throw new Error("A deploy hook must be an https address.");
  const pinned = await resolveWebsiteAddress(url);
  const signal = AbortSignal.timeout(15_000);
  return new Promise<number>((resolve, reject) => {
    const request = https.request(url, {
      signal, method: "POST", headers: { "User-Agent": "DakyXTech-Publish", "Content-Length": "0" },
      lookup: createPinnedLookup(pinned),
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      if (status >= 200 && status < 300) resolve(status);
      else reject(Object.assign(new Error(`The deploy hook answered ${status}.`), { status }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** One response from `requestWebsite`: status, headers and body, whatever the status. */
export type WebsiteResponse = { status: number; headers: Record<string, string>; text: string };

/**
 * One authenticated request to somebody else's website — a WordPress REST call.
 *
 * Pinned the same way as everything above, and different in the two ways a
 * request carrying a password has to be:
 *
 * - **A redirect is never followed.** It is returned, status and `location`, for
 *   the caller to refuse. Following one would hand the `Authorization` header to
 *   whatever host the redirect names, which is exactly how a password leaves
 *   the site it was made for.
 * - **There is no fallback from HTTPS to HTTP**, for the same reason: a
 *   certificate problem is reported, never worked around with the password
 *   travelling in the clear.
 *
 * Every status is answered rather than thrown, because a WordPress error is a
 * JSON body with a code in it, and the code is what says what to fix.
 */
export async function requestWebsite(address: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  maxBytes?: number;
  timeoutMs?: number;
} = {}): Promise<WebsiteResponse> {
  const url = new URL(address);
  const allowLoopback = process.env.NODE_ENV === "development" && process.env.DEV_NO_AUTH === "true";
  const pinned = await resolveWebsiteAddress(url, allowLoopback);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const body = options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, "utf8");
  return new Promise<WebsiteResponse>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      signal,
      method: options.method ?? "GET",
      headers: {
        "User-Agent": "DakyXTech-OS-Editor",
        "Accept-Encoding": "identity",
        ...(body ? { "Content-Length": String(body.length) } : {}),
        ...options.headers,
      },
      lookup: createPinnedLookup(pinned),
    }, (response) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(new Error("The website's answer was larger than this request allows.")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}
