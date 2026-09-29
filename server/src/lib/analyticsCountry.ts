import { createRequire } from "node:module";

let lookup: ((ip: string) => { country?: string } | null) | null = null;
let retryAt = 0;
export const countryMetrics = { loadFailures: 0, lookupFailures: 0, misses: 0 };

/** Analytics-only fallback. Pricing retains its existing lookup behavior. */
export function analyticsCountry(ip: string): string | null {
  if (!lookup && Date.now() >= retryAt) {
    try {
      lookup = createRequire(import.meta.url)("geoip-country").lookup;
    } catch {
      retryAt = Date.now() + 60000;
      countryMetrics.loadFailures++;
      console.warn("[geo] country_database_load_failed");
    }
  }
  try {
    const country = lookup?.(ip)?.country;
    if (country && /^[A-Z]{2}$/.test(country)) return country;
    countryMetrics.misses++;
  } catch { countryMetrics.lookupFailures++; }
  return null;
}
