import { createRequire } from "node:module";

/**
 * The country an IP address is registered to, looked up on this server.
 *
 * The API sits behind Railway's edge, not Cloudflare or Vercel, so no country
 * header ever arrives and every visitor used to be quoted the default. This
 * answers the same question from MaxMind's GeoLite2 country data, which
 * `geoip-country` ships inside the package: the address never leaves this
 * process, so no third party learns who is looking at the pricing page.
 *
 * It is a hint for which currency to quote, nothing more. A VPN or a mobile
 * carrier routing through another country gets the wrong default, and that is
 * an acceptable failure for a price display. It must never gate access.
 *
 * `ip-address`, which the package lists, is used only by its database-update
 * script, never at lookup time; package.json overrides it to a patched version.
 */

type LookupResult = {
  country?: string;
  name?: string;
  capital?: string;
  continent?: string;
  continent_name?: string;
} | null;

type Lookup = (ip: string) => LookupResult;

let lookup: Lookup | null | undefined;

function loader(): Lookup | null {
  if (lookup !== undefined) return lookup;
  try {
    // CommonJS, loaded on first use so a missing data file costs a lookup
    // rather than the whole server's boot.
    const geoip = createRequire(import.meta.url)("geoip-country") as { lookup: Lookup };
    lookup = (ip) => geoip.lookup(ip);
  } catch {
    lookup = null;
  }
  return lookup;
}

/**
 * Strips port, IPv6 brackets, and IPv4-mapped IPv6 prefixes so GeoIP lookup
 * receives a pure, bare IP address.
 */
function cleanLookupIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let clean = ip.trim();
  clean = clean.replace(/^::ffff:/i, "");
  // Bracketed IPv6: [2001:db8::1]:8080 or [2001:db8::1]
  const bracket = clean.match(/^\[([a-fA-F0-9:]+)\](?::\d+)?$/);
  if (bracket) return bracket[1]!;
  // IPv4 with port: 1.2.3.4:8080
  const ipv4Port = clean.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/);
  if (ipv4Port) return ipv4Port[1]!;
  return clean || null;
}

export interface GeoIpRecord {
  country: string;
  name?: string;
  capital?: string;
  continent?: string;
  continentName?: string;
}

/** Look up full GeoIP record from MaxMind country database. */
export function lookupIpRecord(ip: string | null | undefined): GeoIpRecord | null {
  const address = cleanLookupIp(ip);
  if (!address) return null;
  const find = loader();
  if (!find) return null;
  try {
    const res = find(address);
    if (!res || typeof res.country !== "string" || !/^[A-Z]{2}$/.test(res.country)) {
      return null;
    }
    return {
      country: res.country,
      name: res.name,
      capital: res.capital,
      continent: res.continent,
      continentName: res.continent_name,
    };
  } catch {
    return null;
  }
}

/** A two-letter country code, or null for a private, unknown or malformed address. */
export function countryForIp(ip: string | null | undefined): string | null {
  const record = lookupIpRecord(ip);
  return record ? record.country : null;
}
