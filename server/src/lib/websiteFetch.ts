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

/** Pin DNS for each request and revalidate every redirect; never forward a session. */
export async function fetchWebsiteText(address: string): Promise<string> {
  const allowLoopback = process.env.NODE_ENV === "development" && process.env.DEV_NO_AUTH === "true";
  const signal = AbortSignal.timeout(20_000);
  let url = new URL(address);
  for (let hop = 0; hop <= 5; hop++) {
    const pinned = await resolveWebsiteAddress(url, allowLoopback);
    if (signal.aborted) throw new Error("The website took too long to respond.");
    const result = await new Promise<{ location?: string; text: string }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(url, {
        signal, method: "GET", headers: { "User-Agent": "Dakyworld-OS-Editor", "Accept-Encoding": "identity" },
        // Keep the original hostname for Host/TLS, but connect only to the vetted IP.
        lookup: (_hostname, options, done) => {
          if ((options as { all?: boolean }).all) (done as any)(null, [pinned]);
          else done(null, pinned.address, pinned.family);
        },
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
        response.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end();
    });
    if (!result.location) return result.text;
    url = new URL(result.location, url);
  }
  throw new Error("The website redirected too many times.");
}

/** A bounded, DNS-pinned availability probe. Redirects are vetted anew. */
export async function probeWebsiteUrl(address: string): Promise<{ statusCode: number; finalUrl: string }> {
  const signal = AbortSignal.timeout(8_000);
  let url = new URL(address);
  for (let hop = 0; hop <= 5; hop++) {
    const pinned = await resolveWebsiteAddress(url);
    const result = await new Promise<{ statusCode: number; location?: string }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(url, {
        signal,
        method: "GET",
        headers: { "User-Agent": "Dakyworld-OS-UptimeMonitor/1.0", "Accept-Encoding": "identity" },
        lookup: (_hostname, options, done) => {
          if ((options as { all?: boolean }).all) (done as any)(null, [pinned]);
          else done(null, pinned.address, pinned.family);
        },
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

/** Download a public image without allowing DNS rebinding, private redirects or unbounded bodies. */
export async function fetchWebsiteBytes(address: string, maxBytes: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(20_000);
  let url = new URL(address);
  for (let hop = 0; hop <= 5; hop++) {
    const pinned = await resolveWebsiteAddress(url);
    const result = await new Promise<{ location?: string; bytes?: Buffer }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(url, {
        signal, method: "GET", headers: { "User-Agent": "Dakyworld-OS-Editor", "Accept-Encoding": "identity" },
        lookup: (_hostname, options, done) => {
          if ((options as { all?: boolean }).all) (done as any)(null, [pinned]);
          else done(null, pinned.address, pinned.family);
        },
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
