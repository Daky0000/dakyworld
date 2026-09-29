import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { lookupAnalyticsCity } from "./geoCity.js";
import { analyticsCountry } from "./analyticsCountry.js";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * Strips port, IPv6 brackets, and IPv4-mapped IPv6 prefixes so GeoIP and
 * network checks receive a pure, normalized IP address with verified syntax.
 */
export function cleanIp(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let ip = raw.trim();
  ip = ip.replace(/^::ffff:/i, "");
  // Bracketed IPv6: [2001:db8::1]:8080 or [2001:db8::1]
  const bracket = ip.match(/^\[([a-fA-F0-9:]+)\](?::\d+)?$/);
  if (bracket) {
    ip = bracket[1]!;
  } else {
    // IPv4 with port: 1.2.3.4:8080
    const ipv4Port = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/);
    if (ipv4Port) {
      ip = ipv4Port[1]!;
    }
  }

  if (ip === "localhost") return "127.0.0.1";
  if (!isIP(ip)) {
    return null;
  }
  return ipaddr.process(ip).toString();
}

/**
 * Masks an IP address for ordinary dashboard and privacy-conscious displays.
 * Example IPv4: 102.176.45.12 -> 102.176.***.***
 * Example IPv6: 2001:db8:85a3::8a2e -> 2001:db8:***
 */
export function maskIp(rawIp: string | null | undefined): string | null {
  const ip = cleanIp(rawIp);
  if (!ip) return null;
  if (isPrivateOrLocalIp(ip)) return "Local / Private IP";

  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.***.***`;
    }
  } else if (version === 6) {
    const parts = ip.split(":");
    return `${parts.slice(0, 2).join(":")}:***`;
  }
  return "***";
}

/**
 * Checks whether an IP address is private, loopback, link-local, carrier-grade NAT,
 * or local development address.
 */
export function isPrivateOrLocalIp(rawIp: string | null | undefined): boolean {
  const ip = cleanIp(rawIp);
  if (!ip) return false;
  const address = ipaddr.process(ip);
  return ["private", "loopback", "linkLocal", "uniqueLocal", "carrierGradeNat", "unspecified"].includes(address.range());
}

/**
 * Returns full English country name for an ISO 3166-1 alpha-2 code, or null if invalid.
 */
export function countryName(code: string | null | undefined): string | null {
  if (!code || typeof code !== "string") return null;
  const upper = code.trim().toUpperCase();
  if (upper === "LOCAL") return "Local Development";
  if (upper === "UK") return "United Kingdom";
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
  const normalized = upper === "UK" ? "GB" : upper;
  if (!/^[A-Z]{2}$/.test(normalized)) return "🌐";
  try {
    const c1 = normalized.charCodeAt(0) - 65 + 0x1f1e6;
    const c2 = normalized.charCodeAt(1) - 65 + 0x1f1e6;
    return String.fromCodePoint(c1, c2);
  } catch {
    return "🌐";
  }
}

/** Compatibility helper: edge geography is disabled regardless of request headers. */
export function isEdgeVerified(_req: { headers: Record<string, unknown> }, _options?: { trustEdge?: boolean }): boolean {
  return false;
}

/** Express alone resolves the configured proxy chain. Raw headers are never trusted here. */
export function extractClientIp(req: { headers: Record<string, unknown>; ip?: string; socket?: { remoteAddress?: string } }, _options?: { trustEdge?: boolean }): string | null {
  return cleanIp(req.ip);
}

export interface GeoHints { country: string | null; city: string | null; region: string | null }
export function extractGeoHints(_req: { headers: Record<string, unknown> }, _options?: { trustEdge?: boolean }): GeoHints {
  return { country: null, city: null, region: null };
}

/**
 * Standard IANA Timezone to ISO Country and primary City mapping table.
 */
const TIMEZONE_GEO_MAP: Record<string, { country: string; city: string }> = {
  // Africa
  "Africa/Accra": { country: "GH", city: "Accra" },
  "Africa/Lagos": { country: "NG", city: "Lagos" },
  "Africa/Johannesburg": { country: "ZA", city: "Johannesburg" },
  "Africa/Nairobi": { country: "KE", city: "Nairobi" },
  "Africa/Cairo": { country: "EG", city: "Cairo" },
  "Africa/Casablanca": { country: "MA", city: "Casablanca" },
  "Africa/Abidjan": { country: "CI", city: "Abidjan" },
  "Africa/Dakar": { country: "SN", city: "Dakar" },
  "Africa/Addis_Ababa": { country: "ET", city: "Addis Ababa" },
  "Africa/Kampala": { country: "UG", city: "Kampala" },
  "Africa/Kigali": { country: "RW", city: "Kigali" },
  "Africa/Tunis": { country: "TN", city: "Tunis" },
  "Africa/Algiers": { country: "DZ", city: "Algiers" },

  // Americas
  "America/New_York": { country: "US", city: "New York" },
  "America/Chicago": { country: "US", city: "Chicago" },
  "America/Los_Angeles": { country: "US", city: "Los Angeles" },
  "America/Denver": { country: "US", city: "Denver" },
  "America/Phoenix": { country: "US", city: "Phoenix" },
  "America/Detroit": { country: "US", city: "Detroit" },
  "America/Indiana/Indianapolis": { country: "US", city: "Indianapolis" },
  "America/Toronto": { country: "CA", city: "Toronto" },
  "America/Vancouver": { country: "CA", city: "Vancouver" },
  "America/Montreal": { country: "CA", city: "Montreal" },
  "America/Edmonton": { country: "CA", city: "Edmonton" },
  "America/Mexico_City": { country: "MX", city: "Mexico City" },
  "America/Sao_Paulo": { country: "BR", city: "São Paulo" },
  "America/Buenos_Aires": { country: "AR", city: "Buenos Aires" },
  "America/Bogota": { country: "CO", city: "Bogotá" },
  "America/Lima": { country: "PE", city: "Lima" },
  "America/Santiago": { country: "CL", city: "Santiago" },

  // Europe
  "Europe/London": { country: "GB", city: "London" },
  "Europe/Paris": { country: "FR", city: "Paris" },
  "Europe/Berlin": { country: "DE", city: "Berlin" },
  "Europe/Rome": { country: "IT", city: "Rome" },
  "Europe/Madrid": { country: "ES", city: "Madrid" },
  "Europe/Amsterdam": { country: "NL", city: "Amsterdam" },
  "Europe/Brussels": { country: "BE", city: "Brussels" },
  "Europe/Dublin": { country: "IE", city: "Dublin" },
  "Europe/Zurich": { country: "CH", city: "Zurich" },
  "Europe/Vienna": { country: "AT", city: "Vienna" },
  "Europe/Stockholm": { country: "SE", city: "Stockholm" },
  "Europe/Oslo": { country: "NO", city: "Oslo" },
  "Europe/Copenhagen": { country: "DK", city: "Copenhagen" },
  "Europe/Helsinki": { country: "FI", city: "Helsinki" },
  "Europe/Warsaw": { country: "PL", city: "Warsaw" },
  "Europe/Prague": { country: "CZ", city: "Prague" },
  "Europe/Lisbon": { country: "PT", city: "Lisbon" },
  "Europe/Athens": { country: "GR", city: "Athens" },
  "Europe/Bucharest": { country: "RO", city: "Bucharest" },
  "Europe/Budapest": { country: "HU", city: "Budapest" },
  "Europe/Kiev": { country: "UA", city: "Kyiv" },
  "Europe/Kyiv": { country: "UA", city: "Kyiv" },

  // Asia & Middle East
  "Asia/Dubai": { country: "AE", city: "Dubai" },
  "Asia/Tokyo": { country: "JP", city: "Tokyo" },
  "Asia/Singapore": { country: "SG", city: "Singapore" },
  "Asia/Hong_Kong": { country: "HK", city: "Hong Kong" },
  "Asia/Shanghai": { country: "CN", city: "Shanghai" },
  "Asia/Kolkata": { country: "IN", city: "New Delhi" },
  "Asia/Bangkok": { country: "TH", city: "Bangkok" },
  "Asia/Seoul": { country: "KR", city: "Seoul" },
  "Asia/Riyadh": { country: "SA", city: "Riyadh" },
  "Asia/Doha": { country: "QA", city: "Doha" },
  "Asia/Kuwait": { country: "KW", city: "Kuwait City" },
  "Asia/Jerusalem": { country: "IL", city: "Jerusalem" },
  "Asia/Taipei": { country: "TW", city: "Taipei" },
  "Asia/Manila": { country: "PH", city: "Manila" },
  "Asia/Jakarta": { country: "ID", city: "Jakarta" },
  "Asia/Kuala_Lumpur": { country: "MY", city: "Kuala Lumpur" },

  // Oceania
  "Australia/Sydney": { country: "AU", city: "Sydney" },
  "Australia/Melbourne": { country: "AU", city: "Melbourne" },
  "Australia/Brisbane": { country: "AU", city: "Brisbane" },
  "Australia/Perth": { country: "AU", city: "Perth" },
  "Pacific/Auckland": { country: "NZ", city: "Auckland" },
};

/**
 * Resolves country and city from browser IANA timezone string.
 */
export function resolveFromTimezone(timezone: string | null | undefined): {
  country: string;
  countryName: string;
  city: string;
  flag: string;
} | null {
  if (!timezone || typeof timezone !== "string") return null;
  const clean = timezone.trim();
  const direct = TIMEZONE_GEO_MAP[clean];
  if (direct) {
    const name = countryName(direct.country) || direct.country;
    const flag = countryFlag(direct.country);
    return {
      country: direct.country,
      countryName: name,
      city: direct.city,
      flag,
    };
  }

  // Fallback: extract City from "Continent/City_Name"
  const parts = clean.split("/");
  if (parts.length >= 2) {
    const rawCity = parts[parts.length - 1]!.replace(/_/g, " ").trim();
    if (rawCity) {
      return {
        country: "LOCAL",
        countryName: "Local Development",
        city: rawCity,
        flag: "🏠",
      };
    }
  }

  return null;
}

/**
 * Resolves country from browser navigator.language (e.g. "en-GH" -> "GH").
 */
export function resolveFromLocale(locale: string | null | undefined): {
  country: string;
  countryName: string;
  flag: string;
} | null {
  if (!locale || typeof locale !== "string") return null;
  const parts = locale.trim().split(/[-_]/);
  if (parts.length >= 2) {
    const regionCode = parts[1]!.toUpperCase();
    if (/^[A-Z]{2}$/.test(regionCode) && regionCode !== "ZZ" && regionCode !== "XX") {
      const normalized = regionCode === "UK" ? "GB" : regionCode;
      const name = countryName(normalized);
      if (name) {
        return {
          country: normalized,
          countryName: name,
          flag: countryFlag(normalized),
        };
      }
    }
  }
  return null;
}

export interface LocationResolveOptions {
  hintCountry?: string | null;
  hintCity?: string | null;
  hintRegion?: string | null;
  timezone?: string | null;
  locale?: string | null;
}

export type LocationSource = "geolite_city" | "geoip_country" | "legacy" | "none";
export interface GeoResult {
  country: string; city?: string | null; region?: string | null;
  accuracyRadiusKm?: number | null; databaseVersion?: string | null;
}

/** Browser preferences and edge hints are intentionally ignored. */
export function resolveIpLocation(
  ip: string | null | undefined,
  _options?: string | LocationResolveOptions | null,
  providers = { city: lookupAnalyticsCity, country: analyticsCountry },
) {
  const address = cleanIp(ip);
  const local = isPrivateOrLocalIp(address);
  const publicIp = address && ipaddr.process(address).range() === "unicast";
  const record = publicIp ? providers.city(address!) : null;
  const code = record?.country || (publicIp ? providers.country(address!) : null);
  const city = code ? record?.city || null : null;
  return {
    ip: address, country: code, countryName: countryName(code), city,
    region: record?.region || null, flag: countryFlag(code), isLocal: local,
    countrySource: code ? (record ? "geolite_city" : "geoip_country") : "none",
    citySource: city ? "geolite_city" : "none",
    locationStatus: local ? "local" : city ? "resolved" : code ? "partial" : "unknown",
    accuracyRadiusKm: record?.accuracyRadiusKm ?? null,
    geoDatabaseVersion: record?.databaseVersion ?? null,
    locationResolvedAt: new Date(), locationResolverVersion: "2",
  };
}
