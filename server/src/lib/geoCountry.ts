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

type Lookup = (ip: string) => { country?: string } | null;

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

/** A two-letter country code, or null for a private, unknown or malformed address. */
export function countryForIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  // Express reports IPv4 clients on a dual-stack socket as ::ffff:1.2.3.4.
  const address = ip.trim().replace(/^::ffff:/i, "");
  if (!address) return null;
  const find = loader();
  if (!find) return null;
  try {
    const code = find(address)?.country;
    return typeof code === "string" && /^[A-Z]{2}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}
