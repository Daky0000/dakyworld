import { countryForIp } from "./geoCountry.js";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * Returns full English country name for an ISO 3166-1 alpha-2 code, or null if invalid.
 */
export function countryName(code: string | null | undefined): string | null {
  if (!code || typeof code !== "string") return null;
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper) || upper === "ZZ" || upper === "XX" || upper === "T1") return null;
  try {
    const name = regionNames.of(upper);
    if (!name || name === "Unknown Region" || name === "Unknown" || name === upper) {
      return null;
    }
    return name;
  } catch {
    return null;
  }
}


/**
 * Returns flag emoji for a two-letter country code (e.g. "GH" -> "🇬🇭", "US" -> "🇺🇸").
 */
export function countryFlag(code: string | null | undefined): string {
  if (!code || typeof code !== "string") return "🌐";
  const upper = code.trim().toUpperCase();
  if (upper === "LOCAL") return "🏠";
  if (!/^[A-Z]{2}$/.test(upper)) return "🌐";
  try {
    const c1 = upper.charCodeAt(0) - 65 + 0x1f1e6;
    const c2 = upper.charCodeAt(1) - 65 + 0x1f1e6;
    return String.fromCodePoint(c1, c2);
  } catch {
    return "🌐";
  }
}

/**
 * Checks whether an IP address is a private, loopback, or local development address.
 */
export function isPrivateOrLocalIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const clean = ip.trim().replace(/^::ffff:/i, "");
  if (clean === "127.0.0.1" || clean === "::1" || clean === "localhost") return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  return false;
}

export interface ResolvedIpLocation {
  country: string | null;
  countryName: string | null;
  flag: string;
  isLocal: boolean;
}

export function resolveIpLocation(ip: string | null | undefined, hintCountry?: string | null): ResolvedIpLocation {
  const isLocal = isPrivateOrLocalIp(ip);

  let code: string | null = null;
  if (hintCountry && /^[A-Z]{2}$/i.test(hintCountry) && hintCountry.toUpperCase() !== "XX") {
    code = hintCountry.toUpperCase();
  } else {
    code = countryForIp(ip);
  }

  if (!code && isLocal) {
    return {
      country: "LOCAL",
      countryName: "Local Development",
      flag: "🏠",
      isLocal: true,
    };
  }

  const name = code ? countryName(code) : null;
  const flag = code ? countryFlag(code) : "🌐";

  return {
    country: code,
    countryName: name,
    flag,
    isLocal,
  };
}
