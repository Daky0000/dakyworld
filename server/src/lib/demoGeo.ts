import { isIP } from "node:net";
import { countryForIp, lookupIpRecord } from "./geoCountry.js";

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
  return ip;
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
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || ip === "::") return true;

  // 127.0.0.0/8 (Loopback block)
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  // 10.0.0.0/8 (Private)
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  // 192.168.0.0/16 (Private)
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  // 169.254.0.0/16 (Link-local)
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  // 100.64.0.0/10 (Carrier-Grade NAT / Shared Address Space)
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;

  // IPv6 Unique Local (fc00::/7 -> fc.. or fd..)
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  // IPv6 Link-Local (fe80::/10 -> fe8., fe9., fea., feb.)
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;

  return false;
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

/**
 * Checks whether the incoming request is verified to have arrived from a trusted edge
 * (Cloudflare, Vercel, CloudFront) rather than a direct client with spoofed headers.
 */
export function isEdgeVerified(
  req: { headers: Record<string, unknown> },
  options?: { trustEdge?: boolean },
): boolean {
  if (options?.trustEdge) return true;
  const headers = req.headers || {};
  const hasHeader = (name: string): boolean => {
    const val = headers[name] || headers[name.toLowerCase()];
    return typeof val === "string" && val.trim().length > 0;
  };

  // Cloudflare requests carry cf-ray
  if (hasHeader("cf-ray")) return true;
  // Vercel edge requests carry x-vercel-id
  if (hasHeader("x-vercel-id")) return true;
  // AWS CloudFront requests carry x-amz-cf-id
  if (hasHeader("x-amz-cf-id")) return true;

  return false;
}

/**
 * Extracts the real client IP using the configured trusted proxy chain (Express req.ip)
 * and verifies edge headers against spoofing.
 */
export function extractClientIp(
  req: {
    headers: Record<string, unknown>;
    ip?: string;
    socket?: { remoteAddress?: string };
  },
  options?: { trustEdge?: boolean },
): string | null {
  const getHeader = (name: string): string | null => {
    const val = req.headers[name] || req.headers[name.toLowerCase()];
    if (typeof val === "string") return val.trim();
    if (Array.isArray(val) && typeof val[0] === "string") return val[0].trim();
    return null;
  };

  const edgeVerified = isEdgeVerified(req, options);

  // 1. If Express resolved req.ip through trust proxy, use it as the trusted baseline
  const expressIp = cleanIp(req.ip);
  if (expressIp && !isPrivateOrLocalIp(expressIp)) {
    // If edge is verified and provides cf-connecting-ip or true-client-ip, validate syntax
    if (edgeVerified) {
      const edgeIp = cleanIp(getHeader("cf-connecting-ip") || getHeader("true-client-ip"));
      if (edgeIp) return edgeIp;
    }
    return expressIp;
  }

  // 2. If req.ip is private / local (e.g. internal proxy, Docker, or mock), allow verified edge header
  if (edgeVerified) {
    const directHeaders = [
      "cf-connecting-ip",
      "true-client-ip",
      "x-real-ip",
      "fastly-client-ip",
    ];
    for (const h of directHeaders) {
      const val = getHeader(h);
      if (val) {
        const clean = cleanIp(val);
        if (clean) return clean;
      }
    }
  }

  // 3. X-Forwarded-For: find first valid public IP, or leftmost clean IP
  const xForwardedFor = getHeader("x-forwarded-for");
  if (xForwardedFor) {
    const parts = xForwardedFor
      .split(",")
      .map((p) => cleanIp(p))
      .filter((p): p is string => Boolean(p));
    const publicIp = parts.find((p) => !isPrivateOrLocalIp(p));
    if (publicIp) return publicIp;
    if (parts.length > 0) return parts[0]!;
  }

  // 4. Fallback to Express req.ip (even if local) or socket
  if (expressIp) {
    return expressIp;
  }
  if (req.socket?.remoteAddress) {
    const clean = cleanIp(req.socket.remoteAddress);
    if (clean) return clean;
  }

  return null;
}

export interface GeoHints {
  country: string | null;
  city: string | null;
  region: string | null;
}

/**
 * Extracts country, city, and region hints from CDN edge headers (Cloudflare, Vercel, CloudFront, etc.).
 * Rejects client-spoofed headers when not arriving from a verified edge.
 */
export function extractGeoHints(
  req: { headers: Record<string, unknown> },
  options?: { trustEdge?: boolean },
): GeoHints {
  const getHeader = (name: string): string | null => {
    const val = req.headers[name] || req.headers[name.toLowerCase()];
    if (typeof val === "string") return val.trim();
    if (Array.isArray(val) && typeof val[0] === "string") return val[0].trim();
    return null;
  };

  // Reject spoofed geo headers if not from verified edge
  if (!isEdgeVerified(req, options)) {
    return { country: null, city: null, region: null };
  }

  // Country headers
  let country: string | null = null;
  const countryHeaders = [
    "cf-ipcountry",
    "x-vercel-ip-country",
    "cloudfront-viewer-country",
    "x-country-code",
    "x-country",
    "x-appengine-country",
    "fastly-country-code",
    "geoip-country-code",
  ];
  for (const h of countryHeaders) {
    const val = getHeader(h);
    if (val) {
      const upper = val.toUpperCase();
      if (/^[A-Z]{2}$/.test(upper) && upper !== "XX" && upper !== "ZZ" && upper !== "T1") {
        country = upper === "UK" ? "GB" : upper;
        break;
      }
    }
  }

  // City headers
  let city: string | null = null;
  const cityHeaders = [
    "cf-ipcity",
    "x-vercel-ip-city",
    "cloudfront-viewer-city",
    "x-appengine-city",
    "x-city",
    "x-geo-city",
  ];
  for (const h of cityHeaders) {
    const val = getHeader(h);
    if (val) {
      try {
        const decoded = decodeURIComponent(val.replace(/\+/g, " ")).trim();
        if (decoded && decoded.length <= 80 && !/^[0-9]+$/.test(decoded)) {
          city = decoded;
          break;
        }
      } catch {
        city = val.trim();
        break;
      }
    }
  }

  // Region headers
  let region: string | null = null;
  const regionHeaders = [
    "cf-region",
    "x-vercel-ip-country-region",
    "cloudfront-viewer-country-region-name",
    "x-region",
  ];
  for (const h of regionHeaders) {
    const val = getHeader(h);
    if (val) {
      try {
        const decoded = decodeURIComponent(val.replace(/\+/g, " ")).trim();
        if (decoded && decoded.length <= 80) {
          region = decoded;
          break;
        }
      } catch {
        region = val.trim();
        break;
      }
    }
  }

  return { country, city, region };
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

export type LocationSource = "edge" | "geoip" | "preference" | "local" | "unresolved";
export type CitySource = "edge" | "unverified" | "none";
export type LocationConfidence = "high" | "medium" | "low" | "none";

export interface ResolvedIpLocation {
  ip: string | null;
  country: string | null;
  countryName: string | null;
  city: string | null;
  flag: string;
  isLocal: boolean;
  countrySource: LocationSource;
  citySource: CitySource;
  confidence: LocationConfidence;
  timezonePreference?: string | null;
  localePreference?: string | null;
}

/**
 * Resolves visitor location through multi-tiered detection:
 * 1. CDN Edge Geo Headers (Cloudflare, Vercel, CloudFront)
 * 2. MaxMind GeoIP Country Database
 * 3. Client IANA Timezone mapping & locale (as preference/heuristic only)
 * 4. Fallback to Local Development with neutral flag
 *
 * Truthful location resolution:
 * - City is ONLY resolved if provided by a trusted edge lookup; otherwise null ("City unavailable").
 * - Capital city defaults and timezone city guesses are NOT treated as measured locations.
 * - Browser timezone and locale are treated strictly as environment preferences, not physical locations.
 * - If IP country contradicts timezone country, IP country always wins.
 */
export function resolveIpLocation(
  ip: string | null | undefined,
  hintOrOptions?: string | LocationResolveOptions | null,
): ResolvedIpLocation {
  const sanitizedIp = cleanIp(ip);
  const isLocal = isPrivateOrLocalIp(sanitizedIp);

  const opts: LocationResolveOptions =
    typeof hintOrOptions === "string"
      ? { hintCountry: hintOrOptions }
      : hintOrOptions && typeof hintOrOptions === "object"
        ? hintOrOptions
        : {};

  let code: string | null = null;
  let city: string | null = null;
  let countrySource: LocationSource = "unresolved";
  let citySource: CitySource = "none";
  let confidence: LocationConfidence = "none";

  // 1. Direct country hint from verified CDN edge headers
  if (
    opts.hintCountry &&
    /^[A-Z]{2}$/i.test(opts.hintCountry) &&
    opts.hintCountry.toUpperCase() !== "XX" &&
    opts.hintCountry.toUpperCase() !== "ZZ"
  ) {
    code = opts.hintCountry.toUpperCase() === "UK" ? "GB" : opts.hintCountry.toUpperCase();
    countrySource = "edge";
    confidence = "high";
  }

  // 2. MaxMind GeoIP Database lookup for public IP
  const geoRecord = sanitizedIp ? lookupIpRecord(sanitizedIp) : null;
  if (!code && geoRecord) {
    code = geoRecord.country;
    countrySource = "geoip";
    confidence = "high";
  }

  // 3. Local development handling
  if (isLocal) {
    if (!code) {
      const tzResolved = resolveFromTimezone(opts.timezone);
      const locResolved = resolveFromLocale(opts.locale);
      if (tzResolved && tzResolved.country !== "LOCAL") {
        code = tzResolved.country;
        countrySource = "preference";
        confidence = "low";
      } else if (locResolved) {
        code = locResolved.country;
        countrySource = "preference";
        confidence = "low";
      } else {
        code = "LOCAL";
        countrySource = "local";
        confidence = "high";
      }
    }
  } else if (!code) {
    // 4. Public IP without GeoIP or edge hint: treat browser timezone / locale strictly as preference
    const tzResolved = resolveFromTimezone(opts.timezone);
    const locResolved = resolveFromLocale(opts.locale);
    if (tzResolved && tzResolved.country !== "LOCAL") {
      code = tzResolved.country;
      countrySource = "preference";
      confidence = "low";
    } else if (locResolved) {
      code = locResolved.country;
      countrySource = "preference";
      confidence = "low";
    }
  }

  // City resolution:
  // ONLY use trusted CDN edge header city. NEVER invent capital city or guess from timezone!
  if (opts.hintCity && typeof opts.hintCity === "string" && opts.hintCity.trim().length > 0) {
    city = opts.hintCity.trim();
    citySource = "edge";
  } else {
    city = null;
    citySource = "none";
  }

  // Handle local development / loopback
  if (isLocal) {
    if (code && code !== "LOCAL") {
      return {
        ip: sanitizedIp,
        country: code,
        countryName: countryName(code),
        city,
        flag: countryFlag(code),
        isLocal: true,
        countrySource,
        citySource,
        confidence,
        timezonePreference: opts.timezone || null,
        localePreference: opts.locale || null,
      };
    }
    return {
      ip: sanitizedIp,
      country: "LOCAL",
      countryName: "Local Development",
      city,
      flag: "🏠",
      isLocal: true,
      countrySource: "local",
      citySource,
      confidence: "high",
      timezonePreference: opts.timezone || null,
      localePreference: opts.locale || null,
    };
  }

  const name = code ? countryName(code) : null;
  const flag = code ? countryFlag(code) : "🌐";

  return {
    ip: sanitizedIp,
    country: code,
    countryName: name,
    city,
    flag,
    isLocal: false,
    countrySource,
    citySource,
    confidence,
    timezonePreference: opts.timezone || null,
    localePreference: opts.locale || null,
  };
}
