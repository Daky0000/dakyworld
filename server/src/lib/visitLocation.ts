import { countryFlag, isPrivateOrLocalIp } from "./demoGeo.js";

export interface StoredLocation {
  ip?: string | null; country?: string | null; countryName?: string | null; city?: string | null;
  region?: string | null; countrySource?: string | null; citySource?: string | null;
  locationStatus?: string | null; accuracyRadiusKm?: number | null; geoDatabaseVersion?: string | null;
  locationResolvedAt?: Date | string | null; locationResolverVersion?: string | null;
}

export function serializeVisitLocation(v: StoredLocation) {
  const status = v.locationStatus || "legacy";
  const legacy = status === "legacy";
  return {
    country: v.country ?? null, countryName: v.countryName ?? null, city: v.city ?? null,
    region: v.region ?? null, countrySource: v.countrySource || "legacy", citySource: v.citySource || "legacy",
    locationStatus: status, accuracyRadiusKm: v.accuracyRadiusKm ?? null,
    geoDatabaseVersion: v.geoDatabaseVersion ?? null, locationResolvedAt: v.locationResolvedAt ?? null,
    locationResolverVersion: v.locationResolverVersion ?? null,
    isLocal: status === "local" || isPrivateOrLocalIp(v.ip), flag: countryFlag(v.country),
    locationLabel: legacy ? "Legacy / unverified location" : status === "local" ? "Local traffic" :
      !v.country ? "Unknown location" : `Approximate location: ${[v.city, v.region, v.countryName || v.country].filter(Boolean).join(", ")}${v.city ? "" : " (City unavailable)"}`,
  };
}

export function locationCoverage(visits: StoredLocation[]) {
  const locations = visits.map(serializeVisitLocation);
  const local = locations.filter(v => v.isLocal).length;
  const eligible = locations.length - local;
  const measured = locations.filter(v => !v.isLocal && ["resolved", "partial"].includes(v.locationStatus));
  const country = measured.filter(v => v.country).length;
  const city = measured.filter(v => v.city).length;
  return { total: locations.length, eligible, local, legacy: locations.filter(v => !v.isLocal && v.locationStatus === "legacy").length,
    unknown: locations.filter(v => !v.isLocal && v.locationStatus === "unknown").length,
    country, city, countryPercent: eligible ? Math.round(country / eligible * 100) : 0,
    cityPercent: eligible ? Math.round(city / eligible * 100) : 0 };
}
